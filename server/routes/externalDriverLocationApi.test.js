import test from 'node:test';
import assert from 'node:assert/strict';
import router from './externalDriverLocationApi.js';
import VehicleLocationHistory from '../models/VehicleLocationHistory.js';
import User from '../models/User.js';
import truckoom from '../services/truckoomApiService.js';

const driver='6909ca5c18d53863aab8471b';
function setup(t, rows=[], total=rows.length) {
  const oldKeys=process.env.DELIVERY_API_KEYS, oldKey=process.env.DELIVERY_API_KEY;
  process.env.DELIVERY_API_KEYS='fixture:fixture-key';delete process.env.DELIVERY_API_KEY;
  t.after(()=>{
    if(oldKeys===undefined)delete process.env.DELIVERY_API_KEYS;else process.env.DELIVERY_API_KEYS=oldKeys;
    if(oldKey===undefined)delete process.env.DELIVERY_API_KEY;else process.env.DELIVERY_API_KEY=oldKey;
  });
  const calls={};
  t.mock.method(VehicleLocationHistory,'find',filter=>{
    calls.filter=filter;
    const chain={sort:value=>(calls.sort=value,chain),skip:value=>(calls.skip=value,chain),
      limit:value=>(calls.limit=value,chain),select:()=>chain,lean:async()=>rows};
    return chain;
  });
  t.mock.method(VehicleLocationHistory,'countDocuments',async filter=>{calls.countFilter=filter;return total;});
  t.mock.method(User,'find',()=>{throw new Error('Must not remap historical driver');});
  t.mock.method(truckoom,'getFleetStatus',()=>{throw new Error('Must not call Truckoom');});
  return calls;
}
function request(query, key='fixture-key') {
  return new Promise((resolve,reject)=>{
    const req={method:'GET',url:'/locations/history',query,headers:key?{'x-api-key':key}:{}};
    const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){resolve({status:this.statusCode,body});}};
    router.handle(req,res,error=>reject(error||new Error('Route not handled')));
  });
}

test('history fails closed before reading GPS for missing or wrong API keys',async t=>{
  setup(t);
  for(const key of [null,'wrong'])assert.equal((await request({vehicleNo:'71592',date:'2026-11-01'},key)).status,401);
  process.env.DELIVERY_API_KEYS='';
  assert.equal((await request({vehicleNo:'71592',date:'2026-11-01'})).status,503);
  assert.equal(VehicleLocationHistory.find.mock.callCount(),0);
});

test('history date selects the Dubai day, returns UTC times and preserves saved driver identity',async t=>{
  const calls=setup(t,[{_id:'point1',vehicleNo:'71592',driver,latitude:25.1,longitude:55.2,
    gpsTime:new Date('2026-10-31T21:00:00Z'),recordedAt:new Date('2026-10-31T21:00:30Z')}]);
  const response=await request({vehicleNo:'71592',date:'2026-11-01'});
  assert.equal(response.status,200);
  assert.equal(calls.filter.recordedAt.$gte.toISOString(),'2026-10-31T20:00:00.000Z');
  assert.equal(calls.filter.recordedAt.$lt.toISOString(),'2026-11-01T20:00:00.000Z');
  assert.deepEqual(calls.countFilter,calls.filter);
  assert.deepEqual(response.body.data[0].location,{lat:25.1,lng:55.2});
  assert.equal(response.body.data[0].driverId,driver);
  assert.equal(response.body.data[0].source,'server_recorded_gps');
  assert.equal('capture' in response.body.data[0],false);
  assert.equal(User.find.mock.callCount(),0);
  assert.equal(truckoom.getFleetStatus.mock.callCount(),0);
});

test('history filters by recorded driver across vehicle reassignments and paginates deterministically',async t=>{
  const calls=setup(t,[],2050);
  const response=await request({driverId:driver,dateFrom:'2026-10-30',dateTo:'2026-11-02',page:'3',limit:'1000'});
  assert.equal(response.status,200);
  assert.equal(calls.filter.driver,driver);
  assert.equal(calls.filter.vehicleNo,undefined);
  assert.deepEqual(calls.sort,{recordedAt:1,_id:1});
  assert.equal(calls.skip,2000);
  assert.equal(calls.limit,1000);
  assert.deepEqual(response.body.pagination,{page:3,limit:1000,total:2050,pages:3});
});

test('exact ISO ranges retain timezone and include the requested final instant',async t=>{
  const calls=setup(t);
  const response=await request({vehicleNo:' 71592 ',driverId:driver,
    dateFrom:'2026-11-01T01:00:00+04:00',dateTo:'2026-11-01T02:00:00+04:00'});
  assert.equal(response.status,200);
  assert.equal(calls.filter.vehicleNo,'71592');
  assert.equal(calls.filter.driver,driver);
  assert.equal(calls.filter.recordedAt.$gte.toISOString(),'2026-10-31T21:00:00.000Z');
  assert.equal(calls.filter.recordedAt.$lt.toISOString(),'2026-10-31T22:00:00.001Z');
});

test('invalid identifiers, malformed dates, unbounded ranges and invalid pagination never read GPS',async t=>{
  setup(t);
  const valid={vehicleNo:'71592',date:'2026-11-01'};
  for(const query of [
    {date:'2026-11-01'}, {...valid,vehicleNo:{$ne:null}}, {...valid,driverId:'bad'},
    {...valid,date:'2026-02-30'}, {...valid,dateFrom:'2026-11-01'},
    {vehicleNo:'71592'}, {vehicleNo:'71592',dateFrom:'2026-11-01'},
    {vehicleNo:'71592',dateFrom:'2026-10-01',dateTo:'2026-11-01'},
    {vehicleNo:'71592',dateFrom:'2026-11-02',dateTo:'2026-11-01'},
    {vehicleNo:'71592',dateFrom:'2026-11-01T01:00:00',dateTo:'2026-11-01T02:00:00'},
    {...valid,page:'0'}, {...valid,limit:'1001'}, {...valid,page:['1','2']},
  ])assert.equal((await request(query)).status,400,JSON.stringify(query));
  assert.equal(VehicleLocationHistory.find.mock.callCount(),0);
});

test('empty history is an empty successful response rather than an invented trail',async t=>{
  setup(t);
  const response=await request({vehicleNo:'71592',date:'2026-11-01'});
  assert.equal(response.status,200);
  assert.deepEqual(response.body.data,[]);
  assert.equal(response.body.pagination.total,0);
});

test('invalid stored coordinates are not exposed as a real GPS fix',async t=>{
  setup(t,[{_id:'bad',vehicleNo:'71592',driver:null,latitude:0,longitude:0,recordedAt:new Date()}]);
  const response=await request({vehicleNo:'71592',date:'2026-11-01'});
  assert.equal(response.body.data[0].location,null);
  assert.equal(response.body.data[0].driverId,null);
  assert.equal(response.body.data[0].gpsTime,null);
});

test('database failures return a safe error without leaking credentials or connection details',async t=>{
  setup(t);
  t.mock.method(VehicleLocationHistory,'countDocuments',async()=>{throw new Error('private connection details');});
  const response=await request({vehicleNo:'71592',date:'2026-11-01'});
  assert.equal(response.status,500);
  assert.equal(response.body.message,'Failed to fetch recorded GPS history');
});

test('new capture metadata is optional, keeps all clocks distinct and never remaps driver identity',async t=>{
 setup(t,[{_id:'point-metadata',vehicleNo:'71592',driver:null,latitude:25,longitude:55,gpsTime:new Date('2026-11-01T01:00:00Z'),recordedAt:new Date('2026-11-01T02:00:00Z'),trackerServerTime:new Date('2026-11-01T01:59:50Z'),rawGpsTime:'01-11-2026 05:00:00',speedKph:0,trackerStatus:'STOP',driverMappingState:'ambiguous_current_mapping',driverCandidates:[driver],qualityFlags:['last_known_fix_older_than_5m'],fixAgeMs:3600000}]);
 const response=await request({vehicleNo:'71592',date:'2026-11-01'});assert.equal(response.status,200);const p=response.body.data[0];assert.equal(p.driverId,null);assert.equal(new Date(p.gpsTime).toISOString(),'2026-11-01T01:00:00.000Z');assert.equal(new Date(p.recordedAt).toISOString(),'2026-11-01T02:00:00.000Z');assert.equal(new Date(p.capture.trackerServerTime).toISOString(),'2026-11-01T01:59:50.000Z');assert.equal(p.capture.speedKph,0);assert.equal(p.capture.physicalDriverIdentityConfirmed,false);assert.equal(User.find.mock.callCount(),0);assert.equal(truckoom.getFleetStatus.mock.callCount(),0);
});

test('saved export preserves receipt and batch references without exposing raw payload', async t => {
  setup(t, [{ _id: 'fixture', vehicleNo: 'V1', latitude: null, longitude: null, captureBatchId: 'batch', captureRow: 2,
    sourceReceipt: { receiptId: 'receipt', sha256: 'a'.repeat(64), kind: 'live', responseReceivedAt: '2026-01-01T00:00:00Z', payload: 'private-payload' }, sourceRow: 3 }]);
  const result = await request({ vehicleNo: 'V1', date: '2026-01-01' }); const p = result.body.data[0];
  assert.equal(p.location, null); assert.equal(p.capture.batchId, 'batch'); assert.equal(p.capture.batchRow, 2); assert.equal(p.capture.sourceRow, 3);
  assert.equal(p.capture.sourceReceipt.receiptId, 'receipt'); assert.ok(!JSON.stringify(result).includes('private-payload'));
});

test('capture health distinguishes saved batches from full-day position coverage', async t => {
  setup(t); const { default: Batch } = await import('../models/VehicleLocationCaptureBatch.js');
  const q = { sort: () => q, limit: () => q, select: fields => { assert.equal(fields, 'tickAt state payload.summary failureCode'); return q; }, lean: async () => [
    { state: 'complete', payload: { summary: { storedRows: 2, unusablePositionRows: 1, missingFixClock: 1, mappingAvailable: false } } },
    { state: 'pending', failureCode: 'CAPTURE_FAILED' }, { state: 'failed', failureCode: 'GPS_ARCHIVE_UNAVAILABLE' },
  ] };
  t.mock.method(Batch, 'find', () => q);
  const call = key => new Promise((resolve, reject) => router.handle({ method: 'GET', url: '/locations/capture-status', query: { date: '2026-01-01' }, headers: key ? { 'x-api-key': key } : {} }, { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { resolve({ status: this.statusCode, body }); } }, reject));
  assert.equal((await call(null)).status, 401); assert.equal(Batch.find.mock.callCount(), 0);
  const { body } = await call('fixture-key'); assert.equal(body.data.states.pending, 1); assert.equal(body.data.states.failed, 1);
  assert.equal(body.data.totals.storedRows, 2); assert.equal(body.data.completeDayVerified, false); assert.equal(body.data.expectedFleetVerified, false);
});

test('external live API preserves conflicting mappings as unknown', async t => {
  t.mock.method(User, 'find', () => ({ select: () => ({ lean: async () => [
    { _id: 'a'.repeat(24), profile: { truckoomVehicleNo: 'V1' } }, { _id: 'b'.repeat(24), profile: { truckoomVehicleNo: 'V1' } },
  ] }) }));
  t.mock.method(truckoom, 'getFleetStatus', async () => [{ vehicleNo: 'V1', latitude: 25, longitude: 55 }]);
  const handler = router.stack.find(layer => layer.route?.path === '/locations').route.stack.at(-1).handle;
  let body; await handler({}, { json: value => { body = value; } });
  assert.equal(body.data[0].driver, null); assert.equal(body.data[0].driverMappingState, 'ambiguous_current_mapping');
});
