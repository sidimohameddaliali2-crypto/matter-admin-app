import { test } from 'node:test';
import assert from 'node:assert/strict';
import CustomerGeofence from '../models/CustomerGeofence.js';
import TrackerGeofenceEvent from '../models/TrackerGeofenceEvent.js';
import truckoom from './truckoomApiService.js';
import { archiveTrackerEvents, removeExpiredCustomerGeofences } from './truckoomGeofenceLifecycle.js';

const now = new Date('2026-10-23T20:16:00Z'); // 00:16 on 24 October in Dubai
const key = 'a'.repeat(64);
const fence = { _id: 'local', businessDate: '2026-10-23', name: `MATTER-20261023-${key.slice(0,24)}`,
  key, truckoomId: 'remote-id' };

function setup(t, fences = [fence]) {
  const order = [];
  let filter;
  t.mock.method(CustomerGeofence, 'find', query => {
    filter = query;
    return { sort: () => ({ limit: () => ({ lean: async () => fences }) }) };
  });
  t.mock.method(truckoom, 'getGeofences', async () => [{ 'Geofence Id': fence.truckoomId, 'Geofence name': fence.name }]);
  t.mock.method(truckoom, 'deleteCustomerGeofence', async () => { order.push('delete'); });
  t.mock.method(CustomerGeofence, 'updateOne', async () => { order.push('markDeleted'); });
  const options = { now, renew: async () => {}, getDateAlerts: async date => { order.push(`archive:${date}`); } };
  return { options, order, filter: () => filter };
}

test('archives both UTC dates before deleting yesterday fence, and keeps local identity', async t => {
  const f = setup(t);
  assert.equal(await removeExpiredCustomerGeofences(f.options), 1);
  assert.deepEqual(f.order, ['archive:22-10-2026', 'archive:23-10-2026', 'delete', 'markDeleted']);
  assert.deepEqual(f.filter().businessDate, { $lt: '2026-10-24' });
  assert.deepEqual(CustomerGeofence.updateOne.mock.calls[0].arguments[1], { $set: { deletedAt: now } });
});

test('keeps yesterday fence during the midnight grace period', async t => {
  const f = setup(t);
  assert.equal(await removeExpiredCustomerGeofences({ ...f.options, now: new Date('2026-10-23T20:14:59Z') }), 0);
  assert.equal(CustomerGeofence.find.mock.callCount(), 0);
  assert.equal(truckoom.deleteCustomerGeofence.mock.callCount(), 0);
});

test('archive failure leaves the remote fence and local deletion marker untouched', async t => {
  const f = setup(t);
  f.options.getDateAlerts = async () => { throw new Error('Archive database unavailable'); };
  assert.equal(await removeExpiredCustomerGeofences(f.options), 0);
  assert.equal(truckoom.deleteCustomerGeofence.mock.callCount(), 0);
  assert.equal(CustomerGeofence.updateOne.mock.callCount(), 0);
});

test('failed remote deletion is retried on a later cycle', async t => {
  const f = setup(t);
  t.mock.method(truckoom, 'deleteCustomerGeofence', async () => { throw new Error('API unavailable'); });
  assert.equal(await removeExpiredCustomerGeofences(f.options), 0);
  assert.equal(CustomerGeofence.updateOne.mock.callCount(), 0);
});

test('a lost worker lease stops cleanup before any external call', async t => {
  const f = setup(t);
  f.options.renew = async () => { throw new Error('Lease lost'); };
  await assert.rejects(removeExpiredCustomerGeofences(f.options), /Lease lost/);
  assert.equal(truckoom.getGeofences.mock.callCount(), 0);
  assert.equal(truckoom.deleteCustomerGeofence.mock.callCount(), 0);
});

test('a previously deleted remote fence can be marked locally after a restart', async t => {
  const f = setup(t);
  t.mock.method(truckoom, 'getGeofences', async () => []);
  assert.equal(await removeExpiredCustomerGeofences(f.options), 1);
  assert.equal(truckoom.deleteCustomerGeofence.mock.callCount(), 0);
  assert.equal(CustomerGeofence.updateOne.mock.callCount(), 1);
});

test('kitchen/manual/legacy fences and mismatched remote names cannot be removed', async t => {
  const f = setup(t, [{ ...fence, name: 'Matter Kitchen - Al Quoz' }, { ...fence, businessDate: undefined },
    { ...fence, businessDate: '2026-10-24', name: `MATTER-20261024-${key.slice(0,24)}` }, fence]);
  t.mock.method(truckoom, 'getGeofences', async () => [{ 'Geofence Id': fence.truckoomId, 'Geofence name': 'A manual fence' }]);
  assert.equal(await removeExpiredCustomerGeofences(f.options), 0);
  assert.equal(truckoom.deleteCustomerGeofence.mock.callCount(), 0);
});

test('event archives use stable unique ids so repeated polling is idempotent', async t => {
  const writes = [];
  t.mock.method(TrackerGeofenceEvent, 'bulkWrite', async ops => { writes.push(ops); });
  const events = [{ name: fence.name, vehicleNo: 'V1', flag: 'entry', at: new Date('2026-10-23T01:00:00Z') },
    { name: 'Matter Kitchen - Al Quoz', vehicleNo: 'V1', flag: 'exit', at: now }];
  await archiveTrackerEvents(events);
  await archiveTrackerEvents(events);
  assert.equal(writes[0].length, 1);
  assert.deepEqual(writes[0], writes[1]);
  assert.equal(writes[0][0].updateOne.upsert, true);
  assert.deepEqual(writes[0][0].updateOne.update.$setOnInsert, events[0]);
});
