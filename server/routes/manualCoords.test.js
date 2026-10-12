// Issue #6: a manual pin correction must only touch the requested delivery.
// Runs the real POST /:id/manual-coords handler with the Mongoose model
// statics stubbed (no database).
import test from 'node:test';
import assert from 'node:assert/strict';
import Delivery from '../models/Delivery.js';
import Customer from '../models/Customer.js';
import deliveriesRouter from './deliveries.js';

const layer = deliveriesRouter.stack.find(
  (l) => l.route?.path === '/:id/manual-coords' && l.route.methods.post
);
const handler = layer.route.stack[layer.route.stack.length - 1].handle;

function fakeDelivery(overrides = {}) {
  const d = {
    _id: 'd-future',
    customerId: 'CUST-A',
    address: 'LOCATION-NEW',
    status: 'pending',
    gpsLocation: undefined,
    saves: 0,
    async save() { this.saves += 1; },
    ...overrides
  };
  return d;
}

async function callHandler({ delivery, body }) {
  const calls = { updateMany: [], customerUpdateOne: [], findById: [] };
  const origFindById = Delivery.findById;
  const origUpdateMany = Delivery.updateMany;
  const origCustomerUpdateOne = Customer.updateOne;
  const origInfo = console.info;
  const logs = [];
  Delivery.findById = async (id) => { calls.findById.push(id); return delivery; };
  Delivery.updateMany = async (...args) => { calls.updateMany.push(args); return { modifiedCount: 99 }; };
  Customer.updateOne = (...args) => { calls.customerUpdateOne.push(args); return Promise.resolve({}); };
  console.info = (...args) => logs.push(args);
  try {
    const out = {};
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { out.status = this.statusCode; out.body = b; }
    };
    await handler({ params: { id: delivery._id }, body, user: { _id: 'user-1' } }, res);
    return { ...out, calls, logs };
  } finally {
    Delivery.findById = origFindById;
    Delivery.updateMany = origUpdateMany;
    Customer.updateOne = origCustomerUpdateOne;
    console.info = origInfo;
  }
}

test('correcting a future delivery saves that delivery and never bulk-updates other deliveries', async () => {
  const delivery = fakeDelivery();
  const r = await callHandler({ delivery, body: { lat: 25.1, lng: 55.2 } });
  assert.equal(r.status, 200);
  assert.equal(delivery.saves, 1);
  assert.deepEqual({ lat: delivery.gpsLocation.lat, lng: delivery.gpsLocation.lng }, { lat: 25.1, lng: 55.2 });
  // The old completed delivery at LOCATION-OLD (same customer, no GPS) can only be
  // reached through a bulk write — there must be none.
  assert.equal(r.calls.updateMany.length, 0);
});

test('missing GPS elsewhere does not justify assigning this destination to other deliveries', async () => {
  const r = await callHandler({ delivery: fakeDelivery({ customerId: 'CUST-MULTI' }), body: { lat: 25.1, lng: 55.2 } });
  assert.equal(r.calls.updateMany.length, 0);
});

test('repeating the same correction does not expand the target set', async () => {
  const delivery = fakeDelivery();
  const first = await callHandler({ delivery, body: { lat: 25.1, lng: 55.2 } });
  const second = await callHandler({ delivery, body: { lat: 25.1, lng: 55.2 } });
  assert.equal(first.calls.updateMany.length + second.calls.updateMany.length, 0);
  assert.equal(delivery.saves, 2); // same single delivery each time
  assert.equal(first.calls.findById.length, 1);
  assert.equal(second.calls.findById.length, 1);
});

test('caches the pin on the customer (address-keyed) so later deliveries at that address reuse it', async () => {
  const r = await callHandler({ delivery: fakeDelivery(), body: { lat: 25.1, lng: 55.2 } });
  assert.equal(r.calls.customerUpdateOne.length, 1);
  const [filter, update] = r.calls.customerUpdateOne[0];
  assert.deepEqual(filter, { customerId: 'CUST-A' });
  assert.equal(update.$set.gpsLocation.address, 'LOCATION-NEW');
  assert.equal(update.$set.gpsLocation.source, 'manual');
});

test('writes an audit line with before/after values', async () => {
  const delivery = fakeDelivery({ gpsLocation: { lat: 24.0, lng: 54.0 } });
  const r = await callHandler({ delivery, body: { lat: 25.1, lng: 55.2 } });
  assert.equal(r.logs.length, 1);
  const entry = JSON.parse(r.logs[0][1]);
  assert.equal(entry.deliveryId, 'd-future');
  assert.equal(entry.by, 'user-1');
  assert.deepEqual(entry.before, { lat: 24.0, lng: 54.0, address: 'LOCATION-NEW' });
  assert.deepEqual(entry.after, { lat: 25.1, lng: 55.2, address: 'LOCATION-NEW' });
});

test('rejects non-numeric coordinates and unknown deliveries', async () => {
  const bad = await callHandler({ delivery: fakeDelivery(), body: { lat: 'x', lng: 55.2 } });
  assert.equal(bad.status, 400);
  const origFind = Delivery.findById;
  Delivery.findById = async () => null;
  try {
    const out = {};
    await handler({ params: { id: 'x' }, body: { lat: 1, lng: 2 } }, {
      status(c) { out.status = c; return this; }, json(b) { out.body = b; }
    });
    assert.equal(out.status, 404);
  } finally {
    Delivery.findById = origFind;
  }
});
