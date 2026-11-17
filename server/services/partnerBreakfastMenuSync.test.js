import test from 'node:test';
import mongoose from 'mongoose';
import WeeklyMenu from '../models/WeeklyMenu.js';
import assert from 'node:assert/strict';
import PartnerMenuItem from '../models/PartnerMenuItem.js';
import MenuItem from '../models/MenuItem.js';
import Partner from '../models/Partner.js';
import { partnerBreakfastDays, syncMenuSelectionBreakfastsToPartnerMenu } from './partnerBreakfastMenuSync.js';
import { isPartnerItemAvailable, partnerUnitPrice } from './partnerOrderValidation.js';
import { uniquePartnerMenuItems } from './partnerMenuCatalog.js';

const query = value => ({sort() {return this;}, session() {return this;}, select() {return this;}, lean: async () => value, then(resolve, reject) {return Promise.resolve(value).then(resolve, reject);}});
const key = date => new Date(date).toISOString().slice(0, 10);
const week = () => ({_id: 'week-one', isPublished: true, startDate: '2026-11-17', endDate: '2026-11-21', meals: [],
  breakfastOptionsByDate: new Map([['2026-11-17', [{name: 'EGG Toast'}, {name: ' egg  toast '}]], ['2026-11-19', [{name: 'Egg Toast'}]]])});

// Reads return detached snapshots and updates enforce the same atomic revision
// predicate as MongoDB, allowing deterministic overlapping-publication tests.
function breakfastStore(t) {
  const records = [], sources = new Map(), versions = new Map(), state = {conflicts: 0, sourceConflicts: 0, readGate: null};
  const saveSource = menu => {
    const id = String(menu._id);
    sources.set(id, structuredClone(menu)); versions.set(id, (versions.get(id) || 0) + 1);
  };
  t.mock.method(mongoose.connection, 'transaction', async callback => {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {return await callback({fixture: true});}
      catch (error) {if (!error.sourceConflict) throw error; state.sourceConflicts++;}
    }
    throw new Error('Source transaction retries exhausted');
  });
  t.mock.method(WeeklyMenu, 'findOneAndUpdate', (filter, update, options) => ({lean: async () => {
    assert.deepEqual(update, {$inc: {partnerBreakfastSyncRevision: 1}});
    assert.equal(options.timestamps, false);
    options.session.menuId = String(filter._id);
    options.session.sourceVersion = versions.get(String(filter._id));
    return structuredClone(sources.get(String(filter._id)));
  }}));
  const sync = menu => {saveSource(menu); return syncMenuSelectionBreakfastsToPartnerMenu(menu);};
  const clone = value => value == null ? value : structuredClone(value);
  t.mock.method(MenuItem, 'find', () => query([]));
  t.mock.method(Partner, 'find', () => query([]));
  t.mock.method(PartnerMenuItem, 'init', async () => {});
  t.mock.method(PartnerMenuItem, 'findOne', filter => query(clone(records.find(item =>
    item.source === filter.source && item.mealType === filter.mealType &&
    (typeof filter.breakfastSyncKey === 'string' ? item.breakfastSyncKey === filter.breakfastSyncKey :
      item.breakfastSyncKey === undefined && filter.name.test(item.name))) || null)));
  t.mock.method(PartnerMenuItem, 'findById', id => ({session() {return this;}, lean: async () => {
    const snapshot = clone(records.find(item => item._id === id));
    if (state.readGate) await state.readGate();
    return snapshot;
  }}));
  t.mock.method(PartnerMenuItem, 'find', filter => {
    const menuId = Object.keys(filter).find(field => field.startsWith('menuSelectionDatesByMenu.')).split('.')[1];
    return query(clone(records.filter(item => Object.hasOwn(item.menuSelectionDatesByMenu || {}, menuId))));
  });
  t.mock.method(PartnerMenuItem, 'updateOne', async (filter, update, {session}) => {
    if (versions.get(session.menuId) !== session.sourceVersion) throw Object.assign(new Error('Source changed'), {sourceConflict: true});
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
  return {records, state, sources, sync, saveSource};
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
  const {records, sync} = breakfastStore(t);
  const first = week();
  assert.deepEqual(await sync(first), {created: 1, updated: 0});
  const item = records[0];
  assert.equal(partnerUnitPrice(item), 20);
  assert.equal(item.category, 'Breakfast of the day');
  assert.equal(isPartnerItemAvailable(item, '2026-11-17'), true);
  assert.equal(isPartnerItemAvailable(item, '2026-11-18'), false);
  assert.equal(isPartnerItemAvailable(item, '2026-11-19'), true);
  item.price = 10; item.sellingPrice = 17;
  assert.deepEqual(await sync(first), {created: 0, updated: 1});
  assert.equal(records.length, 1); assert.equal(partnerUnitPrice(item), 17);
  const second = {...first, _id: 'week-two', startDate: '2026-11-24', endDate: '2026-11-28', breakfastOptionsByDate: {'2026-11-24': [{name: 'egg toast'}]}};
  await sync(second);
  assert.deepEqual(item.availableDates.map(key), ['2026-11-17', '2026-11-19', '2026-11-24']);
  first.breakfastOptionsByDate = {};
  await sync(first);
  assert.deepEqual(item.availableDates.map(key), ['2026-11-24']);
  item.isAvailable = false;
  await sync(second);
  assert.equal(item.isAvailable, false); assert.equal(item.sellingPrice, 17);
  second.breakfastOptionsByDate = {};
  await sync(second);
  assert.deepEqual(item.availableDates, []);
  assert.equal(records.length, 1);
});

test('unpublished menus without previous contributions make no writes', async t => {
  const {sync} = breakfastStore(t);
  const create = t.mock.method(PartnerMenuItem, 'create', async () => {throw new Error('No writes allowed');});
  assert.deepEqual(await sync({...week(), isPublished: false}), {created: 0, updated: 0});
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
  const {records, sync} = breakfastStore(t);
  const first = week();
  await sync(first);
  await sync(nextWeek());
  first.isPublished = false; // Keep its configured options, as the unpublish API does.
  await sync(first);
  assert.deepEqual(records[0].availableDates.map(key), ['2026-11-24']);
  assert.equal(Object.hasOwn(records[0].menuSelectionDatesByMenu, 'week-one'), false);
  assert.deepEqual(await sync(first), {created: 0, updated: 0});
});

test('concurrent publications retry stale revisions and preserve both menus and edited prices', async t => {
  const {records, state, sync} = breakfastStore(t);
  await sync(week());
  records[0].sellingPrice = 29;
  state.overlapNextReads();
  await Promise.all([sync(week()), sync(nextWeek())]);
  assert.ok(state.conflicts > 0);
  assert.deepEqual(records[0].availableDates.map(key), ['2026-11-17', '2026-11-19', '2026-11-24']);
  assert.equal(records[0].sellingPrice, 29);
});

test('simultaneous first publications create one breakfast with both schedules', async t => {
  const {records, state, sync} = breakfastStore(t);
  state.overlapNextReads();
  await Promise.all([sync(week()), sync(nextWeek())]);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].availableDates.map(key), ['2026-11-17', '2026-11-19', '2026-11-24']);
  assert.ok(state.conflicts > 0);
});

test('a concurrent withdrawal and publication cannot restore withdrawn dates or lose new dates', async t => {
  const {records, state, sync} = breakfastStore(t);
  await sync(week());
  state.overlapNextReads();
  await Promise.all([sync({...week(), isPublished: false}), sync(nextWeek())]);
  assert.ok(state.conflicts > 0);
  assert.deepEqual(records[0].availableDates.map(key), ['2026-11-24']);
  assert.deepEqual(Object.keys(records[0].menuSelectionDatesByMenu), ['week-two']);
});

test('legacy schedules without revisions are adopted without losing other menus', async t => {
  const {records, sync} = breakfastStore(t);
  records.push({_id: 'legacy', name: 'Egg Toast', source: 'menu-selection', mealType: 'breakfast', sellingPrice: 23,
    menuSelectionDatesByMenu: {'old-week': [new Date('2026-11-10')]}});
  await sync(week());
  assert.equal(records.length, 1);
  assert.equal(records[0].breakfastScheduleRevision, 1);
  assert.equal(records[0].sellingPrice, 23);
  assert.deepEqual(records[0].availableDates.map(key), ['2026-11-10', '2026-11-17', '2026-11-19']);
});

test('repeated revision conflicts report a retryable failure without overwriting schedules', async t => {
  const {records, sync} = breakfastStore(t);
  await sync(week());
  const before = structuredClone(records[0]);
  const writes = t.mock.method(PartnerMenuItem, 'updateOne', async () => ({matchedCount: 0}));
  await assert.rejects(sync(nextWeek()), /retry saving the menu/);
  assert.equal(writes.mock.callCount(), 10);
  assert.deepEqual(records[0], before);
});

test('canonical breakfast keys have a unique index excluding legacy and manual items', () => {
  const index = PartnerMenuItem.schema.indexes().find(([fields]) => fields.breakfastSyncKey === 1);
  assert.equal(index[1].unique, true);
  assert.deepEqual(index[1].partialFilterExpression, {source: 'menu-selection', mealType: 'breakfast', breakfastSyncKey: {$type: 'string'}});
});

// Pause a single worker without blocking the newer request from completing.
function pauseNextItemRead(state) {
  let resume, paused;
  const reached = new Promise(resolve => {paused = resolve;});
  const waiting = new Promise(resolve => {resume = resolve;});
  state.readGate = async () => {state.readGate = null; paused(); await waiting;};
  return {reached, resume};
}

test('a delayed publication cannot restore dates after a newer unpublish completes', async t => {
  const {records, state, sync} = breakfastStore(t);
  await sync(week());
  const pause = pauseNextItemRead(state);
  const olderPublish = sync(week());
  await pause.reached; // Old transaction has already read the published source.
  await sync({...week(), isPublished: false});
  pause.resume();
  await olderPublish;
  assert.ok(state.sourceConflicts > 0, 'the transaction must retry its source snapshot');
  assert.deepEqual(records[0].availableDates, []);
  assert.equal(isPartnerItemAvailable(records[0], '2026-11-17'), false);
});

test('a delayed unpublish cannot remove dates after a newer publication completes', async t => {
  const {records, state, sync} = breakfastStore(t);
  await sync(week());
  const pause = pauseNextItemRead(state);
  const olderWithdrawal = sync({...week(), isPublished: false});
  await pause.reached;
  await sync(week());
  pause.resume();
  await olderWithdrawal;
  assert.ok(state.sourceConflicts > 0);
  assert.deepEqual(records[0].availableDates.map(key), ['2026-11-17', '2026-11-19']);
});

test('a stale snapshot starting after withdrawal cannot create orderable dates on its first publication', async t => {
  const {records, saveSource} = breakfastStore(t);
  saveSource({...week(), isPublished: false});
  await syncMenuSelectionBreakfastsToPartnerMenu(week());
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].availableDates, []);
});

test('a delayed option edit cannot replace the dates from a newer edit of the same menu', async t => {
  const {records, state, sync} = breakfastStore(t);
  await sync(week());
  const pause = pauseNextItemRead(state);
  const olderEdit = sync(week());
  await pause.reached;
  await sync({...week(), breakfastOptionsByDate: {'2026-11-20': [{name: 'Egg Toast'}]}});
  pause.resume();
  await olderEdit;
  assert.ok(state.sourceConflicts > 0);
  assert.deepEqual(records[0].availableDates.map(key), ['2026-11-20']);
});
