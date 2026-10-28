import test from 'node:test';
import assert from 'node:assert/strict';
import { validateKitchenUpload, kitchenUpload } from './kitchenUpload.js';
import mongoose from 'mongoose';
import Menu from '../models/WeeklyMenu.js';
import Breakfast from '../models/KitchenBreakfastPreset.js';
import Snack from '../models/KitchenSnackPreset.js';

const menu = { startDate: '2026-10-26', endDate: '2026-11-01' };
test('upload preview rejects the entire batch for a wrong date, type or macro', () => {
  const input = { mainByDate: { '2026-10-26': { mainMeals: [{ name: 'Chicken', type: 'chicken' }], subMeals: [] } } };
  assert.equal(validateKitchenUpload(input, menu).count, 1);
  assert.throws(() => validateKitchenUpload({ mainByDate: { '2026-11-02': input.mainByDate['2026-10-26'] } }, menu), /outside/);
  assert.throws(() => validateKitchenUpload({ mainByDate: { '2026-10-26': { mainMeals: [{ name: 'Unknown' }], subMeals: [] } } }, menu), /Protein/);
  assert.throws(() => validateKitchenUpload({ snackByDate: { '2026-10-26': { first: [{ name: 'Snack', C: -1 }], second: [] } } }, menu), /Invalid C/);
});

test('preview makes no writes and every commit write uses the same transaction session', async (t) => {
  const session = { transaction: 'fixture' };
  const sessions = [];
  const make = values => ({ ...values, updatedAt: new Date('2026-10-28T00:00:00Z'), save: async options => sessions.push(options.session) });
  const menuDoc = make({ ...menu, mainMealOptionsByDate: new Map(), snackOptionsByDate: new Map(), breakfastOptionsByDate: new Map() });
  const breakfast = make({ presetsByName: new Map() }), snack = make({ presetsByName: new Map() });
  const query = value => ({ session: async () => value });
  t.mock.method(Menu, 'findById', () => query(menuDoc));
  t.mock.method(Breakfast, 'findOne', () => query(breakfast));
  t.mock.method(Snack, 'findOne', () => query(snack));
  let transactions = 0;
  t.mock.method(mongoose.connection, 'transaction', async callback => { transactions++; return callback(session); });
  const input = { snackByDate: { '2026-10-26': { first: [{ name: 'Snack', C: 10, P: 5, F: 2 }], second: [] } } };
  const preview = await kitchenUpload('menu', { ...input, dryRun: true });
  assert.equal(sessions.length, 0);
  assert.equal(transactions, 0);
  await assert.rejects(kitchenUpload('menu', { ...input, expectedRevision: 'stale' }), /changed/);
  assert.equal(transactions, 0);
  await kitchenUpload('menu', { ...input, expectedRevision: preview.revision });
  assert.equal(transactions, 1);
  assert.deepEqual(sessions, [session, session]);
  t.mock.method(snack, 'save', async () => { throw new Error('Preset save failed'); });
  await assert.rejects(kitchenUpload('menu', { ...input, expectedRevision: preview.revision }), /Preset save failed/);
});
