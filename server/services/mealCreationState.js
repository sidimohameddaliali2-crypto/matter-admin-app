import { validateCycleMealSnapshot } from './menuComponentSnapshot.js';
import { createHash } from 'node:crypto';
import { deduplicateMeals, mealFingerprint, rewriteDuplicateBoards } from './mealLibraryDuplicates.js';

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
const boardKeys = new Set(['Main menu:Week 1', 'Main menu:Week 2']);
const emptyBoard = () => Array.from({ length: 7 }, () => Array.from({ length: 4 }, () => []));
const checkedMeal = meal => {
  if (meal?.cycleDays !== undefined && (!Array.isArray(meal.cycleDays) || meal.cycleDays.some(day => typeof day !== 'string'))) fail('Source cycle days must be a list of text values.');
  return validateCycleMealSnapshot({ ...meal,
    ...(typeof meal?.carbCombined === 'string' && !meal.carbCombined.trim() ? { carbCombined: 'Not specified' } : {}),
  });
};
// Match the existing mealFormat precedence for legacy workbook categories.
const primarySlot = meal => {
  if (meal.mealKind === 'Main meal') return 1;
  if (meal.mealKind === 'Breakfast') return 0;
  if (meal.mealKind === 'Snack') return 3;
  if (meal.mealFormat === 'Breakfast') return 0;
  if (meal.mealFormat === 'Snack') return 3;
  if (meal.mealFormat === 'Main') return 1;
  return /B'FAST|OATS/.test(meal.category || '') ? 0 : /SNACK/.test(meal.category || '') ? 3 : 1;
};
const compatibleBoards = (boards, meals) => {
  const byId = new Map(meals.map(meal => [meal.id, meal]));
  return Object.fromEntries(Object.entries(boards).map(([key, days]) => [key, days.map(groups => {
    const result = [[], [], [], []];
    groups.forEach((entries, slot) => entries.forEach(entry => {
      const target = primarySlot(byId.get(entry.mealId));
      result[target === 1 && slot === 2 ? 2 : target].push(entry);
    }));
    return result;
  })]));
};

export function checkedCatalogue(value) {
  if (!plain(value) || !Array.isArray(value.meals) || value.source !== undefined && typeof value.source !== 'string') fail('A meal catalogue is required.');
  const ids = new Map(), meals = [];
  value.meals.forEach(meal => {
    const saved = checkedMeal(meal);
    if (ids.has(saved.id)) {
      if (mealFingerprint(ids.get(saved.id)) !== mealFingerprint(saved)) fail('A repeated Meal ID has conflicting recipe details.');
      const canonical = ids.get(saved.id);
      canonical.cycleDays = [...new Set([canonical.day, ...(canonical.cycleDays || []), saved.day, ...(saved.cycleDays || [])].filter(Boolean))];
      return;
    }
    ids.set(saved.id, saved); meals.push(saved);
  });
  return { meals, source: value.source || '' };
}

export function checkedBoards(value, meals, aliases = []) {
  if (!plain(value)) fail('Cycle weeks must be an object.');
  const ids = new Set(meals.map(meal => meal.id));
  const replacements = new Map(aliases.map(alias => [alias.from, alias.to]));
  const boards = {};
  for (const [key, days] of Object.entries(value)) {
    if (!boardKeys.has(key) || !Array.isArray(days) || days.length !== 7) fail('Each cycle week must contain seven days.');
    boards[key] = days.map(groups => {
      if (!Array.isArray(groups) || groups.length !== 4) fail('Each cycle day must have four meal sections.');
      return groups.map(entries => {
        if (!Array.isArray(entries)) fail('Cycle assignments must be lists.');
        return entries.map(entry => {
          const mealId = replacements.get(entry?.mealId) || entry?.mealId;
          if (!plain(entry) || !ids.has(mealId) || typeof entry.isMatterCore !== 'boolean') fail('A cycle assignment refers to an unknown meal or invalid Matter Core flag.');
          return { mealId, isMatterCore: entry.isMatterCore };
        });
      });
    });
  }
  return boards;
}

export function changeMealCreationState(current, change, missingOnly = false) {
  if (!plain(change)) fail('A library change is required.');
  if (change.skipDuplicates !== undefined && typeof change.skipDuplicates !== 'boolean') fail('The duplicate handling option must be true or false.');
  const catalogue = clone(current.catalogue), boards = clone(current.boards);
  const initial = deduplicateMeals(catalogue.meals, current.aliases || []);
  catalogue.meals = initial.meals;
  let aliases = initial.aliases;
  if (change.catalogue !== undefined) {
    const incoming = checkedCatalogue(change.catalogue);
    const byId = new Map(catalogue.meals.map(meal => [meal.id, meal]));
    const fingerprints = new Map(catalogue.meals.map(meal => [mealFingerprint(meal), meal.id]));
    for (const meal of incoming.meals) {
      const canonicalId = fingerprints.get(mealFingerprint(meal));
      if ((change.skipDuplicates || missingOnly) && canonicalId) {
        if (!byId.has(meal.id) && meal.id !== canonicalId) aliases.push({ from: meal.id, to: canonicalId });
        const canonical = byId.get(canonicalId);
        const cycleDays = [...new Set([canonical.day, ...(canonical.cycleDays || []), meal.day, ...(meal.cycleDays || [])].filter(Boolean))];
        const previousDays = [...new Set([canonical.day, ...(canonical.cycleDays || [])].filter(Boolean))];
        if (JSON.stringify(cycleDays) !== JSON.stringify(previousDays)) byId.set(canonicalId, { ...canonical, cycleDays });
        continue;
      }
      if (!missingOnly || !byId.has(meal.id)) {
        // An import reusing an ID for a different recipe must not replace the
        // existing dietary variant. Ordinary editor saves still update by ID.
        if (change.skipDuplicates && byId.has(meal.id)) {
          const importedMealId = meal.id, base = `${meal.id}~${createHash('sha256').update(mealFingerprint(meal)).digest('hex').slice(0,12)}`;
          let id = base, suffix = 2; while (byId.has(id)) id = `${base}-${suffix++}`;
          const variant = { ...meal, id, importedMealId };
          byId.set(id, variant); fingerprints.set(mealFingerprint(variant), id); continue;
        }
        const previous = byId.get(meal.id);
        if (previous && fingerprints.get(mealFingerprint(previous)) === meal.id) fingerprints.delete(mealFingerprint(previous));
        byId.set(meal.id, meal);
        if (!fingerprints.has(mealFingerprint(meal))) fingerprints.set(mealFingerprint(meal), meal.id);
      }
    }
    catalogue.meals = [...byId.values()];
    if (incoming.source && (!missingOnly || !catalogue.source)) catalogue.source = incoming.source;
  }
  const unique = deduplicateMeals(catalogue.meals, aliases); catalogue.meals = unique.meals; aliases = unique.aliases;
  if (change.boards !== undefined) for (const [key, value] of Object.entries(checkedBoards(change.boards, catalogue.meals, aliases))) {
    if (!missingOnly || !Object.hasOwn(boards, key)) boards[key] = value;
  }
  const state = { catalogue, boards: compatibleBoards(rewriteDuplicateBoards(boards, aliases), catalogue.meals), aliases };
  // Stay below MongoDB's document limit and return a useful error before writing.
  if (Buffer.byteLength(JSON.stringify(state)) > 8 * 1024 * 1024) fail('The meal library is too large to save. No data was changed.', 413);
  return state;
}

// Called on initial server-library creation only. Saved menus and their items
// are read, never changed. Newest menu snapshots win among historical copies.
export function recoverMealCreationState(menus) {
  const byId = new Map(), boards = {};
  let skippedSnapshots = 0;
  for (const menu of menus) {
    const menuBoards = {};
    for (const row of menu.meals || []) for (const item of row.items || []) {
      if (!item?.cycleMeal) continue;
      let meal;
      try { meal = checkedMeal(item.cycleMeal); }
      catch { skippedSnapshots++; continue; }
      if (!byId.has(meal.id)) byId.set(meal.id, meal);
      const source = meal.cycleSource;
      if (!['Week 1', 'Week 2'].includes(source?.week) || !Number.isInteger(source.day) || source.day < 1 || source.day > 7) continue;
      const key = `Main menu:${source.week}`;
      const board = menuBoards[key] ||= emptyBoard();
      const slot = (row.mealType || item.mealType) === 'breakfast' ? 0 : (row.mealType || item.mealType) === 'snack' ? 3 : item.rotationCategory === 'sub' ? 2 : 1;
      const existing = board[source.day - 1].flat().find(entry => entry.mealId === meal.id);
      if (existing) existing.isMatterCore ||= !!item.usedForCorePlan;
      else board[source.day - 1][slot].push({ mealId: meal.id, isMatterCore: !!item.usedForCorePlan });
    }
    for (const [key, board] of Object.entries(menuBoards)) if (!Object.hasOwn(boards, key)) boards[key] = board;
  }
  const catalogue = { meals: [...byId.values()], source: byId.size ? 'Recovered from saved menus' : '' };
  return { catalogue, boards: compatibleBoards(boards, catalogue.meals), recovery: { meals: byId.size, weeks: Object.keys(boards).length, skippedSnapshots } };
}

// Old per-tab drafts are a one-way, additive migration. An old browser must
// never replace a newer database recipe or reset an intentionally empty week.
export function mergeLegacyDraft(current, legacy, missingOnly = true) {
  if (!legacy) return changeMealCreationState(current, {});
  const merged = changeMealCreationState(current, { catalogue: legacy.catalogue }, missingOnly);
  const boards = {};
  for (const [key, days] of Object.entries(legacy.boards || {})) {
    if (!boardKeys.has(key) || missingOnly && Object.hasOwn(merged.boards, key)) continue;
    // Keep the original browser draft available if it has unrecoverable IDs.
    try { Object.assign(boards, checkedBoards({ [key]: days }, merged.catalogue.meals, merged.aliases)); }
    catch { continue; }
  }
  return { ...merged, boards: compatibleBoards(rewriteDuplicateBoards({ ...merged.boards, ...boards }, merged.aliases), merged.catalogue.meals) };
}
