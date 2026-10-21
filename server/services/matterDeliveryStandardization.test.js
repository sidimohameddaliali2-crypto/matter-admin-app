import test from 'node:test';
import assert from 'node:assert/strict';
import { planMatterDeliveryStandardization, standardizeMatterDeliveries, loadCurrentMatterDeliveryProfiles } from './matterDeliveryStandardization.js';
import Delivery from '../models/Delivery.js';
import Customer from '../models/Customer.js';
import matter from './matterApiService.js';
import { buildNutritionResult } from './matterApiService.js';
import { displayMatterName } from '../utils/matterName.js';

const date = '2026-10-23';
const now = new Date('2026-10-21T12:00:00Z');
const delivery = { _id: 'delivery', customerId: 'CUST-1', customerName: 'Saved name', company: 'Matter', type: 'Delivery', status: 'pending', scheduledTime: new Date('2026-10-23T02:00:00Z'), matterSubscriptionId: 'expired' };
const customers = [{ customerId: 'CUST-1', matterCustomerId: '625', firstName: 'Internal name' }];
const subscription = { subscription_id: 'renewed', customer_id: '625', name: '  MATTER  NAME ', delivery_window: { label: 'By 3:30 AM' }, delivery_date: date };

test('renewals match permanent customer IDs and use the same Matter name and minute-accurate Dubai window as kitchen inputs', () => {
  const plan = planMatterDeliveryStandardization([delivery], customers, [subscription], date, now);
  assert.equal(plan.unresolved.length, 0);
  assert.deepEqual(plan.updates[0].fields, { customerName: displayMatterName(buildNutritionResult(subscription).customer_name),
    scheduledTime: new Date('2026-10-22T23:30:00Z'), matterCustomerId: '625', matterSubscriptionId: 'renewed' });
  assert.deepEqual(Object.keys(plan.updates[0].fields).sort(), ['customerName', 'matterCustomerId', 'matterSubscriptionId', 'scheduledTime']);
});

test('historical, completed, in-flight, task and non-Matter records are not rewritten', () => {
  const variants = [ { status: 'delivered' }, { status: 'on_route' }, { status: 'picked_up' }, { type: 'Task' }, { company: 'Partner' }, { scheduledTime: new Date('2026-10-20T02:00:00Z') } ];
  for (const variant of variants) assert.equal(planMatterDeliveryStandardization([{ ...delivery, ...variant }], customers, [subscription], date, now).updates.length, 0);
  assert.equal(planMatterDeliveryStandardization([delivery], customers, [subscription], date, new Date('2026-10-24T12:00:00Z')).updates.length, 0);
});

test('missing accounts, conflicting IDs, duplicate subscriptions and invalid windows never fall back to names or internal times', () => {
  for (const roster of [[], [subscription, { ...subscription, subscription_id: 'second' }], [{ ...subscription, delivery_window: null }], [{ ...subscription, delivery_window: { label: 'By 3:99 AM' } }]]) {
    const plan = planMatterDeliveryStandardization([delivery], customers, roster, date, now);
    assert.equal(plan.updates.length, 0);
    assert.equal(plan.unresolved.length, 1);
  }
  const conflict = planMatterDeliveryStandardization([{ ...delivery, matterCustomerId: 'other' }], customers, [subscription], date, now);
  assert.equal(conflict.updates.length, 0);
  assert.equal(conflict.unresolved[0].reason, 'identity-conflict');
});

test('a synchronized record is idempotent and exact subscription identity works without a profile', () => {
  const first = planMatterDeliveryStandardization([{ ...delivery, matterSubscriptionId: 'renewed' }], [], [subscription], date, now);
  assert.equal(first.updates.length, 1);
  assert.equal(planMatterDeliveryStandardization([{ ...delivery, ...first.updates[0].fields }], customers, [subscription], date, now).updates.length, 0);
});

test('the write is guarded against completion or an edit during the Matter request; failed discovery writes nothing', async () => {
  const originals = { find: Delivery.find, customers: Customer.find, bulk: Delivery.bulkWrite, roster: matter.findSubscriptionsWithDeliveryOnDate };
  const writes = [];
  Delivery.find = () => ({ lean: async () => [delivery] });
  Customer.find = () => ({ select: () => ({ lean: async () => customers }) });
  Delivery.bulkWrite = async (ops) => { writes.push(...ops); return { modifiedCount: 1 }; };
  try {
    const result = await standardizeMatterDeliveries(date, { roster: [subscription], now });
    assert.equal(result.updated, 1);
    const filter = writes[0].updateOne.filter;
    assert.equal(filter.status, 'pending');
    assert.equal(filter.customerName, 'Saved name');
    assert.deepEqual(filter.scheduledTime, delivery.scheduledTime);
    matter.findSubscriptionsWithDeliveryOnDate = async () => { throw new Error('Incomplete roster'); };
    await assert.rejects(standardizeMatterDeliveries(date, { now }), /Incomplete roster/);
    assert.equal(writes.length, 1);
  } finally {
    Delivery.find = originals.find; Customer.find = originals.customers; Delivery.bulkWrite = originals.bulk; matter.findSubscriptionsWithDeliveryOnDate = originals.roster;
  }
});

test('explicit approval permits completed history using current Matter values and refreshes stored timing without changing actual completion', () => {
  const historicalDate = '2026-10-13';
  const completed = { ...delivery, status: 'delivered', scheduledTime: new Date('2026-10-13T02:00:00Z'), deliveredTime: new Date('2026-10-13T00:00:00Z') };
  const plan = planMatterDeliveryStandardization([completed], customers, [{ ...subscription, delivery_date: undefined }], historicalDate, now, { useCurrentValues: true });
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].fields.scheduledTime.toISOString(), '2026-10-12T23:30:00.000Z');
  assert.equal(plan.updates[0].fields.lateMinutes, 30);
  assert.equal(plan.updates[0].fields.earlyMinutes, 0);
  assert.equal(plan.updates[0].fields.deliveryType, 'late');
  assert.equal(Object.hasOwn(plan.updates[0].fields, 'deliveredTime'), false);
  assert.equal(plan.updates[0].identity.deliveredTime, completed.deliveredTime);
});

test('historical lookup follows current permanent identity across renewals, fetching each full profile once', async () => {
  const original = { list: matter.listAllSubscriptions, get: matter.getSubscription };
  const calls = [];
  matter.listAllSubscriptions = async () => [{ ...subscription, subscription_status: 'active' }, { ...subscription, subscription_id: 'expired', subscription_status: 'cancelled' }];
  matter.getSubscription = async (id) => { calls.push(id); return { data: subscription }; };
  try {
    const profiles = await loadCurrentMatterDeliveryProfiles([delivery, delivery], customers);
    assert.deepEqual(calls, ['renewed']);
    assert.equal(profiles.length, 1);
    matter.getSubscription = async () => ({ data: { ...subscription, customer_id: 'wrong' } });
    await assert.rejects(loadCurrentMatterDeliveryProfiles([delivery], customers), /identity/);
  } finally { matter.listAllSubscriptions = original.list; matter.getSubscription = original.get; }
});

test('the approved history starts with last week; older dates cannot trigger backfills', async () => {
  const result = await standardizeMatterDeliveries('2026-10-11');
  assert.equal(result.updated, 0);
  assert.equal(result.outsideApprovedHistory, true);
});
