import { loadKitchenSnapshot } from './kitchenSnapshot';
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
