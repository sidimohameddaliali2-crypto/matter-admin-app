// Isolated MongoDB replica-set acceptance. No production URL is accepted.
// MONGO_TEST_URI=mongodb://127.0.0.1:27017/... node --test services/externalRoutePlan.integration.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { fixture, ids } from './fixtures/externalRoutePlanFixture.js';
import User from '../models/User.js';
import Delivery from '../models/Delivery.js';
import ExternalRoutePlan from '../models/ExternalRoutePlan.js';
import { importExternalPlan, recordPlanEvent, driverPlans, cancelExternalPlan } from './externalRoutePlanService.js';

const uri = process.env.MONGO_TEST_URI;
test('persisted external import -> two native pickups -> proofs, retries, replacement and midnight', { skip: !uri }, async t => {
  assert.match(uri, /^mongodb:\/\/(127\.0\.0\.1|localhost):/);
  const dbName = `hub_flow_fixture_${randomUUID().replaceAll('-', '')}`;
  await mongoose.connect(uri, { dbName });
  t.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-14T02:16:00+04:00') });
  t.after(() => t.mock.timers.reset());
  const raw = fixture();
  // Direct fixture inserts avoid account creation hooks and use no live identities.
  await User.collection.insertMany(raw.routes.map(r => ({ _id: new mongoose.Types.ObjectId(r.driverId), role: 'driver', isActive: true, profile: { firstName: 'Fixture', lastName: r.vehicleLabel, vehicleType: r.vehicleType } })));
  await Delivery.collection.insertMany(raw.routes[0].stops.filter(s => s.type === 'customer').map(s => ({ _id: new mongoose.Types.ObjectId(s.deliveryId), customerId: s.id, customerName: `Fixture ${s.id}`, type: 'Delivery', status: 'pending', scheduledTime: new Date(s.deadlineAt), gpsLocation: s.point })));
  const actor = new mongoose.Types.ObjectId();
  let p = await importExternalPlan(raw, actor);
  assert.equal((await importExternalPlan(raw, actor)).id, p.id, 'duplicate import uses same plan');
  assert.equal(await ExternalRoutePlan.countDocuments(), 1);
  const planKey = p.id;
  let serial = 0;
  const send = (driverId, type, extra = {}, revision = 1, eventId = `fixture-event-${serial++}`) => recordPlanEvent(planKey, driverId, { driverId, eventId, type, revision, ...extra });
  await Delivery.updateOne({ _id: ids.d2 }, { $set: { driver: ids.van2 } });
  await assert.rejects(send(ids.bike, 'acknowledge'), /Assignment changed/);
  assert.equal((await ExternalRoutePlan.findById(planKey).lean()).receipts.length, 0);
  await Delivery.updateOne({ _id: ids.d2 }, { $set: { driver: ids.bike } });
  for (const r of raw.routes) { await send(r.driverId, 'acknowledge'); await send(r.driverId, 'load', { cargo: r.initialCargo }); }
  const proof = { photoUrl: 'https://fixture.invalid/proof.jpg', images: ['https://fixture.invalid/proof.jpg'] };
  const c1 = raw.routes[0].stops[0];
  await send(ids.bike, 'complete', { stopId: c1.id, location: c1.point, proof, bagId: 'FIXTURE-BAG-1' });
  let saved = await Delivery.findById(ids.d1).lean();
  assert.equal(saved.status, 'delivered');
  assert.equal(saved.proof.photoUrl, proof.photoUrl);
  for (const [index, transfer] of raw.transfers.entries()) {
    t.mock.timers.setTime(new Date(transfer.pickupAt).getTime());
    await send(ids.bike, 'exception', { transferId: transfer.id, reason: 'missing_counterpart' });
    await send(ids.bike, 'arrive', { transferId: transfer.id, location: transfer.point });
    await assert.rejects(send(ids.bike, 'confirm', { transferId: transfer.id, batchId: transfer.batchId, cargo: transfer.cargo, location: transfer.point }), /counterpart/);
    await send(transfer.vanDriverId, 'arrive', { transferId: transfer.id, location: transfer.point });
    t.mock.timers.setTime(new Date(transfer.plannedDepartureAt).getTime());
    const beforeRejected = (await Delivery.findById(ids.d1).lean()).externalRouteStateVersion;
    await assert.rejects(send(ids.bike, 'confirm', { transferId: transfer.id, batchId: 'wrong', cargo: transfer.cargo, location: transfer.point }), /batch/);
    assert.equal((await Delivery.findById(ids.d1).lean()).externalRouteStateVersion, beforeRejected, 'failed event transaction rolls back touched rows');
    const accepted = { transferId: transfer.id, batchId: transfer.batchId, cargo: transfer.cargo, location: transfer.point };
    await send(ids.bike, 'confirm', accepted);
    const receiptId = `fixture-confirm-${index}`;
    await send(transfer.vanDriverId, 'confirm', accepted, 1, receiptId);
    const retried = await send(transfer.vanDriverId, 'confirm', accepted, 1, receiptId);
    assert.equal(retried.duplicate, true);
    const stop = raw.routes[0].stops.filter(s => s.type === 'customer')[index + 1];
    await send(ids.bike, 'complete', { stopId: stop.id, location: stop.point, proof, bagId: transfer.cargo[0].bagIds[0] });
  }
  assert.equal(await Delivery.countDocuments({ status: 'delivered' }), 3);
  p = await ExternalRoutePlan.findById(p.id).lean();
  assert.equal(Object.keys(p.state.completedTransfers).length, 2);
  const fresh = await driverPlans(ids.bike, new Date('2026-10-13T19:59:59Z'));
  assert.equal(fresh[0].serviceDate, '2026-10-14');
  assert.equal((await driverPlans(ids.bike, new Date('2026-10-13T20:00:00Z')))[0].serviceDate, '2026-10-14');
  const replacement = fixture(); replacement.revision = 2; replacement.expectedRevision = 1; replacement.requestId = 'fixture-import-2';
  await importExternalPlan(replacement, actor);
  await assert.rejects(send(ids.bike, 'acknowledge'), /revision/);
  const reloaded = await ExternalRoutePlan.findById(p._id).lean();
  assert.deepEqual(reloaded.state.acknowledgements, {});
  assert.equal(Object.keys(reloaded.state.completedTransfers).length, 2);
  await cancelExternalPlan(String(p._id), 2, 'fixture-cancel', actor);
  await assert.rejects(send(ids.bike, 'acknowledge', {}, 3), /cancelled/);
  assert.equal((await driverPlans(ids.bike))[0].cancelled, true);
});
