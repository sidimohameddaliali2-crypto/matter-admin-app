// Live Tracking data: a tracker pin AND the driver app's pin per driver, each
// with a street address; drivers with no tracker come back as app-only.
import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

process.env.GOOGLE_GEOCODING_API_KEY = 'test-key';
process.env.DELIVERY_DEPOT_LAT = '25.2';
process.env.DELIVERY_DEPOT_LNG = '55.3';
const { default: User } = await import('../models/User.js');
const { default: truckoomApiService } = await import('../services/truckoomApiService.js');
const { _resetReverseGeocodeStateForTests } = await import('../services/reverseGeocode.js');
const { default: router } = await import('./truckoomApi.js');

const handler = router.stack.find((l) => l.route?.path === '/vehicles' && l.route.methods.get).route.stack.at(-1).handle;
const origGet = axios.get;
test.after(() => { axios.get = origGet; });

const chain = (rows) => { const q = { select: () => q, lean: async () => rows, then: (res, rej) => Promise.resolve(rows).then(res, rej) }; return q; };
const minutesAgo = (m) => new Date(Date.now() - m * 60000);

async function run({ fleet, drivers, fleetError, google = (latlng) => `Street near ${latlng}` }) {
  _resetReverseGeocodeStateForTests();
  const lookups = [];
  axios.get = async (url, opts) => {
    lookups.push(opts.params.latlng);
    return { data: { status: 'OK', results: [{ formatted_address: google(opts.params.latlng), types: ['street_address'] }] } };
  };
  const origFleet = truckoomApiService.getFleetStatus;
  const origFind = User.find;
  truckoomApiService.getFleetStatus = async () => {
    if (fleetError) throw new Error(fleetError);
    return fleet;
  };
  User.find = () => chain(drivers);
  const out = {};
  try {
    await handler({}, { status(c) { out.status = c; return this; }, json(b) { out.status = out.status || 200; out.body = b; } });
  } finally {
    truckoomApiService.getFleetStatus = origFleet;
    User.find = origFind;
  }
  return { ...out, lookups };
}

const driver = (id, over = {}) => ({ _id: id, email: `${id}@x`, profile: { firstName: id, lastName: 'D', colorCode: '#123456', ...over.profile }, location: over.location });

test('missing, null and invalid phone coordinates never produce a phone pin or an address lookup', async () => {
  const locations = [undefined, {}, { latitude: null, longitude: null },
    { latitude: null, longitude: 55.2 }, { latitude: 25.2, longitude: null },
    { latitude: '', longitude: '' }, { latitude: 0, longitude: 0 },
    { latitude: 100, longitude: 55.2 }, { latitude: 'bad', longitude: 55.2 }];
  const r = await run({ fleet: [], drivers: locations.map((location, i) => driver(`d${i}`, { location })) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.appOnlyDrivers, []);
  assert.equal(r.lookups.length, 0);
});

test('Truckoom failure still returns mapped and unmapped drivers phone positions with a warning', async () => {
  const r = await run({ fleetError: 'tracker timeout', drivers: [
    driver('d1', { profile: { truckoomVehicleNo: 'V1' }, location: { latitude: 25.1, longitude: 55.2, lastUpdated: minutesAgo(1) } }),
    driver('d2', { location: { latitude: 25.15, longitude: 55.25, lastUpdated: minutesAgo(3) } }),
    driver('d3', { location: { latitude: null, longitude: null } }),
  ] });
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assert.deepEqual(r.body.data, []);
  assert.deepEqual(r.body.appOnlyDrivers.map((d) => d.id), ['d1', 'd2']);
  assert.ok(r.body.trackerWarning);
  assert.ok(r.body.appOnlyDrivers[0].appLocation.address);

  const recovered = await run({ fleet: [], drivers: [] });
  assert.equal(recovered.body.trackerWarning, null);
});

test('a driver with a tracker gets two pins, each with its own address', async () => {
  const r = await run({
    fleet: [{ vehicleNo: 'V1', latitude: 25.2, longitude: 55.27 }],
    drivers: [driver('d1', { profile: { truckoomVehicleNo: 'V1' }, location: { latitude: 25.1, longitude: 55.2, lastUpdated: minutesAgo(2) } })]
  });
  const v = r.body.data[0];
  assert.ok(v.address, 'tracker pin has an address');
  assert.ok(v.driver.appLocation.address, 'app pin has an address');
  assert.notEqual(v.address, v.driver.appLocation.address);
  assert.equal(v.driver.appLocation.stale, false);
  assert.deepEqual(r.body.appOnlyDrivers, []);
});

test('a driver with no tracker comes back as app-only (one pin); one with no phone position is left out', async () => {
  const r = await run({
    fleet: [{ vehicleNo: 'V1', latitude: 25.2, longitude: 55.27 }],
    drivers: [
      driver('d1', { profile: { truckoomVehicleNo: 'V1' }, location: { latitude: 25.1, longitude: 55.2, lastUpdated: minutesAgo(1) } }),
      driver('d2', { location: { latitude: 25.15, longitude: 55.25, lastUpdated: minutesAgo(3) } }),
      driver('d3', { location: {} })
    ]
  });
  assert.deepEqual(r.body.appOnlyDrivers.map((d) => d.id), ['d2']);
  assert.ok(r.body.appOnlyDrivers[0].appLocation.address);
});

test('an old phone position is still returned but flagged stale', async () => {
  const r = await run({
    fleet: [],
    drivers: [driver('d2', { location: { latitude: 25.15, longitude: 55.25, lastUpdated: minutesAgo(60 * 20) } })]
  });
  assert.equal(r.body.appOnlyDrivers[0].appLocation.stale, true);
});

test('a vehicle with no GPS fix has no address and costs no lookup; an unmapped vehicle has no driver', async () => {
  const r = await run({ fleet: [{ vehicleNo: 'V9', latitude: null, longitude: null }], drivers: [] });
  assert.equal(r.body.data[0].address, null);
  assert.equal(r.body.data[0].driver, null);
  assert.equal(r.lookups.length, 0);
});

test('every position is looked up at most once per request (cached), and a failing lookup still returns the pins', async () => {
  const r = await run({
    fleet: [{ vehicleNo: 'V1', latitude: 25.2, longitude: 55.27 }, { vehicleNo: 'V2', latitude: 25.2, longitude: 55.27 }],
    drivers: []
  });
  assert.equal(r.lookups.length, 1); // two vehicles at the same spot share one lookup
  _resetReverseGeocodeStateForTests();
  const origFleet = truckoomApiService.getFleetStatus;
  const origFind = User.find;
  truckoomApiService.getFleetStatus = async () => [{ vehicleNo: 'V1', latitude: 25.2, longitude: 55.27 }];
  User.find = () => chain([]);
  axios.get = async () => { throw new Error('google down'); };
  const out = {};
  try {
    await handler({}, { status(c) { out.status = c; return this; }, json(b) { out.body = b; } });
  } finally { truckoomApiService.getFleetStatus = origFleet; User.find = origFind; }
  assert.equal(out.body.success, true);
  assert.equal(out.body.data[0].address, null);
  assert.equal(out.body.data[0].latitude, 25.2);
});
