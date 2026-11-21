import test from 'node:test';
import assert from 'node:assert/strict';
import Record from '../models/MenuSelectionRecord.js';
import { kitchenDateUnavailable } from './kitchenDeliveryEligibility.js';

test('resumed Matter delivery preserves the pause history and audits reconciliation once', async (t) => {
  const date = '2026-10-30';
  const record = { _id: 'record', skippedDays: [{ _id: 'pause', date, pauseStatus: 'success' }] };
  const writes = [];
  t.mock.method(Record, 'updateOne', async (...args) => { writes.push(args); return { modifiedCount: 1 }; });
  const nutrition = { active_delivery_dates: [date], subscription_id: 'current' };
  assert.equal(await kitchenDateUnavailable(record, date, nutrition), false);
  assert.equal(await kitchenDateUnavailable(record, date, nutrition), false);
  assert.equal(writes.length, 1);
  assert.equal(record.skippedDays.length, 1);
  assert.equal(writes[0][1].$push.kitchenAudit.action, 'delivery-resumed');
  assert.equal(await kitchenDateUnavailable(record, date, { active_delivery_dates: [] }), true);
});

test('an unresolved pause does not suppress an active delivery or get rewritten as resumed', async (t) => {
  const date = '2026-10-30';
  const writes = [];
  t.mock.method(Record, 'updateOne', async (...args) => { writes.push(args); return { modifiedCount: 1 }; });
  const nutrition = { active_delivery_dates: [date], subscription_id: 'current' };
  for (const pauseStatus of ['pending', 'failed']) {
    const record = { _id: 'record', skippedDays: [{ _id: 'pause', date, pauseStatus }] };
    assert.equal(await kitchenDateUnavailable(record, date, nutrition), false);
    assert.equal(record.skippedDays[0].resumedAt, undefined);
    assert.equal(await kitchenDateUnavailable({ skippedDays: [{ date, pauseStatus }] }, date, {}), false);
  }
  assert.equal(writes.length, 0);
  assert.equal(await kitchenDateUnavailable({ skippedDays: [{ date, pauseStatus: 'success' }] }, date, {}), true);
  assert.equal(await kitchenDateUnavailable({ skippedDays: [{ date }] }, date, {}), true);
});
