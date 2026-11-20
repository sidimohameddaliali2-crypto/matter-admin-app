import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMatterImportJobs, publicImportJob } from './matterImportJobService.js';
import MatterImportJob from '../models/MatterImportJob.js';
import matterApi from './matterApiService.js';
import Delivery from '../models/Delivery.js';
import Customer from '../models/Customer.js';
import { importMatterDeliveriesForDate } from './matterDeliveryImportService.js';

function store() {
  const rows = [];
  let lock = null;
  const clone = value => value == null ? value : structuredClone(value);
  const query = value => ({ lean: async () => clone(value), sort: () => ({ lean: async () => clone(value) }) });
  const match = (row, filter) => Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === 'object' && '$lte' in value) return +new Date(row[key]) <= +value.$lte;
    if (value && typeof value === 'object' && '$gt' in value) return +new Date(row[key]) > +value.$gt;
    return row[key] === value;
  });
  const apply = (row, update) => {
    Object.assign(row, clone(update.$set || {}));
    for (const key of Object.keys(update.$unset || {})) delete row[key];
  };
  const Job = {
    init: async () => {},
    create: async data => {
      if (rows.some(r => r.activeKey === data.activeKey)) throw Object.assign(new Error('duplicate'), { code: 11000 });
      const row = { ...clone(data), _id: `job${rows.length + 1}`, createdAt: new Date() };
      rows.push(row);
      return { toObject: () => clone(row) };
    },
    findOne: filter => query([...rows].reverse().find(row => match(row, filter))),
    findById: id => query(rows.find(row => row._id === id)),
    findOneAndUpdate: (filter, update) => {
      const row = rows.find(row => match(row, filter));
      if (row) apply(row, update);
      return query(row);
    },
    updateOne: async (filter, update) => {
      const row = rows.find(row => match(row, filter));
      if (row) apply(row, update);
      return { matchedCount: row ? 1 : 0 };
    },
    updateMany: async (filter, update) => { for (const row of rows.filter(row => match(row, filter))) apply(row, update); }
  };
  const Lease = {
    findOneAndUpdate: async (filter, update) => {
      if (lock && !match(lock, filter)) throw Object.assign(new Error('busy'), { code: 11000 });
      lock = { _id: filter._id, ...clone(update.$set) };
      return clone(lock);
    },
    updateOne: async (filter, update) => {
      const found = lock && match(lock, filter);
      if (found) apply(lock, update);
      return { matchedCount: found ? 1 : 0 };
    },
    deleteOne: async filter => { if (lock && match(lock, filter)) lock = null; }
  };
  return { Job, Lease, rows, steal: () => { lock.owner = 'other-worker'; } };
}
const summary = extra => ({ date: '2026-11-22', complete: true, total: 11, created: 11, ...extra });

test('enqueue is immediate and simultaneous clicks share one job without upstream or delivery writes', async () => {
  const db = store();
  let calls = 0;
  const service = createMatterImportJobs({ ...db, runImport: async () => { calls++; } });
  const [a, b] = await Promise.all([service.enqueue('2026-11-22'), service.enqueue('2026-11-22')]);
  assert.equal(a.id, b.id);
  assert.equal(a.status, 'queued');
  assert.equal(db.rows.length, 1);
  assert.equal(calls, 0);
});

test('background job reports checking and write progress and remains readable by another worker after completion', async () => {
  const db = store();
  const service = createMatterImportJobs({ ...db, runImport: async (date, { onProgress }) => {
    assert.equal(date, '2026-11-22');
    await onProgress({ phase: 'checking', completed: 10, total: 354 });
    const reloaded = await createMatterImportJobs(db).latest(date);
    assert.equal(reloaded.status, 'running');
    assert.equal(reloaded.progress.completed, 10);
    await onProgress({ phase: 'importing', completed: 1, total: 11, created: 1 });
    return summary();
  } });
  const job = await service.enqueue('2026-11-22');
  await service.tick();
  const saved = await createMatterImportJobs(db).get(job.id);
  assert.equal(saved.status, 'completed');
  assert.equal(saved.result.created, 11);
  assert.equal(saved.owner, undefined);
  assert.equal(db.rows[0].activeKey, undefined);
});

test('PM2 workers serialize imports and a second date stays queued while the first runs', async () => {
  const db = store();
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const runImport = async () => { calls++; started(); await blocked; return summary(); };
  const a = createMatterImportJobs({ ...db, runImport });
  const b = createMatterImportJobs({ ...db, runImport });
  await a.enqueue('2026-11-22');
  await b.enqueue('2026-11-23');
  const running = a.tick();
  await ready;
  await b.tick();
  assert.equal(calls, 1);
  assert.equal(db.rows[1].status, 'queued');
  release();
  await running;
  await b.tick();
  assert.equal(calls, 2);
});

test('incomplete reads and partial writes are not labelled successful, and retry creates a new attempt', async () => {
  const db = store();
  const service = createMatterImportJobs({ ...db, runImport: async () => summary({ complete: false, created: 3, failed: 1, errors: [{ subscriptionId: 'synthetic', message: 'Unable to verify delivery schedule' }] }) });
  const first = await service.enqueue('2026-11-22');
  await service.tick();
  const result = await service.get(first.id);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.result.created, 3);
  const retry = await service.enqueue('2026-11-22');
  assert.notEqual(retry.id, first.id);
  assert.equal((await service.get(first.id)).result.failed, 1);
});

test('queued work survives restart, but expired running work needs an explicit retry', async () => {
  const db = store();
  const old = createMatterImportJobs(db);
  await old.enqueue('2026-11-22');
  Object.assign(db.rows[0], { status: 'running', owner: 'dead-process', leaseUntil: new Date('2026-11-20T00:00:00Z'), progress: { phase: 'importing', completed: 3, total: 11, created: 3 } });
  let writes = 0;
  const restarted = createMatterImportJobs({ ...db, runImport: async () => { writes++; return summary(); } });
  await restarted.tick();
  assert.equal(db.rows[0].status, 'failed');
  assert.equal(db.rows[0].progress.created, 3);
  assert.equal(writes, 0);
  await restarted.enqueue('2026-11-22');
  await restarted.tick();
  assert.equal(writes, 1);
});

test('lost lease fences further progress and writes and cannot overwrite the replacement owner', async () => {
  const db = store();
  let writes = 0;
  const service = createMatterImportJobs({ ...db, runImport: async (date, { assertActive }) => {
    db.steal();
    await assertActive();
    writes++;
    return summary();
  } });
  await service.enqueue('2026-11-22');
  await service.tick();
  assert.equal(writes, 0);
  assert.equal(db.rows[0].status, 'running');
});

test('transport failure retains progress and marks the job failed without exposing tokens', async () => {
  const db = store();
  const service = createMatterImportJobs({ ...db, runImport: async () => { throw new Error('secret upstream details'); } });
  const job = await service.enqueue('2026-11-22');
  await service.tick();
  const saved = await service.get(job.id);
  assert.equal(saved.status, 'failed');
  assert.equal(JSON.stringify(saved).includes('secret'), false);
});

test('job schema keeps durable date, progress and result and public response omits worker secrets', async () => {
  const job = new MatterImportJob({ date: '2026-11-22', status: 'completed', progress: { phase: 'finished' }, result: summary(), owner: 'private-owner' });
  await job.validate();
  const serialized = publicImportJob(job.toObject());
  assert.equal(serialized.date, '2026-11-22');
  assert.equal(serialized.result.created, 11);
  assert.equal(serialized.owner, undefined);
});

test('incomplete calendar discovery performs no delivery writes and reports an incomplete result', async t => {
  t.mock.method(matterApi, 'findSubscriptionsWithDeliveryOnDate', async () => {
    throw Object.assign(new Error('incomplete'), { code: 'INCOMPLETE_DELIVERY_ROSTER', discovery: { candidates: 354, failed: 1, errors: [] } });
  });
  let writes = 0;
  t.mock.method(Delivery, 'create', async () => { writes++; });
  const result = await importMatterDeliveriesForDate('2026-11-22');
  assert.equal(result.complete, false);
  assert.equal(result.discoveryFailed, 1);
  assert.equal(writes, 0);
});

test('retry uses the existing delivery deduplication and reports saved jobs instead of creating them again', async t => {
  const sub = { subscription_id: 'synthetic-subscription', name: 'Synthetic Customer', delivery_date: '2026-11-22',
    customer_addresses: [{ id: 1, current_delivery_address: true, status: 'active', category: 'villa', building: 'Synthetic Villa', unit: '1', area: 'Test Zone', coordinates: { lat: 25.1, lng: 55.2 } }],
    delivery_window: { label: 'By 5 AM' } };
  t.mock.method(matterApi, 'findSubscriptionsWithDeliveryOnDate', async () => [sub]);
  t.mock.method(Delivery, 'findOne', () => ({ select: async () => ({ _id: 'saved-delivery', status: 'completed', customerName: sub.name }) }));
  let writes = 0;
  t.mock.method(Delivery, 'create', async () => { writes++; });
  const progress = [];
  const result = await importMatterDeliveriesForDate('2026-11-22', { onProgress: async p => progress.push(p) });
  assert.equal(result.created, 0);
  assert.equal(result.alreadyExisted, 1);
  assert.equal(writes, 0);
  assert.equal(progress.at(-1).completed, 1);
});

test('real discovery reports page and calendar progress without relaxing complete-roster checks', async t => {
  t.mock.method(matterApi, 'listSubscriptions', async ({ page }) => ({
    data: [{ subscription_id: `synthetic-${page}`, subscription_status: 'active', cycle_end_date: '2026-11-30' }], meta: { total_pages: 2 }
  }));
  t.mock.method(matterApi, 'getSubscription', async id => ({ data: {
    subscription_id: id, customer_addresses: [], delivery_schedule: [{ date: '2026-11-22', status: 'active' }]
  } }));
  const progress = [];
  const matches = await matterApi.findSubscriptionsWithDeliveryOnDate('2026-11-22', { onProgress: async p => progress.push({ ...p }) });
  assert.equal(matches.length, 2);
  assert.deepEqual(progress.filter(p => p.phase === 'listing').map(p => p.completed), [1, 2]);
  assert.equal(progress.at(-1).completed, 2);
  assert.equal(progress.at(-1).total, 2);
  t.mock.method(matterApi, 'getSubscription', async () => { throw Object.assign(new Error('synthetic timeout'), { code: 'ETIMEDOUT' }); });
  await assert.rejects(() => matterApi.findSubscriptionsWithDeliveryOnDate('2026-11-22', { onProgress: async () => {} }), { code: 'INCOMPLETE_DELIVERY_ROSTER' });
});

test('index creation failure blocks the importer before new customer or delivery writes', async t => {
  const sub = { subscription_id: 'synthetic', name: 'Synthetic Customer', delivery_date: '2026-11-22',
    customer_addresses: [{ id: 1, current_delivery_address: true, status: 'active', building: 'Synthetic Villa', unit: '1' }],
    delivery_window: { label: 'By 5 AM' } };
  t.mock.method(matterApi, 'findSubscriptionsWithDeliveryOnDate', async () => [sub]);
  t.mock.method(Delivery, 'findOne', () => ({ select: async () => null }));
  t.mock.method(Delivery.collection, 'createIndex', async () => { throw new Error('Index unavailable'); });
  let touched = 0;
  t.mock.method(Customer, 'findOne', () => { touched++; throw new Error('Must not reach customer resolution'); });
  t.mock.method(Delivery, 'create', async () => { touched++; });
  const result = await importMatterDeliveriesForDate('2026-11-22');
  assert.equal(result.complete, false);
  assert.equal(result.failed, 1);
  assert.equal(result.created, 0);
  assert.equal(touched, 0);
});

test('an insert lost to a recovery worker counts as already imported, not another stop or a write failure', async t => {
  const sub = { subscription_id: 'synthetic', customer_id: 'synthetic-customer', name: 'Synthetic Customer', delivery_date: '2026-11-22',
    customer_addresses: [{ id: 1, current_delivery_address: true, status: 'active', building: 'Synthetic Villa', unit: '1' }],
    delivery_window: { label: 'By 5 AM' } };
  t.mock.method(matterApi, 'findSubscriptionsWithDeliveryOnDate', async () => [sub]);
  t.mock.method(Delivery, 'findOne', () => ({ select: async () => null }));
  t.mock.method(Delivery.collection, 'createIndex', async () => 'matter_import_obligation_unique');
  t.mock.method(Customer, 'findOne', () => ({ select: async () => ({ customerId: 'SYNTHETIC', firstName: 'Synthetic', lastName: 'Customer' }) }));
  t.mock.method(Delivery, 'create', async snapshot => {
    assert.equal(snapshot.matterImportKey, '2026-11-22:synthetic');
    throw Object.assign(new Error('duplicate'), { code: 11000, keyPattern: { matterImportKey: 1 } });
  });
  const result = await importMatterDeliveriesForDate('2026-11-22');
  assert.equal(result.complete, true);
  assert.equal(result.created, 0);
  assert.equal(result.alreadyExisted, 1);
  assert.equal(result.writeFailed, 0);
});
