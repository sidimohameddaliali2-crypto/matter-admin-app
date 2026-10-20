import test from 'node:test';
import assert from 'node:assert/strict';
import router from '../routes/menus.js';
import Customer from '../models/Customer.js';
import MenuSelectionRecord from '../models/MenuSelectionRecord.js';
import matter from './matterApiService.js';

test('the menu profile restores a submission consisting entirely of skipped days', async (t) => {
  const skippedDays = ['2026-10-28', '2026-10-30', '2026-10-31'].map((date) => ({ date, pauseStatus: 'success' }));
  const customer = { _id: 'customer', email: 'customer@example.com', selectedMeals: [], weekend: false };
  t.mock.method(matter, 'getSubscriptionNutritionByEmail', async () => ({
    subscription_id: 'current', customer_name: 'Customer', active_delivery_dates: [],
    weekend_enabled: true, exclusions: [],
  }));
  t.mock.method(Customer, 'findOne', () => ({ select: async () => customer }));
  t.mock.method(Customer, 'findById', async () => customer);
  t.mock.method(MenuSelectionRecord, 'findOne', async () => ({ selectedMeals: [], skippedDays }));
  const handler = router.stack.find((layer) => layer.route?.path === '/customers/:email/subscription-profile').route.stack[0].handle;
  let response;
  const res = { json: (value) => { response = value; }, status: () => res };
  await handler({ params: { email: 'customer@example.com' }, query: { menuId: 'menu' } }, res);
  assert.equal(response.success, true);
  assert.equal(response.data.hasSubmittedForRequestedMenu, true);
  assert.deepEqual(response.data.skippedDays, skippedDays);
  assert.equal(response.data.weekend, true);
});

test('an incomplete set of resume dates is rejected before saving meals or writing any Matter pauses', async (t) => {
  const customer = { _id: 'customer', email: 'customer@example.com' };
  t.mock.method(matter, 'getSubscriptionNutritionByEmail', async () => ({ subscription_id: 'current', customer_name: 'Customer' }));
  t.mock.method(Customer, 'findOne', () => ({ select: async () => customer }));
  t.mock.method(MenuSelectionRecord, 'findOne', () => ({ select: () => ({ lean: async () => null }) }));
  const save = t.mock.method(MenuSelectionRecord, 'findOneAndUpdate', async () => ({}));
  const pause = t.mock.method(matter, 'createSubscriptionPause', async () => ({}));
  const handler = router.stack.find((layer) => layer.route?.path === '/customers/:email/select-meals').route.stack[0].handle;
  let response;
  let status;
  const res = { json: (value) => { response = value; }, status: (value) => { status = value; return res; } };
  await handler({ params: { email: 'customer@example.com' }, body: {
    weeklyMenuId: 'menu', selections: [], skippedDates: ['2026-10-28', '2026-10-30', '2026-10-31'],
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
});
