import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotIsFresh } from './kitchenProductionSnapshot.js';
import { beginKitchenState, readKitchenState } from './kitchenProductionSnapshot.js';
import Snapshot from '../models/KitchenProductionSnapshot.js';
import Menu from '../models/WeeklyMenu.js';
import Record from '../models/MenuSelectionRecord.js';
import Archive from '../models/MenuSelectionArchive.js';
import MenuItem from '../models/MenuItem.js';
import Breakfast from '../models/KitchenBreakfastPreset.js';
import Snack from '../models/KitchenSnackPreset.js';

test('a production snapshot is invalidated by source edits, expiry, failure or a future timestamp', () => {
  const now = Date.now();
  const snapshot = { status: 'ready', sourceVersion: 'revision', updatedAt: new Date(now - 1000) };
  assert.equal(snapshotIsFresh(snapshot, 'revision', now), true);
  assert.equal(snapshotIsFresh(snapshot, 'different', now), false);
  assert.equal(snapshotIsFresh({ ...snapshot, status: 'failed' }, 'revision', now), false);
  assert.equal(snapshotIsFresh({ ...snapshot, updatedAt: new Date(now - 61000) }, 'revision', now), false);
  assert.equal(snapshotIsFresh({ ...snapshot, updatedAt: new Date(now + 1) }, 'revision', now), false);
});

test('background preparation publishes one source version and an input edit invalidates it', async (t) => {
  const query = value => ({ select() { return this; }, sort() { return this; }, populate() { return this; }, lean: async () => value });
  const menu = { meals: [], updatedAt: new Date('2026-10-28T10:00:00Z') };
  t.mock.method(Menu, 'findById', () => query(menu));
  t.mock.method(Record, 'find', () => query([]));
  t.mock.method(Archive, 'find', () => query([]));
  t.mock.method(MenuItem, 'find', () => query([]));
  t.mock.method(Breakfast, 'findOne', () => query(null));
  t.mock.method(Snack, 'findOne', () => query(null));
  let job, finish;
  const saved = new Promise(resolve => { finish = resolve; });
  t.mock.method(Snapshot, 'findOne', filter => query(job && (filter._id || filter.status === job.status) ? job : null));
  t.mock.method(Snapshot, 'create', async values => {
    job = { ...values, _id: '507f1f77bcf86cd799439011', createdAt: new Date(), save: async () => { job.updatedAt = new Date(); finish(); } };
    return job;
  });
  let preparations = 0;
  const started = await beginKitchenState('menu', '2026-10-30', async () => { preparations++; return { data: { kitchenRoster: [], kitchenInputs: [], rosterComplete: true } }; });
  assert.equal(started.state, 'running');
  await saved;
  const ready = await readKitchenState('menu', '2026-10-30');
  assert.equal(ready.state, 'ready');
  assert.equal(ready.data.snapshotId, String(job._id));
  assert.equal(preparations, 1);
  menu.updatedAt = new Date('2026-10-28T10:01:00Z');
  assert.equal((await readKitchenState('menu', '2026-10-30')).state, 'missing');
});
