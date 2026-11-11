import { test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import truckoom from './truckoomApiService.js';
import truckoomHistory from './truckoomHistoryService.js';
import Delivery from '../models/Delivery.js';
import CustomerGeofence from '../models/CustomerGeofence.js';
import TrackerSyncLease from '../models/TrackerSyncLease.js';
import TrackerGeofenceEvent from '../models/TrackerGeofenceEvent.js';
import VehicleLocationHistory from '../models/VehicleLocationHistory.js';
import { customerFenceIdentity, syncCustomerTrackerVisits } from './truckoomVisitSync.js';
import { getBusinessDayBounds } from '../utils/businessDate.js';

function setup(t, overrides = {}) {
  // Noon Dubai keeps the 05:00 entry and 05:10 exit in the past on every run.
  const now = new Date('2026-11-06T08:00:00.000Z');
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
  const fence = { ...identity, truckoomId: 'G1', lat: 25.1, lng: 55.2, radiusMetres: 60 };
  const writes = [];
  const dates = [];
  t.mock.method(truckoom, 'isConfigured', () => true);
  t.mock.method(truckoomHistory, 'getPoints', async () => []);
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
  const oldCompany=truckoom.companyName;
  truckoom.companyName='Fixture Company';
  t.after(()=>{truckoom.companyName=oldCompany;});
  const stamp=value=>{
    const wall=new Date(+value+240*60000);
    const hour=wall.getUTCHours();
    return `${wall.toISOString().slice(0,10).split('-').reverse().join('-')} ${String(hour%12||12).padStart(2,'0')}:${wall.toISOString().slice(14,19)} ${hour<12?'AM':'PM'}`;
  };
  const eventRows=[
    {company:'Fixture Company',vehicle_no:'V1',alert_type:'Enter In Geofence',alert_info:`Enter In Geofence - ${identity.name}`,alert_generation:stamp(entry)},
    {company:'Fixture Company',vehicle_no:'V1',alert_type:'Out Of Geofence',alert_info:`Out Of Geofence - ${identity.name}`,alert_generation:stamp(exit)},
  ];
  t.mock.method(truckoom, 'getAlertData', async (from,to) => {
    dates.push({from,to});
    return eventRows;
  });
  return { now, row, writes, dates, identity, fence, eventRows };
}

test('sync stores tracker, shutter and departure evidence and checks both UTC days', async t => {
  const fixture = setup(t);
  const result = await syncCustomerTrackerVisits({ now: fixture.now });
  assert.equal(result.checked, 1);
  assert.equal(fixture.dates.length, 2);
  assert.ok(fixture.dates.every(({from,to})=>Number.isSafeInteger(from)&&Number.isSafeInteger(to)&&to-from<86400000));
  assert.equal(TrackerGeofenceEvent.bulkWrite.mock.calls[0].arguments[0][0].updateOne.update.$setOnInsert.source,'truckoom_alert_data');
  const { filter, update } = fixture.writes[0];
  assert.equal(+filter.updatedAt, +fixture.row.updatedAt);
  assert.equal(update.$set.trackerVisit.status, 'inside_window');
  assert.equal(update.$set.trackerVisit.vehicleNo, 'V1');
  assert.equal(update.$set.trackerVisit.radiusMetres, 60);
});

test('wrong vehicle or geofence alerts never verify a photo', async t => {
  const fixture = setup(t);
  t.mock.method(truckoom, 'getAlertData', async () => fixture.eventRows.map(row=>({...row,vehicle_no:'another-vehicle'})));
  await syncCustomerTrackerVisits({ now: fixture.now });
  assert.equal(fixture.writes[0].update.$set.trackerVisit.status, 'awaiting_events');
});

test('an invalid saved radius cannot silently become a default GPS match', async t => {
  const fixture = setup(t);
  fixture.fence.radiusMetres = 0;
  t.mock.method(truckoom, 'getAlertData', async () => []);
  t.mock.method(truckoomHistory, 'getPoints', async () => [{
    latitude: 25.1, longitude: 55.2, gpsTime: fixture.row.proof.photoCapturedAt,
  }]);
  await syncCustomerTrackerVisits({ now: fixture.now });
  const visit = fixture.writes[0].update.$set.trackerVisit;
  assert.equal(visit.radiusMetres, 0);
  assert.equal(visit.status, 'incomplete_events');
  assert.deepEqual(visit.gpsQualityReasons, ['invalid_radius']);
  assert.equal(visit.needsReview, false);
});

test('API failure is unverified and the worker lease is released', async t => {
  const fixture = setup(t);
  t.mock.method(truckoom, 'getAlertData', async () => { throw new Error('Unavailable'); });
  await syncCustomerTrackerVisits({ now: fixture.now });
  assert.equal(fixture.writes[0].update.$set.trackerVisit.status, 'tracker_error');
  assert.equal(fixture.writes[0].update.$set.trackerVisit.needsReview, false);
  assert.equal(TrackerSyncLease.deleteOne.mock.callCount(), 1);
});

test('an assigned delivery without a photo is awaiting capture even when alert reads fail',async t=>{
  const fixture=setup(t,{status:'assigned',proof:{}});
  t.mock.method(truckoom,'getAlertData',async()=>{throw Object.assign(new Error('timeout'),{code:'ECONNABORTED'});});
  await syncCustomerTrackerVisits({now:fixture.now});
  const visit=fixture.writes[0].update.$set.trackerVisit;
  assert.equal(visit.status,'missing_photo_time');
  assert.equal(visit.errorCode,'ECONNABORTED');
  assert.equal(visit.needsReview,false);
});
test('an internal GPS query failure is not reported as a Truckoom outage',async t=>{
  const fixture=setup(t);
  t.mock.method(truckoom,'getAlertData',async()=>[]);
  t.mock.method(VehicleLocationHistory,'find',()=>({select:()=>({lean:async()=>{throw new Error('database error');}})}));
  await syncCustomerTrackerVisits({now:fixture.now});
  const visit=fixture.writes[0].update.$set.trackerVisit;
  assert.equal(visit.status,'verification_error');
  assert.equal(visit.errorStage,'gps_history');
});

test('customer stops sharing a vehicle reuse resolved GPS data, not an already executed Mongoose query',async t=>{
  const fixture=setup(t);
  const second={...fixture.row,_id:'delivery2'};
  t.mock.method(Delivery,'find',()=>({populate:()=>({lean:async()=>[fixture.row,second]})}));
  t.mock.method(truckoom,'getAlertData',async()=>[]);
  let executions=0;
  t.mock.method(VehicleLocationHistory,'find',()=>({select:()=>({lean:()=>({then(resolve,reject){
    if(++executions>1)reject(new Error('Query was already executed'));
    else resolve([]);
  }})})}));
  await syncCustomerTrackerVisits({now:fixture.now});
  assert.equal(executions,1);
  assert.equal(fixture.writes.length,2);
  assert.ok(fixture.writes.every(w=>w.update.$set.trackerVisit.status==='awaiting_events'));
});
test('a transient alert transport failure is retried once and empty valid responses are accepted',async t=>{
  const service=new truckoom.constructor();
  let calls=0;
  t.mock.method(service,'assertConfigured',()=>{});
  t.mock.method(axios,'get',async()=>{
    if(++calls===1)throw Object.assign(new Error('timeout'),{code:'ETIMEDOUT'});
    return {data:[]};
  });
  assert.deepEqual(await service.getGeofenceAlerts('26-10-2026'),[]);
  assert.equal(calls,2);
});
test('unauthorized alert reads are not blindly retried',async t=>{
  const service=new truckoom.constructor();
  t.mock.method(service,'assertConfigured',()=>{});
  t.mock.method(axios,'get',async()=>{throw Object.assign(new Error('unauthorized'),{response:{status:401}});});
  await assert.rejects(()=>service.getGeofenceAlerts('26-10-2026'));
  assert.equal(axios.get.mock.callCount(),1);
});

test('a busy PM2 lease prevents all remote calls and writes', async t => {
  const fixture = setup(t);
  t.mock.method(TrackerSyncLease, 'findOneAndUpdate', async () => { throw Object.assign(new Error('duplicate'), { code: 11000 }); });
  assert.deepEqual(await syncCustomerTrackerVisits({ now: fixture.now }), { busy: true });
  assert.equal(fixture.writes.length, 0);
  assert.equal(truckoom.getAlertData.mock.callCount(), 0);
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
  t.mock.method(truckoom, 'createCustomerGeofence', async (name, pin, radius) => {
    assert.equal(radius, 60);
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

test('yesterday offline photo reconciles archived and delayed alerts after remote fence removal', async t => {
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
  assert.equal(truckoom.getAlertData.mock.callCount(), 2);
});

test('saved snapshot survives a later driver reassignment', async t => {
  const fixture = setup(t);
  fixture.row.trackerVisit = { geofenceId: 'G1', geofenceName: fixture.identity.name,
    vehicleNo: 'V1', driverId: 'driver1', lat: 25.1, lng: 55.2, radiusMetres: 50 };
  fixture.row.driver = { _id: 'driver2', profile: { truckoomVehicleNo: 'V2' } };
  await syncCustomerTrackerVisits({ now: fixture.now });
  assert.equal(fixture.writes[0].update.$set.trackerVisit.vehicleNo, 'V1');
  assert.equal(fixture.writes[0].update.$set.trackerVisit.radiusMetres, 50); // preserve the original proof snapshot
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
  const points = [[-60000,25.11],[0,25.1],[60000,25.1],[300000,25.1],[540000,25.1],[600000,25.11]].map(([offset,lat]) => ({
    latitude:lat,longitude:55.2,driver:'driver1',gpsTime:new Date(base+offset),recordedAt:new Date(base+offset),
  }));
  t.mock.method(truckoom,'getAlertData',async()=>[]);
  t.mock.method(VehicleLocationHistory,'find',()=>({select:()=>({lean:async()=>points})}));
  await syncCustomerTrackerVisits({now:fixture.now});
  const visit=fixture.writes[0].update.$set.trackerVisit;
  assert.equal(visit.status,'gps_visit_observed');
  assert.equal(visit.evidenceSource,'truckoom_gps_samples');
  assert.equal(+visit.arrivedAt,base);
  assert.equal(+visit.departedAt,base+600000);
  assert.equal(fixture.row.status,undefined); // geofence evidence never marks delivery complete
});

test('token authentication, private list filtering and 60 m creation match the supplied API', async t => {
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
  assert.equal(calls[2].body.radius, '0.06');
  await truckoom.deleteCustomerGeofence('3');
  assert.ok(calls[3].url.endsWith('?token=deletGeofence'));
  assert.deepEqual(calls[3].body, { project_id: '49', geofence_id: '3' });
});


test('historical vendor GPS fills visits missing from local recording and is shared across customer stops', async t => {
  const fixture = setup(t);
  t.mock.method(truckoom, 'getAlertData', async () => []);
  const start = getBusinessDayBounds(fixture.now).startOfDay;
  const at = minutes => new Date(+start + minutes * 60000);
  t.mock.method(Delivery, 'find', () => ({populate: () => ({lean: async () => [fixture.row, {...fixture.row, _id: 'second'}]})}));
  t.mock.method(truckoomHistory, 'getPoints', async vehicle => {
    assert.equal(vehicle, 'V1');
    return [{latitude:25.1,longitude:55.2,gpsTime:at(300)},
      {latitude:25.1,longitude:55.2,gpsTime:at(305)}, {latitude:25.2,longitude:55.2,gpsTime:at(310)}];
  });
  await syncCustomerTrackerVisits({now:fixture.now});
  assert.equal(truckoomHistory.getPoints.mock.callCount(),1);
  for (const write of fixture.writes) {
    const visit = write.update.$set.trackerVisit;
    assert.equal(visit.status, 'gps_visit_observed');
    assert.equal(visit.evidenceSource, 'truckoom_gps_samples');
    assert.equal(+visit.arrivedAt,+at(300));
    assert.equal(+visit.departedAt,+at(310));
  }
});

test('history transport failure preserves locally sampled GPS and never becomes confirmed alert evidence', async t => {
  const fixture = setup(t);
  t.mock.method(truckoom, 'getAlertData', async () => []);
  t.mock.method(truckoomHistory, 'getPoints', async () => {throw new Error('timeout');});
  const start = getBusinessDayBounds(fixture.now).startOfDay;
  t.mock.method(VehicleLocationHistory, 'find', () => ({select: () => ({lean: async () => [
    {driver:'driver1',latitude:25.1,longitude:55.2,gpsTime:new Date(+start+300*60000)},
    {driver:'driver1',latitude:25.1,longitude:55.2,gpsTime:new Date(+start+305*60000)},
    {driver:'driver1',latitude:25.2,longitude:55.2,gpsTime:new Date(+start+310*60000)},
  ]})}));
  await syncCustomerTrackerVisits({now:fixture.now});
  assert.equal(fixture.writes[0].update.$set.trackerVisit.status,'gps_visit_observed');
});


test('cached historical GPS does not hide a later locally recorded customer visit', async t => {
  const fixture = setup(t);
  t.mock.method(truckoom, 'getAlertData', async () => []);
  const start = getBusinessDayBounds(fixture.now).startOfDay;
  const at = minutes => new Date(+start + minutes * 60000);
  t.mock.method(truckoomHistory,'getPoints',async()=>[
    {latitude:25.2,longitude:55.2,gpsTime:at(100)},
  ]);
  t.mock.method(VehicleLocationHistory,'find',()=>({select:()=>({lean:async()=>[
    {driver:'driver1',latitude:25.1,longitude:55.2,gpsTime:at(300)},
    {driver:'driver1',latitude:25.1,longitude:55.2,gpsTime:at(305)},
    {driver:'driver1',latitude:25.2,longitude:55.2,gpsTime:at(310)},
  ]})}));
  await syncCustomerTrackerVisits({now:fixture.now});
  const visit=fixture.writes[0].update.$set.trackerVisit;
  assert.equal(visit.status,'gps_visit_observed');
  assert.equal(+visit.arrivedAt,+at(300));
});


test('reused kitchen alert text still matches an exact managed geofence and vehicle',async t=>{
 const fixture=setup(t);
 t.mock.method(truckoom,'getAlertData',async()=>fixture.eventRows.map(row=>({...row,
   alert_info:`Vehicle left Matter Kitchen - Al Quoz. - ${fixture.identity.name}`})));
 await syncCustomerTrackerVisits({now:fixture.now});
 const visit=fixture.writes[0].update.$set.trackerVisit;
 assert.equal(visit.status,'inside_window');
 assert.equal(visit.evidenceSource,'truckoom_alerts');
 assert.equal(truckoomHistory.getPoints.mock.callCount(),0);
});

test('an alert for another daily geofence on the same vehicle cannot verify this delivery',async t=>{
 const fixture=setup(t);
 const other=`MATTER-${fixture.identity.businessDate.replaceAll('-','')}-${'f'.repeat(24)}`;
 t.mock.method(truckoom,'getAlertData',async()=>fixture.eventRows.map(row=>({...row,alert_info:other})));
 await syncCustomerTrackerVisits({now:fixture.now});
 assert.equal(fixture.writes[0].update.$set.trackerVisit.status,'awaiting_events');
});

test('the worker does not request future UTC windows at Dubai midnight',async t=>{
 const fixture=setup(t);
 const {startOfDay}=getBusinessDayBounds(fixture.now);
 const now=new Date(+startOfDay+10*60000);
 await syncCustomerTrackerVisits({now});
 assert.equal(fixture.dates.length,1);
 assert.ok(fixture.dates.every(({to})=>to<+now));
});

function gpsOnly(t, fixture, points) {
  t.mock.method(truckoom, 'getAlertData', async () => []);
  t.mock.method(VehicleLocationHistory, 'find', () => ({select: () => ({lean: async () => points})}));
}

test('full sync keeps receipt-only GPS untimed and preserves the original GPS verdict once', async t => {
  const fixture = setup(t);
  const start = getBusinessDayBounds(fixture.now).startOfDay;
  const at = minutes => new Date(+start + minutes * 60000);
  const previous = { geofenceId:'G1',geofenceName:fixture.identity.name,businessDate:fixture.identity.businessDate,
    vehicleNo:'V1',driverId:'driver1',lat:25.1,lng:55.2,radiusMetres:60,
    evidenceSource:'truckoom_gps_samples',status:'gps_visit_observed',arrivedAt:at(300),departedAt:at(310) };
  fixture.row.trackerVisit = previous;
  gpsOnly(t, fixture, [
    {driver:'driver1',latitude:25.1,longitude:55.2,gpsTime:null,recordedAt:at(300)},
    {driver:'driver1',latitude:25.2,longitude:55.2,gpsTime:null,recordedAt:at(310)},
  ]);
  await syncCustomerTrackerVisits({now:fixture.now});
  const corrected = fixture.writes[0].update.$set.trackerVisit;
  assert.equal(corrected.status,'incomplete_events');
  assert.equal(corrected.gpsMethod,'gps-observations-v2');
  assert.equal(corrected.arrivedAt,null);
  assert.equal(corrected.departedAt,null);
  const baseline=fixture.writes[0].update.$set.trackerVisitGpsBaseline;
  assert.deepEqual(baseline.evidence,previous);
  assert.equal(+fixture.writes[0].filter.updatedAt,+fixture.row.updatedAt);
  fixture.row.trackerVisit = corrected;
  fixture.row.trackerVisitGpsBaseline = baseline;
  await syncCustomerTrackerVisits({now:fixture.now});
  assert.equal(fixture.writes[1].update.$set.trackerVisitGpsBaseline,undefined);
  assert.deepEqual(fixture.row.trackerVisitGpsBaseline.evidence,previous);
});

test('full sync cannot verify a photo inside a long GPS observation gap', async t => {
  const fixture=setup(t),start=getBusinessDayBounds(fixture.now).startOfDay;
  gpsOnly(t,fixture,[
    {driver:'driver1',latitude:25.1,longitude:55.2,gpsTime:new Date(+start+300*60000)},
    {driver:'driver1',latitude:25.2,longitude:55.2,gpsTime:new Date(+start+310*60000)},
  ]);
  await syncCustomerTrackerVisits({now:fixture.now});
  const visit=fixture.writes[0].update.$set.trackerVisit;
  assert.equal(visit.status,'incomplete_events');
  assert.equal(visit.needsReview,false);
  assert.ok(visit.gpsQualityReasons.includes('observation_gap'));
});

test('full sync preserves an ambiguous candidate for the frozen driver as uncertainty', async t => {
  const fixture=setup(t),start=getBusinessDayBounds(fixture.now).startOfDay;
  gpsOnly(t,fixture,[{driver:null,driverCandidates:['driver1','driver2'],driverMappingState:'ambiguous_current_mapping',
    latitude:25.1,longitude:55.2,gpsTime:new Date(+start+305*60000)}]);
  await syncCustomerTrackerVisits({now:fixture.now});
  const visit=fixture.writes[0].update.$set.trackerVisit;
  assert.equal(visit.status,'incomplete_events');
  assert.ok(visit.gpsQualityReasons.includes('ambiguous_driver_mapping'));
});

for (const mapping of [
  { driver: null, driverMappingState: 'unavailable' },
  { driver: null, driverMappingState: 'unmapped' },
  { driver: 'driver2', driverMappingState: 'current_mapping_snapshot' },
]) test(`same-vehicle ${mapping.driverMappingState} assignment cannot disappear inside a GPS bracket (${mapping.driver})`, async t => {
  const fixture = setup(t), start = getBusinessDayBounds(fixture.now).startOfDay;
  const position = minute => ({ driver: 'driver1', latitude: 25.1, longitude: 55.2,
    gpsTime: new Date(+start + minute * 60000) });
  gpsOnly(t, fixture, [position(304), { ...position(305), ...mapping }, position(306)]);
  await syncCustomerTrackerVisits({ now: fixture.now });
  const visit = fixture.writes[0].update.$set.trackerVisit;
  assert.equal(visit.status, 'incomplete_events');
  assert.ok(visit.gpsQualityReasons.includes('unmatched_driver_mapping'));
  assert.equal(visit.needsReview, false);
});

test('full sync uses original source receipt when a fleet fix is sampled later', async t => {
  const fixture = setup(t), photo = fixture.row.proof.photoCapturedAt;
  gpsOnly(t, fixture, [{ driver: 'driver1', latitude: 25.1, longitude: 55.2, gpsTime: photo,
    recordedAt: fixture.now, sourceReceipt: { responseReceivedAt: new Date(+photo - 60000).toISOString() } }]);
  await syncCustomerTrackerVisits({ now: fixture.now });
  const visit = fixture.writes[0].update.$set.trackerVisit;
  assert.equal(visit.status, 'incomplete_events');
  assert.ok(visit.gpsQualityReasons.includes('future_fix_time'));
  assert.ok(VehicleLocationHistory.find.mock.calls[0]);
});

test('conflicting cached and sampled fixes cannot silently select a convenient position', async t => {
  const fixture=setup(t),start=getBusinessDayBounds(fixture.now).startOfDay;
  const gpsTime=new Date(+start+305*60000);
  gpsOnly(t,fixture,[{driver:'driver1',latitude:25.1,longitude:55.2,gpsTime}]);
  t.mock.method(truckoomHistory,'getPoints',async()=>[{latitude:25.2,longitude:55.2,gpsTime}]);
  await syncCustomerTrackerVisits({now:fixture.now});
  const visit=fixture.writes[0].update.$set.trackerVisit;
  assert.equal(visit.status,'incomplete_events');
  assert.ok(visit.gpsQualityReasons.includes('conflicting_coordinates'));
});

test('a failure during the first migration refresh still retains the previous GPS evidence', async t => {
  const fixture=setup(t);
  fixture.row.trackerVisit={geofenceId:'G1',geofenceName:fixture.identity.name,businessDate:fixture.identity.businessDate,
    vehicleNo:'V1',driverId:'driver1',lat:25.1,lng:55.2,evidenceSource:'truckoom_gps_samples',status:'gps_visit_observed'};
  const previous={...fixture.row.trackerVisit};
  t.mock.method(TrackerGeofenceEvent,'find',()=>({lean:async()=>{throw new Error('archive unavailable');}}));
  await syncCustomerTrackerVisits({now:fixture.now});
  const visit=fixture.writes[0].update.$set.trackerVisit;
  assert.equal(visit.status,'verification_error');
  assert.deepEqual(fixture.writes[0].update.$set.trackerVisitGpsBaseline.evidence,previous);
});

test('GPS method and prior evidence survive model casting without changing real geofence fields', async t => {
  const fixture=setup(t);
  const evidence={evidenceSource:'truckoom_gps_samples',status:'gps_visit_observed'};
  const doc=new Delivery({trackerVisit:{status:'incomplete_events',gpsMethod:'gps-observations-v2',
    gpsQualityReasons:['observation_gap']},trackerVisitGpsBaseline:{recordedAt:fixture.now,evidence}});
  const saved=doc.toObject().trackerVisit;
  assert.equal(saved.gpsMethod,'gps-observations-v2');
  assert.deepEqual(saved.gpsQualityReasons,['observation_gap']);
  assert.deepEqual(doc.toObject().trackerVisitGpsBaseline.evidence,evidence);
});

for (const rejection of ['invalid coordinates','missing GPS clock']) {
  test(`history normalization preserves ${rejection} through full photo comparison`, async t => {
    const fixture=setup(t);
    t.mock.method(truckoom,'getAlertData',async()=>[]);
    const { normalizeTrackLogs }=await import('./truckoomHistoryService.js');
    const {startOfDay:start,endOfDayExclusive:end}=getBusinessDayBounds(fixture.now);
    const row={vehicleNumber:'V1',latitude:25.1,longitude:55.2};
    const invalid=rejection==='invalid coordinates'
      ? {...row,latitude:999,timestamp:'06-11-2026 05:05:00 AM'}
      : {...row,timestamp:'unavailable'};
    const normalized=normalizeTrackLogs([
      {...row,timestamp:'06-11-2026 05:04:00 AM'},invalid,
      {...row,timestamp:'06-11-2026 05:06:00 AM'},
    ],'V1',start,end);
    assert.equal(normalized.qualityObservations.length,1);
    t.mock.method(truckoomHistory,'getPoints',async()=>[...normalized,...normalized.qualityObservations]);
    await syncCustomerTrackerVisits({now:fixture.now});
    const visit=fixture.writes[0].update.$set.trackerVisit;
    assert.equal(visit.status,'incomplete_events');
    assert.equal(visit.needsReview,false);
    assert.equal(visit.arrivedAt,null);
    assert.equal(visit.departedAt,null);
    assert.ok(visit.gpsQualityReasons.includes(rejection==='invalid coordinates'?'invalid_coordinates':'missing_or_invalid_fix_time'));
  });
}
