import { validateCycleMealSnapshot } from './menuComponentSnapshot.js';

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
const boardKeys = new Set(['Main menu:Week 1', 'Main menu:Week 2']);
const emptyBoard = () => Array.from({ length: 7 }, () => Array.from({ length: 4 }, () => []));
const checkedMeal = meal => validateCycleMealSnapshot({ ...meal,
  ...(typeof meal?.carbCombined === 'string' && !meal.carbCombined.trim() ? { carbCombined: 'Not specified' } : {}),
});
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
  const ids = new Set();
  const meals = value.meals.map(meal => {
    const saved = checkedMeal(meal);
    if (ids.has(saved.id)) fail('Meal IDs must be unique.');
    ids.add(saved.id);
    return saved;
  });
  return { meals, source: value.source || '' };
}

export function checkedBoards(value, meals) {
  if (!plain(value)) fail('Cycle weeks must be an object.');
  const ids = new Set(meals.map(meal => meal.id));
  const boards = {};
  for (const [key, days] of Object.entries(value)) {
    if (!boardKeys.has(key) || !Array.isArray(days) || days.length !== 7) fail('Each cycle week must contain seven days.');
    boards[key] = days.map(groups => {
      if (!Array.isArray(groups) || groups.length !== 4) fail('Each cycle day must have four meal sections.');
      return groups.map(entries => {
        if (!Array.isArray(entries)) fail('Cycle assignments must be lists.');
        return entries.map(entry => {
          if (!plain(entry) || !ids.has(entry.mealId) || typeof entry.isMatterCore !== 'boolean') fail('A cycle assignment refers to an unknown meal or invalid Matter Core flag.');
          return { mealId: entry.mealId, isMatterCore: entry.isMatterCore };
        });
      });
    });
  }
  return boards;
}

export function changeMealCreationState(current, change, missingOnly = false) {
  if (!plain(change)) fail('A library change is required.');
  const catalogue = clone(current.catalogue), boards = clone(current.boards);
  if (change.catalogue !== undefined) {
    const incoming = checkedCatalogue(change.catalogue);
    const byId = new Map(catalogue.meals.map(meal => [meal.id, meal]));
    for (const meal of incoming.meals) if (!missingOnly || !byId.has(meal.id)) byId.set(meal.id, meal);
    catalogue.meals = [...byId.values()];
    if (incoming.source && (!missingOnly || !catalogue.source)) catalogue.source = incoming.source;
  }
  if (change.boards !== undefined) for (const [key, value] of Object.entries(checkedBoards(change.boards, catalogue.meals))) {
    if (!missingOnly || !Object.hasOwn(boards, key)) boards[key] = value;
  }
  const state = { catalogue, boards: compatibleBoards(boards, catalogue.meals) };
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
  if (!legacy) return { catalogue: current.catalogue, boards: current.boards };
  const merged = changeMealCreationState(current, { catalogue: legacy.catalogue }, missingOnly);
  const boards = {};
  for (const [key, days] of Object.entries(legacy.boards || {})) {
    if (!boardKeys.has(key) || missingOnly && Object.hasOwn(merged.boards, key)) continue;
    // Keep the original browser draft available if it has unrecoverable IDs.
    try { Object.assign(boards, checkedBoards({ [key]: days }, merged.catalogue.meals)); }
    catch { continue; }
  }
  return { ...merged, boards: compatibleBoards({ ...merged.boards, ...boards }, merged.catalogue.meals) };
}
