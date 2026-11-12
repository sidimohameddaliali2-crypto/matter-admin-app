import test from 'node:test';
import assert from 'node:assert/strict';
import router from '../routes/menus.js';
import Customer from '../models/Customer.js';
import MenuSelectionRecord from '../models/MenuSelectionRecord.js';
import matter from './matterApiService.js';
import WeeklyMenu from '../models/WeeklyMenu.js';

const source = {
  subscription_id: 'current', customer_name: 'Customer', customer_id: 'matter-person',
  customer_email: 'customer@example.com', active_delivery_dates: ['2026-11-16'], exclusions: [],
};
const savedRecord = () => ({ _id: 'record', weeklyMenuId: 'menu', matterSubscriptionId: 'current', selectedMeals: [],
  skippedDays: [{ date: '2026-11-16', pauseStatus: 'success', subscriptionId: 'current', resumeDate: '2026-12-11' }],
});

test('reopening a confirmed skip after a Matter admin unpause returns an unlocked delivery day', async (t) => {
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

test('an old tab cannot silently resubmit a confirmed skip after an admin unpause', async (t) => {
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

test('meals on an admin-unpaused date are saved instead of being discarded as a prior skip', async (t) => {
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
    weekend_enabled: true, exclusions: [],
  }));
  t.mock.method(Customer, 'findOne', () => ({ select: async () => customer }));
  t.mock.method(Customer, 'findById', async () => customer);
  t.mock.method(Customer, 'find', () => ({ select: () => ({ lean: async () => [{ ...customer, allergies: ['Milk'] }] }) }));
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
  t.mock.method(matter, 'getKitchenNutrition', async () => ({ subscription_id: 'current', customer_name: 'Customer', customer_id: 'matter-person', customer_email: 'customer@example.com' }));
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
