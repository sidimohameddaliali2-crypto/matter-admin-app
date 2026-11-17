import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldAuditModel, isAutomaticDriverLocation, isLocationOnlyUpdate } from './activityScope.js';
import { installActivityDatabase, createActivityPlugin } from './activityDatabase.js';

test('owning GPS evidence and coordination collections are not duplicated as staff activity', () => {
  for (const name of ['VehicleLocationHistory', 'VehicleLocationCaptureBatch', 'TrackerSyncLease', 'TruckoomGpsReceipt', 'TruckoomTrackHistory', 'TrackerGeofenceEvent', 'TruckoomLiveSnapshot']) assert.equal(shouldAuditModel(name), false);
  for (const name of ['User', 'Delivery', 'Customer', 'Vehicle', 'CustomerGeofence', 'Bag', 'ServiceAction']) assert.equal(shouldAuditModel(name), true);
});
test('model hooks and bulk writes both preserve the owning observation path without duplicate activity', async () => {
  const events = [];
  let queryHook;
  createActivityPlugin({ write: async event => events.push(event) })({ options: {}, pre(name, ...args) { if (name === 'findOneAndUpdate') queryHook = args.at(-1); }, post() {} });
  await queryHook.call({ model: { modelName: 'TruckoomLiveSnapshot', findOne() { assert.fail('No extra before-image read for observation models'); } } });
  let originalCalls = 0;
  const fake = { plugin() {}, Connection: { prototype: { async startSession() {} } }, Model: { async bulkWrite() { originalCalls++; return { insertedCount: 1 }; } } };
  installActivityDatabase(fake, async event => events.push(event));
  const result = await fake.Model.bulkWrite.call({ modelName: 'VehicleLocationHistory', schema: { options: {} } }, [{ insertOne: { document: { observed: true } } }]);
  assert.equal(result.insertedCount, 1);
  assert.equal(originalCalls, 1);
  assert.equal(events.length, 0);
  await fake.Model.bulkWrite.call({ modelName: 'Delivery', schema: { options: {} } }, [{ insertOne: { document: { status: 'pending' } } }]);
  assert.ok(events.some(event => event.stage === 'record_saved'));
});
test('only a driver automatic self-location observation is excluded; explicit actions remain', () => {
  const req = { method: 'PUT', activityRoute: { path: '/api/users/drivers/:id/location' }, params: { id: 'own-driver' }, activityActor: { id: 'own-driver', role: 'driver' } };
  assert.equal(isAutomaticDriverLocation(req), true);
  assert.equal(isAutomaticDriverLocation({ ...req, activityContext: { actionId: 'explicit-action' } }), false);
  assert.equal(isAutomaticDriverLocation({ ...req, activityActor: { id: 'own-driver', role: 'admin' } }), false);
  assert.equal(isAutomaticDriverLocation({ ...req, params: { id: 'another-driver' } }), false);
  assert.equal(isAutomaticDriverLocation({ ...req, activityRoute: { path: '/api/drivers/:id' } }), false);
});
test('location-only detection tolerates actual Mongoose timestamp fields but no business changes', () => {
  const update = { $set: { location: { latitude: 25, longitude: 55 }, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } };
  assert.equal(isLocationOnlyUpdate(update), true);
  assert.equal(isLocationOnlyUpdate({ ...update, $set: { ...update.$set, role: 'admin' } }), false);
  assert.equal(isLocationOnlyUpdate({ ...update, $inc: { score: 1 } }), false);
});
