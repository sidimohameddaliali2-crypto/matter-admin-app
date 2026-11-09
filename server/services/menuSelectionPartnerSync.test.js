import test from 'node:test';
import assert from 'node:assert/strict';
import PartnerMenuItem from '../models/PartnerMenuItem.js';
import MenuItem from '../models/MenuItem.js';
import Partner from '../models/Partner.js';
import { syncMenuSelectionMainMealsToPartnerMenu } from './menuSelectionPartnerSync.js';
import { partnerMenuNamePattern } from './partnerMenuCatalog.js';

const query = value => ({sort() {return this;}, select() {return this;}, lean: async () => value, then(resolve, reject) {return Promise.resolve(value).then(resolve, reject);}});

test('repeated sync reuses differently cased synced dishes and never retags manual dishes', async t => {
  const records = [
    {_id: 'manual', name: 'Chicken Quinoa', mealType: 'main', category: 'Chicken', source: 'manual'},
    {_id: 'synced', name: 'CHICKEN  QUINOA', mealType: 'main', category: 'Chicken', source: 'menu-selection', availableFrom: new Date('2026-11-01'), availableTo: new Date('2026-11-01')}
  ];
  let rows = [{_id: 'menu-item', mealName: 'Chicken Quinoa', portionType: 'chicken', itemDate: new Date('2026-11-12')}];
  t.mock.method(MenuItem, 'find', () => query(rows));
  t.mock.method(Partner, 'find', () => query([]));
  t.mock.method(PartnerMenuItem, 'findOne', filter => query(records.find(record => record.source === filter.source && record.mealType === filter.mealType && record.category === filter.category && filter.name.test(record.name)) || null));
  t.mock.method(PartnerMenuItem, 'updateOne', async (filter, update) => Object.assign(records.find(record => record._id === filter._id), update.$set));
  t.mock.method(PartnerMenuItem, 'create', async fields => {const record = {_id: 'created-' + records.length, ...fields}; records.push(record); return record;});
  const menu = {meals: [{mealType: 'main', items: ['menu-item']}]};
  assert.deepEqual(await syncMenuSelectionMainMealsToPartnerMenu(menu), {created: 0, updated: 1});
  rows = [{...rows[0], mealName: ' chicken   quinoa ', itemDate: new Date('2026-11-14')}];
  assert.deepEqual(await syncMenuSelectionMainMealsToPartnerMenu(menu), {created: 0, updated: 1});
  assert.equal(records.length, 2);
  assert.equal(records[0].source, 'manual');
  assert.equal(records[0].availableFrom, undefined);
  assert.equal(records[1].availableTo.toISOString().slice(0, 10), '2026-11-14');
});

test('name matching treats punctuation literally rather than as a fuzzy match', () => {
  const pattern = partnerMenuNamePattern('Chicken (A+B) [Rice]');
  assert.equal(pattern.test(' CHICKEN  (A+B) [RICE] '), true);
  assert.equal(pattern.test('Chicken AB Rice'), false);
});
