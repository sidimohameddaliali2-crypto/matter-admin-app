const text = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const sortedTerms = values => [...new Set((Array.isArray(values) ? values : values == null ? [] : [values]).flatMap(value => String(value?.name ?? value).split(/[,;|\n\r]+/).map(text)).filter(Boolean))].sort();
const stable = value => typeof value === 'string' ? text(value) : Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, stable(value[key])])) : value;
const without = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const componentSource = ['id','sourceCell','sourceRow','sourceRows','originalText','relationship','attachedComponentId','saladComponentId'];
const mealSource = ['id','importedMealId','day','cycleDays','category','mealKind','mealFormat','mealType','status','sourceRows','sourceRow','workbookRow','cycleSource','absentSlots','preserveLibraryId'];

export const libraryMealKind = meal => {
  if (meal.mealKind === 'Main meal') return 'Main';
  if (['Breakfast','Snack'].includes(meal.mealKind)) return meal.mealKind;
  if (['Main','Breakfast','Snack'].includes(meal.mealFormat)) return meal.mealFormat;
  return /B'FAST|OATS/.test(meal.category || '') ? 'Breakfast' : /SNACK/.test(meal.category || '') ? 'Snack' : 'Main';
};

// IDs, workbook locations and cycle days identify occurrences, not recipes.
// Preserve all operational fields (including notes/adaptations and attachments)
// so different dietary/preparation variants can never be collapsed by name.
export function mealFingerprint(meal, { ignoreQuantity = false } = {}) {
  const base = component => stable({ ...without(component, componentSource), type: ['Protein','Portion','Breakfast','Snack'].includes(component.type) ? 'Portion' : component.type, exclusions: sortedTerms(component.exclusions), allergens: sortedTerms(component.allergens), ingredients: component.ingredients || [], notes: component.notes || '', adaptation: component.adaptation || 'Not reviewed', replacement: component.replacement || '' });
  const components = meal.components || [], byId = new Map(components.map(component => [component.id, component]));
  const signature = (component, visited = new Set()) => {
    if (visited.has(component.id)) return { cycle: true };
    const next = new Set([...visited, component.id]);
    return { ...base(component), ...Object.fromEntries(['attachedComponentId','saladComponentId'].filter(key => component[key]).map(key => {
      const target = byId.get(component[key]);
      return [key, target ? signature(target, next) : `unknown:${component[key]}`];
    })) };
  };
  const kind = libraryMealKind(meal);
  const explicitProtein = text(meal.mealType);
  const protein = ['chicken','beef','fish'].includes(explicitProtein) ? explicitProtein : /\b(CHX|CHICKEN)\b/i.test(meal.category || '') ? 'Chicken' : /\bBEEF\b/i.test(meal.category || '') ? 'Beef' : /\bFISH\b/i.test(meal.category || '') ? 'Fish' : '';
  const recipe = stable({
    ...without(meal, [...mealSource, 'components', 'qtyUnit', 'gramsPerPiece']), kind, protein: kind === 'Main' ? protein : '',
    notes: meal.notes || '', temperature: meal.temperature || '', tags: meal.tags || '', carbCombined: meal.carbCombined || 'Not specified', allergens: sortedTerms(meal.allergens),
    isOatmeal: meal.isOatmeal ?? meal.category === 'OATS', isSaladBase: !!meal.isSaladBase,
    isFixedMeal: meal.isFixedMeal === true,
    components: components.map(component => JSON.stringify(signature(component))).sort(),
  });
  return JSON.stringify(ignoreQuantity ? recipe : { ...recipe, qtyUnit: meal.qtyUnit, gramsPerPiece: meal.gramsPerPiece });
}

const days = meal => [...new Set([meal.day, ...(meal.cycleDays || [])].filter(Boolean))];
export function deduplicateMeals(meals, previousAliases = []) {
  const fingerprints = new Map(), kept = [], aliases = new Map(previousAliases.map(alias => [alias.from, alias.to]));
  for (const meal of meals) {
    const fingerprint = meal.preserveLibraryId === true ? `id:${meal.id}` : `recipe:${mealFingerprint(meal)}`;
    const index = fingerprints.get(fingerprint);
    if (index !== undefined) {
      const canonical = kept[index], cycleDays = [...new Set([...days(canonical), ...days(meal)])];
      if (JSON.stringify(cycleDays) !== JSON.stringify(days(canonical))) kept[index] = { ...canonical, cycleDays };
      if (meal.id !== canonical.id) aliases.set(meal.id, canonical.id);
    } else { fingerprints.set(fingerprint, kept.length); kept.push(meal); }
  }
  const ids = new Set(kept.map(meal => meal.id));
  const resolved = [];
  for (const from of aliases.keys()) {
    if (ids.has(from)) continue;
    let to = aliases.get(from); const seen = new Set([from]);
    while (aliases.has(to) && !ids.has(to) && !seen.has(to)) { seen.add(to); to = aliases.get(to); }
    if (ids.has(to)) resolved.push({ from, to });
  }
  return { meals: kept, aliases: resolved };
}

export function rewriteDuplicateBoards(boards, aliases) {
  const byId = new Map(aliases.map(alias => [alias.from, alias.to]));
  return Object.fromEntries(Object.entries(boards).map(([key, days]) => [key, days.map(groups => {
    const result = groups.map(() => []), seen = new Map();
    groups.forEach((entries, slot) => entries.forEach(entry => {
      const mealId = byId.get(entry.mealId) || entry.mealId, previous = seen.get(mealId);
      if (previous) previous.isMatterCore ||= entry.isMatterCore;
      else { const next = { ...entry, mealId }; seen.set(mealId, next); result[slot].push(next); }
    }));
    return result;
  })]));
}
