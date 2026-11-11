import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import Delivery from '../models/Delivery.js';
import deliveriesRouter from '../routes/deliveries.js';
import {
  countCustomerDetailUsage,
  customerDetailUsagePipeline,
} from './customerDetailUsage.js';

const SINCE = '2026-03-01T00:00:00.000Z';

test('C-A detail usage keeps the plan-start comparison past the 500-row page and does not combine weekends', () => {
  const rows = [];
  for (let i = 0; i < 600; i += 1) {
    rows.push({
      customerId: `OTHER-${i}`,
      status: 'delivered',
      scheduledTime: '2026-04-01T08:00:00.000Z',
    });
  }
  rows.push(
    { customerId: 'C-A', status: 'delivered', scheduledTime: '2026-02-01T08:00:00.000Z' },
    { customerId: 'C-A', status: 'delivered', scheduledTime: '2026-03-01T08:00:00.000Z' },
    { customerId: 'C-A', status: 'pending', scheduledTime: '2026-03-02T08:00:00.000Z' },
    { customerId: 'C-A', status: 'cancelled', scheduledTime: '2026-03-03T08:00:00.000Z' },
    { customerId: 'C-A', status: 'delivered', scheduledTime: '2026-03-07T08:00:00.000Z' },
    { customerId: 'C-A', status: 'delivered', scheduledTime: '2026-03-08T08:00:00.000Z' },
    { customerId: 'C-A', status: 'delivered', scheduledTime: null },
  );

  const used = countCustomerDetailUsage(rows, { customerId: 'C-A', since: SINCE });
  assert.equal(used, 5);
  assert.equal(20 - used, 15);
  assert.equal(countCustomerDetailUsage(rows, { customerId: 'C-A' }), 7);
  assert.equal(countCustomerDetailUsage(rows, { customerId: 'C-A', since: 'not-a-date' }), 0);

  const many = Array.from({ length: 25 }, (_, index) => ({
    customerId: 'C-A',
    status: 'cancelled',
    scheduledTime: `2026-05-${String((index % 28) + 1).padStart(2, '0')}T08:00:00.000Z`,
  }));
  assert.equal(countCustomerDetailUsage(many, { customerId: 'C-A', since: SINCE }), 25);
});

test('customer detail usage pipeline has no row limit and does not drop cancelled or weekend rows', () => {
  const pipeline = customerDetailUsagePipeline({ customerId: 'C-A', since: SINCE });
  const serialized = JSON.stringify(pipeline);
  assert.equal(serialized.includes('"$limit"'), false);
  assert.equal(serialized.includes('"$skip"'), false);
  assert.equal(serialized.includes('weekend'), false);
  assert.equal(pipeline[0].$match.status, undefined);
  assert.equal(pipeline[0].$match.customerId, 'C-A');
  assert.equal(pipeline[0].$match.scheduledTime.$gte.toISOString(), SINCE);
  assert.equal(pipeline[1].$count, 'used');
  assert.equal(customerDetailUsagePipeline({ customerId: 'C-A' })[0].$match.scheduledTime, undefined);
  assert.deepEqual(customerDetailUsagePipeline({ customerId: 'C-A', since: 'not-a-date' })[0].$match._id, { $exists: false });
});

test('customer detail usage route aggregates instead of reading the capped delivery list', async () => {
  const original = {
    secret: process.env.JWT_SECRET,
    findById: User.findById,
    aggregate: Delivery.aggregate,
    find: Delivery.find,
  };
  process.env.JWT_SECRET = 'customer-detail-usage-test-secret';
  const users = {
    dispatcher: { _id: 'dispatcher', role: 'dispatcher', isActive: true },
    driver: { _id: 'driver', role: 'driver', isActive: true },
    denied: {
      _id: 'denied',
      role: 'dispatcher',
      isActive: true,
      permissionsConfigured: true,
      permissions: { customers: false },
    },
  };
  User.findById = (id) => ({ select: async () => users[id] || null });
  const aggregateCalls = [];
  let finds = 0;
  Delivery.aggregate = async (pipeline) => {
    aggregateCalls.push(pipeline);
    return [{ used: 5 }];
  };
  Delivery.find = () => {
    finds += 1;
    return { limit() { return this; }, skip() { return this; }, sort() { return this; }, populate() { return this; }, lean: async () => [] };
  };
  const tokenFor = (id) => jwt.sign({ id }, process.env.JWT_SECRET);
  const app = express();
  app.use('/api/deliveries', deliveriesRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, user) => fetch(base + path, {
    headers: user ? { Authorization: `Bearer ${tokenFor(user)}` } : {},
  });
  try {
    assert.equal((await request('/api/deliveries/customer-detail-usage')).status, 401);
    assert.equal((await request('/api/deliveries/customer-detail-usage?customerId=C-A', 'driver')).status, 403);
    assert.equal((await request('/api/deliveries/customer-detail-usage?customerId=C-A', 'denied')).status, 403);
    assert.equal((await request('/api/deliveries/customer-detail-usage', 'dispatcher')).status, 400);
    assert.equal(aggregateCalls.length, 0);
    assert.equal(finds, 0);

    const invalid = await request('/api/deliveries/customer-detail-usage?customerId=C-A&since=not-a-date', 'dispatcher');
    assert.equal(invalid.status, 200);
    assert.equal((await invalid.json()).data.used, 0);
    assert.equal(aggregateCalls.length, 0);

    const res = await request(`/api/deliveries/customer-detail-usage?customerId=C-A&since=${encodeURIComponent(SINCE)}`, 'dispatcher');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.customerId, 'C-A');
    assert.equal(body.data.used, 5);
    assert.equal(20 - body.data.used, 15);
    assert.equal(aggregateCalls.length, 1);
    assert.equal(JSON.stringify(aggregateCalls[0]).includes('"$limit"'), false);
    assert.deepEqual(aggregateCalls[0], customerDetailUsagePipeline({ customerId: 'C-A', since: SINCE }));
    assert.equal(finds, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    process.env.JWT_SECRET = original.secret;
    User.findById = original.findById;
    Delivery.aggregate = original.aggregate;
    Delivery.find = original.find;
  }
});
