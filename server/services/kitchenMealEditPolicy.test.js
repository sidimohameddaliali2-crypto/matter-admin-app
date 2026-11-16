import test from 'node:test';
import assert from 'node:assert/strict';
import { assertMealEditsOpen, planMealEdit, dayHeld } from './kitchenMealEditPolicy.js';
const date = '2026-11-16', actor = { id: 'staff', name: 'Ahmed' };
const record = { selectedMeals: [{ _id: 'chosen', date, mealName: 'Chicken', mealType: 'main', quantity: 2 }, { _id: 'other', date: '2026-11-17', mealName: 'Beef' }] };
test('staff edits close at the same Dubai cutoff used to open auto assignment', () => {
  assert.doesNotThrow(() => assertMealEditsOpen({}, date, '2026-11-13T11:00:59.999Z'));
  assert.throws(() => assertMealEditsOpen({}, date, '2026-11-13T11:01:00Z'), { code: 'KITCHEN_MEAL_EDIT_CLOSED' });
});
test('deletion can remove one or all portions, never changes other dates, and persists a manual hold', () => {
  const before = JSON.stringify(record);
  const one = planMealEdit({ record, action: 'delete', mealId: 'chosen', quantity: 1, date, actor });
  assert.equal(one.selectedMeals[0].quantity, 1);
  assert.equal(one.selectedMeals[1], record.selectedMeals[1]);
  assert.equal(dayHeld(one, date), true);
  assert.equal(one.kitchenAutoHolds[0].actorName, 'Ahmed');
  const all = planMealEdit({ record, action: 'delete', mealId: 'chosen', quantity: 2, date, actor });
  assert.equal(all.selectedMeals.length, 1);
  assert.equal(JSON.stringify(record), before);
});
test('manual replacement preserves an existing hold until explicit restore and never alters another portion', () => {
  const held = { ...record, kitchenAutoHolds: [{ date }] };
  const changed = planMealEdit({ record: held, action: 'change', mealId: 'chosen', quantity: 1, replacement: { mealName: 'Fish', mealType: 'main' }, date, actor });
  assert.equal(changed.selectedMeals[0].quantity, 1);
  assert.equal(changed.selectedMeals.at(-1).mealName, 'Fish');
  assert.equal(changed.selectedMeals.at(-1).isAutoAssigned, false);
  assert.equal(dayHeld(changed, date), true);
  assert.equal(dayHeld(planMealEdit({ record: { ...held, ...changed }, action: 'restore', date, actor }), date), false);
});
