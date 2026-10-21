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
