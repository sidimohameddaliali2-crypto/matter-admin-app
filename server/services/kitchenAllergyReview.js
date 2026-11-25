import WeeklyMenu from '../models/WeeklyMenu.js';
import MenuItem from '../models/MenuItem.js';
import { buildLegacyKitchenMainRotation, datedKitchenProtein, identifyKitchenMenuItem, kitchenAllergyConflicts, resolveLegacyKitchenChoices } from './kitchenExclusions.js';

const nameKey = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
const idOf = value => String(value?._id || value || '');
const isLegacyBuildYourOwn = meal => meal.mealType === 'main' && meal.isAutoAssigned !== true
  && [meal.proteinChoice, meal.vegChoice, meal.carbChoice].every(choice => typeof choice === 'string' && choice.trim())
  && meal.mealName === `Meal ${meal.slotNumber} - Protein: ${meal.proteinChoice}, Veg: ${meal.vegChoice}, Carb: ${meal.carbChoice}`;

export async function loadDatedKitchenAllergyOptions(menuId, date) {
  const menu = await WeeklyMenu.findById(menuId).select('meals mainMealOptionsByDate breakfastOptionsByDate snackOptionsByDate').lean();
  if (!menu) throw new Error('Menu not found while checking saved kitchen meals.');
  const items = await MenuItem.find({
    _id: { $in: (menu.meals || []).flatMap(day => (day.items || []).map(item => item._id || item)) },
    itemDate: new Date(date),
  }).lean();
  const mainItems = items.filter(item => item.mealType === 'main');
  const usesLegacyMainRotation = !mainItems.some(item => item.rotationCategory === 'main');
  const legacy = usesLegacyMainRotation
    ? buildLegacyKitchenMainRotation(menu.mainMealOptionsByDate?.[date], mainItems.map(identifyKitchenMenuItem)) : null;
  const snacks = menu.snackOptionsByDate?.[date];
  return {
    items,
    usesLegacyMainRotation,
    legacyMainRestrictions: legacy?.restrictions,
    rotations: {
      main: legacy ? [...legacy.mains, ...legacy.subs] : [],
      breakfast: menu.breakfastOptionsByDate?.[date] || [],
      snack: Array.isArray(snacks) ? snacks : [...(snacks?.first || []), ...(snacks?.second || [])],
    },
  };
}

export function assertSavedKitchenAllergies(meals, options, nutrition, date) {
  const allergies = nutrition.allergyProfile.allergies;
  const name = nutrition.customer_name || nutrition.customer_email;
  const core = String(nutrition.plan_name || '').trim().toLowerCase() === 'matter core';
  for (const meal of meals) {
    const typed = options.items.filter(item => item.mealType === meal.mealType);
    const usesLegacyMain = meal.mealType === 'main' && !core && options.usesLegacyMainRotation;
    const legacyRestrictions = usesLegacyMain ? options.legacyMainRestrictions : null;
    const custom = isLegacyBuildYourOwn(meal) ? resolveLegacyKitchenChoices(meal, typed, legacyRestrictions) : null;
    const recipeId = idOf(meal.menuItemId);
    const savedProtein = meal.mealType === 'main' ? datedKitchenProtein({ portionType: meal.manualProteinType || meal.portionType }) : undefined;
    const matching = recipeId ? typed.filter(item => idOf(item) === recipeId)
      : typed.filter(item => nameKey(item.mealName) === nameKey(meal.mealName)
        && (!savedProtein || datedKitchenProtein(item) === savedProtein));
    const relatedNames = [meal.mealName, ...matching.map(item => item.mealName)].map(nameKey);
    const usesRotation = meal.mealType !== 'main' || usesLegacyMain;
    const rotations = usesRotation ? (options.rotations[meal.mealType] || []).filter(option => (
      recipeId && meal.mealType === 'main'
        ? idOf(option.kitchenMenuItemId) === recipeId
        : [option.name, option.rotationName].some(value => relatedNames.includes(nameKey(value)))
          && (!savedProtein || !option.type || option.type === savedProtein)
    )) : [];
    const copyRestrictions = matching.flatMap(item => legacyRestrictions?.get(idOf(item)) || []);
    const conflicts = kitchenAllergyConflicts({ ...meal, proteinSource: meal.proteinChoice, carbs: meal.carbChoice,
      veg: meal.vegChoice, sauce: meal.sauceChoice, portionType: meal.manualProteinType,
      ...(custom ? { ingredients: custom.ingredients }
        : { allergyAlternatives: [...matching, ...rotations, { exclusions: copyRestrictions }] }) }, allergies);
    const verified = custom ? custom.unverified.length === 0 : matching.length > 0;
    if (conflicts.length || !verified) {
      const reason = conflicts.length ? `conflicts with recorded allergies (${conflicts.join(', ')})`
        : custom ? `has unverified dated components (${custom.unverified.join(', ')})` : 'has no verified dated recipe';
      throw Object.assign(new Error(`${date}: ${name} has a saved meal, ${meal.mealName}, that ${reason}. Review the selection before preparing or exporting this date.`),
        { statusCode: 409, code: 'KITCHEN_ALLERGY_REVIEW' });
    }
  }
}

export async function reviewSavedKitchenAllergies(menuId, date, record, nutrition, optionsByDate, mealType) {
  if (!nutrition.allergyProfile?.allergies?.length) return;
  const meals = (record?.selectedMeals || []).filter(meal => {
    if (mealType && meal.mealType !== mealType) return false;
    const time = meal.date && new Date(meal.date);
    return time && Number.isFinite(time.getTime()) && time.toISOString().slice(0, 10) === date;
  });
  if (!meals.length) return;
  if (!optionsByDate.has(date)) optionsByDate.set(date, loadDatedKitchenAllergyOptions(menuId, date));
  assertSavedKitchenAllergies(meals, await optionsByDate.get(date), nutrition, date);
}
