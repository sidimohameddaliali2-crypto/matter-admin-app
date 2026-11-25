import { createHash } from 'node:crypto';
import WeeklyMenu from '../models/WeeklyMenu.js';
import MenuItem from '../models/MenuItem.js';
import { buildLegacyKitchenMainRotation, datedKitchenProtein, identifyKitchenMenuItem, kitchenAllergyConflicts, resolveLegacyKitchenChoices } from './kitchenExclusions.js';
import { fallbackSnackReview, isFallbackSnack, loadFallbackSnackRecipes } from './kitchenFallbackSnacks.js';

const nameKey = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
const idOf = value => String(value?._id || value || '');
const fallbackRecipesKey = Symbol('fallback snack recipes');
const savedMealReviewError = (date, nutrition, meal, reason) => Object.assign(
  new Error(`${date}: ${nutrition.customer_name || nutrition.customer_email} has a saved meal, ${meal.mealName}, that ${reason}. Review the selection before preparing or exporting this date.`),
  { statusCode: 409, code: 'KITCHEN_ALLERGY_REVIEW' },
);
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
  return datedKitchenAllergyOptions(menu, date, items);
}

export function datedKitchenAllergyOptions(menu, date, items) {
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

export function findDatedKitchenAllergyIssues(meals, options, nutrition) {
  const allergies = nutrition.allergyProfile.allergies;
  const core = String(nutrition.plan_name || '').trim().toLowerCase() === 'matter core';
  const findings = [];
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
      findings.push({ meal, reason, conflicts: verified ? conflicts : [],
        evidence: custom || { recipes: matching, rotations, copyRestrictions } });
    }
  }
  return findings;
}

export function assertSavedKitchenAllergies(meals, options, nutrition, date) {
  const [finding] = findDatedKitchenAllergyIssues(meals, options, nutrition);
  if (finding) throw savedMealReviewError(date, nutrition, finding.meal, finding.reason);
}

export function matchesKitchenAllergyRecord(record, nutrition) {
  return record.matterCustomerId ? String(record.matterCustomerId) === String(nutrition.customer_id)
    : (nutrition.subscription_id != null && String(record.matterSubscriptionId || '') === String(nutrition.subscription_id))
      || (!!nutrition.customer_email && nameKey(record.matterEmail || record.email) === nameKey(nutrition.customer_email));
}

function reviewCase(record, nutrition, date, { meal, reason, conflicts = [], evidence }) {
  const recordId = idOf(record._id);
  const mealId = idOf(meal._id);
  const customerId = String(nutrition.customer_id ?? '');
  const subscriptionId = String(nutrition.subscription_id ?? '');
  const canConfirm = Boolean(recordId && mealId && customerId && subscriptionId && conflicts.length);
  const fingerprint = createHash('sha256').update(JSON.stringify([
    'kitchen-allergy-review-v1', recordId, mealId, customerId, subscriptionId, date,
    meal.mealType, meal.mealName, idOf(meal.menuItemId), meal.quantity ?? 1, meal.slotNumber,
    meal.proteinChoice, meal.carbChoice, meal.vegChoice, meal.sauceChoice, meal.manualProteinType || '',
    [...(nutrition.allergyProfile?.allergies || [])].sort(), [...conflicts].sort(), reason, evidence,
  ])).digest('hex');
  const previous = canConfirm && record.kitchenAllergyConfirmations?.find(item => item.fingerprint === fingerprint);
  const confirmation = previous ? { actorName: previous.actorName, at: previous.at, note: previous.note } : null;
  return { fingerprint, recordId, mealId, customerId, subscriptionId, date, canConfirm, conflicts, confirmation,
    mealName: meal.mealName, message: savedMealReviewError(date, nutrition, meal, reason).message };
}

export async function collectSavedKitchenAllergies(menuId, date, record, nutrition, optionsByDate, { mealType, fallbackOnly, checkUnavailable = true, session } = {}) {
  const meals = (record?.selectedMeals || []).filter(meal => {
    if (mealType && meal.mealType !== mealType) return false;
    const time = meal.date && new Date(meal.date);
    return time && Number.isFinite(time.getTime()) && time.toISOString().slice(0, 10) === date;
  });
  const findings = [];
  const fallback = meals.filter(isFallbackSnack);
  if (fallback.length) {
    if (!optionsByDate.has(fallbackRecipesKey)) optionsByDate.set(fallbackRecipesKey, loadFallbackSnackRecipes(session));
    const recipes = await optionsByDate.get(fallbackRecipesKey);
    for (const meal of fallback) {
      const reason = fallbackSnackReview(meal, recipes, nutrition);
      if (!reason) continue;
      const recipe = recipes.find(item => item.fallbackSnackRecipeId === meal.fallbackSnackRecipeId);
      const conflicts = reason.startsWith('conflicts with recorded allergies')
        ? kitchenAllergyConflicts(recipe, nutrition.allergyProfile.allergies) : [];
      findings.push({ meal, reason, conflicts, evidence: recipe });
      if (conflicts.length) {
        const otherReason = fallbackSnackReview(meal, recipes, {
          ...nutrition, allergyProfile: { ...nutrition.allergyProfile, allergies: [] },
        });
        if (otherReason) findings.push({ meal, reason: otherReason, evidence: recipe });
      }
    }
  }
  const regular = meals.filter(meal => !isFallbackSnack(meal));
  if (!fallbackOnly && regular.length) {
    if (checkUnavailable && nutrition.allergyProfile?.allergiesAvailable === false) {
      findings.push(...regular.map(meal => ({ meal, reason: 'has unavailable Matter allergy information' })));
    } else if (nutrition.allergyProfile?.allergies?.length) {
      if (!optionsByDate.has(date)) optionsByDate.set(date, loadDatedKitchenAllergyOptions(menuId, date));
      findings.push(...findDatedKitchenAllergyIssues(regular, await optionsByDate.get(date), nutrition));
    }
  }
  return findings.map(finding => reviewCase(record, nutrition, date, finding));
}

export async function reviewSavedKitchenAllergies(menuId, date, record, nutrition, optionsByDate, mealType) {
  const findings = await collectSavedKitchenAllergies(menuId, date, record, nutrition, optionsByDate, { mealType, checkUnavailable: false });
  const pending = findings.find(finding => !finding.confirmation);
  if (pending) throw Object.assign(new Error(pending.message), { statusCode: 409, code: 'KITCHEN_ALLERGY_REVIEW' });
}
