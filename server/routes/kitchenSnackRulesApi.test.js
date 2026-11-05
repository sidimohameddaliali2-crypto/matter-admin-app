import test from 'node:test';
import assert from 'node:assert/strict';
import router from './menus.js';
import Rule from '../models/KitchenSnackRule.js';
import Record from '../models/MenuSelectionRecord.js';
import Snack from '../models/KitchenSnackPreset.js';
import Menu from '../models/WeeklyMenu.js';
import Item from '../models/MenuItem.js';
import matter from '../services/matterApiService.js';
import { replaceBlockedSnacks } from '../services/kitchenSnackReplacement.js';

const stack = method => router.stack.find(layer => layer.route?.path === '/kitchen-snack-rules/:customerId' && layer.route.methods[method]).route.stack;
const response = () => ({ status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
const query = value => ({ select() { return this; }, lean: async () => value });
test('rule writes require kitchen/menu permission and a permanent customer ID', () => {
  const access = stack('put')[1].handle;
  for (const [role, customerId, code] of [['viewer', '42', 403], ['kitchen', 'subscription-id', 400]]) {
    const res = response(); access({ user: { role }, params: { customerId } }, res, () => assert.fail('Must reject'));
    assert.equal(res.code, code);
  }
  let called = false;
  access({ user: { role: 'kitchen' }, params: { customerId: '42' } }, response(), () => { called = true; });
  assert.equal(called, true);
});
test('saving a rule verifies Matter identity and writes only the rule, never customer selections', async t => {
  t.mock.method(matter, 'getKitchenNutrition', async args => { assert.deepEqual(args, { customerId: '42' }); return { customer_id: '42', subscription_id: 'new-sub' }; });
  t.mock.method(Snack, 'findOne', () => query({ presetsByName: { muffin: { C: 15, P: 10, F: 6 } } }));
  t.mock.method(Rule, 'findById', () => query(null));
  const create = t.mock.method(Rule, 'create', async values => ({ toObject: () => values }));
  for (const method of ['updateOne', 'findOneAndUpdate', 'create']) t.mock.method(Record, method, () => assert.fail('No selection writes on rule save'));
  const res = response();
  await stack('put').at(-1).handle({ user: { _id: 'staff' }, params: { customerId: '42' }, body: { blockedSnackKeys: ['muffin'], version: 0 } }, res);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.version, 1);
  assert.equal(create.mock.calls[0].arguments[0]._id, '42');
  t.mock.method(matter, 'getKitchenNutrition', async () => ({ customer_id: '99' }));
  const wrong = response();
  await stack('put').at(-1).handle({ user: { _id: 'staff' }, params: { customerId: '42' }, body: { blockedSnackKeys: [], version: 0 } }, wrong);
  assert.equal(wrong.code, 409);
  assert.equal(create.mock.callCount(), 1);
});
test('replacement cannot touch historical or still-open dates, even when called directly', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-05T08:00:00Z') });
  t.mock.method(Menu, 'findById', () => query({}));
  t.mock.method(matter, 'getKitchenNutrition', () => assert.fail('Deadline must be checked first'));
  t.mock.method(Record, 'updateOne', () => assert.fail('No write'));
  await assert.rejects(() => replaceBlockedSnacks({ menuId: 'menu', customerId: '42', date: '2026-11-04' }), /today or a future/);
  await assert.rejects(() => replaceBlockedSnacks({ menuId: 'menu', customerId: '42', date: '2099-11-02' }), { code: 'KITCHEN_SELECTION_OPEN' });
});

test('reviewed replacement verifies delivery, retries stale rules, and uses a compare-and-swap write with audit', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-05T08:00:00Z') });
  const date = '2026-11-06';
  const row = { _id: 'record', matterCustomerId: '42', skippedDays: [], selectedMeals: [{ date, mealType: 'snack', mealName: 'Muffin', quantity: 2, isAutoAssigned: true }] };
  const rule = { version: 1, blockedSnacks: [{ key: 'muffin' }] };
  t.mock.method(Menu, 'findById', () => query({ meals: [], snackOptionsByDate: { [date]: { first: [{ name: 'Muffin' }], second: [{ name: 'Oats', C: 20, P: 12, F: 6 }] } } }));
  t.mock.method(matter, 'getKitchenNutrition', async () => ({ customer_id: '42', subscription_id: 'renewed', snacks_per_day: 2, active_delivery_dates: [date], exclusions: [] }));
  t.mock.method(Record, 'find', () => query([row]));
  t.mock.method(Item, 'find', () => query([]));
  t.mock.method(Rule, 'findById', () => query(rule));
  t.mock.method(Snack, 'findOne', () => query({ presetsByName: { muffin: { C: 15, P: 10, F: 6 }, oats: { C: 20, P: 12, F: 6 } } }));
  const write = t.mock.method(Record, 'updateOne', async (filter, update) => {
    assert.equal(filter.matterCustomerId, '42');
    assert.deepEqual(filter.selectedMeals, row.selectedMeals);
    assert.equal(update.$push.kitchenAudit.action, 'replace-blocked-auto-snacks');
    assert.equal(update.$set.selectedMeals.length, 2);
    assert(update.$set.selectedMeals.every(meal => meal.mealName === 'Oats'));
    return { modifiedCount: 1 };
  });
  const args = { menuId: 'menu', customerId: '42', date, actor: 'staff', version: 1 };
  assert.deepEqual(await replaceBlockedSnacks(args), { replaced: 2 });
  assert.equal(write.mock.callCount(), 1);
  let reads = 0;
  t.mock.method(Rule, 'findById', () => query({ ...rule, version: ++reads > 1 ? 2 : 1 }));
  await assert.rejects(() => replaceBlockedSnacks(args), /changed during review/);
  assert.equal(write.mock.callCount(), 1, 'stale rules cannot write replacements');
});
