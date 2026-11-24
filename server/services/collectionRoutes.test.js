import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import router from '../routes/collections.js';
import Customer from '../models/Customer.js';
import Delivery from '../models/Delivery.js';

const original = { findCustomer: Customer.findOne, create: Delivery.create };
afterEach(() => { Customer.findOne = original.findCustomer; Delivery.create = original.create; });
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const body = { customerSource: 'manual', customerName: 'Manual Customer', address: 'Al Quoz, Dubai', collectionDate: '2026-11-27', refundRequestedAfterCollection: true };
const post = router.stack.find(layer => layer.route?.path === '/' && layer.route.methods.post).route.stack[0].handle;

test('request becomes an unassigned Collection delivery and emits the existing dispatch event', async () => {
  let written, event;
  Delivery.create = async data => {
    const doc = new Delivery(data);
    await doc.validate();
    written = doc;
    return doc;
  };
  const res = response();
  await post({ body: { ...body, driver: 'malicious', status: 'collected' }, user: { _id: '507f1f77bcf86cd799439011' }, app: { get: () => ({ emit: (name, data) => { event = { name, data }; } }) } }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(written.type, 'Collection');
  assert.equal(written.driver, null);
  assert.equal(written.status, 'pending');
  assert.equal(written.collectionRequest.refundRequestedAfterCollection, true);
  assert.equal(event.name, 'delivery:created');
});
test('missing selected customer returns a useful error without creating any delivery', async () => {
  Customer.findOne = () => ({ select() { return this; }, lean: async () => null });
  Delivery.create = () => { throw new Error('must not write'); };
  const res = response();
  await post({ body: { ...body, customerSource: 'internal', customerId: 'removed' }, user: { _id: 'staff' } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /Customer no longer exists/);
});
test('collection access requires both an operations role and delivery permission', () => {
  const roleGuard = router.stack[1].handle;
  const permissionGuard = router.stack[2].handle;
  for (const role of ['driver', 'store_keeper', 'viewer']) {
    const res = response(); let next = false;
    roleGuard({ user: { role } }, res, () => { next = true; });
    assert.equal(next, false); assert.equal(res.statusCode, 403);
  }
  const res = response();
  permissionGuard({ user: { role: 'manager', permissionsConfigured: true, permissions: { deliveries: false } } }, res, () => assert.fail('must deny'));
  assert.equal(res.statusCode, 403);
  const allowed = response(); allowed.setHeader = () => {};
  let next = false;
  permissionGuard({ user: { role: 'dispatcher' } }, allowed, () => { next = true; });
  assert.equal(next, true);
});
