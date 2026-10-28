import { loadPreparedKitchenState } from '../lib/kitchenPreparationState';

export const KITCHEN_FORMULA_VERSION = 'main-kitchen-2026-10-20';

export const kitchenMealChanges = meal => [
  meal?.remark ? `Change ${meal.remark}` : '',
  meal?.carbConflict?.length && !/carb/i.test(meal?.remark || '') ? 'Change carb' : '',
  meal?.vegConflict?.length && !/veg/i.test(meal?.remark || '') ? 'Change veg' : '',
  meal?.needsSauceChange ? 'Change sauce' : '',
  meal?.needsGarnishChange ? 'Change garnish' : '',
  meal?.exclusionConflict?.length ? `Excluded: ${meal.exclusionConflict.join(', ')}; replace before preparation` : '',
].filter(Boolean).join(' | ');

const validNumber = (value) => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== ''))
  && Number.isFinite(Number(value)) && Number(value) >= 0;

export const kitchenInputErrors = (customer) => {
  if (customer?.partner) return [];
  if (customer?.nutritionStatus && customer.nutritionStatus !== 'resolved') return [customer.nutritionError || 'Nutrition lookup is incomplete; refresh the customer subscription.'];
  const errors = [];
  if (customer?.matterSourceSubscriptionId != null) {
    if (!customer.matterName) errors.push('Matter customer name is missing.');
    if (!validNumber(customer.mealsPerDay) || !Number.isInteger(Number(customer.mealsPerDay)) || Number(customer.mealsPerDay) < 1) errors.push('Matter daily meal count is unresolved.');
    if (!validNumber(customer.snacksPerDay) || !Number.isInteger(Number(customer.snacksPerDay))) errors.push('Matter daily snack count is unresolved.');
    if (typeof customer.breakfastIncluded !== 'boolean') errors.push('Matter breakfast entitlement is unresolved.');
    if (!Array.isArray(customer.dietaryRestrictions)) errors.push('Matter dietary exclusions are unresolved.');
  }
  if (customer?.deliveryAddressStatus === 'unresolved') errors.push(`Matter delivery address is unresolved (${customer.deliveryAddressReason || 'unknown'}).`);
  if (!String(customer?.planName || '').trim()) errors.push('Plan identity is missing; portion units cannot be determined.');
  const expectedUnits = String(customer?.planName || '').trim().toLowerCase() === 'matter core' ? 'food-weight-grams' : 'nutrient-grams';
  if (customer?.nutritionUnits && customer.nutritionUnits !== expectedUnits) errors.push('Nutrition units do not match the customer plan.');
  const raw = customer?.targetMacros || customer?.customerMacros || customer?.macros || customer?.mealMacros || customer || {};
  const macros = raw.total || raw;
  // Matter Core C/P are food weights, not nutrient targets. Its fat field is
  // normally null; the approved weight lookup supplies the meal's actual fat.
  // Ordinary plans still require all three daily nutrient targets.
  const requiredTargets = expectedUnits === 'food-weight-grams' ? ['C', 'P'] : ['C', 'P', 'F'];
  if (!requiredTargets.every((key) => validNumber(macros[key]))) errors.push(expectedUnits === 'food-weight-grams'
    ? 'Complete, finite carbohydrate/protein food weights are required for Matter Core.'
    : 'Complete, finite C/P/F targets are required.');
  else if (!requiredTargets.some((key) => Number(macros[key]) > 0)) errors.push('The daily nutrition target is unresolved or empty.');
  return errors;
};

export const kitchenMealWarnings = (meal) => [
  ...(meal?.inputErrors || []),
  meal?.remark ? `Change ${meal.remark}` : '',
  meal?.exclusionConflict?.length ? `Contains ${meal.exclusionConflict.join(', ')} (excluded) - swap` : '',
  meal?.needsSauceChange ? 'Sauce needs an exclusion-safe replacement' : '',
  meal?.needsGarnishChange ? 'Garnish needs an exclusion-safe replacement' : '',
  meal?.flags?.macroCapped ? 'Portion capped at 65g protein / 75g carbohydrate; review the reduced portion' : '',
  meal?.flags?.macroShortfall ? 'Daily macro target could not be reached; kitchen review required' : '',
  meal?.flags?.autoUpgradedToLarge ? 'Breakfast upgraded to Large to compensate for capped meals' : '',
  meal?.flags?.matterCoreLookupMissing ? 'Unknown Matter Core weight combination; fix before production' : '',
].filter(Boolean);

export const assertKitchenExportReady = (entries) => {
  const invalid = entries.filter((entry) => entry.calculationStatus === 'incomplete'
    || entry.hasMatterCoreLookupIssue || (entry.inputErrors || []).length);
  if (invalid.length) throw new Error(`Kitchen export blocked: ${invalid.length} customer(s) have unresolved inputs or Matter Core combinations. Refresh and resolve them first.`);
};

// Loading is explicit: GET /selections never launches unobservable writes.
export const prepareKitchenSelections = async (api, menuId, dateKey, isCurrent = () => true) => {
  if (api.get) {
    const prepared = await loadPreparedKitchenState(api, menuId, dateKey, isCurrent);
    if (prepared) return prepared;
  }
  const deadline = Date.now() + 180000;
  while (isCurrent()) {
    try {
      const response = await api.post(`/menus/${menuId}/auto-populate-missing`, { date: dateKey, freshInputs: true }, { timeout: 180000 });
      if (!response.data?.success || response.data?.preparation !== 'completed') throw new Error('Kitchen preparation did not complete.');
      return response.data;
    } catch (error) {
      if (error.response?.data?.code !== 'KITCHEN_PREPARATION_BUSY' || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error('Kitchen selection changed during preparation.');
};

export const createKitchenRequestGuard = () => {
  let current = 0;
  return { begin: () => ++current, isCurrent: (id) => id === current, cancel: () => { current++; } };
};

export const kitchenSourceLabel = (entry) => entry.partner ? 'Partner preset'
  : `Matter checked ${entry.nutritionResolvedAt || 'UNKNOWN'}; subscription ${entry.matterSourceSubscriptionId || 'UNKNOWN'}; address ${entry.deliveryAddress?.id ?? 'UNKNOWN'}; current snapshot (dated changes unverified)`;
