const clone = value => JSON.parse(JSON.stringify(value));
const emptyBoard = () => Array.from({ length: 7 }, () => Array.from({ length: 4 }, () => []));
const sourceDays = meal => [...new Set([meal.day, ...(meal.cycleDays || [])].filter(Boolean))];
const dayIndexes = occurrence => [...new Set(sourceDays(occurrence).flatMap(day => day === 'DAY 6 & 7' ? [5, 6] : /^DAY [1-7]$/.test(day) ? [Number(day.slice(4)) - 1] : []))];
const slotFor = meal => meal.mealKind === 'Breakfast' || meal.mealFormat === 'Breakfast' ? 0 : meal.mealKind === 'Snack' || meal.mealFormat === 'Snack' ? 3 : meal.mealKind === 'Main meal' || meal.mealFormat === 'Main' ? 1 : /B'FAST|OATS/.test(meal.category || '') ? 0 : /SNACK/.test(meal.category || '') ? 3 : 1;
const compact = value => String(value || '').trim().toUpperCase().replace(/\s+/g, '');

// Workbook prefixes identify a saved cycle, while a canonical recipe may occur
// in several cycles. Keep those source occurrences separate from deduplication.
export function cycleIdentity(meal, source = '') {
  const metadata = meal.cycleSource || {};
  const originalId = metadata.sourceMealId || meal.importedMealId || meal.id;
  const prefix = String(originalId || '').match(/^(.+)-\d+(?:~.*)?$/)?.[1];
  const id = compact(metadata.cycleId || prefix) || `WORKBOOK:${String(source || metadata.workbook || 'Custom meals').normalize('NFKC').trim().toLowerCase().replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'custom'}`;
  return { id, name: metadata.cycleName || compact(prefix) || source || metadata.workbook || 'Custom meals', source: metadata.workbook || source || '' };
}

const occurrence = (meal, mealId) => {
  const source = meal.cycleSource || {}, sourceMealId = source.sourceMealId || meal.importedMealId || meal.id;
  const fallbackDay = sourceMealId !== meal.id && Number.isInteger(source.day) && source.day >= 1 && source.day <= 7 ? `DAY ${source.day}` : meal.day || '';
  const day = Object.hasOwn(source, 'sourceDay') ? source.sourceDay : fallbackDay;
  const cycleDays = Object.hasOwn(source, 'sourceDays') ? source.sourceDays : meal.cycleDays;
  return { mealId, sourceMealId, day, ...(Array.isArray(cycleDays) && cycleDays.length ? { cycleDays: [...cycleDays] } : {}) };
};
const addSeed = (cycle, item, meal, indexes = dayIndexes(item)) => {
  if (!indexes.length) return;
  const board = cycle.boards['Main menu:Week 1'] ||= emptyBoard();
  for (const day of indexes) if (!board[day].flat().some(entry => entry.mealId === item.mealId)) board[day][slotFor(meal)].push({ mealId: item.mealId, isMatterCore: false });
};
const resolve = (id, aliases) => aliases.get(id) || id;

export function updateMealCycles(current, catalogue, aliases, imported = []) {
  const replacements = new Map(aliases.map(alias => [alias.from, alias.to]));
  const byId = new Map(catalogue.meals.map(meal => [meal.id, meal]));
  const cycles = clone(current.cycles || []);
  const preImportWeeks = new Set();
  const cycleFor = identity => {
    let cycle = cycles.find(value => value.id === identity.id);
    if (!cycle) { cycle = { ...identity, meals: [], boards: {} }; cycles.push(cycle); }
    return cycle;
  };
  const addOccurrence = (cycle, item, meal, seed = true) => {
    const previous = cycle.meals.find(value => value.sourceMealId === item.sourceMealId && value.mealId === item.mealId);
    if (!previous) { cycle.meals.push(item); if (seed) addSeed(cycle, item, meal); return; }
    if (previous.inferredDays) {
      // An alias retained the original ID but not its day. Exact re-upload is
      // authoritative; do not union guesses or alter manually saved placements.
      cycle.meals[cycle.meals.indexOf(previous)] = item;
      if (seed && !preImportWeeks.has(cycle.id)) addSeed(cycle, item, meal);
      return;
    }
    const previousIndexes = dayIndexes(previous), days = [...new Set([...sourceDays(previous), ...sourceDays(item)])];
    if (JSON.stringify(days) !== JSON.stringify(sourceDays(previous))) previous.cycleDays = days;
    if (seed) addSeed(cycle, previous, meal, dayIndexes(previous).filter(day => !previousIndexes.includes(day)));
  };
  if (!current.cycles) {
    for (const meal of current.catalogue.meals) {
      const mealId = resolve(meal.id, replacements), canonical = byId.get(mealId);
      if (!canonical) continue;
      addOccurrence(cycleFor(cycleIdentity(meal, current.catalogue.source)), occurrence(meal, mealId), canonical, false);
    }
    for (const alias of aliases) {
      const canonical = byId.get(alias.to);
      if (!canonical || !/^.+-\d+$/.test(alias.from) || cycles.some(cycle => cycle.meals.some(item => item.sourceMealId === alias.from))) continue;
      // Older deduplication retained the original ID but not its per-cycle day.
      // The canonical recipe's days may belong to another cycle; never guess.
      addOccurrence(cycleFor(cycleIdentity({ id: alias.from }, current.catalogue.source)), { mealId: alias.to, sourceMealId: alias.from, day: '', inferredDays: true }, canonical, false);
    }
    const latest = cycles.find(cycle => cycle.source === current.catalogue.source) || cycles.at(-1);
    for (const cycle of cycles) {
      const ids = new Set(cycle.meals.map(item => item.mealId));
      for (const [key, board] of Object.entries(current.boards || {})) {
        const filtered = board.map(groups => groups.map(entries => entries.map(entry => ({ ...entry, mealId: resolve(entry.mealId, replacements) })).filter(entry => ids.has(entry.mealId))));
        if (filtered.some(groups => groups.some(entries => entries.length)) || cycle === latest) cycle.boards[key] = filtered;
      }
      if (!Object.hasOwn(cycle.boards, 'Main menu:Week 1')) for (const item of cycle.meals) addSeed(cycle, item, byId.get(item.mealId));
    }
  }
  for (const cycle of cycles) {
    cycle.meals = cycle.meals.map(item => ({ ...item, mealId: resolve(item.mealId, replacements) })).filter(item => byId.has(item.mealId));
    if (Object.hasOwn(cycle.boards, 'Main menu:Week 1')) preImportWeeks.add(cycle.id);
  }
  for (const { meal, mealId, source = '' } of imported) {
    const canonical = byId.get(mealId);
    if (!canonical) continue;
    const identity = cycleIdentity(meal, source), cycle = cycleFor(identity);
    if (source) cycle.source = source;
    addOccurrence(cycle, occurrence(meal, mealId), canonical);
  }
  const represented = new Set(cycles.flatMap(cycle => cycle.meals.map(item => item.mealId)));
  for (const meal of catalogue.meals) if (!represented.has(meal.id)) {
    const cycle = cycleFor(cycleIdentity(meal, catalogue.source));
    addOccurrence(cycle, occurrence(meal, meal.id), meal);
  }
  return cycles;
}

// Menus are newest first. A newer saved week wins only within its own cycle;
// another workbook's Week 1 must never erase the older cycle's Week 1.
export function recoverMealCycles(menus, catalogue, validate = value => value) {
  const byId = new Map(catalogue.meals.map(meal => [meal.id, meal])), cycles = new Map();
  for (const menu of menus) {
    const menuBoards = new Map();
    for (const row of menu.meals || []) for (const item of row.items || []) {
      let meal;
      try { meal = validate(item?.cycleMeal); } catch { continue; }
      const canonical = byId.get(meal?.id);
      if (!canonical) continue;
      const identity = cycleIdentity(meal, meal.cycleSource?.workbook || '');
      let cycle = cycles.get(identity.id);
      if (!cycle) { cycle = { ...identity, meals: [], boards: {} }; cycles.set(identity.id, cycle); }
      const original = occurrence(meal, canonical.id);
      if (!cycle.meals.some(value => value.sourceMealId === original.sourceMealId && value.mealId === original.mealId)) cycle.meals.push(original);
      const source = meal.cycleSource;
      if (!['Week 1', 'Week 2'].includes(source?.week) || !Number.isInteger(source.day) || source.day < 1 || source.day > 7) continue;
      const key = `Main menu:${source.week}`, scopedKey = `${identity.id}\0${key}`;
      let board = menuBoards.get(scopedKey);
      if (!board) { board = { cycle, key, days: emptyBoard() }; menuBoards.set(scopedKey, board); }
      const slot = (row.mealType || item.mealType) === 'breakfast' ? 0 : (row.mealType || item.mealType) === 'snack' ? 3 : item.rotationCategory === 'sub' ? 2 : 1;
      const existing = board.days[source.day - 1].flat().find(entry => entry.mealId === canonical.id);
      if (existing) existing.isMatterCore ||= !!item.usedForCorePlan;
      else board.days[source.day - 1][slot].push({ mealId: canonical.id, isMatterCore: !!item.usedForCorePlan });
    }
    for (const { cycle, key, days } of menuBoards.values()) if (!Object.hasOwn(cycle.boards, key)) cycle.boards[key] = days;
  }
  return [...cycles.values()];
}
