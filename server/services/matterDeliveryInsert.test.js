import { test } from 'node:test';
import assert from 'node:assert/strict';
import Delivery from '../models/Delivery.js';
import { MATTER_IMPORT_IDENTITIES } from '../config/matterImportIdentity.js';
import { ensureMatterDeliveryIdempotency, insertMatterDelivery, matterImportKey } from './matterDeliveryInsert.js';

test('database uniqueness is explicit and partial so historical/manual rows need no backfill', async t => {
  const definitions = [];
  t.mock.method(Delivery.collection, 'createIndex', async (key, options) => { definitions.push([key, options]); });
  await ensureMatterDeliveryIdempotency();
  assert.equal(definitions.length, 3);
  for (const [field, name] of MATTER_IMPORT_IDENTITIES) {
    const [key, options] = definitions.find(([key]) => key[field] === 1);
    const declared = Delivery.schema.indexes().find(([key]) => key[field] === 1);
    assert.deepEqual(key, { [field]: 1 });
    assert.equal(options.unique, true);
    assert.deepEqual(options.partialFilterExpression, { [field]: { $type: 'string' } });
    assert.equal(options.name, name);
    assert.equal(declared[1].name, name);
    assert.equal(declared[1].unique, true);
    assert.equal(Delivery.schema.path(field).options.immutable, true);
    assert.equal(new Delivery({})[field], undefined);
  }
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
  const original = insertMatterDelivery({ customerId: 'C1', matterSubscriptionId: 'synthetic', customerName: 'original-worker' }, '2026-11-22');
  await originalAtInsert;
  const replacement = await insertMatterDelivery({ customerId: 'C1', matterSubscriptionId: 'synthetic', customerName: 'replacement-worker' }, '2026-11-22');
  pause();
  assert.equal(await original, false);
  assert.equal(replacement, true);
  assert.equal(stored.size, 1);
  assert.equal(stored.get(matterImportKey('synthetic', '2026-11-22')).customerName, 'replacement-worker');
  assert.equal(await insertMatterDelivery({ customerId: 'C1', matterSubscriptionId: 'synthetic', customerName: 'next-day' }, '2026-11-23'), true);
  assert.equal(await insertMatterDelivery({ customerId: 'C2', matterSubscriptionId: 'other-subscription', customerName: 'other' }, '2026-11-22'), true);
  assert.equal(stored.size, 3);
});

test('unrelated duplicate keys and write failures are not hidden as already imported', async t => {
  for (const error of [Object.assign(new Error('other index'), { code: 11000, keyPattern: { otherKey: 1 } }), new Error('write failed')]) {
    t.mock.method(Delivery, 'create', async () => { throw error; });
    await assert.rejects(() => insertMatterDelivery({ customerId: 'C1', matterSubscriptionId: 'synthetic' }, '2026-11-22'), error);
  }
});

test('an unavailable uniqueness index is a blocking error rather than permission to insert unprotected', async t => {
  t.mock.method(Delivery.collection, 'createIndex', async () => { throw new Error('index unavailable'); });
  await assert.rejects(ensureMatterDeliveryIdempotency, /index unavailable/);
});

for (const relinked of [false, true]) {
  test(`a renewed subscription cannot create two stops after recovery${relinked ? ', even with a different internal link' : ''}`, async t => {
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    let reached;
    const paused = new Promise(resolve => { reached = resolve; });
    const stored = [];
    t.mock.method(Delivery, 'create', async row => {
      if (row.matterSubscriptionId === 'old-cycle') { reached(); await hold; }
      for (const [field] of MATTER_IMPORT_IDENTITIES) {
        if (row[field] && stored.some(other => other[field] === row[field])) throw Object.assign(new Error('duplicate stop'), {
          code: 11000, keyPattern: { [field]: 1 }, keyValue: { [field]: row[field] }
        });
      }
      stored.push(row);
    });
    const original = insertMatterDelivery({ customerId: 'C1', matterCustomerId: 'permanent-customer', matterSubscriptionId: 'old-cycle' }, '2026-11-22');
    await paused;
    const replacement = await insertMatterDelivery({ customerId: relinked ? 'C2' : 'C1', matterCustomerId: 'permanent-customer', matterSubscriptionId: 'new-cycle' }, '2026-11-22');
    release();
    assert.equal(replacement, true);
    assert.equal(await original, false);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].matterSubscriptionId, 'new-cycle');
    assert.equal(await insertMatterDelivery({ customerId: 'C1', matterCustomerId: 'permanent-customer', matterSubscriptionId: 'new-cycle' }, '2026-11-23'), true);
  });
}
