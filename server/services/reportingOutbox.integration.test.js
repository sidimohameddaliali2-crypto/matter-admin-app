import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import Delivery from '../models/Delivery.js';
import VehicleLocationCaptureBatch from '../models/VehicleLocationCaptureBatch.js';
import VehicleLocationHistory from '../models/VehicleLocationHistory.js';
import { insertMatterDelivery } from './matterDeliveryInsert.js';
import { createVehicleLocationCaptureStore } from './vehicleLocationCaptureStore.js';
import {
  inspectReportingMongoTopology, readReportingChanges, readReportingWatermark,
  recordReportingDeliveryChanges, withReportingEvents,
} from './reportingOutbox.js';

const uri = process.env.REPORTING_TEST_MONGO_URI;

test('completion proof, daily imports and GPS batch commits share a durable replay cursor', { skip: !uri, timeout: 45_000 }, async t => {
  assert.equal(uri, 'mongodb://127.0.0.1:27017/driver_reports_ci?directConnection=true');
  t.after(() => mongoose.disconnect());
  await mongoose.connect(uri, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 5_000 });
  assert.deepEqual(await inspectReportingMongoTopology(), { topology: 'replica_set', supported: true, writable: true });

  const savedCapture = process.env.MATTER_REPORTING_CAPTURE_ENABLED;
  process.env.MATTER_REPORTING_CAPTURE_ENABLED = '1';
  t.after(() => {
    if (savedCapture === undefined) delete process.env.MATTER_REPORTING_CAPTURE_ENABLED;
    else process.env.MATTER_REPORTING_CAPTURE_ENABLED = savedCapture;
  });

  const at = new Date('2026-11-22T06:30:00.000Z');
  const fix = new Date(+at - 2000);
  const delivery = await Delivery.create({ customerId: 'fixture', customerName: 'Fixture', scheduledTime: at, status: 'assigned' });
  const base = await readReportingWatermark();
  const photoUrl = 'https://example.invalid/photos/fixture.jpg';
  delivery.proof = { photoUrl, timestamp: at, receivedAt: at };
  await delivery.updateStatus('delivered', 'Fixture', { lat: 25, lng: 55 });

  const readDelivery = () => Delivery.findById(delivery._id).select('+reportingVersion').lean();
  const completed = await readDelivery();
  assert.equal(completed.status, 'delivered');
  assert.equal(completed.proof.photoUrl, photoUrl);
  assert.deepEqual(completed.proof.location, { lat: 25, lng: 55 });
  assert.equal(completed.reportingVersion, base + 1);

  await assert.rejects(withReportingEvents(async (session, enqueue) => {
    await Delivery.collection.updateOne({ _id: delivery._id }, { $set: { 'proof.photoUrl': 'aborted' } }, { session });
    await recordReportingDeliveryChanges(session, enqueue, [delivery._id], Delivery.collection);
    throw new Error('fixture rollback');
  }), /fixture rollback/);
  assert.equal((await readDelivery()).proof.photoUrl, photoUrl);
  assert.equal((await readDelivery()).reportingVersion, base + 1);
  assert.equal(await readReportingWatermark(), base + 1);

  const inserted = await Promise.all(['one', 'two'].map(id => insertMatterDelivery({
    customerId: id, customerName: 'Fixture', matterSubscriptionId: id, scheduledTime: at,
  }, '2026-11-22')));
  assert.deepEqual(inserted, [true, true]);
  const imported = await Delivery.find({ customerId: { $in: ['one', 'two'] } }).select('+reportingVersion').lean();
  assert.deepEqual(imported.map(row => row.reportingVersion).sort((a, b) => a - b), [base + 2, base + 3]);

  const store = createVehicleLocationCaptureStore({ clock: () => at });
  const lease = await store.claimTick(at);
  const pending = await store.saveBatch(lease, { rows: [
    { vehicleNo: 'fixture-vehicle', latitude: 25, longitude: 55, gpsTime: fix, recordedAt: at },
  ] });
  assert.equal((await VehicleLocationCaptureBatch.findById(lease.batchId).lean()).state, 'pending');
  assert.equal(await readReportingWatermark(), base + 3);
  const receipt = await store.persistBatch(pending);
  assert.equal(receipt.storedRows, 1);
  assert.equal((await VehicleLocationCaptureBatch.findById(lease.batchId).lean()).state, 'complete');
  const point = await VehicleLocationHistory.findOne({ captureBatchId: lease.batchId }).lean();
  assert.equal(+point.gpsTime, +fix);
  assert.equal(+point.recordedAt, +at);

  const page = await readReportingChanges({ after: String(base) });
  assert.deepEqual(page.data.map(event => event.sourceVersion), [base + 1, base + 2, base + 3, base + 4]);
  assert.equal(page.data[0].subjectId, String(delivery._id));
  assert.equal(page.data[0].eventType, 'delivery.changed');
  assert.equal(page.data[3].eventType, 'gps.batch-committed');
  assert.equal(page.data[3].subjectId, lease.batchId);
  assert.equal(page.hasMore, false);
});

test('a rapid second bag use republishes both source versions; amendment save includes its reporting version', {skip: !uri, timeout:45_000}, async t => {
  assert.equal(uri,'mongodb://127.0.0.1:27017/driver_reports_ci?directConnection=true');
  const { default:DeliveryChange } = await import('../models/DeliveryChange.js');
  const { recordDeliveryBagMovements } = await import('./deliveryBagMovements.js');
  const { readReportingDeliverySnapshot } = await import('../routes/externalReportingApi.js');
  const { saveAppliedChange } = await import('./reportingOutbox.js');
  await mongoose.connect(uri,{autoCreate:false,autoIndex:false,serverSelectionTimeoutMS:5000});
  t.after(()=>mongoose.disconnect());
  const previous = process.env.MATTER_REPORTING_CAPTURE_ENABLED;
  process.env.MATTER_REPORTING_CAPTURE_ENABLED = '1';
  t.after(()=>{ if (previous === undefined) delete process.env.MATTER_REPORTING_CAPTURE_ENABLED; else process.env.MATTER_REPORTING_CAPTURE_ENABLED = previous; });
  const actor = {_id:new mongoose.Types.ObjectId(),role:'driver'};
  const {default:User} = await import('../models/User.js');
  await User.collection.insertOne({_id:actor._id,role:'driver',profile:{firstName:'Fixture'}});
  const now = new Date();
  const bagId = 'BAG-' + Date.now();
  const source = async customerId => Delivery.create({type:'Delivery',customerId,customerName:'Fixture',driver:actor._id,
    scheduledTime:now,status:'delivered',proof:{bagIds:[bagId]}});
  const first = await source('fixture-first'), second = await source('fixture-second');
  const movement = order => recordDeliveryBagMovements(order,{status:'delivered',proof:{timestamp:now,bagIds:[bagId],
    bagAcquisitions:[{orderId:String(order._id),bagId,method:'qr',scannedAt:now}]}},actor);
  const before = await readReportingWatermark();
  await movement(first);
  await movement(second);
  const captured = await readReportingDeliverySnapshot(first._id);
  assert.ok(captured.reportingVersion > before+1);
  assert.equal(captured.arrivalEvidence.bags.events[0].physicalScan,true);
  assert.equal(captured.arrivalEvidence.bags.peerEvents[0].orderId,String(second._id));
  const latest = await readReportingWatermark();
  await movement(second);
  assert.equal(await readReportingWatermark(),latest);
  const change = new DeliveryChange({customerId:first.customerId,customerName:'Fixture',scheduledDate:now,status:'applied',
    appliedAt:now,appliedToDelivery:first._id,changes:{scheduledTime:'09:00'}});
  await saveAppliedChange(change,[first._id],Delivery.collection);
  const amended = await readReportingDeliverySnapshot(first._id);
  assert.equal(amended.reportingVersion,latest+1);
  assert.equal(amended.arrivalEvidence.amendments.events[0].changeId,String(change._id));
  // The existing exclusion applies to peers and to the selected order.
  await Delivery.collection.updateOne({_id:second._id},{$set:{zone:'Abu Dhabi'}});
  const hiddenPeer = await readReportingDeliverySnapshot(first._id);
  assert.equal(hiddenPeer.arrivalEvidence.bags.state,'partial');
  assert.equal(hiddenPeer.arrivalEvidence.bags.peerEvents.length,0);
  assert.equal((await readReportingDeliverySnapshot(second._id)).arrivalEvidence,undefined);
  await Delivery.collection.updateOne({_id:first._id},{$set:{customerId:'replacement-customer',scheduledTime:new Date(+now+86_400_000)}});
  const rebound = (await readReportingDeliverySnapshot(first._id)).arrivalEvidence;
  assert.equal(rebound.amendments.state,'partial');
  assert.deepEqual(rebound.amendments.events,[]);
  process.env.MATTER_REPORTING_CAPTURE_ENABLED = '0';
  assert.equal((await readReportingDeliverySnapshot(first._id)).arrivalEvidence,undefined);
});

test('dated website reads retain source order and publish only changes to the protected snapshot', { skip: !uri, timeout: 45_000 }, async t => {
  assert.equal(uri, 'mongodb://127.0.0.1:27017/driver_reports_ci?directConnection=true');
  const { appendWebsiteDeadline } = await import('./matterBookingCapture.js');
  const { observeWebsiteDeadline } = await import('./matterBookingDeadline.js');
  const { readReportingDeliverySnapshot } = await import('../routes/externalReportingApi.js');
  await import('../models/User.js'); // The reporting snapshot populates this model.
  await mongoose.connect(uri, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 5_000 });
  t.after(() => mongoose.disconnect());
  const previous = process.env.MATTER_REPORTING_CAPTURE_ENABLED;
  process.env.MATTER_REPORTING_CAPTURE_ENABLED = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.MATTER_REPORTING_CAPTURE_ENABLED;
    else process.env.MATTER_REPORTING_CAPTURE_ENABLED = previous;
  });

  const serviceDate = '2035-04-03';
  const order = await Delivery.create({ company: 'Matter', type: 'Delivery', status: 'assigned',
    customerId: 'fixture-booking', customerName: 'Fixture', matterCustomerId: 'fixture-website-customer',
    matterSubscriptionId: 'fixture-subscription', addressId: 'fixture-saved-address',
    scheduledTime: new Date(serviceDate + 'T02:00:00.000Z') });
  const reading = (hour, deadline) => observeWebsiteDeadline({
    observedAt: '2035-04-02T' + hour + ':00:00.000Z', subscriptionId: order.matterSubscriptionId,
    matterCustomerId: order.matterCustomerId, addressId: order.addressId, paid: true,
    cycleStart: serviceDate, cycleEnd: serviceDate, days: new Map([[serviceDate, 'active']]),
    time: deadline, windowId: deadline, pricingHash: 'fixture-pricing',
  }, serviceDate);
  const original = reading('08', '06:00');
  const changed = reading('10', '07:00');
  const restored = reading('12', '06:00');
  const snapshot = () => readReportingDeliverySnapshot(order._id);
  const clocks = async () => {
    const row = await Delivery.findById(order._id).select('+matterBookingObservations').lean();
    return row.matterBookingObservations.map(event => event.observedAt);
  };
  const base = await readReportingWatermark();
  assert.equal(await appendWebsiteDeadline(order, original), true);
  const first = await snapshot();
  assert.equal(first.reportingVersion, base + 1);
  assert.equal(first.arrivalEvidence.booking.effective.observedAt, original.observedAt);
  assert.equal(await appendWebsiteDeadline(order, restored), false);
  assert.deepEqual(await clocks(), [original.observedAt, restored.observedAt]);
  assert.deepEqual(await snapshot(), first);

  assert.equal(await appendWebsiteDeadline(order, changed), true);
  const revised = await snapshot();
  assert.equal(revised.reportingVersion, base + 2);
  const booking = revised.arrivalEvidence.booking;
  assert.deepEqual(booking.original, first.arrivalEvidence.booking.original);
  assert.equal(booking.firstDifferentObservation.reference, changed.reference);
  assert.equal(booking.firstDifferentObservation.observedAt, changed.observedAt);
  assert.equal(booking.effective.reference, original.reference);
  assert.equal(booking.effective.observedAt, restored.observedAt);
  assert.equal(await appendWebsiteDeadline(order, changed), false);
  assert.deepEqual(await clocks(), [original.observedAt, changed.observedAt, restored.observedAt]);
  assert.deepEqual(await snapshot(), revised);
  const { data } = await readReportingChanges({ after: String(base) });
  assert.deepEqual(data.map(({ eventType, subjectId, sourceVersion }) => [eventType, subjectId, sourceVersion]), [
    ['delivery.changed', String(order._id), base + 1], ['delivery.changed', String(order._id), base + 2],
  ]);
});
