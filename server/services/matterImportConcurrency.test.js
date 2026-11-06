import test from 'node:test';
import assert from 'node:assert/strict';
import { mockScheduledWork } from '../testSupport/scheduledWorkFixture.js';
import { importMatterDeliveriesForDate, matterImportKey } from './matterDeliveryImportService.js';
import matter from './matterApiService.js';
import Customer from '../models/Customer.js';
import Delivery from '../models/Delivery.js';

const date = '2099-01-02';
const sub = { subscription_id: 'fixture-sub', name: 'Fixture', email: 'fixture@example.com', delivery_date: date,
  delivery_window: { label: 'By 6 AM' }, customer_addresses: [{ id: 1, current_delivery_address: true, status: 'active', building: 'Fixture Building', emirate: 'Dubai' }] };
function fixture(t) {
  mockScheduledWork(t);
  const state = { rows: [], indexReady: false, creates: 0, fail: null, pause: null };
  t.mock.method(matter, 'findSubscriptionsWithDeliveryOnDate', async () => [sub]);
  t.mock.method(Customer, 'findOne', () => ({ select: async () => ({ customerId: 'fixture-customer', firstName: 'Fixture' }) }));
  t.mock.method(Delivery.collection, 'createIndex', async (key, options) => {
    assert.deepEqual(key, { matterImportKey: 1 }); assert.equal(options.unique, true);
    assert.deepEqual(options.partialFilterExpression, { matterImportKey: { $type: 'string' } });
    if (state.indexFailure) throw new Error('cannot create unique index'); state.indexReady = true;
  });
  t.mock.method(Delivery, 'findOne', filter => ({ select: async () => {
    if (filter.$or) return state.rows.find(row => row.matterImportKey === filter.$or[0].matterImportKey
      || (row.matterSubscriptionId === filter.$or[1].matterSubscriptionId && row.scheduledTime >= filter.$or[1].scheduledTime.$gte && row.scheduledTime < filter.$or[1].scheduledTime.$lt)) || null;
    return state.other || null;
  } }));
  t.mock.method(Delivery, 'create', async row => {
    assert(state.indexReady, 'must establish unique index before insert'); state.creates++;
    if (state.pause) await state.pause();
    if (state.fail) throw state.fail;
    if (state.rows.some(r => r.matterImportKey === row.matterImportKey)) throw Object.assign(new Error('duplicate'), { code: 11000, keyPattern: { matterImportKey: 1 } });
    const stored = { _id: `row-${state.rows.length}`, status: 'pending', ...row }; state.rows.push(stored); return stored;
  });
  return state;
}

test('simultaneous import calls serialize writes and retries preserve one stop after time/date edits', async t => {
  const state = fixture(t); let resume, started;
  state.pause = () => new Promise(resolve => { resume = resolve; started = true; });
  const first = importMatterDeliveriesForDate(date);
  while (!started) await Promise.resolve();
  await assert.rejects(importMatterDeliveriesForDate(date), { code: 'MATTER_IMPORT_BUSY', statusCode: 409 });
  resume(); const result = await first; assert.equal(result.created, 1);
  state.pause = null; state.rows[0].scheduledTime = new Date('2099-01-04T02:00:00Z');
  const retry = await importMatterDeliveriesForDate(date);
  assert.equal(retry.alreadyExisted, 1); assert.equal(retry.created, 0);
  assert.equal(state.rows.length, 1); assert.equal(state.creates, 1);
  assert.equal(state.rows[0].scheduledTime.toISOString(), '2099-01-04T02:00:00.000Z');
});

test('unique-key race is a safe repeat; unrelated failures remain incomplete and retryable', async t => {
  const state = fixture(t);
  state.fail = Object.assign(new Error('duplicate'), { code: 11000, keyPattern: { matterImportKey: 1 } });
  let result = await importMatterDeliveriesForDate(date);
  assert.equal(result.complete, true); assert.equal(result.alreadyExisted, 1);
  state.fail = Object.assign(new Error('unrelated duplicate'), { code: 11000, keyPattern: { otherField: 1 } });
  result = await importMatterDeliveriesForDate(date);
  assert.equal(result.complete, false); assert.equal(result.writeFailed, 1);
  state.fail = null; assert.equal((await importMatterDeliveriesForDate(date)).created, 1);
});

test('index failure stops insertion; existing other-source deliveries and legacy imports are preserved', async t => {
  const state = fixture(t); state.indexFailure = true;
  const failed = await importMatterDeliveriesForDate(date);
  assert.equal(failed.complete, false); assert.equal(state.creates, 0);
  state.indexFailure = false;
  state.other = { _id: 'manual', customerName: 'Fixture', scheduledTime: new Date('2099-01-02T02:00:00Z'), status: 'pending' };
  assert.equal((await importMatterDeliveriesForDate(date)).alreadyHadOtherDelivery, 1);
  state.other = null;
  state.rows.push({ _id: 'legacy', customerName: 'Fixture', matterSubscriptionId: sub.subscription_id, scheduledTime: new Date('2099-01-02T02:00:00Z'), status: 'delivered' });
  assert.equal((await importMatterDeliveriesForDate(date)).alreadyExisted, 1);
  assert.equal(state.creates, 0);
});

test('import identity is immutable and unique per subscription/business date; dates are strictly validated', async () => {
  assert.equal(Delivery.schema.path('matterImportKey').options.immutable, true);
  assert(Delivery.schema.indexes().some(([fields, options]) => fields.matterImportKey === 1 && options.unique));
  assert.notEqual(matterImportKey('fixture', date), matterImportKey('fixture', '2099-01-03'));
  assert.throws(() => matterImportKey(null, date));
  await assert.rejects(importMatterDeliveriesForDate('2099-02-30'), { statusCode: 400 });
});
