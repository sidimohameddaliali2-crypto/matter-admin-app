import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Menu from '../models/WeeklyMenu.js';
import Item from '../models/MenuItem.js';
import Record from '../models/MenuSelectionRecord.js';
import Log from '../models/KitchenMealEditLog.js';
import Customer from '../models/Customer.js';
import Snack from '../models/KitchenSnackPreset.js';
import matter from './matterApiService.js';
import { readMealEditContext, mealEditView, editKitchenMeals, mealEditToken } from './kitchenMealEdits.js';
const date = '2026-11-16', menuId = '507f1f77bcf86cd799439011', itemId = '507f1f77bcf86cd799439012';
const query = value => ({ session() { return this; }, lean: async () => value });
const user = { _id: 'staff-id', profile: { firstName: 'Ahmed', lastName: 'Ali' }, email: 'staff@example.invalid' };
const fixture = t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-13T10:00:00Z') });
  const menu = { startDate: date, endDate: '2026-11-22', meals: [{ items: [itemId] }] };
  const item = { _id: itemId, itemDate: date, mealName: 'Core chicken', mealType: 'main', usedForCorePlan: true };
  const row = { _id: 'record', matterCustomerId: '42', updatedAt: new Date(), selectedMeals: [{ _id: 'meal', date, mealType: 'main', mealName: 'Chosen chicken', quantity: 2 }], kitchenAutoHolds: [] };
  const nutrition = { customer_id: '42', customer_email: 'customer@example.invalid', customer_name: 'Customer', subscription_id: 'renewed',
    active_delivery_dates: [date], plan_name: 'Matter Core', meal_frequency: 3, double_delivery_dates: [], exclusions: [], allergens: [] };
  t.mock.method(Menu, 'findById', () => ({ ...query(menu), populate() {
    return query({ ...menu, meals: [{ date, mealType: 'main', items: [item] }] });
  } }));
  t.mock.method(Customer, 'find', () => assert.fail('Internal allergies must not be read'));
  t.mock.method(Item, 'find', () => query([item])); t.mock.method(Item, 'findById', () => query(item));
  t.mock.method(Record, 'find', () => query([row]));
  t.mock.method(matter, 'getKitchenNutrition', async () => nutrition);
  let staged = [], committed = [];
  t.mock.method(mongoose.connection, 'transaction', async fn => { staged = []; await fn({ transaction: true }); committed = [...staged]; });
  const write = t.mock.method(Record, 'updateOne', async (filter, update) => { staged.push({ filter, update }); return { matchedCount: 1 }; });
  const logs = t.mock.method(Log, 'create', async rows => { staged.push({ log: rows[0] }); return rows; });
  return { menu, item, row, nutrition, write, logs, get committed() { return committed; } };
};
test('delete saves the hold and immutable staff attribution atomically; stale tokens cannot write', async t => {
  const f = fixture(t), original = JSON.stringify(f.row);
  const args = { menuId, customerId: '42', date, user, body: { action: 'delete', mealId: 'meal', quantity: 1, token: mealEditToken(f.row), actorName: 'Spoofed' } };
  await editKitchenMeals(args);
  assert.equal(f.committed.length, 2);
  assert.equal(f.committed[0].update.$set.selectedMeals[0].quantity, 1);
  assert.equal(f.committed[0].update.$set.kitchenAutoHolds[0].date, date);
  assert.equal(f.committed[1].log.actorName, 'Ahmed Ali');
  assert.equal(JSON.stringify(f.row), original);
  await assert.rejects(() => editKitchenMeals({ ...args, body: { ...args.body, token: 'stale' } }), /Selections changed/);
  assert.equal(f.write.mock.callCount(), 1);
});
test('cutoff is checked before Matter and is enforced at the exact boundary', async t => {
  fixture(t); t.mock.timers.tick(3600001 + 60000);
  t.mock.method(matter, 'getKitchenNutrition', () => assert.fail('No Matter lookup after cutoff'));
  await assert.rejects(() => editKitchenMeals({ menuId, customerId: '42', date, user, body: { action: 'delete' } }), { code: 'KITCHEN_MEAL_EDIT_CLOSED' });
});
test('Core additions reject untagged dishes and dietary conflicts, without any writes', async t => {
  const f = fixture(t);
  f.item.usedForCorePlan = false;
  const args = { menuId, customerId: '42', date, user, body: { action: 'add', menuItemId: itemId, quantity: 1, token: mealEditToken(f.row) } };
  assert.equal(mealEditView(await readMealEditContext(menuId, '42', date)).choices.length, 0);
  await assert.rejects(() => editKitchenMeals(args), /Core-tagged/);
  f.item.usedForCorePlan = true; f.item.ingredients = 'Peanuts'; f.nutrition.exclusions = ['Peanuts'];
  await assert.rejects(() => editKitchenMeals(args), /exclusions/);
  assert.equal(f.write.mock.callCount(), 0);
});
test('audit failure aborts the transaction; an edit crossing the cutoff cannot commit', async t => {
  const f = fixture(t);
  t.mock.method(Log, 'create', async () => { throw new Error('Audit unavailable'); });
  const args = { menuId, customerId: '42', date, user, body: { action: 'delete', mealId: 'meal', quantity: 1, token: mealEditToken(f.row) } };
  await assert.rejects(() => editKitchenMeals(args), /Audit unavailable/);
  assert.equal(f.committed.length, 0);
  t.mock.method(Record, 'find', () => { t.mock.timers.tick(3700000); return query([f.row]); });
  await assert.rejects(() => editKitchenMeals(args), { code: 'KITCHEN_MEAL_EDIT_CLOSED' });
});

test('adding and changing a Core meal keep the saved IDs for remaining portions and log before/after names', async t => {
  const f = fixture(t);
  const args = { menuId, customerId: '42', date, user, body: { action: 'change', mealId: 'meal', menuItemId: itemId, quantity: 1, token: mealEditToken(f.row) } };
  await editKitchenMeals(args);
  const values = f.committed[0].update.$set;
  assert.equal(values.selectedMeals[0]._id, 'meal');
  assert.equal(values.selectedMeals[0].quantity, 1);
  assert.equal(values.selectedMeals[1].isAutoAssigned, false);
  assert.equal(f.committed[1].log.before.name, 'Chosen chicken');
  assert.equal(f.committed[1].log.after.name, 'Core chicken');
  await editKitchenMeals({ ...args, body: { ...args.body, action: 'add', mealId: undefined } });
  assert.equal(f.committed[0].update.$set.selectedMeals.length, 2);
  assert.equal(f.committed[0].update.$set.selectedMeals[0].quantity, 2);
});

test('restore is allowed after cutoff and removes only this date’s hold; it does not add meals itself', async t => {
  const f = fixture(t);
  f.row.kitchenAutoHolds = [{ date }, { date: '2026-11-17' }];
  t.mock.timers.tick(3700000);
  await editKitchenMeals({ menuId, customerId: '42', date, user,
    body: { action: 'restore', token: mealEditToken(f.row) } });
  assert.deepEqual(f.committed[0].update.$set.kitchenAutoHolds, [{ date: '2026-11-17' }]);
  assert.deepEqual(f.committed[0].update.$set.selectedMeals, f.row.selectedMeals);
  assert.equal(f.committed[1].log.action, 'restore');
});

test('Core main additions cannot exceed dated entitlement and a first selection is created only once under verified identity', async t => {
  const f = fixture(t);
  const args = { menuId, customerId: '42', date, user, body: { action: 'add', menuItemId: itemId, quantity: 1, token: mealEditToken(f.row) } };
  f.nutrition.meal_frequency = 2;
  await assert.rejects(() => editKitchenMeals(args), /entitlement is 2/);
  assert.equal(f.write.mock.callCount(), 0);
  t.mock.method(Record, 'find', () => query([]));
  const create = t.mock.method(Record, 'create', async values => values);
  await editKitchenMeals({ ...args, body: { ...args.body, token: 'missing' } });
  assert.equal(create.mock.calls[0].arguments[0][0].matterCustomerId, '42');
  assert.equal(create.mock.calls[0].arguments[0][0].email, 'customer@example.invalid');
});

for (const action of ['add', 'change']) {
  test(`${action} rejects a Matter peanut allergy with empty Matter exclusions before any selection/audit write`, async t => {
    const f = fixture(t);
    f.item.cycleMeal = { components: [{ id: 'portion', type: 'Protein', name: 'Chicken', exclusions: ['Peanuts'] }] };
    f.nutrition.allergens = ['Peanuts'];
    assert.deepEqual(f.nutrition.exclusions, []);
    const args = { menuId, customerId: '42', date, user,
      body: { action, mealId: 'meal', menuItemId: itemId, quantity: 1, token: mealEditToken(f.row) } };
    await assert.rejects(() => editKitchenMeals(args), { statusCode: 409 });
    assert.equal(f.write.mock.callCount(), 0);
    assert.equal(f.logs.mock.callCount(), 0);
    assert.equal(f.committed.length, 0);
    // The same dish and request succeeds when the Matter profile confirms no
    // peanut allergy, demonstrating that the rejection came from that profile.
    f.nutrition.allergens = [];
    await editKitchenMeals(args);
    assert.equal(f.write.mock.callCount(), 1);
    assert.equal(f.logs.mock.callCount(), 1);
  });
}

test('Matter allergy protection cannot be bypassed by browser flags and does not prevent deleting unsafe saved choices', async t => {
  const f = fixture(t);
  f.item.cycleMeal = { components: [{ id: 'sauce', type: 'Sauce', name: 'Peanut sauce', exclusions: ['Peanuts'] }] };
  f.nutrition.allergens = ['Peanuts'];
  await assert.rejects(() => editKitchenMeals({ menuId, customerId: '42', date, user, body: { action: 'add', menuItemId: itemId,
    quantity: 1, token: mealEditToken(f.row), allergies: [], exclusionAcknowledged: true, needsSauceChange: false } }), { statusCode: 409 });
  assert.equal(f.write.mock.callCount(), 0);
  await editKitchenMeals({ menuId, customerId: '42', date, user, body: { action: 'delete', mealId: 'meal', quantity: 1, token: mealEditToken(f.row) } });
  assert.equal(f.write.mock.callCount(), 1);
});

const afterCutoffAllergyFixture = t => {
  const f = fixture(t);
  const unsafe = { _id: '507f1f77bcf86cd799439013', itemDate: date, mealName: f.row.selectedMeals[0].mealName,
    mealType: 'main', ingredients: 'Peanuts', usedForCorePlan: true };
  f.menu.meals[0].items.push(unsafe._id);
  f.row.selectedMeals[0] = { ...f.row.selectedMeals[0], menuItemId: unsafe._id, slotNumber: 0 };
  f.nutrition.allergens = ['Peanuts'];
  t.mock.method(Item, 'find', () => query([f.item, unsafe]));
  t.mock.timers.tick(3700000);
  const args = { menuId, customerId: '42', date, user,
    body: { action: 'change', mealId: 'meal', menuItemId: itemId, quantity: 1, token: mealEditToken(f.row) } };
  return { ...f, unsafe, args };
};

test('a verified allergy allows partial replacement after cutoff and logs the actor and allergen', async t => {
  const f = afterCutoffAllergyFixture(t);
  const view = mealEditView(await readMealEditContext(menuId, '42', date));
  assert.equal(view.canEdit, false);
  assert.deepEqual(view.allergyReplacementMealIds, ['meal']);
  assert.deepEqual(view.choices.find(item => item.id === f.unsafe._id).allergyConflicts, ['Peanuts']);
  await editKitchenMeals(f.args);
  const saved = f.write.mock.calls[0].arguments[1].$set;
  assert.deepEqual(saved.selectedMeals.map(meal => [meal.mealName, meal.quantity, meal.slotNumber]),
    [['Chosen chicken', 1, 0], ['Core chicken', 1, 1]]);
  assert.deepEqual(saved.kitchenAutoHolds, []);
  const [entries] = f.logs.mock.calls[0].arguments;
  assert.equal(entries[0].actorId, user._id);
  assert.equal(entries[0].action, 'change');
  assert.match(entries[0].reason, /Allergy replacement after cutoff \(Peanuts\)/);
});

test('closed-date allergy replacement cannot delete a meal, change a safe meal, or save an unsafe replacement', async t => {
  const f = afterCutoffAllergyFixture(t);
  await assert.rejects(() => editKitchenMeals({ ...f.args, body: { ...f.args.body, action: 'delete' } }),
    { code: 'KITCHEN_MEAL_EDIT_CLOSED' });
  f.item.ingredients = 'Peanuts';
  await assert.rejects(() => editKitchenMeals(f.args), { statusCode: 409 });
  f.item.ingredients = '';
  f.unsafe.ingredients = '';
  await assert.rejects(() => editKitchenMeals({ ...f.args, body: { ...f.args.body, allergies: ['Peanuts'], allergyOverride: true } }),
    { code: 'KITCHEN_MEAL_EDIT_CLOSED' });
  assert.equal(f.write.mock.callCount(), 0);
  assert.equal(f.logs.mock.callCount(), 0);
});

test('the server rechecks the conflict against the dated recipe in the write transaction', async t => {
  const f = afterCutoffAllergyFixture(t);
  t.mock.method(Item, 'find', () => ({
    session() { return query([f.item, { ...f.unsafe, ingredients: 'Carrots' }]); },
    lean: async () => [f.item, f.unsafe],
  }));
  await assert.rejects(() => editKitchenMeals(f.args), { code: 'KITCHEN_MEAL_EDIT_CLOSED' });
  assert.equal(f.write.mock.callCount(), 0);
});

test('a valid snack cannot replace an allergy-flagged main after cutoff', async t => {
  const f = afterCutoffAllergyFixture(t);
  f.item.mealType = 'snack';
  f.item.mealName = 'Safe snack';
  t.mock.method(Snack, 'findOne', () => query({ presetsByName: { 'Safe snack': { C: 15, P: 10, F: 6 } } }));
  t.mock.method(Menu, 'findById', () => ({ ...query(f.menu), populate() {
    return query({ ...f.menu, meals: [{ date, mealType: 'snack', items: [f.item] }] });
  } }));
  await assert.rejects(() => editKitchenMeals(f.args), /same meal type/);
  assert.equal(f.write.mock.callCount(), 0);
});


test('Core double-delivery staff additions use the four-portion entitlement rather than the two-meal customer cap', async t => {
  const f = fixture(t);
  f.nutrition.meal_frequency = 2;
  f.nutrition.double_delivery_dates = [date];
  f.row.selectedMeals = [];
  await editKitchenMeals({ menuId, customerId: '42', date, user,
    body: { action: 'add', menuItemId: itemId, quantity: 4, token: mealEditToken(f.row) } });
  assert.equal(f.write.mock.callCount(), 1);
  assert.equal(f.committed[0].update.$set.selectedMeals[0].quantity, 4);
  await assert.rejects(editKitchenMeals({ menuId, customerId: '42', date, user,
    body: { action: 'add', menuItemId: itemId, quantity: 5, token: mealEditToken(f.row) } }), /entitlement is 4/);
  assert.equal(f.write.mock.callCount(), 1);
});
