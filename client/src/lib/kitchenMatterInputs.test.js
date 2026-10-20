import { matchesMatterSubscription, enrichSelectionsWithNutrition } from './kitchenData';
import { calculateKitchenListEntry } from '../utils/kitchenListCalculations';
import { assertKitchenExportReady, kitchenSourceLabel } from '../utils/kitchenIntegrity';

const raw = { matterSubscriptionId: 'fixture', matterCustomerId: 'customer', planName: 'Saved plan', targetMacros: { C: 1, P: 1, F: 1 } };
const nutrition = {
  exclusions: [], subscription_id: 'fixture', customer_id: 'customer', customer_name: 'Matter name',
  plan_name: 'Custom', macros: { carbohydrates: 38, protein: 32, fat: 10 },
  meal_frequency: 3, breakfast_included: false, snacks_per_day: 0,
  customer_addresses: [{ id: 'old', emirate: 'Dubai' }, { id: 'current', emirate: 'Abu Dhabi' }],
  delivery_address_resolution: { status: 'resolved', reason: 'current', address: { id: 'current', emirate: 'Abu Dhabi', additional_details: 'Door instruction' } },
  source_fetched_at: '2026-10-20T07:00:00Z',
};
const calculate = (customer) => calculateKitchenListEntry({ customer, selectedMeals: [{ date: '2026-10-20', mealType: 'main', mealName: 'Fixture' }] });

test('Matter resolution, name, daily quantities and zero snacks replace saved kitchen profile fields', async () => {
  const api = { get: jest.fn().mockResolvedValue({ data: { success: true, data: nutrition } }) };
  const [entry] = await enrichSelectionsWithNutrition(api, [raw], { current: new Map() }, { extended: true });
  expect(entry.deliveryAddress.id).toBe('current');
  expect(entry.deliveryAddress.emirate).toBe('Abu Dhabi');
  expect(entry.matterName).toBe('Matter name');
  expect(entry.mealsPerDay).toBe(3);
  expect(entry.snacksPerDay).toBe(0);
  expect(entry.breakfastIncluded).toBe(false);
  expect(entry.nutritionResolvedAt).toBe(nutrition.source_fetched_at);
  expect(calculate(entry).deliveryAddress.additional_details).toBe('Door instruction');
  expect(api.get.mock.calls[0][0]).toBe('/matter/subscriptions/kitchen-inputs');
  expect(api.get.mock.calls[0][1].params.subscriptionId).toBe('fixture');
});

test('refresh ignores a warm browser cache and a failed fresh read cannot export old data', async () => {
  const cache = { current: new Map([['cust:customer', { nutritionResolvedAt: new Date().toISOString(), deliveryAddress: { id: 'old' } }]]) };
  const api = { get: jest.fn().mockResolvedValueOnce({ data: { success: true, data: nutrition } }).mockRejectedValueOnce(new Error('timeout')) };
  const [entry] = await enrichSelectionsWithNutrition(api, [raw], cache, { extended: true });
  expect(entry.deliveryAddress.id).toBe('current');
  const [failed] = await enrichSelectionsWithNutrition(api, [entry], cache, { extended: true });
  expect(api.get).toHaveBeenCalledTimes(2);
  expect(() => assertKitchenExportReady([calculate(failed)])).toThrow('blocked');
});

test.each(['multiple-current-addresses', 'multiple-active-addresses', 'no-active-address'])('ambiguous address blocks final papers: %s', async (reason) => {
  const api = { get: async () => ({ data: { success: true, data: { ...nutrition, delivery_address_resolution: { status: 'unresolved', reason, address: null } } } }) };
  const [entry] = await enrichSelectionsWithNutrition(api, [raw], { current: new Map() }, { extended: true });
  expect(entry.deliveryAddress).toBeNull();
  expect(calculate(entry).inputErrors.join(' ')).toContain(reason);
  expect(() => assertKitchenExportReady([calculate(entry)])).toThrow('blocked');
});

test('renewed or mismatched subscription cannot silently replace the selected entitlement', async () => {
  const api = { get: async () => ({ data: { data: { ...nutrition, subscription_id: 'renewal' } } }) };
  const [entry] = await enrichSelectionsWithNutrition(api, [raw], { current: new Map() });
  expect(entry.nutritionStatus).toBe('failed');
});

test('paper provenance identifies the exact subscription/address and dated-change limitation', () => {
  expect(kitchenSourceLabel({ nutritionResolvedAt: nutrition.source_fetched_at, matterSourceSubscriptionId: 'fixture', deliveryAddress: { id: 'current' } })).toMatch(/subscription fixture; address current; current snapshot \(dated changes unverified\)/);
});


test('roster identity does not fall through an exact subscription link to a different renewal', () => {
  expect(matchesMatterSubscription({ ...raw, email: 'same@example.invalid' }, { subscription_id: 'renewal', customer_id: raw.matterCustomerId, email: 'same@example.invalid' })).toBe(false);
  expect(matchesMatterSubscription(raw, { subscription_id: 'fixture' })).toBe(true);
});


test.each([{ meal_frequency: null }, { breakfast_included: null }, { snacks_per_day: null }, { exclusions: null }, { customer_name: '' }])('unknown Matter entitlement/details cannot use local defaults: %p', async (missing) => {
  const [entry] = await enrichSelectionsWithNutrition({ get: async () => ({ data: { success: true, data: { ...nutrition, ...missing } } }) }, [raw], { current: new Map() }, { extended: true });
  expect(() => assertKitchenExportReady([calculate(entry)])).toThrow('blocked');
});
