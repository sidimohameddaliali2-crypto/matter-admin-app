import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkCoordinator, mongoWorkStore, scheduleWork } from './scheduledWork.js';
import ScheduledWork from '../models/ScheduledWork.js';

function fixture() {
  let now = 100;
  const rows = new Map();
  const store = {
    async acquire(name, owner, ttl, slot) {
      const r = rows.get(name) || { until: 0, completed: -1 };
      if (slot != null && r.completed >= slot) return 'completed';
      if (r.until > now) return 'busy';
      rows.set(name, { ...r, owner, until: now + ttl }); return 'acquired';
    },
    async renew(name, owner, ttl) {
      const r = rows.get(name); if (r?.owner !== owner || r.until <= now) return false;
      r.until = now + ttl; return true;
    },
    async complete(name, owner, slot) {
      const r = rows.get(name); if (r?.owner !== owner || r.until <= now) return false;
      r.completed = slot; r.owner = null; r.until = 0; return true;
    },
    async release(name, owner) { const r = rows.get(name); if (r?.owner === owner) { r.owner = null; r.until = 0; } },
  };
  const options = { store, leaseMs: 90, setTimer: () => 0, clearTimer: () => {} };
  return { rows, store, worker: () => createWorkCoordinator(options), advance: n => { now += n; } };
}

test('independent workers and restarts execute only one completed scheduled slot', async () => {
  const f = fixture(); let finish, runs = 0;
  const first = f.worker()('job', async () => { runs++; await new Promise(r => { finish = r; }); return 'done'; }, { slot: 5 });
  while (!finish) await Promise.resolve();
  assert.deepEqual(await f.worker()('job', () => assert.fail('second worker ran'), { slot: 5 }), { skipped: true, reason: 'busy' });
  finish(); assert.equal(await first, 'done');
  assert.deepEqual(await f.worker()('job', () => assert.fail('restart repeated slot'), { slot: 5 }), { skipped: true, reason: 'completed' });
  assert.equal(await f.worker()('job', async () => { runs++; return 'next'; }, { slot: 6 }), 'next');
  assert.deepEqual(await f.worker()('job', () => assert.fail('stale timer ran'), { slot: 4 }), { skipped: true, reason: 'completed' });
  assert.equal(runs, 2);
});

test('failed jobs release ownership and retry the same slot; different jobs remain independent', async () => {
  const f = fixture();
  await assert.rejects(f.worker()('job', async () => { throw new Error('temporary'); }, { slot: 5 }), /temporary/);
  assert.equal(await f.worker()('job', async () => 'retry', { slot: 5 }), 'retry');
  assert.equal(await f.worker()('other', async () => 'independent', { slot: 5 }), 'independent');
});

test('expired owner stops work and cannot release a replacement owner', async () => {
  const f = fixture(); let resume, finishSecond, oldGuard;
  const first = f.worker()('job', async ({ assertOwned }) => { oldGuard = assertOwned; await new Promise(r => { resume = r; }); await assertOwned(); });
  while (!resume) await Promise.resolve(); f.advance(91);
  const second = f.worker()('job', async () => { await new Promise(r => { finishSecond = r; }); return 'replacement'; });
  while (!finishSecond) await Promise.resolve();
  const replacement = f.rows.get('job').owner;
  await assert.rejects(oldGuard(), { code: 'WORK_LEASE_LOST' }); resume();
  await assert.rejects(first, { code: 'WORK_LEASE_LOST' });
  assert.equal(f.rows.get('job').owner, replacement);
  finishSecond(); assert.equal(await second, 'replacement');
});

test('database failures never allow fallback execution; manual mutex runs can be retried', async () => {
  const worker = createWorkCoordinator({ store: { acquire: async () => { throw new Error('db unavailable'); } } });
  await assert.rejects(worker('job', () => assert.fail('must fail closed')), /db unavailable/);
  const f = fixture(); const run = f.worker();
  assert.equal(await run('manual', async () => 1), 1);
  assert.equal(await run('manual', async () => 2), 2);
});

test('Mongo store uses database time, atomic predicates and owner-scoped release', async t => {
  const writes = [];
  t.mock.method(ScheduledWork, 'updateOne', async (...args) => { writes.push(args); return { matchedCount: 1 }; });
  t.mock.method(ScheduledWork, 'findOneAndUpdate', (filter, update) => {
    assert.deepEqual(filter.$expr, { $lte: ['$leaseUntil', '$$NOW'] });
    assert.deepEqual(filter.completedSlot, { $lt: 10 });
    assert.deepEqual(update[0].$set.leaseUntil, { $add: ['$$NOW', 90] });
    return { lean: async () => ({ owner: 'owner' }) };
  });
  assert.equal(await mongoWorkStore.acquire('job', 'owner', 90, 10), 'acquired');
  assert.equal(await mongoWorkStore.renew('job', 'owner', 90), true);
  assert.equal(await mongoWorkStore.complete('job', 'owner', 10), true);
  await mongoWorkStore.release('job', 'owner');
  assert.equal(writes[0][2].upsert, true);
  assert.deepEqual(writes[1][0].$expr, { $gt: ['$leaseUntil', '$$NOW'] });
  for (const [filter] of writes.slice(1)) assert.equal(filter.owner, 'owner');
});

test('duplicate starter calls share one local timer and stop safely', () => {
  const stop = scheduleWork({ name: 'fixture-starter', intervalMs: 60000, immediate: false, run: () => assert.fail('not due') });
  assert.equal(scheduleWork({ name: 'fixture-starter', intervalMs: 60000, run: () => assert.fail('duplicate') }), stop);
  stop();
});

test('Dubai daily slots roll at the requested wall-clock hour independent of host timezone', async () => {
  const { workSlot } = await import('./scheduledWork.js');
  const day = 86400000, offset = (4 - 6) * 3600000;
  const before = Date.parse('2026-11-04T01:59:59Z');
  const due = Date.parse('2026-11-04T02:00:00Z');
  assert.equal(workSlot(due, day, offset), workSlot(before, day, offset) + 1);
  assert.equal(workSlot(Date.parse('2026-11-03T20:00:00Z'), day, 4 * 3600000), workSlot(before, day, 4 * 3600000));
});

test('partial completion and nested busy results never mark a scheduled slot completed', async () => {
  const f = fixture(); const run = f.worker();
  await assert.rejects(run('job', async () => ({ complete: false }), { slot: 9 }), /incomplete/);
  assert.equal(f.rows.get('job').completed, -1);
  assert.deepEqual(await run('job', async () => ({ skipped: true, reason: 'busy' }), { slot: 9 }), { skipped: true, reason: 'busy' });
  assert.equal(f.rows.get('job').completed, -1);
  await run('job', async () => 'ok', { slot: 9 }); assert.equal(f.rows.get('job').completed, 9);
});

test('startup catch-up is calendar-scoped while normal runs retain 6 AM Dubai scheduling', async t => {
  const { mockScheduledWork } = await import('../testSupport/scheduledWorkFixture.js');
  const { scheduleDailyWork } = await import('./scheduledWork.js');
  const rows = mockScheduledWork(t); let now = Date.parse('2026-11-04T00:00:00Z'), calls = 0;
  t.mock.method(Date, 'now', () => now);
  const timers = [];
  t.mock.method(globalThis, 'setTimeout', (fn, delay) => { const timer = { fn, delay, unref() {} }; timers.push(timer); return timer; });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const options = { name: 'fixture-catchup', hour: 6, startupOffsetMs: 4 * 3600000, run: async () => { calls++; } };
  let stop = scheduleDailyWork(options);
  assert.equal(timers.at(-1).delay, 0); await timers.at(-1).fn();
  assert.equal(calls, 1); assert.equal(timers.at(-1).delay, 2 * 3600000);
  stop(); stop = scheduleDailyWork(options); await timers.at(-1).fn();
  assert.equal(calls, 1, 'restart must not repeat successful catch-up');
  now = Date.parse('2026-11-04T02:00:00Z'); await timers.at(-1).fn();
  assert.equal(calls, 2, '6 AM schedule still executes independently');
  stop(); now = Date.parse('2026-11-04T20:05:00Z');
  stop = scheduleDailyWork(options); await timers.at(-1).fn();
  assert.equal(calls, 3, 'restart after Dubai midnight catches the new business day');
  assert.equal(timers.at(-1).delay, 5 * 3600000 + 55 * 60000);
  assert(rows.has('scheduled:fixture-catchup:startup')); assert(rows.has('scheduled:fixture-catchup'));
  stop();
});
