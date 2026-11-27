import test from 'node:test';
import assert from 'node:assert/strict';
import deliveriesRouter from './deliveries.js';
import { serializeReportingDelivery } from './externalReportingApi.js';
import Delivery from '../models/Delivery.js';
import { recordProofReceipt } from '../services/truckoomVisitRules.js';

const protect = deliveriesRouter.stack.find(layer => layer.name === 'protectTrackerEvidence').handle;

test('all delivery request shapes protect the original tracker evidence and receipt clocks', () => {
  const req = { body: {
    trackerVisit: {status:'inside_window'}, trackerVisitGpsBaseline:{evidence:{status:'inside_window'}},
    'trackerVisitGpsBaseline.evidence': {}, 'trackerVisit.status':'inside_window',
    fleetProofReceipt: {actorId:'forged'}, 'fleetProofReceipt.actorId':'forged',
    proof:{receivedAt:'forged',photoCapturedAt:'2026-11-01T08:00:00Z',photoSource:'camera'},
    edits:[{trackerVisitGpsBaseline:{evidence:{}},notes:'Keep this note'}],
    gpsLocation:{lat:25,lng:55},
  } };
  let next=false;
  protect(req,{},()=>{next=true;});
  assert.equal(next,true);
  assert.deepEqual(req.body,{
    proof:{photoCapturedAt:'2026-11-01T08:00:00Z',photoSource:'camera'},
    edits:[{notes:'Keep this note'}],gpsLocation:{lat:25,lng:55},
  });
});

test('only the versioned delivery projection exposes the original authenticated completion actor', async () => {
  const actorId = 'a'.repeat(24), newDriverId = 'b'.repeat(24);
  const photographed = { photoUrl: '/fixture.jpg', photoCapturedAt: '2026-11-01T08:00:00Z', photoSource: 'camera',
    location: { lat: 25.1, lng: 55.1 } };
  const delivery = new Delivery({ customerId: 'fixture', customerName: 'Fixture', scheduledTime: '2026-11-01T07:00:00Z',
    driver: actorId, status: 'delivered', proof: photographed });
  recordProofReceipt(delivery, photographed, new Date('2026-11-01T08:01:00Z'), {
    actor: { _id: actorId, role: 'driver' }, handsetLocation: photographed.location,
  });
  await delivery.validate();
  assert.equal(Object.hasOwn(delivery.toObject(), 'fleetProofReceipt'), false);
  assert.equal(Object.hasOwn(delivery.toJSON(), 'fleetProofReceipt'), false);
  assert.equal(delivery.toObject().proof.location.lat, photographed.location.lat);

  const saved = delivery.toObject({ transform: false });
  const snapshot = serializeReportingDelivery({ ...saved, driver: { _id: newDriverId }, reportingVersion: 3 });
  assert.equal(snapshot.driver.id, newDriverId);
  assert.deepEqual(snapshot.fleetProof, { cameraReceiptBound: true, completionDriverId: actorId, handsetLocationBound: true });
});

test('proof invalidation cannot erase the preserved original GPS result', () => {
  const baseline={recordedAt:new Date('2026-11-01T09:00:00Z'),evidence:{status:'gps_visit_observed'}};
  const delivery={driver:'new-driver',proof:{photoUrl:'/fixture.jpg'},trackerVisitGpsBaseline:baseline,
    trackerVisit:{geofenceId:'fixture-fence',driverId:'old-driver',status:'gps_visit_observed'}};
  recordProofReceipt(delivery,{photoUrl:'/fixture.jpg',photoCapturedAt:'2026-11-01T08:00:00Z',photoSource:'camera'},new Date('2026-11-01T09:00:00Z'));
  assert.equal(delivery.trackerVisit,undefined);
  assert.deepEqual(delivery.trackerVisitGpsBaseline,baseline);
});
