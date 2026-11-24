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
