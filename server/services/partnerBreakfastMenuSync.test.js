import test from 'node:test';
import assert from 'node:assert/strict';
import PartnerMenuItem from '../models/PartnerMenuItem.js';
import MenuItem from '../models/MenuItem.js';
import Partner from '../models/Partner.js';
import { partnerBreakfastDays, syncMenuSelectionBreakfastsToPartnerMenu } from './partnerBreakfastMenuSync.js';
import { isPartnerItemAvailable, partnerUnitPrice } from './partnerOrderValidation.js';
import { uniquePartnerMenuItems } from './partnerMenuCatalog.js';

const query = value => ({sort() {return this;}, select() {return this;}, lean: async () => value, then(resolve, reject) {return Promise.resolve(value).then(resolve, reject);}});
const key = date => new Date(date).toISOString().slice(0, 10);
const week = () => ({_id: 'week-one', isPublished: true, startDate: '2026-11-17', endDate: '2026-11-21', meals: [],
  breakfastOptionsByDate: new Map([['2026-11-17', [{name: 'EGG Toast'}, {name: ' egg  toast '}]], ['2026-11-19', [{name: 'Egg Toast'}]]])});

test('breakfast rotation de-duplicates per date, prefers configured options and falls back to uploaded items', () => {
  const menu = week();
  menu.meals = [{date: '2026-11-17', mealType: 'breakfast', items: ['fallback']}, {date: '2026-11-18', mealType: 'breakfast', items: ['oats', 'disabled']}];
  const result = partnerBreakfastDays(menu, [{_id: 'fallback', mealName: 'Ignored fallback'}, {_id: 'oats', mealName: 'Berry oats'}, {_id: 'disabled', mealName: 'Disabled', isAvailable: false}]);
  assert.deepEqual(result, [{name: 'EGG Toast', dates: ['2026-11-17', '2026-11-19']}, {name: 'Berry oats', dates: ['2026-11-18']}]);
});

test('breakfast sync retains one ID, editable prices and exact serving dates across menus', async t => {
  const records = [];
  t.mock.method(MenuItem, 'find', () => query([]));
  t.mock.method(Partner, 'find', () => query([]));
  t.mock.method(PartnerMenuItem, 'findOne', filter => query(records.find(item => item.source === filter.source && item.mealType === filter.mealType && filter.name.test(item.name)) || null));
  t.mock.method(PartnerMenuItem, 'find', filter => {
    const menuId = Object.keys(filter).find(field => field.startsWith('menuSelectionDatesByMenu.')).split('.')[1];
    return query(records.filter(item => Object.hasOwn(item.menuSelectionDatesByMenu || {}, menuId)));
  });
  t.mock.method(PartnerMenuItem, 'updateOne', async (filter, update) => Object.assign(records.find(item => item._id === filter._id), update.$set));
  t.mock.method(PartnerMenuItem, 'create', async fields => {const item = {_id: 'id-' + records.length, ...fields}; records.push(item); return item;});
  const first = week();
  assert.deepEqual(await syncMenuSelectionBreakfastsToPartnerMenu(first), {created: 1, updated: 0});
  const item = records[0];
  assert.equal(partnerUnitPrice(item), 12);
  assert.equal(item.category, 'Breakfast of the day');
  assert.equal(isPartnerItemAvailable(item, '2026-11-17'), true);
  assert.equal(isPartnerItemAvailable(item, '2026-11-18'), false);
  assert.equal(isPartnerItemAvailable(item, '2026-11-19'), true);
  item.price = 10; item.sellingPrice = 17;
  assert.deepEqual(await syncMenuSelectionBreakfastsToPartnerMenu(first), {created: 0, updated: 1});
  assert.equal(records.length, 1); assert.equal(partnerUnitPrice(item), 17);
  const second = {...first, _id: 'week-two', startDate: '2026-11-24', endDate: '2026-11-28', breakfastOptionsByDate: {'2026-11-24': [{name: 'egg toast'}]}};
  await syncMenuSelectionBreakfastsToPartnerMenu(second);
  assert.deepEqual(item.availableDates.map(key), ['2026-11-17', '2026-11-19', '2026-11-24']);
  first.breakfastOptionsByDate = {};
  await syncMenuSelectionBreakfastsToPartnerMenu(first);
  assert.deepEqual(item.availableDates.map(key), ['2026-11-24']);
  item.isAvailable = false;
  await syncMenuSelectionBreakfastsToPartnerMenu(second);
  assert.equal(item.isAvailable, false); assert.equal(item.sellingPrice, 17);
  second.breakfastOptionsByDate = {};
  await syncMenuSelectionBreakfastsToPartnerMenu(second);
  assert.deepEqual(item.availableDates, []);
  assert.equal(records.length, 1);
});

test('draft menus do not create or update partner breakfasts', async t => {
  const create = t.mock.method(PartnerMenuItem, 'create', async () => {throw new Error('No writes allowed');});
  assert.deepEqual(await syncMenuSelectionBreakfastsToPartnerMenu({...week(), isPublished: false}), {created: 0, updated: 0});
  assert.equal(create.mock.callCount(), 0);
});

test('synced breakfast and main names appear once per date while referenced order IDs remain editable', () => {
  const first = {_id: 'a', name: 'EGG  TOAST', source: 'menu-selection', mealType: 'breakfast', category: 'Breakfast of the day'};
  const duplicate = {...first, _id: 'b', name: 'Egg Toast'};
  const main = {_id: 'c', name: 'CHICKEN RICE', source: 'menu-selection', mealType: 'main', category: 'Chicken'};
  const mainCopy = {...main, _id: 'd', name: 'Chicken Rice'};
  assert.deepEqual(uniquePartnerMenuItems([duplicate, mainCopy, first, main]).map(item => item._id), ['a', 'c']);
  assert.deepEqual(uniquePartnerMenuItems([first, duplicate], ['b']).map(item => item._id), ['b']);
  assert.deepEqual(uniquePartnerMenuItems([first, duplicate], ['a', 'b']).map(item => item._id), ['a', 'b']);
});

test('partner breakfast schema stores its exact dates and per-menu schedule', async () => {
  const item = new PartnerMenuItem({name: 'Egg Toast', mealType: 'breakfast', price: 12, availableDates: ['2026-11-17'],
    menuSelectionDatesByMenu: {'507f1f77bcf86cd799439011': ['2026-11-17']}});
  await item.validate();
  assert.equal(key(item.availableDates[0]), '2026-11-17');
  assert.equal(item.menuSelectionDatesByMenu.size, 1);
});
