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

test('a saved allergy conflict after cutoff returns a read-only customer preview', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-26T14:00:00Z') });
  const date = '2026-11-26';
  const query = value => ({ select() { return this; }, sort() { return this; }, populate() { return this; }, lean: async () => value });
  const selection = { _id: 'record', matterCustomerId: 'person', email: 'fixture@example.invalid',
    selectedMeals: [{ date, mealType: 'main', mealName: 'Peanut chicken', isAutoAssigned: false }] };
  t.mock.method(Menu, 'findById', () => query({ meals: [] }));
  t.mock.method(Record, 'find', () => query([selection]));
  t.mock.method(Record, 'updateOne', () => assert.fail('A preview must not alter the saved choice'));
  t.mock.method(Archive, 'find', () => query([]));
  t.mock.method(MenuItem, 'find', () => query([]));
  t.mock.method(Breakfast, 'findOne', () => query(null));
  t.mock.method(Snack, 'findOne', () => query(null));
  t.mock.method(matterApiService, 'findSubscriptionsWithDeliveryOnDate', () => assert.fail('Reuse the verified roster'));
  let job, finish;
  const saved = new Promise(resolve => { finish = resolve; });
  t.mock.method(Snapshot, 'findOne', filter => query(job && (filter._id || filter.status === job.status) ? job : null));
  t.mock.method(Snapshot, 'create', async values => {
    job = { ...values, _id: '507f1f77bcf86cd799439011', createdAt: new Date() };
    return job;
  });
  t.mock.method(Snapshot, 'updateOne', async (_filter, update) => { Object.assign(job, update.$set); finish(); });
  const kitchenInputs = [{ customer_id: 'person', customer_email: selection.email, allergyProfile: { allergies: ['Peanuts'] } }];
  const kitchenRoster = [{ customer_id: 'person', email: selection.email }];
  const started = await beginKitchenState('menu', date, async () => {
    throw Object.assign(new Error('Peanut chicken conflicts with recorded allergies (Peanuts).'), {
      code: 'KITCHEN_ALLERGY_REVIEW', kitchenAllergyInputs: { kitchenInputs, kitchenRoster },
    });
  });
  await saved;
  const result = await readKitchenState('menu', date, started.jobId, { verifyAllergies: true });
  assert.equal(result.state, 'allergy-review');
  assert.equal(result.data.selectionWindow.canAutoAssign, true);
  assert.deepEqual(result.data.data.kitchenSelections, [selection]);
  assert.match(result.data.data.kitchenAllergyReview, /Peanut chicken.*Peanuts/);
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
