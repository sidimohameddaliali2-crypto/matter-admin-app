import test from 'node:test';
import assert from 'node:assert/strict';
import { customersWithoutMenuSelections, getMenuNonSelectors } from './menuNonSelectors.js';
import Menu from '../models/WeeklyMenu.js';
import Record from '../models/MenuSelectionRecord.js';
import matter from './matterApiService.js';
import router from '../routes/menus.js';

const start = '2026-11-16', end = '2026-11-22';
const delivery = (id, date = start, extra = {}) => ({ customer_id: id, subscription_id: `sub-${id}`, email: `${id}@example.com`, name: `Customer ${id}`, phone: '0501234567', delivery_date: date, ...extra });
const meal = (date = start, extra = {}) => ({ date, mealType: 'main', quantity: 1, ...extra });
const choose = (id, meals = [meal()], extra = {}) => ({ matterCustomerId: id, selectedMeals: meals, ...extra });

test('one choice on any menu date excludes the customer even if other delivery days are empty', () => {
  const deliveries = [delivery('monday'), delivery('monday', '2026-11-17'), delivery('friday'), delivery('none')];
  const records = [choose('monday'), choose('friday', [meal('2026-11-20')])];
  assert.deepEqual(customersWithoutMenuSelections(deliveries, records, start, end).map(c => c.customerId), ['none']);
});

test('automatic meals, empty records and skip-only records are not customer choices; any chosen snack is', () => {
  const rows = ['auto', 'empty', 'skip', 'snack'].map(id => delivery(id));
  const records = [choose('auto', [meal(start, { isAutoAssigned: true })]), choose('empty', []), choose('skip', [], { skippedDays: [{ date: start }] }), choose('snack', [meal(start, { mealType: 'snack' })])];
  assert.deepEqual(customersWithoutMenuSelections(rows, records, start, end).map(c => c.customerId), ['auto', 'empty', 'skip']);
});

test('deduplicates customers and delivery dates across subscriptions, keeping only the selected menu range', () => {
  const rows = [delivery('one'), delivery('one'), delivery('one', end, { subscription_id: 'renewal' }), delivery('outside', '2026-11-23')];
  const result = customersWithoutMenuSelections(rows, [], start, end);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].deliveryDates, [start, end]);
  assert.equal(result[0].phone, '0501234567');
});

test('permanent identity follows renewals and cannot be overridden by another person sharing an email', () => {
  const rows = [delivery('one', start, { email: 'shared@example.com' }), delivery('two', start, { email: 'shared@example.com' })];
  const records = [choose('one', [meal()], { email: 'shared@example.com', matterSubscriptionId: 'old-sub' })];
  assert.deepEqual(customersWithoutMenuSelections(rows, records, start, end).map(c => c.customerId), ['two']);
});

test('legacy records match exact subscription or unique case-insensitive email; ambiguous identity fails visibly', () => {
  const rows = [delivery('sub'), delivery('email')];
  assert.deepEqual(customersWithoutMenuSelections(rows, [choose(null, [meal()], { matterSubscriptionId: 'sub-sub' }), choose(null, [meal()], { email: 'EMAIL@EXAMPLE.COM' })], start, end), []);
  const shared = [delivery('one', start, { email: 'same@example.com' }), delivery('two', start, { email: 'same@example.com' })];
  assert.throws(() => customersWithoutMenuSelections(shared, [choose(null, [meal()], { email: 'same@example.com' })], start, end), { statusCode: 409 });
});

test('a choice from another menu date range does not hide a non-selector', () => {
  assert.equal(customersWithoutMenuSelections([delivery('one')], [choose('one', [meal('2026-11-15')])], start, end).length, 1);
});

test('reads one fresh whole-menu delivery range before saved choices; never assigns meals or writes records', async (t) => {
  const order = [];
  t.mock.method(Menu, 'findById', () => ({ select: () => ({ lean: async () => ({ _id: 'menu', title: 'Week', startDate: new Date(start), endDate: new Date(end) }) }) }));
  const read = t.mock.method(matter, 'findSubscriptionsWithDeliveryInRange', async (a, b) => { order.push('matter'); assert.equal(a, start); assert.equal(b, end); return [delivery('one'), delivery('two')]; });
  t.mock.method(Record, 'find', () => ({ select: () => ({ lean: async () => { order.push('selections'); return [choose('one')]; } }) }));
  for (const method of ['updateOne', 'findOneAndUpdate', 'create']) t.mock.method(Record, method, () => assert.fail('Read-only report'));
  const result = await getMenuNonSelectors('menu');
  assert.equal(read.mock.callCount(), 1);
  assert.deepEqual(order, ['matter', 'selections']);
  assert.deepEqual(result.customers.map(c => c.customerId), ['two']);
});

test('an incomplete Matter sweep fails rather than reporting no customers', async (t) => {
  t.mock.method(Menu, 'findById', () => ({ select: () => ({ lean: async () => ({ startDate: start, endDate: end }) }) }));
  t.mock.method(matter, 'findSubscriptionsWithDeliveryInRange', async () => { throw Object.assign(new Error('Incomplete delivery roster'), { statusCode: 503 }); });
  t.mock.method(Record, 'find', () => assert.fail('Cannot build an incomplete report'));
  await assert.rejects(getMenuNonSelectors('menu'), { statusCode: 503 });
});

test('menu non-selector endpoint requires the menus permission and disables response caching', async (t) => {
  const route = router.stack.find(layer => layer.route?.path === '/:id/did-not-select').route;
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; }, set(name, value) { this.header = [name, value]; } };
  route.stack[1].handle({ user: { role: 'driver', permissions: { menus: false } } }, res, () => assert.fail('Permission must be checked'));
  assert.equal(res.code, 403);
  await route.stack.at(-1).handle({ params: { id: 'invalid' } }, res);
  assert.equal(res.code, 400);
  assert.deepEqual(res.header, ['Cache-Control', 'no-store']);
});
