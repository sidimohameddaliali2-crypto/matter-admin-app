import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTrackLogTime, normalizeTrackLogs, getHistoryPoints} from './truckoomHistoryService.js';
import TruckoomTrackHistory from '../models/TruckoomTrackHistory.js';
import TrackerSyncLease from '../models/TrackerSyncLease.js';
import truckoom from './truckoomApiService.js';

const start=new Date('2026-10-27T20:00:00Z'),end=new Date('2026-10-28T20:00:00Z');
const now=new Date('2026-10-29T06:00:00Z');
const row={vehicleNumber:'71592',latitude:25.1,longitude:55.2,timestamp:'28-10-2026 01:30:00 AM'};
function setup(t, cached=null) {
  const writes=[];
  t.mock.method(Date,'now',()=>+now);
  t.mock.method(TruckoomTrackHistory,'findById',()=>({lean:async()=>cached}));
  t.mock.method(TruckoomTrackHistory,'updateOne',async(filter,update)=>{writes.push({filter,update});});
  t.mock.method(TrackerSyncLease,'findOneAndUpdate',async(filter,update)=>({owner:update.$set.owner}));
  t.mock.method(truckoom,'getVehicleTrackLogs',async()=>[row]);
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
  assert.deepEqual(truckoom.getVehicleTrackLogs.mock.calls[0].arguments,['71592','2026-10-28 00:00:00','2026-10-28 23:59:59']);
  const [filter,update]=TrackerSyncLease.findOneAndUpdate.mock.calls[0].arguments;
  assert.equal(filter._id,'truckoom-track-logs');
  assert.equal(+update.$set.expiresAt-+now,180000);
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
  assert.equal(+update.$set.expiresAt,+actualRequest+180000);
  assert.equal(+writes[0].update.$set.fetchedAt,+actualRequest);
  assert.equal(truckoom.getVehicleTrackLogs.mock.calls[0].arguments[2],'2026-10-28 23:59:59');
});
