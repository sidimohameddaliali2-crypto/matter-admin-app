import { calculateKitchenListEntry } from './kitchenListCalculations';

const date = '2026-11-05';
const main = { date, mealType: 'main', mealName: 'Chicken meal' };
const calculate = (targetMacros, selectedMeals = [main], extras = {}) => calculateKitchenListEntry({
  customer: { planName: 'Custom', targetMacros }, selectedMeals, ...extras,
});

test.each([0, 1, 4])('split C/P below 5g use the floor without changing the original food weights: %s', amount => {
  const result = calculate({ C: amount, P: amount, F: 10 });
  const meal = result.selectedMeals[0];
  expect(meal.macros.C).toBe(5);
  expect(meal.macros.P).toBe(5);
  expect(meal).toMatchObject({ proteinWeight: 100, carbWeight: 20, vegWeight: 80, weight: 200 });
  expect(meal.macros.calories).toBe(40 + meal.macros.F * 9);
  expect(result.totalWeight).toBe(200);
  expect(result.totalCalories).toBe(meal.macros.calories);
});

test('breakfast and snack deductions can exhaust the split budget; presets and weights remain intact', () => {
  const breakfast = { date, mealType: 'breakfast', mealName: 'Test breakfast' };
  const snack = { date, mealType: 'snack', mealName: 'Test snack' };
  const result = calculate({ C: 25, P: 35, F: 15 }, [main, breakfast, snack], {
    breakfastPreset: { presetsByName: { 'test breakfast': { breakfastName: 'Test breakfast', C: 20, P: 30, F: 0 } } },
    snackPreset: { presetsByName: { 'test snack': { C: 15, P: 10, F: 6 } } },
  });
  expect(result.selectedMeals[0]).toMatchObject({ macros: { C: 5, P: 5 }, proteinWeight: 100, carbWeight: 20, weight: 200 });
  expect(result.selectedMeals[1]).toMatchObject({ macros: { C: 20, P: 30, F: 0 }, proteinWeight: 100, carbWeight: 100, vegWeight: 80 });
  expect(result.selectedMeals[2]).toMatchObject({ macros: { C: 15, P: 10, F: 6 }, proteinWeight: 50, carbWeight: 50, vegWeight: 0 });
});

test('only the deficient nutrient changes and existing caps still apply', () => {
  expect(calculate({ C: 0, P: 40, F: 10 }).selectedMeals[0]).toMatchObject({ macros: { C: 5, P: 42 }, proteinWeight: 160, carbWeight: 20 });
  expect(calculate({ C: 40, P: 0, F: 10 }).selectedMeals[0]).toMatchObject({ macros: { C: 43, P: 5 }, proteinWeight: 100, carbWeight: 150 });
  expect(calculate({ C: 200, P: 200, F: 10 }).selectedMeals[0]).toMatchObject({ macros: { C: 75, P: 65 }, proteinWeight: 240, carbWeight: 210 });
});

test('missing inputs and unsupported Core combinations remain unresolved rather than receiving synthetic macros', () => {
  expect(calculate({ C: null, P: 40, F: 10 }).calculationStatus).toBe('incomplete');
  const core = calculateKitchenListEntry({ customer: { planName: 'Matter Core', targetMacros: { C: 50, P: 50 } }, selectedMeals: [main] });
  expect(core.selectedMeals[0].flags.matterCoreLookupMissing).toBe(true);
  expect(core.selectedMeals[0].macros).toMatchObject({ C: 0, P: 0 });
});
