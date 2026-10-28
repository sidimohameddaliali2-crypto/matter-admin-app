import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Menu from '../models/WeeklyMenu.js';
import Item from '../models/MenuItem.js';
import Selection from '../models/MenuSelectionRecord.js';
import { planManagedMenu, saveManagedMenu } from './managedMenuSave.js';
import router from '../routes/menus.js';
import PartnerItem from '../models/PartnerMenuItem.js';
import Partner from '../models/Partner.js';

const startDate = '2026-10-26', endDate = '2026-11-01';
const menuId = '507f1f77bcf86cd799439011', itemId = '507f1f77bcf86cd799439012';
const buildMealName = item => String(item.mealName || '').trim();
const baseDays = () => [{ date: '2026-10-30', items: [{ mealName: 'Chosen Chicken', mealType: 'main', portionType: 'chicken', carbs: 'Rice', veg: 'Broccoli' }] }];
const plan = input => planManagedMenu({ startDate, endDate, buildMealName, ...input });
const existing = () => ({ ...plan({ days: baseDays() })[0].fields, _id: new mongoose.Types.ObjectId(itemId) });
const selection = () => ({ weeklyMenuId: new mongoose.Types.ObjectId(menuId), email: 'chosen@example.invalid', firstName: 'Existing Customer',
  selectedMeals: [{ date: new Date('2026-10-30'), mealName: 'Chosen Chicken', mealType: 'main', menuItemId: new mongoose.Types.ObjectId(itemId), quantity: 2 }] });

test('an unchanged selected dish retains its ID and leaves quantity-two customer selections byte-for-byte unchanged', () => {
  const records = [selection()];
  const before = JSON.stringify(records);
  const result = plan({ days: baseDays(), existingItems: [existing()], selections: records });
  assert.equal(String(result[0].existingId), itemId);
  assert.equal(JSON.stringify(records), before);
});

test('selected dish rename, removal, ingredients, date, protein type and hidden tags are blocked with the affected customer', () => {
  const changes = [
    days => { days[0].items[0].mealName = 'Renamed'; },
    days => { days[0].items = []; },
    days => { days[0].items[0].carbs = 'Potato'; },
    days => { days[0].date = '2026-10-31'; },
    days => { days[0].items[0].portionType = 'beef'; },
    days => { days[0].items[0].carbIngredients = [{ name: 'Milk', visible: false }]; },
  ];
  for (const change of changes) {
    const days = baseDays(); days[0].items[0].menuItemId = itemId; change(days);
    assert.throws(() => plan({ days, existingItems: [existing()], selections: [selection()] }), error => error.statusCode === 409 && error.conflicts[0].customers.includes('Existing Customer'));
  }
});

test('Excel reuploads and legacy name-only selections cannot bypass selected-dish protection', () => {
  const record = selection(); delete record.selectedMeals[0].menuItemId;
  const days = baseDays(); days[0].items[0].mealName = 'Replacement Chicken';
  assert.throws(() => plan({ days, existingItems: [existing()], selections: [record] }), /Existing customer selections are protected/);
});

test('unselected recipe changes create a new item instead of mutating a possibly in-flight selection reference', () => {
  const item = existing(), before = JSON.stringify(item);
  const days = baseDays(); days[0].items[0].menuItemId = itemId; days[0].items[0].carbs = 'Potato';
  assert.equal(plan({ days, existingItems: [item] })[0].existingId, null);
  assert.equal(JSON.stringify(item), before);
});

test('invalid rows, duplicate dishes, foreign IDs and incomplete publishing fail before persistence', () => {
  assert.throws(() => plan({ days: [{ date: '2026-02-30', items: [] }] }), /Invalid menu date/);
  assert.throws(() => plan({ days: [{ date: '2026-11-02', items: [] }] }), /outside/);
  assert.throws(() => plan({ days: [...baseDays(), ...baseDays()] }), /Duplicate/);
  const foreign = baseDays(); foreign[0].items[0].menuItemId = itemId;
  assert.throws(() => plan({ days: foreign }), /does not belong/);
  assert.throws(() => plan({ days: [], published: true }), /Add meals/);
  const unknown = baseDays(); unknown[0].items[0].portionType = '';
  assert.throws(() => plan({ days: unknown, published: true }), /protein type/);
});

const fixture = t => {
  const item = existing();
  const store = { menu: new Menu({ _id: menuId, title: 'Original', startDate, endDate, meals: [{ date: '2026-10-30', mealType: 'main', items: [item._id] }] }).toObject(), items: [item], selections: [], committed: false };
  let active, operations;
  const writes = [], deleted = [];
  const query = value => ({ session() { return this; }, select() { return this; }, lean: async () => value });
  t.mock.method(mongoose.connection, 'transaction', async callback => {
    active = { transaction: true }; operations = []; store.committed = false;
    const result = await callback(active);
    for (const operation of operations) operation();
    store.committed = true; return result;
  });
  t.mock.method(Menu, 'findById', () => ({ session: async () => Menu.hydrate(store.menu) }));
  t.mock.method(Item, 'find', filter => query(store.items.filter(item => filter._id.$in.some(id => String(id) === String(item._id)))));
  t.mock.method(Selection, 'find', filter => { assert.deepEqual(filter, { weeklyMenuId: menuId }); return query(store.selections); });
  t.mock.method(Selection, 'updateOne', () => assert.fail('Customer selections must not be written'));
  t.mock.method(Selection, 'findOneAndUpdate', () => assert.fail('Customer selections must not be replaced'));
  t.mock.method(Item, 'deleteMany', () => { deleted.push(true); assert.fail('Existing item references must not be deleted'); });
  t.mock.method(Item.prototype, 'save', async function (options) {
    assert.equal(options.session, active); const error = this.validateSync(); if (error) throw error;
    const row = this.toObject(); writes.push(row); operations.push(() => store.items.push(row)); return this;
  });
  t.mock.method(Menu.prototype, 'save', async function (options) {
    assert.equal(options.session, active); const error = this.validateSync(); if (error) throw error;
    const row = this.toObject(); operations.push(() => { store.menu = row; }); return this;
  });
  return { store, writes, deleted };
};

test('a late menu-save failure rolls back staged new items, and a successful retry commits all dishes together', async (t) => {
  const { store, writes } = fixture(t);
  const before = JSON.stringify(store);
  const save = Menu.prototype.save;
  t.mock.method(Menu.prototype, 'save', async () => { throw new Error('Simulated final save failure'); });
  const body = { title: 'Updated', days: [...baseDays(), { date: '2026-10-31', items: [{ mealName: 'New Beef', mealType: 'main', portionType: 'beef' }] }] };
  await assert.rejects(saveManagedMenu({ menuId, body, buildMealName, mergeUploadedSnackPools: () => {} }), /Simulated final save failure/);
  assert.equal(writes.length, 1);
  assert.equal(JSON.stringify(store), before);
  Menu.prototype.save = save;
  const result = await saveManagedMenu({ menuId, body, buildMealName, mergeUploadedSnackPools: () => {} });
  assert.equal(result.title, 'Updated'); assert.equal(store.items.length, 2);
  assert.equal(String(store.menu.meals[0].items[0]), itemId);
  assert.equal(store.committed, true);
});

test('metadata-only updates preserve selected dishes and reject shrinking dates around selections', async (t) => {
  const { store, writes } = fixture(t); store.selections = [selection()];
  const before = JSON.stringify(store.selections);
  await saveManagedMenu({ menuId, body: { title: 'New title' }, buildMealName, mergeUploadedSnackPools: () => {} });
  assert.equal(writes.length, 0); assert.equal(JSON.stringify(store.selections), before);
  await assert.rejects(saveManagedMenu({ menuId, body: { endDate: '2026-10-29' }, buildMealName, mergeUploadedSnackPools: () => {} }), /would exclude Existing Customer/);
});

test('legacy out-of-week selections do not block unchanged dates or dish reuploads', async (t) => {
  const { store } = fixture(t);
  const record = selection();
  record.selectedMeals.push({ ...record.selectedMeals[0], date: new Date('2026-11-04') });
  store.selections = [record];
  const before = JSON.stringify(record);
  await saveManagedMenu({ menuId, body: { title: 'Updated title', startDate, endDate, days: baseDays() }, buildMealName, mergeUploadedSnackPools: () => {} });
  assert.equal(JSON.stringify(store.selections[0]), before);
  assert.equal(String(store.menu.meals[0].items[0]), itemId);
  await assert.rejects(saveManagedMenu({ menuId, body: { endDate: '2026-10-29' }, buildMealName, mergeUploadedSnackPools: () => {} }), /would exclude Existing Customer/);
});

test('adding a new dish preserves selected IDs, duplicate portions, notes and remarks', async (t) => {
  const { store } = fixture(t);
  const record = selection();
  record.dayNotes = [{ date: '2026-10-30', note: 'Kitchen note' }];
  record.selectedMeals[0].remark = 'carb; sauce';
  store.selections = [record];
  const before = JSON.stringify(record);
  await saveManagedMenu({ menuId, body: { days: [...baseDays(), { date: '2026-10-31', items: [{ mealName: 'New Beef', mealType: 'main', portionType: 'beef' }] }] }, buildMealName, mergeUploadedSnackPools: () => {} });
  assert.equal(JSON.stringify(store.selections[0]), before);
  assert.equal(String(store.menu.meals[0].items[0]), itemId);
  assert.equal(store.items[0].mealName, 'Chosen Chicken');
  assert.equal(store.items.length, 2);
});

test('an unselected replacement preserves nutrition and presentation metadata that the editor did not change', async (t) => {
  const { store } = fixture(t);
  Object.assign(store.items[0], { calories: 500, protein: 40, fat: 15, image: 'dish.jpg', instructions: 'Serve warm', isAvailable: false });
  const days = baseDays(); days[0].items[0].carbs = 'Potato';
  await saveManagedMenu({ menuId, body: { days }, buildMealName, mergeUploadedSnackPools: () => {} });
  assert.equal(store.items[0].carbs, 'Rice');
  assert.equal(store.items[1].carbs, 'Potato');
  assert.equal(store.items[1].calories, 500); assert.equal(store.items[1].image, 'dish.jpg');
  assert.equal(store.items[1].instructions, 'Serve warm'); assert.equal(store.items[1].isAvailable, false);
});

test('empty days and legacy direct-reference payloads cannot clear a selected menu', async (t) => {
  const { store } = fixture(t); store.selections = [selection()];
  for (const body of [{ days: [] }, { meals: [] }]) await assert.rejects(saveManagedMenu({ menuId, body, buildMealName, mergeUploadedSnackPools: () => {} }), /Existing customer selections are protected/);
  assert.equal(String(store.menu.meals[0].items[0]), itemId);
});

test('creating and publishing are one transaction and a failure leaves no empty menu behind', async (t) => {
  const { store } = fixture(t);
  const result = await saveManagedMenu({ body: { title: 'Published menu', startDate, endDate, days: baseDays(), isPublished: true }, userId: new mongoose.Types.ObjectId(), buildMealName, mergeUploadedSnackPools: () => {} });
  assert.equal(result.isPublished, true); assert.equal(result.meals.length, 1); assert.equal(store.committed, true);
  const before = JSON.stringify(store);
  await assert.rejects(saveManagedMenu({ body: { title: '', startDate, endDate, days: baseDays() }, buildMealName, mergeUploadedSnackPools: () => {} }), /title/);
  assert.equal(JSON.stringify(store), before.replace('"committed":true', '"committed":false'));
});

test('a stale edit token rejects the save before creating any replacement dishes', async (t) => {
  const { store, writes } = fixture(t);
  store.menu.updatedAt = new Date('2026-10-28T10:00:00Z');
  await assert.rejects(saveManagedMenu({ menuId, body: { title: 'Stale', days: baseDays(), expectedUpdatedAt: '2026-10-28T09:00:00Z' }, buildMealName, mergeUploadedSnackPools: () => {} }), /changed since you opened/);
  assert.equal(writes.length, 0); assert.equal(store.menu.title, 'Original');
});

const handler = (path, method) => router.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route.stack.at(-1).handle;
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('the API synchronizes partner dishes only after a published menu commits, and never after a failed save', async (t) => {
  const { store } = fixture(t);
  const events = [];
  t.mock.method(PartnerItem, 'findOne', async () => { assert.equal(store.committed, true); events.push('partner-read-after-commit'); return null; });
  t.mock.method(PartnerItem, 'create', async () => ({ _id: new mongoose.Types.ObjectId() }));
  t.mock.method(Partner, 'find', () => ({ select() { return this; }, lean: async () => [] }));
  t.mock.method(console, 'error', () => {});
  const request = { params: { id: menuId }, user: { _id: new mongoose.Types.ObjectId() }, body: { days: baseDays(), isPublished: true } };
  const res = response();
  await handler('/:id', 'put')(request, res);
  assert.equal(res.statusCode, 200); assert.deepEqual(res.body.warnings, []);
  assert.equal(events.length, 1);
  t.mock.method(Menu.prototype, 'save', async () => { throw new Error('Database save failed'); });
  const failed = response();
  await handler('/:id', 'put')(request, failed);
  assert.equal(failed.statusCode, 503); assert.equal(failed.body.success, false);
  assert.equal(events.length, 1);
});

test('partner-sync failure after commit reports a saved-menu warning instead of implying the menu rolled back', async (t) => {
  const { store } = fixture(t);
  t.mock.method(PartnerItem, 'findOne', async () => { throw new Error('Partner source unavailable'); });
  t.mock.method(console, 'error', () => {});
  const res = response();
  await handler('/:id', 'put')({ params: { id: menuId }, user: { _id: new mongoose.Types.ObjectId() }, body: { isPublished: true } }, res);
  assert.equal(store.committed, true); assert.equal(res.statusCode, 200);
  assert.match(res.body.warnings[0], /Partner synchronization failed/);
});

test('deleting a menu with customer history is blocked before any menu or item deletion', async (t) => {
  const { store } = fixture(t);
  t.mock.method(Menu, 'findById', async () => store.menu);
  t.mock.method(Selection, 'exists', async () => ({ _id: 'existing-selection' }));
  t.mock.method(Menu, 'findByIdAndDelete', () => assert.fail('Selected menu must not be deleted'));
  const res = response();
  await handler('/:id', 'delete')({ params: { id: menuId } }, res);
  assert.equal(res.statusCode, 409);
});
