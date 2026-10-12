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

async function callHandler({ delivery, body, siblings = [] }) {
  const calls = { updateMany: [], customerUpdateOne: [], findById: [], find: [] };
  const origFindById = Delivery.findById;
  const origUpdateMany = Delivery.updateMany;
  const origFind = Delivery.find;
  const origCustomerUpdateOne = Customer.updateOne;
  const origInfo = console.info;
  const logs = [];
  Delivery.findById = async (id) => { calls.findById.push(id); return delivery; };
  Delivery.updateMany = async (...args) => { calls.updateMany.push(args); return { modifiedCount: 99 }; };
  Delivery.find = (filter) => { calls.find.push(filter); return { select: () => ({ lean: async () => siblings }) }; };
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
    Delivery.find = origFind;
    Customer.updateOne = origCustomerUpdateOne;
    console.info = origInfo;
  }
}

test('no addressId: saves only that delivery and never bulk-updates other deliveries', async () => {
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

const SAME_PLACE = [{ _id: 'f2' }, { _id: 'f3' }];

test('addressId: propagates only to same customer + same addressId, still-editable, today-or-later deliveries', async () => {
  const delivery = fakeDelivery({ addressId: '1042' });
  const r = await callHandler({ delivery, body: { lat: 25.1, lng: 55.2 }, siblings: SAME_PLACE });
  assert.equal(r.calls.find.length, 1);
  const f = r.calls.find[0];
  assert.deepEqual(f._id, { $ne: 'd-future' });
  assert.equal(f.customerId, 'CUST-A');
  assert.equal(f.addressId, '1042');
  assert.deepEqual(f.status, { $in: ['pending', 'assigned'] }); // never delivered history / in-progress stops
  assert.ok(f.scheduledTime.$gte instanceof Date); // nothing before today
  assert.equal(r.calls.updateMany.length, 1);
  const [filter, update] = r.calls.updateMany[0];
  assert.deepEqual(filter, { _id: { $in: ['f2', 'f3'] } }); // exactly the audited targets
  assert.equal(update.$set['gpsLocation.lat'], 25.1);
});

test('addressId: with no same-place job there is no write at all, and other locations cannot match', async () => {
  const r = await callHandler({ delivery: fakeDelivery({ addressId: '1042' }), body: { lat: 25.1, lng: 55.2 }, siblings: [] });
  const f = r.calls.find[0];
  assert.equal(f.addressId, '1042'); // other addressIds can't match
  assert.ok(!('status' in f) || !f.status.$in.includes('delivered'));
  assert.equal(r.calls.updateMany.length, 0); // no matching same-place job -> no write at all
});

test('addressId: audit line lists exactly which deliveries received the pin; repeating does not widen it', async () => {
  const delivery = fakeDelivery({ addressId: '1042' });
  const first = await callHandler({ delivery, body: { lat: 25.1, lng: 55.2 }, siblings: SAME_PLACE });
  const second = await callHandler({ delivery, body: { lat: 25.1, lng: 55.2 }, siblings: SAME_PLACE });
  assert.deepEqual(JSON.parse(first.logs[0][1]).propagatedTo, ['f2', 'f3']);
  assert.deepEqual(JSON.parse(first.logs[0][1]).addressId, '1042');
  assert.deepEqual(first.calls.updateMany[0], second.calls.updateMany[0]);
});

test('editing the address text drops the stale addressId (pre-save hook)', async () => {
  const doc = new Delivery({ customerId: 'C', customerName: 'N', scheduledTime: new Date(), address: 'Old', addressId: '1042' });
  doc.isNew = false;
  doc.$__reset?.();
  doc.address = 'New place';
  await new Promise((resolve, reject) => {
    Delivery.schema.s.hooks.execPre('save', doc, [], (err) => (err ? reject(err) : resolve()));
  });
  assert.equal(doc.addressId, null);

  const kept = new Delivery({ customerId: 'C', customerName: 'N', scheduledTime: new Date(), address: 'Old', addressId: '1042' });
  kept.isNew = false;
  kept.$__reset?.();
  kept.scheduledTime = new Date(Date.now() + 1000); // unrelated edit
  await new Promise((resolve, reject) => {
    Delivery.schema.s.hooks.execPre('save', kept, [], (err) => (err ? reject(err) : resolve()));
  });
  assert.equal(kept.addressId, '1042');
});

test('update-style address edits ($set.address) also drop the stale addressId, unless the same write sets one', async () => {
  const run = async (update) => {
    const query = Delivery.findOneAndUpdate({ _id: '6a1bbd6a925161da6ed226e9' }, update); // built, never executed
    await new Promise((resolve, reject) => {
      Delivery.schema.s.hooks.execPre('findOneAndUpdate', query, [], (err) => (err ? reject(err) : resolve()));
    });
    return query.getUpdate();
  };
  assert.equal((await run({ $set: { address: 'New' } })).$set.addressId, null);
  assert.equal((await run({ $set: { address: 'New', addressId: '7' } })).$set.addressId, '7');
  assert.equal((await run({ $set: { notes: 'x' } })).$set.addressId, undefined);
});
