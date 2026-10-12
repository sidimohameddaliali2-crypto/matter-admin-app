// Automatic Google geocoding is off: the resolver only returns pins that
// already exist and never writes a guess. Google/Customer calls are stubbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

process.env.GOOGLE_GEOCODING_API_KEY = 'test-key';
process.env.DELIVERY_DEPOT_LAT = '25.2'; // read at import time by geocoding.js
process.env.DELIVERY_DEPOT_LNG = '55.3';
const { default: Customer } = await import('../models/Customer.js');
const { resolveDeliveryCoordinatesCached, resolveDeliveryCoordinates, geocodeAddress } = await import('./geocoding.js');

async function withStubs({ cache = null }, fn) {
  const calls = { axiosGet: 0, customerFindOne: 0, customerUpdateOne: 0 };
  const origGet = axios.get;
  const origFindOne = Customer.findOne;
  const origUpdateOne = Customer.updateOne;
  axios.get = async () => { calls.axiosGet += 1; return { data: { status: 'OK', results: [{ geometry: { location: { lat: 25.2, lng: 55.3 } } }] } }; };
  Customer.findOne = () => { calls.customerFindOne += 1; return { select: () => ({ lean: async () => (cache ? { gpsLocation: cache } : null) }) }; };
  Customer.updateOne = async () => { calls.customerUpdateOne += 1; return {}; };
  try {
    return await fn(calls);
  } finally {
    axios.get = origGet;
    Customer.findOne = origFindOne;
    Customer.updateOne = origUpdateOne;
  }
}

test('an address with no pin anywhere resolves to null — Google is never called, nothing is cached', async () => {
  await withStubs({}, async (calls) => {
    const result = await resolveDeliveryCoordinatesCached({ customerId: 'C1', address: 'Villa 40, Jumeirah 1, Dubai' });
    assert.equal(result, null);
    assert.equal(calls.axiosGet, 0);
    assert.equal(calls.customerUpdateOne, 0); // no 'geocoded' / 'unresolved' guess saved
  });
});

test('the non-cached resolver also never geocodes', async () => {
  await withStubs({}, async (calls) => {
    assert.equal(await resolveDeliveryCoordinates({ address: 'Villa 46, Algeria St' }), null);
    assert.equal(calls.axiosGet, 0);
  });
});

test("a delivery's own plausible coordinates are returned as-is", async () => {
  await withStubs({}, async (calls) => {
    const r = await resolveDeliveryCoordinatesCached({ customerId: 'C1', address: 'x', gpsLocation: { lat: 25.1, lng: 55.2 } });
    assert.deepEqual(r, { lat: 25.1, lng: 55.2 });
    assert.equal(calls.axiosGet, 0);
    assert.equal(calls.customerFindOne, 0);
  });
});

test('a pin extracted from a Google Maps link is still used (it is a real pin, not a guess)', async () => {
  await withStubs({}, async (calls) => {
    const r = await resolveDeliveryCoordinatesCached({
      customerId: 'C1', address: 'x', mapsUrl: 'https://www.google.com/maps/place/Villa/@25.1234,55.5678,15z'
    });
    assert.deepEqual(r, { lat: 25.1234, lng: 55.5678 });
    assert.equal(calls.axiosGet, 0);
  });
});

test("the customer's saved pin is reused only for the exact address it was saved for", async () => {
  const cache = { lat: 25.11, lng: 55.22, address: 'Villa 40, Jumeirah 1, Dubai', source: 'manual' };
  await withStubs({ cache }, async (calls) => {
    const same = await resolveDeliveryCoordinatesCached({ customerId: 'C1', address: 'Villa 40, Jumeirah 1, Dubai ' });
    assert.deepEqual(same, { lat: 25.11, lng: 55.22 });
    const other = await resolveDeliveryCoordinatesCached({ customerId: 'C1', address: 'Villa 9, Al Barsha, Dubai' });
    assert.equal(other, null); // different address: no reuse, and no guess either
    assert.equal(calls.axiosGet, 0);
    assert.equal(calls.customerUpdateOne, 0);
  });
});

test('a saved pin that is implausibly far from the depot is not reused', async () => {
  const cache = { lat: -26.2, lng: 28.0, address: 'Algeria St, Villa 46', source: 'geocoded' }; // Johannesburg
  await withStubs({ cache }, async () => {
    const r = await resolveDeliveryCoordinatesCached({ customerId: 'C1', address: 'Algeria St, Villa 46' });
    assert.equal(r, null);
  });
});

test('the explicit geocode (dispatcher button) still works through geocodeAddress', async () => {
  await withStubs({}, async (calls) => {
    const r = await geocodeAddress('Villa 40, Jumeirah 1, Dubai');
    assert.equal(r.lat, 25.2);
    assert.equal(calls.axiosGet, 1);
  });
});
