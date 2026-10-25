import { test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import truckoom from './truckoomApiService.js';
import Delivery from '../models/Delivery.js';
import CustomerGeofence from '../models/CustomerGeofence.js';
import TrackerSyncLease from '../models/TrackerSyncLease.js';
import TrackerGeofenceEvent from '../models/TrackerGeofenceEvent.js';
import VehicleLocationHistory from '../models/VehicleLocationHistory.js';
import { customerFenceIdentity, syncCustomerTrackerVisits } from './truckoomVisitSync.js';
import { getBusinessDayBounds } from '../utils/businessDate.js';

function setup(t, overrides = {}) {
  const now = new Date();
  const { startOfDay } = getBusinessDayBounds(now);
  const entry = new Date(+startOfDay + 5 * 60 * 60000);
  const exit = new Date(+entry + 10 * 60000);
  const photo = new Date(+entry + 5 * 60000);
  const row = { _id: 'delivery1', updatedAt: now, customerId: 'C1', address: 'Customer address',
    scheduledTime: new Date(+startOfDay + 8 * 60 * 60000), type: 'Delivery',
    driver: { _id: 'driver1', profile: { truckoomVehicleNo: 'V1' } },
    gpsLocation: { lat: 25.1, lng: 55.2 }, proof: { photoCapturedAt: photo, photoSource: 'camera', receivedAt: now },
    ...overrides };
  const identity = customerFenceIdentity(row, row.gpsLocation);
  const fence = { ...identity, truckoomId: 'G1', lat: 25.1, lng: 55.2, radiusMetres: 50 };
  const writes = [];
  const dates = [];
  t.mock.method(truckoom, 'isConfigured', () => true);
  t.mock.method(TrackerSyncLease, 'findOneAndUpdate', async (_filter, update) => ({ owner: update.$set.owner }));
  t.mock.method(TrackerSyncLease, 'updateOne', async () => ({ matchedCount: 1 }));
  t.mock.method(TrackerSyncLease, 'deleteOne', async () => ({}));
  t.mock.method(Delivery, 'find', () => ({ populate: () => ({ lean: async () => [row] }) }));
  t.mock.method(Delivery, 'updateOne', async (filter, update) => { writes.push({ filter, update }); return { modifiedCount: 1 }; });
  t.mock.method(CustomerGeofence, 'findOne', () => ({ lean: async () => fence }));
  t.mock.method(CustomerGeofence, 'find', () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }));
  t.mock.method(TrackerGeofenceEvent, 'bulkWrite', async () => ({}));
  t.mock.method(TrackerGeofenceEvent, 'find', () => ({ lean: async () => [] }));
  t.mock.method(VehicleLocationHistory, 'find', () => ({ select: () => ({ lean: async () => [] }) }));
  const stamp = value => value.toISOString().slice(0, 19).replace('T', ' ').replace(/^(\d{4})-(\d{2})-(\d{2})/, '$3-$2-$1');
  t.mock.method(truckoom, 'getGeofenceAlerts', async date => {
    dates.push(date);
    return [{ vehicle_no: 'V1', geofence_data: [
      { geofence_name: identity.name, geofence_alarm_time: stamp(entry), geofence_entry_exit_flag: 'entry' },
      { geofence_name: identity.name, geofence_alarm_time: stamp(exit), geofence_entry_exit_flag: 'exit' },
    ] }];
  });
  return { now, row, writes, dates, identity, fence };
}

test('sync stores tracker, shutter and departure evidence and checks both UTC days', async t => {
  const fixture = setup(t);
  const result = await syncCustomerTrackerVisits({ now: fixture.now });
  assert.equal(result.checked, 1);
  assert.equal(fixture.dates.length, 2);
  const { filter, update } = fixture.writes[0];
  assert.equal(+filter.updatedAt, +fixture.row.updatedAt);
  assert.equal(update.$set.trackerVisit.status, 'inside_window');
  assert.equal(update.$set.trackerVisit.vehicleNo, 'V1');
  assert.equal(update.$set.trackerVisit.radiusMetres, 50);
});

test('wrong vehicle or geofence alerts never verify a photo', async t => {
  const fixture = setup(t);
  t.mock.method(truckoom, 'getGeofenceAlerts', async () => [{ vehicle_no: 'another-vehicle', geofence_data: [] }]);
  await syncCustomerTrackerVisits({ now: fixture.now });
  assert.equal(fixture.writes[0].update.$set.trackerVisit.status, 'awaiting_events');
});

test('API failure is unverified and the worker lease is released', async t => {
  const fixture = setup(t);
  t.mock.method(truckoom, 'getGeofenceAlerts', async () => { throw new Error('Unavailable'); });
  await syncCustomerTrackerVisits({ now: fixture.now });
  assert.equal(fixture.writes[0].update.$set.trackerVisit.status, 'tracker_error');
  assert.equal(fixture.writes[0].update.$set.trackerVisit.needsReview, false);
  assert.equal(TrackerSyncLease.deleteOne.mock.callCount(), 1);
});

test('a busy PM2 lease prevents all remote calls and writes', async t => {
  const fixture = setup(t);
  t.mock.method(TrackerSyncLease, 'findOneAndUpdate', async () => { throw Object.assign(new Error('duplicate'), { code: 11000 }); });
  assert.deepEqual(await syncCustomerTrackerVisits({ now: fixture.now }), { busy: true });
  assert.equal(fixture.writes.length, 0);
  assert.equal(truckoom.getGeofenceAlerts.mock.callCount(), 0);
});

test('deterministic fence name recovers an existing remote fence without duplicate creation', async t => {
  const fixture = setup(t);
  t.mock.method(CustomerGeofence, 'findOne', () => ({ lean: async () => null }));
  t.mock.method(truckoom, 'getGeofences', async () => [{ 'Geofence name': fixture.identity.name, 'Geofence Id': 123 }]);
  t.mock.method(truckoom, 'createCustomerGeofence', async () => { throw new Error('Must not create'); });
  t.mock.method(CustomerGeofence, 'findOneAndUpdate', (_filter, update) => ({ lean: async () => update.$set }));
  await syncCustomerTrackerVisits({ now: fixture.now });
  assert.equal(truckoom.createCustomerGeofence.mock.callCount(), 0);
  assert.equal(fixture.writes[0].update.$set.trackerVisit.geofenceId, '123');
});

test('new saved customer pin creates one fence and persists its remote id', async t => {
  const fixture = setup(t);
  t.mock.method(CustomerGeofence, 'findOne', () => ({ lean: async () => null }));
  t.mock.method(truckoom, 'getGeofences', async () => []);
  t.mock.method(truckoom, 'createCustomerGeofence', async (name, pin) => {
    assert.equal(name, fixture.identity.name);
    assert.deepEqual(pin, { lat: 25.1, lng: 55.2 });
    return 'new-fence';
  });
  t.mock.method(CustomerGeofence, 'findOneAndUpdate', (_filter, update) => ({ lean: async () => update.$set }));
  const result = await syncCustomerTrackerVisits({ now: fixture.now });
  assert.equal(result.created, 1);
  assert.equal(truckoom.createCustomerGeofence.mock.callCount(), 1);
  assert.equal(fixture.writes[0].update.$set.trackerVisit.geofenceId, 'new-fence');
});

test('changing a customer pin makes a new identity without altering old visit evidence', t => {
  const fixture = setup(t);
  assert.notEqual(customerFenceIdentity(fixture.row, { lat: 25.2, lng: 55.2 }).key, fixture.identity.key);
});

test('the same customer pin receives a new geofence identity each Dubai day', t => {
  const fixture = setup(t);
  const tomorrow = { ...fixture.row, scheduledTime: new Date(+fixture.row.scheduledTime + 86400000) };
  const next = customerFenceIdentity(tomorrow, tomorrow.gpsLocation);
  assert.notEqual(next.key, fixture.identity.key);
  assert.notEqual(next.businessDate, fixture.identity.businessDate);
  assert.match(next.name, /^MATTER-\d{8}-[a-f0-9]{24}$/);
  const overnight = customerFenceIdentity({ ...fixture.row, scheduledTime: '2026-10-22T21:00:00Z' }, fixture.row.gpsLocation);
  assert.equal(overnight.businessDate, '2026-10-23');
});

test('tomorrow geofences are not uploaded until their Dubai business day begins', async t => {
  const fixture = setup(t);
  fixture.row.scheduledTime = new Date(+fixture.row.scheduledTime + 86400000);
  t.mock.method(CustomerGeofence, 'findOne', () => ({ lean: async () => null }));
  t.mock.method(truckoom, 'createCustomerGeofence', async () => { throw new Error('Must not create'); });
  const result = await syncCustomerTrackerVisits({ now: fixture.now });
  assert.equal(result.created, 0);
  assert.equal(truckoom.createCustomerGeofence.mock.callCount(), 0);
});

test('daily cleanup still runs on a day with no deliveries', async t => {
  const fixture = setup(t);
  const { startOfDay } = getBusinessDayBounds(fixture.now);
  const now = new Date(+startOfDay + 60 * 60000);
  const oldIdentity = customerFenceIdentity({ ...fixture.row, scheduledTime: new Date(+startOfDay - 86400000) }, fixture.row.gpsLocation);
  const old = { ...fixture.fence, ...oldIdentity, _id: 'old-local' };
  t.mock.method(Delivery, 'find', () => ({ populate: () => ({ lean: async () => [] }) }));
  t.mock.method(CustomerGeofence, 'find', () => ({ sort: () => ({ limit: () => ({ lean: async () => [old] }) }) }));
  t.mock.method(CustomerGeofence, 'updateOne', async () => ({}));
  t.mock.method(truckoom, 'getGeofences', async () => [{ 'Geofence Id': old.truckoomId, 'Geofence name': old.name }]);
  t.mock.method(truckoom, 'deleteCustomerGeofence', async () => {});
  const result = await syncCustomerTrackerVisits({ now });
  assert.equal(result.deleted, 1);
  assert.equal(fixture.writes.length, 0);
});

test('today pins are uploaded before a driver is assigned', async t => {
  const fixture = setup(t, { driver: null, proof: {} });
  await syncCustomerTrackerVisits({ now: fixture.now });
  const visit = fixture.writes[0].update.$set.trackerVisit;
  assert.equal(visit.geofenceId, 'G1');
  assert.equal(visit.status, 'no_tracker');
});

test('yesterday offline photo is checked against archived events after remote fence removal', async t => {
  const fixture = setup(t);
  const { startOfDay } = getBusinessDayBounds(fixture.now);
  const start = new Date(+startOfDay - 86400000);
  const entry = new Date(+start + 5 * 60 * 60000);
  const exit = new Date(+entry + 10 * 60000);
  fixture.row.scheduledTime = new Date(+start + 8 * 60 * 60000);
  fixture.row.proof.photoCapturedAt = new Date(+entry + 5 * 60000);
  const identity = customerFenceIdentity(fixture.row, fixture.row.gpsLocation);
  fixture.row.trackerVisit = { geofenceId: 'G1', geofenceName: identity.name, vehicleNo: 'V1' };
  t.mock.method(CustomerGeofence, 'findOne', () => ({ lean: async () => ({ ...identity, truckoomId: 'G1', deletedAt: fixture.now }) }));
  t.mock.method(TrackerGeofenceEvent, 'find', () => ({ lean: async () => [
    { name: identity.name, vehicleNo: 'V1', flag: 'entry', at: entry },
    { name: identity.name, vehicleNo: 'V1', flag: 'exit', at: exit },
  ] }));
  await syncCustomerTrackerVisits({ now: fixture.now });
  assert.equal(fixture.writes[0].update.$set.trackerVisit.status, 'inside_window');
  assert.equal(truckoom.getGeofenceAlerts.mock.callCount(), 0);
});

test('saved snapshot survives a later driver reassignment', async t => {
  const fixture = setup(t);
  fixture.row.trackerVisit = { geofenceId: 'G1', geofenceName: fixture.identity.name,
    vehicleNo: 'V1', driverId: 'driver1', lat: 25.1, lng: 55.2, radiusMetres: 50 };
  fixture.row.driver = { _id: 'driver2', profile: { truckoomVehicleNo: 'V2' } };
  await syncCustomerTrackerVisits({ now: fixture.now });
  assert.equal(fixture.writes[0].update.$set.trackerVisit.vehicleNo, 'V1');
  assert.equal(fixture.writes[0].update.$set.trackerVisit.status, 'inside_window');
});

test('a completed proof with no captured vehicle cannot borrow a later tracker mapping', async t => {
  const fixture = setup(t);
  fixture.row.trackerVisit = { geofenceId: 'G1', geofenceName: fixture.identity.name,
    businessDate: fixture.identity.businessDate, driverId: 'driver1' };
  await syncCustomerTrackerVisits({ now: fixture.now });
  const visit = fixture.writes[0].update.$set.trackerVisit;
  assert.equal(visit.status, 'no_tracker');
  assert.equal(visit.vehicleNo, undefined);
});

test('vehicle GPS supplies labelled visit evidence when the vendor supplies no customer alerts', async t => {
  const fixture = setup(t);
  const { startOfDay } = getBusinessDayBounds(fixture.now);
  const base = +startOfDay + 5*60*60000;
  const points = [[-60000,25.11],[0,25.1],[60000,25.1],[600000,25.11]].map(([offset,lat]) => ({
    latitude:lat,longitude:55.2,driver:'driver1',recordedAt:new Date(base+offset),
  }));
  t.mock.method(truckoom,'getGeofenceAlerts',async()=>[]);
  t.mock.method(VehicleLocationHistory,'find',()=>({select:()=>({lean:async()=>points})}));
  await syncCustomerTrackerVisits({now:fixture.now});
  const visit=fixture.writes[0].update.$set.trackerVisit;
  assert.equal(visit.status,'gps_visit_observed');
  assert.equal(visit.evidenceSource,'truckoom_gps_samples');
  assert.equal(+visit.arrivedAt,base);
  assert.equal(+visit.departedAt,base+600000);
  assert.equal(fixture.row.status,undefined); // geofence evidence never marks delivery complete
});

test('token authentication, private list filtering and 50 m creation match the supplied API', async t => {
  const original = { username: truckoom.username, password: truckoom.password, companyName: truckoom.companyName,
    accessToken: truckoom.accessToken, accessTokenExpiresAt: truckoom.accessTokenExpiresAt };
  t.after(() => Object.assign(truckoom, original));
  Object.assign(truckoom, { username: 'fixture', password: 'fixture', companyName: 'OUR COMPANY', accessToken: null });
  const calls = [];
  t.mock.method(axios, 'post', async (url, body, options) => {
    calls.push({ url, body, options });
    if (url.includes('generateAccessToken')) return { data: { result: 1, data: { token: 'fixture-token' } } };
    if (url.includes('getGeofenceList')) return { data: { result: 1, data: [
      { 'Company Name': 'OUR COMPANY', 'Geofence Id': 1 }, { 'Company Name': 'OTHER COMPANY', 'Geofence Id': 2 },
    ] } };
    return { data: { result: 1, data: { geofenceId: 3 } } };
  });
  assert.equal((await truckoom.getGeofences()).length, 1);
  assert.equal(await truckoom.createCustomerGeofence('Customer', { lat: 25.1, lng: 55.2 }), '3');
  assert.equal(calls.length, 3);
  assert.equal(calls[1].options.headers['auth-code'], 'fixture-token');
  assert.deepEqual(calls[2].body.coordinates, [[25.1, 55.2]]);
  assert.equal(calls[2].body.radius, '0.05');
  await truckoom.deleteCustomerGeofence('3');
  assert.ok(calls[3].url.endsWith('?token=deletGeofence'));
  assert.deepEqual(calls[3].body, { project_id: '49', geofence_id: '3' });
});
