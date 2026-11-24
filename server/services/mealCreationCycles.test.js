import test from 'node:test';
import assert from 'node:assert/strict';
import { cycleIdentity } from './mealCreationCycles.js';
import { changeMealCreationState, recoverMealCreationState, mergeLegacyDraft, repairMealCreationState } from './mealCreationState.js';

const meal = (id, day = 'DAY 1') => ({ id, name: 'Roast Chicken', day, mealKind: 'Main meal', mealType: 'Chicken', carbCombined: 'No', components: [{ id: id + '-p', type: 'Protein', name: 'Chicken', exclusions: ['Nuts'], notes: 'Keep this note' }] });
const empty = () => Array.from({ length: 7 }, () => Array.from({ length: 4 }, () => []));
const initial = () => ({ catalogue: { meals: [], source: '' }, boards: {} });
const upload = (state, meals, source) => changeMealCreationState(state, { catalogue: { meals, source }, skipDuplicates: true });
const cycle = (state, id) => state.cycles.find(value => value.id === id);

test('NOV3, NOV4 and DEC1 are separate permanent cycles even when they share one canonical recipe', () => {
  let saved = upload(initial(), [meal('NOV3-004')], 'November_Cycle_3.xlsx');
  saved = upload(saved, [meal('NOV4-004', 'DAY 2')], 'November_Cycle_4.xlsx');
  saved = upload(saved, [meal('DEC 1-004', 'DAY 6 & 7')], 'December_Cycle_1.xlsx');
  assert.equal(saved.catalogue.meals.length, 1);
  assert.deepEqual(saved.cycles.map(value => value.id), ['NOV3', 'NOV4', 'DEC1']);
  assert.equal(cycle(saved, 'NOV4').meals[0].sourceMealId, 'NOV4-004');
  assert.equal(cycle(saved, 'NOV4').meals[0].day, 'DAY 2');
  assert.deepEqual(cycle(saved, 'NOV4').boards['Main menu:Week 1'][1][1], [{ mealId: 'NOV3-004', isMatterCore: false }]);
  assert.equal(cycle(saved, 'NOV4').boards['Main menu:Week 1'][0][1].length, 0);
  assert.equal(cycle(saved, 'DEC1').boards['Main menu:Week 1'][5][1].length, 1);
  assert.equal(cycle(saved, 'DEC1').boards['Main menu:Week 1'][6][1].length, 1);
  assert.deepEqual(changeMealCreationState(saved, {}), saved);
});

test('re-upload is additive and does not restore a deliberately removed placement or overwrite other weeks', () => {
  let saved = upload(initial(), [meal('NOV3-004')], 'November.xlsx');
  const week2 = empty(); week2[4][2] = [{ mealId: 'NOV3-004', isMatterCore: true }];
  saved = changeMealCreationState(saved, { cycleId: 'NOV3', boards: { 'Main menu:Week 1': empty(), 'Main menu:Week 2': week2 } });
  const before = structuredClone(saved);
  saved = upload(saved, [meal('NOV3-004')], 'November.xlsx');
  assert.deepEqual(saved, before);
  const newMeal = meal('NOV3-005', 'DAY 3'); newMeal.name = 'Another Chicken';
  saved = upload(saved, [meal('NOV3-004'), newMeal], 'November.xlsx');
  assert.equal(cycle(saved, 'NOV3').boards['Main menu:Week 1'][0][1].length, 0);
  assert.equal(cycle(saved, 'NOV3').boards['Main menu:Week 1'][2][1][0].mealId, 'NOV3-005');
  assert.deepEqual(cycle(saved, 'NOV3').boards['Main menu:Week 2'], week2);
});

test('selected cycle saves preserve legacy boards and the other cycles and accept manually added library meals', () => {
  let saved = upload(initial(), [meal('NOV3-004')], 'November3.xlsx');
  const other = meal('NOV4-005'); other.name = 'Different meal';
  saved = upload(saved, [other], 'November4.xlsx');
  const before = structuredClone(cycle(saved, 'NOV4')), board = empty(); board[2][2] = [{ mealId: other.id, isMatterCore: true }];
  saved = changeMealCreationState(saved, { cycleId: 'NOV3', boards: { 'Main menu:Week 2': board } });
  assert.deepEqual(cycle(saved, 'NOV4'), before); assert.deepEqual(saved.boards, {});
  assert.deepEqual(cycle(saved, 'NOV3').meals.find(value => value.mealId === other.id), { mealId: other.id, sourceMealId: other.id, day: '' });
  assert.throws(() => changeMealCreationState(saved, { cycleId: 'missing', boards: {} }), { statusCode: 400 });
});

test('migrating the old global library retains each original prefix and source day before duplicate consolidation', () => {
  const state = initial(); state.catalogue = { meals: [meal('NOV3-004'), meal('NOV4-004', 'DAY 2')], source: 'November4.xlsx' };
  const saved = changeMealCreationState(state, {});
  assert.equal(saved.catalogue.meals.length, 1);
  assert.equal(cycle(saved, 'NOV3').meals[0].day, 'DAY 1');
  assert.equal(cycle(saved, 'NOV4').meals[0].day, 'DAY 2');
  assert.equal(cycle(saved, 'NOV4').meals[0].cycleDays, undefined);
  assert.deepEqual(changeMealCreationState(saved, {}), saved);
});

test('pre-existing aliases remain accessible as named cycles after migration', () => {
  const state = initial(); state.catalogue.meals = [meal('NOV3-004')]; state.aliases = [{ from: 'NOV4-004', to: 'NOV3-004' }];
  const saved = changeMealCreationState(state, {});
  assert.equal(cycle(saved, 'NOV4').meals[0].sourceMealId, 'NOV4-004');
  assert.equal(cycle(saved, 'NOV4').meals[0].mealId, 'NOV3-004');
  assert.deepEqual(saved.aliases, state.aliases);
});

test('reused source IDs with different dietary data retain both variants and source occurrences', () => {
  const original = meal('NOV3-004'), variant = meal('NOV3-004'); variant.components[0].exclusions.push('Dairy');
  let saved = upload(initial(), [original], 'November.xlsx'); saved = upload(saved, [variant], 'November.xlsx');
  assert.equal(saved.catalogue.meals.length, 2); assert.equal(cycle(saved, 'NOV3').meals.length, 2);
  assert.equal(cycle(saved, 'NOV3').boards['Main menu:Week 1'][0][1].length, 2);
  assert.deepEqual(upload(saved, [variant], 'November.xlsx'), saved);
});

test('recovery keeps independent Week 1 boards for every saved cycle and exact source IDs without editing menus', () => {
  const snapshot = (id, sourceMealId, day, cycleId) => ({ ...meal(id), cycleSource: { workbook: cycleId + '.xlsx', sourceMealId, cycleId, cycleName: cycleId, week: 'Week 1', day } });
  const menus = [snapshot('NOV3-004', 'NOV4-004', 2, 'NOV4'), snapshot('NOV3-004', 'NOV3-004', 1, 'NOV3')].map(cycleMeal => ({ meals: [{ mealType: 'main', items: [{ cycleMeal, rotationCategory: 'sub', usedForCorePlan: true }] }] }));
  const before = JSON.stringify(menus), saved = recoverMealCreationState(menus);
  assert.equal(saved.catalogue.meals.length, 1); assert.equal(saved.cycles.length, 2);
  assert.equal(cycle(saved, 'NOV4').meals[0].sourceMealId, 'NOV4-004');
  assert.equal(cycle(saved, 'NOV4').boards['Main menu:Week 1'][1][2][0].isMatterCore, true);
  assert.equal(cycle(saved, 'NOV3').boards['Main menu:Week 1'][0][2][0].mealId, 'NOV3-004');
  assert.equal(JSON.stringify(menus), before);
});

test('legacy board migration retains its Main/Sub/Core choices in the new named cycle', () => {
  const board = empty(); board[3][2] = [{ mealId: 'NOV3-004', isMatterCore: true }];
  const saved = mergeLegacyDraft(initial(), { catalogue: { meals: [meal('NOV3-004')], source: 'November.xlsx' }, boards: { 'Main menu:Week 1': board } });
  assert.deepEqual(cycle(saved, 'NOV3').boards['Main menu:Week 1'], board);
  assert.deepEqual(mergeLegacyDraft(saved, { catalogue: { meals: [meal('NOV3-004')], source: 'November.xlsx' }, boards: { 'Main menu:Week 1': empty() } }), saved);
  assert.equal(cycleIdentity(meal('free-form'), 'Original Workbook.xlsx').id, 'WORKBOOK:original-workbook');
});

test('browser NOV4 Week 1 migrates independently of an existing global NOV3 Week 1', () => {
  const nov3 = meal('NOV3-004'), nov4 = meal('NOV4-004');
  const globalWeek = empty(); globalWeek[0][1] = [{ mealId: nov3.id, isMatterCore: false }];
  const browserWeek = empty(); browserWeek[3][2] = [{ mealId: nov4.id, isMatterCore: true }];
  const legacy = { catalogue: { meals: [nov4], source: 'Nov4.xlsx' }, boards: { 'Main menu:Week 1': browserWeek } };
  for (const current of [
    { catalogue: { meals: [nov3], source: 'Nov3.xlsx' }, boards: { 'Main menu:Week 1': globalWeek } },
    upload({ catalogue: { meals: [nov3], source: 'Nov3.xlsx' }, boards: { 'Main menu:Week 1': globalWeek } }, [nov3], 'Nov3.xlsx'),
  ]) {
    const before = JSON.stringify({ current, legacy });
    const saved = mergeLegacyDraft(current, legacy);
    const canonical = saved.catalogue.meals[0].id;
    assert.equal(saved.catalogue.meals.length, 1);
    assert.deepEqual(cycle(saved, 'NOV4').boards['Main menu:Week 1'][3][2], [{ mealId: canonical, isMatterCore: true }]);
    assert.deepEqual(cycle(saved, 'NOV4').boards['Main menu:Week 1'][0][1], []);
    assert.deepEqual(cycle(saved, 'NOV3').boards['Main menu:Week 1'], globalWeek);
    assert.deepEqual(saved.boards['Main menu:Week 1'], globalWeek);
    assert.equal(JSON.stringify({ current, legacy }), before);
    assert.deepEqual(mergeLegacyDraft(saved, legacy), saved);
    const emptied = changeMealCreationState(saved, { cycleId: 'NOV4', boards: { 'Main menu:Week 1': empty() } });
    assert.deepEqual(cycle(mergeLegacyDraft(emptied, legacy), 'NOV4').boards['Main menu:Week 1'], empty());
  }
});

test('browser weeks cannot migrate into another cycle through a shared canonical recipe', () => {
  const nov3 = meal('NOV3-004'), nov4 = meal('NOV4-004');
  const current = upload(initial(), [nov3], 'Nov3.xlsx');
  const browserWeek = empty(); browserWeek[3][2] = [{ mealId: nov4.id, isMatterCore: true }];
  const saved = mergeLegacyDraft(current, { catalogue: { meals: [nov4], source: 'Nov4.xlsx' }, boards: { 'Main menu:Week 2': browserWeek } });
  assert.deepEqual(cycle(saved, 'NOV3'), cycle(current, 'NOV3'));
  assert.deepEqual(cycle(saved, 'NOV4').boards['Main menu:Week 2'][3][2], [{ mealId: nov3.id, isMatterCore: true }]);
});

test('generated seeds cannot suppress browser weeks for recipes already in an old combined catalogue', () => {
  const nov3 = meal('NOV3-004'), nov4 = { ...meal('NOV4-004'), name: 'Different NOV4 recipe' };
  const globalWeek = empty(); globalWeek[0][1] = [{ mealId: nov3.id, isMatterCore: false }];
  const current = { catalogue: { meals: [nov3, nov4], source: 'Nov3.xlsx' }, boards: { 'Main menu:Week 1': globalWeek } };
  const browserWeek = empty(); browserWeek[3][2] = [{ mealId: nov4.id, isMatterCore: true }];
  const saved = mergeLegacyDraft(current, { catalogue: { meals: [nov4], source: 'Nov4.xlsx' }, boards: { 'Main menu:Week 1': browserWeek } });
  assert.deepEqual(cycle(saved, 'NOV4').boards['Main menu:Week 1'], browserWeek);
  assert.deepEqual(cycle(saved, 'NOV3').boards['Main menu:Week 1'], globalWeek);
  assert.deepEqual(saved.boards['Main menu:Week 1'], globalWeek);
});

test('a combined browser board partitions original IDs before recipes are consolidated', () => {
  const nov3 = meal('NOV3-004'), nov4 = meal('NOV4-004');
  const browserWeek = empty(); browserWeek[1][1] = [{ mealId: nov3.id, isMatterCore: false }]; browserWeek[3][2] = [{ mealId: nov4.id, isMatterCore: true }];
  const saved = mergeLegacyDraft(initial(), { catalogue: { meals: [nov3, nov4], source: 'Combined.xlsx' }, boards: { 'Main menu:Week 1': browserWeek } });
  assert.deepEqual(cycle(saved, 'NOV3').boards['Main menu:Week 1'][1][1], [{ mealId: nov3.id, isMatterCore: false }]);
  assert.deepEqual(cycle(saved, 'NOV3').boards['Main menu:Week 1'][3][2], []);
  assert.deepEqual(cycle(saved, 'NOV4').boards['Main menu:Week 1'][3][2], [{ mealId: nov3.id, isMatterCore: true }]);
  assert.deepEqual(cycle(saved, 'NOV4').boards['Main menu:Week 1'][1][1], []);
});

test('recovery uses exact source occurrence days instead of the shared canonical recipe day', () => {
  const snapshot = { ...meal('NOV3-004'), cycleSource: { cycleId: 'NOV4', sourceMealId: 'NOV4-020', sourceDay: 'DAY 4', sourceDays: ['DAY 4', 'DAY 5'], week: 'Week 1', day: 4 } };
  const recover = value => recoverMealCreationState([{ meals: [{ mealType: 'main', items: [{ cycleMeal: value }] }] }]);
  let saved = recover(snapshot);
  assert.equal(cycle(saved, 'NOV4').meals[0].day, 'DAY 4'); assert.deepEqual(cycle(saved, 'NOV4').meals[0].cycleDays, ['DAY 4', 'DAY 5']);
  snapshot.cycleSource.sourceDay = ''; snapshot.cycleSource.sourceDays = [];
  saved = recover(snapshot); assert.equal(cycle(saved, 'NOV4').meals[0].day, ''); assert.equal(cycle(saved, 'NOV4').meals[0].cycleDays, undefined);
  delete snapshot.cycleSource.sourceDay; delete snapshot.cycleSource.sourceDays;
  assert.equal(cycle(recover(snapshot), 'NOV4').meals[0].day, 'DAY 4');
});

test('repairing empty state retains aliases from deduplicated recovered cycles and remaps their boards', () => {
  const menus = ['NOV3', 'NOV4'].map((id,index) => ({ meals: [{ mealType: 'main', items: [{ cycleMeal: { ...meal(id + '-004', `DAY ${index + 1}`), cycleSource: { workbook: id + '.xlsx', week: 'Week 1', day: index + 1 } } }] }] }));
  const recovered = changeMealCreationState(recoverMealCreationState(menus), {});
  assert.deepEqual(recovered.aliases, [{ from: 'NOV4-004', to: 'NOV3-004' }]);
  const saved = repairMealCreationState({ ...initial(), cycles: [], aliases: [] }, recovered);
  assert.deepEqual(saved.aliases, recovered.aliases);
  assert.equal(cycle(saved, 'NOV4').boards['Main menu:Week 1'][1][1][0].mealId, 'NOV3-004');
  assert.equal(cycle(saved, 'NOV4').meals[0].sourceMealId, 'NOV4-004');
});

test('synthesized migration seeds never override an explicitly saved recovered Main/Sub/Core week', () => {
  const original = meal('NOV3-004');
  const state = { catalogue: { meals: [original], source: 'Nov3.xlsx' }, boards: {}, aliases: [] };
  const recovered = recoverMealCreationState([{ meals: [{ mealType: 'main', items: [{ cycleMeal: { ...original, cycleSource: { workbook: 'Nov3.xlsx', week: 'Week 1', day: 4 } }, rotationCategory: 'sub', usedForCorePlan: true }] }] }]);
  const saved = repairMealCreationState(state, recovered), week = cycle(saved, 'NOV3').boards['Main menu:Week 1'];
  assert.deepEqual(week[3][2], [{ mealId: original.id, isMatterCore: true }]); assert.deepEqual(week[0][1], []);
  state.boards['Main menu:Week 1'] = empty();
  assert.deepEqual(cycle(repairMealCreationState(state, recovered), 'NOV3').boards['Main menu:Week 1'], empty());
});

test('saved original occurrences repair the guessed days of older cross-cycle aliases', () => {
  const canonical = { ...meal('NOV3-004'), cycleDays: ['DAY 1', 'DAY 4'] };
  const state = { catalogue: { meals: [canonical], source: 'Nov4.xlsx' }, boards: {}, aliases: [{ from: 'NOV4-004', to: 'NOV3-004' }] };
  const recovered = recoverMealCreationState([{ meals: [{ mealType: 'main', items: [{ cycleMeal: { ...meal('NOV4-004', 'DAY 4'), cycleSource: { workbook: 'Nov4.xlsx', week: 'Week 1', day: 4 } } }] }] }]);
  const saved = repairMealCreationState(state, recovered), original = cycle(saved, 'NOV4').meals[0];
  assert.equal(original.mealId, canonical.id); assert.equal(original.day, 'DAY 4'); assert.equal(original.cycleDays, undefined);
  assert.deepEqual(saved.aliases, state.aliases);
});

test('exact re-upload replaces unknown alias days without changing saved cycle placements', () => {
  const canonical = { ...meal('NOV3-004'), cycleDays: ['DAY 1', 'DAY 4'] };
  const original = { catalogue: { meals: [canonical], source: 'Nov4.xlsx' }, boards: {}, aliases: [{ from: 'NOV4-004', to: canonical.id }] };
  let saved = changeMealCreationState(original, {}), inferred = cycle(saved, 'NOV4').meals[0];
  assert.equal(inferred.day, ''); assert.equal(inferred.cycleDays, undefined); assert.equal(inferred.inferredDays, true);
  assert.equal(Object.hasOwn(cycle(saved, 'NOV4').boards, 'Main menu:Week 1'), false);
  const manuallySaved = empty(); manuallySaved[4][2] = [{ mealId: canonical.id, isMatterCore: true }];
  saved = changeMealCreationState(saved, { cycleId: 'NOV4', boards: { 'Main menu:Week 1': manuallySaved } });
  saved = upload(saved, [meal('NOV4-004', 'DAY 4')], 'Nov4.xlsx');
  const { recipeSignatures, ...occurrence } = cycle(saved, 'NOV4').meals[0];
  assert.equal(recipeSignatures.length, 1);
  assert.match(recipeSignatures[0], /^[a-f0-9]{64}$/);
  assert.deepEqual(occurrence, { mealId: canonical.id, sourceMealId: 'NOV4-004', day: 'DAY 4' });
  assert.deepEqual(cycle(saved, 'NOV4').boards['Main menu:Week 1'], manuallySaved);
  assert.deepEqual(upload(saved, [meal('NOV4-004', 'DAY 4')], 'Nov4.xlsx'), saved);
});

test('an exact alias re-upload seeds its source day only when no explicit week was previously saved', () => {
  const canonical = meal('NOV3-004');
  const original = { catalogue: { meals: [canonical], source: 'Nov4.xlsx' }, boards: {}, aliases: [{ from: 'NOV4-004', to: canonical.id }] };
  let saved = changeMealCreationState(original, {});
  assert.deepEqual(cycle(saved, 'NOV4').boards, {});
  const inferred = structuredClone(saved);
  saved = upload(saved, [meal('NOV4-004', 'DAY 4')], 'Nov4.xlsx');
  assert.deepEqual(cycle(saved, 'NOV4').boards['Main menu:Week 1'][3][1], [{ mealId: canonical.id, isMatterCore: false }]);
  const explicitEmpty = changeMealCreationState(inferred, { cycleId: 'NOV4', boards: { 'Main menu:Week 1': empty() } });
  assert.deepEqual(cycle(upload(explicitEmpty, [meal('NOV4-004', 'DAY 4')], 'Nov4.xlsx'), 'NOV4').boards['Main menu:Week 1'], empty());
});

test('all inferred rows in one exact re-upload seed when the cycle week was absent before importing', () => {
  const first = meal('NOV3-004'), second = { ...meal('NOV3-005', 'DAY 2'), name: 'Another Chicken' };
  const original = { catalogue: { meals: [first, second], source: 'Nov4.xlsx' }, boards: {}, aliases: [{ from: 'NOV4-004', to: first.id }, { from: 'NOV4-005', to: second.id }] };
  const inferred = changeMealCreationState(original, {});
  const exact = [meal('NOV4-004', 'DAY 4'), { ...meal('NOV4-005', 'DAY 5'), name: 'Another Chicken' }];
  const saved = upload(inferred, exact, 'Nov4.xlsx'), week = cycle(saved, 'NOV4').boards['Main menu:Week 1'];
  assert.deepEqual(week[3][1], [{ mealId: first.id, isMatterCore: false }]);
  assert.deepEqual(week[4][1], [{ mealId: second.id, isMatterCore: false }]);
  assert.deepEqual(upload(saved, exact, 'Nov4.xlsx'), saved);
  const explicit = changeMealCreationState(inferred, { cycleId: 'NOV4', boards: { 'Main menu:Week 1': empty() } });
  assert.deepEqual(cycle(upload(explicit, exact, 'Nov4.xlsx'), 'NOV4').boards['Main menu:Week 1'], empty());
});
