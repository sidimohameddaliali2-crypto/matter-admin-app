import test from 'node:test';
import assert from 'node:assert/strict';
import matter, { buildNutritionResult } from './matterApiService.js';
import { menuNutritionForDate, menuPlanDates } from './menuPlanSchedule.js';
import { validatedMenuSelections } from './menuSelectionValidation.js';
import Menu from '../models/WeeklyMenu.js';
import { resolveSubscriptionContext, previewSkipPauses, applyConfirmedPauses } from './matterPauseResumeService.js';

const monday = '2099-11-02', thursday = '2099-11-05';
const raw = () => ({ subscription_id: 1, customer_id: 8, email: 'member@example.invalid', starting_date: monday,
  cycle_end_date: '2099-11-08', plan: { name: 'Current', meal_frequency: 2 }, allergens: [], exclusions: [],
  delivery_schedule: [monday, thursday].map(date => ({ date, status: 'active' })),
  upcoming_plan: { subscription_id: 2, customer_id: 8, replaces_subscription_id: 1, email: 'member@example.invalid', starting_date: thursday,
    cycle_end_date: '2099-11-08', plan: { name: 'Upcoming', meal_frequency: 3 }, allergens: [], exclusions: [],
    delivery_schedule: [monday, thursday, '2099-11-06'].map(date => ({ date, status: date.endsWith('06') ? 'paused' : 'active' })) } });

test('upcoming start switches plans exactly on Thursday and never opens an early or paused upcoming date', () => {
  const nutrition = buildNutritionResult(raw());
  assert.equal(menuNutritionForDate(nutrition, monday).meal_frequency, 2);
  assert.equal(menuNutritionForDate(nutrition, thursday).meal_frequency, 3);
  assert.deepEqual(menuPlanDates(nutrition), [monday, thursday]);
  assert.throws(() => menuNutritionForDate({ ...nutrition, upcoming_plan: { ...nutrition.upcoming_plan, customer_id: 99 } }, thursday), { statusCode: 409 });
  assert.throws(() => menuNutritionForDate({ ...nutrition, upcoming_plan: { ...nutrition.upcoming_plan, starting_date: null } }, thursday), { statusCode: 409 });
});

test('Matter lookup and dated roster use embedded upcoming detail without calling its unavailable standalone endpoint', async t => {
  t.mock.method(matter, 'listSubscriptions', async () => ({ data: [{ subscription_id: 1, email: 'member@example.invalid', subscription_status: 'active' }] }));
  t.mock.method(matter, 'getSubscription', async id => { assert.equal(id, 1); return { data: raw() }; });
  assert.equal((await matter.getKitchenNutrition({ email: 'member@example.invalid', date: thursday })).subscription_id, 2);
  t.mock.method(matter, 'listAllSubscriptions', async () => [{ subscription_id: 1, subscription_status: 'active', cycle_end_date: monday, upcoming_plan: raw().upcoming_plan }]);
  const rows = await matter.findSubscriptionsWithDeliveryInRange(monday, thursday, { includeKitchenInputs: true });
  assert.deepEqual(rows.map(row => [row.delivery_date, row.subscription_id, row.kitchen_inputs.meal_frequency, row.is_upcoming_plan]), [[monday, 1, 2, false], [thursday, 2, 3, true]]);
});

test('mixed-week submission enforces each date allowance and stamps trusted subscription IDs', async t => {
  const meals = [monday, thursday].map(date => ({ date, mealType: 'main', items: [{ _id: date, itemDate: date, mealName: 'Plain dish', mealType: 'main' }] }));
  t.mock.method(Menu, 'findById', () => ({ populate: () => ({ lean: async () => ({ meals }) }) }));
  const row = (date, quantity) => ({ date, mealType: 'main', menuItemId: date, mealName: 'Plain dish', quantity, matterSubscriptionId: 'forged', isUpcomingPlan: false });
  const args = { menuId: '507f1f77bcf86cd799439011', nutrition: buildNutritionResult(raw()), selections: [row(monday, 2), row(thursday, 3)] };
  const checked = await validatedMenuSelections(args);
  assert.deepEqual(checked.map(meal => [meal.quantity, meal.matterSubscriptionId, meal.isUpcomingPlan]), [[2, '1', false], [3, '2', true]]);
  await assert.rejects(validatedMenuSelections({ ...args, selections: [row(monday, 3)] }), { statusCode: 409 });
  await assert.rejects(validatedMenuSelections({ ...args, selections: [row(thursday, 4)] }), { statusCode: 409 });
  args.nutrition.upcoming_plan.allergens = ['Milk'];
  meals[1].items[0].ingredients = 'Butter';
  await assert.rejects(validatedMenuSelections(args), { statusCode: 409 });
  args.nutrition.upcoming_plan.allergens = null;
  await assert.rejects(validatedMenuSelections(args), { statusCode: 502 });
});


test('upcoming pauses resolve the embedded subscription and never write against the current plan', async t => {
  t.mock.method(matter, 'listSubscriptions', async () => ({ data: [{ subscription_id: 1, subscription_status: 'active' }] }));
  t.mock.method(matter, 'getSubscription', async id => { assert.equal(id, 1); return { data: raw() }; });
  t.mock.method(matter, 'getSubscriptionPauses', async () => ({ paused_days: [], resumed_days: [] }));
  const writes = t.mock.method(matter, 'createSubscriptionPause', async id => { assert.equal(id, 2); });
  const context = await resolveSubscriptionContext({ matterCustomerId: 8, date: thursday });
  assert.equal(context.subscriptionId, 2);
  const preview = await previewSkipPauses({ matterCustomerId: 8, skippedDateKeys: [monday, thursday] });
  assert.deepEqual(preview.pauses.map(pause => [pause.date, pause.subscriptionId]), [[monday, 1], [thursday, 2]]);
  const result = await applyConfirmedPauses({ subscriptionId: 2, matterCustomerId: 8, decisions: [{ date: thursday, resumeDate: '2099-12-01' }] });
  assert.equal(result[0].pauseStatus, 'success');
  assert.equal(writes.mock.callCount(), 1);
  const blocked = await applyConfirmedPauses({ subscriptionId: 1, matterCustomerId: 8, decisions: [{ date: monday, resumeDate: thursday }] });
  assert.equal(blocked[0].pauseStatus, 'failed');
  assert.equal(writes.mock.callCount(), 1);
});


test('Saturday skip includes Sunday starting the upcoming plan and its existing pause state', async t => {
  const saturday = '2026-11-28', sunday = '2026-11-29';
  const source = raw();
  Object.assign(source, { starting_date: '2026-11-01', cycle_end_date: saturday, delivery_schedule: [{ date: saturday, status: 'active' }] });
  Object.assign(source.upcoming_plan, { starting_date: sunday, cycle_end_date: '2026-12-10', delivery_schedule: [{ date: sunday, status: 'paused' }], pauses: { paused_days: [sunday], resumed_days: ['2026-12-07'] } });
  t.mock.method(matter, 'listSubscriptions', async () => ({ data: [{ subscription_id: 1, subscription_status: 'active' }] }));
  t.mock.method(matter, 'getSubscription', async () => ({ data: source }));
  t.mock.method(matter, 'getSubscriptionPauses', async id => id === 2 ? source.upcoming_plan.pauses : { paused_days: [], resumed_days: [] });
  const preview = await previewSkipPauses({ matterCustomerId: 8, skippedDateKeys: [saturday] });
  assert.deepEqual(preview.pauses.map(pause => [pause.date, pause.subscriptionId, pause.alreadyPaused]), [[saturday, 1, false], [sunday, 2, true]]);
  assert.ok(preview.unavailableDates.includes('2026-12-07'));
});

test('a changed start date rechecks the subscription for every pause decision before any write', async t => {
  const nutrition = buildNutritionResult(raw());
  t.mock.method(matter, 'getKitchenNutrition', async () => nutrition);
  const writes = t.mock.method(matter, 'createSubscriptionPause', async () => {});
  const result = await applyConfirmedPauses({ subscriptionId: 1, matterCustomerId: 8, decisions: [
    { date: monday, resumeDate: '2099-12-01' }, { date: thursday, resumeDate: '2099-12-02' },
  ] });
  assert.ok(result.every(row => row.pauseStatus === 'failed'));
  assert.equal(writes.mock.callCount(), 0);
});


test('a sparse upcoming list summary still loads authoritative detail after the current cycle ends', async t => {
  const source = raw(); source.cycle_end_date = monday;
  t.mock.method(matter, 'listAllSubscriptions', async () => [{ subscription_id: 1, subscription_status: 'active', cycle_end_date: monday,
    upcoming_plan: { subscription_id: 2, starting_date: thursday } }]);
  const read = t.mock.method(matter, 'getSubscription', async id => { assert.equal(id, 1); return { data: source }; });
  const rows = await matter.findSubscriptionsWithDeliveryInRange(thursday, thursday, { includeKitchenInputs: true });
  assert.equal(read.mock.callCount(), 1);
  assert.deepEqual(rows.map(row => row.subscription_id), [2]);
  assert.equal(rows[0].kitchen_inputs.meal_frequency, 3);
});

test('unknown upcoming exclusions fail before catalogue lookup instead of becoming empty restrictions', async t => {
  const source = raw(); delete source.upcoming_plan.exclusions;
  t.mock.method(Menu, 'findById', () => assert.fail('Must reject unknown exclusions before catalogue lookup'));
  await assert.rejects(validatedMenuSelections({ menuId: '507f1f77bcf86cd799439011', nutrition: buildNutritionResult(source),
    selections: [{ date: thursday, mealType: 'main', menuItemId: 'dish', mealName: 'Beef', quantity: 1 }] }),
  { statusCode: 502, code: 'MATTER_EXCLUSIONS_UNAVAILABLE' });
});

test('upcoming plan requires a distinct subscription ID and an exact replacement link', () => {
  for (const changes of [{ replaces_subscription_id: undefined }, { replaces_subscription_id: null }, { replaces_subscription_id: 99 }, { subscription_id: 1 }]) {
    const source = raw(); Object.assign(source.upcoming_plan, changes);
    assert.throws(() => menuNutritionForDate(buildNutritionResult(source), thursday), { statusCode: 409 });
  }
});


test('a paused upcoming calendar date stays already paused when the standalone pause endpoint is unavailable', async t => {
  const source = raw();
  source.upcoming_plan.delivery_schedule = [{ date: thursday, status: 'paused' }];
  delete source.upcoming_plan.pauses;
  t.mock.method(console, 'error', () => {});
  t.mock.method(matter, 'listSubscriptions', async () => ({ data: [{ subscription_id: 1, subscription_status: 'active' }] }));
  t.mock.method(matter, 'getSubscription', async () => ({ data: source }));
  t.mock.method(matter, 'getSubscriptionPauses', async () => { throw Object.assign(new Error('Not available until activation'), { response: { status: 404 } }); });
  const context = await resolveSubscriptionContext({ matterCustomerId: 8, date: thursday });
  assert.equal(context.subscriptionId, 2);
  assert.equal(context.existingPaused.has(thursday), true);
  const preview = await previewSkipPauses({ matterCustomerId: 8, skippedDateKeys: [thursday] });
  assert.deepEqual(preview.pauses.map(row => [row.date, row.subscriptionId, row.alreadyPaused]), [[thursday, 2, true]]);
});
