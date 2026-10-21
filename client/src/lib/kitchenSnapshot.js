import { matchesMatterSubscription, enrichSelectionsWithNutrition, fetchBreakfastPresets, fetchSnackPresets, getCustomerName, getDateKey } from './kitchenData';
import { calculateKitchenListEntry } from '../utils/kitchenListCalculations';
import { assertKitchenExportReady, prepareKitchenSelections } from '../utils/kitchenIntegrity';

export const verifiedKitchenRoster = (response) => {
  if (response?.success !== true || response.complete === false || !Array.isArray(response.data)) {
    throw new Error('Delivery roster is incomplete. Retry before exporting or counting.');
  }
  return response.data;
};

export const hasKitchenDeliveryOnDate = (entry, roster, date) => {
  if ((entry.skippedDays || []).some((day) => getDateKey(day.date || day) === date)) return false;
  // Partner members use their assigned meal dates, not Matter subscriptions.
  if (entry.partner) return true;
  return roster.some((sub) => matchesMatterSubscription(entry, sub));
};

export const assertKitchenRosterCovered = (selections, roster, date) => {
  for (const sub of roster) {
    const entry = selections.find((candidate) => matchesMatterSubscription(candidate, sub));
    if (entry?.skippedDays?.some((day) => getDateKey(day.date || day) === date)) continue;
    const meals = (entry?.selectedMeals || []).filter((meal) => getDateKey(meal.date) === date);
    const core = String(sub.plan_name || '').trim().toLowerCase() === 'matter core';
    const portions = meals.filter((meal) => core ? meal.mealType === 'main' : meal.mealType !== 'snack')
      .reduce((sum, meal) => sum + Math.max(1, Math.floor(Number(meal.quantity) || 1)), 0);
    if (!entry || portions < Math.max(1, Number(sub.meal_frequency) || 1)) {
      throw new Error(`Kitchen roster changed or assignments are incomplete for ${date}. Refresh preparation before exporting.`);
    }
  }
};

// Every retained production paper uses the same prepared inputs and formula.
export const loadKitchenSnapshot = async (api, menuId, dates, isCurrent = () => true, transformSelection = (entry) => entry, prepared = null) => {
  const dayKeys = [...new Set(dates)].sort();
  if (!menuId || !dayKeys.length) throw new Error('Select a menu and delivery date first.');
  // Export the exact verified load version for up to 60 seconds. This is
  // request-local memory, never a persistent/offline cache. Failed refreshes
  // clear it; older or different-date versions still require a fresh read.
  const ages = (prepared?.selections || []).filter((entry) => entry.nutritionStatus === 'resolved')
    .map((entry) => Date.now() - Date.parse(entry.nutritionResolvedAt));
  if (prepared?.menuId === menuId && dayKeys.length === 1 && prepared.date === dayKeys[0]
    && prepared.complete === true && Array.isArray(prepared.roster)
    && Date.now() - prepared.receivedAt < 60000 && Date.now() >= prepared.receivedAt
    && ages.length > 0 && ages.every((age) => Number.isFinite(age) && age >= 0 && age < 60000)) {
    if (!isCurrent()) throw new Error('Selection changed during preparation.');
    return calculateKitchenSnapshot({ ...prepared, dayKeys, menuId,
      rosters: new Map([[prepared.date, prepared.roster]]), transformSelection,
      checkedAt: prepared.checkedAt,
    });
  }

  const preparations = new Map();
  for (const date of dayKeys) preparations.set(date, await prepareKitchenSelections(api, menuId, date, isCurrent));
  if (!isCurrent()) throw new Error('Selection changed during preparation.');
  const [response, breakfastPreset, snackPreset] = await Promise.all([
    api.get(`/menus/${menuId}/selections`), fetchBreakfastPresets(api, menuId), fetchSnackPresets(api),
  ]);
  if (!response.data?.success) throw new Error('Selections could not be verified.');
  const selections = await enrichSelectionsWithNutrition(api, response.data.data || [], { current: new Map() }, { extended: true, matterInputs: [...preparations.values()].flatMap((result) => result.cached ? [] : result.data?.kitchenInputs || []) });
  const rosters = new Map();
  for (const date of dayKeys) {
    const preparation = preparations.get(date);
    const source = preparation?.data;
    const roster = !preparation?.cached && source?.rosterComplete === true && Array.isArray(source.kitchenRoster)
      ? source.kitchenRoster
      : verifiedKitchenRoster((await api.get('/matter/subscriptions/delivery-on-date', { params: { date }, timeout: 180000 })).data);
    assertKitchenRosterCovered(selections, roster, date);
    rosters.set(date, roster);
  }
  if (!isCurrent()) throw new Error('Selection changed during preparation.');
  return calculateKitchenSnapshot({ selections, rosters, dayKeys, menuId, breakfastPreset, snackPreset, transformSelection });
};

export const calculateKitchenSnapshot = ({ selections, rosters, dayKeys, menuId, breakfastPreset, snackPreset, transformSelection = (entry) => entry, checkedAt }) => {
  for (const date of dayKeys) assertKitchenRosterCovered(selections, rosters.get(date) || [], date);
  const entries = selections.map(transformSelection).map((entry) => {
    const deliveryDates = dayKeys.filter((date) => hasKitchenDeliveryOnDate(entry, rosters.get(date), date));
    // Calculate the entire selection first: the approved fallback delivery-number
    // adjustment depends on its full date order, not the range being printed.
    const calculated = calculateKitchenListEntry({ customer: { ...entry, customerName: getCustomerName(entry) }, selectedMeals: entry.selectedMeals || [], breakfastPreset, snackPreset });
    const selectedMeals = calculated.selectedMeals.filter((meal) => deliveryDates.includes(getDateKey(meal.date)));
    return {
      ...calculated, selectedMeals, deliveryDates, dayNotes: entry.dayNotes || [],
      totalWeight: selectedMeals.reduce((sum, meal) => sum + Number(meal.weight || 0), 0),
      totalCalories: selectedMeals.reduce((sum, meal) => sum + Number(meal.macros?.calories || 0), 0),
      hasMatterCoreLookupIssue: selectedMeals.some((meal) => meal.flags?.matterCoreLookupMissing),
      hasMacroShortfall: selectedMeals.some((meal) => meal.flags?.macroShortfall),
    };
  }).filter((entry) => entry.selectedMeals.length);
  return { entries, menuId, dates: dayKeys, preparedAt: checkedAt || new Date().toISOString() };
};

export const requireKitchenSnapshot = (snapshot) => {
  assertKitchenExportReady(snapshot.entries);
  return snapshot;
};
