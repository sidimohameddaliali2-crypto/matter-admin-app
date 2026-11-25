import test from 'node:test';
import assert from 'node:assert/strict';
import WeeklyMenu from '../models/WeeklyMenu.js';
import MenuItem from '../models/MenuItem.js';
import { assertSavedKitchenAllergies, loadDatedKitchenAllergyOptions } from './kitchenAllergyReview.js';

const date = '2026-11-26';
const nutrition = { customer_name: 'Fixture', allergyProfile: { allergies: ['Peanuts'] } };

test('a previously assigned meal is blocked when its verified recipe contains the recorded allergy', () => {
  const meal = { mealType: 'snack', mealName: 'Snack cup', isAutoAssigned: true };
  const items = [{ mealType: 'snack', mealName: 'Snack cup', cycleMeal: { allergens: ['Peanuts'] } }];
  assert.throws(() => assertSavedKitchenAllergies([meal], { items, rotations: {} }, nutrition, date),
    { code: 'KITCHEN_ALLERGY_REVIEW', message: /Snack cup.*recorded allergies \(Peanuts\)/ });
  assert.equal(meal.isAutoAssigned, true);
});

test('saved manual breakfasts and snacks respect restrictions recorded only on their applicable rotations', () => {
  for (const mealType of ['breakfast', 'snack']) {
    const meal = { mealType, mealName: 'Recipe cup', menuItemId: 'dish', isAutoAssigned: false };
    const items = [{ _id: 'dish', mealType, mealName: meal.mealName }];
    const rotations = { [mealType]: [{ name: meal.mealName, exclusions: ['Peanuts'] }] };
    assert.throws(() => assertSavedKitchenAllergies([meal], { items, rotations }, nutrition, date),
      { code: 'KITCHEN_ALLERGY_REVIEW', message: /Peanuts/ });
  }
});

test('a saved name-only automatic meal with recorded allergies needs a dated recipe', () => {
  const meal = { mealType: 'snack', mealName: 'Snack cup', isAutoAssigned: true };
  assert.throws(() => assertSavedKitchenAllergies([meal], { items: [], rotations: {} }, nutrition, date),
    { code: 'KITCHEN_ALLERGY_REVIEW', message: /no verified dated recipe/ });
  assert.doesNotThrow(() => assertSavedKitchenAllergies([meal], { items: [{ _id: 'safe', mealType: 'snack', mealName: 'Snack cup' }], rotations: {} }, nutrition, date));
});

test('a namesake cannot replace the saved recipe ID for an allergy check', () => {
  const meal = { mealType: 'main', mealName: 'House bowl', menuItemId: 'removed', isAutoAssigned: true };
  const items = [{ _id: 'safe', mealType: 'main', mealName: 'House bowl' }];
  assert.throws(() => assertSavedKitchenAllergies([meal], { items, rotations: {} }, nutrition, date),
    { code: 'KITCHEN_ALLERGY_REVIEW', message: /no verified dated recipe/ });
});

for (const isAutoAssigned of [false, true, undefined]) test(`a name-only legacy main must match the recorded protein (Auto: ${isAutoAssigned})`, () => {
  const meal = { mealType: 'main', mealName: 'House bowl', manualProteinType: 'beef', isAutoAssigned };
  const fish = { _id: 'fish', mealType: 'main', mealName: 'House bowl', portionType: 'fish' };
  const beef = { ...fish, _id: 'beef', portionType: 'beef' };
  assert.throws(() => assertSavedKitchenAllergies([meal], { items: [fish], rotations: {} }, nutrition, date),
    { code: 'KITCHEN_ALLERGY_REVIEW', message: /no verified dated recipe/ });
  const rotations = { main: [{ name: fish.mealName, type: 'fish', exclusions: ['Peanuts'] }] };
  assert.doesNotThrow(() => assertSavedKitchenAllergies([meal],
    { items: [fish, beef], rotations, usesLegacyMainRotation: true }, nutrition, date));
});

test('an exact safe recipe does not inherit a namesake rotation for a different protein', () => {
  const meal = { mealType: 'main', mealName: 'House bowl', menuItemId: 'safe', isAutoAssigned: true };
  const items = [{ _id: 'safe', mealType: 'main', mealName: 'House bowl', portionType: 'beef' }];
  const rotations = { main: [{ name: 'House bowl', type: 'fish', exclusions: ['Peanuts'] }] };
  assert.doesNotThrow(() => assertSavedKitchenAllergies([meal], { items, rotations, usesLegacyMainRotation: true }, nutrition, date));
});

test('a tagged meal ignores the obsolete main rotation when the live tagged source is used', () => {
  const meal = { mealType: 'main', mealName: 'House bowl', menuItemId: 'safe', isAutoAssigned: true };
  const items = [{ _id: 'safe', mealType: 'main', mealName: 'House bowl', portionType: 'beef', rotationCategory: 'main' }];
  const rotations = { main: [{ name: 'House bowl', type: 'beef', kitchenMenuItemId: 'safe', exclusions: ['Peanuts'] }] };
  assert.doesNotThrow(() => assertSavedKitchenAllergies([meal], { items, rotations, usesLegacyMainRotation: false }, nutrition, date));
  assert.throws(() => assertSavedKitchenAllergies([meal], { items, rotations, usesLegacyMainRotation: true }, nutrition, date),
    { code: 'KITCHEN_ALLERGY_REVIEW' });
});

test('an exact legacy sub recipe retains its own restriction tags when it shares a name and protein with a main', async t => {
  const meal = { mealType: 'main', mealName: 'House bowl', menuItemId: 'sub', isAutoAssigned: true };
  const items = [{ _id: 'legacy-main', mealType: 'main', mealName: 'House bowl', portionType: 'beef' },
    { _id: 'sub', mealType: 'main', mealName: 'House bowl', portionType: 'beef', rotationCategory: 'sub' }];
  t.mock.method(WeeklyMenu, 'findById', () => ({ select() { return this; }, lean: async () => ({
    meals: [{ items: items.map(item => item._id) }],
    mainMealOptionsByDate: { [date]: { mainMeals: [{ name: 'House bowl', type: 'beef', exclusions: ['Peanuts'] }],
      subMeals: [{ name: 'House bowl', type: 'beef' }] } },
  }) }));
  t.mock.method(MenuItem, 'find', () => ({ lean: async () => items }));
  const options = await loadDatedKitchenAllergyOptions('menu', date);
  assert.doesNotThrow(() => assertSavedKitchenAllergies([meal], options, nutrition, date));
  assert.throws(() => assertSavedKitchenAllergies([{ ...meal, menuItemId: 'legacy-main' }], options, nutrition, date),
    { code: 'KITCHEN_ALLERGY_REVIEW' });
});

test('a verified legacy recipe copy inherits its rotation allergy restrictions in a saved selection', async t => {
  const meal = { mealType: 'main', mealName: 'Lunch House Bowl', menuItemId: 'copy', isAutoAssigned: true };
  const recipe = { mealType: 'main', portionType: 'chicken', cycleMeal: { mealType: 'Chicken',
    components: [{ type: 'Protein', name: 'Roasted chicken', ingredients: ['Chicken'] }] } };
  const items = [{ ...recipe, _id: 'original', mealName: 'House Bowl' },
    { ...recipe, _id: 'copy', mealName: meal.mealName, rotationCategory: 'sub' }];
  t.mock.method(WeeklyMenu, 'findById', () => ({ select() { return this; }, lean: async () => ({
    meals: [{ items: items.map(item => item._id) }],
    mainMealOptionsByDate: { [date]: { mainMeals: [{ name: 'House Bowl', type: 'chicken', exclusions: ['Sesame'] }] } },
  }) }));
  t.mock.method(MenuItem, 'find', () => ({ lean: async () => items }));
  const options = await loadDatedKitchenAllergyOptions('menu', date);
  assert.throws(() => assertSavedKitchenAllergies([meal], options,
    { ...nutrition, allergyProfile: { allergies: ['Sesame'] } }, date), { code: 'KITCHEN_ALLERGY_REVIEW' });
});

test('saved protein overrides are checked alongside the dated recipe', () => {
  const meal = { mealType: 'main', mealName: 'House bowl', menuItemId: 'dish', manualProteinType: 'fish' };
  const items = [{ _id: 'dish', mealType: 'main', mealName: 'House bowl', portionType: 'beef' }];
  assert.throws(() => assertSavedKitchenAllergies([meal], { items, rotations: {} },
    { ...nutrition, allergyProfile: { allergies: ['Fish'] } }, date), { code: 'KITCHEN_ALLERGY_REVIEW', message: /Fish/ });
});

test('a legacy custom meal checks its selected components and their ingredients instead of the placeholder recipe', () => {
  const meal = { mealType: 'main', mealName: 'Meal 2 - Protein: Beef, Veg: Carrot, Carb: Rice',
    slotNumber: 2, menuItemId: 'placeholder', proteinChoice: 'Beef', vegChoice: 'Carrot', carbChoice: 'Rice', sauceChoice: 'Lemon herb' };
  const items = [{ _id: 'placeholder', mealType: 'main', mealName: 'Shrimp bowl', allergens: ['Shrimp'] },
    { _id: 'other', mealType: 'main', mealName: 'Butcher bowl', proteinSource: 'Beef', veg: 'Carrot', carbs: 'Rice', cycleMeal: { components: [
      { type: 'Sauce', name: 'Lemon herb', ingredients: [{ name: 'Lemon' }] },
    ] } }];
  const profile = { ...nutrition, allergyProfile: { allergies: ['Shellfish'] } };
  assert.doesNotThrow(() => assertSavedKitchenAllergies([meal], { items, rotations: {} }, profile, date));
  assert.throws(() => assertSavedKitchenAllergies([{ ...meal, sauceChoice: 'Archived sauce' }], { items, rotations: {} }, profile, date),
    { code: 'KITCHEN_ALLERGY_REVIEW', message: /unverified dated components \(Archived sauce\)/ });
  assert.doesNotThrow(() => assertSavedKitchenAllergies([{ ...meal, sauceChoice: '' }], { items, rotations: {} }, profile, date));
  const declaredItems = [items[0], { ...items[1], allergens: ['Peanuts'] }];
  assert.throws(() => assertSavedKitchenAllergies([meal], { items: declaredItems, rotations: {} }, nutrition, date),
    { code: 'KITCHEN_ALLERGY_REVIEW', message: /recorded allergies \(Peanuts\)/ });
  const legacy = { items, rotations: {}, usesLegacyMainRotation: true,
    legacyMainRestrictions: new Map([['other', ['Peanuts']]]) };
  assert.throws(() => assertSavedKitchenAllergies([meal], legacy, nutrition, date),
    { code: 'KITCHEN_ALLERGY_REVIEW', message: /recorded allergies \(Peanuts\)/ });
  items[1].cycleMeal.components[0].ingredients.push({ name: 'Clams', visible: false });
  assert.throws(() => assertSavedKitchenAllergies([meal], { items, rotations: {} }, profile, date),
    { code: 'KITCHEN_ALLERGY_REVIEW', message: /Shellfish/ });
  assert.throws(() => assertSavedKitchenAllergies([{ ...meal, isAutoAssigned: true }], { items, rotations: {} }, profile, date),
    { code: 'KITCHEN_ALLERGY_REVIEW' });
});
