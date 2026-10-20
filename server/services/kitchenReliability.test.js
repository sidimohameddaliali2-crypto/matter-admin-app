import test from 'node:test';
import assert from 'node:assert/strict';
import matter from './matterApiService.js';
import Delivery from '../models/Delivery.js';
import Lease from '../models/KitchenPreparationLease.js';
import { importMatterDeliveriesForDate } from './matterDeliveryImportService.js';
import { withKitchenPreparation, preparationHasFailures } from './kitchenPreparation.js';

test('incomplete discovery blocks import before DB writes and recovery includes all subscriptions', async () => {
  const original = { list: matter.listAllSubscriptions, detail: matter.getSubscription, find: Delivery.findOne, log: console.error };
  let fail = true;
  let reads = 0;
  matter.listAllSubscriptions = async () => ['A', 'B', 'C'].map((id) => ({ subscription_id: id, subscription_status: 'active', cycle_end_date: '2026-11-30' }));
  matter.getSubscription = async (id) => {
    if (id === 'B' && fail) throw new Error('Upstream timeout');
    return { data: { name: id, delivery_schedule: [{ date: '2026-10-20', status: 'active' }], customer_addresses: [] } };
  };
  Delivery.findOne = () => { reads++; return { select: async () => ({ _id: 'existing', status: 'delivered' }) }; };
  console.error = () => {};
  try {
    await assert.rejects(matter.findSubscriptionsWithDeliveryOnDate('2026-10-20'), (error) => {
      assert.equal(error.code, 'INCOMPLETE_DELIVERY_ROSTER');
      assert.equal(error.discovery.verified, 2);
      assert.equal(error.discovery.errors[0].subscriptionId, 'B');
      return true;
    });
    const incomplete = await importMatterDeliveriesForDate('2026-10-20');
    assert.equal(incomplete.complete, false);
    assert.equal(incomplete.discoveryFailed, 1);
    assert.equal(incomplete.writeFailed, 0);
    assert.equal(incomplete.created, 0);
    assert.equal(reads, 0);
    fail = false;
    assert.equal((await matter.findSubscriptionsWithDeliveryOnDate('2026-10-20')).length, 3);
    const recovered = await importMatterDeliveriesForDate('2026-10-20');
    assert.equal(recovered.complete, true);
    assert.equal(recovered.alreadyExisted, 3);
    assert.equal(recovered.created, 0);
    // Repeated imports preserve existing records instead of duplicating them.
    assert.equal((await importMatterDeliveriesForDate('2026-10-20')).alreadyExisted, 3);
    matter.getSubscription = async () => ({ data: {} });
    await assert.rejects(matter.findSubscriptionsWithDeliveryOnDate('2026-10-20'), { code: 'INCOMPLETE_DELIVERY_ROSTER' });
    matter.getSubscription = async () => ({ data: { delivery_schedule: [] } });
    assert.deepEqual(await matter.findSubscriptionsWithDeliveryOnDate('2026-10-20'), []);
  } finally {
    matter.listAllSubscriptions = original.list;
    matter.getSubscription = original.detail;
    Delivery.findOne = original.find;
    console.error = original.log;
  }
});

test('concurrent preparation shares one job, releases the lease, and a failure can be retried', async () => {
  const original = { acquire: Lease.findOneAndUpdate, release: Lease.deleteOne };
  let acquired = 0, released = 0, runs = 0, finish;
  Lease.findOneAndUpdate = async () => { acquired++; return {}; };
  Lease.deleteOne = async () => { released++; return {}; };
  try {
    const task = async () => { runs++; return new Promise((resolve) => { finish = resolve; }); };
    const first = withKitchenPreparation('fixture', task);
    const second = withKitchenPreparation('fixture', task);
    await Promise.resolve();
    finish('completed');
    assert.deepEqual(await Promise.all([first, second]), ['completed', 'completed']);
    assert.equal(runs, 1); assert.equal(acquired, 1); assert.equal(released, 1);
    await assert.rejects(withKitchenPreparation('fixture', async () => { throw new Error('Failed assignment'); }));
    assert.equal(await withKitchenPreparation('fixture', async () => 'retry completed'), 'retry completed');
    assert.equal(released, 3);
    Lease.findOneAndUpdate = async () => { const e = new Error('Duplicate lease'); e.code = 11000; throw e; };
    await assert.rejects(withKitchenPreparation('other-worker', async () => assert.fail('must not assign concurrently')), { code: 'KITCHEN_PREPARATION_BUSY' });
  } finally { Lease.findOneAndUpdate = original.acquire; Lease.deleteOne = original.release; }
});

test('partial assignment summaries cannot be cached as complete', () => {
  assert.equal(preparationHasFailures({ assignedMainMeals: { error: 'No rotation' } }), true);
  assert.equal(preparationHasFailures({ assignedSnacks: { skippedNoOptions: 1 } }), true);
  assert.equal(preparationHasFailures({ assignedMainMeals: { skippedBreakfastNoOption: 1 } }), true);
  assert.equal(preparationHasFailures({ assignedMainMeals: { assigned: 2, skippedAlreadyAssigned: 3 } }), false);
});
