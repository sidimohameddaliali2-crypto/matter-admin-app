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

test.each([0, 0.1, 0.4])('fat that rounds to zero defaults to 12g without resizing any food: %s', F => {
  const entry = calculate({ C: 40, P: 40, F });
  const reference = calculate({ C: 40, P: 40, F: 10 });
  const meal = entry.selectedMeals[0], other = reference.selectedMeals[0];
  expect(meal.macros.F).toBe(12);
  expect(meal.macros.calories).toBe(meal.macros.C * 4 + meal.macros.P * 4 + 108);
  expect([meal.proteinWeight, meal.carbWeight, meal.vegWeight, meal.weight])
    .toEqual([other.proteinWeight, other.carbWeight, other.vegWeight, other.weight]);
  expect(entry.totalWeight).toBe(reference.totalWeight);
  expect(entry.totalCalories).toBe(meal.macros.calories);
});

test('exhausted fat after breakfast/snack deduction uses 12g per main; positive fat and presets keep their values', () => {
  const breakfast = { date, mealType: 'breakfast', mealName: 'Test breakfast' };
  const snack = { date, mealType: 'snack', mealName: 'Test snack' };
  const entry = calculate({ C: 100, P: 100, F: 5 }, [{ ...main, quantity: 2 }, breakfast, snack], {
    breakfastPreset: { presetsByName: { 'test breakfast': { breakfastName: 'Test breakfast', C: 20, P: 30, F: 0 } } },
    snackPreset: { presetsByName: { 'test snack': { C: 15, P: 10, F: 6 } } },
  });
  expect(entry.selectedMeals.slice(0, 2).map(meal => meal.macros.F)).toEqual([12, 12]);
  expect(entry.selectedMeals[2].macros.F).toBe(0);
  expect(entry.selectedMeals[3].macros.F).toBe(6);
  expect(calculate({ C: 40, P: 40, F: 1 }).selectedMeals[0].macros.F).toBe(1);
  const unsupported = calculateKitchenListEntry({ customer: { planName: 'Matter Core', targetMacros: { C: 50, P: 50 } }, selectedMeals: [main] });
  expect(unsupported.selectedMeals[0].macros.F).toBe(0);
  expect(unsupported.selectedMeals[0].flags.matterCoreLookupMissing).toBe(true);
});
