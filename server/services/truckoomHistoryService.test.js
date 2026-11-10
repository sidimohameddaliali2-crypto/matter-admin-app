import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTrackLogTime, normalizeTrackLogs, getHistoryPoints} from './truckoomHistoryService.js';
import TruckoomTrackHistory from '../models/TruckoomTrackHistory.js';
import TrackerSyncLease from '../models/TrackerSyncLease.js';
import truckoom from './truckoomApiService.js';
import axios from 'axios';
import { evaluateGpsVisit } from './trackerGpsVisits.js';

const start=new Date('2026-10-27T20:00:00Z'),end=new Date('2026-10-28T20:00:00Z');
const now=new Date('2026-10-29T06:00:00Z');
const row={vehicleNumber:'71592',latitude:25.1,longitude:55.2,timestamp:'28-10-2026 01:30:00 AM'};
function setup(t, cached=null) {
  const writes=[];
  t.mock.method(Date,'now',()=>+now);
  t.mock.method(TruckoomTrackHistory,'findById',()=>({lean:async()=>cached}));
  t.mock.method(TruckoomTrackHistory,'updateOne',async(filter,update)=>{writes.push({filter,update});});
  t.mock.method(TrackerSyncLease,'findOneAndUpdate',async(filter,update)=>({owner:update.$set.owner}));
  t.mock.method(TrackerSyncLease,'updateOne',async()=>({matchedCount:1}));
  t.mock.method(truckoom,'getVehicleTrackLogs',async(vehicle,startDate,endDate,options)=>{
    await options.beforeDispatch({end_date:endDate});
    return [row];
  });
  return writes;
}

test('historical GPS parses UAE 12-hour timestamps including midnight and noon',()=>{
  assert.equal(parseTrackLogTime('28-10-2026 12:39:01 AM').toISOString(),'2026-10-27T20:39:01.000Z');
  assert.equal(parseTrackLogTime('28-10-2026 12:39:01 PM').toISOString(),'2026-10-28T08:39:01.000Z');
  assert.equal(parseTrackLogTime('31-02-2026 01:30:00 AM'),null);
  assert.equal(parseTrackLogTime('28-10-2026 00:30:00 AM'),null);
});

test('history rejects another vehicle, invalid pins and other days, and deduplicates points',()=>{
  const result=normalizeTrackLogs([row,row,{...row,vehicleNumber:'OTHER'}, {...row,latitude:91},
    {...row,timestamp:'27-10-2026 01:30:00 AM'}, {...row,latitude:null}], '71592',start,end);
  assert.equal(result.length,1);
  assert.equal(result[0].gpsTime.toISOString(),'2026-10-27T21:30:00.000Z');
  assert.throws(()=>normalizeTrackLogs({},'71592',start,end));
});

test('history uses UAE request dates, reserves shared rate slot, and caches normalized evidence',async t=>{
  const writes=setup(t);
  const points=await getHistoryPoints('71592',start,end,now);
  assert.equal(points.length,1);
  assert.deepEqual(truckoom.getVehicleTrackLogs.mock.calls[0].arguments.slice(0,3),['71592','2026-10-28 00:00:00','2026-10-28 23:59:59']);
  const [filter,update]=TrackerSyncLease.findOneAndUpdate.mock.calls[0].arguments;
  assert.equal(filter._id,'truckoom-track-logs');
  assert.equal(+update.$set.expiresAt-+now,300000);
  assert.equal(+TrackerSyncLease.updateOne.mock.calls.at(-1).arguments[1].$set.expiresAt-+now,180000);
  assert.equal(writes.length,1);
});

test('fresh shared cache avoids another API call',async t=>{
  setup(t,{fetchedAt:now,points:[row]});
  assert.deepEqual(await getHistoryPoints('71592',start,end,now),[row]);
  assert.equal(truckoom.getVehicleTrackLogs.mock.callCount(),0);
  assert.equal(TrackerSyncLease.findOneAndUpdate.mock.callCount(),0);
});

test('another worker rate reservation defers history without losing stale cached evidence',async t=>{
  setup(t,{fetchedAt:start,points:[row]});
  t.mock.method(TrackerSyncLease,'findOneAndUpdate',async()=>{throw Object.assign(new Error('busy'),{code:11000});});
  assert.deepEqual(await getHistoryPoints('71592',start,end,now),[row]);
  assert.equal(truckoom.getVehicleTrackLogs.mock.callCount(),0);
});

test('vendor failure retains rate reservation and does not cache a false empty success',async t=>{
  const writes=setup(t);
  t.mock.method(truckoom,'getVehicleTrackLogs',async()=>{throw new Error('unavailable');});
  assert.deepEqual(await getHistoryPoints('71592',start,end,now),[]);
  assert.equal(writes.length,0);
  assert.equal(TrackerSyncLease.findOneAndUpdate.mock.callCount(),1);
});

test('future business days never request history',async t=>{
  setup(t);
  assert.deepEqual(await getHistoryPoints('71592',start,end,new Date(+start-1000)),[]);
  assert.equal(truckoom.getVehicleTrackLogs.mock.callCount(),0);
});

test('a partial snapshot keeps its one-hour lifetime after Dubai midnight',async t=>{
  const fetchedAt=new Date(+end-30*60000);
  const afterMidnight=new Date(+end+31*60000);
  const writes=setup(t,{fetchedAt,points:[]});
  t.mock.method(Date,'now',()=>+afterMidnight);
  const points=await getHistoryPoints('71592',start,end,afterMidnight);
  assert.equal(truckoom.getVehicleTrackLogs.mock.callCount(),1);
  assert.equal(points.length,1);
  assert.equal(+writes[0].update.$set.fetchedAt,+afterMidnight);
});

test('a snapshot fetched after the day closes retains the longer lifetime',async t=>{
  const fetchedAt=new Date(+end+10*60000);
  const later=new Date(+end+2*60*60000);
  setup(t,{fetchedAt,points:[row]});
  t.mock.method(Date,'now',()=>+later);
  assert.deepEqual(await getHistoryPoints('71592',start,end,later),[row]);
  assert.equal(truckoom.getVehicleTrackLogs.mock.callCount(),0);
});

test('a delayed sync reserves three minutes from acquisition and records the actual request time',async t=>{
  const writes=setup(t);
  const cycleStart=new Date(+end-5*60000);
  const actualRequest=new Date(+end+3*60000);
  // Simulate earlier sync work and the cache read delaying this API request
  // across midnight, beyond the entire original three-minute reservation.
  t.mock.method(TruckoomTrackHistory,'findById',()=>({lean:async()=>{
    t.mock.method(Date,'now',()=>+actualRequest);
    return null;
  }}));
  await getHistoryPoints('71592',start,end,cycleStart);
  const [filter,update]=TrackerSyncLease.findOneAndUpdate.mock.calls[0].arguments;
  assert.equal(+filter.$or[0].expiresAt.$lte,+actualRequest);
  assert.equal(+update.$set.expiresAt,+actualRequest+300000);
  assert.equal(+writes[0].update.$set.fetchedAt,+actualRequest);
  assert.equal(truckoom.getVehicleTrackLogs.mock.calls[0].arguments[2],'2026-10-28 23:59:59');
});


function realDispatchFixture(t, {authFails=false, vendorFails=false, acquisitionDelay=0, initialTime=+now}={}) {
  const writes=setup(t);
  let time=initialTime, lease=null, authCalls=0;
  const dispatches=[],bodies=[];
  t.mock.method(Date,'now',()=>time);
  t.mock.method(TrackerSyncLease,'findOneAndUpdate',async(_filter,update)=>{
    if(lease && +lease.expiresAt>time)throw Object.assign(new Error('busy'),{code:11000});
    time+=acquisitionDelay;
    lease={...update.$set};
    return {...lease};
  });
  t.mock.method(TrackerSyncLease,'updateOne',async(filter,update)=>{
    if(lease?.owner!==filter.owner || (filter.expiresAt && +lease.expiresAt<=+filter.expiresAt.$gt))return {matchedCount:0};
    lease={...lease,...update.$set};
    return {matchedCount:1};
  });
  const service=new truckoom.constructor();
  service.retainGpsResponse=async()=>({receiptId:'history-fixture',kind:'history',sha256:'a'.repeat(64),responseReceivedAt:new Date(Date.now()).toISOString()});
  Object.assign(service,{username:'fixture-user',password:'fixture-password',companyName:'Fixture Company'});
  t.mock.method(truckoom,'getVehicleTrackLogs',service.getVehicleTrackLogs.bind(service));
  t.mock.method(axios,'post',async(url,body)=>{
    if(url.includes('generateAccessToken')){
      authCalls++;time+=15000;
      if(authFails)throw new Error('auth timeout');
      return {data:{result:1,data:{token:'fixture-token'}}};
    }
    assert.ok(url.includes('getVehicleTrackLogs'));
    dispatches.push(time);bodies.push({...body});time+=5000;
    if(vendorFails)throw new Error('history timeout');
    return {data:{result:1,data:[{...row,vehicleNumber:body.vehicle_no}]}};
  });
  return {writes,dispatches,bodies,setTime:value=>{time=value;},get time(){return time;},get lease(){return lease;},get authCalls(){return authCalls;}};
}

for(const vendorFails of [false,true])test(`three-minute completion cooldown survives acquisition/auth delays (vendor failure: ${vendorFails})`,async t=>{
  const fixture=realDispatchFixture(t,{vendorFails,acquisitionDelay:15000});
  await getHistoryPoints('71592',start,end,now);
  assert.equal(fixture.dispatches.length,1);
  assert.equal(fixture.dispatches[0],+now+30000);
  const completion=fixture.time;
  assert.equal(+fixture.lease.expiresAt,completion+180000);
  fixture.setTime(fixture.dispatches[0]+179999);
  await getHistoryPoints('86801',start,end,new Date(fixture.time));
  assert.equal(fixture.dispatches.length,1,'another worker cannot dispatch early');
  fixture.setTime(completion+180000);
  await getHistoryPoints('86801',start,end,new Date(fixture.time));
  assert.equal(fixture.dispatches.length,2);
  assert.ok(fixture.dispatches[1]-fixture.dispatches[0]>=180000);
  if(vendorFails)assert.equal(fixture.writes.length,0);
});

test('authentication failure also holds a full cooldown after the failed attempt',async t=>{
  const fixture=realDispatchFixture(t,{authFails:true});
  await getHistoryPoints('71592',start,end,now);
  const completion=fixture.time;
  assert.equal(fixture.dispatches.length,0);
  assert.equal(fixture.authCalls,1);
  assert.equal(+fixture.lease.expiresAt,completion+180000);
  fixture.setTime(completion+179999);
  await getHistoryPoints('86801',start,end,new Date(fixture.time));
  assert.equal(fixture.authCalls,1);
  fixture.setTime(completion+180000);
  await getHistoryPoints('86801',start,end,new Date(fixture.time));
  assert.equal(fixture.authCalls,2);
});

test('lost ownership after authentication prevents the actual historical POST',async t=>{
  const fixture=realDispatchFixture(t);
  t.mock.method(TrackerSyncLease,'updateOne',async()=>({matchedCount:0}));
  assert.deepEqual(await getHistoryPoints('71592',start,end,now),[]);
  assert.equal(fixture.authCalls,1);
  assert.equal(fixture.dispatches.length,0);
  assert.equal(fixture.writes.length,0);
});

test('a slow reservation renewal cannot dispatch with less than three minutes remaining',async t=>{
  const fixture=realDispatchFixture(t);
  t.mock.method(TrackerSyncLease,'updateOne',async filter=>{
    if(filter.expiresAt)fixture.setTime(fixture.time+120001);
    return {matchedCount:1};
  });
  assert.deepEqual(await getHistoryPoints('71592',start,end,now),[]);
  assert.equal(fixture.dispatches.length,0);
});

test('authentication crossing midnight refreshes request bounds before caching a closed-day snapshot',async t=>{
  const cycleStart=new Date(+end-5000);
  const fixture=realDispatchFixture(t,{initialTime:+cycleStart});
  await getHistoryPoints('71592',start,end,cycleStart);
  assert.equal(fixture.bodies[0].end_date,'2026-10-28 23:59:59');
  assert.equal(+fixture.writes[0].update.$set.fetchedAt,+end+10000);
});

test('history persists and returns unusable observations alongside clean cache points', async t => {
  const writes = setup(t);
  t.mock.method(truckoom, 'getVehicleTrackLogs', async () => [row, { ...row, latitude: null }, { ...row, timestamp: null }]);
  const result = await getHistoryPoints('71592', start, end, now);
  assert.equal(result.length, 3); assert.equal(writes[0].update.$set.qualityObservations.length, 2);
  assert.equal(result.filter(p => p.gpsTime === null).length, 1);
});

test('fresh cached quality markers survive readback and empty refresh preserves earlier evidence', async t => {
  const marker = { latitude: null, longitude: 55, gpsTime: null };
  setup(t, { fetchedAt: now, points: [row], qualityObservations: [marker] });
  assert.deepEqual(await getHistoryPoints('71592', start, end, now), [row, marker]);
  assert.equal(truckoom.getVehicleTrackLogs.mock.callCount(), 0);
});

test('empty valid response does not erase an earlier nonempty cache', async t => {
  const writes = setup(t, { fetchedAt: start, points: [row] });
  t.mock.method(truckoom, 'getVehicleTrackLogs', async () => []);
  assert.deepEqual(await getHistoryPoints('71592', start, end, now), [row]);
  assert.equal(writes[0].update.$set.lastRefreshOutcome, 'empty_preserved');
  assert.equal('points' in writes[0].update.$set, false);
});

test('a history fix future at original receipt stays unusable after persistence and later cache evaluation', async t => {
  setup(t);
  const receipt = new Date('2026-10-28T05:00:00Z');
  const photo = new Date('2026-10-28T05:01:00Z');
  const later = new Date('2026-10-28T05:10:00Z');
  let cached = null;
  t.mock.method(Date, 'now', () => +receipt);
  t.mock.method(TruckoomTrackHistory, 'findById', () => ({ lean: async () => cached }));
  t.mock.method(TruckoomTrackHistory, 'updateOne', async (filter, update) => {
    const doc = new TruckoomTrackHistory({ _id: filter._id, ...update.$set });
    await doc.validate();
    cached = doc.toObject();
  });
  t.mock.method(truckoom, 'getVehicleTrackLogs', async (_vehicle, _start, _end, options) => {
    await options.beforeDispatch({});
    const rows = [{ ...row, timestamp: '28-10-2026 09:01:00 AM' }];
    Object.defineProperty(rows, 'sourceReceipt', { value: { responseReceivedAt: receipt.toISOString() } });
    return rows;
  });
  const evaluate = (points, asOf) => evaluateGpsVisit({ points, asOf, start, end,
    pin: { lat: 25.1, lng: 55.2 }, photoSource: 'camera', photoCapturedAt: photo });
  const fresh = await getHistoryPoints('71592', start, end, receipt);
  assert.equal(+fresh[0].recordedAt, +receipt);
  assert.equal(evaluate(fresh, receipt).status, 'incomplete_events');
  t.mock.method(Date, 'now', () => +later);
  const reread = await getHistoryPoints('71592', start, end, later);
  assert.equal(truckoom.getVehicleTrackLogs.mock.callCount(), 1);
  assert.equal(+reread[0].recordedAt, +receipt);
  const result = evaluate(reread, later);
  assert.equal(result.status, 'incomplete_events');
  assert.ok(result.gpsQualityReasons.includes('future_fix_time'));
});

test('legacy history with no response receipt stays uncertain without inventing a clock', async t => {
  const gpsTime = new Date('2026-10-27T21:30:00Z');
  setup(t, { fetchedAt: now, points: [{ latitude: 25.1, longitude: 55.2, gpsTime }] });
  const points = await getHistoryPoints('71592', start, end, now);
  assert.equal(points[0].recordedAt, undefined);
  const result = evaluateGpsVisit({ points, asOf: now, start, end, pin: { lat: 25.1, lng: 55.2 },
    photoSource: 'camera', photoCapturedAt: gpsTime });
  assert.equal(result.status, 'incomplete_events');
  assert.ok(result.gpsQualityReasons.includes('missing_observation_receipt'));
});
