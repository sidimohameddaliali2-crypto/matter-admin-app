import { mealsForCycle } from './savedMealCycles';

test('cycle views keep original IDs and days without changing the canonical recipe', () => {
  const meals = [{ id: 'NOV3-004', name: 'Chicken', day: 'DAY 1', cycleDays: ['DAY 1', 'DAY 4'], components: [{ exclusions: ['Nuts'] }] }];
  const before = JSON.stringify(meals);
  const cycle = { meals: [{ mealId: 'NOV3-004', sourceMealId: 'NOV4-021', day: 'DAY 3' }, { mealId: 'NOV3-004', sourceMealId: 'NOV4-022', day: 'DAY 5' }] };
  expect(mealsForCycle(meals, cycle)).toEqual([{ ...meals[0], day: 'DAY 3', cycleDays: ['DAY 3', 'DAY 5'], sourceMealIds: ['NOV4-021', 'NOV4-022'] }]);
  expect(JSON.stringify(meals)).toBe(before);
  expect(mealsForCycle(meals, null)).toBe(meals);
  const all = mealsForCycle(meals, null, [cycle]);
  expect(all[0].sourceMealIds).toEqual(['NOV4-021', 'NOV4-022']);
  expect(all).toHaveLength(1);
});
