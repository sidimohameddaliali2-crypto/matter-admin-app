import test from 'node:test';
import assert from 'node:assert/strict';
import Record from '../models/MenuSelectionRecord.js';
import { reconcileCoreMainMeals } from './kitchenCoreEntitlement.js';
const date = '2026-11-06', now = new Date('2026-11-04T08:00:00Z');
const nutrition = { customer_id: 'person', subscription_id: 'sub', plan_name: 'Matter Core', meal_frequency: 1,
  active_delivery_dates: ['2026-11-04', date], double_delivery_dates: ['2026-11-04'] };
const meal = (extra = {}) => ({ date, mealType: 'main', mealName: 'Core chicken', isAutoAssigned: true, quantity: 1, slotNumber: 0, ...extra });
const record = meals => ({ _id: 'record', matterCustomerId: 'person', selectedMeals: meals, skippedDays: [] });
const reconcile = (r, n = nutrition, d = date) => reconcileCoreMainMeals(r, d, n, now);

test('Friday excess auto main is removed, retaining earliest slot, other days, breakfast, snack, remarks and identity', async t => {
  const a = meal({ remark: 'sauce', _id: 'a' }), b = meal({ slotNumber: 1, mealName: 'Core beef' });
  const other = meal({ date: '2026-11-04' }), breakfast = meal({ mealType: 'breakfast' }), snack = meal({ mealType: 'snack' });
  const r = record([b, other, a, breakfast, snack]), original = JSON.stringify(r);
  const write = t.mock.method(Record, 'updateOne', async (filter, update) => {
    assert.equal(filter.selectedMeals, r.selectedMeals);
    assert.equal(filter.matterCustomerId, 'person');
    assert.deepEqual(update.$set.selectedMeals, [other, a, breakfast, snack]);
    assert.equal(update.$push.kitchenAudit.action, 'remove-excess-auto-core-mains');
    assert.match(update.$push.kitchenAudit.reason, /food_days=1/);
    return { modifiedCount: 1 };
  });
  const result = await reconcile(r);
  assert.equal(result._id, r._id); assert.equal(JSON.stringify(r), original);
  assert.equal(await reconcile(result), result, 'repeat preparation is a no-op');
  assert.equal(write.mock.callCount(), 1);
});
test('double Wednesday keeps two full meals; meal frequency two requires four portions on a double day', async t => {
  t.mock.method(Record, 'updateOne', () => assert.fail('No excess'));
  for (const count of [1, 2]) {
    const r = record(Array.from({ length: count * 2 }, () => meal({ date: '2026-11-04' })));
    assert.equal(await reconcile(r, { ...nutrition, meal_frequency: count }, '2026-11-04'), r);
  }
});
test('customer choices win and only the auto quantity is reduced', async t => {
  const chosen = meal({ isAutoAssigned: false, remark: 'chosen' }), auto = meal({ quantity: 3, slotNumber: 1 });
  t.mock.method(Record, 'updateOne', async (_, update) => {
    assert.deepEqual(update.$set.selectedMeals, [chosen, { ...auto, quantity: 1 }]); return { modifiedCount: 1 };
  });
  await reconcile(record([chosen, auto]), { ...nutrition, meal_frequency: 2 });
});
test('excess chosen quantities block review without modifying choices', async t => {
  t.mock.method(Record, 'updateOne', () => assert.fail('Must preserve choices'));
  await assert.rejects(() => reconcile(record([meal({ isAutoAssigned: false, quantity: 2 }), meal()])), { code: 'KITCHEN_CORE_SELECTION_REVIEW' });
});
test('no removals for ordinary plans, past/paused dates, missing schedule flags or unresolved entitlement', async t => {
  t.mock.method(Record, 'updateOne', () => assert.fail('No removal allowed'));
  const r = record([meal(), meal()]);
  for (const n of [{ ...nutrition, plan_name: 'Custom' }, { ...nutrition, active_delivery_dates: [] },
    { ...nutrition, double_delivery_dates: null }, { ...nutrition, meal_frequency: null }, { ...nutrition, meal_frequency: 1.5 }]) {
    assert.equal(await reconcile(r, n), r);
  }
  assert.equal(await reconcileCoreMainMeals(r, date, nutrition, new Date('2026-11-07T08:00:00Z')), r);
});
test('identity mismatch and concurrent changes are blocked', async t => {
  const r = record([meal(), meal()]);
  const write = t.mock.method(Record, 'updateOne', async () => ({ modifiedCount: 0 }));
  await assert.rejects(() => reconcile(r, { ...nutrition, customer_id: 'other' }), /verified Matter customer identity/);
  await assert.rejects(() => reconcile(r), { code: 'KITCHEN_PREPARATION_BUSY' });
  assert.equal(write.mock.callCount(), 1);
});
