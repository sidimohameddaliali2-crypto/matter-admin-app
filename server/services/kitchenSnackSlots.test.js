import test from 'node:test';
import assert from 'node:assert/strict';
import { missingCoreSnackSlots } from './kitchenSnackSlots.js';
const pools = { first: [{ name: 'First' }], second: [{ name: 'Second' }] };

test('a saved second slot leaves only the failed first slot pending', () => {
  assert.deepEqual(missingCoreSnackSlots([{ mealName: 'Second', slotNumber: 1 }], 2, pools), [0]);
  assert.deepEqual(missingCoreSnackSlots([{ mealName: 'First', slotNumber: 0 }], 2, pools), [1]);
});

test('legacy unnumbered second-pool snacks and quantities are preserved without mutation', () => {
  const meals = [{ mealName: 'SECOND', quantity: 1 }], before = JSON.stringify(meals);
  assert.deepEqual(missingCoreSnackSlots(meals, 2, pools), [0]);
  assert.equal(JSON.stringify(meals), before);
  assert.deepEqual(missingCoreSnackSlots([{ mealName: 'First', quantity: 2 }], 2, pools), []);
  assert.deepEqual(missingCoreSnackSlots([{ mealName: 'Old removed option', quantity: 2 }], 2, pools), []);
});

test('numbered portions are reserved before legacy portions regardless of record order', () => {
  assert.deepEqual(missingCoreSnackSlots([{ mealName: 'Second' }, { mealName: 'First', slotNumber: 0 }], 2, pools), []);
  assert.deepEqual(missingCoreSnackSlots([], 0, pools), []);
});

test('ineligible legacy snacks keep their unique original pool slot', () => {
  const raw = { first: [{ name: 'First' }], second: [{ name: 'Second' }, { name: 'Alternative second' }] };
  const eligible = { first: raw.first, second: [raw.second[1]] };
  const meals = [{ mealName: 'SECOND' }], before = JSON.stringify(meals);
  assert.deepEqual(missingCoreSnackSlots(meals, 2, eligible, raw), [0]);
  assert.equal(JSON.stringify(meals), before);
  assert.deepEqual(missingCoreSnackSlots([{ mealName: 'First' }], 2, { first: [], second: raw.second }, raw), [1]);
});

test('eligible matches still take priority over ambiguous raw names', () => {
  const raw = { first: [{ name: 'Shared' }], second: [{ name: 'Shared' }] };
  const eligible = { first: [], second: raw.second };
  assert.deepEqual(missingCoreSnackSlots([{ mealName: 'Shared' }], 2, eligible, raw), [0]);
  assert.deepEqual(missingCoreSnackSlots([{ mealName: 'Shared', slotNumber: 0 }], 2, eligible, raw), [1]);
  assert.deepEqual(missingCoreSnackSlots([{ mealName: 'Shared', quantity: 2 }], 2, eligible, raw), []);
});
