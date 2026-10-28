import { isMatterCoreDoubleDay } from '../utils/matterCoreDelivery.js';
import { hasKitchenPreset } from './kitchenMacroValidation.js';

export const assertPreparedCoverage = (data, date) => {
  for (const sub of data.kitchenRoster || []) {
    const entry = (data.kitchenSelections || []).find(row => row.matterCustomerId
      ? String(row.matterCustomerId) === String(sub.customer_id)
      : row.matterSubscriptionId ? String(row.matterSubscriptionId) === String(sub.subscription_id)
        : String(row.email || '').toLowerCase() === String(sub.email || '').toLowerCase());
    const meals = (entry?.selectedMeals || []).filter(meal => new Date(meal.date).toISOString().slice(0, 10) === date);
    const core = String(sub.plan_name || '').trim().toLowerCase() === 'matter core';
    const portions = type => meals.filter(meal => type === 'portion' ? (core ? meal.mealType === 'main' : meal.mealType !== 'snack') : meal.mealType === type)
      .reduce((sum, meal) => sum + Math.max(1, Math.floor(Number(meal.quantity) || 1)), 0);
    const required = Math.max(1, Number(sub.meal_frequency) || 1) * (core && isMatterCoreDoubleDay(date, sub.active_delivery_dates) ? 2 : 1);
    const name = sub.name || sub.email || sub.customer_id;
    if (!entry || portions('portion') < required) throw new Error(`${date}: ${name} needs ${required} meal(s), but has ${portions('portion')}. Check active delivery and assignments.`);
    if (sub.snacks_per_day != null && portions('snack') < Number(sub.snacks_per_day)) throw new Error(`${date}: ${name} is missing required snacks.`);
    if (core && sub.breakfast_included === true && !portions('breakfast')) throw new Error(`${date}: ${name} is missing the included breakfast.`);
    for (const meal of meals) {
      const table = meal.mealType === 'snack' ? data.kitchenSnackPreset : meal.mealType === 'breakfast' ? data.kitchenBreakfastPreset : null;
      if (table && !hasKitchenPreset(meal.mealName, table.presetsByName)) throw new Error(`${date}: set ${meal.mealType} preset macros for ${meal.mealName} (${name}).`);
    }
  }
};
