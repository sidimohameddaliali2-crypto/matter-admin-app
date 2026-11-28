import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookingDeadlineEvidence, observeWebsiteDeadline, websiteDeadlineSource, withholdOverlappingWebsiteDeadlines } from './matterBookingDeadline.js';
import { removeClientMatterImportIdentity } from '../middleware/matterImportIdentityInput.js';

const date = '2026-11-29';
const captured = '2026-11-28T02:00:00.000Z';
const subscription = {
  customer_id: 'site-person', subscription_id: 'paid-subscription', subscription_status: 'active', currency: 'AED',
  cycle_start_date: '2026-11-01', cycle_end_date: '2026-11-30', total_deliveries: 20, gross_paid: 1000,
  payments: [{ id: 'bank-receipt', amount: 1000, currency: 'AED', date: '2026-10-30', status: 'active' }],
  delivery_schedule: [{ date, status: 'active', food_days: 1, is_double: false }],
  customer_addresses: [{ id: 'saved-address', status: 'active', current_delivery_address: true }],
  delivery_window: { id: 4, label: 'By 6 AM', timezone: 'Asia/Dubai' },
};
const order = { matterCustomerId: 'site-person', matterSubscriptionId: 'paid-subscription', addressId: 'saved-address',
  customerId: 'order-person', scheduledTime: date + 'T02:00:00.000Z' };
const observe = (overrides = {}, clock = captured) => observeWebsiteDeadline(websiteDeadlineSource({ ...subscription, ...overrides }, clock), date);
const read = (events, changes = {}) => bookingDeadlineEvidence({ ...order, ...changes,
  matterBookingObservations: events.map(event => ({ ...event, customerId: 'order-person' })) });

test('paid pre-service native By commitment keeps only the Dubai deadline and first source reference', () => {
  const record = observe();
  const result = read([record]);
  assert.equal(result.basis, 'website-observed-deadline-v1');
  assert.equal(result.state, 'partial');
  assert.equal(result.coverage, 'pre-service-observations-only');
  assert.equal(result.original.start, null);
  assert.equal(result.original.end, '2026-11-29T02:00:00.000Z');
  assert.deepEqual(result.effective, result.original);
  assert.match(record.reference, /^[a-f0-9]{64}$/);
  assert.equal(observe({}, '2026-11-28T19:59:59.999Z').reference, record.reference);
  assert.equal(observe({}, '2026-11-28T20:00:00.000Z'), null);
  assert.equal(observe({}, '2026-12-01T00:00:00.000Z'), null);
});

test('calendar, matched payment, uniquely active address and native deadline are each required', () => {
  const checks = [
    [{ gross_paid: 0, payments: [] }, 'dated-payment-unverified'],
    [{ payments: [subscription.payments[0], subscription.payments[0]] }, 'dated-payment-unverified'],
    [{ payments: [{ ...subscription.payments[0], status: 'refunded' }] }, 'dated-payment-unverified'],
    [{ payments: [{ ...subscription.payments[0], amount: 10 }] }, 'dated-payment-unverified'],
    [{ payments: [{ ...subscription.payments[0], id: '' }] }, 'dated-payment-unverified'],
    [{ delivery_schedule: [{ date, status: 'paused' }] }, 'active-service-date-unverified'],
    [{ delivery_schedule: [...subscription.delivery_schedule, { date, status: 'paused' }] }, 'active-service-date-unverified'],
    [{ cycle_end_date: '2026-11-28' }, 'paid-cycle-date-unverified'],
    [{ upcoming_plan: { starting_date: date } }, 'paid-cycle-date-unverified'],
    [{ customer_addresses: [{ id: 'old', status: 'inactive', current_delivery_address: true }] }, 'active-address-unverified'],
    [{ customer_addresses: [{ id: 'a', status: 'active' }, { id: 'b', status: 'active' }] }, 'active-address-unverified'],
    [{ delivery_window: { ...subscription.delivery_window, label: '3 AM to 6 AM' } }, 'website-deadline-unverified'],
    [{ delivery_window: { ...subscription.delivery_window, timezone: 'UTC' } }, 'website-deadline-unverified'],
  ];
  for (const [overrides, reason] of checks) {
    const record = observe(overrides);
    assert.equal(record.reason, reason);
    assert.equal(record.end, null);
    assert.equal(read([record]).state, 'unverified');
  }
});

test('a later website observation preserves the dated first observation through retiming, lost coverage and rebinding', () => {
  const first = observe();
  const clock = '2026-11-28T10:00:00.000Z';
  const next = observe({ delivery_window: { id: 5, label: 'By 7 AM', timezone: 'Asia/Dubai' } }, clock);
  const result = read([first, next]);
  assert.equal(result.original.reference, first.reference);
  assert.equal(result.effective.end, '2026-11-29T03:00:00.000Z');
  assert.notEqual(result.effective.reference, result.original.reference);
  assert.deepEqual(result.firstDifferentObservation, result.effective);
  const unavailable = read([first, observe({ payments: [] }, clock)]);
  assert.equal(unavailable.original.reference, first.reference);
  assert.equal(unavailable.effective, null);
  assert.equal(unavailable.reason, 'dated-payment-unverified');
  assert.equal(read([first], { addressId: 'different' }).effective, null);
  assert.equal(read([first], { matterCustomerId: 'different' }).state, 'unverified');
  assert.equal(read([first, { ...next, observedAt: first.observedAt }]).effective, null);
  assert.equal(read([first], { scheduledTime: '2026-11-30T02:00:00Z' }).state, 'unverified');
});

test('a restored deadline or address retains the differing pre-service observation', () => {
  const first = observe();
  const later = '2026-11-28T12:00:00.000Z';
  const restored = observe({}, later);
  for (const changed of [
    observe({delivery_window:{id:5, label:'By 7 AM', timezone:'Asia/Dubai'}}, '2026-11-28T10:00:00.000Z'),
    observe({customer_addresses:[{id:'different-address', status:'active', current_delivery_address:true}]}, '2026-11-28T10:00:00.000Z'),
  ]) {
    const result = read([first, changed, restored]);
    assert.equal(result.effective.reference, result.original.reference);
    assert.equal(result.firstDifferentObservation.reference, changed.reference);
    assert.equal(result.firstDifferentObservation.observedAt, changed.observedAt);
  }
  assert.equal(read([first, restored]).firstDifferentObservation, undefined);
});

test('the effective clock follows a conflicting same-clock read only when a later poll confirms it', () => {
  const original = observe();
  const revised = observe({ delivery_window: { id: 5, label: 'By 7 AM', timezone: 'Asia/Dubai' } });
  const tie = [original, revised].sort((a, b) => a.reference.localeCompare(b.reference));
  const confirmed = { ...tie[1], observedAt: '2026-11-28T12:00:00.000Z' };
  assert.equal(read(tie).effective, null);
  assert.equal(read([...tie, confirmed]).effective.observedAt, confirmed.observedAt);
});

test('normal delivery inputs cannot supply, update or rename a website observation', () => {
  const body = { customerId: 'fixture', matterBookingObservations: [observe()], $set: { 'matterBookingObservations.0.end': date },
    $rename: { title: 'matterBookingObservations', matterBookingObservations: 'title' } };
  removeClientMatterImportIdentity(body);
  assert.deepEqual(body, { customerId: 'fixture', $set: {}, $rename: {} });
});

test('overlapping active subscriptions are held even before the hourly reconciliation', () => {
  const record = observe();
  const rows = [{ delivery_date: date, customer_id: 'c', bookingObservation: record },
    { delivery_date: date, customer_id: 'c', bookingObservation: { ...record, subscriptionId: 'second' } },
    { delivery_date: date, customer_id: 'other', bookingObservation: record }];
  withholdOverlappingWebsiteDeadlines(rows);
  assert.equal(rows[0].bookingObservation.reason, 'ambiguous-customer-subscriptions');
  assert.equal(rows[1].bookingObservation.end, null);
  assert.deepEqual(rows[2].bookingObservation, record);
});
