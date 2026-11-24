import test from 'node:test';
import assert from 'node:assert/strict';
import Record from '../models/MenuSelectionRecord.js';
import { reconcileCoreDoubleAddOns, reconcileCoreMainMeals } from './kitchenCoreEntitlement.js';
import { missingCoreSnackSlots } from './kitchenSnackSlots.js';
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

test('verified Core single days remove only surplus automatic doubles for that date', async t => {
  const input = { ...nutrition, breakfast_included: true, snacks_per_day: 2 };
  const savedBreakfast = meal({ mealType: 'breakfast', mealName: 'Saved eggs', isAutoAssigned: false, remark: 'adjust sauce' });
  const extraBreakfast = meal({ mealType: 'breakfast', mealName: 'Extra breakfast', coreDeliveryFoodDay: 2 });
  const savedSnack = meal({ mealType: 'snack', mealName: 'Saved snack', isAutoAssigned: false });
  const extraSnack = meal({ mealType: 'snack', mealName: 'Extra snacks', quantity: 2, coreDeliveryFoodDay: 2, coreDeliverySnackSlot: 0, slotNumber: 2 });
  const otherDay = { ...extraBreakfast, date: '2026-11-04' };
  const r = record([savedBreakfast, extraBreakfast, savedSnack, extraSnack, otherDay]);
  const expected = [savedBreakfast, savedSnack, otherDay];
  const update = t.mock.method(Record, 'updateOne', async (filter, write) => {
    assert.equal(filter.selectedMeals, r.selectedMeals);
    assert.equal(filter.matterCustomerId, r.matterCustomerId);
    assert.deepEqual(filter['kitchenAutoHolds.date'], { $ne: date });
    assert.deepEqual(write.$set.selectedMeals, expected);
    assert.equal(write.$push.kitchenAudit.action, 'reconcile-core-double-add-ons');
    return { modifiedCount: 1 };
  });
  const result = await reconcileCoreDoubleAddOns(r, date, input, now);
  assert.deepEqual(result.selectedMeals, expected);
  assert.equal(await reconcileCoreDoubleAddOns(result, date, input, now), result);
  assert.equal(update.mock.callCount(), 1);
});

test('Core add-on reconciliation leaves held, historical, unresolved and double dates alone', async t => {
  t.mock.method(Record, 'updateOne', () => assert.fail('No removal allowed'));
  const r = record([meal({ mealType: 'snack', coreDeliveryFoodDay: 2, quantity: 2 })]);
  const input = { ...nutrition, snacks_per_day: 1 };
  for (const overrides of [{ double_delivery_dates: null }, { snacks_per_day: null, double_delivery_dates: [date] }, { active_delivery_dates: [] }]) {
    assert.equal(await reconcileCoreDoubleAddOns(r, date, { ...input, ...overrides }, now), r);
  }
  const held = { ...r, kitchenAutoHolds: [{ date }] };
  assert.equal(await reconcileCoreDoubleAddOns(held, date, input, now), held);
  assert.equal(await reconcileCoreDoubleAddOns(r, date, input, new Date('2026-11-07T08:00:00Z')), r);
});

test('an extra second-pool snack is retired when its food day is gone, even if the first slot is empty', async t => {
  const r = record([meal({ mealType: 'snack', mealName: 'Late bite', slotNumber: 1 }),
    meal({ mealType: 'snack', mealName: 'Late bite', slotNumber: 3, coreDeliveryFoodDay: 2, coreDeliverySnackSlot: 1 })]);
  t.mock.method(Record, 'updateOne', async () => ({ modifiedCount: 1 }));
  const result = await reconcileCoreDoubleAddOns(r, date, { ...nutrition, snacks_per_day: 2 }, now);
  const pools = { first: [{ name: 'Early bite' }], second: [{ name: 'Late bite' }] };
  assert.deepEqual(result.selectedMeals, r.selectedMeals.slice(0, 1));
  assert.deepEqual(missingCoreSnackSlots(result.selectedMeals, 2, pools), [0]);
});

test('a lower snack entitlement or plan change retires only previous Core extras', async t => {
  const r = record(Array.from({ length: 4 }, (_, slotNumber) => meal({
    mealType: 'snack', slotNumber, ...(slotNumber >= 2 && { coreDeliveryFoodDay: 2, coreDeliverySnackSlot: slotNumber - 2 }),
  })));
  t.mock.method(Record, 'updateOne', async () => ({ modifiedCount: 1 }));
  const double = { ...nutrition, double_delivery_dates: [date], snacks_per_day: 2 };
  assert.equal(await reconcileCoreDoubleAddOns(r, date, double, now), r);
  for (const input of [{ ...double, snacks_per_day: 1 }, { ...double, plan_name: 'Custom' }]) {
    const updated = await reconcileCoreDoubleAddOns(r, date, input, now);
    assert.deepEqual(updated.selectedMeals, r.selectedMeals.slice(0, 2));
  }
});

test('a smaller daily allowance preserves the only saved snack on each retained food day', async t => {
  const late = (day, slotNumber) => meal({ mealType: 'snack', mealName: 'Late bite', slotNumber,
    coreDeliveryFoodDay: day, coreDeliverySnackSlot: 1 });
  const r = record([late(1, 1), late(2, 3)]);
  t.mock.method(Record, 'updateOne', async () => ({ modifiedCount: 1 }));
  const pools = { first: [], second: [{ name: 'Late bite' }] };
  for (const double of [false, true]) {
    const input = { ...nutrition, snacks_per_day: 1, double_delivery_dates: double ? [date] : [] };
    const updated = await reconcileCoreDoubleAddOns(r, date, input, now);
    const count = double ? 2 : 1;
    assert.deepEqual(updated.selectedMeals, r.selectedMeals.slice(0, count).map((snack, slotNumber) => ({ ...snack, slotNumber })));
    assert.deepEqual(missingCoreSnackSlots(updated.selectedMeals, count, pools, pools, 1), []);
    assert.equal(await reconcileCoreDoubleAddOns(updated, date, input, now), updated);
  }
});

test('a remapped snack does not take a legacy snack’s occupied slot', async t => {
  const saved = meal({ mealType: 'snack', mealName: 'Legacy snack', slotNumber: 0 });
  const previous = meal({ mealType: 'snack', mealName: 'Extra first-day snack', slotNumber: 2,
    coreDeliveryFoodDay: 1, coreDeliverySnackSlot: 2 });
  const r = record([saved, previous]);
  t.mock.method(Record, 'updateOne', async () => ({ modifiedCount: 1 }));
  const result = await reconcileCoreDoubleAddOns(r, date, { ...nutrition, snacks_per_day: 2 }, now);
  const pools = { first: [{ name: 'First' }], second: [{ name: 'Second' }] };
  assert.deepEqual(result.selectedMeals, [saved, { ...previous, slotNumber: 1 }]);
  assert.deepEqual(missingCoreSnackSlots(result.selectedMeals, 2, pools), []);
});
