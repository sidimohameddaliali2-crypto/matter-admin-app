import Menu from '../models/WeeklyMenu.js';
import Record from '../models/MenuSelectionRecord.js';
import Item from '../models/MenuItem.js';
import Rule from '../models/KitchenSnackRule.js';
import matter from './matterApiService.js';
import { toBusinessDateKey } from '../utils/businessDate.js';
import { assertKitchenSelectionClosed } from './kitchenSelectionDeadline.js';
import { readSnackCatalogue } from './kitchenSnackRules.js';
import { snackRuleConflict, eligibleSnackPools, preferredSnackPool } from './kitchenSnackPolicy.js';
import { mergeKitchenMetadata, kitchenConflictList } from './kitchenExclusions.js';
import { assertAssignmentMacros } from './kitchenMacroValidation.js';

const fail = message => { throw Object.assign(new Error(message), { statusCode: 409 }); };
export const replacementSnackMeals = (meals, date, rule, catalogue, pools, exclusions, snacksPerDay) => {
  const eligible = eligibleSnackPools(pools, { rule, catalogue, excluded: option => kitchenConflictList(option, exclusions).length > 0 });
  let snackSlot = 0, replaced = 0;
  const selectedMeals = meals.flatMap(meal => {
    if (meal.mealType !== 'snack' || new Date(meal.date).toISOString().slice(0, 10) !== date) return [meal];
    const count = Math.max(1, Math.floor(Number(meal.quantity) || 1));
    if (!snackRuleConflict(meal, rule, catalogue)) { snackSlot += count; return [meal]; }
    return Array.from({ length: count }, () => {
      const choice = preferredSnackPool(eligible, snackSlot++)[0];
      if (!choice) fail(`No eligible replacement for ${meal.mealName}. Add a snack with macros that passes dietary exclusions and blocked-snack rules.`);
      replaced++;
      return { date: new Date(date), mealType: 'snack', mealName: choice.name, quantity: 1, isAutoAssigned: true,
        snackMacros: { C: Number(choice.C || 0) / snacksPerDay, P: Number(choice.P || 0) / snacksPerDay, F: Number(choice.F || 0) / snacksPerDay } };
    });
  });
  return { selectedMeals, replaced };
};

// Explicit staff action only. Reads and automatic top-ups never rewrite saved snacks.
export const replaceBlockedSnacks = async ({ menuId, customerId, date, actor, version }) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || date < toBusinessDateKey(new Date())) fail('Only today or a future delivery date can be reviewed.');
  const menu = await Menu.findById(menuId).lean();
  if (!menu) fail('Menu not found.');
  assertKitchenSelectionClosed(menu, date);
  const nutrition = await matter.getKitchenNutrition({ customerId });
  if (String(nutrition?.customer_id) !== customerId || !nutrition.active_delivery_dates?.includes(date)
    || !Number.isInteger(Number(nutrition.snacks_per_day)) || Number(nutrition.snacks_per_day) <= 0) fail('Verify this customer’s active delivery and snack entitlement first.');
  const rows = await Record.find({ weeklyMenuId: menuId, matterCustomerId: customerId }).lean();
  if (rows.length !== 1) fail('A single selection linked to this Matter customer ID is required. Review customer matching first.');
  const record = rows[0];
  if ((record.skippedDays || []).some(day => String(day.date).slice(0, 10) === date && !day.resumedAt)) fail('Resolve the saved pause before replacing snacks.');
  const [rule, catalogue, ingredients] = await Promise.all([
    Rule.findById(customerId).lean(), readSnackCatalogue(),
    Item.find({ _id: { $in: (menu.meals || []).flatMap(day => day.items || []) }, itemDate: new Date(date), mealType: 'snack' }).lean(),
  ]);
  if (!Number.isInteger(version) || (rule?.version || 0) !== version) fail('Snack rules changed. Reload before replacing assignments.');
  const raw = menu.snackOptionsByDate?.[date];
  const pools = Array.isArray(raw) ? { first: raw, second: [] } : { first: raw?.first || [], second: raw?.second || [] };
  const merged = { first: mergeKitchenMetadata(pools.first, ingredients), second: mergeKitchenMetadata(pools.second, ingredients) };
  const { selectedMeals, replaced } = replacementSnackMeals(record.selectedMeals || [], date, rule, catalogue, merged,
    nutrition.exclusions || [], Number(nutrition.snacks_per_day));
  if (!replaced) return { replaced: 0 };
  await assertAssignmentMacros(selectedMeals.filter(meal => meal.mealType === 'snack' && new Date(meal.date).toISOString().slice(0, 10) === date));
  if (((await Rule.findById(customerId).lean())?.version || 0) !== version) fail('Snack rules changed during review. Retry.');
  const result = await Record.updateOne({ _id: record._id, matterCustomerId: customerId, selectedMeals: record.selectedMeals,
    $expr: { $eq: [{ $ifNull: ['$skippedDays', []] }, record.skippedDays || []] } }, {
    $set: { selectedMeals }, $push: { kitchenAudit: { date, action: 'replace-blocked-auto-snacks', at: new Date(),
      subscriptionId: String(nutrition.subscription_id), reason: `Staff ${actor}; snack rule version ${version}; replaced ${replaced} auto-assigned snack portion(s).` } },
  });
  if (!result.modifiedCount) fail('Selections changed during review. Reload before replacing snacks.');
  return { replaced };
};
