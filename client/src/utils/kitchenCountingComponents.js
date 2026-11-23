import { getDateKey } from '../lib/kitchenData';

export const countingMealName = meal => {
  const base = meal.mealName || meal.menuItemName || 'Unnamed meal';
  return meal.category === 'breakfast' && meal.flags?.isLargeBreakfast ? `${base} (LARGE)` : base;
};
const normalized = value => String(value || '').trim().toLowerCase();
const type = value => ['breakfast', 'snack'].includes(value) ? value : 'main';
export function kitchenPortionQuantity(category, name, recipe) {
  const { qtyUnit, gramsPerPiece } = recipe.cycleMeal || {};
  if (qtyUnit === 'KG') return { unit: 'KG' };
  if (category === 'breakfast' || category === 'snack') return { unit: 'PCS' };
  if (qtyUnit === 'PCS') return { unit: 'PCS', gramsPerPiece };
  if (normalized(name).replace(/\s+/g, ' ') === 'mexican burger') return { unit: 'PCS', gramsPerPiece: 50 };
  return { unit: 'KG' };
}

export function bufferedPortionPieces(grams, gramsPerPiece, bufferPercent = 5) {
  const decimalParts = value => {
    const [mantissa, exponent = '0'] = String(value).split('e');
    const [whole, fraction = ''] = mantissa.split('.');
    return [BigInt(whole + fraction), Number(exponent) - fraction.length];
  };
  const [weight, weightScale] = decimalParts(grams);
  const [piece, pieceScale] = decimalParts(gramsPerPiece);
  const scale = weightScale - pieceScale;
  const numerator = weight * BigInt(100 + bufferPercent) * BigInt(10) ** BigInt(Math.max(0, scale));
  const denominator = piece * BigInt(100) * BigInt(10) ** BigInt(Math.max(0, -scale));
  return Number((numerator + denominator - BigInt(1)) / denominator);
}

export const countingComponentQuantity = component => component.pcs === undefined
  ? `${Math.round(component.weight)} g` : `${component.pcs} PCS`;
export function kitchenRecipeForMeal(meal, catalog = []) {
  const populated = typeof meal.menuItemId === 'object' ? meal.menuItemId : null;
  const id = String(populated?._id || meal.menuItemId || '');
  const matches = catalog.filter(item => id ? String(item._id) === id
    : normalized(item.mealName) === normalized(meal.mealName) && type(item.mealType) === type(meal.mealType));
  return matches.length === 1 ? matches[0] : populated || {};
}

export function kitchenComponentNames(meal, catalog = []) {
  const item = kitchenRecipeForMeal(meal, catalog);
  const components = item.cycleMeal?.components || [];
  const names = types => [...new Set(components.filter(component => types.includes(component.type))
    .map(component => String(component.name || '').trim()).filter(Boolean))].join(' + ');
  return {
    protein: meal.proteinChoice || names(['Protein', 'Portion', 'Breakfast', 'Snack']) || item.proteinSource
      || (['breakfast', 'snack'].includes(meal.category) ? meal.mealName : '') || 'Component not recorded',
    carb: meal.carbChoice || names(['Carb']) || item.carbs || 'Component not recorded',
    veg: meal.vegChoice || names(['Vegetable', 'Salad']) || item.veg || 'Component not recorded',
  };
}

export function buildKitchenCountRows(entries, date, catalog = []) {
  const grouped = new Map();
  for (const entry of entries) for (const meal of entry.selectedMeals || []) {
    if (getDateKey(meal.date) !== date) continue;
    const category = meal.category || 'meal', mealName = countingMealName(meal);
    const key = `${category}||${mealName}`, qty = Number(meal.quantity) || 1;
    if (!grouped.has(key)) grouped.set(key, { category, mealName, count: 0,
      totalProteinWeight: 0, totalCarbWeight: 0, totalVegWeight: 0,
      components: { protein: [], carb: [], veg: [] } });
    const row = grouped.get(key), names = kitchenComponentNames(meal, catalog);
    const portion = kitchenPortionQuantity(category, names.protein, kitchenRecipeForMeal(meal, catalog));
    row.count += qty;
    for (const [kind, total] of [['protein', 'totalProteinWeight'], ['carb', 'totalCarbWeight'], ['veg', 'totalVegWeight']]) {
      const weight = (Number(meal[`${kind}Weight`]) || 0) * qty;
      row[total] += weight;
      const pieces = kind === 'protein' && portion.unit === 'PCS'
        && (category !== 'meal' || Number.isFinite(portion.gramsPerPiece) && portion.gramsPerPiece > 0);
      const gramsPerPiece = pieces ? portion.gramsPerPiece : undefined;
      const existing = row.components[kind].find(component => normalized(component.name) === normalized(names[kind])
        && (component.pcs !== undefined) === pieces && component.gramsPerPiece === gramsPerPiece);
      const component = existing || { name: names[kind], weight: 0 };
      component.weight += weight;
      if (pieces) {
        if (gramsPerPiece) {
          component.gramsPerPiece = gramsPerPiece;
          component.pcs = bufferedPortionPieces(component.weight, gramsPerPiece);
        } else component.pcs = (component.pcs || 0) + qty;
      }
      if (!existing) row.components[kind].push(component);
    }
  }
  const order = { breakfast: 0, meal: 1, snack: 2 };
  return [...grouped.values()].sort((a, b) => (order[a.category] ?? 9) - (order[b.category] ?? 9) || a.mealName.localeCompare(b.mealName));
}

export const componentWeightText = components => (components || []).map(component => `${component.name}: ${countingComponentQuantity(component)}`).join('; ');
