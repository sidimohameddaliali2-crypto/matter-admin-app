import { test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { createTruckoomLiveCache, normalizeTruckoomLiveData, parseTruckoomGpsTime } from './truckoomLiveData.js';
import truckoom from './truckoomApiService.js';

const row = { Company: 'OURS', Vehicle_No: ' V1 ', Vehicle_Name: 'Vehicle', Imeino: '123',
  Latitude: '25.1', Longitude: '55.2', GPSActualTime: '23-10-2026 10:58:09',
  Datetime: '23-10-2026 10:58:12', Speed: '0', IGN: 'OFF', Status: 'STOP', Location: 'Saved tracker address' };
const payload = { root: { VehicleData: [row, { ...row, Company: 'OTHER' }] } };

test('parses real live-data envelope, filters company, preserves zero speed and converts UAE GPS time', () => {
  const rows = normalizeTruckoomLiveData(payload, 'OURS');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].vehicleNo, 'V1');
  assert.equal(rows[0].latitude, 25.1);
  assert.equal(rows[0].gpsTime, '2026-10-23T06:58:09.000Z');
  assert.equal(rows[0].rawGpsTime, row.GPSActualTime);
  assert.equal(rows[0].rawTrackerServerTime, row.Datetime);
  assert.equal(rows[0].speedKph, 0);
  assert.equal(rows[0].ignition, 'OFF');
  assert.equal(rows[0].address, 'Saved tracker address');
  assert.equal(parseTruckoomGpsTime('bad'), null);
});

test('rejects rate-limit envelopes and invalid pins never turn into map coordinates', () => {
  assert.throws(() => normalizeTruckoomLiveData({ root: { error: 'Limit exceeded' } }, 'OURS'));
  for (const coords of [{ Latitude: null }, { Longitude: '' }, { Latitude: '100' }, { Latitude: '0', Longitude: '0' }]) {
    const [result] = normalizeTruckoomLiveData({ root: { VehicleData: [{ ...row, ...coords }] } }, 'OURS');
    assert.equal(result.latitude, null);
    assert.equal(result.longitude, null);
  }
});

test('local cache deduplicates concurrent calls and refreshes at one minute', async () => {
  let now = 100000;
  let calls = 0;
  const cache = createTruckoomLiveCache({ sharedAvailable: () => false, clock: () => now });
  const fetch = async () => { calls++; return [{ vehicleNo: 'V1' }]; };
  await Promise.all([cache(fetch), cache(fetch), cache(fetch)]);
  now += 59000;
  await cache(fetch);
  assert.equal(calls, 1);
  now += 1000;
  await cache(fetch);
  assert.equal(calls, 2);
});

test('failed requests cannot cause a retry storm inside the one-minute limit', async () => {
  let calls = 0;
  const cache = createTruckoomLiveCache({ sharedAvailable: () => false, clock: () => 100000 });
  const fetch = async () => { calls++; throw new Error('Network failure'); };
  await assert.rejects(cache(fetch));
  await assert.rejects(cache(fetch));
  assert.equal(calls, 1);
});

test('one-minute spacing includes the authentication and network response time', async () => {
  let now = 100000;
  let calls = 0;
  const cache = createTruckoomLiveCache({ sharedAvailable: () => false, clock: () => now });
  const fetch = async () => { calls++; now += 5000; return [{ vehicleNo: 'V1' }]; };
  await cache(fetch); // completes at 105000
  now = 160000; // only 55 seconds since completion
  await cache(fetch);
  assert.equal(calls, 1);
  now = 165000;
  await cache(fetch);
  assert.equal(calls, 2);
});

test('separate PM2 workers share a Mongo snapshot without Redis', async () => {
  let now = 100000;
  let snapshot;
  let requests = 0;
  const store = {
    findById: () => ({ lean: async () => snapshot }),
    findOneAndUpdate: async (_query, update) => {
      if (snapshot && +snapshot.nextRequestAt > now) throw Object.assign(new Error('duplicate'), { code: 11000 });
      snapshot = { ...snapshot, ...update.$set };
      return snapshot;
    },
    updateOne: async (_query, update) => { snapshot = { ...snapshot, ...update.$set }; return { matchedCount: 1 }; },
  };
  const options = { store, sharedAvailable: () => true, clock: () => now };
  const worker1 = createTruckoomLiveCache(options);
  const worker2 = createTruckoomLiveCache(options);
  const fetch = async () => { requests++; return [{ vehicleNo: 'V1' }]; };
  await worker1(fetch);
  await worker2(fetch);
  assert.equal(requests, 1);
  now += 60000;
  await worker2(fetch);
  await worker1(fetch);
  assert.equal(requests, 2);
});

test('another worker cannot fetch upstream while the first worker is refreshing', async () => {
  const store = {
    findById: () => ({ lean: async () => null }),
    findOneAndUpdate: async () => { throw Object.assign(new Error('duplicate'), { code: 11000 }); },
  };
  const cache = createTruckoomLiveCache({ store, sharedAvailable: () => true });
  let calls = 0;
  await assert.rejects(cache(async () => { calls++; return []; }), /already in progress/);
  assert.equal(calls, 0);
});

test('vehicle service calls token-based Project 49 endpoint with the correct header', async t => {
  const original = truckoom.cachedLiveData;
  t.after(() => { truckoom.cachedLiveData = original; });
  truckoom.cachedLiveData = createTruckoomLiveCache({ sharedAvailable: () => false });
  t.mock.method(truckoom, 'assertConfigured', () => {});
  t.mock.method(truckoom, 'retainGpsResponse', async () => ({ receiptId: 'fixture', sha256: 'a'.repeat(64), kind: 'live', responseReceivedAt: '2026-01-01T00:00:00Z' }));
  t.mock.method(truckoom, 'getAccessToken', async () => 'fixture-token');
  t.mock.method(axios, 'post', async (url, body, config) => {
    assert.ok(url.endsWith('?token=getTokenBaseLiveData&ProjectId=49'));
    assert.deepEqual(body, { company_names: '', format: 'json' });
    assert.equal(config.headers['auth-code'], 'fixture-token');
    return { data: { root: { VehicleData: [{ ...row, Company: truckoom.companyName }] } } };
  });
  const [vehicle] = await truckoom.getVehicleLocations();
  assert.equal(vehicle.locationSource, 'truckoom_live_data');
});

test('archive failure keeps the operational live view explicitly ineligible for capture', async t => {
  const service = new truckoom.constructor(); service.companyName = 'OURS';
  t.mock.method(service, 'assertConfigured', () => {});
  t.mock.method(service, 'getAccessToken', async () => 'fixture-token');
  t.mock.method(service, 'retainGpsResponse', async () => { throw Error('archive failure'); });
  t.mock.method(axios, 'post', async () => ({ data: payload }));
  service.cachedLiveData = createTruckoomLiveCache({ sharedAvailable: () => false });
  const locations = await service.getVehicleLocations();
  assert.equal(locations[0].latitude, 25.1); assert.equal(locations.captureEvidenceStatus, 'unavailable');
});

test('empty fleet response keeps its receipt through another worker shared cache', async () => {
  let snapshot, requests = 0; const receipt = { receiptId: 'fixture-empty' };
  const store = {
    findById: () => ({ lean: async () => snapshot }),
    findOneAndUpdate: async (_filter, update) => { snapshot = { ...update.$set }; return snapshot; },
    updateOne: async (_filter, update) => { snapshot = { ...snapshot, ...update.$set }; return { matchedCount: 1 }; },
  };
  const opts = { store, sharedAvailable: () => true, clock: () => 100000 };
  await createTruckoomLiveCache(opts)(async () => { requests++; const rows = []; Object.defineProperties(rows, { sourceReceipt: { value: receipt }, captureEvidenceStatus: { value: 'retained' } }); return rows; });
  const cached = await createTruckoomLiveCache(opts)(async () => { requests++; return []; });
  assert.equal(requests, 1); assert.equal(cached.length, 0); assert.deepEqual(cached.sourceReceipt, receipt); assert.equal(cached.captureEvidenceStatus, 'retained');
});

test('lost live lease after authentication prevents dispatch', async () => {
  let time = 100000, renewals = 0, dispatches = 0;
  const store = { findById: () => ({ lean: async () => null }), findOneAndUpdate: async () => ({}),
    updateOne: async () => ({ matchedCount: ++renewals === 1 ? 1 : 0 }) };
  const cache = createTruckoomLiveCache({ store, sharedAvailable: () => true, clock: () => time });
  await assert.rejects(cache(async beforeDispatch => { time += 15000; await beforeDispatch(); dispatches++; return []; }), /reservation expired/);
  assert.equal(dispatches, 0);
});

test('duplicate live vehicle rows stay ambiguous instead of choosing the last position', async t => {
  const service = new truckoom.constructor();
  t.mock.method(service, 'getCompanyVehicles', async () => [{ vehicleNo: 'V1' }]);
  t.mock.method(service, 'getVehicleLocations', async () => [{ vehicleNo: 'V1', latitude: 25, longitude: 55 }, { vehicleNo: 'V1', latitude: 26, longitude: 55 }]);
  const [result] = await service.getFleetStatus();
  assert.equal(result.latitude, null); assert.deepEqual(result.sourceQualityFlags, ['conflicting_live_vehicle_rows']);
});
