import test from 'node:test';
import assert from 'node:assert/strict';
import router from './menus.js';
import matter from '../services/matterApiService.js';
import Customer from '../models/Customer.js';
import Record from '../models/MenuSelectionRecord.js';
import Menu from '../models/WeeklyMenu.js';

const handler = router.stack.find((layer) => layer.route?.path === '/customers/:email/select-meals').route.stack.at(-1).handle;
const response = () => { const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; return res; };

test('submission stores a Matter customer selection without accessing Internal profiles', async () => {
  const original = { lookup: matter.getKitchenNutrition, find: Customer.findOne, byId: Customer.findById, prior: Record.findOne, save: Record.findOneAndUpdate, count: Record.countDocuments, menu: Menu.findByIdAndUpdate, log: console.log };
  let saved;
  const customer = { _id: '507f1f77bcf86cd799439011', customerId: 'internal', email: 'internal@example.invalid', firstName: 'Internal', selectedMeals: [], save: async function () { return this; } };
  matter.getKitchenNutrition = async (params) => {
    assert.deepEqual(params, { email: 'website@example.invalid' });
    return { subscription_id: 'verified-subscription', customer_id: 'permanent', customer_email: 'website@example.invalid', customer_name: 'Website', exclusions: [] };
  };
  Customer.findOne = () => assert.fail('Internal profiles must not be read');
  Customer.findById = async () => customer;
  Record.findOne = () => ({ select: () => ({ lean: async () => null }) });
  Record.findOneAndUpdate = async (filter, update) => { saved = { filter, values: update.$set }; return {}; };
  Record.countDocuments = async () => 1;
  Menu.findByIdAndUpdate = async () => ({});
  console.log = () => {};
  try {
    const res = response();
    await handler({ params: { email: 'website@example.invalid' }, body: { weeklyMenuId: '507f1f77bcf86cd799439012', subscriptionId: 'untrusted-client-id', selections: [{ date: '2026-10-22', mealType: 'main', mealName: 'Fixture' }] } }, res);
    assert.equal(res.body.success, true);
    assert.equal(saved.values.email, 'website@example.invalid');
    assert.equal(saved.values.customerId, 'permanent');
    assert.equal(saved.values.customer, undefined);
    assert.equal(saved.values.matterEmail, 'website@example.invalid');
    assert.equal(saved.values.matterCustomerId, 'permanent');
    assert.equal(saved.values.matterSubscriptionId, 'verified-subscription');
    const doc = new Record(saved.values);
    assert.equal(doc.validateSync(), undefined);
    assert.equal(doc.toObject().matterEmail, 'website@example.invalid');
  } finally { matter.getKitchenNutrition = original.lookup; Customer.findOne = original.find; Customer.findById = original.byId; Record.findOne = original.prior; Record.findOneAndUpdate = original.save; Record.countDocuments = original.count; Menu.findByIdAndUpdate = original.menu; console.log = original.log; }
});

test('failed website verification cannot save an unverified selection', async () => {
  const original = { lookup: matter.getKitchenNutrition, find: Customer.findOne, log: console.log, error: console.error };
  matter.getKitchenNutrition = async () => { throw new Error('Upstream unavailable'); };
  Customer.findOne = () => assert.fail('must stop before Internal lookup or writes');
  console.log = console.error = () => {};
  try {
    const res = response();
    await handler({ params: { email: 'website@example.invalid' }, body: { selections: [] } }, res);
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.success, false);
  } finally { matter.getKitchenNutrition = original.lookup; Customer.findOne = original.find; console.log = original.log; console.error = original.error; }
});
