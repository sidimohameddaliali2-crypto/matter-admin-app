import { createHash } from 'node:crypto';
import MealCreationState from '../models/MealCreationState.js';
import SnackPreset from '../models/KitchenSnackPreset.js';
import { KITCHEN_FALLBACK_SNACKS, findKitchenFallbackSnackPreset, kitchenFallbackSnackKey, kitchenSnackRecipeKey } from '../../client/src/constants/kitchenFallbackSnacks.js';
import { libraryMealKind, mealFingerprint } from './mealLibraryDuplicates.js';
import { kitchenAllergyConflicts, kitchenConflictList } from './kitchenExclusions.js';
import { kitchenDietaryExclusions } from './kitchenDietaryExclusions.js';

const hasTerms = value => Array.isArray(value)
  ? value.some(term => hasTerms(term?.name ?? term))
  : typeof value === 'string' && Boolean(value.trim());
const hasRestrictionData = meal => meal.components?.length
  ? meal.components.every(component => hasTerms(component.name)
    && [component.ingredients, component.allergens, component.exclusions].some(hasTerms))
  : hasTerms(meal.ingredients);

export async function loadFallbackSnackRecipes(session) {
  const query = MealCreationState.findById('shared').select('catalogue.meals');
  if (session) query.session(session);
  const library = await query.lean();
  return KITCHEN_FALLBACK_SNACKS.flatMap(name => {
    const matches = (library?.catalogue?.meals || []).filter(meal => libraryMealKind(meal) === 'Snack'
      && kitchenFallbackSnackKey(meal.name) === kitchenFallbackSnackKey(name));
    if (matches.length !== 1 || !matches[0].id) return [];
    const recipe = matches[0];
    if (recipe.components != null && (!Array.isArray(recipe.components) || recipe.components.some(component => !component || typeof component !== 'object'))
      || !hasRestrictionData(recipe)) return [];
    return [{
      name, mealType: 'snack', cycleMeal: recipe,
      // Keep recipe-level declarations and dietary tags written in the full title.
      ingredients: recipe.ingredients, allergens: recipe.allergens,
      exclusions: recipe.exclusions, mealName: recipe.name,
      fallbackSnackRecipeId: String(recipe.id),
      fallbackSnackRecipeVersion: createHash('sha256').update(mealFingerprint(recipe, { ignoreQuantity: true })).digest('hex'),
    }];
  });
}

export const kitchenSnackConflicts = (option, exclusions) => {
  const recipe = option.cycleMeal;
  return kitchenConflictList({ ...option, exclusions: [option.exclusions, recipe?.ingredients, recipe?.allergens, recipe?.exclusions] }, exclusions);
};
const compatible = (option, exclusions, allergies) => !kitchenSnackConflicts(option, exclusions).length
  && !kitchenAllergyConflicts(option, allergies).length;

export const canUseFallbackSnacks = (pools, exclusions, allergies) =>
  pools.first.length > 0 && pools.second.length > 0
  && [...pools.first, ...pools.second].every(option => !compatible(option, exclusions, allergies));

export async function loadFallbackSnackOptions() {
  const [recipes, presets] = await Promise.all([loadFallbackSnackRecipes(), SnackPreset.findOne({ key: 'global' }).lean()]);
  return recipes.flatMap(recipe => {
    const macros = findKitchenFallbackSnackPreset(recipe.mealName, presets?.presetsByName);
    return macros ? [{ ...recipe, macros }] : [];
  });
}

export function eligibleFallbackSnacks(options, pools, exclusions, allergies) {
  const scheduledNames = new Set([...pools.first, ...pools.second].map(option => kitchenFallbackSnackKey(option.name)));
  return options.filter(option => !scheduledNames.has(kitchenFallbackSnackKey(option.name)) && compatible(option, exclusions, allergies));
}

export const isFallbackSnack = meal => meal.mealType === 'snack' && Boolean(meal.fallbackSnackRecipeId || meal.fallbackSnackRecipeVersion);

export function fallbackSnackSelection(choice) {
  return {
    mealName: choice.mealName,
    fallbackSnackRecipeId: choice.fallbackSnackRecipeId,
    fallbackSnackRecipeVersion: choice.fallbackSnackRecipeVersion,
    snackMacros: choice.macros,
  };
}

export function fallbackSnackReview(meal, options, nutrition) {
  if (!nutrition.allergyProfile?.allergiesAvailable) return 'has unavailable Matter allergy information';
  const exclusions = kitchenDietaryExclusions(nutrition);
  if (!Array.isArray(exclusions)) return 'has unavailable Matter exclusions';
  const recipe = options.find(option => option.fallbackSnackRecipeId === meal.fallbackSnackRecipeId);
  if (!recipe || recipe.fallbackSnackRecipeVersion !== meal.fallbackSnackRecipeVersion
    || kitchenSnackRecipeKey(recipe.mealName) !== kitchenSnackRecipeKey(meal.mealName)) return 'has no matching verified fallback recipe';
  const allergens = kitchenAllergyConflicts(recipe, nutrition.allergyProfile?.allergies || []);
  if (allergens.length) return `conflicts with recorded allergies (${allergens.join(', ')})`;
  const conflicts = kitchenSnackConflicts(recipe, exclusions);
  return conflicts.length ? `conflicts with exclusions (${conflicts.join(', ')})` : null;
}
