import { calculateKitchenListEntry } from './kitchenListCalculations';
import { assertKitchenExportReady } from './kitchenIntegrity';
import { enrichSelectionsWithNutrition } from '../lib/kitchenData';
import { assertKitchenRosterCovered } from '../lib/kitchenSnapshot';

test('Wednesday starter gets two full Core portions from dated Matter flags, matching coverage and paper calculations', async () => {
  const date = '2026-11-04';
  const nutrition = { customer_id: 'fixture', customer_email: 'fixture@example.invalid', customer_name: 'Fixture', subscription_id: 'fixture-sub',
    source_fetched_at: new Date().toISOString(), plan_name: 'Matter Core', meal_frequency: 1, snacks_per_day: 0, breakfast_included: false,
    macros: { carbohydrates: 100, protein: 100, fat: 11 }, exclusions: [], active_delivery_dates: [date, '2026-11-06'], double_delivery_dates: [date],
    delivery_address_resolution: { status: 'resolved', address: { id: 'address' } } };
  const meals = [0, 1].map(slotNumber => ({ date, mealType: 'main', mealName: 'Fixture main', slotNumber, isAutoAssigned: true }));
  const [entry] = await enrichSelectionsWithNutrition({ get: async () => ({ data: { success: true, data: nutrition } }) }, [{ email: nutrition.customer_email, selectedMeals: meals }], { current: new Map() }, { extended: true });
  expect(entry.doubleDeliveryDates).toEqual([date]);
  const result = calculateKitchenListEntry({ customer: entry, selectedMeals: meals });
  expect(result.selectedMeals).toHaveLength(2);
  for (const meal of result.selectedMeals) {
    expect(meal.proteinWeight).toBe(100); expect(meal.carbWeight).toBe(100); expect(meal.vegWeight).toBe(0);
    expect(meal.macros).toEqual({ C: 28, P: 25, F: 11, calories: 311 });
    expect(meal.flags.matterCoreDoubleDelivery).toBe(true);
    expect(meal.flags.matterCoreLookupMissing).toBe(false);
  }
  const roster = [{ customer_id: 'fixture', name: 'Fixture', plan_name: 'Matter Core', meal_frequency: 1, active_delivery_dates: nutrition.active_delivery_dates, double_delivery_dates: [date] }];
  expect(() => assertKitchenRosterCovered([entry], roster, date)).not.toThrow();
  expect(() => assertKitchenRosterCovered([{ ...entry, selectedMeals: meals.slice(0, 1) }], roster, date)).toThrow('needs 2 meal(s)');
  expect(() => assertKitchenExportReady([result])).not.toThrow();
});

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
