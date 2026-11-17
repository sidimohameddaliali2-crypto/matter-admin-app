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

// Reads return detached snapshots and updates enforce the same atomic revision
// predicate as MongoDB, allowing deterministic overlapping-publication tests.
function breakfastStore(t) {
  const records = [], state = {conflicts: 0, readGate: null};
  const clone = value => value == null ? value : structuredClone(value);
  t.mock.method(MenuItem, 'find', () => query([]));
  t.mock.method(Partner, 'find', () => query([]));
  t.mock.method(PartnerMenuItem, 'init', async () => {});
  t.mock.method(PartnerMenuItem, 'findOne', filter => query(clone(records.find(item =>
    item.source === filter.source && item.mealType === filter.mealType &&
    (typeof filter.breakfastSyncKey === 'string' ? item.breakfastSyncKey === filter.breakfastSyncKey :
      item.breakfastSyncKey === undefined && filter.name.test(item.name))) || null)));
  t.mock.method(PartnerMenuItem, 'findById', id => ({lean: async () => {
    const snapshot = clone(records.find(item => item._id === id));
    if (state.readGate) await state.readGate();
    return snapshot;
  }}));
  t.mock.method(PartnerMenuItem, 'find', filter => {
    const menuId = Object.keys(filter).find(field => field.startsWith('menuSelectionDatesByMenu.')).split('.')[1];
    return query(clone(records.filter(item => Object.hasOwn(item.menuSelectionDatesByMenu || {}, menuId))));
  });
  t.mock.method(PartnerMenuItem, 'updateOne', async (filter, update) => {
    const item = records.find(item => item._id === filter._id);
    const revision = filter.breakfastScheduleRevision;
    if (!item || (typeof revision === 'number' ? item.breakfastScheduleRevision !== revision : item.breakfastScheduleRevision !== undefined)) {
      state.conflicts++; return {matchedCount: 0};
    }
    Object.assign(item, clone(update.$set));
    item.breakfastScheduleRevision = (item.breakfastScheduleRevision || 0) + update.$inc.breakfastScheduleRevision;
    return {matchedCount: 1};
  });
  t.mock.method(PartnerMenuItem, 'create', async fields => {
    if (records.some(item => item.breakfastSyncKey === fields.breakfastSyncKey)) throw Object.assign(new Error('Duplicate key'), {code: 11000});
    const item = {_id: 'id-' + records.length, ...clone(fields)};
    records.push(item); return clone(item);
  });
  state.overlapNextReads = () => {
    let reads = 0, release;
    const ready = new Promise(resolve => { release = resolve; });
    state.readGate = async () => {
      if (++reads === 2) { state.readGate = null; release(); }
      await ready;
    };
  };
  return {records, state};
}
const nextWeek = () => ({...week(), _id: 'week-two', startDate: '2026-11-24', endDate: '2026-11-28',
  breakfastOptionsByDate: {'2026-11-24': [{name: 'egg toast'}]}});

test('breakfast rotation de-duplicates per date, prefers configured options and falls back to uploaded items', () => {
  const menu = week();
  menu.meals = [{date: '2026-11-17', mealType: 'breakfast', items: ['fallback']}, {date: '2026-11-18', mealType: 'breakfast', items: ['oats', 'disabled']}];
  const result = partnerBreakfastDays(menu, [{_id: 'fallback', mealName: 'Ignored fallback'}, {_id: 'oats', mealName: 'Berry oats'}, {_id: 'disabled', mealName: 'Disabled', isAvailable: false}]);
  assert.deepEqual(result, [{name: 'EGG Toast', dates: ['2026-11-17', '2026-11-19']}, {name: 'Berry oats', dates: ['2026-11-18']}]);
});

test('breakfast sync retains one ID, editable prices and exact serving dates across menus', async t => {
  const {records} = breakfastStore(t);
  const first = week();
  assert.deepEqual(await syncMenuSelectionBreakfastsToPartnerMenu(first), {created: 1, updated: 0});
  const item = records[0];
  assert.equal(partnerUnitPrice(item), 20);
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

test('unpublished menus without previous contributions make no writes', async t => {
  t.mock.method(PartnerMenuItem, 'find', () => query([]));
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

test('unpublishing removes only the withdrawn menu contribution and is idempotent', async t => {
  const {records} = breakfastStore(t);
  const first = week();
  await syncMenuSelectionBreakfastsToPartnerMenu(first);
  await syncMenuSelectionBreakfastsToPartnerMenu(nextWeek());
  first.isPublished = false; // Keep its configured options, as the unpublish API does.
  await syncMenuSelectionBreakfastsToPartnerMenu(first);
  assert.deepEqual(records[0].availableDates.map(key), ['2026-11-24']);
  assert.equal(Object.hasOwn(records[0].menuSelectionDatesByMenu, 'week-one'), false);
  assert.deepEqual(await syncMenuSelectionBreakfastsToPartnerMenu(first), {created: 0, updated: 0});
});

test('concurrent publications retry stale revisions and preserve both menus and edited prices', async t => {
  const {records, state} = breakfastStore(t);
  await syncMenuSelectionBreakfastsToPartnerMenu(week());
  records[0].sellingPrice = 29;
  state.overlapNextReads();
  await Promise.all([syncMenuSelectionBreakfastsToPartnerMenu(week()), syncMenuSelectionBreakfastsToPartnerMenu(nextWeek())]);
  assert.ok(state.conflicts > 0);
  assert.deepEqual(records[0].availableDates.map(key), ['2026-11-17', '2026-11-19', '2026-11-24']);
  assert.equal(records[0].sellingPrice, 29);
});

test('simultaneous first publications create one breakfast with both schedules', async t => {
  const {records, state} = breakfastStore(t);
  state.overlapNextReads();
  await Promise.all([syncMenuSelectionBreakfastsToPartnerMenu(week()), syncMenuSelectionBreakfastsToPartnerMenu(nextWeek())]);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].availableDates.map(key), ['2026-11-17', '2026-11-19', '2026-11-24']);
  assert.ok(state.conflicts > 0);
});

test('a concurrent withdrawal and publication cannot restore withdrawn dates or lose new dates', async t => {
  const {records, state} = breakfastStore(t);
  await syncMenuSelectionBreakfastsToPartnerMenu(week());
  state.overlapNextReads();
  await Promise.all([syncMenuSelectionBreakfastsToPartnerMenu({...week(), isPublished: false}), syncMenuSelectionBreakfastsToPartnerMenu(nextWeek())]);
  assert.ok(state.conflicts > 0);
  assert.deepEqual(records[0].availableDates.map(key), ['2026-11-24']);
  assert.deepEqual(Object.keys(records[0].menuSelectionDatesByMenu), ['week-two']);
});

test('legacy schedules without revisions are adopted without losing other menus', async t => {
  const {records} = breakfastStore(t);
  records.push({_id: 'legacy', name: 'Egg Toast', source: 'menu-selection', mealType: 'breakfast', sellingPrice: 23,
    menuSelectionDatesByMenu: {'old-week': [new Date('2026-11-10')]}});
  await syncMenuSelectionBreakfastsToPartnerMenu(week());
  assert.equal(records.length, 1);
  assert.equal(records[0].breakfastScheduleRevision, 1);
  assert.equal(records[0].sellingPrice, 23);
  assert.deepEqual(records[0].availableDates.map(key), ['2026-11-10', '2026-11-17', '2026-11-19']);
});

test('repeated revision conflicts report a retryable failure without overwriting schedules', async t => {
  const {records} = breakfastStore(t);
  await syncMenuSelectionBreakfastsToPartnerMenu(week());
  const before = structuredClone(records[0]);
  const writes = t.mock.method(PartnerMenuItem, 'updateOne', async () => ({matchedCount: 0}));
  await assert.rejects(syncMenuSelectionBreakfastsToPartnerMenu(nextWeek()), /retry saving the menu/);
  assert.equal(writes.mock.callCount(), 10);
  assert.deepEqual(records[0], before);
});

test('canonical breakfast keys have a unique index excluding legacy and manual items', () => {
  const index = PartnerMenuItem.schema.indexes().find(([fields]) => fields.breakfastSyncKey === 1);
  assert.equal(index[1].unique, true);
  assert.deepEqual(index[1].partialFilterExpression, {source: 'menu-selection', mealType: 'breakfast', breakfastSyncKey: {$type: 'string'}});
});
