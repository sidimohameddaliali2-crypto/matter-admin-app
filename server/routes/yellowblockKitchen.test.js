import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import sharp from 'sharp';
import createRouter from './yellowblockKitchen.js';
import Workflow from '../models/YellowblockOrderWorkflow.js';
import Assignment from '../models/ThirdPartyDeliveryAssignment.js';
import Company from '../models/ThirdPartyDeliveryCompany.js';
import User from '../models/User.js';

test('kitchen responses hide addresses and preparation requires two photos before courier handoff', async (t) => {
  const order = {
    id: 123, name: '#123', phone: 'private phone',
    customer: { first_name: 'Test', last_name: 'Customer', email: 'private email' },
    shipping_address: { address1: 'Private street', city: 'Private city', province_code: 'DU', latitude: 25, longitude: 55 },
    line_items: [{ title: 'Box', quantity: 1, properties: [{ name: 'Address', value: 'Private detail' }] }],
  };
  let workflow;
  let assignment;
  const recordedUpdates = [];
  const query = result => ({
    select: () => query(result), populate: () => query(result), sort: () => query(result),
    lean: async () => result, then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  });
  t.mock.method(Workflow, 'findById', () => query(workflow));
  t.mock.method(Workflow, 'find', () => query(workflow ? [workflow] : []));
  t.mock.method(Workflow, 'findOneAndUpdate', (filter, update) => {
    assert.equal(filter._id, '123');
    if (filter.status.$in) assert.ok(filter.status.$in.includes(workflow?.status || 'pending'));
    else assert.equal(filter.status, workflow?.status || 'pending');
    recordedUpdates.push(update.$set);
    workflow = { ...update.$setOnInsert, ...workflow, ...update.$set, _id: filter._id };
    return query(workflow);
  });
  t.mock.method(Assignment, 'find', () => query(assignment ? [assignment] : []));
  t.mock.method(Assignment, 'updateOne', async ({ shopifyOrderId }, update) => {
    assignment = { ...update.$set, shopifyOrderId };
  });
  t.mock.method(Company, 'find', () => query([]));
  t.mock.method(User, 'find', () => query([{ _id: 'driver-1', profile: { firstName: 'Driver' } }]));

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { _id: 'fixture', role: req.get('x-fixture-role') || 'kitchen', profile: { firstName: 'Test Staff' } };
    next();
  });
  app.use(createRouter({
    getShopifyConfig: () => ({ configured: true, version: 'fixture' }),
    shopifyRequest: async path => ({ status: 200, headers: {}, body: path.includes('/123.json') ? { order } : { orders: [order] } }),
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/orders`;

  const list = await fetch(base);
  const { orders } = (await list.json()).data;
  assert.equal(orders[0].emirate, 'Dubai');
  assert.equal(orders[0].customerName, 'Test Customer');
  const detail = await fetch(`${base}/123`);
  const serialized = await detail.text();
  for (const sensitive of ['Private street', 'Private city', 'Private detail', 'private phone', 'private email', 'latitude', 'longitude', 'shipping_address']) {
    assert.ok(!serialized.includes(sensitive));
    assert.ok(!JSON.stringify(orders).includes(sensitive));
  }
  assert.equal(detail.headers.get('cache-control'), 'no-store');
  assert.equal(JSON.parse(serialized).data.canDispatch, false);

  const status = (stage, options = {}) => fetch(`${base}/123/status/${stage}`, { method: 'POST', ...options });
  assert.equal((await status('collected')).status, 403);
  assert.equal((await status('in_preparation')).status, 200);
  assert.equal((await status('in_preparation')).status, 409);
  const jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).jpeg().toBuffer();
  const form = new FormData();
  form.append('displayPhoto', new Blob([jpeg], { type: 'image/jpeg' }), 'first.jpg');
  assert.equal((await status('prepared', { body: form })).status, 400);
  assert.equal(workflow.status, 'in_preparation');
  form.append('boxedPhoto', new Blob([jpeg], { type: 'image/jpeg' }), 'second.jpg');
  assert.equal((await status('prepared', { body: form })).status, 200);
  assert.ok(Buffer.isBuffer(recordedUpdates[1].displayPhoto));
  assert.ok(Buffer.isBuffer(recordedUpdates[1].boxedPhoto));
  const storedPhoto = await fetch(`${base}/123/photos/boxedPhoto`);
  assert.equal(storedPhoto.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await storedPhoto.arrayBuffer()), recordedUpdates[1].boxedPhoto);

  const staff = { headers: { 'x-fixture-role': 'yellowblock_user', 'Content-Type': 'application/json' } };
  const couriersUrl = new URL('../couriers', `${base}/`);
  const batchUrl = new URL('../courier-assignments', `${base}/`);
  assert.equal((await fetch(couriersUrl)).status, 403);
  const courierOptions = await (await fetch(couriersUrl, staff)).json();
  assert.ok(courierOptions.data.some(option => option.id === 'driver:driver-1' && option.driver));
  const assignBatch = (orderIds, options = staff) => fetch(batchUrl, {
    ...options, method: 'PATCH', body: JSON.stringify({ orderIds, courierId: 'Lalamove' }),
  });
  assert.equal((await assignBatch(['123'], { headers: { 'Content-Type': 'application/json' } })).status, 403);
  assert.equal((await assignBatch(['invalid'])).status, 400);
  const batchResponse = await assignBatch(['123', '999', '123']);
  assert.equal(batchResponse.status, 200);
  assert.deepEqual((await batchResponse.json()).data, { courier: 'Lalamove', assigned: ['123'], failed: [{ orderId: '999', message: 'Order not found.' }] });
  assignment = undefined;
  assert.equal((await status('collected', staff)).status, 409);
  const courier = await fetch(`${base}/123/courier`, { ...staff, method: 'PATCH', body: JSON.stringify({ courierId: 'Lalamove' }) });
  assert.equal(courier.status, 200);
  assert.equal((await status('collected', staff)).status, 200);
  const delivered = await status('delivered', staff);
  assert.equal(delivered.status, 200);
  const { data } = await delivered.json();
  assert.deepEqual(data.timeline.map(event => event.status), ['in_preparation', 'prepared', 'collected', 'delivered']);
  assert.equal(data.timeline[2].courier, 'Lalamove');
  assert.equal(data.timeline[3].courier, 'Lalamove');
  assert.ok(!Object.hasOwn(data, 'displayPhoto'));
  const kitchenDetail = await (await fetch(`${base}/123`)).json();
  assert.deepEqual(kitchenDetail.data.timeline, []);
  assert.deepEqual(kitchenDetail.data.couriers, []);

  workflow = undefined;
  assignment = undefined;
  const assignDriver = await fetch(`${base}/123/courier`, { ...staff, method: 'PATCH', body: JSON.stringify({ courierId: 'driver:driver-1' }) });
  assert.equal(assignDriver.status, 200);
  assert.equal(workflow.status, 'pending');
  assert.equal(workflow.driverId, 'driver-1');
  assert.equal((await status('in_preparation')).status, 200);
  assert.equal((await status('prepared', { body: form })).status, 200);
  assert.equal(workflow.driverId, 'driver-1');
  assert.equal((await status('collected', staff)).status, 409);
});
