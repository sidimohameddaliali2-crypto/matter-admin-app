export const KITCHEN_FORMULA_VERSION = 'main-kitchen-2026-10-20';

const validNumber = (value) => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== ''))
  && Number.isFinite(Number(value)) && Number(value) >= 0;

export const kitchenInputErrors = (customer) => {
  if (customer?.partner) return [];
  const errors = [];
  if (customer?.nutritionStatus && customer.nutritionStatus !== 'resolved') errors.push('Nutrition lookup is incomplete; refresh the customer subscription.');
  if (!String(customer?.planName || '').trim()) errors.push('Plan identity is missing; portion units cannot be determined.');
  const expectedUnits = String(customer?.planName || '').trim().toLowerCase() === 'matter core' ? 'food-weight-grams' : 'nutrient-grams';
  if (customer?.nutritionUnits && customer.nutritionUnits !== expectedUnits) errors.push('Nutrition units do not match the customer plan.');
  const raw = customer?.targetMacros || customer?.customerMacros || customer?.macros || customer?.mealMacros || customer || {};
  const macros = raw.total || raw;
  if (!['C', 'P', 'F'].every((key) => validNumber(macros[key]))) errors.push('Complete, finite C/P/F targets are required.');
  else if (!['C', 'P', 'F'].some((key) => Number(macros[key]) > 0)) errors.push('The daily nutrition target is unresolved or empty.');
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
  const deadline = Date.now() + 180000;
  while (isCurrent()) {
    try {
      const response = await api.post(`/menus/${menuId}/auto-populate-missing`, { date: dateKey }, { timeout: 180000 });
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
