import test from 'node:test';
import assert from 'node:assert/strict';
import { kitchenConflictFields, kitchenConflictList } from './kitchenExclusions.js';

test('carb and veg conflicts are checked even without global intolerances, including hidden ingredient tags', () => {
  const meal = { name: 'Chicken', carbs: 'Rice', vegIngredients: [{ name: 'Broccoli', visible: false }], sauce: 'Soy sauce', garnish: 'Sesame' };
  const flags = kitchenConflictFields(meal, ['Rice', 'Broccoli', 'Soy', 'Sesame']);
  assert.deepEqual(flags.carbConflict, ['Rice']);
  assert.deepEqual(flags.vegConflict, ['Broccoli']);
  assert.equal(flags.remark, 'carb; veg');
  assert.equal(flags.needsSauceChange, true);
  assert.equal(flags.needsGarnishChange, true);
});

test('auto-selection shares whole-word and umbrella matching with customer selection', () => {
  assert.deepEqual(kitchenConflictList({ carbs: 'Eggplant', veg: 'Peanut' }, ['Egg', 'Pea']), []);
  assert.deepEqual(kitchenConflictList({ carbIngredients: [{ name: 'Almond' }] }, ['All Nuts']), ['All Nuts']);
  assert.deepEqual(kitchenConflictList({ carbs: 'Gluten Free Flour' }, ['Gluten']), []);
});
