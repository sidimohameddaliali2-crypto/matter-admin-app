import Breakfast from '../models/KitchenBreakfastPreset.js';
import Snack from '../models/KitchenSnackPreset.js';

const normalize = value => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
export const hasKitchenPreset = (name, presets) => {
  const entries = presets instanceof Map ? [...presets] : Object.entries(presets || {});
  const needle = normalize(name);
  const exact = entries.find(([key]) => normalize(key) === needle);
  const matches = exact ? [exact] : entries.filter(([key]) => normalize(key) && (needle.includes(normalize(key)) || normalize(key).includes(needle)));
  return matches.length === 1 && ['C', 'P', 'F'].every(key => Number.isFinite(Number(matches[0][1][key])) && Number(matches[0][1][key]) >= 0)
    && ['C', 'P', 'F'].some(key => Number(matches[0][1][key]) > 0);
};

export const assertAssignmentMacros = async meals => {
  for (const [kind, Model] of [['breakfast', Breakfast], ['snack', Snack]]) {
    const names = [...new Set(meals.filter(meal => meal.mealType === kind).map(meal => meal.mealName))];
    if (!names.length) continue;
    const doc = await Model.findOne({ key: 'global' }).lean();
    const missing = names.filter(name => !hasKitchenPreset(name, doc?.presetsByName));
    if (missing.length) throw Object.assign(new Error(`Set ${kind} preset macros before auto-assigning: ${missing.join(', ')}`), { statusCode: 409, code: 'KITCHEN_MACROS_MISSING' });
  }
};
