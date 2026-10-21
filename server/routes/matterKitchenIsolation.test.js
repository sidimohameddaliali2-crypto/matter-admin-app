import test from 'node:test';
import assert from 'node:assert/strict';
import Customer from '../models/Customer.js';
import Record from '../models/MenuSelectionRecord.js';
import Archive from '../models/MenuSelectionArchive.js';
import Menu from '../models/WeeklyMenu.js';
import MenuItem from '../models/MenuItem.js';
import Lease from '../models/KitchenPreparationLease.js';
import matter from '../services/matterApiService.js';
import router, { runAutoPopulateMissing } from './menus.js';

const query = (data) => ({ select() { return this; }, populate() { return this; }, sort() { return this; }, lean: async () => data, then: (resolve, reject) => Promise.resolve(data).then(resolve, reject) });
const response = () => ({ set() { return this; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const route = (path, method) => router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]).route.stack.at(-1).handle;
const source = { customer_id: '42', customer_email: 'website@example.invalid', customer_name: 'Matter Name', subscription_id: 'renewal', plan_name: 'Custom', meal_frequency: 1, breakfast_included: false, snacks_per_day: 0, exclusions: [], weekend_enabled: true, macros: { carbohydrates: 38, protein: 32, fat: 10 } };
const blockInternal = (t) => {
  for (const name of ['find', 'findOne', 'findById', 'updateOne', 'findOneAndUpdate', 'findByIdAndUpdate', 'create']) t.mock.method(Customer, name, () => assert.fail(`Forbidden Internal Customer.${name}`));
  t.mock.method(Customer.prototype, 'save', () => assert.fail('Forbidden Internal customer save'));
  t.mock.method(matter, 'client', () => assert.fail('Unmocked network access'));
};

test('preparation follows permanent Matter ID across renewal without Internal reads or writes', async (t) => {
  blockInternal(t);
  const record = { _id: 'record', matterCustomerId: '42', matterSubscriptionId: 'expired', email: 'old-storage@example.invalid', selectedMeals: [{ date: '2026-10-22', mealType: 'main', quantity: 1 }] };
  t.mock.method(Lease, 'findOneAndUpdate', async () => ({})); t.mock.method(Lease, 'deleteOne', async () => ({}));
  t.mock.method(matter, 'findSubscriptionsWithDeliveryOnDate', async () => [{ subscription_id: 'renewal', customer_id: '42', email: source.customer_email, kitchen_inputs: source }]);
  t.mock.method(Record, 'find', () => query([record]));
  const writes = [];
  t.mock.method(Record, 'updateOne', async (_filter, update) => { writes.push(update); return {}; });
  t.mock.method(Menu, 'findById', () => query({ snackOptionsByDate: {} }));
  const result = await runAutoPopulateMissing('isolation-menu', '2026-10-22', { freshInputs: true });
  assert.equal(result.data.alreadyCovered, 1);
  assert.equal(result.data.newlyCreatedCustomers, 0);
  assert.equal(result.data.kitchenInputs[0].customer_id, '42');
  assert.equal(writes[0].$set.matterSubscriptionId, 'renewal');
  assert.equal(writes[0].$set.customerId, '42');
});

test('menu sign-in reads only Internal allergies; identity and saved selections remain Matter-owned', async (t) => {
  blockInternal(t);
  // Owner (2026-10-21): internal allergy profiles are the sole exception.
  t.mock.method(Customer, 'find', () => ({ select(fields) {
    assert.equal(fields, 'allergies email matterCustomerId matterSubscriptionId');
    return query([{ matterCustomerId: '42', allergies: ['Milk'], firstName: 'Internal name', mealPerDay: 99 }]);
  } }));
  const record = { email: source.customer_email, matterCustomerId: '42', selectedMeals: [{ date: '2026-10-22', mealType: 'main' }], skippedDays: [], firstName: 'Untrusted legacy name' };
  t.mock.method(matter, 'getKitchenNutrition', async () => source);
  t.mock.method(Record, 'findOne', () => query(record)); t.mock.method(Record, 'find', () => query([record]));
  const res = response();
  await route('/customers/:email/subscription-profile', 'get')({ params: { email: source.customer_email }, query: { menuId: 'menu' } }, res);
  assert.equal(res.body.data.customerId, '42');
  assert.equal(res.body.data.firstName, 'Matter');
  assert.deepEqual(res.body.data.allergies, ['Milk']);
  assert.equal(res.body.data.allergiesAvailable, true);
  assert.equal(res.body.data.mealPerDay, 1);
  assert.equal(res.body.data.hasSubmittedForRequestedMenu, true);
  const list = response();
  t.mock.method(Customer, 'find', () => assert.fail('Selections GET must not read Internal profiles'));
  await route('/:id/selections', 'get')({ params: { id: 'menu' } }, list);
  assert.equal(list.body.data[0].firstName, undefined);
  assert.equal(list.body.data[0].customer, undefined);
  assert.equal(list.body.data[0].matterCustomerId, '42');
});

test('staff selection edits and deletion never mirror changes onto Internal customers', async (t) => {
  blockInternal(t);
  t.mock.method(Menu, 'findById', () => query({ _id: 'menu' }));
  t.mock.method(Menu, 'findByIdAndUpdate', async () => ({}));
  t.mock.method(Record, 'findOneAndUpdate', async (filter) => { assert.equal(filter.matterCustomerId, '42'); return { matterCustomerId: '42' }; });
  t.mock.method(Record, 'findOneAndDelete', async () => ({})); t.mock.method(Record, 'countDocuments', async () => 0);
  const res = response();
  await route('/:menuId/selections/:email', 'put')({ params: { menuId: 'menu', email: 'old-storage@example.invalid' }, body: { matterCustomerId: '42', selections: [] } }, res);
  assert.equal(res.body.success, true);
  const deleted = response();
  await route('/:menuId/selections/:email', 'delete')({ params: { menuId: 'menu', email: 'old-storage@example.invalid' } }, deleted);
  assert.equal(deleted.body.success, true);
});

test('selections GET suppresses only an approved archived alias and never recreates or deletes records', async (t) => {
  blockInternal(t);
  const menuId = '507f1f77bcf86cd799439012';
  const meal = { date: new Date('2026-10-23'), mealType: 'main', mealName: 'Saved choice', quantity: 1 };
  const alias = { _id: 'new-alias', weeklyMenuId: menuId, email: 'alias@example.invalid', selectedMeals: [meal] };
  const retained = { _id: 'retained', weeklyMenuId: menuId, matterCustomerId: '42', email: source.customer_email, selectedMeals: [meal] };
  t.mock.method(Record, 'find', () => query([alias, retained]));
  t.mock.method(Archive, 'find', filter => {
    assert.equal(String(filter['original.weeklyMenuId']), menuId);
    return query([{ retainedSelectionId: 'retained', matterCustomerId: '42', original: alias }]);
  });
  for (const method of ['create', 'deleteOne', 'updateOne', 'findOneAndUpdate']) t.mock.method(Record, method, () => assert.fail('GET must not write selections'));
  const res = response();
  await route('/:id/selections', 'get')({ params: { id: menuId } }, res);
  assert.equal(res.body.success, true);
  assert.deepEqual(res.body.data.map(row => row.email), [source.customer_email]);
});

test('missing Core rotation returns the actual date and missing main slots without exposing source inputs', async (t) => {
  blockInternal(t);
  const nutrition = { ...source, plan_name: 'Matter Core', meal_frequency: 2 };
  const record = { email: source.customer_email, matterCustomerId: '42', matterEmail: source.customer_email,
    matterSubscriptionId: 'renewal', selectedMeals: [] };
  t.mock.method(Lease, 'findOneAndUpdate', async () => ({}));
  t.mock.method(Lease, 'deleteOne', async () => ({}));
  t.mock.method(matter, 'findSubscriptionsWithDeliveryOnDate', async () => [{ customer_id: '42', kitchen_inputs: nutrition }]);
  t.mock.method(Record, 'find', () => query([record]));
  t.mock.method(Record, 'findOne', () => query(record));
  t.mock.method(Record, 'findOneAndUpdate', () => assert.fail('No dish is configured to assign'));
  t.mock.method(Menu, 'findById', () => query({ meals: [] }));
  t.mock.method(MenuItem, 'find', () => query([]));
  t.mock.method(console, 'error', () => {});
  const res = response();
  await route('/:id/auto-populate-missing', 'post')({ params: { id: 'missing-core-menu' }, body: { date: '2026-10-23', freshInputs: true } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.preparation, 'failed');
  assert.equal(res.body.code, 'KITCHEN_ASSIGNMENT_INCOMPLETE');
  assert.match(res.body.message, /2026-10-23.*Matter Core: 2 main slot/);
  assert.match(res.body.message, /Also tag for Core Plan/);
  assert.deepEqual(res.body.failures.map(({ stage, mealType, count }) => ({ stage, mealType, count })), [{ stage: 'Matter Core', mealType: 'main', count: 2 }]);
  assert.equal(JSON.stringify(res.body).includes('carbohydrates'), false);
});
