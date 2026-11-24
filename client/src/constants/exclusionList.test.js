import { allergenMatchesAny, exclusionMatchesAny } from './exclusionList';

test.each([
  ['All Nuts', 'Almond Flour'], ['All Nuts', 'Roasted Cashews'],
  ['All Sea Food', 'Shrimp'], ['All Fish', 'Grilled Salmon'],
  ['Potato', 'Sweet Potato Mash'], ['All Seafood', 'Calamari'],
])('%s detects %s in recipe names', (exclusion, term) => {
  expect(exclusionMatchesAny(exclusion, [term])).toBe(true);
});

test('whole-word boundaries and explicit free labels prevent incorrect dietary warnings', () => {
  expect(exclusionMatchesAny('Egg', ['Eggplant'])).toBe(false);
  expect(exclusionMatchesAny('Pea', ['Peanut Butter'])).toBe(false);
  expect(exclusionMatchesAny('Gluten', ['Gluten Free Flour'])).toBe(false);
  expect(exclusionMatchesAny('Gluten-Free', ['Gluten Free Flour'])).toBe(false);
  expect(exclusionMatchesAny('Gluten-Free', ['Gluten'])).toBe(true);
});

test('allergy matching handles full ingredient names, plurals and declared category aliases', () => {
  expect(allergenMatchesAny('Milk', ['Whole Milk'])).toBe(true);
  expect(allergenMatchesAny('Milk', ['Dairy'])).toBe(true);
  expect(allergenMatchesAny('Eggs', ['Boiled Egg'])).toBe(true);
  expect(allergenMatchesAny('Nuts', ['Almond Flour'])).toBe(true);
  expect(allergenMatchesAny('Fish', ['Grilled Salmon'])).toBe(true);
  expect(allergenMatchesAny('Shellfish', ['Shrimp'])).toBe(true);
  expect(allergenMatchesAny('Fish', ['Shrimp'])).toBe(false);
  expect(allergenMatchesAny('Egg', ['Eggplant'])).toBe(false);
});

test('a free claim never suppresses an explicit matching allergen', () => {
  expect(allergenMatchesAny('Gluten', ['Gluten Free Flour', 'Gluten'])).toBe(true);
});

test('Raw Onion requires the full phrase while Onion remains a general exclusion', () => {
  for (const term of ['Onion', 'Cooked Onion', 'Caramelized Onion', 'Onion Sauce']) {
    expect(exclusionMatchesAny('Raw Onion', [term])).toBe(false);
  }
  for (const term of ['Raw Onion', 'RAW ONION', 'Salad with Raw Onion']) {
    expect(exclusionMatchesAny('Raw Onion', [term])).toBe(true);
  }
  expect(exclusionMatchesAny('Onion', ['Raw Onion'])).toBe(true);
  expect(allergenMatchesAny('Onion', ['Raw Onion'])).toBe(true);
});


test.each([['Milk', 'Butter'], ['Gluten', 'Wheat flour'], ['Soy', 'Tofu'], ['All Nuts', 'Brazil nuts']])('%s matches its ingredient %s', (allergy, ingredient) => {
  expect(allergenMatchesAny(allergy, [ingredient])).toBe(true);
});

test('milk category distinguishes named plant ingredients while respecting explicit declarations', () => {
  expect(allergenMatchesAny('Milk', ['Peanut butter', 'Coconut milk'])).toBe(false);
  expect(allergenMatchesAny('Milk', ['Coconut milk', 'Milk'])).toBe(true);
});


test.each(['Cream Dory', 'Butter beans'])('milk does not block the non-dairy ingredient %s', ingredient => {
  expect(allergenMatchesAny('Milk', [ingredient])).toBe(false);
  expect(allergenMatchesAny('Dairy', [ingredient, 'Milk'])).toBe(true);
});

test('tree nuts do not expand generic nut aliases back to peanuts', () => {
  expect(allergenMatchesAny('Tree nuts', ['Peanut butter'])).toBe(false);
  expect(allergenMatchesAny('Tree nuts', ['Almond flour'])).toBe(true);
  expect(allergenMatchesAny('All Nuts', ['Peanut butter'])).toBe(true);
});
