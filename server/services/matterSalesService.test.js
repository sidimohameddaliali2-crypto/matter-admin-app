import test from 'node:test';
import assert from 'node:assert/strict';
import matter from './matterApiService.js';
import Snapshot from '../models/MatterSalesSnapshot.js';
import Delivery from '../models/Delivery.js';
import Customer from '../models/Customer.js';
import { refreshMatterSales, readSalesSubscriptionList, capturePendingMatterRevenue, getMatterSalesReport } from './matterSalesService.js';
import { normalizeSalesProfile } from './matterSalesCalculations.js';
import router from '../routes/matterApi.js';

const sub = { subscription_id: 'sub', customer_id: 'customer', subscription_status: 'paused', name: 'Source', plan: { name: 'Plan' }, currency: 'AED',
  cycle_start_date: '2020-01-01', cycle_end_date: '2099-12-31', total_deliveries: 20, gross_paid: 1000,
  payments: [{ id: 'payment', amount: 1000, currency: 'AED', date: '2026-10-20', status: 'active' }] };
const query = (value) => ({ sort() { return this; }, select() { return this; }, lean: async () => value });

test('incomplete/malformed pagination fails instead of publishing an empty/partial financial result', async (t) => {
  t.mock.method(matter, 'listSubscriptions', async () => ({ success: false, data: [] }));
  await assert.rejects(readSalesSubscriptionList(), /incomplete/);
  matter.listSubscriptions = async ({ page }) => ({ data: page === 1 ? [sub] : [], meta: { total_pages: page === 1 ? 2 : 3 } });
  await assert.rejects(readSalesSubscriptionList(), /pagination/);
});

test('a failed full-detail lookup writes no snapshot and cannot zero previously captured data', async (t) => {
  t.mock.method(matter, 'listSubscriptions', async () => ({ data: [sub], meta: { total_pages: 1 } }));
  t.mock.method(matter, 'getSubscription', async () => { throw new Error('Source unavailable'); });
  t.mock.method(Snapshot, 'create', () => assert.fail('Partial observations must not be saved'));
  t.mock.method(Delivery, 'bulkWrite', () => assert.fail('No allocation after incomplete source'));
  await assert.rejects(refreshMatterSales(), /Source unavailable/);
});

test('identity conflicts from the source fail before persistence', async (t) => {
  t.mock.method(matter, 'listSubscriptions', async () => ({ data: [sub], meta: { total_pages: 1 } }));
  t.mock.method(matter, 'getSubscription', async () => ({ data: { ...sub, customer_id: 'other' } }));
  await assert.rejects(refreshMatterSales(), /identity/);
});

test('captures exclude completed/past records, use only permanent identity and leave changed subscription pricing for review', async (t) => {
  const source = normalizeSalesProfile(sub);
  const future = new Date(Date.now() + 86400000);
  const selections = [];
  t.mock.method(Delivery, 'find', (filter) => { selections.push(filter); return query([{ _id: 'delivery', customerId: 'CUST-1', status: 'pending', scheduledTime: future }]); });
  t.mock.method(Customer, 'find', () => query([{ customerId: 'CUST-1', matterCustomerId: 'customer' }]));
  t.mock.method(Snapshot, 'find', () => query([{ profiles: [{ subscriptionId: 'sub', pricingHash: 'previous-price' }] }]));
  let written;
  t.mock.method(Delivery, 'bulkWrite', async (ops) => { written = ops; return { modifiedCount: 1 }; });
  await capturePendingMatterRevenue([source]);
  assert.ok(selections[0].scheduledTime.$gte instanceof Date);
  assert.equal(selections[0].status.$in.includes('delivered'), false);
  assert.deepEqual(written[0].updateOne.filter.matterRevenue, { $exists: false });
  assert.equal(written[0].updateOne.update.$set.matterRevenue.state, 'review');
  assert.equal(written[0].updateOne.update.$set.matterRevenue.unitAmount, null);
});

test('invalid report ranges fail before database access', async () => {
  await assert.rejects(getMatterSalesReport('2026-02-30', '2026-03-01'), /valid range/);
  await assert.rejects(getMatterSalesReport('2020-01-01', '2026-10-21'), /400 days/);
});

test('dashboard permissions deny drivers and unrelated roles', () => {
  for (const path of ['/sales-dashboard', '/sales-dashboard/refresh']) {
    const route = router.stack.find((layer) => layer.route?.path === path).route;
    const gate = route.stack[1].handle;
    let status;
    gate({ user: { role: 'driver' } }, { status(code) { status = code; return this; }, json() {} }, () => assert.fail('Driver access'));
    assert.equal(status, 403);
    let allowed = false;
    gate({ user: { role: 'super_admin' } }, {}, () => { allowed = true; });
    assert.equal(allowed, true);
  }
});

test('complete paused and active profiles are captured together, and concurrent refreshes share one source request', async (t) => {
  let reads = 0;
  t.mock.method(matter, 'listSubscriptions', async () => { reads++; return { data: [sub], meta: { total_pages: 1 } }; });
  t.mock.method(matter, 'getSubscription', async () => ({ data: sub }));
  t.mock.method(Snapshot, 'findOne', () => query(null));
  let saved;
  t.mock.method(Snapshot, 'create', async (data) => { saved = data; });
  t.mock.method(Delivery, 'find', () => query([]));
  t.mock.method(Customer, 'find', () => query([]));
  t.mock.method(Snapshot, 'find', () => query([]));
  const [first, second] = await Promise.all([refreshMatterSales(), refreshMatterSales()]);
  assert.equal(reads, 1);
  assert.equal(first.profiles, second.profiles);
  assert.equal(saved.profiles[0].status, 'paused');
  assert.equal(saved.profiles[0].payments[0].amount, 1000);
});
