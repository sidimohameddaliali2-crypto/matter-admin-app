import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSalesProfile, captureSalesAllocation, buildMatterSalesReport, classifySalesEntitlements } from './matterSalesCalculations.js';
import { getMatterSalesReport } from './matterSalesService.js';
import Snapshot from '../models/MatterSalesSnapshot.js';
import Delivery from '../models/Delivery.js';

const source = normalizeSalesProfile({ subscription_id: 'sub', customer_id: 'customer', subscription_status: 'active', plan: { name: 'Plan' },
  currency: 'AED', cycle_start_date: '2026-09-01', cycle_end_date: '2026-11-30', gross_paid: 1000, total_deliveries: 20,
  payments: [{ id: 'payment', amount: 1000, currency: 'AED', date: '2026-09-01', status: 'active' }] });
const observedAt = new Date('2026-09-01T00:00:00Z');
const allocation = captureSalesAllocation(source, observedAt);
const snapshots = [{ observedAt, profiles: [source] }];
const row = (number, changes = {}) => ({ _id: String(number).padStart(3, '0'), type: 'Delivery', company: 'Matter', customerId: 'CUST-1', matterCustomerId: 'customer', matterSubscriptionId: 'sub',
  customerName: 'Customer', scheduledTime: `2026-10-${String(number).padStart(2, '0')}T02:00:00Z`, deliveredTime: `2026-10-${String(number).padStart(2, '0')}T01:00:00Z`, status: 'delivered', matterRevenue: allocation, ...changes });
const report = (deliveries, options = {}) => buildMatterSalesReport({ snapshots, deliveries, from: '2026-10-01', to: '2026-10-31', today: '2026-10-21', ...options });

test('twenty paid deliveries earn AED 1000; delivery twenty-one is separately flagged and excluded from all paid counts', () => {
  const data = report(Array.from({ length: 21 }, (_, i) => row(i + 1)));
  assert.equal(data.totals.knownDeliveryRevenue, 1000);
  assert.equal(data.totals.completed, 20);
  assert.equal(data.totals.orders, 20);
  assert.equal(data.totals.additional, 1);
  assert.equal(data.totals.unpriced, 0);
  const additional = data.details.find((entry) => entry.id === '021');
  assert.equal(additional.additional, true);
  assert.equal(additional.includedInPaidCounts, false);
  assert.equal(additional.revenue, 0);
  assert.equal(additional.entitlementDeliveryNumber, 21);
  assert.equal(additional.pricingStatus, 'additional-delivery-excluded');
});

test('paid entitlement is not reset by month filters or a changed pricing hash', () => {
  const earlier = Array.from({ length: 20 }, (_, i) => row(i + 1, { scheduledTime: `2026-09-${String(i + 2).padStart(2, '0')}T02:00:00Z` }));
  const latest = row(21, { matterRevenue: { ...allocation, sourceHash: 'different-price-hash' } });
  const data = report([latest], { entitlementHistory: earlier });
  assert.equal(data.totals.additional, 1);
  assert.equal(data.totals.orders, 0);
  assert.equal(data.totals.knownDeliveryRevenue, 0);
});

test('legacy completed deliveries consume entitlement even if their historical price/customer-ID capture is missing', () => {
  const earlier = Array.from({ length: 20 }, (_, i) => row(i + 1, { matterRevenue: undefined, matterCustomerId: undefined }));
  const data = report([row(21)], { entitlementHistory: earlier });
  assert.equal(data.totals.additional, 1);
  assert.equal(data.totals.knownDeliveryRevenue, 0);
});

test('failed, cancelled and pending deliveries do not consume a paid completion and repeated records count once', () => {
  const rows = Array.from({ length: 20 }, (_, i) => row(i + 1));
  const result = classifySalesEntitlements([...rows, rows[0], row(21, { status: 'failed' }), row(22, { status: 'cancelled' }), row(23, { status: 'pending' })], snapshots);
  assert.equal(result.size, 20);
  assert.equal([...result.values()].filter((entry) => entry.additional).length, 0);
});

test('a new subscription has its own allowance while the original subscription keeps its extra delivery', () => {
  const original = Array.from({ length: 21 }, (_, i) => row(i + 1));
  const renewal = row(22, { matterRevenue: { ...allocation, matterSubscriptionId: 'renewed' } });
  const data = report([...original, renewal]);
  assert.equal(data.totals.additional, 1);
  assert.equal(data.details.find((entry) => entry.id === '022').entitlementDeliveryNumber, 1);
  assert.equal(data.totals.completed, 21);
});

test('missing or conflicting entitlement history requires review rather than silently granting a new allowance', () => {
  const missing = row(1, { matterRevenue: { ...allocation, cycleStart: undefined, cycleEnd: undefined, sourceHash: 'unknown-history' } });
  assert.equal(report([missing], { snapshots: [] }).totals.unpriced, 1);
  const data = report([row(1), row(2, { matterRevenue: { ...allocation, paidDeliveries: 30 } })]);
  assert.equal(data.totals.knownDeliveryRevenue, 0);
  assert.equal(data.totals.unpriced, 2);
});

test('the report loads completed history outside its selected date range', async (t) => {
  const chain = (data) => ({ sort() { return this; }, select() { return this; }, lean: async () => data });
  t.mock.method(Snapshot, 'find', () => chain(snapshots));
  const queries = [];
  t.mock.method(Delivery, 'find', (query) => {
    queries.push(query);
    return chain(queries.length === 1 ? [row(21)] : Array.from({ length: 20 }, (_, i) => row(i + 1, { scheduledTime: `2026-09-${String(i + 2).padStart(2, '0')}T02:00:00Z` })));
  });
  const result = await getMatterSalesReport('2026-10-01', '2026-10-31');
  assert.equal(queries.length, 2);
  assert.equal(queries[1].scheduledTime.$gte, undefined);
  assert.deepEqual(queries[1].status, { $in: ['delivered', 'completed'] });
  assert.equal(result.totals.additional, 1);
});
