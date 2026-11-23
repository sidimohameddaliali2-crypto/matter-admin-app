import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkedBoards, changeMealCreationState, recoverMealCreationState, repairMealCreationState, mergeLegacyDraft } from './mealCreationState.js';

const meal = (id, name = id) => ({ id, name, mealKind: 'Main meal', mealType: 'Chicken', carbCombined: 'No', components: [{ id: `${id}-p`, type: 'Protein', name: 'Roast', exclusions: ['Nuts'], notes: 'Keep preparation notes' }] });
const board = () => Array.from({ length: 7 }, () => Array.from({ length: 4 }, () => []));
const initial = () => ({ catalogue: { meals: [meal('one')], source: 'Original.xlsx' }, boards: { 'Main menu:Week 1': board() } });

test('reimporting an unchanged workbook keeps its meal ID, saved QTY and single cycle placement', () => {
  const original = { ...meal('one'), day: 'DAY 1', category: 'MAIN CHX' };
  const workbook = { catalogue: { meals: [original], source: 'Original.xlsx' }, skipDuplicates: true };
  const first = changeMealCreationState(initial(), workbook);
  for (const settings of [{ qtyUnit: 'KG', gramsPerPiece: null }, { qtyUnit: 'PCS', gramsPerPiece: 65.1 }]) {
    const edited = changeMealCreationState(first, { catalogue: { meals: [{ ...original, ...settings }] } });
    const reimported = changeMealCreationState(edited, workbook);
    assert.deepEqual(reimported.catalogue.meals, edited.catalogue.meals);
    assert.deepEqual(reimported.cycles, edited.cycles);
  }
});

test('a same-ID workbook variant keeps its own quantity setting when a separate recipe copy exists', () => {
  const variant = { ...meal('one', 'Imported salad'), day: 'DAY 1' };
  const workbook = { catalogue: { meals: [variant], source: 'Salad.xlsx' }, skipDuplicates: true };
  const imported = changeMealCreationState(initial(), workbook);
  const savedVariant = imported.catalogue.meals.find(candidate => candidate.importedMealId === 'one');
  const edited = changeMealCreationState(imported, { catalogue: { meals: [
    { ...savedVariant, qtyUnit: 'PCS', gramsPerPiece: 50 }, { ...variant, id: 'kg-copy' },
  ] } });
  const reimported = changeMealCreationState(edited, workbook);
  assert.deepEqual(reimported.catalogue.meals, edited.catalogue.meals);
  assert.deepEqual(reimported.cycles, edited.cycles);
  const matchingOriginal = changeMealCreationState(reimported, { catalogue: { meals: [
    { ...variant, qtyUnit: 'KG', gramsPerPiece: null },
  ] } });
  assert.deepEqual(changeMealCreationState(matchingOriginal, workbook).cycles, matchingOriginal.cycles);
  const newDay = changeMealCreationState(matchingOriginal, { ...workbook, catalogue: {
    ...workbook.catalogue, meals: [{ ...variant, day: 'DAY 3' }],
  } });
  const cycle = newDay.cycles.find(item => item.source === 'Salad.xlsx');
  assert.deepEqual(cycle.boards['Main menu:Week 1'][2][1], [{ mealId: savedVariant.id, isMatterCore: false }]);
  const legacy = structuredClone(matchingOriginal);
  for (const savedCycle of legacy.cycles) for (const occurrence of savedCycle.meals) delete occurrence.recipeSignatures;
  const legacyNewDay = changeMealCreationState(legacy, { ...workbook, catalogue: {
    ...workbook.catalogue, meals: [{ ...variant, day: 'DAY 3' }],
  } });
  assert.deepEqual(legacyNewDay.cycles.find(item => item.source === 'Salad.xlsx').boards['Main menu:Week 1'][2][1],
    [{ mealId: 'one', isMatterCore: false }]);
});

test('a piece conversion below 0.001 g is rejected by the library', () => {
  assert.throws(() => changeMealCreationState(initial(), { catalogue: { meals: [
    { ...meal('one'), qtyUnit: 'PCS', gramsPerPiece: 1e-307 },
  ] } }), /grams per piece must be at least 0.001/);
});

test('bootstrap preserves the valid PCS recipe when another legacy recipe uses a corrupt unit', () => {
  const bad = { ...meal('bad', 'Same dish'), qtyUnit: 'pcs', gramsPerPiece: 50 };
  const valid = { ...meal('valid', 'Same dish'), qtyUnit: 'PCS', gramsPerPiece: 50 };
  const bootstrapped = changeMealCreationState({ catalogue: { meals: [bad, valid], source: '' }, boards: {} }, {});
  assert.deepEqual(bootstrapped.catalogue.meals, [bad, valid]);
  assert.deepEqual(bootstrapped.aliases, []);
});

test('repair merges recovered source signatures into an existing edited occurrence', () => {
  const original = { ...meal('RECOVER-001'), day: 'DAY 1' };
  const current = { catalogue: { meals: [{ ...original, notes: 'Saved edit', qtyUnit: 'PCS', gramsPerPiece: 50 }], source: 'Recovered.xlsx' }, boards: {} };
  const dated = { ...original, cycleSource: { sourceMealId: original.id, week: 'Week 1', day: 1 } };
  const recovered = recoverMealCreationState([{ meals: [{ items: [{ mealType: 'main', cycleMeal: dated }] }] }]);
  const repaired = repairMealCreationState(current, recovered);
  const reimported = changeMealCreationState(repaired, { catalogue: { source: 'Recovered.xlsx', meals: [original] }, skipDuplicates: true });
  assert.deepEqual(reimported.catalogue.meals, current.catalogue.meals);
  assert.deepEqual(reimported.cycles.find(cycle => cycle.id === 'RECOVER').boards['Main menu:Week 1'][0][1],
    [{ mealId: original.id, isMatterCore: false }]);
});

test('editing legacy preparation notes preserves the existing quantity rule while new invalid rules still fail', () => {
  const previous = { ...meal('one'), qtyUnit: 'PCS' };
  const existing = { ...initial(), catalogue: { meals: [previous], source: '' } };
  const edited = { ...previous, notes: 'New prep notes' };
  const next = changeMealCreationState(existing, { catalogue: { meals: [edited] } });
  assert.deepEqual(next.catalogue.meals, [edited]);
  assert.throws(() => changeMealCreationState(existing, { catalogue: { meals: [{ ...edited, gramsPerPiece: 0 }] } }), /grams per piece/);
});

test('recovery retains a dated recipe and its placement when only legacy quantity metadata is invalid', () => {
  const snapshot = { ...meal('LEGACY-001'), qtyUnit: 'PCS', cycleSource: { week: 'Week 1', day: 2 } };
  const menus = [{ meals: [{ items: [{ mealType: 'main', cycleMeal: snapshot }] }] }];
  const olderSnapshot = { ...snapshot, gramsPerPiece: 50 };
  const recovered = recoverMealCreationState([...menus, { meals: [{ items: [{ mealType: 'main', cycleMeal: olderSnapshot }] }] }]);
  assert.deepEqual(recovered.catalogue.meals, [{ ...meal('LEGACY-001'), cycleSource: snapshot.cycleSource, preserveLibraryId: true }]);
  assert.equal(recovered.cycles[0].boards['Main menu:Week 1'][1][1][0].mealId, snapshot.id);
  assert.equal(recovered.recovery.skippedSnapshots, 0);
  assert.equal(snapshot.qtyUnit, 'PCS');
  assert.equal(olderSnapshot.gramsPerPiece, 50);
  const current = { catalogue: { meals: [{ ...meal('COPY-001', snapshot.name), qtyUnit: 'PCS', gramsPerPiece: 75 }], source: '' }, boards: {} };
  const repaired = changeMealCreationState(current, { catalogue: recovered.catalogue, boards: recovered.boards }, true);
  assert.deepEqual(repaired.catalogue.meals.map(item => [item.id, item.gramsPerPiece]), [['COPY-001', 75], ['LEGACY-001', undefined]]);
  assert.deepEqual(repaired.aliases, []);
  const unconfigured = { ...meal('LEGACY-001'), cycleSource: snapshot.cycleSource };
  const missingRules = recoverMealCreationState([{ meals: [{ items: [{ mealType: 'main', cycleMeal: unconfigured }] }] }]);
  const repairedUnconfigured = changeMealCreationState(current, { catalogue: missingRules.catalogue, boards: missingRules.boards }, true);
  assert.deepEqual(repairedUnconfigured.catalogue.meals.map(item => [item.id, item.gramsPerPiece]), [['COPY-001', 75], ['LEGACY-001', undefined]]);
  assert.deepEqual(repairedUnconfigured.aliases, []);
});

test('matching quantity rules keep both existing library IDs and assigned cycle days through reload', () => {
  const one = { ...meal('one', 'Shared recipe'), day: 'DAY 1', qtyUnit: 'PCS', gramsPerPiece: 50 };
  const two = { ...meal('two', 'Shared recipe'), day: 'DAY 2', qtyUnit: 'PCS', gramsPerPiece: 100 };
  for (const notes of ['', 'A different prep note']) {
    const saved = changeMealCreationState({ catalogue: { meals: [one, { ...two, notes }], source: 'Workbook.xlsx' }, boards: {} }, {});
    const edited = changeMealCreationState(saved, { catalogue: { meals: [{ ...two, gramsPerPiece: 50 }] } });
    const reloaded = changeMealCreationState(edited, {});
    assert.deepEqual(reloaded.catalogue.meals.map(recipe => [recipe.id, recipe.gramsPerPiece]), [['one', 50], ['two', 50]]);
    assert.deepEqual(reloaded.cycles.map(cycle => cycle.boards), saved.cycles.map(cycle => cycle.boards));
    assert.deepEqual(reloaded.aliases, []);
  }
});

test('reimport recognizes the original workbook occurrence after a combined QTY and preparation edit', () => {
  const original = { ...meal('ORIGINAL-001'), day: 'DAY 1' };
  const workbook = { catalogue: { meals: [original], source: 'Original.xlsx' }, skipDuplicates: true };
  const imported = changeMealCreationState(initial(), workbook);
  const edited = changeMealCreationState(imported, { catalogue: { meals: [
    { ...original, qtyUnit: 'PCS', gramsPerPiece: 50, notes: 'Revised instructions' },
  ] } });
  const repeated = changeMealCreationState(edited, workbook);
  assert.deepEqual(repeated.catalogue.meals, edited.catalogue.meals);
  assert.deepEqual(repeated.cycles, edited.cycles);
  const moved = changeMealCreationState(edited, { ...workbook, catalogue: {
    ...workbook.catalogue, meals: [{ ...original, day: 'DAY 2' }],
  } });
  assert.equal(moved.catalogue.meals.find(entry => entry.id === original.id).gramsPerPiece, 50);
  assert.equal(moved.catalogue.meals.length, edited.catalogue.meals.length);
  assert.equal(moved.cycles.find(cycle => cycle.id === 'ORIGINAL').boards['Main menu:Week 1'][1][1][0].mealId, original.id);
  const genuineChange = changeMealCreationState(repeated, { ...workbook, catalogue: {
    ...workbook.catalogue, meals: [{ ...original, name: 'New recipe' }],
  } });
  assert.equal(genuineChange.catalogue.meals.length, repeated.catalogue.meals.length + 1);
});

test('every previously matched workbook recipe remains linked after later local edits', () => {
  const original = { ...meal('ORIGINAL-001'), day: 'DAY 1' };
  const upload = (state, row) => changeMealCreationState(state, { catalogue: { meals: [row], source: 'Original.xlsx' }, skipDuplicates: true });
  const imported = upload(initial(), original);
  const firstEdit = { ...original, qtyUnit: 'PCS', gramsPerPiece: 50, notes: 'First edit' };
  const edited = changeMealCreationState(imported, { catalogue: { meals: [firstEdit] } });
  const updatedSource = { ...original, notes: 'First edit' };
  const matched = upload(edited, updatedSource);
  const secondEdit = changeMealCreationState(matched, { catalogue: { meals: [{ ...firstEdit, notes: 'Second edit' }] } });
  for (const workbookRow of [original, updatedSource]) {
    const repeated = upload(secondEdit, workbookRow);
    assert.deepEqual(repeated.catalogue.meals, secondEdit.catalogue.meals);
    assert.deepEqual(repeated.cycles, secondEdit.cycles);
  }
});

test('moving a workbook row onto another variant’s day keeps the original source recipe', () => {
  const original = { ...meal('CYCLE-001', 'Original bowl'), day: 'DAY 1' };
  const different = { ...original, day: 'DAY 2', notes: 'Different source recipe' };
  const upload = (state, row) => changeMealCreationState(state, { catalogue: { meals: [row], source: 'Cycle.xlsx' }, skipDuplicates: true });
  const imported = upload(upload(initial(), original), different);
  const variant = imported.catalogue.meals.find(entry => entry.importedMealId === original.id);
  const edits = { catalogue: { meals: [
    { ...original, qtyUnit: 'PCS', gramsPerPiece: 50 },
    { ...variant, notes: original.notes, qtyUnit: 'PCS', gramsPerPiece: 100 },
  ] } };
  const legacy = structuredClone(imported);
  for (const cycle of legacy.cycles) for (const occurrence of cycle.meals) delete occurrence.recipeSignatures;
  for (const stateBeforeEdit of [imported, legacy]) {
    const state = changeMealCreationState(stateBeforeEdit, edits);
    const moved = upload(state, { ...original, day: 'DAY 2' });
    const cycle = moved.cycles.find(entry => entry.id === 'CYCLE');
    assert.ok(cycle.meals.find(entry => entry.mealId === original.id).cycleDays.includes('DAY 2'));
    assert.equal(moved.catalogue.meals.find(entry => entry.id === original.id).gramsPerPiece, 50);
  }
});

test('an unchanged legacy row keeps its existing destination variant when the original was edited to match', () => {
  const original = { ...meal('CYCLE-001', 'Original bowl'), day: 'DAY 1' };
  const different = { ...original, day: 'DAY 2', notes: 'Different source recipe' };
  const upload = (state, row) => changeMealCreationState(state, { catalogue: { meals: [row], source: 'Cycle.xlsx' }, skipDuplicates: true });
  const legacy = upload(upload(initial(), original), different);
  const variant = legacy.catalogue.meals.find(entry => entry.importedMealId === original.id);
  for (const cycle of legacy.cycles) for (const occurrence of cycle.meals) delete occurrence.recipeSignatures;
  const edited = changeMealCreationState(legacy, { catalogue: { meals: [
    { ...original, notes: different.notes, qtyUnit: 'PCS', gramsPerPiece: 50 },
  ] } });
  const repeated = upload(edited, different);
  assert.deepEqual(repeated.cycles.find(entry => entry.id === 'CYCLE').boards['Main menu:Week 1'][1][1],
    [{ mealId: variant.id, isMatterCore: false }]);
  assert.deepEqual(repeated.catalogue.meals, edited.catalogue.meals);
});

test('a legacy workbook row on a new day keeps its exact same-source variant after an original is edited', () => {
  const original = { ...meal('CYCLE-001', 'Original bowl'), day: 'DAY 1' };
  const different = { ...original, day: 'DAY 2', notes: 'Different source recipe' };
  const upload = (state, row) => changeMealCreationState(state, { catalogue: { meals: [row], source: 'Cycle.xlsx' }, skipDuplicates: true });
  const legacy = upload(upload(initial(), original), different);
  const variant = legacy.catalogue.meals.find(entry => entry.importedMealId === original.id);
  for (const cycle of legacy.cycles) for (const occurrence of cycle.meals) delete occurrence.recipeSignatures;
  const edited = changeMealCreationState(legacy, { catalogue: { meals: [
    { ...original, notes: different.notes, qtyUnit: 'PCS', gramsPerPiece: 50 },
  ] } });
  const row = { ...different, day: 'DAY 3' };
  const repeated = upload(edited, row);
  assert.deepEqual(repeated.cycles.find(entry => entry.id === 'CYCLE').boards['Main menu:Week 1'][2][1],
    [{ mealId: variant.id, isMatterCore: false }]);
  const week = board();
  week[2][1] = [{ mealId: original.id, isMatterCore: true }];
  const bootstrap = mergeLegacyDraft(edited, { catalogue: { meals: [row], source: 'Cycle.xlsx' }, boards: { 'Main menu:Week 2': week } });
  assert.deepEqual(bootstrap.cycles.find(entry => entry.id === 'CYCLE').boards['Main menu:Week 2'][2][1],
    [{ mealId: variant.id, isMatterCore: true }]);
});

test('reimport recognizes a pre-existing workbook after separate QTY and preparation edits', () => {
  const original = { ...meal('OLD-001'), day: 'DAY 1' };
  const legacy = changeMealCreationState({ catalogue: { meals: [original], source: 'Old.xlsx' }, boards: {} }, {});
  const withQuantity = { ...original, qtyUnit: 'PCS', gramsPerPiece: 50 };
  const quantityEdit = changeMealCreationState(legacy, { catalogue: { meals: [withQuantity] } });
  const edited = changeMealCreationState(quantityEdit, { catalogue: { meals: [{ ...withQuantity, notes: 'Revised prep' }] } });
  const repeated = changeMealCreationState(edited, { catalogue: { meals: [original], source: 'Old.xlsx' }, skipDuplicates: true });
  assert.deepEqual(repeated.catalogue.meals, edited.catalogue.meals);
  assert.deepEqual(repeated.cycles.map(cycle => cycle.boards), edited.cycles.map(cycle => cycle.boards));
  const occurrence = repeated.cycles.find(cycle => cycle.id === 'OLD').meals[0];
  assert.deepEqual(occurrence.recipeSignatures, [occurrence.inferredRecipeSignature]);
});

test('reusing a historical workbook alias creates a variant without moving dated links', () => {
  const original = { ...meal('OLD-001'), qtyUnit: 'PCS', gramsPerPiece: 50 };
  const legacy = changeMealCreationState({ catalogue: { meals: [original], source: 'Old.xlsx' }, boards: {},
    aliases: [{ from: 'OLD-002', to: original.id }],
  }, {});
  const newRecipe = { ...meal('OLD-002', 'A different recipe'), day: 'DAY 2' };
  const imported = changeMealCreationState(legacy, { catalogue: { meals: [newRecipe], source: 'Old.xlsx' }, skipDuplicates: true });
  assert.deepEqual(imported.aliases, legacy.aliases);
  assert.equal(imported.catalogue.meals.find(recipe => recipe.id === original.id).gramsPerPiece, 50);
  const variant = imported.catalogue.meals.find(recipe => recipe.importedMealId === newRecipe.id);
  assert.notEqual(variant.id, newRecipe.id);
  assert.equal(imported.cycles[0].boards['Main menu:Week 1'][1][1][0].mealId, variant.id);
});

test('legacy bootstrap does not reclaim an alias or override its edited PCS rule', () => {
  const original = { ...meal('NOV3-001', 'Original recipe'), day: 'DAY 1' };
  const aliased = { ...original, id: 'NOV4-001', day: 'DAY 2' };
  const legacy = changeMealCreationState({ catalogue: { meals: [original], source: 'Nov3.xlsx' }, boards: {},
    aliases: [{ from: aliased.id, to: original.id }],
  }, {});
  const edited = changeMealCreationState(legacy, { catalogue: { meals: [
    { ...original, qtyUnit: 'PCS', gramsPerPiece: 50, notes: 'Current prep' },
  ] } });
  const bootstrapped = mergeLegacyDraft(edited, { catalogue: { meals: [aliased], source: 'Nov4.xlsx' }, boards: {} });
  assert.deepEqual(bootstrapped.aliases, legacy.aliases);
  assert.equal(bootstrapped.catalogue.meals.length, 1);
  assert.equal(bootstrapped.catalogue.meals[0].gramsPerPiece, 50);
  assert.equal(bootstrapped.cycles.find(item => item.id === 'NOV4').meals[0].mealId, original.id);
});

test('an edited source ID cannot be redirected to an unrelated cycle on legacy bootstrap', () => {
  const original = { ...meal('NOV4-001', 'Shared dish'), day: 'DAY 1' };
  const unrelated = { ...original, id: 'NOV2-001', qtyUnit: 'PCS', gramsPerPiece: 100 };
  const upload = (state, row) => changeMealCreationState(state, { catalogue: { meals: [row], source: 'Cycle.xlsx' }, skipDuplicates: true });
  const initialState = upload(upload(initial(), original), unrelated);
  const state = changeMealCreationState(initialState, { catalogue: { meals: [
    { ...original, notes: 'Current prep', qtyUnit: 'PCS', gramsPerPiece: 50 },
  ] } });
  const week = board(); week[0][1] = [{ mealId: original.id, isMatterCore: true }];
  const bootstrap = mergeLegacyDraft(state, { catalogue: { meals: [original], source: 'Cycle.xlsx' }, boards: { 'Main menu:Week 2': week } });
  const cycle = bootstrap.cycles.find(entry => entry.id === 'NOV4');
  assert.deepEqual(cycle.boards['Main menu:Week 2'][0][1], [{ mealId: original.id, isMatterCore: true }]);
  assert.deepEqual(cycle.meals.map(entry => entry.mealId), [original.id]);
});

test('legacy bootstrap links a uniquely matching new workbook ID to an existing recipe with saved PCS', () => {
  const original = { ...meal('NOV3-001', 'Original recipe'), qtyUnit: 'PCS', gramsPerPiece: 50 };
  const state = changeMealCreationState({ catalogue: { meals: [original], source: 'Nov3.xlsx' }, boards: {} }, {});
  const oldCopy = { ...meal('NOV4-001', original.name), day: 'DAY 2' };
  const bootstrapped = mergeLegacyDraft(state, { catalogue: { meals: [oldCopy], source: 'Nov4.xlsx' }, boards: {} });
  assert.equal(bootstrapped.catalogue.meals.length, 1);
  assert.equal(bootstrapped.catalogue.meals[0].gramsPerPiece, 50);
  assert.deepEqual(bootstrapped.aliases, [{ from: oldCopy.id, to: original.id }]);
});

test('first-run legacy migration keeps the recovered PCS rule when the browser draft omits QTY', () => {
  const original = meal('RECOVER-001');
  const dated = { ...original, qtyUnit: 'PCS', gramsPerPiece: 50 };
  const recovered = recoverMealCreationState([{ meals: [{ items: [{ mealType: 'main', cycleMeal: dated }] }] }]);
  const migrated = mergeLegacyDraft(recovered, { catalogue: { source: 'Browser.xlsx', meals: [{ ...original, notes: 'More recent browser notes' }] } }, false);
  assert.deepEqual(migrated.catalogue.meals, [{ ...dated, notes: 'More recent browser notes' }]);
  const oldDraft = { catalogue: { source: 'Browser.xlsx', meals: [{ ...original, qtyUnit: 'PCS' }] } };
  for (const missingOnly of [true, false]) {
    const withInvalidLegacyRule = mergeLegacyDraft(recovered, oldDraft, missingOnly);
    assert.equal(withInvalidLegacyRule.catalogue.meals[0].gramsPerPiece, 50);
  }
  const oldCopy = { ...original, id: 'BROWSER-001', day: 'DAY 2' };
  const week = board();
  week[1][2] = [{ mealId: oldCopy.id, isMatterCore: true }];
  const firstRun = mergeLegacyDraft(recovered, { catalogue: { source: 'Browser.xlsx', meals: [oldCopy] },
    boards: { 'Main menu:Week 2': week } }, false);
  assert.deepEqual(firstRun.catalogue.meals.map(item => [item.id, item.gramsPerPiece]), [[original.id, 50]]);
  assert.deepEqual(firstRun.cycles.find(cycle => cycle.id === 'BROWSER').boards['Main menu:Week 2'][1][2],
    [{ mealId: original.id, isMatterCore: true }]);
});

test('first-run migration maps a raw source ID to the verified dated variant before inheriting QTY', () => {
  const original = { ...meal('RECOVER-001', 'Original dish'), qtyUnit: 'PCS', gramsPerPiece: 50, day: 'DAY 1',
    cycleSource: { week: 'Week 1', day: 1, sourceDay: 'DAY 1' } };
  const variant = { ...meal('RECOVER-001~second', 'Second recipe'), importedMealId: original.id, qtyUnit: 'PCS', gramsPerPiece: 100, day: 'DAY 2',
    cycleSource: { week: 'Week 1', day: 2, sourceDay: 'DAY 2' } };
  const recovered = recoverMealCreationState([{ meals: [{ items: [original, variant].map(cycleMeal => ({ mealType: 'main', cycleMeal })) }] }]);
  const { qtyUnit, gramsPerPiece, importedMealId, cycleSource, ...legacyFields } = variant;
  const legacy = { catalogue: { source: 'Browser.xlsx', meals: [{ ...legacyFields, id: original.id, day: 'DAY 3' }] } };
  const migrated = mergeLegacyDraft(recovered, legacy, false);
  assert.deepEqual(migrated.catalogue.meals.map(item => [item.id, item.name, item.gramsPerPiece]), [
    [original.id, original.name, 50], [variant.id, variant.name, 100],
  ]);
  const cycle = migrated.cycles.find(item => item.id === 'RECOVER');
  assert.equal(cycle.meals.find(item => item.mealId === variant.id).cycleDays.includes('DAY 3'), true);
});

test('reimport keeps both recovered days when one source recipe has different saved conversions', () => {
  const row = meal('RECOVER-001', 'Recovered dish');
  const snapshots = [50, 100].map((gramsPerPiece, index) => ({
    ...row, id: index ? `${row.id}~variant` : row.id, qtyUnit: 'PCS', gramsPerPiece,
    cycleSource: { sourceMealId: row.id, sourceDay: `DAY ${index + 1}`, week: 'Week 1', day: index + 1 },
  }));
  const recovered = recoverMealCreationState([{ meals: [{ items: snapshots.map(cycleMeal => ({ mealType: 'main', cycleMeal })) }] }]);
  const upload = (state, day) => changeMealCreationState(state, { catalogue: {
    source: 'Recovered.xlsx', meals: [{ ...row, day }],
  }, skipDuplicates: true });
  const reimported = upload(upload(recovered, 'DAY 1'), 'DAY 2');
  const combinedUpload = changeMealCreationState(recovered, {
    catalogue: { source: 'Recovered.xlsx', meals: [{ ...row, day: 'DAY 1', cycleDays: ['DAY 1', 'DAY 2'] }] },
    skipDuplicates: true,
  });
  const week = board();
  for (const index of [0, 1]) week[index][1] = [{ mealId: row.id, isMatterCore: true }];
  const legacyDraft = {
    catalogue: { source: 'Recovered.xlsx', meals: [{ ...row, day: 'DAY 1', cycleDays: ['DAY 1', 'DAY 2'] }] },
    boards: { 'Main menu:Week 2': week },
  };
  const bootstrapped = mergeLegacyDraft(recovered, legacyDraft);
  const upgraded = structuredClone(recovered);
  for (const cycle of upgraded.cycles) for (const occurrence of cycle.meals) delete occurrence.recipeSignatures;
  const reimportedUpgrade = upload(upload(upgraded, 'DAY 1'), 'DAY 2');
  for (const state of [reimported, combinedUpload, bootstrapped, reimportedUpgrade]) {
    const cycle = state.cycles.find(item => item.id === 'RECOVER');
    for (const [index, snapshot] of snapshots.entries()) {
      assert.deepEqual(cycle.boards['Main menu:Week 1'][index][1], [{ mealId: snapshot.id, isMatterCore: false }]);
      if (state === bootstrapped) assert.deepEqual(cycle.boards['Main menu:Week 2'][index][1], [{ mealId: snapshot.id, isMatterCore: true }]);
    }
  }
});

test('recovery cannot promote a stale main conversion carried by a dated breakfast', () => {
  const original = { ...meal('RECOVER-001'), qtyUnit: 'PCS', gramsPerPiece: 100 };
  const misclassified = { ...original, gramsPerPiece: 50 };
  const recovered = recoverMealCreationState([
    { meals: [{ items: [{ mealType: 'breakfast', cycleMeal: misclassified }] }] },
    { meals: [{ items: [{ mealType: 'main', cycleMeal: original }] }] },
  ]);
  assert.equal(recovered.catalogue.meals[0].qtyUnit, undefined);
  assert.equal(recovered.catalogue.meals[0].gramsPerPiece, undefined);
  assert.equal(original.gramsPerPiece, 100);
});

for (const sharedSourceDay of [false, true]) test(`a combined weekend row keeps separate recovered conversions (shared source day: ${sharedSourceDay})`, () => {
  const row = meal('WEEKEND-001');
  const snapshots = [50, 100].map((gramsPerPiece, index) => ({
    ...row, id: `${row.id}~${index + 1}`, qtyUnit: 'PCS', gramsPerPiece,
    cycleSource: { sourceMealId: row.id, sourceDay: sharedSourceDay ? 'DAY 6 & 7' : `DAY ${index + 6}`, week: 'Week 1', day: index + 6 },
  }));
  const weekTwo = snapshots.map(cycleMeal => ({
    ...cycleMeal, cycleSource: { ...cycleMeal.cycleSource, week: 'Week 2', day: 13 - cycleMeal.cycleSource.day },
  }));
  const recovered = recoverMealCreationState([{ meals: [{ items: [...snapshots, ...weekTwo].map(cycleMeal => ({ mealType: 'main', cycleMeal })) }] }]);
  const workbook = { source: 'Weekend.xlsx', meals: [{ ...row, day: 'DAY 6 & 7' }] };
  const imported = changeMealCreationState(recovered, { catalogue: workbook, skipDuplicates: true });
  const bootstrapped = mergeLegacyDraft(recovered, { catalogue: workbook, boards: {} });
  for (const state of [imported, bootstrapped]) {
    assert.equal(state.catalogue.meals.length, 2);
    const cycle = state.cycles.find(item => item.id === 'WEEKEND');
    for (const [index, snapshot] of snapshots.entries()) {
      assert.deepEqual(cycle.boards['Main menu:Week 1'][index + 5][1], [{ mealId: snapshot.id, isMatterCore: false }]);
      assert.deepEqual(cycle.boards['Main menu:Week 2'][6 - index][1], [{ mealId: snapshot.id, isMatterCore: false }]);
    }
  }
});

test('recovery remembers every source day of a dated variant before reimporting placements', () => {
  const row = meal('SOURCE-001');
  const snapshots = [1, 2, 3].map(day => ({
    ...row, ...(day === 2 ? { id: `${row.id}~second`, qtyUnit: 'PCS', gramsPerPiece: 100 } : {}),
    cycleSource: { week: 'Week 1', day, sourceDay: `DAY ${day}`, sourceMealId: row.id },
  }));
  const recovered = recoverMealCreationState([{ meals: [{ items: snapshots.map(cycleMeal => ({ mealType: 'main', cycleMeal })) }] }]);
  const imported = changeMealCreationState(recovered, { catalogue: { source: 'Source.xlsx', meals: [{ ...row, day: 'DAY 3' }] }, skipDuplicates: true });
  const cycle = imported.cycles.find(entry => entry.id === 'SOURCE');
  assert.deepEqual(cycle.meals.find(entry => entry.mealId === row.id).cycleDays, ['DAY 1', 'DAY 3']);
  assert.deepEqual(cycle.boards['Main menu:Week 1'][2][1], [{ mealId: row.id, isMatterCore: false }]);
});

test('a verified day match beats a recipe signature inferred from an edit on another day', () => {
  const row = meal('SOURCE-001');
  const snapshots = [
    { ...row, qtyUnit: 'PCS', gramsPerPiece: 50, cycleSource: { sourceMealId: row.id, sourceDay: 'DAY 1', week: 'Week 1', day: 1 } },
    { ...row, id: `${row.id}~variant`, cycleSource: { sourceMealId: row.id, sourceDay: 'DAY 2', week: 'Week 1', day: 2 } },
  ];
  const legacy = recoverMealCreationState([{ meals: [{ items: snapshots.map(cycleMeal => ({ mealType: 'main', cycleMeal })) }] }]);
  for (const cycle of legacy.cycles) for (const occurrence of cycle.meals) delete occurrence.recipeSignatures;
  const edited = changeMealCreationState(legacy, { catalogue: { meals: [{ ...row, qtyUnit: 'PCS', gramsPerPiece: 75, notes: 'Preparations changed' }] } });
  const imported = changeMealCreationState(edited, { catalogue: { source: 'Source.xlsx', meals: [{ ...row, day: 'DAY 2' }] }, skipDuplicates: true });
  const cycle = imported.cycles.find(item => item.id === 'SOURCE');
  assert.deepEqual(cycle.boards['Main menu:Week 1'][1][1], [{ mealId: snapshots[1].id, isMatterCore: false }]);
});

test('legacy placement uses its matching recipe variant without reclaiming a reserved source ID', () => {
  const original = { ...meal('CYCLE-001', 'Roast Chicken'), day: 'DAY 1' };
  const variantRow = { ...original, name: 'Grilled Chicken', day: 'DAY 2' };
  const upload = (state, row) => changeMealCreationState(state, { catalogue: { meals: [row], source: 'Cycle.xlsx' }, skipDuplicates: true });
  const state = upload(upload(initial(), original), variantRow);
  const variant = state.catalogue.meals.find(entry => entry.importedMealId === original.id);
  const week = board();
  week[2][1] = [{ mealId: original.id, isMatterCore: true }];
  const migrated = mergeLegacyDraft(state, { catalogue: { meals: [{ ...variantRow, day: 'DAY 3' }], source: 'Cycle.xlsx' },
    boards: { 'Main menu:Week 2': week },
  });
  const cycle = migrated.cycles.find(entry => entry.id === 'CYCLE');
  assert.deepEqual(cycle.boards['Main menu:Week 2'][2][1], [{ mealId: variant.id, isMatterCore: true }]);
  assert.equal(migrated.catalogue.meals.find(entry => entry.id === original.id).name, original.name);
  assert.deepEqual(migrated.aliases, state.aliases);
});

test('an inferred alias with the original workbook recipe keeps its ID and receives the supplied day', () => {
  const original = meal('NOV3-001', 'Imported recipe');
  const legacy = changeMealCreationState({ catalogue: { meals: [original], source: 'Nov3.xlsx' }, boards: {},
    aliases: [{ from: 'NOV4-001', to: original.id }],
  }, {});
  const edited = changeMealCreationState(legacy, { catalogue: { meals: [
    { ...original, qtyUnit: 'PCS', gramsPerPiece: 50, notes: 'New prep notes' },
  ] } });
  const workbookRow = { ...original, id: 'NOV4-001', day: 'DAY 2' };
  const repeated = changeMealCreationState(edited, { catalogue: { meals: [workbookRow], source: 'Nov4.xlsx' }, skipDuplicates: true });
  assert.deepEqual(repeated.catalogue.meals.map(entry => [entry.id, entry.gramsPerPiece]), [[original.id, 50]]);
  const cycle = repeated.cycles.find(entry => entry.id === 'NOV4');
  assert.equal(cycle.meals[0].inferredDays, undefined);
  assert.equal(cycle.meals[0].day, 'DAY 2');
  assert.equal(cycle.boards['Main menu:Week 1'][1][1][0].mealId, original.id);
});

test('actual workbook parser blank combined flags import and migrate without losing notes or exclusions',async()=>{
  const source=readFileSync(new URL('../../client/src/pages/adminMealSelectionV2/workbookMeals.js',import.meta.url));
  const {parseMealWorkbook}=await import(`data:text/javascript;base64,${source.toString('base64')}`);
  const headers=['Meal ID','Day','Meal category','Temperature','Meal name','Protein / main item','Carb','Vegetable','Sauce','Garnish','Tags','Carb combined with veg','Preparation / option notes'];
  const parsed=parseMealWorkbook({Meals:[headers,['blank','DAY 1','MAIN CHX','WARM','Own meal','Roast','','','','','','','Meal notes']],Components:[['Meal ID','Component type','Component name','Preparation / option notes','Exclusion 1'],['blank','Protein','Roast','Keep notes','Nuts']]});
  assert.equal(parsed[0].carbCombined,'');
  const saved=changeMealCreationState(initial(),{catalogue:{meals:parsed}});
  const imported=saved.catalogue.meals.find(m=>m.id==='blank');assert.equal(imported.carbCombined,'Not specified');assert.equal(imported.notes,'Meal notes');assert.deepEqual(imported.components[0].exclusions,['Nuts']);assert.equal(imported.components[0].notes,'Keep notes');
  assert.equal(mergeLegacyDraft(initial(),{catalogue:{meals:parsed}},false).catalogue.meals.length,2);
  assert.equal(parsed[0].carbCombined,'');
});

test('imports upsert meals without dropping existing library meals, notes, exclusions or cycle placements', () => {
  const state=initial();state.boards['Main menu:Week 1'][0][1].push({mealId:'one',isMatterCore:true});
  const before=JSON.stringify(state);
  const saved=changeMealCreationState(state,{catalogue:{meals:[meal('two')],source:'Next.xlsx'}});
  assert.deepEqual(saved.catalogue.meals.map(m=>m.id),['one','two']);
  assert.deepEqual(saved.catalogue.meals[0],state.catalogue.meals[0]);assert.deepEqual(saved.boards,state.boards);assert.equal(JSON.stringify(state),before);
  const changed=changeMealCreationState(saved,{catalogue:{meals:[meal('one','Renamed')]}});
  assert.equal(changed.catalogue.meals.length,2);assert.equal(changed.catalogue.meals[0].name,'Renamed');
  assert.equal(changed.catalogue.source,'Next.xlsx');
});

test('board changes preserve other weeks and intentionally empty weeks survive',()=>{
  const state=initial(), second=board();second[6][2]=[{mealId:'one',isMatterCore:true}];
  const saved=changeMealCreationState(state,{boards:{'Main menu:Week 2':second}});
  assert.deepEqual(saved.boards['Main menu:Week 1'],board());assert.deepEqual(saved.boards['Main menu:Week 2'][6][2],[{mealId:'one',isMatterCore:true}]);
  assert.throws(()=>checkedBoards({'Main menu:Week 2':[]},state.catalogue.meals),{statusCode:400});
  const invalid=board();invalid[0][0]=[{mealId:'missing',isMatterCore:false}];assert.throws(()=>checkedBoards({'Main menu:Week 2':invalid},state.catalogue.meals),{statusCode:400});
});

test('recovery keeps newest intact snapshots and reconstructs exact Main/Sub/Core placements without mutating menus',()=>{
  const latest={...meal('one','Newest'),cycleSource:{week:'Week 1',day:7}};
  const menus=[{meals:[{mealType:'main',items:[{cycleMeal:latest,rotationCategory:'sub',usedForCorePlan:true},{cycleMeal:meal('two')},{cycleMeal:{id:'invalid'}}]}]},{meals:[{mealType:'main',items:[{cycleMeal:{...meal('one','Old'),cycleSource:{week:'Week 1',day:1}}}]}]}];
  const before=JSON.stringify(menus), recovered=recoverMealCreationState(menus);
  assert.equal(recovered.catalogue.meals.length,2);assert.equal(recovered.catalogue.meals[0].name,'Newest');
  assert.deepEqual(recovered.catalogue.meals[0].components,latest.components);
  assert.deepEqual(recovered.boards['Main menu:Week 1'][6][2],[{mealId:'one',isMatterCore:true}]);assert.deepEqual(recovered.boards['Main menu:Week 1'][0][1],[]);
  assert.equal(recovered.recovery.skippedSnapshots,1);assert.equal(JSON.stringify(menus),before);
});

test('old browser migrations add missing meals and never overwrite database edits or empty weeks',()=>{
  const current=initial();current.catalogue.meals[0].name='Edited on server';
  const oldBoard=board();oldBoard[0][1]=[{mealId:'one',isMatterCore:false}];
  const legacy={catalogue:{meals:[meal('one','Old browser'),meal('two')],source:'Old.xlsx'},boards:{'Main menu:Week 1':oldBoard}};
  const merged=mergeLegacyDraft(current,legacy);
  assert.equal(merged.catalogue.meals[0].name,'Edited on server');assert.equal(merged.catalogue.meals.length,2);assert.deepEqual(merged.boards['Main menu:Week 1'],board());
  assert.deepEqual(mergeLegacyDraft(merged,legacy),merged);
});

test('a dangling old browser board does not prevent first-run meal recovery or destroy its recovered week',()=>{
  const recovered=initial(), bad=board();bad[0][1]=[{mealId:'gone',isMatterCore:false}];
  const merged=mergeLegacyDraft(recovered,{catalogue:{meals:[meal('two')]},boards:{'Main menu:Week 1':bad}},false);
  assert.equal(merged.catalogue.meals.length,2);assert.deepEqual(merged.boards,recovered.boards);
});

test('dated copies with original cycle-source metadata recover one importable assignment and retain Core',()=>{
  const snapshot={...meal('one'),cycleSource:{week:'Week 1',day:1}};
  const recovered=recoverMealCreationState([{meals:[{date:'2026-11-16',mealType:'main',items:[{cycleMeal:snapshot,rotationCategory:'main'}]},{date:'2026-11-17',mealType:'main',items:[{cycleMeal:snapshot,rotationCategory:'sub',usedForCorePlan:true}]}]}]);
  assert.deepEqual(recovered.boards['Main menu:Week 1'][0][1],[{mealId:'one',isMatterCore:true}]);assert.deepEqual(recovered.boards['Main menu:Week 1'][0][2],[]);
});

test('recovered older weeks and first-run legacy recipes use the retained meal kind without losing placements',()=>{
  const latest={...meal('one'),mealKind:'Snack',cycleSource:{week:'Week 1',day:1}};
  const old={...meal('one'),cycleSource:{week:'Week 2',day:1}};
  const recovered=recoverMealCreationState([{meals:[{mealType:'snack',items:[{cycleMeal:latest}]}]},{meals:[{mealType:'main',items:[{cycleMeal:old,rotationCategory:'sub',usedForCorePlan:true}]}]}]);
  assert.deepEqual(recovered.boards['Main menu:Week 2'][0][3],[{mealId:'one',isMatterCore:true}]);assert.deepEqual(recovered.boards['Main menu:Week 2'][0][2],[]);
  const migrated=mergeLegacyDraft(recovered,{catalogue:{meals:[{...meal('one'),mealKind:'Breakfast'}]}},false);
  assert.equal(migrated.boards['Main menu:Week 1'][0][0][0].mealId,'one');assert.equal(migrated.boards['Main menu:Week 2'][0][0][0].isMatterCore,true);
});
