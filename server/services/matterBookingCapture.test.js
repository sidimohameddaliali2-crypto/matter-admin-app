import test from 'node:test';
import assert from 'node:assert/strict';
import Delivery from '../models/Delivery.js';
import Customer from '../models/Customer.js';
import { appendWebsiteDeadline, captureTomorrowWebsiteDeadlines } from './matterBookingCapture.js';
import { bookingDeadlineEvidence, observeWebsiteDeadline, websiteDeadlineSource } from './matterBookingDeadline.js';
import matter from './matterApiService.js';
import Snapshot from '../models/MatterSalesSnapshot.js';
import { refreshMatterSales } from './matterSalesService.js';

const date = '2026-12-01';
const clock = '2026-11-30T12:00:00.000Z';
const subscription = {
  subscription_id: 'subscription', customer_id: 'website-person', subscription_status: 'active',
  customer_addresses: [{ id: 'address', status: 'active' }], delivery_schedule: [{ date, status: 'active' }],
  delivery_window: { label: 'By 6 AM', id: 4, timezone: 'Asia/Dubai' }, currency: 'AED',
  total_deliveries: 20, cycle_start_date: '2026-11-15', cycle_end_date: '2026-12-15', gross_paid: 200,
  payments: [{ id: 'receipt', amount: 200, date: '2026-11-14', currency: 'AED', status: 'active' }],
};
const order = {
  _id: 'order', customerId: 'internal-person', matterCustomerId: 'website-person', matterSubscriptionId: 'subscription',
  addressId: 'address', company: 'Matter', scheduledTime: new Date('2026-12-01T02:00:00.000Z'), status: 'pending',
};
const query = value => ({ select() { return this; }, sort() { return this; }, lean: async () => value });

function captureStore(t) {
  const writes = [];
  t.mock.method(Delivery.collection, 'findOneAndUpdate', async (filter, update, options) => {
    const record = update.$push.matterBookingObservations.$each[0];
    assert.equal(filter._id, order._id);
    assert.equal(filter.scheduledTime, order.scheduledTime);
    assert.equal(filter.matterCustomerId, order.matterCustomerId);
    assert.deepEqual(filter.matterBookingObservations.$not.$elemMatch,
      { reference: record.reference, observedAt: record.observedAt });
    assert.equal(filter.$or, undefined);
    assert.deepEqual(update.$push.matterBookingObservations.$sort, { observedAt: 1, reference: 1 });
    assert.equal(options.returnDocument, 'after');
    assert.equal(options.includeResultMetadata, false);
    if (writes.some(row => row.reference === record.reference && row.observedAt === record.observedAt)) return null;
    writes.push(record);
    writes.sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.reference.localeCompare(b.reference));
    return { ...order, matterBookingObservations: [...writes] };
  });
  return writes;
}

test('a supplemental failure after the financial receipt leaves the financial capture and cooldown usable', async t => {
  const previous = process.env.MATTER_REPORTING_CAPTURE_ENABLED;
  process.env.MATTER_REPORTING_CAPTURE_ENABLED = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.MATTER_REPORTING_CAPTURE_ENABLED;
    else process.env.MATTER_REPORTING_CAPTURE_ENABLED = previous;
  });
  t.mock.method(matter, 'listSubscriptions', async () => ({ data: [subscription], meta: { total_pages: 1 } }));
  t.mock.method(matter, 'getSubscription', async () => ({ data: { ...subscription, upcoming_plan: { subscription_id: 'bad-renewal' } } }));
  t.mock.method(Snapshot, 'findOne', () => query(null));
  let saved;
  t.mock.method(Snapshot, 'create', async row => { saved = row; });
  t.mock.method(Snapshot, 'find', () => query([]));
  t.mock.method(Customer, 'find', () => query([]));
  t.mock.method(Delivery, 'find', filter => {
    if (!filter.matterRevenue) throw new Error('Supplemental read unavailable');
    return query([]);
  });
  const result = await refreshMatterSales();
  assert.equal(saved.profiles.length, 1);
  assert.equal(saved.profiles[0].payments[0].id, 'receipt');
  assert.equal(result.bookingCapture.state, 'incomplete');
  assert.deepEqual(await refreshMatterSales(), { reused: true });
});

test('hourly source captures a unique linked future order and holds ambiguous orders or vanished subscriptions', async t => {
  const deliveries = [{ ...order }];
  t.mock.method(Delivery, 'find', () => query(deliveries));
  t.mock.method(Customer, 'find', () => query([{ customerId: order.customerId, matterCustomerId: order.matterCustomerId }]));
  const writes = captureStore(t);
  const source = websiteDeadlineSource(subscription, clock);
  assert.equal(await captureTomorrowWebsiteDeadlines([source], clock), 1);
  assert.equal(bookingDeadlineEvidence({ ...order, matterBookingObservations: writes }).effective.end, '2026-12-01T02:00:00.000Z');
  deliveries.push({ ...order, _id: 'competing-order', status: 'completed' });
  await captureTomorrowWebsiteDeadlines([{ ...source, observedAt: '2026-11-30T13:00:00.000Z' }], clock);
  assert.equal(writes.at(-1).reason, 'ambiguous-customer-orders');
  assert.equal(bookingDeadlineEvidence({ ...order, matterBookingObservations: writes }).effective, null);
  deliveries.pop();
  await captureTomorrowWebsiteDeadlines([], '2026-11-30T14:00:00.000Z');
  assert.equal(writes.at(-1).reason, 'subscription-unavailable-in-website-read');
  assert.equal(bookingDeadlineEvidence({ ...order, matterBookingObservations: writes }).original.reference, writes[0].reference);
  assert.equal(await appendWebsiteDeadline({ ...order, matterCustomerId: 'another-customer' }, writes[0]), false);
});

test('an unchanged later poll brackets a delayed revision without republishing stable reads or exact retries', async t => {
  const writes = captureStore(t);
  const reading = (time, label) => observeWebsiteDeadline(websiteDeadlineSource({
    ...subscription, delivery_window: { ...subscription.delivery_window, label },
  }, '2026-11-30T' + time + ':00.000Z'), date);
  const original = reading('08:00', 'By 6 AM');
  const changed = reading('10:00', 'By 7 AM');
  const restored = reading('12:00', 'By 6 AM');
  const read = () => bookingDeadlineEvidence({ ...order, matterBookingObservations: writes });
  assert.equal(await appendWebsiteDeadline(order, original), true);
  const before = read();
  assert.equal(await appendWebsiteDeadline(order, restored), false);
  assert.deepEqual(read(), before);
  assert.equal(writes.length, 2);
  assert.equal(await appendWebsiteDeadline(order, changed), true);
  const after = read();
  assert.equal(after.effective.reference, original.reference);
  assert.equal(after.effective.observedAt, restored.observedAt);
  assert.equal(after.firstDifferentObservation.reference, changed.reference);
  assert.equal(await appendWebsiteDeadline(order, changed), false);
  assert.equal(writes.length, 3);
  assert.equal(await appendWebsiteDeadline(order, reading('13:00', 'By 6 AM')), false);
  assert.deepEqual(read(), after);
  assert.equal(writes.length, 4);
});

test('only the importer asks the dated roster for a native website receipt', async t => {
  const future = '2099-02-01';
  const sub = { ...subscription, cycle_end_date: '2099-02-28', delivery_schedule: [{ date: future, status: 'active' }] };
  t.mock.method(matter, 'listAllSubscriptions', async () => [sub]);
  t.mock.method(matter, 'getSubscription', async () => ({ data: sub }));
  const ordinary = await matter.findSubscriptionsWithDeliveryOnDate(future);
  const [read] = await matter.findSubscriptionsWithDeliveryOnDate(future, { includeBookingEvidence: true });
  assert.equal(ordinary[0].bookingObservation, undefined);
  assert.equal(read.bookingObservation.end, '2099-02-01T02:00:00.000Z');
  assert.equal(read.bookingObservation.matterCustomerId, subscription.customer_id);
  matter.getSubscription = async () => ({ data: { ...sub, customer_id: 'different-person' } });
  const [changed] = await matter.findSubscriptionsWithDeliveryOnDate(future, { includeBookingEvidence: true });
  assert.equal(changed.bookingObservation, null);
});
