import test from 'node:test';
import assert from 'node:assert/strict';
import { planHistoricalMatterPricing } from './matterSalesHistory.js';
import { normalizeSalesProfile, salesPricingForDelivery, buildMatterSalesReport } from './matterSalesCalculations.js';

const source = { subscription_id: 'historical', customer_id: 'customer', name: 'Name', subscription_status: 'active',
  plan: { name: 'Plan' }, gross_paid: 1000, currency: 'AED', total_deliveries: 20, cycle_start_date: '2026-08-01', cycle_end_date: '2026-10-31',
  payments: [{ id: 'payment', amount: 1000, currency: 'AED', date: '2026-07-30', status: 'active' }],
  delivery_schedule: [{ date: '2026-08-03', status: 'active' }] };
const delivery = { _id: 'delivery', type: 'Delivery', company: 'Matter', status: 'delivered', customerId: 'CUST-1', matterCustomerId: 'customer', matterSubscriptionId: 'historical',
  scheduledTime: new Date('2026-08-03T02:00:00Z'), deliveredTime: new Date('2026-08-03T01:00:00Z') };
const verifiedAt = new Date('2026-10-21T12:00:00Z');
const run = (options = {}) => planHistoricalMatterPricing({ deliveries: [delivery], customers: [{ customerId: 'CUST-1', matterCustomerId: 'customer' }], sources: [source], verifiedAt, ...options });

test('single-payment historical Matter contract can verify an earlier delivery without falsifying capture time', () => {
  const plan = run();
  assert.equal(plan.updates.length, 1);
  const allocation = plan.updates[0].allocation;
  assert.equal(allocation.state, 'verified-history');
  assert.equal(+allocation.capturedAt, +verifiedAt);
  assert.equal(allocation.unitAmount, 50);
  assert.ok(allocation.evidenceHash);
  assert.equal(salesPricingForDelivery({ ...delivery, matterRevenue: allocation }, []).amount, 50);
  const report = buildMatterSalesReport({ snapshots: [], deliveries: [{ ...delivery, matterRevenue: allocation }], from: '2026-08-01', to: '2026-08-31', today: '2026-10-21' });
  assert.equal(report.totals.knownDeliveryRevenue, 50);
});

test('multiple payments, a later payment, missing calendars and conflicting observed prices cannot be guessed', () => {
  const cases = [ { ...source, payments: [...source.payments, { ...source.payments[0], id: 'second' }] },
    { ...source, payments: [{ ...source.payments[0], date: '2026-08-10' }] }, { ...source, delivery_schedule: [] } ];
  for (const sub of cases) assert.equal(run({ sources: [sub] }).updates.length, 0);
  const old = normalizeSalesProfile({ ...source, total_deliveries: 30 });
  assert.equal(run({ snapshots: [{ profiles: [old] }] }).updates.length, 0);
});

test('existing captures, conflicting customer links and an unavailable saved subscription remain untouched', () => {
  assert.equal(run({ deliveries: [{ ...delivery, matterRevenue: { state: 'captured' } }] }).updates.length, 0);
  assert.equal(run({ deliveries: [{ ...delivery, matterCustomerId: 'other' }] }).updates.length, 0);
  assert.equal(run({ sources: [{ ...source, subscription_id: 'renewed' }] }).updates.length, 0);
});

test('unlinked legacy selections require a unique permanent-customer/date/calendar contract', () => {
  assert.equal(run({ deliveries: [{ ...delivery, matterSubscriptionId: null }] }).updates.length, 1);
  assert.equal(run({ deliveries: [{ ...delivery, matterSubscriptionId: null }], sources: [source, { ...source, subscription_id: 'overlapping' }] }).updates.length, 0);
});

test('changing service date invalidates historical evidence rather than moving a verified price to an uncovered day', () => {
  const allocation = run().updates[0].allocation;
  assert.equal(salesPricingForDelivery({ ...delivery, scheduledTime: new Date('2026-08-04T02:00:00Z'), matterRevenue: allocation }, []).amount, null);
});

test('verified history still excludes the twenty-first delivery from a twenty-delivery paid entitlement', () => {
  const days = Array.from({ length: 21 }, (_, index) => `2026-08-${String(index + 1).padStart(2, '0')}`);
  const deliveries = days.map((day, index) => ({ ...delivery, _id: `delivery-${String(index).padStart(2, '0')}`, scheduledTime: new Date(day + 'T02:00:00Z'), deliveredTime: new Date(day + 'T01:00:00Z') }));
  const plan = run({ deliveries, sources: [{ ...source, delivery_schedule: days.map((date) => ({ date, status: 'active' })) }] });
  assert.equal(plan.updates.length, 21);
  const byId = new Map(plan.updates.map((row) => [row.deliveryId, row.allocation]));
  const report = buildMatterSalesReport({ snapshots: [], deliveries: deliveries.map((row) => ({ ...row, matterRevenue: byId.get(row._id) })), from: '2026-08-01', to: '2026-08-31', today: '2026-10-21' });
  assert.equal(report.totals.knownDeliveryRevenue, 1000);
  assert.equal(report.totals.additional, 1);
  assert.equal(report.totals.completed, 20);
});
