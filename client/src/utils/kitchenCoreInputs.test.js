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

test('Core Monday and Wednesday require double portions with normal macros and weights; Friday remains single', () => {
  const deliveryDates = ['2026-10-26', '2026-10-28', '2026-10-30'];
  const customer = { matterCustomerId: 'person', planName: 'Matter Core', mealsPerDay: 2, snacksPerDay: 1, breakfastIncluded: true, deliveryDates, targetMacros: { C: 300, P: 300, F: null } };
  const roster = [{ customer_id: 'person', name: 'Core fixture', plan_name: 'Matter Core', meal_frequency: 2, breakfast_included: true, snacks_per_day: 1 }];
  const breakfastPreset = { presetsByName: { eggs: { C: 12, P: 20, F: 8 } } };
  const snackPreset = { presetsByName: { bite: { C: 15, P: 10, F: 6 } } };
  for (const [date, count] of [[deliveryDates[0], 4], [deliveryDates[1], 4], [deliveryDates[2], 2]]) {
    const quantity = count / 2;
    const mains = Array.from({ length: count }, () => ({ date, mealType: 'main', quantity: 1 }));
    const breakfast = { date, mealType: 'breakfast', mealName: 'Eggs', quantity };
    const snack = { date, mealType: 'snack', mealName: 'Bite', quantity };
    const meals = [...mains, breakfast, snack];
    const calculated = calculateKitchenListEntry({ customer, selectedMeals: meals, breakfastPreset, snackPreset });
    const byType = type => calculated.selectedMeals.filter(meal => meal.mealType === type);
    expect(byType('main').every(meal => meal.proteinWeight === 150 && meal.carbWeight === 150)).toBe(true);
    expect(byType('breakfast')).toHaveLength(quantity);
    expect(byType('breakfast').every(meal => meal.macros.C === 12 && meal.proteinWeight === 100)).toBe(true);
    expect(byType('snack')).toHaveLength(quantity);
    expect(byType('snack').every(meal => meal.macros.C === 15 && meal.proteinWeight === 50)).toBe(true);
    expect(() => assertKitchenRosterCovered([{ ...customer, selectedMeals: meals }], roster, date)).not.toThrow();
    expect(() => assertKitchenRosterCovered([{ ...customer, selectedMeals: meals.slice(1) }], roster, date)).toThrow(`needs ${count} meal(s)`);
    if (quantity === 2) {
      expect(() => assertKitchenRosterCovered([{ ...customer, selectedMeals: [...mains, { ...breakfast, quantity: 1 }, snack] }], roster, date)).toThrow('needs 2 breakfast(s)');
      expect(() => assertKitchenRosterCovered([{ ...customer, selectedMeals: [...mains, breakfast, { ...snack, quantity: 1 }] }], roster, date)).toThrow('needs 2 snack(s)');
    }
  }
});

test.each(['breakfast', 'snack'])('export flags surplus automatic Core %s portions on an unresolved legacy calendar', kind => {
  const date = '2026-10-26';
  const sub = { customer_id: 'person', plan_name: 'Matter Core', meal_frequency: 1,
    active_delivery_dates: [date, '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'],
    breakfast_included: kind === 'breakfast', snacks_per_day: kind === 'snack' ? 1 : 0 };
  const tagged = { date, mealType: kind, coreDeliveryFoodDay: 2, isAutoAssigned: true };
  const entry = { matterCustomerId: 'person', selectedMeals: [{ date, mealType: 'main' }, { date, mealType: kind }, tagged] };
  expect(() => assertKitchenRosterCovered([entry], [sub], date)).toThrow('confirm the Matter schedule');
  tagged.isAutoAssigned = false;
  expect(() => assertKitchenRosterCovered([entry], [sub], date)).not.toThrow();
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
