import { parseMealWorkbook, dietaryFlags, componentName, mealFormat, cycleSlots } from './workbookMeals';

// Small synthetic parser fixtures; never bundled into the application.
function sheets() {
  return {
    Meals: [
      ['Meal ID', 'Day', 'Meal category', 'Temperature', 'Meal name', 'Protein / main item', 'Carb', 'Vegetable', 'Sauce', 'Sauce 2', 'Garnish', 'Tags', 'Carb combined with veg', 'Preparation / option notes'],
      ['TEST-1', 'DAY 6 & 7', 'MAIN CHX', 'WARM', 'Test meal', 'Test protein', '', '', 'Test sauce', 'Test dressing', 'Test garnish', '', 'No', 'Review preparation'],
    ],
    Components: [
      ['Meal ID', 'Component type', 'Component name', 'Preparation / option notes', 'Exclusion 1', 'Exclusion 10', 'Original component text'],
      ['TEST-1', 'Protein', 'Test protein', 'Review adaptation', 'Egg', 'Beans', 'Review adaptation'],
      ['TEST-1', 'Sauce', 'Test sauce', '', 'Soy'],
      ['TEST-1', 'Sauce 2', 'Test dressing', '', 'Dairy'],
      ['TEST-1', 'Garnish', 'Test garnish', '', 'Sesame'],
    ],
  };
}

test('preserves meal metadata and shared weekend without adding records', () => {
  const meals = parseMealWorkbook(sheets());
  expect(meals).toHaveLength(1);
  expect(meals[0]).toMatchObject({ id: 'TEST-1', day: 'DAY 6 & 7', category: 'MAIN CHX', status: 'Draft' });
  expect(meals[0].components).toHaveLength(4);
});

test('joins both sauces and garnish and aggregates component flags', () => {
  const meal = parseMealWorkbook(sheets())[0];
  expect(componentName(meal, 'Sauce 2')).toBe('Test dressing');
  expect(componentName(meal, 'Garnish')).toBe('Test garnish');
  expect(dietaryFlags(meal)).toEqual(['Egg', 'Beans', 'Soy', 'Dairy', 'Sesame']);
});

test('retains original notes without approving an adaptation', () => {
  const component = parseMealWorkbook(sheets())[0].components[0];
  expect(component.notes).toBe('Review adaptation');
  expect(component.adaptation).toBe('Not reviewed');
  expect(component.originalText).toBe('Review adaptation');
});

test('rejects orphan components, duplicate meal IDs and missing second sauce', () => {
  const orphan = sheets(); orphan.Components[1][0] = 'UNKNOWN';
  expect(() => parseMealWorkbook(orphan)).toThrow('was not found');
  const duplicate = sheets(); duplicate.Meals.push([...duplicate.Meals[1]]);
  expect(() => parseMealWorkbook(duplicate)).toThrow('duplicate Meal ID');
  const missing = sheets(); missing.Components = missing.Components.filter(row => row[1] !== 'Sauce 2');
  expect(() => parseMealWorkbook(missing)).toThrow('Sauce 2');
});

test('an empty workbook produces no meals', () => {
  const empty = sheets(); empty.Meals = empty.Meals.slice(0, 1); empty.Components = empty.Components.slice(0, 1);
  expect(parseMealWorkbook(empty)).toEqual([]);
});

test('meal format is independent of the source category and protein type', () => {
  expect(mealFormat({ category: "MAIN B'FAST" })).toBe('Breakfast');
  expect(mealFormat({ category: 'SNACK 1' })).toBe('Snack');
  expect(mealFormat({ category: 'MAIN CHX', mealFormat: 'Snack' })).toBe('Snack');
  expect(mealFormat({ category: 'SUB' })).toBe('Main');
});


test('salad dressing is optional even without a Sauce 2 column', () => {
  const optional = sheets();
  const index = optional.Meals[0].indexOf('Sauce 2');
  optional.Meals[1][index] = '';
  optional.Components = optional.Components.filter(row => row[1] !== 'Sauce 2');
  expect(parseMealWorkbook(optional)[0].components).toHaveLength(3);
  optional.Meals.forEach(row => row.splice(index, 1));
  expect(parseMealWorkbook(optional)[0].components).toHaveLength(3);
});

test('cycle assignments decide Main or Sub and keep breakfast and snacks separate', () => {
  expect(cycleSlots({ mealKind: 'Main meal', category: 'SUB' })).toEqual([1, 2]);
  expect(cycleSlots({ mealKind: 'Breakfast', mealFormat: 'Main' })).toEqual([0]);
  expect(cycleSlots({ mealKind: 'Snack' })).toEqual([3]);
});

test('a salad base is displayed as the meal vegetable component', () => {
  expect(componentName({ components: [{ type: 'Salad', name: 'Test salad' }] }, 'Vegetable')).toBe('Test salad');
});
