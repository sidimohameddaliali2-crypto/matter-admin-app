import test from 'node:test';
import assert from 'node:assert/strict';
import Record from '../models/MenuSelectionRecord.js';
import { reconcileCoreBreakfast as reconcile } from './kitchenBreakfastEntitlement.js';
const reconcileCoreBreakfast = (record, date, nutrition) => reconcile(record, date, nutrition, new Date('2026-11-02T08:00:00Z'));
const date = '2026-11-04';
const nutrition = { customer_id: 'fixture', subscription_id: 'sub', plan_name: 'Matter Core', breakfast_included: false, active_delivery_dates: [date] };
const breakfast = (extra = {}) => ({ date: new Date(date), mealType: 'breakfast', mealName: 'Auto breakfast', isAutoAssigned: true, ...extra });

test('removes only the dated Core auto breakfast, preserving choices, other dates, audit and record identity', async t => {
  const meals = [{ date, mealType: 'main', mealName: 'Chosen main', remark: 'veg' }, breakfast(), breakfast({ isAutoAssigned: false }), breakfast({ date: '2026-11-06' })];
  const record = { _id: 'record', matterCustomerId: 'fixture', email: 'fixture@example.invalid', selectedMeals: meals, skippedDays: [] };
  const before = JSON.stringify(record);
  t.mock.method(Record, 'updateOne', async (filter, update) => {
    assert.equal(filter._id, record._id);
    assert.equal(filter.selectedMeals, meals, 'optimistic compare protects a concurrent menu edit');
    assert.deepEqual(update.$set.selectedMeals, [meals[0], meals[2], meals[3]]);
    assert.equal(update.$push.kitchenAudit.action, 'remove-unentitled-auto-breakfast');
    assert.equal(update.$push.kitchenAudit.date, date);
    return { modifiedCount: 1 };
  });
  const result = await reconcileCoreBreakfast(record, date, nutrition);
  assert.equal(result._id, record._id);
  assert.equal(result.selectedMeals.length, 3);
  assert.equal(JSON.stringify(record), before);
});
test('no writes for included or unknown breakfast entitlement, ordinary plans, or customer-picked meals', async t => {
  t.mock.method(Record, 'updateOne', () => assert.fail('No removal allowed'));
  const record = { _id: 'record', selectedMeals: [breakfast()] };
  for (const input of [{ ...nutrition, breakfast_included: true }, { ...nutrition, breakfast_included: null }, { ...nutrition, plan_name: 'Custom' }, { ...nutrition, active_delivery_dates: [] }, { ...nutrition, active_delivery_dates: null }]) {
    assert.equal(await reconcileCoreBreakfast(record, date, input), record);
  }
  const manual = { ...record, selectedMeals: [breakfast({ isAutoAssigned: false })] };
  assert.equal(await reconcileCoreBreakfast(manual, date, nutrition), manual);
  const historical = { ...record, selectedMeals: [breakfast({ date: '2026-11-01' })] };
  assert.equal(await reconcileCoreBreakfast(historical, '2026-11-01', { ...nutrition, active_delivery_dates: ['2026-11-01'] }), historical);
});
test('a concurrent edit or identity mismatch blocks reconciliation rather than overwriting choices', async t => {
  const write = t.mock.method(Record, 'updateOne', async () => ({ modifiedCount: 0 }));
  const record = { _id: 'record', matterCustomerId: 'fixture', selectedMeals: [breakfast()] };
  await assert.rejects(() => reconcileCoreBreakfast(record, date, nutrition), { code: 'KITCHEN_PREPARATION_BUSY' });
  await assert.rejects(() => reconcileCoreBreakfast(record, date, { ...nutrition, customer_id: 'other' }), /verified selection identity/);
  assert.equal(write.mock.callCount(), 1);
});
