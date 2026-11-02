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

// Staff may prepare next week's scheduled menu from Friday 15:00 Dubai,
// without publishing it or changing customer-facing selection deadlines.
export const kitchenMenuAccess = (menus, now = new Date(), today = kitchenToday(now)) => {
  const monday = new Date(`${today}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  const release = new Date(monday);
  release.setUTCDate(release.getUTCDate() + 4);
  release.setUTCHours(11, 0, 0, 0); // Friday 15:00 at UTC+4.
  const nextMonday = new Date(monday);
  nextMonday.setUTCDate(nextMonday.getUTCDate() + 7);
  const nextKey = nextMonday.toISOString().slice(0, 10);
  const rollover = new Date(nextMonday.getTime() - 240 * 60000);
  const current = currentKitchenMenu(menus, today);
  const released = new Date(now).getTime() >= release.getTime();
  const scheduled = released ? menus.filter(menu => menu.isActive !== false
    && getDateKey(menu.startDate) === nextKey && getDateKey(menu.endDate) >= nextKey) : [];
  const nextMenu = scheduled.length === 1 ? scheduled[0] : null;
  const availableMenus = current.ambiguous ? [] : [current.menu, nextMenu].filter(Boolean);
  return { availableMenus, defaultMenu: current.menu || (!current.ambiguous ? nextMenu : null),
    currentAmbiguous: current.ambiguous, scheduledAmbiguous: scheduled.length > 1,
    nextMenuId: nextMenu?._id, nextChangeAt: released ? rollover.getTime() : release.getTime() };
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
