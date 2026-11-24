import test from 'node:test';
import assert from 'node:assert/strict';
import { hydrateMainRotation, kitchenConflictFields, kitchenConflictList, mergeKitchenMetadata } from './kitchenExclusions.js';

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

test('snack hydration keeps exact names when another dated item has different spacing', () => {
  const [snack] = mergeKitchenMetadata([{ name: 'Cocoa Bite' }], [
    { mealName: 'Cocoa  Bite' },
    { mealName: 'Cocoa Bite', cycleMeal: { components: [{ type: 'Snack', exclusions: ['Sesame'] }] } },
  ]);
  assert.deepEqual(kitchenConflictList(snack, ['Sesame']), ['Sesame']);
});

test('legacy rotation does not link a same-name recipe with a different explicit protein', () => {
  const option = { name: 'House Bowl', type: 'chicken' };
  assert.deepEqual(hydrateMainRotation([option], [
    { _id: 'beef-id', mealName: option.name, portionType: 'beef' },
  ]), [option]);
  assert.deepEqual(hydrateMainRotation([option], [
    { _id: 'beef-id', mealName: option.name, portionType: '', cycleMeal: { mealType: 'Beef' } },
  ]), [option]);
});

test('a compatible dated recipe still supplies exclusions when an exact name belongs to a different protein', () => {
  const [option] = hydrateMainRotation([{ name: 'House Bowl', type: 'chicken' }], [
    { _id: 'beef-id', mealName: 'House Bowl', portionType: 'beef' },
    { _id: 'chicken-id', mealName: 'House  Bowl', portionType: 'chicken',
      cycleMeal: { components: [{ type: 'Sauce', exclusions: ['Sesame'] }] } },
  ]);
  assert.equal(option._id, 'chicken-id');
  assert.deepEqual(kitchenConflictList(option, ['Sesame']), ['Sesame']);
});

test('recipe-level metadata adds main exclusions while snack eligibility keeps its component rules', () => {
  const cycleMeal = { allergens: ['Sesame'], components: [{ type: 'Snack', exclusions: ['Soy'] }] };
  assert.deepEqual(kitchenConflictList({ mealType: 'main', cycleMeal }, ['Soy', 'Sesame']), ['Soy', 'Sesame']);
  assert.deepEqual(kitchenConflictList({ mealType: 'snack', cycleMeal }, ['Soy', 'Sesame']), ['Soy']);
});

test('hydrating a legacy main retains exclusion terms from its original name', () => {
  const [option] = hydrateMainRotation([{ name: 'Raw Onion Chicken', type: 'chicken' }], [
    { _id: 'dated-id', mealName: 'Raw  Onion Chicken', portionType: 'chicken' },
  ]);
  assert.equal(option._id, 'dated-id');
  assert.equal(option.name, 'Raw  Onion Chicken');
  assert.deepEqual(kitchenConflictList(option, ['Raw Onion']), ['Raw Onion']);
});

test('a fuzzy legacy name cannot take over an explicitly configured dated substitute', () => {
  const main = { name: 'House  Bowl', type: 'chicken', exclusions: ['Sesame'] };
  const sub = { name: 'House Bowl', type: 'chicken' };
  const items = [{ _id: 'dated-id', mealName: sub.name, portionType: 'chicken' }];
  assert.deepEqual(hydrateMainRotation([main], items, [main, sub]), [main]);
  const [matchedSub] = hydrateMainRotation([sub], items, [main, sub]);
  assert.equal(matchedSub._id, 'dated-id');
  assert.deepEqual(kitchenConflictList(matchedSub, ['Sesame']), []);
});

test('same-name rotation roles cannot bypass exact-name reservation for a separate substitute', () => {
  const main = { name: 'House Bowl', type: 'chicken', exclusions: ['Sesame'] };
  const oldSub = { ...main };
  const safeSub = { name: 'House  Bowl', type: 'chicken' };
  const items = [{ _id: 'safe-sub', mealName: safeSub.name, portionType: 'chicken', rotationCategory: 'sub' }];
  const rotation = [main, oldSub, safeSub];
  const [first, second] = hydrateMainRotation([oldSub, safeSub], items, rotation, 'sub');
  assert.equal(first._id, undefined);
  assert.equal(second._id, 'safe-sub');
  assert.deepEqual(kitchenConflictList(second, ['Sesame']), []);
});

test('two fuzzy pool names cannot share a dated substitute meant for the sub pool', () => {
  const main = { name: 'House Bowl', type: 'chicken', exclusions: ['Sesame'] };
  const sub = { name: 'House  Bowl', type: 'chicken' };
  const items = [{ _id: 'safe-sub', mealName: 'House   Bowl', portionType: 'chicken', rotationCategory: 'sub' }];
  assert.deepEqual(hydrateMainRotation([main], items, [main, sub], 'main'), [main]);
  const [matched] = hydrateMainRotation([sub], items, [main, sub], 'sub');
  assert.equal(matched._id, 'safe-sub');
  assert.deepEqual(kitchenConflictList(matched, ['Sesame']), []);
});

test('an exact name in the wrong pool does not hide the dated substitute exclusions', () => {
  const main = { name: 'Roast Chicken', type: 'chicken', exclusions: ['Sesame'] };
  const sub = { name: 'Roast  Chicken', type: 'chicken', exclusions: ['Sesame'] };
  const items = [{ _id: 'sub', mealName: main.name, portionType: 'chicken', rotationCategory: 'sub' }];
  assert.deepEqual(hydrateMainRotation([main], items, [main, sub], 'main'), [main]);
  const [matched] = hydrateMainRotation([sub], items, [main, sub], 'sub');
  assert.equal(matched._id, 'sub');
  assert.deepEqual(kitchenConflictList(matched, ['Sesame']), ['Sesame']);
});

test('a fuzzy main name prefers an untagged dated recipe over a separate tagged sub', () => {
  const main = { name: 'House   Bowl', type: 'chicken' };
  const items = [
    { _id: 'safe-sub', mealName: 'House  Bowl', portionType: 'chicken', rotationCategory: 'sub' },
    { _id: 'safe-main', mealName: 'House Bowl', portionType: 'chicken' },
  ];
  assert.deepEqual(hydrateMainRotation([main], items, [main], 'main').map(option => option._id), ['safe-main']);
});

test('duplicate aliases in one pool retain saved restrictions on the only dated match', () => {
  const options = ['House Bowl', 'HOUSE BOWL'].map(name => ({ name, type: 'chicken', exclusions: ['Soy'] }));
  const items = [{ _id: 'dated-sub', mealName: 'House Bowl', portionType: 'chicken', rotationCategory: 'sub' }];
  const matches = hydrateMainRotation(options, items, options, 'main');
  assert(matches.every(option => option._id === 'dated-sub' && kitchenConflictList(option, ['Soy']).includes('Soy')));
});

test('same-name legacy entries with different proteins only use compatible dated recipe IDs', () => {
  const options = ['chicken', 'beef'].map(type => ({ name: 'House Bowl', type }));
  const items = ['ambiguous-a', 'ambiguous-b'].map(_id => ({ _id, mealName: 'House Bowl' }));
  assert.deepEqual(hydrateMainRotation(options, items), options);
  items[0].portionType = 'beef';
  items[1].cycleMeal = { mealType: 'Chicken' };
  assert.deepEqual(hydrateMainRotation(options, items).map(option => option._id), ['ambiguous-b', 'ambiguous-a']);
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

test('attached topping exclusions still apply after an empty legacy component', () => {
  const meal = { cycleMeal: { components: [null, { id: 'rice', type: 'Carb' },
    { type: 'Extra sauce / topping', attachedComponentId: 'rice', exclusions: ['Sesame'] }] } };
  assert.deepEqual(kitchenConflictFields(meal, ['Sesame']).carbConflict, ['Sesame']);
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
  assert.deepEqual(kitchenConflictList({ mealType: 'main', name: 'Raw  Onion Chicken' }, ['Raw Onion']), ['Raw Onion']);
});

for (const saladMarker of [{ isSaladBase: true }, { components: [{ id: 'salad', type: 'Salad' }] }]) {
  test(`salad dressing and attached toppings request veg replacement (${JSON.stringify(saladMarker)})`, () => {
    const meal = { cycleMeal: { ...saladMarker, components: [...(saladMarker.components || []),
      { id: 'dressing', type: 'Sauce 2', exclusions: ['Soy'] },
      { id: 'topping', type: 'Extra sauce / topping', attachedComponentId: 'dressing', exclusions: ['All Nuts'] },
      { id: 'sauce', type: 'Sauce', exclusions: ['Egg'] },
    ] } };
    const flags = kitchenConflictFields(meal, ['Soy', 'All Nuts']);
    assert.deepEqual(flags.vegConflict, ['Soy', 'All Nuts']);
    assert.equal(flags.carbVegAction, 'replace');
    assert.equal(flags.remark, 'veg');
    assert.equal(flags.needsSauceChange, false);
    assert.deepEqual(kitchenConflictFields(meal, ['Egg']).sauceConflict, ['Egg']);
    const warmMeal = { cycleMeal: { components: [{ type: 'Sauce 2', exclusions: ['Soy'] }] } };
    assert.deepEqual(kitchenConflictFields(warmMeal, ['Soy']).sauceConflict, ['Soy']);
  });
}

test('a negative salad tag keeps a Sauce 2 conflict in the sauce group', () => {
  const option = { cycleMeal: { tags: 'WARM; NO SALAD BASE', components: [{ type: 'Sauce 2', exclusions: ['Sesame'] }] } };
  const flags = kitchenConflictFields(option, ['Sesame']);
  assert.deepEqual(flags.vegConflict, []);
  assert.deepEqual(flags.sauceConflict, ['Sesame']);
  assert.equal(flags.needsSauceChange, true);
});
