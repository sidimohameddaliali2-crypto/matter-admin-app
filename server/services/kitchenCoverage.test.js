import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPreparedCoverage } from './kitchenCoverage.js';

test('Core single delivery rejects extra portions, including quantity, without changing ordinary plan policy', () => {
  const date = '2026-11-06';
  const sub = { customer_id: 'person', name: 'Lauren fixture', meal_frequency: 1, plan_name: 'Matter Core',
    active_delivery_dates: [date], double_delivery_dates: [] };
  const data = { kitchenRoster: [sub], kitchenSelections: [{ matterCustomerId: 'person', selectedMeals: [{ date, mealType: 'main', quantity: 2 }] }] };
  assert.throws(() => assertPreparedCoverage(data, date), /entitlement is 1/);
  data.kitchenSelections[0].selectedMeals[0].quantity = 1;
  assert.doesNotThrow(() => assertPreparedCoverage(data, date));
  sub.plan_name = 'Custom'; data.kitchenSelections[0].selectedMeals[0].quantity = 2;
  assert.doesNotThrow(() => assertPreparedCoverage(data, date));
});

test('snapshot completeness enforces Core double days, extra breakfast and snacks', () => {
  const date = '2026-10-26';
  const sub = { customer_id: 'person', name: 'Core fixture', meal_frequency: 2, plan_name: 'Matter Core',
    active_delivery_dates: [date, '2026-10-28', '2026-10-30'], snacks_per_day: 1, breakfast_included: true };
  const meals = Array.from({ length: 4 }, () => ({ date, mealType: 'main', quantity: 1 }));
  const data = { kitchenRoster: [sub], kitchenSelections: [{ matterCustomerId: 'person', selectedMeals: meals }],
    kitchenBreakfastPreset: { presetsByName: { breakfast: { C: 10, P: 30, F: 5 } } }, kitchenSnackPreset: { presetsByName: { snack: { C: 10, P: 5, F: 3 } } } };
  assert.throws(() => assertPreparedCoverage(data, date), /snacks/);
  meals.push({ date, mealType: 'snack', mealName: 'Snack' });
  assert.throws(() => assertPreparedCoverage(data, date), /snacks \(1 of 2\)/);
  meals.at(-1).quantity = 2;
  assert.throws(() => assertPreparedCoverage(data, date), /breakfast/);
  meals.push({ date, mealType: 'breakfast', mealName: 'Breakfast' });
  assert.throws(() => assertPreparedCoverage(data, date), /breakfast portions \(1 of 2\)/);
  data.kitchenSelections[0].kitchenAutoHolds = [{ date }];
  assert.doesNotThrow(() => assertPreparedCoverage(data, date, { allowManualHolds: true }));
  assert.throws(() => assertPreparedCoverage(data, date), /breakfast/);
  meals.at(-1).quantity = 2;
  assert.doesNotThrow(() => assertPreparedCoverage(data, date));
  meals.splice(0, 1);
  assert.throws(() => assertPreparedCoverage(data, date), /needs 4 meal/);
});

for (const kind of ['breakfast', 'snack']) test(`coverage flags surplus automatic Core ${kind} portions on an unresolved legacy calendar`, () => {
  const date = '2026-10-26';
  const sub = { customer_id: 'person', name: 'Core fixture', meal_frequency: 1, plan_name: 'Matter Core',
    active_delivery_dates: [date, '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'],
    snacks_per_day: kind === 'snack' ? 1 : 0, breakfast_included: kind === 'breakfast' };
  const tagged = { date, mealType: kind, coreDeliveryFoodDay: 2, isAutoAssigned: true };
  const meals = [{ date, mealType: 'main' }, { date, mealType: kind }, tagged];
  const data = { kitchenRoster: [sub], kitchenSelections: [{ matterCustomerId: 'person', selectedMeals: meals }] };
  assert.throws(() => assertPreparedCoverage(data, date), /confirm the Matter schedule/);
  tagged.isAutoAssigned = false;
  assert.doesNotThrow(() => assertPreparedCoverage(data, date));
});
