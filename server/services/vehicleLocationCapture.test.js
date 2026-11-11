import test from 'node:test';import assert from 'node:assert/strict';
import {buildVehicleLocationSamples,createVehicleLocationRecorder} from './vehicleLocationCapture.js';
const at='2026-11-10T08:00:00.000Z',id='a'.repeat(24),vehicle={vehicleNo:'V1',latitude:25,longitude:55,gpsTime:'2026-11-10T06:00:00.000Z',trackerServerTime:'2026-11-10T07:59:50.000Z',rawGpsTime:'10-11-2026 10:00:00',speedKph:0,ignition:'OFF',trackerStatus:'STOP',locationSource:'truckoom_live_data'},drivers=[{_id:id,profile:{truckoomVehicleNo:'V1'}}];
test('preserves repeat raw observations, original clocks and zero-speed metadata; stale fix is flagged',()=>{const a=buildVehicleLocationSamples({fleet:[vehicle],drivers,recordedAt:at}),b=buildVehicleLocationSamples({fleet:[vehicle],drivers,recordedAt:'2026-11-10T08:01:00Z'});assert.equal(a.rows.length,1);assert.equal(b.rows.length,1);assert.equal(a.rows[0].speedKph,0);assert.equal(a.rows[0].gpsTime.toISOString(),vehicle.gpsTime);assert.equal(a.rows[0].trackerServerTime.toISOString(),vehicle.trackerServerTime);assert.equal(a.rows[0].rawGpsTime,vehicle.rawGpsTime);assert.ok(a.rows[0].qualityFlags.includes('last_known_fix_older_than_5m'));assert.equal(a.rows[0].driverMappingState,'current_mapping_snapshot');assert.equal(a.rows[0].fixAgeMs,7200000);});
test('null fix clocks stay null and future clocks remain separate from receipt time',()=>{const {rows}=buildVehicleLocationSamples({fleet:[{...vehicle,gpsTime:null},{...vehicle,gpsTime:'2026-11-10T09:00:00Z'}],drivers,recordedAt:at});assert.equal(rows[0].gpsTime,null);assert.ok(rows[0].qualityFlags.includes('missing_fix_clock'));assert.ok(rows[1].qualityFlags.includes('future_fix_clock'));});
test('ambiguous driver mapping keeps all candidates and does not select the last user',()=>{const {rows}=buildVehicleLocationSamples({fleet:[vehicle],drivers:[...drivers,{_id:'b'.repeat(24),profile:{truckoomVehicleNo:'V1'}}],recordedAt:at});assert.equal(rows[0].driver,null);assert.equal(rows[0].driverCandidates.length,2);assert.ok(rows[0].qualityFlags.includes('ambiguous_driver_mapping'));});
test('invalid and missing coordinates remain explicit observations',()=>{const {rows,summary}=buildVehicleLocationSamples({fleet:[{...vehicle,latitude:0,longitude:0},{...vehicle,latitude:null}],drivers,recordedAt:at});assert.equal(rows.length,2);assert.equal(summary.rejectedRows,0);assert.equal(summary.unusablePositionRows,2);assert.equal(rows[1].latitude,null);assert.ok(rows[0].qualityFlags.includes('invalid_coordinates'));});
test('overlap is blocked and failed inserts do not prevent a later successful poll',async()=>{let unblock,read=0,fail=true;const recorder=createVehicleLocationRecorder({isConfigured:()=>true,getFleet:async()=>{read++;if(read===1)await new Promise(r=>{unblock=r;});return[vehicle];},getDrivers:async()=>drivers,insertRows:async()=>{if(fail)throw Error('storage');},clock:()=>new Date(at)});const first=recorder();assert.equal((await recorder()).status,'already-running');unblock();assert.equal((await first).status,'failed');fail=false;assert.equal((await recorder()).status,'complete');assert.equal(read,2);});
test('disabled source makes no upstream call and logging failures cannot undo a stored capture',async()=>{const recorder=createVehicleLocationRecorder({isConfigured:()=>false,getFleet:()=>{throw Error('must not call');}});assert.equal((await recorder()).status,'not-configured');const enabled=createVehicleLocationRecorder({isConfigured:()=>true,getFleet:async()=>[vehicle],getDrivers:async()=>drivers,insertRows:async()=>{},clock:()=>new Date(at),onResult:()=>{throw Error('logging');}});assert.equal((await enabled()).status,'complete');});

test('saved model preserves additive capture fields and accepts old records without them',async()=>{const {default:History}=await import('../models/VehicleLocationHistory.js');const {rows}=buildVehicleLocationSamples({fleet:[vehicle],drivers,recordedAt:at});const doc=new History(rows[0]);await doc.validate();const saved=doc.toObject();assert.equal(saved.speedKph,0);assert.equal(saved.rawGpsTime,vehicle.rawGpsTime);assert.equal(saved.trackerServerTime.toISOString(),vehicle.trackerServerTime);assert.equal(saved.driverCandidates[0].toString(),id);const legacy=new History({vehicleNo:'V1',latitude:25,longitude:55,gpsTime:null,recordedAt:new Date(at)});await legacy.validate();assert.equal(legacy.gpsTime,null);assert.equal(legacy.trackerServerTime,undefined);});

test('real live normalization retains unusable observations through model casting', async () => {
  const { normalizeTruckoomLiveData } = await import('./truckoomLiveData.js');
  const { default: History } = await import('../models/VehicleLocationHistory.js');
  const fleet = normalizeTruckoomLiveData({ root: { VehicleData: [
    { Company: 'Fixture', Vehicle_No: 'V1', Latitude: '100', Longitude: '55', GPSActualTime: '10-11-2026 11:00:00' },
    { Company: 'Fixture', Vehicle_No: 'V1', Latitude: null, Longitude: '55', GPSActualTime: '10-11-2026 11:01:00' },
  ] } }, 'Fixture');
  const result = buildVehicleLocationSamples({ fleet, drivers, recordedAt: at });
  assert.equal(result.rows.length, 2); assert.equal(result.summary.unusablePositionRows, 2);
  for (const row of result.rows) { const doc = new History(row); await doc.validate(); assert.ok(doc.qualityFlags.length); }
  assert.equal(result.rows[0].latitude, 100); assert.equal(result.rows[1].latitude, null);
});

test('failed assignment lookup retains GPS with explicit unavailable mapping', async () => {
  let rows;
  const recorder = createVehicleLocationRecorder({ isConfigured: () => true, getFleet: async () => [vehicle],
    getDrivers: async () => { throw Error('fixture lookup failure'); }, insertRows: async value => { rows = value; }, clock: () => new Date(at) });
  const result = await recorder(); assert.equal(result.status, 'complete'); assert.equal(result.mappingAvailable, false);
  assert.equal(rows[0].driver, null); assert.equal(rows[0].driverMappingState, 'unavailable');
});

test('unarchived live views cannot be acknowledged as captured evidence', async () => {
  const fleet = [vehicle]; Object.defineProperty(fleet, 'captureEvidenceStatus', { value: 'unavailable' });
  let writes = 0;
  const recorder = createVehicleLocationRecorder({ isConfigured: () => true, getFleet: async () => fleet,
    getDrivers: async () => drivers, insertRows: async () => { writes++; }, clock: () => new Date(at) });
  assert.equal((await recorder()).status, 'failed'); assert.equal(writes, 0);
});

test('cached fleet sampled after a future fix retains the original receipt-time failure', async () => {
  const { evaluateGpsVisit } = await import('./trackerGpsVisits.js');
  const { default: History } = await import('../models/VehicleLocationHistory.js');
  const sourceReceipt = { receiptId: 'synthetic-receipt', responseReceivedAt: '2026-11-10T07:00:00Z' };
  const gpsTime = '2026-11-10T07:01:00Z';
  const result = buildVehicleLocationSamples({ fleet: [{ ...vehicle, gpsTime, sourceReceipt }], drivers, recordedAt: at });
  assert.equal(result.summary.futureClock, 1);
  assert.ok(result.rows[0].qualityFlags.includes('future_fix_clock'));
  const saved = new History(result.rows[0]); await saved.validate();
  const evaluation = evaluateGpsVisit({ points: [saved.toObject()], pin: { lat: 25, lng: 55 },
    photoSource: 'camera', photoCapturedAt: gpsTime, asOf: at,
    start: new Date('2026-11-09T20:00:00Z'), end: new Date('2026-11-10T20:00:00Z') });
  assert.equal(evaluation.status, 'incomplete_events');
  assert.ok(evaluation.gpsQualityReasons.includes('future_fix_time'));
});
