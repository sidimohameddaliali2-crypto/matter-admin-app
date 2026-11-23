import { mealFormat } from '../pages/adminMealSelectionV2/workbookMeals';

export const recipeForDatedCopy = (meal, type) => {
  const { qtyUnit, gramsPerPiece, ...recipe } = meal;
  const validConversion = Number.isFinite(gramsPerPiece) && gramsPerPiece >= 0.001;
  const isMain = type === 'main';
  if ((qtyUnit === 'KG' && (gramsPerPiece == null || validConversion))
    || (qtyUnit === 'PCS' && isMain === (mealFormat(meal) === 'Main') && (isMain ? validConversion : gramsPerPiece == null))) return meal;
  // Keep the saved recipe while discarding any legacy quantity metadata that
  // cannot apply to a new dated item.
  return recipe;
};

export const copyManagedMenuItem = item => {
  const copy = JSON.parse(JSON.stringify(item));
  delete copy.menuItemId;
  delete copy._id;
  if (copy.cycleMeal) copy.cycleMeal = recipeForDatedCopy(copy.cycleMeal, copy.mealType || 'main');
  return copy;
};

export const MENU_TITLE_REQUIRED = 'Enter a menu title before saving or publishing.';

export const managedMenuPayload = (form, days, publish) => {
  if (typeof form.title !== 'string' || !form.title.trim()) {
    throw Object.assign(new Error(MENU_TITLE_REQUIRED), { code: 'MENU_TITLE_REQUIRED' });
  }
  return { ...form, title: form.title.trim(), days, ...(publish ? { isPublished: true } : {}) };
};
