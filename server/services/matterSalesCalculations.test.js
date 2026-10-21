import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSalesProfile, captureSalesAllocation, salesPricingForDelivery, buildMatterSalesReport } from './matterSalesCalculations.js';

const source = (overrides = {}) => ({ subscription_id: 'sub-one', customer_id: 'customer', name: 'Matter Name', subscription_status: 'active',
  cycle_start_date: '2026-10-01', cycle_end_date: '2026-11-30', total_deliveries: 20, gross_paid: 1000, currency: 'AED', plan: { name: 'Plan One' },
  payments: [{ id: 'payment', amount: 1000, currency: 'AED', date: '2026-10-20', status: 'active' }], ...overrides });
const observedAt = new Date('2026-10-20T10:00:00Z');
const profile = normalizeSalesProfile(source());
const captured = captureSalesAllocation(profile, observedAt);
const delivery = (overrides = {}) => ({ _id: 'delivery', type: 'Delivery', company: 'Matter', customerId: 'CUST-1', matterCustomerId: 'customer', customerName: 'Matter Name',
  scheduledTime: new Date('2026-10-21T02:00:00Z'), deliveredTime: new Date('2026-10-21T01:00:00Z'), status: 'delivered', matterRevenue: captured, ...overrides });
const snapshot = (profiles = [profile], date = observedAt) => ({ observedAt: date, lastVerifiedAt: date, profiles });
const report = (options = {}) => buildMatterSalesReport({ snapshots: [snapshot()], deliveries: [delivery()], from: '2026-10-01', to: '2026-10-21', today: '2026-10-21', ...options });

test('AED 1000 for twenty paid deliveries allocates AED 50 regardless of calendar length', () => {
  assert.equal(captured.unitAmount, 50);
  assert.equal(captured.paidDeliveries, 20);
  assert.equal(captured.state, 'captured');
  assert.equal(salesPricingForDelivery(delivery(), snapshot()).amount, 50);
});

test('missing money/entitlement/currency and payment changes are unavailable, while verified free plans are zero', () => {
  for (const changes of [{ gross_paid: null }, { total_deliveries: null }, { total_deliveries: 0 }, { currency: 'USD' }, { payments: null },
    { payments: [{ id: 'p', amount: 900, currency: 'AED', status: 'active' }] },
    { payments: [...source().payments, { id: 'second', amount: 200, currency: 'AED', status: 'active' }] }]) {
    const result = captureSalesAllocation(normalizeSalesProfile(source(changes)), observedAt);
    assert.equal(result.state, 'review'); assert.equal(result.unitAmount, null);
  }
  assert.equal(captureSalesAllocation(normalizeSalesProfile(source({ gross_paid: 0, payments: [] })), observedAt).unitAmount, 0);
});

test('subscription changes never reprice an old completed delivery and need review if observed before completion', () => {
  const changed = normalizeSalesProfile(source({ gross_paid: 2000, payments: [{ ...source().payments[0], amount: 2000 }] }));
  assert.equal(salesPricingForDelivery(delivery(), snapshot([changed], new Date('2026-10-22T00:00:00Z'))).amount, 50);
  const unsafe = salesPricingForDelivery(delivery(), snapshot([changed], new Date('2026-10-20T23:00:00Z')));
  assert.equal(unsafe.amount, null);
  assert.equal(unsafe.reason, 'subscription-change-needs-effective-date');
  const laterUnrelatedCapture = snapshot([changed], new Date('2026-10-23T00:00:00Z'));
  assert.equal(salesPricingForDelivery(delivery(), [snapshot(), snapshot([changed], new Date('2026-10-20T23:00:00Z')), laterUnrelatedCapture]).amount, null);
  assert.equal(delivery().matterRevenue.unitAmount, 50);
});

test('a renewal can change subscription reference while old captured prices and customer identity remain intact', () => {
  const renewal = normalizeSalesProfile(source({ subscription_id: 'renewal', gross_paid: 1500 }));
  const old = delivery({ matterSubscriptionId: 'renewal' });
  assert.equal(salesPricingForDelivery(old, snapshot([renewal], new Date('2026-10-22T00:00:00Z'))).amount, 50);
  assert.equal(old.matterRevenue.matterSubscriptionId, 'sub-one');
  assert.equal(salesPricingForDelivery(delivery({ matterCustomerId: 'different' }), snapshot()).amount, null);
});

test('old deliveries cannot be backfilled from a capture made after service or completion', () => {
  assert.equal(salesPricingForDelivery(delivery({ matterRevenue: undefined }), snapshot()).amount, null);
  assert.equal(salesPricingForDelivery(delivery({ matterRevenue: { ...captured, capturedAt: '2026-10-22T00:00:00Z' } }), snapshot()).amount, null);
  assert.equal(salesPricingForDelivery(delivery({ matterRevenue: { ...captured, capturedAt: 'invalid' } }), snapshot()).amount, null);
});

test('payment-date cash and completed-delivery revenue are separate; missing prices are counted, pending deliveries earn nothing', () => {
  const data = report({ deliveries: [delivery(), delivery({ _id: 'unknown', matterRevenue: undefined }), delivery({ _id: 'pending', status: 'pending' }),
    delivery({ _id: 'cancelled', status: 'cancelled' }), delivery({ _id: 'other', company: 'Partner' })] });
  assert.equal(data.days.find((day) => day.day === '2026-10-20').paymentsReceived, 1000);
  assert.equal(data.days.find((day) => day.day === '2026-10-21').paymentsReceived, 0);
  assert.equal(data.totals.knownDeliveryRevenue, 50);
  assert.equal(data.totals.orders, 3);
  assert.equal(data.totals.completed, 2);
  assert.equal(data.totals.unpriced, 1);
  assert.equal(data.details.find((row) => row.id === 'unknown').revenue, null);
});

test('payments are deduplicated across snapshots/renewals and retained after an account disappears', () => {
  const data = report({ snapshots: [snapshot(), snapshot([profile, { ...profile, subscriptionId: 'renewal' }], new Date('2026-10-20T12:00:00Z')),
    snapshot([], new Date('2026-10-21T12:00:00Z'))] });
  assert.equal(data.totals.paymentsReceived, 1000);
  assert.equal(data.activeSubscriptions, 0);
});

test('conflicting, non-AED or inactive payment records are explicit review counts', () => {
  const duplicate = { ...profile, subscriptionId: 'another', payments: [{ ...profile.payments[0], amount: 1500 }] };
  const data = report({ snapshots: [snapshot([profile, duplicate])] });
  assert.equal(data.totals.paymentsReceived, 0);
  assert.equal(data.totals.unknownPayments, 1);
  const inactive = report({ snapshots: [snapshot([{ ...profile, payments: [{ ...profile.payments[0], status: 'refunded' }] }])] });
  assert.equal(inactive.totals.unknownPayments, 1);
});

test('future starts are excluded, duplicate subscriptions deduplicate, and renewal rate is never fabricated', () => {
  const started = { ...profile, start: '2026-10-20' };
  const data = report({ snapshots: [snapshot([started, started, { ...profile, subscriptionId: 'future', customerId: 'future', start: '2026-10-26' }])] });
  assert.equal(data.subscriptionStartsLast7Days, 1);
  assert.equal(data.activeSubscriptions, 2);
  assert.equal(data.renewalRate, null);
});

test('business dates use Dubai even when a delivery instant is the previous UTC date', () => {
  const data = report({ deliveries: [delivery({ scheduledTime: '2026-10-20T23:30:00Z' })] });
  assert.equal(data.details[0].date, '2026-10-21');
});
