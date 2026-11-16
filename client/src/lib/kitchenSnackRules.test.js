import { applyKitchenSnackRules, fetchKitchenSnackRules } from './kitchenSnackRules';
import { calculateKitchenListEntry } from '../utils/kitchenListCalculations';
import { assertKitchenExportReady, kitchenMealWarnings } from '../utils/kitchenIntegrity';

const date = '2026-11-06';
const presets = { muffin: { C: 15, P: 10, F: 6 } };
const rules = [{ customerId: '42', version: 1, blockedSnacks: [{ key: 'muffin', name: 'Muffin' }] }];
const rows = [{ matterCustomerId: '42', matterSubscriptionId: 'renewed', planName: 'Custom', targetMacros: { C: 60, P: 60, F: 20 },
  selectedMeals: [{ date, mealType: 'main', mealName: 'Chicken' }, { date, mealType: 'snack', mealName: 'MUFFIN (W/ SOY)', isAutoAssigned: true }] }];
test('permanent identity follows renewals; rule flags propagate through the calculator and block paper/count exports without changing portions', () => {
  const before = JSON.stringify(rows);
  const unblocked = calculateKitchenListEntry({ customer: rows[0], selectedMeals: rows[0].selectedMeals, snackPreset: { presetsByName: presets } });
  const [entry] = applyKitchenSnackRules(rows, rules, presets);
  const calculated = calculateKitchenListEntry({ customer: entry, selectedMeals: entry.selectedMeals, snackPreset: { presetsByName: presets } });
  expect(calculated.snackRule.version).toBe(1);
  expect(calculated.selectedMeals[1].snackRuleConflict).toContain('Blocked snack');
  expect(kitchenMealWarnings(calculated.selectedMeals[1]).join(' ')).toContain('Blocked snack');
  expect(() => assertKitchenExportReady([calculated])).toThrow('Blocked snack');
  expect(calculated.selectedMeals.map(meal => [meal.weight, meal.macros])).toEqual(unblocked.selectedMeals.map(meal => [meal.weight, meal.macros]));
  expect(JSON.stringify(rows)).toBe(before);
  expect(applyKitchenSnackRules([{ ...rows[0], matterCustomerId: '43' }], rules, presets)[0].selectedMeals[1].snackRuleConflict).toBeNull();
  expect(applyKitchenSnackRules(rows, [], presets)[0].selectedMeals[1].snackRuleConflict).toBeNull();
});
test('snapshot rules are reused; fallback is one request and failures cannot silently remove rules', async () => {
  const api = { get: jest.fn().mockResolvedValue({ data: { success: true, data: { rules } } }) };
  expect(await fetchKitchenSnackRules(api, rules)).toBe(rules);
  expect(api.get).not.toHaveBeenCalled();
  expect(await fetchKitchenSnackRules(api)).toBe(rules);
  expect(api.get).toHaveBeenCalledTimes(1);
  api.get.mockRejectedValueOnce(new Error('offline'));
  await expect(fetchKitchenSnackRules(api)).rejects.toThrow('offline');
});
