import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import sharp from 'sharp';
import createRouter from './yellowblockDriver.js';
import Workflow from '../models/YellowblockOrderWorkflow.js';

test('only the assigned driver can collect an order and deliver it with a photo', async t => {
  const jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).jpeg().toBuffer();
  const workflow = {
    _id: '123', orderName: '#123', customerName: 'Test Customer', emirate: 'Dubai',
    driverId: 'driver-1', status: 'prepared', prepared: { at: new Date() }, boxedPhoto: jpeg,
  };
  const shopifyOrder = {
    id: 123, name: '#123', customer: { first_name: 'Test', last_name: 'Customer', email: 'private@example.invalid' },
    shipping_address: { address1: 'Example Street', city: 'Dubai', latitude: 25, longitude: 55 },
  };
  const match = filter => filter.driverId === workflow.driverId && (!filter._id || filter._id === workflow._id)
    && (filter.status.$in?.includes(workflow.status) || filter.status === workflow.status);
  const query = result => ({ select: () => query(result), sort: () => query(result), lean: async () => result,
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject) });
  t.mock.method(Workflow, 'find', filter => query(match(filter) ? [workflow] : []));
  t.mock.method(Workflow, 'findOne', filter => query(match(filter) ? workflow : null));
  t.mock.method(Workflow, 'updateOne', async (filter, update) => {
    if (!match(filter)) return { matchedCount: 0 };
    Object.assign(workflow, update.$set);
    return { matchedCount: 1 };
  });

  const app = express();
  app.use((req, res, next) => {
    req.user = { role: req.get('x-test-role') || 'driver', _id: req.get('x-test-driver') || 'driver-1', profile: { firstName: 'Test Driver' } };
    next();
  });
  let shopifyAvailable = true;
  app.use(createRouter({
    getShopifyConfig: () => ({ configured: shopifyAvailable, version: 'test' }),
    shopifyRequest: async () => ({ status: 200, body: { order: shopifyOrder } }),
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/orders`;
  const otherDriver = { headers: { 'x-test-driver': 'driver-2' } };

  assert.equal((await fetch(base, { headers: { 'x-test-role': 'kitchen' } })).status, 403);
  assert.deepEqual((await (await fetch(base, otherDriver)).json()).data, []);
  for (const path of ['/123', '/123/packed-photo']) assert.equal((await fetch(base + path, otherDriver)).status, 404);
  assert.equal((await fetch(`${base}/123/collect`, { method: 'POST', ...otherDriver })).status, 404);
  assert.equal((await fetch(`${base}/123/deliver`, { method: 'POST' })).status, 409);

  const detail = await fetch(`${base}/123`);
  assert.equal(detail.headers.get('cache-control'), 'no-store');
  const { data } = await detail.json();
  assert.equal(data.shippingAddress.address1, 'Example Street');
  assert.equal(data.customerName, 'Test Customer');
  assert.ok(!JSON.stringify(data).includes('private@example.invalid'));
  const photo = await fetch(`${base}/123/packed-photo`);
  assert.deepEqual(Buffer.from(await photo.arrayBuffer()), jpeg);
  assert.equal((await fetch(`${base}/123/delivery-photo`)).status, 404);

  const collection = await fetch(`${base}/123/collect`, { method: 'POST' });
  assert.equal((await collection.json()).data.status, 'collected');
  assert.equal(workflow.collected.actor, 'Test Driver');
  assert.equal((await fetch(`${base}/123/deliver`, { method: 'POST' })).status, 400);
  const form = new FormData();
  form.append('deliveryPhoto', new Blob([jpeg], { type: 'image/jpeg' }), 'delivery.jpg');
  const delivery = await fetch(`${base}/123/deliver`, { method: 'POST', body: form });
  assert.equal((await delivery.json()).data.status, 'delivered');
  assert.ok(Buffer.isBuffer(workflow.deliveryPhoto));
  assert.equal(workflow.delivered.photoTaken, true);
  assert.deepEqual((await (await fetch(base)).json()).data, []);
  const history = `${base}?includeDelivered=true`;
  assert.deepEqual((await (await fetch(history)).json()).data, [{
    id: '123', name: '#123', customerName: 'Test Customer', emirate: 'Dubai',
    status: 'delivered', deliveredAt: workflow.delivered.at.toISOString(),
  }]);
  assert.deepEqual((await (await fetch(history, otherDriver)).json()).data, []);
  assert.equal((await fetch(`${base}/123/delivery-photo`, otherDriver)).status, 404);
  assert.equal((await fetch(`${base}/123/delivery-photo`, { headers: { 'x-test-role': 'kitchen' } })).status, 403);
  shopifyAvailable = false;
  const completed = (await (await fetch(`${base}/123`)).json()).data;
  assert.equal(completed.status, 'delivered');
  assert.equal(completed.hasDeliveryPhoto, true);
  const savedPhoto = await fetch(`${base}/123/delivery-photo`);
  assert.equal(savedPhoto.headers.get('cache-control'), 'no-store');
  assert.equal(savedPhoto.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await savedPhoto.arrayBuffer()), workflow.deliveryPhoto);
});
