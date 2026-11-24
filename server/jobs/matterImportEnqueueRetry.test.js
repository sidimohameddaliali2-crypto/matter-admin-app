import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduledImportEnqueuer } from './matterImportEnqueueRetry.js';

function timers() {
  const scheduled = [];
  const cleared = [];
  return { scheduled, cleared,
    setTimer: (callback, delay) => { const timer = { callback, delay, unref() {} }; scheduled.push(timer); return timer; },
    clearTimer: timer => cleared.push(timer)
  };
}

test('startup enqueue failure retries the captured date even after the next daily service date is queued', async () => {
  const time = timers();
  const calls = [];
  let unavailable = true;
  const retry = createScheduledImportEnqueuer({ ...time, onError: () => {}, enqueue: async date => {
    calls.push(date);
    if (unavailable) throw new Error('Synthetic Mongo outage');
  } });
  await retry.queue('2026-11-22');
  assert.deepEqual(calls, ['2026-11-22']);
  assert.equal(time.scheduled[0].delay, 60000);
  // A subsequent daily run calculates tomorrow anew. The prior retry retains
  // its original date, rather than calling tomorrowDateKey again.
  unavailable = false;
  await retry.queue('2026-11-23');
  time.scheduled[0].callback();
  await retry.queue('2026-11-22');
  assert.deepEqual(calls, ['2026-11-22', '2026-11-23', '2026-11-22']);
  assert.equal(time.scheduled.length, 1);
  retry.stop();
});

test('repeated failures back off, coalesce requests and stop scheduling after success', async () => {
  const time = timers();
  let calls = 0;
  let succeed = false;
  const retry = createScheduledImportEnqueuer({ ...time, onError: () => {}, enqueue: async () => {
    calls++; if (!succeed) throw new Error('Synthetic failure');
  } });
  await Promise.all([retry.queue('2026-11-22'), retry.queue('2026-11-22')]);
  assert.equal(calls, 1);
  for (let i = 0; i < 4; i++) {
    time.scheduled[i].callback();
    await retry.queue('2026-11-22');
  }
  assert.deepEqual(time.scheduled.map(t => t.delay), [60000, 120000, 240000, 300000, 300000]);
  succeed = true;
  time.scheduled.at(-1).callback();
  await retry.queue('2026-11-22');
  assert.equal(time.scheduled.length, 5);
  retry.stop();
});

test('shutdown clears pending retries and an in-flight failure cannot rearm them', async () => {
  const time = timers();
  let reject;
  const retry = createScheduledImportEnqueuer({ ...time, onError: () => {}, enqueue: () => new Promise((_resolve, fail) => { reject = fail; }) });
  const initial = retry.queue('2026-11-22');
  retry.stop();
  reject(new Error('Synthetic in-flight failure'));
  await initial;
  await retry.queue('2026-11-23');
  assert.equal(time.scheduled.length, 0);
  const another = createScheduledImportEnqueuer({ ...time, onError: () => {}, enqueue: async () => { throw new Error('Synthetic failure'); } });
  await another.queue('2026-11-22');
  another.stop();
  assert.deepEqual(time.cleared, [time.scheduled[0]]);
});
