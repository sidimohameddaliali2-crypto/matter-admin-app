import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPreparedCoverage } from './kitchenCoverage.js';

test('snapshot completeness enforces Core double days, extra breakfast and snacks', () => {
  const date = '2026-10-26';
  const sub = { customer_id: 'person', name: 'Core fixture', meal_frequency: 2, plan_name: 'Matter Core',
    active_delivery_dates: [date, '2026-10-28', '2026-10-30'], snacks_per_day: 1, breakfast_included: true };
  const meals = Array.from({ length: 4 }, () => ({ date, mealType: 'main', quantity: 1 }));
  const data = { kitchenRoster: [sub], kitchenSelections: [{ matterCustomerId: 'person', selectedMeals: meals }],
    kitchenBreakfastPreset: { presetsByName: { breakfast: { C: 10, P: 30, F: 5 } } }, kitchenSnackPreset: { presetsByName: { snack: { C: 10, P: 5, F: 3 } } } };
  assert.throws(() => assertPreparedCoverage(data, date), /snacks/);
  meals.push({ date, mealType: 'snack', mealName: 'Snack' });
  assert.throws(() => assertPreparedCoverage(data, date), /breakfast/);
  meals.push({ date, mealType: 'breakfast', mealName: 'Breakfast' });
  assert.doesNotThrow(() => assertPreparedCoverage(data, date));
  meals.splice(0, 1);
  assert.throws(() => assertPreparedCoverage(data, date), /needs 4 meal/);
});
