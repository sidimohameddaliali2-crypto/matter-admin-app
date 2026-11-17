import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createDriverAuditFixedHostBudgetFactory } from './driverAuditFixedHostBudget.js';
import { createDriverAuditDataBackend } from './driverAuditDataBackend.js';
import { createWorkerBudget, WORKER_BUDGET_DEFAULTS, runWithWorkerBudget } from '../vendor/driver-audits/integration/cloud/worker-budget.mjs';
import { createCloudPhotoGrader } from '../vendor/driver-audits/integration/cloud/photo-grader.mjs';
import { createPhotoVisualAudit } from '../vendor/driver-audits/integration/cloud/photo-visual-audit.mjs';

const start = Date.parse('2026-11-03T00:00:00Z');
const id = sequence => String(sequence).padStart(8, '0') + '-0000-4000-8000-000000000000';
const readerPolicy = { ...WORKER_BUDGET_DEFAULTS, reservationMicros: 150_000 };

function fixture(options) {
  let now = start, sequence = 0;
  const create = createDriverAuditFixedHostBudgetFactory(options);
  return { create: input => create({ clock: () => now, requestId: () => id(++sequence), ...input }),
    advance: elapsed => { now += elapsed; } };
}

test('native execution admits against exhausted legacy counters without reading or changing them', async () => {
  const body = JSON.stringify({ version: 1, policy: WORKER_BUDGET_DEFAULTS, latestPeriod: '2026-11',
    periods: { '2026-11': { usedMicros: WORKER_BUDGET_DEFAULTS.monthlyMicros, admissions: 1, settlements: 1 } }, active: {} });
  let reads = 0, writes = 0;
  const stateStore = { async read() { reads++; return { revision: 7, body }; },
    async compareAndSwap() { writes++; throw Error('Original budget mutation forbidden'); } };
  assert.equal((await createWorkerBudget({ stateStore, clock: () => start }).reserve()).allowed, false);
  const f = fixture(), budget = f.create({ stateStore });
  const result = await runWithWorkerBudget(budget, async () => { f.advance(1000); return { status: 'complete' }; },
    { monotonic: (() => { let time = 0; return () => time += 1000; })() });
  assert.equal(result.status, 'complete');
  assert.equal(result.budgetSettlement, 'settled');
  assert.equal(reads, 1);
  assert.equal(writes, 0);
  assert.equal((await budget.settle(await budget.reserve(), { elapsedMs: 0 })).chargedMicros, 0);
});

test('reader reservations retain identity and increase through every existing response threshold', async () => {
  const f = fixture(), budget = f.create({ key: 'reader-budget', policy: readerPolicy });
  const first = await budget.reserve({ reservationMicros: 40_000 });
  assert.match(first.id, /^[a-f0-9-]{36}$/);
  assert.equal(first.startedAtMs, start);
  assert.equal(first.period, '2026-11');
  let current = first;
  for (const reservationMicros of [45_000, 47_000, 55_000, 150_000]) {
    current = await budget.increase(current, { reservationMicros });
    assert.equal(current.allowed, true);
    assert.equal(current.reservationMicros, reservationMicros);
  }
  assert.equal((await budget.increase(first, { reservationMicros: 55_000 })).reservationMicros, 150_000);
  await assert.rejects(budget.settle(first, { elapsedMs: 0 }), /mismatch/i);
  f.advance(2000);
  assert.deepEqual(await budget.settle(current, { elapsedMs: 2000, extraMicros: 106_000, cpuMicros: 100_000 }),
    { settled: true, period: '2026-11', chargedMicros: 0, accountingBasis: 'fixed-host-execution-v1' });
  assert.equal((await budget.settle(current, { elapsedMs: 2000 })).settled, false);
  assert.equal((await budget.increase(current)).allowed, false);
});

test('one shared concurrency bound covers all budgets and fallback pool instances', async () => {
  const f = fixture({ maxConcurrent: 2 });
  const primary = f.create(), reader = f.create({ key: 'reader-budget', policy: readerPolicy });
  const other = f.create({ key: 'reader-budget-reserve', policy: readerPolicy });
  const reservations = await Promise.all([primary.reserve(), reader.reserve(), other.reserve()]);
  assert.deepEqual(reservations.map(value => value.allowed), [true, true, false]);
  await assert.rejects(other.settle(reservations[0], { elapsedMs: 0 }), /mismatch/i);
  assert.equal((await other.reserve()).allowed, false);
  await primary.settle(reservations[0], { elapsedMs: 0 });
  assert.equal((await other.reserve()).allowed, true);
});

test('unfinished work retains its slot past the deadline and invalid measurements never release it', async () => {
  const f = fixture({ maxConcurrent: 1 }), budget = f.create();
  const reservation = await budget.reserve();
  for (const measurement of [{ elapsedMs: -1 }, { elapsedMs: 300_001 }, { elapsedMs: 1000 },
    { elapsedMs: 0, extraMicros: 40_001 }, { elapsedMs: 0, preReservationMs: 1 },
    { elapsedMs: 0, cpuMicros: 1_000_001 }]) {
    await assert.rejects(budget.settle(reservation, measurement));
    assert.equal((await budget.reserve()).allowed, false);
  }
  f.advance(300_001);
  await assert.rejects(budget.increase(reservation), /duration/i);
  await assert.rejects(budget.settle(reservation, { elapsedMs: 300_000 }), /duration/i);
  assert.equal((await budget.reserve()).allowed, false);
});

test('success at the 300 second limit releases a slot without charging legacy hosting', async () => {
  const f = fixture({ maxConcurrent: 1 }), budget = f.create(), reservation = await budget.reserve();
  f.advance(300_000);
  assert.equal((await budget.settle(reservation, { elapsedMs: 300_000 })).chargedMicros, 0);
  assert.equal((await budget.reserve()).allowed, true);
});

test('failed work, clock reversal, duplicate identities and the lifetime admission bound fail closed', async () => {
  const f = fixture({ maxConcurrent: 1, maxReservations: 2 }), budget = f.create();
  const reservation = await budget.reserve();
  f.advance(-1);
  await assert.rejects(budget.settle(reservation, { elapsedMs: 0 }), /clock|duration/i);
  f.advance(1);
  await budget.settle(reservation, { elapsedMs: 0 });
  const duplicate = f.create({ requestId: () => reservation.id });
  await assert.rejects(duplicate.reserve(), /duplicate/i);
  const second = await budget.reserve();
  await budget.settle(second, { elapsedMs: 0 });
  assert.equal((await budget.reserve()).reason, 'admission-limit');
  const failed = fixture({ maxConcurrent: 1 }), held = failed.create();
  await assert.rejects(runWithWorkerBudget(held, async () => { throw Error('uncertain operation'); }), /uncertain/);
  assert.equal((await held.reserve()).allowed, false);
});

test('invalid capacities, policies, clocks and reservation sizes cannot open an admission slot', async () => {
  for (const maxConcurrent of [0, 5, NaN, '1']) assert.throws(() => createDriverAuditFixedHostBudgetFactory({ maxConcurrent }));
  const f = fixture(), budget = f.create({ policy: readerPolicy });
  for (const reservationMicros of [0, 39_999, 150_001, 40_000.5, '40000']) {
    await assert.rejects(budget.reserve({ reservationMicros }));
  }
  assert.throws(() => f.create({ policy: { ...readerPolicy, maxRunMs: 300_001 } }));
  assert.throws(() => f.create({ key: 'photo-grading-budget' }));
  await assert.rejects(f.create({ clock: () => NaN }).reserve());
  await assert.rejects(f.create({ requestId: () => 'bad' }).reserve());
});

test('only the native data backend supplies fixed host execution admission', async () => {
  const legacy = await createDriverAuditDataBackend({ env: { MATTER_SUPABASE_SECRET: 'fictional-secret' } });
  assert.equal(legacy.createExecutionBudget, undefined);
  const collection = { async createIndex() {}, async updateOne() {}, async findOne() { return null; } };
  const db = { collection: () => collection, admin: () => ({ command: async () => ({ setName: 'fixture', logicalSessionTimeoutMinutes: 30 }) }),
    client: { startSession: () => ({ withTransaction: operation => operation(), async endSession() {} }) } };
  const native = await createDriverAuditDataBackend({ db, staging: true,
    env: { DRIVER_AUDIT_DATA_STORE: 'mongo', DRIVER_AUDIT_NATIVE_CAPACITY_BYTES: '1000000' } });
  assert.equal(typeof native.createExecutionBudget, 'function');
  assert.equal((await native.createExecutionBudget().reserve()).allowed, true);
});

function paidFixture({ exhausted = false, uncertainCommit = false } = {}) {
  const month = '2026-11';
  const docs = new Map(exhausted ? [['photo-grading-budget', { revision: 7, body: JSON.stringify({ version: 1,
    months: { [month]: 25_000_000 }, attempts: { ['f'.repeat(64)]: { month, reservedMicros: 25_000_000 } } }) }]] : []);
  let calls = 0;
  const state = { async read(key) { return docs.get(key) ?? { revision: 0, body: null }; },
    async compareAndSwap(input) {
      assert.equal(input.expectedRevision, (await this.read(input.key)).revision);
      docs.set(input.key, { revision: input.expectedRevision + 1, body: input.body });
      if (uncertainCommit) throw Object.assign(Error('uncertain committed reservation'), { status: 503 });
      return { body_text: input.body, replayed: false };
    } };
  const pricing = { verified: true, model: 'openai/gpt-4.1-mini', maxRequestMicros: 1000, validUntil: '2030-01-01' };
  const requestModel = async () => { calls++; throw Error('uncertain provider result'); };
  const options = { enabled: true, state, pricing, requestModel, now: () => new Date(start), lookupExisting: async () => 'clear' };
  const bytes = Buffer.from([255, 216, 255, 1]);
  const binding = { recordKey: '2026-11-03/fictional-record', urlSha256: 'a'.repeat(64), proofTimestamp: null,
    imageSha256: createHash('sha256').update(bytes).digest('hex'), sourceSha256: 'b'.repeat(64), observedSourceSha256: 'c'.repeat(64),
    sourceSnapshotHash: 'd'.repeat(64), originalSourceVersionMatch: false, sourceProvenance: 'local-copy-consistency-only' };
  return { docs, calls: () => calls, args: { binding, bytes, generation: 'e'.repeat(64) },
    grade: createCloudPhotoGrader(options).grade, observe: createPhotoVisualAudit(options).observe };
}

for (const operation of ['grade', 'observe']) {
  test('native execution preserves the separate paid ' + operation + ' exhaustion guard', async () => {
    const paid = paidFixture({ exhausted: true }), before = structuredClone([...paid.docs]);
    const f = fixture(), result = await runWithWorkerBudget(f.create(), () => paid[operation](paid.args));
    assert.equal(result.status, 'budget_exhausted');
    assert.equal(paid.calls(), 0);
    assert.deepEqual([...paid.docs], before);
  });
  test('an uncertain paid ' + operation + ' retains its original reservation and does not charge or call twice', async () => {
    const paid = paidFixture(), f = fixture();
    assert.equal((await runWithWorkerBudget(f.create(), () => paid[operation](paid.args))).status, 'needs_recovery');
    const before = structuredClone([...paid.docs]);
    assert.equal((await runWithWorkerBudget(f.create(), () => paid[operation](paid.args))).status, 'already_attempted');
    assert.deepEqual([...paid.docs], before);
    assert.equal(paid.calls(), 1);
    assert.equal(JSON.parse(paid.docs.get('photo-grading-budget').body).months['2026-11'], 1000);
  });
  test('an ambiguous paid ' + operation + ' admission commit is never retried or refunded', async () => {
    const paid = paidFixture({ uncertainCommit: true }), f = fixture();
    await assert.rejects(runWithWorkerBudget(f.create(), () => paid[operation](paid.args)), /uncertain/);
    const before = structuredClone([...paid.docs]);
    assert.equal((await runWithWorkerBudget(f.create(), () => paid[operation](paid.args))).status, 'already_attempted');
    assert.deepEqual([...paid.docs], before);
    assert.equal(paid.calls(), 0);
  });
}
