import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertDateKeys, parseTruckoomAlertTime, normalizeGeofenceAlerts, evaluateTrackerVisit, recordProofReceipt } from './truckoomVisitRules.js';
import Delivery from '../models/Delivery.js';

const start = new Date('2026-10-21T20:00:00Z');
const end = new Date('2026-10-22T20:00:00Z');
const at = time => new Date(`2026-10-22T${time}Z`);
const events = [{ flag: 'entry', at: at('04:00:00') }, { flag: 'exit', at: at('04:10:00') }];
const evaluate = (photo = '04:05:00', overrides = {}) => evaluateTrackerVisit({ events,
  photoCapturedAt: at(photo), photoSource: 'camera', start, end, ...overrides });

test('Truckoom alert timestamps are UTC and Dubai midnight needs two UTC days', () => {
  assert.equal(parseTruckoomAlertTime('22-10-2026 04:10:20').toISOString(), '2026-10-22T04:10:20.000Z');
  assert.equal(parseTruckoomAlertTime('31-02-2026 04:10:20'), null);
  assert.equal(parseTruckoomAlertTime('2026-10-22 04:10:20'), null);
  assert.deepEqual(alertDateKeys(start, end), ['21-10-2026', '22-10-2026']);
});

test('normalizes alerts with the actual Truckoom response field names', () => {
  const result = normalizeGeofenceAlerts([{ vehicle_no: ' 86397 ', geofence_data: [
    { geofence_alarm_time: '22-10-2026 04:00:00', geofence_name: 'Customer', geofence_entry_exit_flag: 'entry' },
    { geofence_alarm_time: 'bad', geofence_entry_exit_flag: 'exit' },
  ] }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].vehicleNo, '86397');
  assert.equal(result[0].name, 'Customer');
  assert.throws(() => normalizeGeofenceAlerts({ result: 0 }));
});

test('photo inside a complete visit passes, including either boundary', () => {
  for (const time of ['04:00:00', '04:05:00', '04:10:00']) {
    const result = evaluate(time);
    assert.equal(result.status, 'inside_window');
    assert.equal(result.needsReview, false);
    assert.equal(+result.arrivedAt, +events[0].at);
    assert.equal(+result.departedAt, +events[1].at);
  }
});

test('photos before arrival and after departure are flagged for review', () => {
  for (const time of ['03:59:59', '04:10:01']) {
    assert.equal(evaluate(time).status, 'outside_window');
    assert.equal(evaluate(time).needsReview, true);
  }
});

test('missing, duplicated and out-of-order events never manufacture a violation', () => {
  assert.equal(evaluate('04:05:00', { events: [] }).status, 'awaiting_events');
  assert.equal(evaluate('04:05:00', { events: events.slice(0, 1) }).status, 'pending_exit');
  assert.equal(evaluate('04:05:00', { events: events.slice(1) }).status, 'incomplete_events');
  assert.equal(evaluate('04:05:00', { events: [...events, ...events].reverse() }).status, 'inside_window');
  assert.equal(evaluate('04:05:00', { events: [events[0], { flag: 'entry', at: at('04:01:00') }, events[1]] }).status, 'incomplete_events');
});

test('pairs multiple visits and waits for an open later visit', () => {
  const second = [{ flag: 'entry', at: at('05:00:00') }, { flag: 'exit', at: at('05:10:00') }];
  const result = evaluate('05:05:00', { events: [...events, ...second] });
  assert.equal(result.status, 'inside_window');
  assert.equal(+result.arrivedAt, +second[0].at);
  const open = evaluate('05:05:00', { events: [...events, second[0]] });
  assert.equal(open.status, 'pending_exit');
  assert.equal(open.departedAt, null);
});

test('gallery uploads and legacy proofs cannot pass as camera evidence', () => {
  assert.equal(evaluate('04:05:00', { photoSource: 'upload' }).status, 'uploaded_photo');
  assert.equal(evaluate('04:05:00', { photoSource: 'unknown' }).status, 'missing_photo_time');
  assert.equal(evaluate('04:05:00', { photoCapturedAt: undefined }).status, 'missing_photo_time');
});

test('offline photo capture time survives a later server receipt', async () => {
  const d = new Delivery({ customerId: 'C1', customerName: 'Customer', scheduledTime: start,
    gpsLocation: { lat: 25.1, lng: 55.2 }, proof: { photoUrl: '/proof.jpg' },
    trackerVisit: { vehicleNo: 'V1', status: 'inside_window', needsReview: false } });
  recordProofReceipt(d, { photoCapturedAt: at('04:05:00').toISOString(), photoSource: 'camera' }, at('06:00:00'));
  await d.validate();
  assert.equal(+d.proof.photoCapturedAt, +at('04:05:00'));
  assert.equal(+d.proof.receivedAt, +at('06:00:00'));
  assert.equal(d.trackerVisit.vehicleNo, 'V1');
  assert.equal(d.trackerVisit.status, 'awaiting_events');
  assert.equal(evaluate('04:05:00', { photoCapturedAt: d.proof.photoCapturedAt }).status, 'inside_window');
});

test('invalid, timezone-free or future capture times remain unverified', () => {
  for (const value of ['invalid', '2026-10-22T04:05:00', '2026-10-23T04:05:00Z']) {
    const d = { proof: { photoUrl: '/proof.jpg' } };
    recordProofReceipt(d, { photoCapturedAt: value, photoSource: 'camera' }, at('06:00:00'));
    assert.equal(d.proof.photoCapturedAt, undefined);
  }
});

test('editing proof notes does not erase recorded shutter evidence', () => {
  const capturedAt = at('04:05:00');
  const d = { proof: { photoUrl: '/proof.jpg', photoCapturedAt: capturedAt, photoSource: 'camera' },
    trackerVisit: { status: 'inside_window' } };
  recordProofReceipt(d, { notes: 'Updated note' }, at('06:00:00'));
  assert.equal(d.proof.photoCapturedAt, capturedAt);
  assert.equal(d.trackerVisit.status, 'inside_window');
});

test('first photo after assignment invalidates the earlier unassigned tracker snapshot', () => {
  const d = { driver: 'driver1', gpsLocation: { lat: 25.1, lng: 55.2 },
    proof: { photoUrl: '/photo.jpg' }, trackerVisit: { geofenceId: 'G1', driverId: '', lat: 25.1, lng: 55.2 } };
  recordProofReceipt(d, { photoSource: 'camera', photoCapturedAt: at('04:05:00').toISOString() }, at('04:06:00'));
  assert.equal(d.trackerVisit, undefined);
});

test('legacy completion preserves the address pin and records the driver separately', async () => {
  const d = new Delivery({ customerId: 'C1', customerName: 'Customer', scheduledTime: start,
    gpsLocation: { lat: 25.1, lng: 55.2 } });
  d.save = async () => d;
  await d.updateStatus('delivered', 'Done', { latitude: 25.3, longitude: 55.4 });
  assert.equal(d.gpsLocation.lat, 25.1);
  assert.equal(d.proof.location.lat, 25.3);
});
