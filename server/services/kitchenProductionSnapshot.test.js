import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotIsFresh } from './kitchenProductionSnapshot.js';
import { beginKitchenState, readKitchenState } from './kitchenProductionSnapshot.js';
import Snapshot from '../models/KitchenProductionSnapshot.js';
import Menu from '../models/WeeklyMenu.js';
import Record from '../models/MenuSelectionRecord.js';
import Archive from '../models/MenuSelectionArchive.js';
import MenuItem from '../models/MenuItem.js';
import Breakfast from '../models/KitchenBreakfastPreset.js';
import Snack from '../models/KitchenSnackPreset.js';
import MealCreationState from '../models/MealCreationState.js';
import { loadFallbackSnackRecipes } from './kitchenFallbackSnacks.js';
import matterApiService from './matterApiService.js';
import { withMenuAllergyProfiles } from './menuAllergyProfileService.js';
import { confirmKitchenAllergy } from './kitchenAllergyConfirmations.js';

test('a production snapshot is invalidated by source edits, expiry, failure or a future timestamp', () => {
  const now = Date.now();
  const snapshot = { status: 'ready', sourceVersion: 'revision', updatedAt: new Date(now - 1000) };
  assert.equal(snapshotIsFresh(snapshot, 'revision', now), true);
  assert.equal(snapshotIsFresh(snapshot, 'different', now), false);
  assert.equal(snapshotIsFresh({ ...snapshot, status: 'failed' }, 'revision', now), false);
  assert.equal(snapshotIsFresh({ ...snapshot, updatedAt: new Date(now - 61000) }, 'revision', now), false);
  assert.equal(snapshotIsFresh({ ...snapshot, updatedAt: new Date(now + 1) }, 'revision', now), false);
});

test('background preparation publishes one source version and an input edit invalidates it', async (t) => {
  const query = value => ({ select() { return this; }, sort() { return this; }, populate() { return this; }, lean: async () => value });
  const menu = { meals: [], updatedAt: new Date('2026-10-28T10:00:00Z') };
  t.mock.method(Menu, 'findById', () => query(menu));
  t.mock.method(Record, 'find', () => query([]));
  t.mock.method(Archive, 'find', () => query([]));
  t.mock.method(MenuItem, 'find', () => query([]));
  t.mock.method(Breakfast, 'findOne', () => query(null));
  t.mock.method(Snack, 'findOne', () => query(null));
  let matterAllergies = [];
  const readMatter = t.mock.method(matterApiService, 'getSubscription', async id => ({ data: {
    subscription_id: id, customer_id: 'person', allergens: matterAllergies,
    delivery_schedule: [{ status: 'active', date: '2026-10-30' }],
  } }));
  let job, finish;
  const saved = new Promise(resolve => { finish = resolve; });
  t.mock.method(Snapshot, 'findOne', filter => query(job && (filter._id || filter.status === job.status) ? job : null));
  t.mock.method(Snapshot, 'create', async values => {
    job = { ...values, _id: '507f1f77bcf86cd799439011', createdAt: new Date(), save: async () => { job.updatedAt = new Date(); finish(); } };
    return job;
  });
  let preparations = 0;
  const prepare = async () => {
    preparations++;
    const kitchenInputs = withMenuAllergyProfiles([{ customer_id: 'person', subscription_id: 'subscription', allergens: [] }]);
    return { data: { kitchenRoster: [], kitchenInputs, rosterComplete: true } };
  };
  const started = await beginKitchenState('menu', '2026-10-30', prepare);
  assert.equal(started.state, 'running');
  await saved;
  const ready = await readKitchenState('menu', '2026-10-30');
  assert.equal(ready.state, 'ready');
  assert.equal(ready.data.snapshotId, String(job._id));
  assert.equal(preparations, 1);
  assert.equal(readMatter.mock.callCount(), 0);
  const exportOptions = { verifyAllergies: true };
  assert.equal((await readKitchenState('menu', '2026-10-30', job._id, exportOptions)).state, 'ready');
  matterAllergies = [{ title: 'Peanuts' }];
  const exportCheck = await readKitchenState('menu', '2026-10-30', job._id, exportOptions);
  assert.equal(exportCheck.state, 'stale');
  assert.match(exportCheck.message, /Matter allergies/);
  assert.equal((await readKitchenState('menu', '2026-10-30', undefined, exportOptions)).state, 'stale');
  matterAllergies = [];
  const refresh = await beginKitchenState('menu', '2026-10-30', prepare, { refresh: true });
  assert.equal(refresh.state, 'running', 'explicit refresh bypasses the cached ready snapshot');
  const joined = await beginKitchenState('menu', '2026-10-30', () => assert.fail('Do not duplicate the running preparation'), { refresh: true });
  assert.equal(joined.jobId, refresh.jobId);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(preparations, 2);
  assert.equal((await readKitchenState('menu', '2026-10-30')).state, 'ready');
  menu.updatedAt = new Date('2026-10-28T10:01:00Z');
  assert.equal((await readKitchenState('menu', '2026-10-30')).state, 'missing');
});

for (const upcoming of [false, true]) test(`after cutoff every saved conflict must be confirmed, then an ingredient change requires a new review (upcoming: ${upcoming})`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-26T14:00:00Z') });
  const date = '2026-11-26';
  const id = num => String(num).padStart(24, '0');
  const menuId = id(1);
  const query = value => ({ select() { return this; }, sort() { return this; }, populate() { return this; }, lean: async () => value });
  const item = { _id: id(2), itemDate: date, mealType: 'main', mealName: 'Peanut chicken',
    rotationCategory: 'main', cycleMeal: { allergens: ['Peanuts'] } };
  const selection = { _id: id(3), matterCustomerId: '42', email: 'fixture@example.invalid',
    selectedMeals: [4, 5].map(slot => ({ _id: id(slot), date, mealType: 'main', mealName: item.mealName, slotNumber: slot,
      menuItemId: item._id, isAutoAssigned: false })) };
  t.mock.method(Menu, 'findById', () => query({ meals: [{ items: [item._id] }] }));
  t.mock.method(Record, 'find', () => query([selection]));
  t.mock.method(Record, 'findOne', filter => {
    assert.equal(filter._id, selection._id);
    assert.equal(filter.weeklyMenuId, menuId);
    assert.ok(selection.selectedMeals.some(meal => meal._id === filter['selectedMeals._id']));
    return query(selection);
  });
  const writes = t.mock.method(Record, 'updateOne', async (filter, update) => {
    const entry = update.$push.kitchenAllergyConfirmations;
    assert.equal(filter['kitchenAllergyConfirmations.fingerprint'].$ne, entry.fingerprint);
    assert.deepEqual(Object.keys(update.$push), ['kitchenAllergyConfirmations']);
    (selection.kitchenAllergyConfirmations ??= []).push(entry);
    return { modifiedCount: 1 };
  });
  t.mock.method(Archive, 'find', () => query([]));
  t.mock.method(MenuItem, 'find', () => query([item]));
  t.mock.method(Breakfast, 'findOne', () => query(null));
  t.mock.method(Snack, 'findOne', () => query(null));
  t.mock.method(matterApiService, 'findSubscriptionsWithDeliveryOnDate', () => assert.fail('Reuse the verified roster'));
  const input = { customer_id: '42', subscription_id: '45', allergens: ['Peanuts'], customer_email: selection.email,
    is_upcoming_plan: upcoming, source_parent_subscription_id: upcoming ? '44' : null };
  t.mock.method(matterApiService, 'listSubscriptions', async () => ({ data: [{ subscription_id: upcoming ? '44' : '45', subscription_status: 'active' }] }));
  t.mock.method(matterApiService, 'getSubscription', async subscriptionId => {
    assert.equal(String(subscriptionId), upcoming ? '44' : '45', 'Scheduled standalone detail must not be used');
    const detail = { ...input, email: selection.email, delivery_schedule: [{ date, status: 'active' }] };
    return { data: upcoming ? { ...detail, subscription_id: '44', allergens: [], upcoming_plan: {
      ...detail, replaces_subscription_id: '44', starting_date: date, cycle_end_date: '2026-12-10',
    } } : detail };
  });
  let job;
  t.mock.method(Snapshot, 'findOne', filter => query(job && (filter._id || filter.status === job.status) ? job : null));
  t.mock.method(Snapshot, 'create', async values => {
    job = { ...values, _id: '507f1f77bcf86cd799439011', createdAt: new Date(), save: async () => { job.updatedAt = new Date(); } };
    return job;
  });
  t.mock.method(Snapshot, 'updateOne', async (_filter, update) => { Object.assign(job, update.$set); });
  const prepare = async () => ({ data: { kitchenInputs: withMenuAllergyProfiles([input]),
    kitchenRoster: [{ customer_id: '42', email: selection.email, meal_frequency: 2 }], rosterComplete: true } });
  const read = async () => {
    const started = await beginKitchenState(menuId, date, prepare);
    assert.equal(started.state, 'running');
    await new Promise(resolve => setImmediate(resolve));
    return readKitchenState(menuId, date, started.jobId, { verifyAllergies: true });
  };
  const result = await read();
  assert.equal(result.state, 'allergy-review');
  assert.equal(result.data.selectionWindow.canAutoAssign, true);
  const [first, second] = result.data.data.kitchenAllergyCases;
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.match(first.message, /Peanut chicken.*Peanuts/);
  assert.equal(result.data.data.kitchenSelections[0].selectedMeals[0].kitchenAllergyCases[0].fingerprint, first.fingerprint);
  const confirm = (item, note = 'Kitchen will use the verified allergen-free preparation.') => confirmKitchenAllergy({
    menuId, customerId: item.customerId, body: { ...item, note, actorName: 'untrusted' },
    user: { _id: 'staff-1', profile: { firstName: 'Kitchen', lastName: 'Lead' } },
  });
  await assert.rejects(confirm(first, ' '), { statusCode: 400 });
  await assert.rejects(confirm({ ...first, fingerprint: second.fingerprint }), { statusCode: 409 });
  assert.equal((await confirm(first)).actorName, 'Kitchen Lead');
  assert.equal((await confirm(first)).actorName, 'Kitchen Lead');
  assert.equal(writes.mock.callCount(), 1);
  assert.equal(selection.kitchenAllergyConfirmations[0].actorId, 'staff-1');
  const partial = await read();
  assert.equal(partial.state, 'allergy-review');
  assert.match(partial.data.data.kitchenAllergyReview, /^1 saved/);
  assert.equal(partial.data.data.kitchenSelections[0].kitchenAllergyConfirmations, undefined);
  await confirm(second);
  const ready = await read();
  assert.equal(ready.state, 'ready');
  assert.ok(ready.data.data.kitchenAllergyCases.every(item => item.confirmation));
  item.cycleMeal.ingredients = ['New ingredient'];
  await assert.rejects(confirm(second), { statusCode: 409 });
  assert.equal((await read()).state, 'allergy-review');
});

for (const planName of ['Custom', 'Matter Core']) test(`a ready paper rechecks fallback recipe changes and applicable exclusions (${planName})`, async t => {
  const date = '2026-11-26';
  t.mock.timers.enable({ apis: ['Date'], now: new Date(`${date}T14:00:00Z`) });
  const query = value => ({ select() { return this; }, sort() { return this; }, populate() { return this; }, lean: async () => value });
  const recipe = { id: 'cake', name: 'CHEESECAKE BITES', mealKind: 'Snack', ingredients: ['Milk'] };
  t.mock.method(MealCreationState, 'findById', () => query({ catalogue: { meals: [recipe] } }));
  const [fallback] = await loadFallbackSnackRecipes();
  const selectedMeals = [{ date, mealType: 'snack', mealName: fallback.name, isAutoAssigned: true,
    fallbackSnackRecipeId: fallback.fallbackSnackRecipeId, fallbackSnackRecipeVersion: fallback.fallbackSnackRecipeVersion }];
  t.mock.method(Menu, 'findById', () => query({ meals: [] }));
  t.mock.method(Record, 'find', () => query([{ _id: 'saved', email: 'person@example.invalid', matterCustomerId: 'person', selectedMeals }]));
  t.mock.method(Archive, 'find', () => query([]));
  t.mock.method(MenuItem, 'find', () => query([]));
  t.mock.method(Breakfast, 'findOne', () => query(null));
  t.mock.method(Snack, 'findOne', () => query(null));
  let currentExclusions = [];
  let currentPlan = planName;
  t.mock.method(matterApiService, 'getSubscription', async id => ({ data: { subscription_id: id, customer_id: 'person',
    allergens: [], plan: { name: currentPlan }, exclusions: currentExclusions, delivery_schedule: [{ status: 'active', date }] } }));
  let job, finish;
  const saved = new Promise(resolve => { finish = resolve; });
  t.mock.method(Snapshot, 'findOne', filter => query(job && (filter._id || filter.status === job.status) ? job : null));
  t.mock.method(Snapshot, 'create', async values => {
    job = { ...values, _id: '507f1f77bcf86cd799439011', createdAt: new Date(), save: async () => { job.updatedAt = new Date(); finish(); } };
    return job;
  });
  const input = { customer_id: 'person', subscription_id: 'sub', plan_name: planName, allergens: [], exclusions: [] };
  const started = await beginKitchenState('menu', date, async () => ({ data: {
    kitchenRoster: [], kitchenInputs: withMenuAllergyProfiles([input]), rosterComplete: true,
  } }));
  await saved;
  const read = () => readKitchenState('menu', date, started.jobId, { verifyAllergies: true });
  assert.equal((await read()).state, 'ready');
  currentExclusions = [{ title: 'Milk' }];
  if (planName === 'Matter Core') {
    assert.equal((await read()).state, 'ready');
    currentPlan = 'Custom';
    assert.equal((await read()).state, 'stale');
    currentPlan = planName;
  } else assert.match((await read()).message, /Matter allergies, exclusions, or delivery status changed/);
  currentExclusions = [];
  recipe.ingredients.push('Peanuts');
  const latest = await read();
  assert.equal(latest.state, 'stale');
  assert.match(latest.message, /no matching verified fallback recipe/);
});
