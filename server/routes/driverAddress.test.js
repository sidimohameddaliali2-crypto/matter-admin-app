// The two places an address is attached to what the driver app reports:
// the drop-off spot on a delivery, and the driver's current position.
import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

process.env.GOOGLE_GEOCODING_API_KEY = 'test-key';
process.env.DELIVERY_DEPOT_LAT = '25.2';
process.env.DELIVERY_DEPOT_LNG = '55.3';
const { default: Delivery } = await import('../models/Delivery.js');
const { default: User } = await import('../models/User.js');
const { resolveProofAddress, resolveProofAddressWithin } = await import('../services/proofLocationAddress.js');
const { _resetReverseGeocodeStateForTests } = await import('../services/reverseGeocode.js');
const { default: driversRouter } = await import('./drivers.js');

const googleReturns = (address) => { axios.get = async () => ({ data: { status: 'OK', results: [{ formatted_address: address, types: ['street_address'] }] } }); };
const origGet = axios.get;
test.after(() => { axios.get = origGet; });

test('drop-off: coordinates get an address, saved once on the delivery', async () => {
  _resetReverseGeocodeStateForTests();
  googleReturns('Villa 40, Jumeirah 1, Dubai');
  const writes = [];
  const orig = Delivery.updateOne;
  Delivery.updateOne = async (...a) => { writes.push(a); return {}; };
  try {
    const d = { _id: 'd1', proof: { location: { lat: 25.2, lng: 55.27 } } };
    assert.equal(await resolveProofAddress(d), 'Villa 40, Jumeirah 1, Dubai');
    assert.equal(writes.length, 1);
    assert.equal(writes[0][1].$set['proof.location.address'], 'Villa 40, Jumeirah 1, Dubai');
    assert.equal(writes[0][0]._id, 'd1');
  } finally { Delivery.updateOne = orig; }
});

test('drop-off: an address already saved is returned without any lookup or write', async () => {
  let called = 0;
  axios.get = async () => { called += 1; return { data: { status: 'OK', results: [] } }; };
  const orig = Delivery.updateOne;
  Delivery.updateOne = async () => { called += 1; return {}; };
  try {
    assert.equal(await resolveProofAddress({ _id: 'd2', proof: { location: { lat: 25.2, lng: 55.27, address: 'Saved already' } } }), 'Saved already');
    assert.equal(called, 0);
  } finally { Delivery.updateOne = orig; }
});

test('drop-off: no proof/location, or a lookup that finds nothing, gives null and never throws', async () => {
  _resetReverseGeocodeStateForTests();
  assert.equal(await resolveProofAddress({ _id: 'd3' }), null);
  assert.equal(await resolveProofAddress({ _id: 'd4', proof: { location: {} } }), null);
  assert.equal(await resolveProofAddress(null), null);
  axios.get = async () => { throw new Error('boom'); };
  assert.equal(await resolveProofAddress({ _id: 'd5', proof: { location: { lat: 25.21, lng: 55.28 } } }), null);
});

test('drop-off: the detail view never waits longer than its limit for a slow lookup', async () => {
  _resetReverseGeocodeStateForTests();
  axios.get = () => new Promise((resolve) => setTimeout(() => resolve({ data: { status: 'OK', results: [{ formatted_address: 'Too late', types: [] }] } }), 300));
  const started = Date.now();
  const r = await resolveProofAddressWithin({ _id: 'd6', proof: { location: { lat: 25.22, lng: 55.29 } } }, 40);
  assert.equal(r, null);
  assert.ok(Date.now() - started < 200);
});

const handlerFor = (path, method) => driversRouter.stack.find((l) => l.route?.path === path && l.route.methods[method]).route.stack.at(-1).handle;
const call = async (handler, req) => {
  const out = {};
  await handler(req, { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { out.status = this.statusCode; out.body = b; } });
  return out;
};
const chain = (rows) => { const q = { select: () => q, lean: async () => rows, then: (res, rej) => Promise.resolve(rows).then(res, rej) }; return q; };

test('driver list: each driver position gets an address; a driver with no position gets none', async () => {
  _resetReverseGeocodeStateForTests();
  googleReturns('Al Wasl Rd, Dubai');
  const origFind = User.find;
  User.find = () => chain([
    { _id: 'dr1', email: 'a@x', profile: {}, isActive: true, location: { latitude: 25.2, longitude: 55.27, lastUpdated: new Date() } },
    { _id: 'dr2', email: 'b@x', profile: {}, isActive: true, location: {} }
  ]);
  try {
    const r = await call(handlerFor('/locations', 'get'), { query: {}, user: { role: 'admin' } });
    assert.equal(r.body[0].location.address, 'Al Wasl Rd, Dubai');
    assert.equal(r.body[1].location, null);
  } finally { User.find = origFind; }
});

test('single driver: staff can read any driver; a driver can only read their own', async () => {
  _resetReverseGeocodeStateForTests();
  googleReturns('Jumeirah St, Dubai');
  const origFindOne = User.findOne;
  User.findOne = () => chain({ _id: 'dr1', location: { latitude: 25.2, longitude: 55.27 } });
  try {
    const get = handlerFor('/:id/location', 'get');
    const staff = await call(get, { params: { id: 'dr1' }, user: { role: 'dispatcher', id: 'u9' } });
    assert.equal(staff.body.data.location.address, 'Jumeirah St, Dubai');
    const other = await call(get, { params: { id: 'dr1' }, user: { role: 'driver', id: 'dr2' } });
    assert.equal(other.status, 403);
    const own = await call(get, { params: { id: 'dr1' }, user: { role: 'driver', id: 'dr1' } });
    assert.equal(own.status, 200);
  } finally { User.findOne = origFindOne; }
});
