import { getDateKey } from './kitchenData';
import { hasKitchenDeliveryOnDate } from './kitchenSnapshot';
import { formatBusinessDateInput } from '../utils/businessTime';
import { kitchenMealWarnings } from '../utils/kitchenIntegrity';

export const kitchenToday = (now = new Date()) => formatBusinessDateInput(now);
export const formatKitchenDay = date => date ? new Date(`${getDateKey(date)}T12:00:00Z`).toLocaleDateString('en-GB', {
  weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
}) : '';

export const currentKitchenMenu = (menus, date) => {
  const matches = menus.filter(menu => menu.isActive !== false && menu.isPublished === true
    && getDateKey(menu.startDate) <= date && getDateKey(menu.endDate) >= date);
  return { menu: matches.length === 1 ? matches[0] : null, ambiguous: matches.length > 1 };
};

export const visibleKitchenCustomer = (entry, roster, date) => {
  if (!date || !Array.isArray(roster) || entry.kitchenProductionExcluded) return false;
  if (!hasKitchenDeliveryOnDate(entry, roster, date)) return false;
  // Matter customers without choices stay visible so the kitchen can fill them.
  // Partner members have no Matter roster and need an actual assignment that day.
  return !entry.partner || (entry.selectedMeals || []).some(meal => getDateKey(meal.date) === date);
};

// Project AFTER calculating the full saved record. This preserves per-day macro
// rules, Core double days and stable override keys while displaying one day only.
export const kitchenCustomerDay = (entry, date) => {
  const selectedMeals = (entry.selectedMeals || []).filter(meal => getDateKey(meal.date) === date);
  const incomplete = entry.calculationStatus === 'incomplete';
  const missing = selectedMeals.length === 0;
  return { ...entry, selectedMeals,
    mealsByDay: (entry.mealsByDay || []).filter(day => day.dateKey === date),
    totalWeight: incomplete ? null : selectedMeals.reduce((sum, meal) => sum + Number(meal.weight || 0) * (Number(meal.quantity) || 1), 0),
    totalCalories: incomplete ? null : selectedMeals.reduce((sum, meal) => sum + Number(meal.macros?.calories || 0) * (Number(meal.quantity) || 1), 0),
    mealCount: selectedMeals.filter(meal => meal.category === 'meal').reduce((sum, meal) => sum + (Number(meal.quantity) || 1), 0),
    showMissingPlaceholder: missing, missingSelection: missing || entry.missingSelection,
    missingSelectionDate: missing ? date : entry.missingSelectionDate,
    needsAttention: missing || incomplete || selectedMeals.some(meal => kitchenMealWarnings(meal).length > 0),
    hasMacroShortfall: selectedMeals.some(meal => meal.flags?.macroShortfall),
    hasMatterCoreLookupIssue: selectedMeals.some(meal => meal.flags?.matterCoreLookupMissing),
  };
};
