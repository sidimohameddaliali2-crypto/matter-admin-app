import { test } from 'node:test';
import assert from 'node:assert/strict';
import Delivery from '../models/Delivery.js';
import { ensureMatterDeliveryIdempotency, insertMatterDelivery, matterImportKey } from './matterDeliveryInsert.js';

test('database uniqueness is explicit and partial so historical/manual rows need no backfill', async t => {
  let definition;
  t.mock.method(Delivery.collection, 'createIndex', async (key, options) => { definition = [key, options]; });
  await ensureMatterDeliveryIdempotency();
  const declared = Delivery.schema.indexes().find(([key]) => key.matterImportKey === 1);
  assert.deepEqual(definition[0], { matterImportKey: 1 });
  assert.equal(definition[1].unique, true);
  assert.deepEqual(definition[1].partialFilterExpression, { matterImportKey: { $type: 'string' } });
  assert.equal(declared[1].name, definition[1].name);
  assert.equal(declared[1].unique, true);
  assert.equal(Delivery.schema.path('matterImportKey').options.immutable, true);
  assert.equal(new Delivery({}).matterImportKey, undefined);
});

test('a paused original insert loses safely when a recovery worker inserts the same obligation first', async t => {
  let pause;
  const held = new Promise(resolve => { pause = resolve; });
  let arrived;
  const originalAtInsert = new Promise(resolve => { arrived = resolve; });
  const stored = new Map();
  t.mock.method(Delivery, 'create', async row => {
    if (row.customerName === 'original-worker') { arrived(); await held; }
    // Emulate the unique index at MongoDB's insert boundary, not the earlier
    // eligibility lookup/lease check (both workers have already passed those).
    if (stored.has(row.matterImportKey)) throw Object.assign(new Error('duplicate obligation'), {
      code: 11000, keyPattern: { matterImportKey: 1 }, keyValue: { matterImportKey: row.matterImportKey }
    });
    stored.set(row.matterImportKey, row);
  });
  const original = insertMatterDelivery({ matterSubscriptionId: 'synthetic', customerName: 'original-worker' }, '2026-11-22');
  await originalAtInsert;
  const replacement = await insertMatterDelivery({ matterSubscriptionId: 'synthetic', customerName: 'replacement-worker' }, '2026-11-22');
  pause();
  assert.equal(await original, false);
  assert.equal(replacement, true);
  assert.equal(stored.size, 1);
  assert.equal(stored.get(matterImportKey('synthetic', '2026-11-22')).customerName, 'replacement-worker');
  assert.equal(await insertMatterDelivery({ matterSubscriptionId: 'synthetic', customerName: 'next-day' }, '2026-11-23'), true);
  assert.equal(await insertMatterDelivery({ matterSubscriptionId: 'other-subscription', customerName: 'other' }, '2026-11-22'), true);
  assert.equal(stored.size, 3);
});

test('unrelated duplicate keys and write failures are not hidden as already imported', async t => {
  for (const error of [Object.assign(new Error('other index'), { code: 11000, keyPattern: { otherKey: 1 } }), new Error('write failed')]) {
    t.mock.method(Delivery, 'create', async () => { throw error; });
    await assert.rejects(() => insertMatterDelivery({ matterSubscriptionId: 'synthetic' }, '2026-11-22'), error);
  }
});

test('an unavailable uniqueness index is a blocking error rather than permission to insert unprotected', async t => {
  t.mock.method(Delivery.collection, 'createIndex', async () => { throw new Error('index unavailable'); });
  await assert.rejects(ensureMatterDeliveryIdempotency, /index unavailable/);
});
