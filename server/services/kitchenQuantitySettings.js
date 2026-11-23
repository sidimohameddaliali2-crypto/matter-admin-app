import MealCreationState from '../models/MealCreationState.js';

export async function withCurrentKitchenQuantities(items) {
  if (!items.some(item => item.cycleMeal?.id)) return items;
  const library = await MealCreationState.findById('shared')
    .select('catalogue.meals.id catalogue.meals.qtyUnit catalogue.meals.gramsPerPiece aliases').lean();
  const meals = new Map((library?.catalogue?.meals || []).map(meal => [meal.id, meal]));
  const aliases = new Map((library?.aliases || []).map(({ from, to }) => [from, to]));

  // Dated recipes stay intact. Only the kitchen quantity rule follows the library.
  return items.map(item => {
    const id = item.cycleMeal?.id;
    const current = meals.get(id) || meals.get(aliases.get(id));
    if (!current?.qtyUnit) return item;
    return { ...item, cycleMeal: { ...item.cycleMeal, qtyUnit: current.qtyUnit, gramsPerPiece: current.gramsPerPiece ?? null } };
  });
}
