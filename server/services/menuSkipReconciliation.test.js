import test from 'node:test';
import assert from 'node:assert/strict';
import Record from '../models/MenuSelectionRecord.js';
import matter from './matterApiService.js';
import { reconcileMenuSkippedDays, restoredMenuSkipDates } from './menuSkipReconciliation.js';

const nutrition = { subscription_id: 'sub', active_delivery_dates: ['2026-11-16', '2026-11-17'] };
const makeRecord = () => ({ _id: 'record', weeklyMenuId: 'menu', matterSubscriptionId: 'sub', skippedDays: [
  { date: '2026-11-16', pauseStatus: 'success', subscriptionId: 'sub', resumeDate: '2026-12-11' },
  { date: '2026-11-18', pauseStatus: 'already_paused', subscriptionId: 'sub' },
] });

const confirmActive = (t) => t.mock.method(matter, 'getSubscription', async () => ({ data: {
  subscription_id: 'sub', delivery_schedule: nutrition.active_delivery_dates.map(date => ({ date, status: 'active' })),
} }));

test('a confirmed pause restored to active in Matter is released and archived once', async (t) => {
  confirmActive(t);
  const write = t.mock.method(Record, 'updateOne', async () => ({ matchedCount: 1 }));
  const record = makeRecord();
  await reconcileMenuSkippedDays(record, nutrition);
  assert.deepEqual(record.skippedDays.map(s => s.date), ['2026-11-18']);
  assert.deepEqual(restoredMenuSkipDates(record, nutrition), ['2026-11-16']);
  assert.equal(record.unpausedDays[0].resumeDate, '2026-12-11');
  assert.ok(record.unpausedDays[0].unpausedAt instanceof Date);
  assert.deepEqual(write.mock.calls[0].arguments[1].$pull.skippedDays, { date: '2026-11-16', pauseStatus: 'success' });
  await reconcileMenuSkippedDays(record, nutrition);
  assert.equal(write.mock.callCount(), 1);
});

test('missing schedules, missing dates, pending/failed/declined skips and renewal dates never release a skip', async (t) => {
  const write = t.mock.method(Record, 'updateOne', () => assert.fail('Must not write'));
  for (const source of [{ subscription_id: 'sub' }, { ...nutrition, active_delivery_dates: [] }, { ...nutrition, subscription_id: 'renewed' }]) {
    const record = makeRecord();
    await reconcileMenuSkippedDays(record, source);
    assert.equal(record.skippedDays.length, 2);
  }
  for (const pauseStatus of ['pending', 'failed', 'declined']) {
    const record = makeRecord();
    record.skippedDays[0].pauseStatus = pauseStatus;
    await reconcileMenuSkippedDays(record, nutrition);
    assert.equal(record.skippedDays.length, 2);
  }
  assert.equal(write.mock.callCount(), 0);
});

test('subscription identity uses the pause-specific subscription before the record fallback', async (t) => {
  t.mock.method(Record, 'updateOne', () => assert.fail('Old cycle must not be released'));
  const record = makeRecord();
  record.matterSubscriptionId = 'renewed';
  await reconcileMenuSkippedDays(record, { ...nutrition, subscription_id: 'renewed' });
  assert.equal(record.skippedDays.length, 2);
});

test('a concurrent new pause cannot be removed using the older saved pause', async (t) => {
  confirmActive(t);
  t.mock.method(Record, 'updateOne', async () => ({ matchedCount: 0 }));
  const record = makeRecord();
  await assert.rejects(reconcileMenuSkippedDays(record, nutrition), { statusCode: 409 });
  assert.equal(record.skippedDays.length, 2);
  assert.equal(record.unpausedDays, undefined);
});

test('history cannot unlock a new confirmed pause or another subscription', () => {
  const record = makeRecord();
  record.unpausedDays = [{ date: '2026-11-16', subscriptionId: 'sub' }, { date: '2026-11-17', subscriptionId: 'old' }];
  assert.deepEqual(restoredMenuSkipDates(record, nutrition), []);
});

test('multiple restored dates work on Mongoose documents as used by snack assignment', async (t) => {
  confirmActive(t);
  t.mock.method(Record, 'updateOne', async () => ({ matchedCount: 1 }));
  const record = new Record({ email: 'fixture@example.com', weeklyMenuId: '507f1f77bcf86cd799439011', matterSubscriptionId: 'sub', skippedDays: [
    { date: '2026-11-16', pauseStatus: 'success', subscriptionId: 'sub' },
    { date: '2026-11-17', pauseStatus: 'already_paused', subscriptionId: 'sub' },
  ] });
  await reconcileMenuSkippedDays(record, nutrition);
  assert.equal(record.skippedDays.length, 0);
  assert.equal(record.unpausedDays.length, 2);
  assert.deepEqual(restoredMenuSkipDates(record, nutrition), nutrition.active_delivery_dates);
  assert.equal(record.validateSync(), undefined);
});

test('a stale active snapshot fetched before a newly confirmed pause never clears that pause', async (t) => {
  const record = makeRecord();
  record.skippedDays[0].processedAt = new Date('2026-11-12T09:00:01Z');
  const snapshot = { ...nutrition, source_fetched_at: '2026-11-12T09:00:00Z' };
  t.mock.method(Record, 'updateOne', () => assert.fail('New pause must be retained'));
  const read = t.mock.method(matter, 'getSubscription', async (id) => {
    assert.equal(id, 'sub');
    assert.equal(record.skippedDays[0].pauseStatus, 'success');
    return { data: { subscription_id: id, delivery_schedule: [
      { date: '2026-11-16', status: 'paused' }, { date: '2026-11-17', status: 'active' },
    ] } };
  });
  await reconcileMenuSkippedDays(record, snapshot);
  assert.equal(read.mock.callCount(), 1);
  assert.equal(record.skippedDays.length, 2);
  assert.equal(record.unpausedDays, undefined);
  assert.deepEqual(snapshot.active_delivery_dates, ['2026-11-17']);
});

test('a missing or failed confirming calendar cannot remove a saved pause', async (t) => {
  t.mock.method(Record, 'updateOne', () => assert.fail('Must retain pause'));
  for (const data of [null, { subscription_id: 'sub' }, { subscription_id: 'different', delivery_schedule: [] }]) {
    const read = t.mock.method(matter, 'getSubscription', async () => ({ data }));
    const record = makeRecord();
    await assert.rejects(reconcileMenuSkippedDays(record, { ...nutrition }), { statusCode: 503 });
    assert.equal(record.skippedDays.length, 2);
    read.mock.restore();
  }
  t.mock.method(matter, 'getSubscription', async () => { throw new Error('Matter unavailable'); });
  const record = makeRecord();
  await assert.rejects(reconcileMenuSkippedDays(record, { ...nutrition }), { statusCode: 503 });
  assert.equal(record.skippedDays.length, 2);
});
