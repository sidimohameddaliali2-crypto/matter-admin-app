import test from 'node:test';
import assert from 'node:assert/strict';
import { kitchenConflictFields, kitchenConflictList, mergeKitchenMetadata } from './kitchenExclusions.js';

test('cycle snack exclusions survive empty legacy rotation tags without mutating either source', () => {
  const options = [{ name: 'BRAIN CLUSTER', exclusions: [] }];
  const items = [{ mealName: 'BRAIN CLUSTER', intolerances: '', cycleMeal: { components: [
    { type: 'Snack', name: 'BRAIN CLUSTER', exclusions: ['All Nuts'] },
  ] } }];
  const before = JSON.stringify({ options, items });
  const [option] = mergeKitchenMetadata(options, items);
  assert.deepEqual(kitchenConflictList(option, ['All Nuts', 'Peanuts']), ['All Nuts']);
  assert.equal(JSON.stringify({ options, items }), before);
  assert.deepEqual(kitchenConflictList(option, ['Soy']), []);
});

test('cycle exclusions set the corresponding kitchen component flags', () => {
  const meal = { cycleMeal: { components: [
    { type: 'Carb', exclusions: ['Gluten'] }, { type: 'Vegetable', exclusions: ['Capsicum'] },
    { type: 'Sauce', exclusions: ['Soy'] }, { type: 'Garnish', exclusions: ['Sesame'] },
    { type: 'Breakfast', exclusions: ['Egg'] },
  ] } };
  const flags = kitchenConflictFields(meal, ['Gluten', 'Capsicum', 'Soy', 'Sesame', 'Egg']);
  assert.deepEqual(flags.carbConflict, ['Gluten']);
  assert.deepEqual(flags.vegConflict, ['Capsicum']);
  assert.deepEqual(flags.sauceConflict, ['Soy']);
  assert.deepEqual(flags.garnishConflict, ['Sesame']);
  assert.ok(flags.exclusionConflict.includes('Egg'));
});

test('attached component exclusions follow their target, unknown types still block, cyclic attachments terminate', () => {
  const meal = { cycleMeal: { components: [
    { id: 'carb', type: 'Carb' },
    { id: 'topping', type: 'Extra sauce / topping', attachedComponentId: 'carb', exclusions: ['All Nuts'] },
    { id: 'unknown', type: 'New component type', exclusions: ['Soy'] },
    { id: 'a', type: 'Extra sauce / topping', attachedComponentId: 'b', exclusions: ['Egg'] },
    { id: 'b', type: 'Extra sauce / topping', attachedComponentId: 'a' },
  ] } };
  assert.deepEqual(kitchenConflictFields(meal, ['All Nuts']).carbConflict, ['All Nuts']);
  assert.deepEqual(kitchenConflictList(meal, ['Soy', 'Egg']), ['Soy', 'Egg']);
});

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

test('Raw Onion does not flag generic or cooked onion in kitchen components', () => {
  assert.deepEqual(kitchenConflictList({ veg: 'Onion', sauce: 'Cooked Onion', ingredients: ['Caramelized Onion'] }, ['Raw Onion']), []);
  assert.deepEqual(kitchenConflictFields({ veg: 'Salad with Raw Onion' }, ['Raw Onion']).vegConflict, ['Raw Onion']);
  assert.deepEqual(kitchenConflictList({ veg: 'Raw Onion' }, ['Onion']), ['Onion']);
});
