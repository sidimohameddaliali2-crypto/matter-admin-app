import { calculateKitchenListEntry } from './kitchenListCalculations';
import { assertKitchenExportReady } from './kitchenIntegrity';
import { enrichSelectionsWithNutrition } from '../lib/kitchenData';
import { assertKitchenRosterCovered } from '../lib/kitchenSnapshot';

test('Core Monday and Wednesday require doubled mains with normal portions; Friday remains single', () => {
  const deliveryDates = ['2026-10-26', '2026-10-28', '2026-10-30'];
  const customer = { matterCustomerId: 'person', planName: 'Matter Core', mealsPerDay: 2, deliveryDates, targetMacros: { C: 300, P: 300, F: null } };
  const roster = [{ customer_id: 'person', name: 'Core fixture', plan_name: 'Matter Core', meal_frequency: 2 }];
  for (const [date, count] of [[deliveryDates[0], 4], [deliveryDates[1], 4], [deliveryDates[2], 2]]) {
    const meals = Array.from({ length: count }, () => ({ date, mealType: 'main', quantity: 1 }));
    const calculated = calculateKitchenListEntry({ customer, selectedMeals: meals });
    expect(calculated.selectedMeals.every(meal => meal.proteinWeight === 150 && meal.carbWeight === 150)).toBe(true);
    expect(() => assertKitchenRosterCovered([{ ...customer, selectedMeals: meals }], roster, date)).not.toThrow();
    expect(() => assertKitchenRosterCovered([{ ...customer, selectedMeals: meals.slice(1) }], roster, date)).toThrow(`needs ${count} meal(s)`);
  }
});

// Anonymous fixtures reproduce the actual Matter Core API shapes: upstream
// fat is null because carbohydrate/protein values are daily food weights.
test.each([
  [300, 300, 2, 150, 150, 15],
  [300, 400, 2, 150, 200, 18],
  [150, 200, 1, 150, 200, 18],
])('Core food weights C=%i P=%i across %i mains do not require a fat target', async (C, P, count, carbWeight, proteinWeight, fat) => {
  const date = '2026-10-20';
  const nutrition = {
    subscription_id: 'fixture', customer_name: 'Fixture', plan_name: 'Matter Core',
    macros: { carbohydrates: C, protein: P, fat: null }, meal_frequency: count,
    snacks_per_day: 0, breakfast_included: false, exclusions: [], active_delivery_dates: [date],
    delivery_address_resolution: { status: 'resolved', reason: 'current', address: { id: 'fixture' } },
  };
  const [entry] = await enrichSelectionsWithNutrition({ get: async () => ({ data: { success: true, data: nutrition } }) },
    [{ email: 'fixture@example.invalid' }], { current: new Map() }, { extended: true });
  expect(entry.targetMacros.F).toBeNull();
  const result = calculateKitchenListEntry({ customer: entry, selectedMeals: Array.from({ length: count }, () => ({ mealType: 'main', date })) });
  expect(result.calculationStatus).toBe('complete');
  for (const meal of result.selectedMeals) {
    expect(meal.carbWeight).toBe(carbWeight);
    expect(meal.proteinWeight).toBe(proteinWeight);
    expect(meal.macros.F).toBe(fat);
  }
  expect(() => assertKitchenExportReady([result])).not.toThrow();
});

test.each([null, undefined, '', Infinity, -1])('Core still rejects a missing or invalid required food weight: %p', (C) => {
  const result = calculateKitchenListEntry({ customer: { planName: 'Matter Core', targetMacros: { C, P: 200, F: null } }, selectedMeals: [{ mealType: 'main' }] });
  expect(result.calculationStatus).toBe('incomplete');
  expect(() => assertKitchenExportReady([result])).toThrow('blocked');
});

test('ordinary plans still require a fat target and unknown Core combinations remain blocked', () => {
  const meals = [{ mealType: 'main' }];
  const ordinary = calculateKitchenListEntry({ customer: { planName: 'Custom', targetMacros: { C: 150, P: 200, F: null } }, selectedMeals: meals });
  expect(ordinary.calculationStatus).toBe('incomplete');
  const core = calculateKitchenListEntry({ customer: { planName: 'Matter Core', targetMacros: { C: 123, P: 234, F: null } }, selectedMeals: meals });
  expect(core.hasMatterCoreLookupIssue).toBe(true);
  expect(() => assertKitchenExportReady([core])).toThrow('blocked');
});
