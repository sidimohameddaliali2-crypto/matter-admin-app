// Reverse geocoding (coordinates -> address) for the driver app's reported
// positions. Google is stubbed; the cache/throttle behaviour is what matters.
import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

process.env.GOOGLE_GEOCODING_API_KEY = 'test-key';
process.env.DELIVERY_DEPOT_LAT = '25.2';
process.env.DELIVERY_DEPOT_LNG = '55.3';
delete process.env.REVERSE_GEOCODE_DISABLED;
const { reverseGeocode, addressForDriver, _resetReverseGeocodeStateForTests } = await import('./reverseGeocode.js');

function stubGoogle(handler) {
  const orig = axios.get;
  const calls = [];
  axios.get = async (url, opts) => { calls.push(opts.params.latlng); return handler(opts.params.latlng, calls.length); };
  return { calls, restore: () => { axios.get = orig; } };
}
const ok = (address) => ({ data: { status: 'OK', results: [{ formatted_address: address, types: ['street_address'] }] } });

test('a coordinate pair resolves to the street address Google returns', async () => {
  _resetReverseGeocodeStateForTests();
  const g = stubGoogle(() => ok('Flametree Ridge, Jumeirah Golf Estates, Dubai'));
  try {
    assert.equal(await reverseGeocode(25.0205, 55.2008), 'Flametree Ridge, Jumeirah Golf Estates, Dubai');
    assert.equal(g.calls.length, 1);
  } finally { g.restore(); }
});

test('the same spot is looked up once (cached), concurrent requests share one call', async () => {
  _resetReverseGeocodeStateForTests();
  const g = stubGoogle(async () => { await new Promise((r) => setTimeout(r, 20)); return ok('Cached St, Dubai'); });
  try {
    const [a, b, c] = await Promise.all([reverseGeocode(25.1, 55.2), reverseGeocode(25.1, 55.2), reverseGeocode(25.1, 55.2)]);
    assert.deepEqual([a, b, c], ['Cached St, Dubai', 'Cached St, Dubai', 'Cached St, Dubai']);
    await reverseGeocode(25.1, 55.2);
    assert.equal(g.calls.length, 1);
  } finally { g.restore(); }
});

test('implausible coordinates (0,0, far outside the service area, junk) never reach Google', async () => {
  _resetReverseGeocodeStateForTests();
  const g = stubGoogle(() => ok('should not be called'));
  try {
    for (const [la, ln] of [[0, 0], [-26.2, 28.0], ['x', 'y'], [null, null], [999, 999]]) assert.equal(await reverseGeocode(la, ln), null);
    assert.equal(g.calls.length, 0);
  } finally { g.restore(); }
});

test('"no address found" and Google failures return null and are remembered briefly, not retried every time', async () => {
  _resetReverseGeocodeStateForTests();
  const g = stubGoogle(() => ({ data: { status: 'ZERO_RESULTS', results: [] } }));
  try {
    assert.equal(await reverseGeocode(25.3, 55.4), null);
    assert.equal(await reverseGeocode(25.3, 55.4), null);
    assert.equal(g.calls.length, 1);
  } finally { g.restore(); }
  const g2 = stubGoogle(() => { throw new Error('network down'); });
  try {
    assert.equal(await reverseGeocode(25.31, 55.41), null); // swallowed, never throws into a request
  } finally { g2.restore(); }
});

test('a bare Plus Code is skipped in favour of a real address when Google returns both', async () => {
  _resetReverseGeocodeStateForTests();
  const g = stubGoogle(() => ({ data: { status: 'OK', results: [
    { formatted_address: '7HQ2+F9 Dubai', types: ['plus_code'] },
    { formatted_address: 'Sheikh Zayed Rd, Dubai', types: ['route'] }
  ] } }));
  try {
    assert.equal(await reverseGeocode(25.15, 55.25), 'Sheikh Zayed Rd, Dubai');
  } finally { g.restore(); }
});

test('REVERSE_GEOCODE_DISABLED=1 turns it off completely', async () => {
  _resetReverseGeocodeStateForTests();
  process.env.REVERSE_GEOCODE_DISABLED = '1';
  const g = stubGoogle(() => ok('x'));
  try {
    assert.equal(await reverseGeocode(25.1, 55.2), null);
    assert.equal(await addressForDriver('d1', 25.1, 55.2), null);
    assert.equal(g.calls.length, 0);
  } finally { g.restore(); delete process.env.REVERSE_GEOCODE_DISABLED; }
});

test('a moving driver is not re-resolved on every position update (same cell, or within the interval)', async () => {
  _resetReverseGeocodeStateForTests();
  const g = stubGoogle((latlng) => ok(`Address for ${latlng}`));
  try {
    const first = await addressForDriver('driver-1', 25.12345, 55.22222);
    const sameCell = await addressForDriver('driver-1', 25.12349, 55.22226); // ~5 m later
    const movedFar = await addressForDriver('driver-1', 25.2, 55.3); // far, but inside the 5-minute window
    assert.equal(first, sameCell);
    assert.equal(movedFar, first); // reused: throttled per driver
    assert.equal(g.calls.length, 1);
    const other = await addressForDriver('driver-2', 25.2, 55.3); // a different driver still gets their own lookup
    assert.notEqual(other, first);
    assert.equal(g.calls.length, 2);
  } finally { g.restore(); }
});
