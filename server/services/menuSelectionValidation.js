import mongoose from 'mongoose';
import Menu from '../models/WeeklyMenu.js';
import { resolveMenuAllergyProfile } from './menuAllergyProfileService.js';
import { evaluateComponentSelection, selectionPreferenceFlags } from '../../client/src/constants/componentSelectionRules/index.js';

const failure = () => Object.assign(new Error('Could not save your selections.'), { statusCode: 409 });
const idOf = value => String(value?._id || value || '');
const typeOf = value => ['lunch', 'dinner'].includes(value) ? 'main' : value;
const dateKey = value => {
  if (!value) throw failure();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw failure();
  const key = date.toISOString().slice(0, 10);
  if (typeof value === 'string' && value.slice(0, 10) !== key) throw failure();
  return key;
};

// Selection overrides are not a replacement catalogue. Only names from this
// already-checked stored item may be carried into kitchen calculations.
const validateComponentChoices = (item, selection) => {
  const components = Array.isArray(item.cycleMeal?.components) ? item.cycleMeal.components : [];
  const fields = {
    proteinChoice: ['proteinSource', ['Protein', 'Portion', 'Breakfast', 'Snack']],
    carbChoice: ['carbs', ['Carb']],
    vegChoice: ['veg', ['Vegetable', 'Salad']],
    sauceChoice: ['sauce', ['Sauce', 'Sauce 2', 'Extra sauce / topping']],
  };
  const checked = {};
  for (const [field, [legacy, types]] of Object.entries(fields)) {
    if (selection[field] === undefined) continue;
    if (typeof selection[field] !== 'string') throw failure();
    const value = selection[field].trim();
    const canonical = [item[legacy], ...components.filter(component => types.includes(component.type)).map(component => component.name)]
      .filter(name => typeof name === 'string' && name.trim()).map(name => name.trim());
    if (value && !canonical.includes(value)) throw failure();
    checked[field] = value;
  }
  if (selection.manualProteinType !== undefined) {
    if (typeof selection.manualProteinType !== 'string') throw failure();
    const value = selection.manualProteinType.trim().toLowerCase();
    const stored = typeof item.portionType === 'string' ? item.portionType.trim().toLowerCase() : '';
    if (value && (!['chicken', 'beef', 'fish'].includes(stored) || value !== stored)) throw failure();
    checked.manualProteinType = value;
  }
  return checked;
};

export function validateMenuSelections({ menu, selections, exclusions = [], allergies = [] }) {
  if (!menu || !Array.isArray(selections)) throw failure();
  const entries = (menu.meals || []).filter(row => row && typeof row === 'object').flatMap(row => (Array.isArray(row.items) ? row.items : []).filter(item => item && typeof item === 'object' && !Array.isArray(item) && item.mealName).map(item => ({ item, date: dateKey(row.date), type: typeOf(row.mealType || item.mealType) })));
  return selections.map(selection => {
    if (!selection || typeof selection !== 'object') throw failure();
    const date = dateKey(selection.date), type = typeOf(selection.mealType);
    const matches = entries.filter(entry => entry.date === date && entry.type === type && (selection.menuItemId
      ? idOf(entry.item) === idOf(selection.menuItemId)
      : String(entry.item.mealName || '').trim() === String(selection.mealName || '').trim()));
    if (matches.length !== 1) throw failure();
    const item = matches[0].item;
    if (!item || typeof item !== 'object' || !item.mealName || selection.mealName && selection.mealName !== item.mealName) throw failure();
    if (item.itemDate && dateKey(item.itemDate) !== date || item.mealType && typeOf(item.mealType) !== type) throw failure();
    const quantity = selection.quantity === undefined ? 1 : Number(selection.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) throw failure();
    const choices = validateComponentChoices(item, selection);
    const result = evaluateComponentSelection(item, exclusions, allergies);
    if (result.allergies.length) throw failure();
    // Preserve the explicit Keep/Replace choice separately from private salad
    // routing. Legacy clients supply only carbVegAction.
    const preference = selection.carbVegPreference !== undefined ? selection.carbVegPreference : selection.carbVegAction;
    const flags = selectionPreferenceFlags(result, preference);
    // Clear all client claims first. Only the stored item and profile decide flags.
    const { carbVegPreference, carbVegAction, carbVegConflict, carbConflict, vegConflict, keptCarbConflict, keptVegConflict, needsSauceChange, needsGarnishChange, sauceConflict, garnishConflict, exclusionConflict, preferenceConflict, ...input } = selection;
    return { ...input, ...choices, date, mealType: type, menuItemId: idOf(item), mealName: item.mealName, quantity, ...flags };
  });
}

export async function validatedMenuSelections({ menuId, selections, nutrition }) {
  if (!mongoose.isValidObjectId(menuId) || !nutrition) throw failure();
  const menu = await Menu.findById(menuId).populate({ path: 'meals.items', model: 'MenuItem' }).lean();
  const profile = await resolveMenuAllergyProfile(nutrition);
  // Unknown remains unknown: we do not create or confirm a missing allergy profile.
  return validateMenuSelections({ menu, selections, exclusions: nutrition.exclusions || [], allergies: profile.allergiesAvailable ? profile.allergies : [] });
}
