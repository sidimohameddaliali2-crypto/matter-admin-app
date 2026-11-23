import { getDateKey } from '../lib/kitchenData';
import { mealFormat as workbookMealFormat, mealType as workbookProteinType } from '../pages/adminMealSelectionV2/workbookMeals';

export const kitchenMealCategory = meal => meal.category || (['breakfast', 'snack'].includes(meal.mealType) ? meal.mealType : 'meal');
const largeBreakfastSuffix = /\s*\(LARGE\)\s*$/i;
export const isLargeKitchenBreakfast = (meal, item) => kitchenMealCategory(meal) === 'breakfast'
  && (meal.flags?.isLargeBreakfast === true || [meal.mealName, meal.menuItemName, item?.mealName].some(name => largeBreakfastSuffix.test(name || '')));
// Build-your-own selections carry a placeholder item ID from the day, not a linked recipe.
const isIngredientSelection = meal => kitchenMealCategory(meal) === 'meal' && Boolean(meal.proteinChoice)
  && /^meal\s+\d+\s*-\s*protein:/i.test(String(meal.mealName || '').trim());
export const countingMealName = (meal, item) => {
  if (isIngredientSelection(meal)) {
    return meal.sauceChoice && !/\bsauce:/i.test(meal.mealName) ? `${meal.mealName}, Sauce: ${meal.sauceChoice}` : meal.mealName;
  }
  const base = item?.mealName || meal.mealName || meal.menuItemName || 'Unnamed meal';
  return isLargeKitchenBreakfast(meal, item) ? `${base.replace(largeBreakfastSuffix, '')} (LARGE)` : base;
};
const normalized = value => String(value || '').trim().toLowerCase();
export const kitchenMealNameKey = value => normalized(value).replace(/\s+/g, ' ');
const isNovember24Burger = (date, mealName, item, meal) => {
  if (date !== '2026-11-24' || !item._id || item.mealType !== 'main' || item.ambiguous || item.unresolved
    || kitchenMealNameKey(mealName) !== 'mexican burger with green rice'
    || workbookMealFormat({ category: item.category }) !== 'Main'
    || workbookMealFormat(item.cycleMeal || {}) !== 'Main'
    || workbookMealFormat({ category: item.cycleMeal?.category }) !== 'Main') return false;
  const datedTypes = [item.portionType, item.cycleMeal?.mealType,
    workbookProteinType({ category: item.cycleMeal?.category }), workbookProteinType({ category: item.category })];
  return [meal.manualProteinType, meal.proteinType, meal.proteinSourceType, ...datedTypes].every(type => ['', 'beef'].includes(normalized(type)));
};
const LEGACY_BURGER_PORTION = 'MEXICAN BURGER';
const isBurgerPortion = name => /^(?:beef )?mexican burger(?: beef| \(beef\))?$/.test(kitchenMealNameKey(name));
export const isAbsentKitchenComponent = value => !normalized(value) || /^(no|none|n\/a)(\s+(sauce|garnish))?$/.test(normalized(value));
const type = value => ['breakfast', 'snack'].includes(value) ? value : 'main';
export function kitchenPortionQuantity(category, name, recipe, date, mealName, meal = {}) {
  const { qtyUnit, gramsPerPiece } = recipe.cycleMeal || {};
  if (category !== 'meal') {
    const validKg = qtyUnit === 'KG' && (gramsPerPiece == null || Number.isFinite(gramsPerPiece) && gramsPerPiece >= 0.001);
    return { unit: validKg ? 'KG' : 'PCS' };
  }
  const burgerAlias = isNovember24Burger(date, mealName, recipe, meal) && isBurgerPortion(name);
  const component = burgerAlias ? { componentName: LEGACY_BURGER_PORTION } : {};
  if (qtyUnit === 'PCS' && Number.isFinite(gramsPerPiece) && gramsPerPiece >= 0.001) {
    return { unit: 'PCS', gramsPerPiece, ...component };
  }
  // The November 24 production exception predates saved library quantity rules.
  if (burgerAlias && qtyUnit === undefined && gramsPerPiece == null) {
    const datedPortions = (recipe.cycleMeal?.components || []).filter(value => ['Protein', 'Portion'].includes(value.type)).map(value => value.name);
    if ([recipe.proteinSource, ...datedPortions].every(value => isAbsentKitchenComponent(value) || isBurgerPortion(value))) {
      return { unit: 'PCS', gramsPerPiece: 50, ...component };
    }
  }
  return { unit: 'KG', ...component };
}

const decimalParts = value => {
  const [mantissa, exponent = '0'] = String(value).split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  return [BigInt(whole + fraction), Number(exponent) - fraction.length];
};
const decimalShift = places => BigInt(10) ** BigInt(places);
export function addAssignedGrams(total, grams, quantity) {
  const [weight, weightScale] = decimalParts(grams);
  const [count, countScale] = decimalParts(quantity);
  const scale = weightScale + countScale;
  if (!total) return [weight * count, scale];
  const sharedScale = Math.min(total[1], scale);
  return [total[0] * decimalShift(total[1] - sharedScale) + weight * count * decimalShift(scale - sharedScale), sharedScale];
}
export const decimalGramNumber = ([weight, scale]) => Number(`${weight}e${scale}`);

export function bufferedPortionPieces(grams, gramsPerPiece, bufferPercent = 5) {
  const [weight, weightScale] = Array.isArray(grams) ? grams : decimalParts(grams);
  const [piece, pieceScale] = decimalParts(gramsPerPiece);
  const scale = weightScale - pieceScale;
  const numerator = weight * BigInt(100 + bufferPercent) * decimalShift(Math.max(0, scale));
  const denominator = piece * BigInt(100) * decimalShift(Math.max(0, -scale));
  return Number((numerator + denominator - BigInt(1)) / denominator);
}

export const countingComponentQuantity = component => component.pcs === undefined
  ? `${Math.round(component.weight)} g` : `${component.pcs} PCS`;
const selectedItemId = meal => {
  if (isIngredientSelection(meal)) return undefined;
  return typeof meal.menuItemId === 'object' ? meal.menuItemId?._id : meal.menuItemId;
};
export function kitchenMealGroupKey(meal, item, mealName) {
  if (isIngredientSelection(meal)) {
    return JSON.stringify(['meal', 'ingredients', ...[mealName, meal.proteinChoice, meal.carbChoice, meal.vegChoice, meal.sauceChoice].map(kitchenMealNameKey)]);
  }
  const id = item?._id || selectedItemId(meal);
  // Counting keeps normal and Large breakfasts separate.
  const size = kitchenMealCategory(meal) === 'breakfast' && /\s*\(LARGE\)$/i.test(mealName) ? 'large' : '';
  return JSON.stringify([kitchenMealCategory(meal), id ? 'id' : 'name', String(id || kitchenMealNameKey(mealName)), size]);
}
export function kitchenRecipeForMeal(meal, catalog = []) {
  if (isIngredientSelection(meal)) return {};
  const populated = typeof meal.menuItemId === 'object' ? meal.menuItemId : null;
  const id = String(selectedItemId(meal) || '');
  if (id) {
    const datedItem = catalog.find(item => String(item._id) === id);
    if (datedItem) return datedItem;
    return { ...populated, unresolved: true };
  }
  const name = meal.mealName || meal.menuItemName;
  const candidates = catalog.filter(item => type(item.mealType) === type(meal.mealType));
  let matches = candidates.filter(item => normalized(item.mealName) === normalized(name));
  if (!matches.length) matches = candidates.filter(item => kitchenMealNameKey(item.mealName) === kitchenMealNameKey(name));
  if (matches.length > 1) return { ambiguous: true };
  return matches.length === 1 ? matches[0] : populated || {};
}

export function kitchenComponentNames(meal, catalog = [], item = kitchenRecipeForMeal(meal, catalog)) {
  const components = item.cycleMeal?.components || [];
  const names = types => [...new Set(components.filter(component => types.includes(component.type))
    .map(component => String(component.name || '').trim()).filter(Boolean))].join(' + ');
  return {
    protein: meal.proteinChoice || names(['Protein', 'Portion', 'Breakfast', 'Snack']) || item.proteinSource
      || (kitchenMealCategory(meal) !== 'meal' ? countingMealName({ ...meal, flags: {} }, item) : '')
      || (isNovember24Burger(getDateKey(meal.date), countingMealName(meal, item), item, meal) ? LEGACY_BURGER_PORTION : 'Component not recorded'),
    carb: meal.carbChoice || names(['Carb']) || item.carbs || 'Component not recorded',
    veg: meal.vegChoice || names(['Vegetable', 'Salad']) || item.veg || 'Component not recorded',
  };
}

export function kitchenCountMeals(entries, date, catalog = [], groupFromSelections = false) {
  const portions = [], idsByName = new Map();
  for (const entry of entries) for (const meal of entry.selectedMeals || []) {
    if (getDateKey(meal.date) !== date) continue;
    const item = kitchenRecipeForMeal(meal, catalog);
    const category = kitchenMealCategory(meal), mealName = countingMealName(meal, item);
    const key = kitchenMealGroupKey(meal, item, mealName);
    const nameKey = JSON.stringify([category, kitchenMealNameKey(mealName)]);
    const linked = Boolean(item._id || selectedItemId(meal));
    portions.push({ entry, meal, item, category, mealName, key, nameKey, linked });
    if (groupFromSelections && linked) {
      if (!idsByName.has(nameKey)) idsByName.set(nameKey, new Set());
      idsByName.get(nameKey).add(key);
    }
  }
  if (groupFromSelections) for (const portion of portions) {
    const sameName = idsByName.get(portion.nameKey);
    if (!portion.linked && !portion.item.ambiguous && sameName?.size === 1) portion.key = sameName.values().next().value;
  }
  return portions;
}

export function buildKitchenCountRows(entries, date, catalog = [], groupFromSelections = false) {
  const grouped = new Map();
  const portionWeights = new WeakMap();
  for (const { meal, item, category, mealName, key } of kitchenCountMeals(entries, date, catalog, groupFromSelections)) {
    const qty = Number(meal.quantity) || 1;
    if (!grouped.has(key)) grouped.set(key, { key, category, mealName, count: 0,
      totalProteinWeight: 0, totalCarbWeight: 0, totalVegWeight: 0,
      components: { protein: [], carb: [], veg: [] } });
    const row = grouped.get(key), names = kitchenComponentNames(meal, catalog, item);
    const portion = kitchenPortionQuantity(category, names.protein, item, date, mealName, meal);
    row.count += qty;
    for (const [kind, total] of [['protein', 'totalProteinWeight'], ['carb', 'totalCarbWeight'], ['veg', 'totalVegWeight']]) {
      const grams = Number(meal[`${kind}Weight`]) || 0;
      const weight = grams * qty;
      row[total] += weight;
      const label = (kind === 'protein' && portion.componentName) || names[kind];
      if (isAbsentKitchenComponent(label) && (kind === 'protein' || !weight)) continue;
      const name = isAbsentKitchenComponent(label) ? 'Component not recorded' : label;
      const pieces = kind === 'protein' && portion.unit === 'PCS';
      const gramsPerPiece = pieces ? portion.gramsPerPiece : undefined;
      const existing = row.components[kind].find(component => kitchenMealNameKey(component.name) === kitchenMealNameKey(name)
        && (component.pcs !== undefined) === pieces && component.gramsPerPiece === gramsPerPiece);
      const component = existing || { name, weight: 0 };
      component.weight += weight;
      if (pieces) {
        if (gramsPerPiece) {
          component.gramsPerPiece = gramsPerPiece;
          component.pcs = 0;
          portionWeights.set(component, addAssignedGrams(portionWeights.get(component), grams, qty));
        } else component.pcs = (component.pcs || 0) + qty;
      }
      if (!existing) row.components[kind].push(component);
    }
  }
  for (const row of grouped.values()) for (const component of row.components.protein) {
    const grams = portionWeights.get(component);
    if (!grams) continue;
    component.weight = decimalGramNumber(grams);
    component.pcs = bufferedPortionPieces(grams, component.gramsPerPiece);
  }
  const order = { breakfast: 0, meal: 1, snack: 2 };
  return [...grouped.values()].sort((a, b) => (order[a.category] ?? 9) - (order[b.category] ?? 9) || a.mealName.localeCompare(b.mealName));
}

export const componentWeightText = components => (components || []).map(component => `${component.name}: ${countingComponentQuantity(component)}`).join('; ');
