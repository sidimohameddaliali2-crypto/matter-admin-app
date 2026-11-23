import MealCreationState from '../models/MealCreationState.js';
import { validKitchenQuantityRule } from './menuComponentSnapshot.js';
import { libraryMealKind } from './mealLibraryDuplicates.js';

const hasQuantityRule = rule => rule.qtyUnit !== undefined || rule.gramsPerPiece != null;

export async function withCurrentKitchenQuantities(items) {
  if (!items.some(item => item.cycleMeal?.id)) return items;
  const library = await MealCreationState.findById('shared')
    .select('catalogue.meals.id catalogue.meals.qtyUnit catalogue.meals.gramsPerPiece catalogue.meals.mealKind catalogue.meals.mealFormat catalogue.meals.category aliases').lean();
  const meals = new Map((library?.catalogue?.meals || []).map(meal => [meal.id, meal]));
  const aliases = new Map((library?.aliases || []).map(({ from, to }) => [from, to]));

  // Dated recipes stay intact. Only the kitchen quantity rule follows the library.
  return items.map(item => {
    const id = item.cycleMeal?.id;
    const current = meals.get(id) || meals.get(aliases.get(id));
    const isMain = item.mealType === 'main';
    const dated = item.cycleMeal;
    const sourceRule = current && hasQuantityRule(current);
    const validSource = sourceRule && validKitchenQuantityRule(current, libraryMealKind(current) === 'Main');
    const withRule = (qtyUnit, gramsPerPiece) => ({ ...item, cycleMeal: { ...dated, qtyUnit, gramsPerPiece } });
    if (validSource && validKitchenQuantityRule(current, isMain)) return withRule(current.qtyUnit, current.gramsPerPiece ?? null);
    const datedRule = dated && hasQuantityRule(dated);
    if (datedRule && validKitchenQuantityRule(dated, isMain)
      && (dated.qtyUnit !== 'PCS' || (libraryMealKind(dated) === 'Main') === isMain)) return item;
    if (datedRule || (sourceRule && !validSource)) return withRule(isMain ? 'KG' : 'PCS', null);
    return item;
  });
}
