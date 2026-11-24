import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import * as implementation from './driverAuditSyncStatus.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const key = 'app-sidi-report-worker-status';
const generation = sha('fictional-current-report');

function fixture() {
  let now = Date.parse('2026-11-18T06:40:00.000Z');
  const head = { version: 1, generation, visibleCutoffAt: '2026-11-18T06:31:00.000Z',
    servingPackage: { version: 1, dataStore: 'supabase', collectorRevision: 5772 } };
  const body = JSON.stringify(head), rows = new Map([['app-sidi-report-head', { revision: 7, body }]]), writes = [];
  const state = {
    async read(name) { return structuredClone(rows.get(name) ?? { revision: 0, body: null }); },
    async compareAndSwap(value) {
      const prior = rows.get(value.key) ?? { revision: 0, body: null };
      assert.equal(value.expectedRevision, prior.revision);
      writes.push(structuredClone(value));
      rows.set(value.key, { revision: prior.revision + 1, body: value.body });
      return { revision: prior.revision + 1, body_text: value.body, event_text: value.event,
        body_sha256: sha(value.body), replayed: false };
    },
  };
  const value = { version: 1, kind: 'supabase-report-worker-slot-status', executionHost: 'off-host',
    syncConfigSha256: sha('sync'), sourceConfigSha256: sha('source'),
    scheduledAt: '2026-11-18T06:30:00.000Z', nextCheckAt: '2026-11-18T08:00:00.000Z',
    checkedAt: new Date(now).toISOString(), outcome: 'published', status: 'ready', activeGeneration: generation,
    servingHeadRevision: 7, servingHeadBodySha256: sha(body), collectorRevision: 5772,
    visibleCutoffAt: head.visibleCutoffAt, latestCaptureAt: head.visibleCutoffAt, errorCode: null };
  assert.equal(typeof implementation.createDriverAuditSupabaseWorkerStatusStore, 'function');
  const store = implementation.createDriverAuditSupabaseWorkerStatusStore({ state, clock: () => now });
  return { rows, writes, state, value, store, setNow(value) { now = Date.parse(value); } };
}

test('a cross-host reader reports pending when the remote slot receipt is absent and never writes', async () => {
  const f = fixture();
  assert.deepEqual(await f.store.read(generation), { status: 'pending', pending: true, latestCaptureAt: null, checkedAt: null });
  assert.equal(f.writes.length, 0);
});

test('one terminal slot preserves the exact report identity, survives reload and remains ready until the next slot', async () => {
  const f = fixture();
  await f.store.write(f.value);
  assert.equal(f.writes.length, 1);
  f.setNow('2026-11-18T07:50:00.000Z');
  assert.equal((await f.store.read(generation)).status, 'ready', 'A healthy overnight/morning idle is not a 30-minute failure');
  const reloaded = implementation.createDriverAuditSupabaseWorkerStatusStore({ state: f.state, clock: () => Date.parse('2026-11-18T07:50:00Z') });
  assert.equal((await reloaded.read(generation)).checkedAt, f.value.checkedAt);
  assert.equal((await reloaded.read(generation)).latestCaptureAt, f.value.latestCaptureAt);
  f.setNow('2026-11-18T08:31:00.000Z');
  assert.equal((await f.store.read(generation)).status, 'pending');
  assert.equal(f.writes.length, 1, 'No idle status receipt is created');
});

test('noon remains ready overnight but becomes pending after the next morning grace', async () => {
  const f = fixture(); f.setNow('2026-11-18T08:05:00Z');
  const noon = { ...f.value, scheduledAt: '2026-11-18T08:00:00.000Z', nextCheckAt: '2026-11-19T06:30:00.000Z',
    checkedAt: '2026-11-18T08:05:00.000Z', outcome: 'unchanged' };
  await f.store.write(noon); f.setNow('2026-11-19T04:00:00Z');
  assert.equal((await f.store.read(generation)).status, 'ready');
  f.setNow('2026-11-19T07:01:00Z'); assert.equal((await f.store.read(generation)).status, 'pending');
});

test('a changed head, revision, cutoff or requested generation cannot inherit another report status', async () => {
  for (const change of [row => row.revision++, row => { const head = JSON.parse(row.body); head.visibleCutoffAt = '2026-11-18T06:32:00.000Z'; row.body = JSON.stringify(head); }]) {
    const f = fixture(); await f.store.write(f.value); change(f.rows.get('app-sidi-report-head'));
    assert.equal((await f.store.read(generation)).status, 'pending');
  }
  const f = fixture(); await f.store.write(f.value);
  assert.equal((await f.store.read(sha('other-report'))).status, 'pending');
});

test('malformed, future, out-of-slot and raw payload status cannot be admitted or presented as checked', async () => {
  for (const change of [value => { value.raw = { customer: 'not permitted' }; }, value => { value.nextCheckAt = '2027-01-01T00:00:00.000Z'; },
    value => { value.checkedAt = '2027-01-01T00:00:00.000Z'; }, value => { value.scheduledAt = '2026-11-18T07:00:00.000Z'; },
    value => { value.servingHeadBodySha256 = sha('other-body'); }, value => { value.status = 'failed'; }]) {
    const f = fixture(), value = structuredClone(f.value); change(value);
    await assert.rejects(f.store.write(value));
    f.rows.set(key, { revision: 1, body: JSON.stringify(value) });
    assert.equal((await f.store.read(generation)).status, 'pending'); assert.equal(f.writes.length, 0);
  }
});

test('exact lost-ack retry reuses one outcome while same-slot conflicts and older slots never overwrite', async () => {
  const f = fixture(), original = f.state.compareAndSwap;
  f.state.compareAndSwap = async value => { await original(value); throw Error('Lost acknowledgement'); };
  await f.store.write(f.value); assert.equal(f.writes.length, 1);
  await f.store.write(f.value); assert.equal(f.writes.length, 1);
  await assert.rejects(f.store.write({ ...f.value, checkedAt: '2026-11-18T06:41:00.000Z' }));
  const older = { ...f.value, scheduledAt: '2026-11-17T08:00:00.000Z', nextCheckAt: '2026-11-18T06:30:00.000Z' };
  await assert.rejects(f.store.write(older)); assert.equal(f.writes.length, 1);
});

test('failure outcomes keep the retained report identity and do not invent evidence clocks', async () => {
  const f = fixture();
  await f.store.write({ ...f.value, status: 'budget-deferred', outcome: 'failed', errorCode: 'AUDIT_BUDGET' });
  const read = await f.store.read(generation);
  assert.equal(read.status, 'budget-deferred'); assert.equal(read.pending, true);
  assert.equal(read.latestCaptureAt, f.value.latestCaptureAt); assert.equal(read.checkedAt, f.value.checkedAt);
});

test('a verified newer serving head can supersede only old metadata without creating another receipt', async () => {
  const f = fixture(), row = f.rows.get('app-sidi-report-head'), next = JSON.parse(row.body);
  next.generation = sha('genuine-newer-report'); next.servingPackage.collectorRevision++;
  row.revision++; row.body = JSON.stringify(next);
  assert.deepEqual(await f.store.write(f.value), { verified: false, superseded: true });
  assert.equal(f.writes.length, 0);
  assert.equal((await f.store.read(next.generation)).status, 'pending');
});

test('a concurrent genuine publication after the status head check never presents the old slot as new-report health', async () => {
  const f = fixture(), original = f.state.compareAndSwap;
  f.state.compareAndSwap = async value => {
    const row = f.rows.get('app-sidi-report-head'), next = JSON.parse(row.body);
    next.generation = sha('concurrent-report'); next.servingPackage.collectorRevision++;
    row.revision++; row.body = JSON.stringify(next);
    return original(value);
  };
  await f.store.write(f.value);
  assert.equal((await f.store.read(generation)).status, 'pending');
  assert.equal((await f.store.read(sha('concurrent-report'))).status, 'pending');
  assert.deepEqual(await f.store.write(f.value), { verified: false, superseded: true });
  assert.equal(f.writes.length, 1);
});

test('unknown prior status and invalid calendar clocks are preserved without a replacement write', async () => {
  const f = fixture(), unknown = JSON.stringify({ version: 1, kind: 'foreign-control' });
  f.rows.set(key, { revision: 3, body: unknown });
  await assert.rejects(f.store.write(f.value)); assert.equal(f.rows.get(key).body, unknown);
  assert.equal(f.writes.length, 0);
  f.rows.delete(key);
  await assert.rejects(f.store.write({ ...f.value, latestCaptureAt: '2026-02-30T00:00:00.000Z' }));
  assert.equal(f.writes.length, 0);
});
