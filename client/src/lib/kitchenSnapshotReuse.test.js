import { calculateKitchenSnapshot, loadKitchenSnapshot } from './kitchenSnapshot';
import { assertKitchenExportReady } from '../utils/kitchenIntegrity';

const day = '2026-10-22';
const prepared = () => ({
  menuId: 'menu', date: day, receivedAt: Date.now(), checkedAt: new Date().toISOString(), complete: true,
  roster: [{ customer_id: '42', subscription_id: 'renewal', meal_frequency: 1, plan_name: 'Custom' }],
  selections: [{
    matterCustomerId: '42', customerId: '42', matterSubscriptionId: 'expired', matterSourceSubscriptionId: 'renewal',
    matterName: 'Matter Customer', email: 'website@example.invalid', planName: 'Custom',
    nutritionStatus: 'resolved', nutritionResolvedAt: new Date().toISOString(),
    targetMacros: { C: 38, P: 32, F: 10 }, mealsPerDay: 1, snacksPerDay: 0,
    breakfastIncluded: false, dietaryRestrictions: [], deliveryAddressStatus: 'resolved', deliveryAddress: { id: 'place' },
    selectedMeals: [{ date: day, mealType: 'main', mealName: 'Approved choice', quantity: 1 }],
  }], breakfastPreset: {}, snackPreset: {},
});

test('a range paper uses each date’s Core calendar across a subscription renewal', () => {
  const before = '2026-11-25', after = '2026-11-27';
  const core = { customer_id: '42', plan_name: 'Matter Core', meal_frequency: 1, breakfast_included: true, snacks_per_day: 1 };
  const rosters = new Map([
    [before, [{ ...core, subscription_id: 'outgoing', active_delivery_dates: [before], double_delivery_dates: [before] }]],
    [after, [{ ...core, subscription_id: 'renewal', active_delivery_dates: [after], double_delivery_dates: [] }]],
  ]);
  const selectedMeals = [[before, 2], [after, 1]].flatMap(([date, quantity]) => [
    { date, quantity, mealType: 'main', mealName: 'Approved choice' },
    { date, quantity, mealType: 'breakfast', mealName: 'Eggs', isAutoAssigned: true, coreDeliveryFoodDay: quantity },
    { date, quantity, mealType: 'snack', mealName: 'Bite', isAutoAssigned: true, coreDeliveryFoodDay: quantity },
  ]);
  const entry = { ...prepared().selections[0], planName: 'Matter Core', deliveryDates: [after], doubleDeliveryDates: [],
    targetMacros: { C: 200, P: 200, F: null }, selectedMeals };
  const kitchenInputsByDate = new Map([
    [before, [{ subscription_id: 'outgoing', macros: { carbohydrates: 100, protein: 100 } }]],
    [after, [{ subscription_id: 'renewal', macros: { carbohydrates: 200, protein: 200 } }]],
  ]);
  const input = { selections: [entry], rosters, dayKeys: [before, after], menuId: 'menu',
    breakfastPreset: { presetsByName: { eggs: { C: 12, P: 20, F: 8 } } },
    snackPreset: { presetsByName: { bite: { C: 15, P: 10, F: 6 } } } };
  expect(() => calculateKitchenSnapshot(input)).toThrow('could not be verified');
  const snapshot = calculateKitchenSnapshot({ ...input, kitchenInputsByDate });
  expect(snapshot.entries[0].selectedMeals.map(meal => meal.mealType).sort())
    .toEqual(['breakfast', 'breakfast', 'breakfast', 'main', 'main', 'main', 'snack', 'snack', 'snack']);
  expect(snapshot.entries[0].selectedMeals.filter(meal => meal.mealType === 'main').map(meal => meal.proteinWeight))
    .toEqual([100, 100, 200]);
  expect(() => assertKitchenExportReady(snapshot.entries)).not.toThrow();
});

test('a range paper uses the meals and notes from each verified date', async () => {
  const dates = [day, '2026-10-23'];
  const selectedMeal = (date, mealName) => ({ date, mealType: 'main', mealName });
  const profile = { allergies: ['Peanuts'], allergiesAvailable: true };
  const nutrition = { subscription_id: 'renewal', customer_id: '42', customer_email: 'website@example.invalid',
    customer_name: 'Matter Customer', source_fetched_at: new Date().toISOString(), plan_name: 'Custom',
    macros: { carbohydrates: 38, protein: 32, fat: 10 }, meal_frequency: 1, snacks_per_day: 0, breakfast_included: false,
    exclusions: [], allergyProfile: profile, delivery_address_resolution: { status: 'resolved', address: { id: 'address' } } };
  const api = { get: jest.fn(async (path, { params }) => {
    if (!path.endsWith('/kitchen-state')) throw new Error('Do not reload unverified meal selections.');
    expect(params.verifyAllergies).toBe(true);
    const index = dates.indexOf(params.date);
    return { data: { state: 'ready', data: { success: true, data: {
      kitchenInputs: [nutrition], rosterComplete: true, kitchenRoster: prepared().roster,
      kitchenBreakfastPreset: {}, kitchenSnackPreset: {},
      kitchenSelections: [{ _id: 'record', matterCustomerId: '42', email: nutrition.customer_email,
        selectedMeals: dates.map((date, position) => selectedMeal(date, position === index ? `Verified meal ${index}` : 'Peanut chicken')),
        dayNotes: dates.map((date, position) => ({ date, note: position === index ? `Verified note ${index}` : 'Stale note' })),
      }],
    } } } };
  }) };
  const result = await loadKitchenSnapshot(api, 'menu', dates);
  expect(result.entries).toHaveLength(1);
  expect(result.entries[0].selectedMeals.map(meal => meal.mealName)).toEqual(['Verified meal 0', 'Verified meal 1']);
  expect(result.entries[0].dayNotes.map(note => note.note)).toEqual(['Verified note 0', 'Verified note 1']);
  expect(result.entries[0].allergyProfilesByDate).toEqual({ [dates[0]]: profile, [dates[1]]: profile });
});

test('immediate download uses the exact verified version and permanent Matter customer identity', async () => {
  const api = { get: jest.fn(), post: jest.fn() };
  const snapshot = await loadKitchenSnapshot(api, 'menu', [day], () => true, (entry) => entry, prepared());
  expect(snapshot.entries).toHaveLength(1);
  expect(snapshot.entries[0].selectedMeals[0].mealName).toBe('Approved choice');
  expect(snapshot.entries[0].selectedMeals[0].weight).toBe(335);
  expect(() => assertKitchenExportReady(snapshot.entries)).not.toThrow();
  expect(api.get).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
});

test.each(['expired', 'changed-date', 'incomplete'])('an unusable verified version requires fresh Matter preparation: %s', async (kind) => {
  const state = prepared();
  if (kind === 'expired') state.receivedAt -= 61000;
  if (kind === 'changed-date') state.date = '2026-10-23';
  if (kind === 'incomplete') state.complete = false;
  const api = { post: jest.fn().mockRejectedValue(new Error('Fresh preparation failed')), get: jest.fn() };
  await expect(loadKitchenSnapshot(api, 'menu', [day], () => true, (entry) => entry, state)).rejects.toThrow('Fresh preparation failed');
  expect(api.post).toHaveBeenCalledTimes(1);
});

test('fast downloads still reject missing roster portions', async () => {
  const state = prepared(); state.selections[0].selectedMeals = [];
  await expect(loadKitchenSnapshot({}, 'menu', [day], () => true, (entry) => entry, state)).rejects.toThrow('incomplete');
});

test.each(['selection-open', 'allergy-review'])('a fully covered date cannot export a recorded allergy conflict in %s', async state => {
  const api = { get: jest.fn().mockResolvedValue({ data: { state, data: { success: true,
    preparation: state, data: { kitchenAllergyReview: 'House bowl conflicts with recorded allergies (Peanuts).' } } } }) };
  await expect(loadKitchenSnapshot(api, 'menu', [day])).rejects.toThrow('House bowl conflicts with recorded allergies');
  expect(api.get).toHaveBeenCalledTimes(1);
});

test('a pinned production version cannot silently export newer or expired data', async () => {
  const state = prepared(); state.snapshotId = 'version';
  const api = { get: jest.fn().mockResolvedValue({ data: { state: 'stale' } }), post: jest.fn() };
  await expect(loadKitchenSnapshot(api, 'menu', [day], () => true, entry => entry, state)).rejects.toThrow('changed or expired');
  expect(api.get).toHaveBeenCalledWith('/menus/menu/kitchen-state', {
    params: { date: day, job: 'version', verifyAllergies: true }, timeout: 180000,
  });
  expect(api.post).not.toHaveBeenCalled();
});

test('an active Matter delivery keeps customer selections even after an earlier saved pause', async () => {
  const state = prepared();
  state.selections[0].skippedDays = [{ date: day, pauseStatus: 'success' }];
  state.selections[0].selectedMeals[0].isAutoAssigned = false;
  const snapshot = await loadKitchenSnapshot({}, 'menu', [day], () => true, (entry) => entry, state);
  expect(snapshot.entries).toHaveLength(1);
  expect(snapshot.entries[0].deliveryDates).toEqual([day]);
  expect(snapshot.entries[0].selectedMeals[0]).toMatchObject({ mealName: 'Approved choice', isAutoAssigned: false });
});

test('a saved selection stays off production papers when Matter has no delivery that date', async () => {
  const state = prepared();
  state.roster = [];
  const snapshot = await loadKitchenSnapshot({}, 'menu', [day], () => true, (entry) => entry, state);
  expect(snapshot.entries).toEqual([]);
});
