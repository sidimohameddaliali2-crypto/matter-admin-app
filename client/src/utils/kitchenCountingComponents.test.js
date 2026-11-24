import { buildKitchenCountRows, kitchenComponentNames, componentWeightText } from './kitchenCountingComponents';

const date = '2026-11-20';
const item = { _id: 'recipe', mealName: 'Chicken bowl', mealType: 'main', cycleMeal: { components: [
  { type: 'Protein', name: 'Roast chicken' }, { type: 'Carb', name: 'White rice' }, { type: 'Vegetable', name: 'Broccoli' },
] } };
const meal = extra => ({ date, category: 'meal', mealType: 'main', mealName: item.mealName, menuItemId: 'recipe',
  proteinWeight: 120, carbWeight: 150, vegWeight: 80, quantity: 1, ...extra });

test('component breakdown sums existing weights and quantities, preserving distinct customer sides', () => {
  const entries = [{ selectedMeals: [meal({ quantity: 2 }), meal({ carbChoice: 'Brown rice', proteinWeight: 140 }), meal({ date: '2026-11-19' })] }];
  const before = JSON.stringify(entries);
  const [row] = buildKitchenCountRows(entries, date, [item]);
  expect(row.count).toBe(3);
  expect(row.totalProteinWeight).toBe(380);
  expect(row.totalCarbWeight).toBe(450);
  expect(row.totalVegWeight).toBe(240);
  expect(row.components.protein).toEqual([{ name: 'Roast chicken', weight: 380 }]);
  expect(row.components.carb).toEqual([{ name: 'White rice', weight: 300 }, { name: 'Brown rice', weight: 150 }]);
  expect(componentWeightText(row.components.carb)).toBe('White rice: 300 g; Brown rice: 150 g');
  expect(JSON.stringify(entries)).toBe(before);
});

test('auto-assigned name-only meals resolve dated metadata; ambiguous recipes never guess', () => {
  expect(kitchenComponentNames(meal({ menuItemId: undefined }), [item]).protein).toBe('Roast chicken');
  expect(kitchenComponentNames(meal({ menuItemId: undefined }), [item, { ...item, _id: 'other' }]).protein).toBe('Component not recorded');
  expect(kitchenComponentNames(meal({ menuItemId: { _id: 'recipe', proteinSource: 'Legacy chicken', carbs: 'Potato', veg: 'Carrot' } })).carb).toBe('Potato');
});

test('Large breakfast rows stay separate, zero component weights and legacy labels remain intact', () => {
  const breakfast = meal({ mealName: 'Oats', mealType: 'breakfast', category: 'breakfast', menuItemId: undefined, proteinWeight: 100, carbWeight: 100, vegWeight: 0 });
  const rows = buildKitchenCountRows([{ selectedMeals: [breakfast, { ...breakfast, flags: { isLargeBreakfast: true }, proteinWeight: 150, carbWeight: 200 }] }], date);
  expect(rows.map(row => row.mealName)).toEqual(['Oats', 'Oats (LARGE)']);
  expect(rows[1].totalProteinWeight).toBe(150);
  expect(rows[0].components.veg).toEqual([{ name: 'Component not recorded', weight: 0 }]);
});
