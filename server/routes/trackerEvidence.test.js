import test from 'node:test';
import assert from 'node:assert/strict';
import deliveriesRouter from './deliveries.js';
import { recordProofReceipt } from '../services/truckoomVisitRules.js';

const protect = deliveriesRouter.stack.find(layer => layer.name === 'protectTrackerEvidence').handle;

test('all delivery request shapes protect the original tracker evidence and receipt clocks', () => {
  const req = { body: {
    trackerVisit: {status:'inside_window'}, trackerVisitGpsBaseline:{evidence:{status:'inside_window'}},
    'trackerVisitGpsBaseline.evidence': {}, 'trackerVisit.status':'inside_window',
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

test('proof invalidation cannot erase the preserved original GPS result', () => {
  const baseline={recordedAt:new Date('2026-11-01T09:00:00Z'),evidence:{status:'gps_visit_observed'}};
  const delivery={driver:'new-driver',proof:{photoUrl:'/fixture.jpg'},trackerVisitGpsBaseline:baseline,
    trackerVisit:{geofenceId:'fixture-fence',driverId:'old-driver',status:'gps_visit_observed'}};
  recordProofReceipt(delivery,{photoUrl:'/fixture.jpg',photoCapturedAt:'2026-11-01T08:00:00Z',photoSource:'camera'},new Date('2026-11-01T09:00:00Z'));
  assert.equal(delivery.trackerVisit,undefined);
  assert.deepEqual(delivery.trackerVisitGpsBaseline,baseline);
});
