import { validKitchenQuantityRule, validateCycleMealSnapshot } from './menuComponentSnapshot.js';
import { createHash } from 'node:crypto';
import { deduplicateMeals, libraryMealKind, mealFingerprint, rewriteDuplicateBoards } from './mealLibraryDuplicates.js';
import { updateMealCycles, recoverMealCycles, cycleIdentity, dayIndexes } from './mealCreationCycles.js';

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
const boardKeys = new Set(['Main menu:Week 1', 'Main menu:Week 2']);
const emptyBoard = () => Array.from({ length: 7 }, () => Array.from({ length: 4 }, () => []));
const recipeSignature = fingerprint => createHash('sha256').update(fingerprint).digest('hex');
const workbookDayRows = (meal, splitWeekend) => {
  const sourceDays = [meal.cycleSource?.sourceDay || meal.day, ...(meal.cycleSource?.sourceDays || meal.cycleDays || [])].filter(Boolean);
  const days = [...new Set(sourceDays.flatMap(day => splitWeekend && day === 'DAY 6 & 7' ? ['DAY 6', 'DAY 7'] : [day]))];
  if (days.length < 2) return [meal];
  return days.map(day => ({
    ...meal, day, cycleDays: undefined,
    ...(meal.cycleSource ? { cycleSource: { ...meal.cycleSource, sourceDay: day, sourceDays: undefined } } : {}),
  }));
};
const checkedMeal = (meal, options) => {
  if (meal?.cycleDays !== undefined && (!Array.isArray(meal.cycleDays) || meal.cycleDays.some(day => typeof day !== 'string'))) fail('Source cycle days must be a list of text values.');
  return validateCycleMealSnapshot({ ...meal,
    ...(typeof meal?.carbCombined === 'string' && !meal.carbCombined.trim() ? { carbCombined: 'Not specified' } : {}),
  }, options);
};
const recoveredMeal = (meal, datedMealType) => checkedMeal(meal, { legacyQuantity: 'repair', datedMealType });
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

export function checkedCatalogue(value, { legacyQuantity, storedMeals } = {}) {
  if (!plain(value) || !Array.isArray(value.meals) || value.source !== undefined && typeof value.source !== 'string') fail('A meal catalogue is required.');
  const ids = new Map(), meals = [];
  value.meals.forEach(meal => {
    const previous = storedMeals?.get(meal?.id);
    const unchangedRule = previous && Object.is(previous.qtyUnit, meal.qtyUnit) && Object.is(previous.gramsPerPiece, meal.gramsPerPiece)
      && libraryMealKind(previous) === libraryMealKind(meal);
    const saved = checkedMeal(meal, { legacyQuantity: unchangedRule ? 'preserve' : legacyQuantity });
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

export function checkedBoards(value, meals, aliases = [], legacyOccurrenceIds) {
  if (!plain(value)) fail('Cycle weeks must be an object.');
  const ids = new Set(meals.map(meal => meal.id));
  const replacements = new Map(aliases.map(alias => [alias.from, alias.to]));
  const boards = {};
  for (const [key, days] of Object.entries(value)) {
    if (!boardKeys.has(key) || !Array.isArray(days) || days.length !== 7) fail('Each cycle week must contain seven days.');
    boards[key] = days.map((groups, dayIndex) => {
      if (!Array.isArray(groups) || groups.length !== 4) fail('Each cycle day must have four meal sections.');
      return groups.map(entries => {
        if (!Array.isArray(entries)) fail('Cycle assignments must be lists.');
        return entries.map(entry => {
          const variants = legacyOccurrenceIds?.get(entry?.mealId);
          const dayVariants = variants?.byDay.get(dayIndex);
          const candidates = dayVariants?.size ? dayVariants : variants?.all;
          const legacyId = candidates?.size === 1 ? candidates.values().next().value : undefined;
          const mealId = legacyId || replacements.get(entry?.mealId) || entry?.mealId;
          if (!plain(entry) || !ids.has(mealId) || typeof entry.isMatterCore !== 'boolean') fail('A cycle assignment refers to an unknown meal or invalid Matter Core flag.');
          return { mealId, isMatterCore: entry.isMatterCore };
        });
      });
    });
  }
  return boards;
}

export function changeMealCreationState(current, change, missingOnly = false, { legacyOccurrenceIds } = {}) {
  if (!plain(change)) fail('A library change is required.');
  if (change.skipDuplicates !== undefined && typeof change.skipDuplicates !== 'boolean') fail('The duplicate handling option must be true or false.');
  const catalogue = clone(current.catalogue), boards = clone(current.boards);
  const imported = [];
  const previousRecipeSignatures = new Map();
  const matchLegacyCopies = Boolean(legacyOccurrenceIds);
  const initial = deduplicateMeals(catalogue.meals, current.aliases || []);
  catalogue.meals = initial.meals;
  let aliases = initial.aliases;
  if (change.catalogue !== undefined) {
    const byId = new Map(catalogue.meals.map(meal => [meal.id, meal]));
    const incoming = checkedCatalogue(change.catalogue, legacyOccurrenceIds ? { legacyQuantity: 'discard' }
      : !change.skipDuplicates && !missingOnly ? { storedMeals: byId } : undefined);
    const aliasIds = new Map(aliases.map(({ from, to }) => [from, to]));
    const fingerprints = new Map(catalogue.meals.map(meal => [mealFingerprint(meal), meal.id]));
    const cyclesById = new Map((current.cycles || []).map(cycle => [cycle.id, cycle]));
    const recipeMatches = new Map();
    const matchWorkbookRecipes = (change.skipDuplicates && !missingOnly || matchLegacyCopies)
      && incoming.meals.some(meal => meal.qtyUnit === undefined && !meal.preserveLibraryId);
    const indexRecipe = meal => {
      const recipe = mealFingerprint(meal, { ignoreQuantity: true });
      if (!recipeMatches.has(recipe)) recipeMatches.set(recipe, new Set());
      recipeMatches.get(recipe).add(meal.id);
    };
    if (matchWorkbookRecipes) catalogue.meals.forEach(indexRecipe);
    const matchDays = change.skipDuplicates && !missingOnly || matchLegacyCopies;
    const incomingRows = matchDays ? incoming.meals.flatMap(meal => {
      const cycle = cyclesById.get(cycleIdentity(meal, incoming.source).id);
      const sourceId = meal.cycleSource?.sourceMealId || meal.id;
      const variants = new Set((cycle?.meals || []).filter(item => item.sourceMealId === sourceId).map(item => item.mealId));
      return workbookDayRows(meal, variants.size > 1);
    }) : incoming.meals;
    for (const meal of incomingRows) {
      // Bootstrap is additive. A stale browser draft cannot reclaim a saved
      // alias or redirect an existing recipe ID to a different recipe.
      const existingId = missingOnly ? (byId.has(meal.id) ? meal.id : aliasIds.get(meal.id)) : undefined;
      const exactFingerprint = mealFingerprint(meal);
      const exactRecipeId = meal.preserveLibraryId ? undefined : fingerprints.get(exactFingerprint);
      let canonicalId = existingId || exactRecipeId;
      let reuseLegacyRecipe = false;
      if (matchWorkbookRecipes && meal.qtyUnit === undefined && !meal.preserveLibraryId) {
        const recipe = mealFingerprint(meal, { ignoreQuantity: true });
        const matches = recipeMatches.get(recipe) || new Set();
        const original = byId.get(meal.id) || byId.get(aliasIds.get(meal.id));
        const cycle = cyclesById.get(cycleIdentity(meal, incoming.source).id);
        const sourceId = meal.cycleSource?.sourceMealId || meal.id;
        const signature = recipeSignature(recipe);
        const matchesSource = item => item.recipeSignatures?.includes(signature) || item.inferredRecipeSignature === signature;
        const occurrences = (cycle?.meals || []).filter(item => item.sourceMealId === sourceId && (matches.has(item.mealId)
          || (byId.has(item.mealId) && matchesSource(item))));
        const sourceDay = meal.cycleSource?.sourceDay || meal.day;
        const incomingDays = dayIndexes({ day: sourceDay });
        const exactDay = occurrences.filter(item => item.day === sourceDay || item.cycleDays?.includes(sourceDay)
          || dayIndexes(item).some(day => incomingDays.includes(day)));
        const placements = exactDay.length ? exactDay : occurrences.filter(item => item.inferredDays);
        const compatiblePlacements = placements.filter(item =>
          (!item.recipeSignatures?.length && !item.inferredRecipeSignature) || matchesSource(item));
        const placedIds = [...new Set(compatiblePlacements.map(item => item.mealId))];
        const weekendDay = incomingDays.length === 1 && incomingDays[0] >= 5 ? incomingDays[0] : null;
        const weekendBoardIds = weekendDay !== null && placedIds.length > 1 && exactDay.some(item => dayIndexes(item).length > 1)
          ? new Set((cycle.boards?.['Main menu:Week 1']?.[weekendDay] || []).flat().map(entry => entry.mealId))
          : new Set();
        const datedWeekendIds = placedIds.filter(id => weekendBoardIds.has(id));
        const originalSourceIds = [...new Set(occurrences.filter(item => item.recipeSignatures?.includes(signature)).map(item => item.mealId))];
        const inferredSourceIds = [...new Set(occurrences.filter(item => item.inferredRecipeSignature === signature).map(item => item.mealId))];
        const sourceIds = [...matches].filter(id => byId.get(id).importedMealId === sourceId);
        const exactSourceIds = sourceIds.filter(id => mealFingerprint(byId.get(id)) === exactFingerprint);
        if (exactDay.length && placedIds.length === 1) canonicalId = placedIds[0];
        else if (datedWeekendIds.length === 1) canonicalId = datedWeekendIds[0];
        else if (originalSourceIds.length === 1) canonicalId = originalSourceIds[0];
        else if (placedIds.length === 1) canonicalId = placedIds[0];
        else if (inferredSourceIds.length === 1) canonicalId = inferredSourceIds[0];
        else if (exactSourceIds.length === 1) canonicalId = exactSourceIds[0];
        else if (matches.has(original?.id)) canonicalId = original.id;
        else if (sourceIds.length === 1) canonicalId = sourceIds[0];
        else if (matchLegacyCopies && !existingId && exactRecipeId) canonicalId = exactRecipeId;
        else if (!existingId && (!canonicalId || matchLegacyCopies) && matches.size === 1) canonicalId = matches.values().next().value;
        reuseLegacyRecipe = Boolean(canonicalId && canonicalId !== meal.id
          && (sourceIds.includes(canonicalId) || occurrences.some(item => item.mealId === canonicalId)
            || (!byId.has(meal.id) && !aliasIds.has(meal.id) && matches.size === 1 && matches.has(canonicalId))));
      }
      if ((change.skipDuplicates || missingOnly || (matchLegacyCopies && reuseLegacyRecipe)) && canonicalId) {
        imported.push({ meal, mealId: canonicalId, source: incoming.source });
        if (!byId.has(meal.id) && !aliasIds.has(meal.id) && meal.id !== canonicalId) {
          aliases.push({ from: meal.id, to: canonicalId });
          aliasIds.set(meal.id, canonicalId);
        }
        const canonical = byId.get(canonicalId);
        const cycleDays = [...new Set([canonical.day, ...(canonical.cycleDays || []), meal.day, ...(meal.cycleDays || [])].filter(Boolean))];
        const previousDays = [...new Set([canonical.day, ...(canonical.cycleDays || [])].filter(Boolean))];
        if (JSON.stringify(cycleDays) !== JSON.stringify(previousDays)) byId.set(canonicalId, { ...canonical, cycleDays });
        continue;
      }
      if (!missingOnly || !byId.has(meal.id)) {
        // An import reusing an ID for a different recipe must not replace the
        // existing dietary variant. Ordinary editor saves still update by ID.
        if (change.skipDuplicates && (byId.has(meal.id) || aliasIds.has(meal.id))) {
          const importedMealId = meal.id, base = `${meal.id}~${createHash('sha256').update(mealFingerprint(meal)).digest('hex').slice(0,12)}`;
          let id = base, suffix = 2; while (byId.has(id) || aliasIds.has(id)) id = `${base}-${suffix++}`;
          const variant = { ...meal, id, importedMealId };
          byId.set(id, variant); fingerprints.set(mealFingerprint(variant), id);
          if (matchWorkbookRecipes) indexRecipe(variant);
          imported.push({ meal, mealId: id, source: incoming.source }); continue;
        }
        const previous = byId.get(meal.id);
        const keepRecoveredQuantity = legacyOccurrenceIds && previous && meal.qtyUnit === undefined && meal.gramsPerPiece == null
          && validKitchenQuantityRule(previous, libraryMealKind(meal) === 'Main');
        const savedMeal = keepRecoveredQuantity ? { ...meal, qtyUnit: previous.qtyUnit, gramsPerPiece: previous.gramsPerPiece ?? null } : meal;
        if (previous && fingerprints.get(mealFingerprint(previous)) === meal.id) fingerprints.delete(mealFingerprint(previous));
        // A quantity edit can make two existing dated recipe links identical.
        // Keep the edited link independent through later saves and bootstraps.
        const quantityChanged = previous && !change.skipDuplicates && !missingOnly
          && (previous.qtyUnit !== savedMeal.qtyUnit || previous.gramsPerPiece !== savedMeal.gramsPerPiece);
        if (previous && !change.skipDuplicates && !missingOnly) {
          const oldRecipe = mealFingerprint(previous, { ignoreQuantity: true });
          if (oldRecipe !== mealFingerprint(meal, { ignoreQuantity: true })) previousRecipeSignatures.set(meal.id, recipeSignature(oldRecipe));
        }
        byId.set(meal.id, quantityChanged || previous?.preserveLibraryId ? { ...savedMeal, preserveLibraryId: true } : savedMeal);
        if (matchWorkbookRecipes) indexRecipe(savedMeal);
        if (!fingerprints.has(mealFingerprint(savedMeal))) fingerprints.set(mealFingerprint(savedMeal), meal.id);
      }
      if (change.skipDuplicates || missingOnly || incoming.source) imported.push({ meal, mealId: meal.id, source: incoming.source });
    }
    catalogue.meals = [...byId.values()];
    if (incoming.source && (!missingOnly || !catalogue.source)) catalogue.source = incoming.source;
  }
  const unique = deduplicateMeals(catalogue.meals, aliases); catalogue.meals = unique.meals; aliases = unique.aliases;
  const replacements = new Map(aliases.map(alias => [alias.from, alias.to]));
  const occurrences = imported.map(value => ({ ...value, mealId: replacements.get(value.mealId) || value.mealId,
    ...(change.skipDuplicates && !missingOnly ? { recipeSignature: recipeSignature(mealFingerprint(value.meal, { ignoreQuantity: true })) } : {}),
  }));
  if (legacyOccurrenceIds) for (const { meal, mealId } of occurrences) {
    if (!legacyOccurrenceIds.has(meal.id)) legacyOccurrenceIds.set(meal.id, { all: new Set(), byDay: new Map() });
    const variants = legacyOccurrenceIds.get(meal.id);
    variants.all.add(mealId);
    for (const day of dayIndexes({ day: meal.cycleSource?.sourceDay || meal.day, cycleDays: meal.cycleSource?.sourceDays || meal.cycleDays })) {
      if (!variants.byDay.has(day)) variants.byDay.set(day, new Set());
      variants.byDay.get(day).add(mealId);
    }
  }
  const cycles = updateMealCycles(current, catalogue, aliases, occurrences, previousRecipeSignatures);
  if (change.cycleId !== undefined && (typeof change.cycleId !== 'string' || !cycles.some(cycle => cycle.id === change.cycleId))) fail('Choose a saved cycle before updating its week.');
  if (change.boards !== undefined) {
    const target = change.cycleId ? cycles.find(cycle => cycle.id === change.cycleId).boards : boards;
    for (const [key, value] of Object.entries(checkedBoards(change.boards, catalogue.meals, aliases))) {
      if (!missingOnly || !Object.hasOwn(target, key)) target[key] = value;
    }
    if (change.cycleId) {
      const cycle = cycles.find(value => value.id === change.cycleId);
      for (const mealId of new Set(Object.values(cycle.boards).flat(3).map(entry => entry.mealId))) {
        if (!cycle.meals.some(item => item.mealId === mealId)) cycle.meals.push({ mealId, sourceMealId: mealId, day: '' });
      }
    }
  }
  for (const cycle of cycles) cycle.boards = compatibleBoards(rewriteDuplicateBoards(cycle.boards, aliases), catalogue.meals);
  const state = { catalogue, boards: compatibleBoards(rewriteDuplicateBoards(boards, aliases), catalogue.meals), aliases, cycles };
  // Stay below MongoDB's document limit and return a useful error before writing.
  if (Buffer.byteLength(JSON.stringify(state)) > 8 * 1024 * 1024) fail('The meal library is too large to save. No data was changed.', 413);
  return state;
}

// Used for initial creation and repair of older shared documents. Saved menus
// and their items are read, never changed. Newest historical snapshots win.
export function recoverMealCreationState(menus) {
  const byId = new Map(), boards = {};
  let skippedSnapshots = 0;
  for (const menu of menus) {
    const menuBoards = {};
    for (const row of menu.meals || []) for (const item of row.items || []) {
      if (!item?.cycleMeal) continue;
      let meal;
      try { meal = recoveredMeal(item.cycleMeal, item.mealType || row.mealType); }
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
  const signatureFor = meal => recipeSignature(mealFingerprint(meal, { ignoreQuantity: true }));
  const cycles = recoverMealCycles(menus, catalogue, recoveredMeal, signatureFor).map(cycle => ({ ...cycle, boards: compatibleBoards(cycle.boards, catalogue.meals) }));
  return { catalogue, boards: compatibleBoards(boards, catalogue.meals), cycles, recovery: { meals: byId.size, weeks: Object.keys(boards).length, skippedSnapshots } };
}

// A one-time migration/repair for older shared documents. Newer recipes and
// existing (including deliberately empty) weeks always win over saved copies.
export function repairMealCreationState(current, recovered) {
  const baseline = changeMealCreationState(current, {});
  const repaired = changeMealCreationState(current, { catalogue: recovered.catalogue, boards: recovered.boards }, true);
  const mapped = new Map(repaired.aliases.map(alias => [alias.from, alias.to]));
  repaired.aliases = deduplicateMeals(repaired.catalogue.meals, [
    ...(recovered.aliases || []).map(alias => ({ from: alias.from, to: mapped.get(alias.to) || alias.to })),
    ...repaired.aliases,
  ]).aliases;
  const replacements = new Map(repaired.aliases.map(alias => [alias.from, alias.to]));
  const latestLegacy = baseline.cycles.find(cycle => cycle.source === current.catalogue.source) || baseline.cycles.at(-1);
  const storedWeek = (cycle, key) => {
    if (current.cycles !== undefined) return Object.hasOwn(current.cycles.find(value => value.id === cycle.id)?.boards || {}, key);
    if (!Object.hasOwn(current.boards, key)) return false;
    const ids = new Set(cycle.meals.map(item => item.mealId));
    return cycle.id === latestLegacy?.id || current.boards[key].flat(2).some(entry => ids.has(replacements.get(entry.mealId) || entry.mealId));
  };
  for (const source of recovered.cycles) {
    let target = repaired.cycles.find(cycle => cycle.id === source.id);
    if (!target) { target = { ...clone(source), meals: [], boards: {} }; repaired.cycles.push(target); }
    const existing = baseline.cycles.find(cycle => cycle.id === source.id);
    if (!existing) target.boards = {};
    for (const item of source.meals) {
      const mapped = { ...item, mealId: replacements.get(item.mealId) || item.mealId };
      const index = target.meals.findIndex(value => value.mealId === mapped.mealId && value.sourceMealId === mapped.sourceMealId);
      if (index < 0) target.meals.push(mapped);
      else {
        const saved = target.meals[index];
        const recipeSignatures = [...new Set([...(saved.recipeSignatures || []), ...(mapped.recipeSignatures || [])])];
        if (current.cycles === undefined && !current.catalogue.meals.some(meal => meal.id === mapped.sourceMealId || meal.importedMealId === mapped.sourceMealId)) {
          // An intact occurrence supersedes source days inferred from old aliases.
          target.meals[index] = mapped;
        }
        if (recipeSignatures.length) target.meals[index].recipeSignatures = recipeSignatures;
      }
    }
    for (const [key, board] of Object.entries(source.boards)) if (!existing || !storedWeek(existing, key)) {
      target.boards[key] = compatibleBoards(checkedBoards({ [key]: board }, repaired.catalogue.meals, repaired.aliases), repaired.catalogue.meals)[key];
    }
  }
  if (Buffer.byteLength(JSON.stringify(repaired)) > 8 * 1024 * 1024) fail('The meal library is too large to save. No data was changed.', 413);
  return repaired;
}

// Old per-tab drafts are a one-way, additive migration. An old browser must
// never replace a newer database recipe or reset an intentionally empty week.
export function mergeLegacyDraft(current, legacy, missingOnly = true) {
  if (!legacy) return changeMealCreationState(current, {});
  const existingCycles = updateMealCycles(current, current.catalogue, current.aliases || []);
  const legacyOccurrenceIds = new Map();
  const merged = changeMealCreationState(current, { catalogue: legacy.catalogue }, missingOnly, { legacyOccurrenceIds });
  const boards = {};
  for (const [key, days] of Object.entries(legacy.boards || {})) {
    // Global week keys belong to the old combined planner. A matching key
    // there says nothing about whether this browser's cycle has been saved.
    if (!boardKeys.has(key)) continue;
    // Keep the original browser draft available if it has unrecoverable IDs.
    try { Object.assign(boards, checkedBoards({ [key]: days }, merged.catalogue.meals, merged.aliases, legacyOccurrenceIds)); }
    catch { continue; }
  }
  const sourceCycles = new Set(legacy.catalogue.meals.map(meal => cycleIdentity(meal, legacy.catalogue.source).id));
  const sourceCycleByMealId = new Map(legacy.catalogue.meals.map(meal => [meal.id, cycleIdentity(meal, legacy.catalogue.source).id]));
  const hasSavedWeek = (cycle, key) => {
    if (current.cycles !== undefined) return Object.hasOwn(current.cycles.find(saved => saved.id === cycle.id)?.boards || {}, key);
    if (!Object.hasOwn(current.boards, key)) return false;
    const entries = current.boards[key].flat(2);
    // An empty legacy combined board was explicitly cleared. Otherwise only
    // original IDs in that cycle establish ownership, not generated seeds.
    return !entries.length || entries.some(entry => cycle.meals.some(item => item.sourceMealId === entry.mealId));
  };
  for (const cycle of merged.cycles) {
    if (!sourceCycles.has(cycle.id)) continue;
    for (const [key, days] of Object.entries(boards)) {
      const existing = existingCycles.find(saved => saved.id === cycle.id);
      if (missingOnly && existing && hasSavedWeek(existing, key)) continue;
      // Partition before alias resolution: a recipe shared by two workbooks
      // does not make their unpublished scheduling choices interchangeable.
      const filtered = sourceCycles.size === 1 ? days : checkedBoards({ [key]: legacy.boards[key].map(groups => groups.map(entries => entries.filter(entry => sourceCycleByMealId.get(entry.mealId) === cycle.id))) }, merged.catalogue.meals, merged.aliases, legacyOccurrenceIds)[key];
      cycle.boards[key] = compatibleBoards({ [key]: filtered }, merged.catalogue.meals)[key];
    }
  }
  const missingGlobalBoards = Object.fromEntries(Object.entries(boards).filter(([key]) => !missingOnly || !Object.hasOwn(merged.boards, key)));
  return { ...merged, boards: compatibleBoards(rewriteDuplicateBoards({ ...merged.boards, ...missingGlobalBoards }, merged.aliases), merged.catalogue.meals) };
}
