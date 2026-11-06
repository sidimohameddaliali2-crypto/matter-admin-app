import april from './aprilCycle.json';
import { parseMealWorkbook, dietaryFlags, componentName, mealFormat } from './workbookMeals';

test('preserves all April meals, component rows, exact categories and the shared weekend', () => {
  const meals = parseMealWorkbook(april.sheets);
  expect(meals).toHaveLength(61);
  expect(meals.reduce((sum, meal) => sum + meal.components.length, 0)).toBe(209);
  expect(meals.filter(m => m.day === 'DAY 6 & 7')).toHaveLength(11);
  expect(new Set(meals.map(m => m.category)).size).toBe(13);
});

test('joins both sauces and garnish by Meal ID and aggregates flags across components', () => {
  const meal = parseMealWorkbook(april.sheets).find(m => m.id === 'APR1-002');
  expect(componentName(meal, 'Sauce 2')).toBe('CREAMY CHIPOTLE SAUCE');
  expect(componentName(meal, 'Garnish')).toBe('SALTED PINEAPPLE');
  expect(dietaryFlags(meal)).toEqual(expect.arrayContaining(['CORIANDER', 'EGG', 'SOY', 'SALTED PINEAPPLE']));
});

test('retains original notes without turning ambiguous wording into an approved adaptation', () => {
  const meal = parseMealWorkbook(april.sheets).find(m => m.id === 'APR1-003');
  const protein = meal.components.find(c => c.type === 'Protein');
  expect(protein.notes).toBe('NO DAIRY & GLUTEN FREE OPTION');
  expect(protein.adaptation).toBe('Not reviewed');
  expect(protein.originalText).toContain('NO DAIRY & GLUTEN FREE OPTION');
});

test('rejects orphan components, duplicate meal IDs and missing second-sauce detail', () => {
  const orphan = JSON.parse(JSON.stringify(april.sheets));
  orphan.Components[4][0] = 'UNKNOWN';
  expect(() => parseMealWorkbook(orphan)).toThrow('was not found');
  const duplicate = JSON.parse(JSON.stringify(april.sheets));
  duplicate.Meals[5][0] = duplicate.Meals[4][0];
  expect(() => parseMealWorkbook(duplicate)).toThrow('duplicate Meal ID');
  const missing = JSON.parse(JSON.stringify(april.sheets));
  missing.Components = missing.Components.filter(row => !(row[0] === 'APR1-002' && row[2] === 'Sauce 2'));
  expect(() => parseMealWorkbook(missing)).toThrow('Sauce 2');
});

test('preserves a tenth exclusion column alongside the original exclusions', () => {
  const sheets = JSON.parse(JSON.stringify(april.sheets));
  const index = sheets.Components[3].length;
  sheets.Components[3][index] = 'Exclusion 10';
  sheets.Components[4][index] = 'Beans';
  const first = parseMealWorkbook(sheets)[0].components[0];
  expect(first.exclusions).toEqual(expect.arrayContaining(['EGG', 'A BIT SPICY', 'Beans']));
});

test('meal format can be set independently from the source category and protein type', () => {
  expect(mealFormat({ category: "MAIN B'FAST" })).toBe('Breakfast');
  expect(mealFormat({ category: 'SNACK 1' })).toBe('Snack');
  expect(mealFormat({ category: 'MAIN CHX', mealFormat: 'Snack' })).toBe('Snack');
  expect(mealFormat({ category: 'SUB' })).toBe('Main');
});
