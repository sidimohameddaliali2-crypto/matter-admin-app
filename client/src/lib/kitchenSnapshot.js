import { matchesMatterSubscription, enrichSelectionsWithNutrition, fetchBreakfastPresets, fetchSnackPresets, toBreakfastPresetState, toSnackPresetState, getCustomerName, getDateKey } from './kitchenData';
import { calculateKitchenListEntry, isMatterCoreDoubleDay } from '../utils/kitchenListCalculations';
import { assertKitchenExportReady, prepareKitchenSelections } from '../utils/kitchenIntegrity';

export const verifiedKitchenRoster = (response) => {
  if (response?.success !== true || response.complete === false || !Array.isArray(response.data)) {
    throw new Error('Delivery roster is incomplete. Retry before exporting or counting.');
  }
  return response.data;
};

export const hasKitchenDeliveryOnDate = (entry, roster, date) => {
  // Partner members use their assigned meal dates, not Matter subscriptions.
  if (entry.partner) return !(entry.skippedDays || []).some((day) => getDateKey(day.date || day) === date);
  return roster.some((sub) => matchesMatterSubscription(entry, sub));
};

const isCorePlan = sub => String(sub.plan_name || '').trim().toLowerCase() === 'matter core';
const kitchenCoreDoubleDelivery = (sub, entry, date) => {
  // A paper can span a renewal. Use the subscription verified for this date
  // when it supplies a calendar, including its legacy scheduling fallback.
  if (!isCorePlan(sub)) return false;
  return Array.isArray(sub.active_delivery_dates)
    ? isMatterCoreDoubleDay(date, sub.active_delivery_dates, sub.double_delivery_dates)
    : isMatterCoreDoubleDay(date, entry?.deliveryDates, sub.double_delivery_dates ?? entry?.doubleDeliveryDates);
};

export const kitchenPortionCoverage = (sub, entry, date, meals) => {
  const core = isCorePlan(sub);
  const doubleDelivery = kitchenCoreDoubleDelivery(sub, entry, date);
  const multiplier = doubleDelivery ? 2 : 1;
  const count = predicate => meals.filter(predicate)
    .reduce((sum, meal) => sum + Math.max(1, Math.floor(Number(meal.quantity) || 1)), 0);
  return {
    core, doubleDelivery,
    mains: count(meal => core ? meal.mealType === 'main' : meal.mealType !== 'snack'),
    snacks: count(meal => meal.mealType === 'snack'),
    breakfasts: count(meal => meal.mealType === 'breakfast'),
    requiredMains: Math.max(1, Number(sub.meal_frequency) || 1) * multiplier,
    requiredSnacks: (Number(sub.snacks_per_day) || 0) * multiplier,
    requiredBreakfasts: core && sub.breakfast_included === true ? multiplier : 0,
  };
};

export const assertKitchenRosterCovered = (selections, roster, date) => {
  for (const sub of roster) {
    const entry = selections.find((candidate) => matchesMatterSubscription(candidate, sub));
    const meals = (entry?.selectedMeals || []).filter((meal) => getDateKey(meal.date) === date);
    const { doubleDelivery, mains, snacks, breakfasts, requiredMains, requiredSnacks, requiredBreakfasts } = kitchenPortionCoverage(sub, entry, date, meals);
    if ((entry?.kitchenAutoHolds || []).some(hold => hold.date === date)
      && (mains < requiredMains || snacks < requiredSnacks || breakfasts < requiredBreakfasts)) {
      throw new Error(`Kitchen assignments are incomplete for ${date}: ${sub.name || entry?.customerName || sub.email || sub.customer_id}. Automatic assignment is paused after a staff deletion. Add the missing portions before cutoff or choose Restore automatic assignment.`);
    }
    if (snacks < requiredSnacks) throw new Error(`Kitchen assignments are incomplete for ${date}: ${sub.name || sub.email || sub.customer_id} needs ${requiredSnacks} snack(s), but has ${snacks}.`);
    if (breakfasts < requiredBreakfasts) throw new Error(`Kitchen assignments are incomplete for ${date}: ${sub.name || sub.email || sub.customer_id} needs ${requiredBreakfasts} breakfast(s), but has ${breakfasts}.`);
    const reviewSurplus = (kind, actual, maximum) => {
      if (maximum !== null && actual > maximum
        && meals.some(meal => meal.mealType === kind && meal.isAutoAssigned === true && meal.coreDeliveryFoodDay)) {
        throw new Error(`Kitchen export blocked for ${date}. ${sub.name || sub.email || sub.customer_id} has ${actual} ${kind} portion(s), with ${maximum} due. Review the previously assigned Core portions and confirm the Matter schedule.`);
      }
    };
    reviewSurplus('snack', snacks, sub.snacks_per_day == null ? null : requiredSnacks);
    reviewSurplus('breakfast', breakfasts, typeof sub.breakfast_included === 'boolean' ? Number(sub.breakfast_included) * (doubleDelivery ? 2 : 1) : null);
    if (!entry || mains < requiredMains) {
      throw new Error(`Kitchen assignments are incomplete for ${date}: ${sub.name || entry?.customerName || sub.email || sub.customer_id} needs ${requiredMains} meal(s), but has ${mains}. Refresh preparation before exporting.`);
    }
  }
};

// Keep each printed day's meals and notes bound to its verified snapshot.
// Keep the surrounding week's meal dates for the existing macro calculation.
const collectDatedKitchenSelections = preparations => {
  const dates = new Set(preparations.keys());
  const entries = new Map();
  for (const [date, preparation] of preparations) {
    for (const row of preparation.data.kitchenSelections) {
      const key = row._id || row.matterCustomerId || row.matterEmail || row.email;
      const previous = entries.get(key);
      entries.set(key, {
        ...row,
        selectedMeals: [
          ...(previous?.selectedMeals || (row.selectedMeals || []).filter(meal => !dates.has(getDateKey(meal.date)))),
          ...(row.selectedMeals || []).filter(meal => getDateKey(meal.date) === date),
        ],
        dayNotes: [
          ...(previous?.dayNotes || []),
          ...(row.dayNotes || []).filter(note => getDateKey(note.date) === date),
        ],
      });
    }
  }
  return [...entries.values()];
};

// Every retained production paper uses the same prepared inputs and formula.
export const loadKitchenSnapshot = async (api, menuId, dates, isCurrent = () => true, transformSelection = (entry) => entry, prepared = null) => {
  const dayKeys = [...new Set(dates)].sort();
  if (!menuId || !dayKeys.length) throw new Error('Select a menu and delivery date first.');
  if (prepared?.snapshotId && dayKeys.length === 1 && prepared.menuId === menuId && prepared.date === dayKeys[0]) {
    const verified = (await api.get(`/menus/${menuId}/kitchen-state`, {
      params: { date: prepared.date, job: prepared.snapshotId, verifyAllergies: true }, timeout: 180000,
    })).data;
    if (verified?.state !== 'ready') throw new Error(verified?.message || 'The prepared kitchen version changed or expired. Reload the selected date before exporting.');
  }
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
  for (const date of dayKeys) {
    const preparation = await prepareKitchenSelections(api, menuId, date, isCurrent, { verifyAllergies: true });
    if (preparation.data?.kitchenAllergyReview) throw new Error(preparation.data.kitchenAllergyReview);
    preparations.set(date, preparation);
  }
  if (!isCurrent()) throw new Error('Selection changed during preparation.');
  const withVerifiedSelections = [...preparations.values()].filter(preparation => Array.isArray(preparation.data?.kitchenSelections));
  if (withVerifiedSelections.length > 0 && withVerifiedSelections.length !== dayKeys.length) {
    throw new Error('Some dates did not return verified selections. Refresh preparation before exporting.');
  }
  const verifiedSelections = withVerifiedSelections.length === 0 ? null
    : dayKeys.length === 1 ? withVerifiedSelections[0].data.kitchenSelections : collectDatedKitchenSelections(preparations);
  const [response, rawBreakfastPreset, rawSnackPreset] = await Promise.all([
    verifiedSelections ? { data: { success: true, data: verifiedSelections } } : api.get(`/menus/${menuId}/selections`, { timeout: 30000 }),
    preparations.get(dayKeys[0]).data?.kitchenBreakfastPreset || fetchBreakfastPresets(api, menuId),
    preparations.get(dayKeys[0]).data?.kitchenSnackPreset || fetchSnackPresets(api),
  ]);
  if (!response.data?.success) throw new Error('Selections could not be verified.');
  const breakfastPreset = toBreakfastPresetState(rawBreakfastPreset);
  const snackPreset = toSnackPresetState(rawSnackPreset);
  const single = dayKeys.length === 1 ? preparations.get(dayKeys[0]) : null;
  const selections = await enrichSelectionsWithNutrition(api, response.data.data || [], { current: new Map() }, { extended: true, matterInputs: [...preparations.values()].flatMap((result) => result.cached ? [] : result.data?.kitchenInputs || []),
    productionScope: single && !single.cached && single.data?.rosterComplete === true
      ? { complete: true, date: dayKeys[0], roster: single.data.kitchenRoster } : null });
  const rosters = new Map();
  const kitchenInputsByDate = new Map();
  for (const date of dayKeys) {
    const preparation = preparations.get(date);
    const source = preparation?.data;
    const roster = !preparation?.cached && source?.rosterComplete === true && Array.isArray(source.kitchenRoster)
      ? source.kitchenRoster
      : verifiedKitchenRoster((await api.get('/matter/subscriptions/delivery-on-date', { params: { date }, timeout: 180000 })).data);
    assertKitchenRosterCovered(selections, roster, date);
    rosters.set(date, roster);
    if (!preparation?.cached && Array.isArray(source?.kitchenInputs)) kitchenInputsByDate.set(date, source.kitchenInputs);
  }
  if (!isCurrent()) throw new Error('Selection changed during preparation.');
  return calculateKitchenSnapshot({ selections, rosters, kitchenInputsByDate, dayKeys, menuId, breakfastPreset, snackPreset, transformSelection });
};

export const calculateKitchenSnapshot = ({ selections, rosters, kitchenInputsByDate = new Map(), dayKeys, menuId, breakfastPreset, snackPreset, transformSelection = (entry) => entry, checkedAt }) => {
  for (const date of dayKeys) assertKitchenRosterCovered(selections, rosters.get(date) || [], date);
  const inputsBySubscriptionByDate = new Map([...kitchenInputsByDate].map(([date, inputs]) =>
    [date, new Map(inputs.filter(input => input?.subscription_id != null).map(input => [String(input.subscription_id), input]))]));
  const entries = selections.map(transformSelection).map((entry) => {
    const coreInputsByDate = {};
    const allergyProfilesByDate = {};
    const deliveryDates = dayKeys.filter((date) => {
      const roster = rosters.get(date) || [];
      if (entry.partner) return hasKitchenDeliveryOnDate(entry, roster, date);
      const sub = roster.find(candidate => matchesMatterSubscription(entry, candidate));
      const input = sub && inputsBySubscriptionByDate.get(date)?.get(String(sub.subscription_id));
      if (input?.allergyProfile) allergyProfilesByDate[date] = input.allergyProfile;
      if (sub && isCorePlan(sub)) {
        const macros = input?.macros;
        const hasWeights = [macros?.carbohydrates, macros?.protein]
          .every(weight => weight != null && String(weight).trim() !== '' && Number.isFinite(Number(weight)) && Number(weight) >= 0);
        const differentSubscription = dayKeys.length > 1 && sub.subscription_id != null && entry.matterSourceSubscriptionId != null
          && String(sub.subscription_id) !== String(entry.matterSourceSubscriptionId);
        if (!hasWeights && differentSubscription) {
          throw new Error(`Matter Core food weights for ${sub.name || entry.email} on ${date} could not be verified. Refresh preparation for that date.`);
        }
        coreInputsByDate[date] = {
          doubleDelivery: kitchenCoreDoubleDelivery(sub, entry, date),
          mealsPerDay: Number(sub.meal_frequency) || undefined,
          ...(hasWeights && { carbs: Number(macros.carbohydrates), protein: Number(macros.protein) }),
        };
      }
      return !!sub;
    });
    // Calculate the entire selection first: the approved fallback delivery-number
    // adjustment depends on its full date order, not the range being printed.
    const calculated = calculateKitchenListEntry({ customer: { ...entry, customerName: getCustomerName(entry), coreInputsByDate },
      selectedMeals: entry.selectedMeals || [], breakfastPreset, snackPreset });
    const selectedMeals = calculated.selectedMeals.filter((meal) => deliveryDates.includes(getDateKey(meal.date)));
    return {
      ...calculated, selectedMeals, deliveryDates, allergyProfile: entry.allergyProfile, allergyProfilesByDate, dayNotes: entry.dayNotes || [],
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
