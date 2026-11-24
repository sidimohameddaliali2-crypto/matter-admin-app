import { isMatterCoreDoubleDay } from '../utils/matterCoreDelivery.js';
import { hasKitchenPreset } from './kitchenMacroValidation.js';
import { dayHeld } from './kitchenMealEditPolicy.js';

export const assertPreparedCoverage = (data, date, { allowManualHolds = false } = {}) => {
  for (const sub of data.kitchenRoster || []) {
    const entry = (data.kitchenSelections || []).find(row => row.matterCustomerId
      ? String(row.matterCustomerId) === String(sub.customer_id)
      : row.matterSubscriptionId ? String(row.matterSubscriptionId) === String(sub.subscription_id)
        : String(row.email || '').toLowerCase() === String(sub.email || '').toLowerCase());
    const meals = (entry?.selectedMeals || []).filter(meal => new Date(meal.date).toISOString().slice(0, 10) === date);
    const core = String(sub.plan_name || '').trim().toLowerCase() === 'matter core';
    const portions = type => meals.filter(meal => type === 'portion' ? (core ? meal.mealType === 'main' : meal.mealType !== 'snack') : meal.mealType === type)
      .reduce((sum, meal) => sum + Math.max(1, Math.floor(Number(meal.quantity) || 1)), 0);
    const multiplier = core && isMatterCoreDoubleDay(date, sub.active_delivery_dates, sub.double_delivery_dates) ? 2 : 1;
    const required = Math.max(1, Number(sub.meal_frequency) || 1) * multiplier;
    const requiredSnacks = (Number(sub.snacks_per_day) || 0) * multiplier;
    const requiredBreakfasts = core && sub.breakfast_included === true ? multiplier : 0;
    const name = sub.name || sub.email || sub.customer_id;
    // Keep the customer editable in List after a deliberate deletion. Export
    // coverage remains strict; a held incomplete date is never a full roster.
    const heldPreview = allowManualHolds && dayHeld(entry, date);
    if (!heldPreview && (!entry || portions('portion') < required)) throw new Error(`${date}: ${name} needs ${required} meal(s), but has ${portions('portion')}. Check active delivery and assignments.`);
    if (core && portions('portion') > required) throw new Error(`${date}: ${name} has ${portions('portion')} Matter Core main meal(s), but entitlement is ${required}. Review excess selections before preparation.`);
    if (!heldPreview && portions('snack') < requiredSnacks) throw new Error(`${date}: ${name} is missing required snacks (${portions('snack')} of ${requiredSnacks}).`);
    if (!heldPreview && portions('breakfast') < requiredBreakfasts) throw new Error(`${date}: ${name} is missing the included breakfast portions (${portions('breakfast')} of ${requiredBreakfasts}).`);
    const reviewSurplus = (kind, maximum) => {
      if (!heldPreview && maximum !== null && portions(kind) > maximum
        && meals.some(meal => meal.mealType === kind && meal.isAutoAssigned === true && meal.coreDeliveryFoodDay)) {
        throw new Error(`${date}: ${name} has ${portions(kind)} ${kind} portion(s), with ${maximum} due. Review the previously assigned Core portions and confirm the Matter schedule.`);
      }
    };
    reviewSurplus('snack', sub.snacks_per_day == null ? null : requiredSnacks);
    reviewSurplus('breakfast', typeof sub.breakfast_included === 'boolean' ? Number(sub.breakfast_included) * multiplier : null);
    for (const meal of meals) {
      const table = meal.mealType === 'snack' ? data.kitchenSnackPreset : meal.mealType === 'breakfast' ? data.kitchenBreakfastPreset : null;
      if (table && !hasKitchenPreset(meal.mealName, table.presetsByName)) throw new Error(`${date}: set ${meal.mealType} preset macros for ${meal.mealName} (${name}).`);
    }
  }
};
