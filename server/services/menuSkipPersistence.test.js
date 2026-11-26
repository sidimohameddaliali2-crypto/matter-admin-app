import test from 'node:test';
import assert from 'node:assert/strict';
import router from '../routes/menus.js';
import Customer from '../models/Customer.js';
import MenuSelectionRecord from '../models/MenuSelectionRecord.js';
import matter, { buildNutritionResult } from './matterApiService.js';
import WeeklyMenu from '../models/WeeklyMenu.js';

const source = {
  subscription_id: 'current', customer_name: 'Customer', customer_id: 'matter-person',
  customer_email: 'customer@example.com', active_delivery_dates: ['2026-11-16'], exclusions: [], allergens: [],
};
const savedRecord = () => ({ _id: 'record', weeklyMenuId: 'menu', matterSubscriptionId: 'current', selectedMeals: [],
  skippedDays: [{ date: '2026-11-16', pauseStatus: 'success', subscriptionId: 'current', resumeDate: '2026-12-11' }],
});
const confirmActive = (t) => t.mock.method(matter, 'getSubscription', async () => ({ data: {
  subscription_id: 'current', delivery_schedule: [{ date: '2026-11-16', status: 'active' }],
} }));

test('reopening a confirmed skip after a Matter admin unpause returns an unlocked delivery day', async (t) => {
  confirmActive(t);
  const record = savedRecord();
  t.mock.method(matter, 'getKitchenNutrition', async () => source);
  t.mock.method(Customer, 'find', () => ({ select: () => ({ lean: async () => [] }) }));
  t.mock.method(MenuSelectionRecord, 'findOne', () => ({ lean: async () => record }));
  t.mock.method(MenuSelectionRecord, 'updateOne', async () => ({ matchedCount: 1 }));
  const handler = router.stack.find(layer => layer.route?.path === '/customers/:email/subscription-profile').route.stack[0].handle;
  let body;
  const res = { json(value) { body = value; }, status() { return this; } };
  await handler({ params: { email: source.customer_email }, query: { menuId: 'menu' } }, res);
  assert.equal(body.success, true);
  assert.deepEqual(body.data.skippedDays, []);
  assert.deepEqual(body.data.deliveryDates, ['2026-11-16']);
  assert.deepEqual(body.data.restoredSkipDates, ['2026-11-16']);
});

test('sign-in retains a pause confirmed between the initial calendar fetch and saved-record read', async (t) => {
  const order = [];
  const record = savedRecord();
  record.skippedDays[0].processedAt = new Date('2026-11-12T09:00:01Z');
  t.mock.method(matter, 'getKitchenNutrition', async () => {
    order.push('initial-calendar');
    return { ...source, source_fetched_at: '2026-11-12T09:00:00Z' };
  });
  t.mock.method(Customer, 'find', () => ({ select: () => ({ lean: async () => [] }) }));
  t.mock.method(MenuSelectionRecord, 'findOne', () => ({ lean: async () => {
    order.push('newly-confirmed-pause');
    return record;
  } }));
  t.mock.method(matter, 'getSubscription', async () => {
    order.push('confirm-calendar');
    return { data: { subscription_id: 'current', delivery_schedule: [{ date: '2026-11-16', status: 'paused' }] } };
  });
  t.mock.method(MenuSelectionRecord, 'updateOne', () => assert.fail('The newly confirmed pause must not be removed'));
  const handler = router.stack.find(layer => layer.route?.path === '/customers/:email/subscription-profile').route.stack[0].handle;
  const res = { json(body) { this.body = body; }, status() { return this; } };
  await handler({ params: { email: source.customer_email }, query: { menuId: 'menu' } }, res);
  assert.deepEqual(order, ['initial-calendar', 'newly-confirmed-pause', 'confirm-calendar']);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.skippedDays[0].pauseStatus, 'success');
  assert.deepEqual(res.body.data.deliveryDates, []);
  assert.deepEqual(res.body.data.restoredSkipDates, []);
});

test('an old tab cannot silently resubmit a confirmed skip after an admin unpause', async (t) => {
  confirmActive(t);
  const record = savedRecord();
  t.mock.method(matter, 'getKitchenNutrition', async () => source);
  t.mock.method(MenuSelectionRecord, 'findOne', () => ({ select: () => ({ lean: async () => record }) }));
  t.mock.method(MenuSelectionRecord, 'updateOne', async () => ({ matchedCount: 1 }));
  const save = t.mock.method(MenuSelectionRecord, 'findOneAndUpdate', () => assert.fail('Must not overwrite meals'));
  const pause = t.mock.method(matter, 'createSubscriptionPause', () => assert.fail('Must not repause Matter'));
  const handler = router.stack.find(layer => layer.route?.path === '/customers/:email/select-meals').route.stack[0].handle;
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  await handler({ params: { email: source.customer_email }, body: { weeklyMenuId: '507f1f77bcf86cd799439012', selections: [], skippedDates: ['2026-11-16'], pauseDecisions: [{ date: '2026-11-16', action: 'pause', alreadyPaused: true }] } }, res);
  assert.equal(res.code, 409);
  assert.match(res.body.message, /unpaused in Matter/);
  assert.equal(save.mock.callCount(), 0);
  assert.equal(pause.mock.callCount(), 0);
});

test('meals on an admin-unpaused date still open for selection are saved instead of discarded as a prior skip', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-13T10:00Z') });
  confirmActive(t);
  const record = savedRecord();
  t.mock.method(matter, 'getKitchenNutrition', async () => source);
  t.mock.method(MenuSelectionRecord, 'findOne', () => ({ select: () => ({ lean: async () => record }) }));
  t.mock.method(MenuSelectionRecord, 'updateOne', async () => ({ matchedCount: 1 }));
  let stored;
  t.mock.method(MenuSelectionRecord, 'findOneAndUpdate', async (_, update) => { stored = update.$set; return {}; });
  t.mock.method(MenuSelectionRecord, 'countDocuments', async () => 1);
  t.mock.method(WeeklyMenu, 'findByIdAndUpdate', async () => ({}));
  t.mock.method(WeeklyMenu, 'findById', () => ({ populate: () => ({ lean: async () => ({ meals: [{ date: '2026-11-16', mealType: 'main', items: [{ mealName: 'Chicken', mealType: 'main' }] }] }) }) }));
  t.mock.method(Customer, 'find', () => ({ select: () => ({ lean: async () => [] }) }));
  const handler = router.stack.find(layer => layer.route?.path === '/customers/:email/select-meals').route.stack[0].handle;
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  await handler({ params: { email: source.customer_email }, body: { weeklyMenuId: '507f1f77bcf86cd799439012', skippedDates: [], selections: [{ date: '2026-11-16', mealType: 'main', mealName: 'Chicken', quantity: 1 }] } }, res);
  assert.equal(res.body.success, true);
  assert.deepEqual(stored.skippedDays, []);
  assert.equal(stored.selectedMeals[0].mealName, 'Chicken');
});

test('the menu profile restores a submission consisting entirely of skipped days', async (t) => {
  const skippedDays = ['2026-10-28', '2026-10-30', '2026-10-31'].map((date) => ({ date, pauseStatus: 'success' }));
  const customer = { _id: 'customer', email: 'customer@example.com', selectedMeals: [], weekend: false };
  t.mock.method(matter, 'getKitchenNutrition', async () => ({
    subscription_id: 'current', customer_name: 'Customer', customer_id: 'matter-person', customer_email: 'customer@example.com', active_delivery_dates: [],
    weekend_enabled: true, exclusions: [], allergens: ['Milk'],
  }));
  t.mock.method(Customer, 'findOne', () => ({ select: async () => customer }));
  t.mock.method(Customer, 'findById', async () => customer);
  t.mock.method(Customer, 'find', () => assert.fail('Internal allergies must never be read'));
  t.mock.method(MenuSelectionRecord, 'findOne', () => ({ lean: async () => ({ selectedMeals: [], skippedDays }) }));
  const handler = router.stack.find((layer) => layer.route?.path === '/customers/:email/subscription-profile').route.stack[0].handle;
  let response;
  const res = { json: (value) => { response = value; }, status: () => res };
  await handler({ params: { email: 'customer@example.com' }, query: { menuId: 'menu' } }, res);
  assert.equal(response.success, true);
  assert.equal(response.data.hasSubmittedForRequestedMenu, true);
  assert.deepEqual(response.data.skippedDays, skippedDays);
  assert.equal(response.data.weekend, true);
  assert.deepEqual(response.data.allergies, ['Milk']);
  assert.equal(response.data.allergiesAvailable, true);
});

test('an incomplete set of resume dates is rejected before saving meals or writing any Matter pauses', async (t) => {
  const menuId = '507f1f77bcf86cd799439012';
  const customer = { _id: 'customer', email: 'customer@example.com' };
  t.mock.method(matter, 'getKitchenNutrition', async () => ({ subscription_id: 'current', customer_name: 'Customer', customer_id: 'matter-person',
    customer_email: 'customer@example.com', active_delivery_dates: ['2026-10-31', '2026-11-01'] }));
  t.mock.method(matter, 'getSubscription', async () => ({ data: { subscription_id: 'current', cycle_end_date: '2026-11-11', delivery_schedule: [
    { date: '2026-10-31', status: 'active' }, { date: '2026-11-01', status: 'active' },
  ] } }));
  t.mock.method(matter, 'listSubscriptions', async () => ({ data: [{ subscription_id: 'current', customer_id: 'matter-person', subscription_status: 'active' }] }));
  t.mock.method(matter, 'getSubscriptionPauses', async () => ({}));
  t.mock.method(Customer, 'findOne', () => ({ select: async () => customer }));
  t.mock.method(MenuSelectionRecord, 'findOne', () => ({ select: () => ({ lean: async () => null }) }));
  const save = t.mock.method(MenuSelectionRecord, 'findOneAndUpdate', async () => ({}));
  const pause = t.mock.method(matter, 'createSubscriptionPause', async () => ({}));
  const handler = router.stack.find((layer) => layer.route?.path === '/customers/:email/select-meals').route.stack[0].handle;
  let response;
  let status;
  const res = { json: (value) => { response = value; }, status: (value) => { status = value; return res; } };
  await handler({ params: { email: 'customer@example.com' }, body: {
    weeklyMenuId: menuId, selections: [], skippedDates: ['2026-10-28', '2026-10-30', '2026-10-31'],
    pauseDecisions: [
      { date: '2026-10-28', action: 'pause', resumeDate: '2026-11-12' },
      { date: '2026-10-30', action: 'pause', resumeDate: '2026-11-13' },
    ],
  } }, res);
  assert.equal(status, 400);
  assert.equal(response.success, false);
  assert.match(response.message, /2026-10-31/);
  assert.equal(save.mock.callCount(), 0);
  assert.equal(pause.mock.callCount(), 0);
  // An older client cannot submit Saturday without a replacement for Sunday.
  await handler({ params: { email: 'customer@example.com' }, body: {
    weeklyMenuId: menuId, selections: [], skippedDates: ['2026-10-31'],
    pauseDecisions: [{ date: '2026-10-31', action: 'pause', resumeDate: '2026-11-12' }],
  } }, res);
  assert.equal(status, 400);
  assert.match(response.message, /2026-11-01/);
  assert.equal(save.mock.callCount(), 0);
  assert.equal(pause.mock.callCount(), 0);
});


for (const [restored, activated] of [[false, false], [true, false], [false, true], [true, true]]) test(`upcoming pause is rechecked after loading the record (restored=${restored}, activated=${activated})`, async t => {
  const date = '2099-11-05';
  const raw = { subscription_id: 'current', customer_id: 'person', email: 'customer@example.com', plan: { meal_frequency: 2 }, allergens: [], exclusions: [], delivery_schedule: [],
    upcoming_plan: { subscription_id: 'next', replaces_subscription_id: 'current', customer_id: 'person', starting_date: date, plan: { meal_frequency: 3 }, allergens: [], exclusions: [], delivery_schedule: [{ date, status: 'active' }] } };
  const initial = buildNutritionResult(raw);
  const skippedDays = [{ date, subscriptionId: 'next', pauseStatus: 'success', processedAt: new Date() }];
  t.mock.method(matter, 'getKitchenNutrition', async () => initial);
  const updated = { ...raw.upcoming_plan, delivery_schedule: [{ date, status: restored ? 'active' : 'paused' }] };
  const read = t.mock.method(matter, 'getSubscription', async id => {
    if (id === 'next') {
      if (activated) return { data: { ...updated, subscription_status: 'active' } };
      throw Object.assign(new Error('Scheduled renewal has no standalone detail'), { response: { status: 404 } });
    }
    assert.equal(id, 'current');
    // After activation this copy may still advertise the wrong active state.
    return { data: { ...raw, upcoming_plan: activated ? raw.upcoming_plan : updated } };
  });
  t.mock.method(MenuSelectionRecord, 'findOne', () => ({ lean: async () => ({ _id: 'record', selectedMeals: [], skippedDays, weeklyMenuId: 'menu' }) }));
  const update = t.mock.method(MenuSelectionRecord, 'updateOne', async (_, write) => { assert.equal(write.$push.unpausedDays.subscriptionId, 'next'); return { matchedCount: 1 }; });
  const handler = router.stack.find(layer => layer.route?.path === '/customers/:email/subscription-profile').route.stack[0].handle;
  let response;
  const res = { json: value => { response = value; }, status: () => res };
  await handler({ params: { email: 'customer@example.com' }, query: { menuId: 'menu' } }, res);
  assert.equal(response.success, true);
  assert.equal(response.data.skippedDays.length, restored ? 0 : 1);
  assert.deepEqual(read.mock.calls.map(call => call.arguments[0]), activated ? ['next'] : ['next', 'current']);
  assert.equal(response.data.restoredSkipDates.includes(date), restored);
  assert.equal(update.mock.callCount(), restored ? 1 : 0);
});


test('pauses stay bound to the previewed subscription when a renewal is booked', async t => {
  const date = '2099-11-05';
  const raw = { subscription_id: 'current', customer_id: 'matter-person', email: source.customer_email, plan: { meal_frequency: 2 },
    allergens: [], exclusions: [], delivery_schedule: [{ date, status: 'active' }],
    upcoming_plan: { subscription_id: 'next', replaces_subscription_id: 'current', customer_id: 'matter-person', email: source.customer_email,
      starting_date: date, cycle_end_date: '2099-11-20', plan: { meal_frequency: 3 }, allergens: [], exclusions: [], delivery_schedule: [{ date, status: 'active' }] } };
  const initial = buildNutritionResult({ ...raw, upcoming_plan: null });
  const latest = buildNutritionResult(raw);
  let reads = 0, stored = null;
  t.mock.method(matter, 'getKitchenNutrition', async () => ++reads === 1 ? initial : latest);
  t.mock.method(matter, 'listSubscriptions', async () => ({ data: [{ subscription_id: 'current', subscription_status: 'active' }] }));
  t.mock.method(matter, 'getSubscription', async id => { assert.equal(id, 'current'); return { data: raw }; });
  t.mock.method(matter, 'getSubscriptionPauses', async () => ({ paused_days: [], resumed_days: [] }));
  const writes = t.mock.method(matter, 'createSubscriptionPause', async () => ({}));
  t.mock.method(MenuSelectionRecord, 'findOne', () => ({ select() { return this; }, lean: async () => stored }));
  t.mock.method(MenuSelectionRecord, 'findOneAndUpdate', async (_, update) => { stored = update.$set; return stored; });
  t.mock.method(MenuSelectionRecord, 'updateOne', async (_, update) => { Object.assign(stored, update.$set); return { matchedCount: 1 }; });
  t.mock.method(MenuSelectionRecord, 'countDocuments', async () => 1);
  t.mock.method(WeeklyMenu, 'findByIdAndUpdate', async () => ({}));
  t.mock.method(WeeklyMenu, 'findById', () => ({ populate: () => ({ lean: async () => ({ meals: [] }) }) }));
  const handler = router.stack.find(layer => layer.route?.path === '/customers/:email/select-meals').route.stack[0].handle;
  const confirm = async subscriptionId => {
    const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
    await handler({ params: { email: source.customer_email }, body: { weeklyMenuId: '507f1f77bcf86cd799439012', selections: [], skippedDates: [date],
      pauseDecisions: [{ date, subscriptionId, action: 'pause', resumeDate: '2099-12-01', alreadyPaused: false }] } }, res);
    return res;
  };
  const duringSave = await confirm('current');
  assert.equal(duringSave.body.pauseResults[0].pauseStatus, 'failed');
  assert.equal((await confirm('current')).code, 409);
  assert.equal(writes.mock.callCount(), 0);
  const afterPreview = await confirm('next');
  assert.equal(afterPreview.body.pauseResults[0].pauseStatus, 'success');
  assert.equal(writes.mock.callCount(), 1);
  assert.equal(writes.mock.calls[0].arguments[0], 'next');
  assert.equal(stored.skippedDays[0].subscriptionId, 'next');
});
