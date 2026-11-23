import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import Delivery from '../models/Delivery.js';
import deliveriesRouter from '../routes/deliveries.js';
import {
  customerListStatsPipeline,
  summarizeCustomerListStats,
} from './customerListStats.js';

test('C-A list counts ignore the first 500 global rows, cancelled rows and weekend combining', () => {
  const rows = [];
  for (let i = 0; i < 600; i += 1) {
    rows.push({
      customerId: `OTHER-${i}`,
      status: 'delivered',
      scheduledTime: '2024-01-01T00:00:00.000Z',
    });
  }
  rows.push(
    { customerId: 'C-A', status: 'delivered', lateMinutes: 10, scheduledTime: '2026-03-01T08:00:00.000Z' },
    { customerId: 'C-A', status: 'pending', scheduledTime: '2026-03-02T08:00:00.000Z' },
    { customerId: 'C-A', status: 'assigned', lateMinutes: 5, scheduledTime: '2026-03-03T08:00:00.000Z' },
    { customerId: 'C-A', status: 'picked_up', scheduledTime: '2026-03-04T08:00:00.000Z' },
    { customerId: 'C-A', status: 'on_route', scheduledTime: '2026-03-05T08:00:00.000Z' },
    { customerId: 'C-A', status: 'failed', scheduledTime: '2026-03-06T08:00:00.000Z' },
    { customerId: 'C-A', status: 'cancelled', scheduledTime: '2026-12-01T08:00:00.000Z' },
    { customerId: 'WEEKEND', status: 'delivered', scheduledTime: '2026-03-07T08:00:00.000Z' },
    { customerId: 'WEEKEND', status: 'delivered', scheduledTime: '2026-03-08T08:00:00.000Z' },
    { customerId: '', status: 'delivered', scheduledTime: '2026-03-09T08:00:00.000Z' },
  );

  const summary = summarizeCustomerListStats(rows);
  const customer = summary.find((row) => row.customerId === 'C-A');
  assert.equal(customer.totalDeliveries, 6);
  assert.equal(20 - customer.totalDeliveries, 14);
  assert.equal(customer.completedDeliveries, 1);
  assert.equal(customer.pendingDeliveries, 3);
  assert.equal(customer.lateDeliveries, 2);
  assert.equal(customer.totalLateMinutes, 15);
  assert.equal(customer.lastDeliveryDate, '2026-12-01T08:00:00.000Z');

  const weekend = summary.find((row) => row.customerId === 'WEEKEND');
  assert.equal(weekend.totalDeliveries, 2);
  assert.equal(summary.some((row) => !row.customerId), false);
  assert.equal(summary.length, 602);
});

test('customer list stats pipeline has no row limit and does not combine weekend stops', () => {
  const pipeline = customerListStatsPipeline();
  const serialized = JSON.stringify(pipeline);
  assert.equal(serialized.includes('"$limit"'), false);
  assert.equal(serialized.includes('"$skip"'), false);
  assert.equal(serialized.includes('weekend'), false);
  assert.equal(pipeline.some((stage) => Object.prototype.hasOwnProperty.call(stage, '$limit')), false);
  assert.deepEqual(pipeline[0].$match.customerId, { $nin: [null, ''] });
  assert.equal(pipeline[0].$match.status, undefined);
  assert.deepEqual(pipeline[1].$group.totalDeliveries, {
    $sum: { $cond: [{ $ne: ['$status', 'cancelled'] }, 1, 0] },
  });
  assert.deepEqual(pipeline[1].$group.completedDeliveries, {
    $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, 1, 0] },
  });
  assert.deepEqual(pipeline[1].$group.pendingDeliveries.$sum.$cond[0].$in[1], ['pending', 'assigned', 'picked_up']);
  assert.deepEqual(pipeline[1].$group.lastDeliveryDate, { $max: '$scheduledTime' });
});

test('customer list stats route aggregates instead of reading the capped delivery list', async () => {
  const original = {
    secret: process.env.JWT_SECRET,
    findById: User.findById,
    aggregate: Delivery.aggregate,
    find: Delivery.find,
  };
  process.env.JWT_SECRET = 'customer-list-stats-test-secret';
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
    return [{
      customerId: 'C-A',
      totalDeliveries: 6,
      completedDeliveries: 1,
      pendingDeliveries: 3,
      lateDeliveries: 2,
      totalLateMinutes: 15,
      lastDeliveryDate: new Date('2026-12-01T08:00:00.000Z'),
    }];
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
    assert.equal((await request('/api/deliveries/customer-list-stats')).status, 401);
    assert.equal((await request('/api/deliveries/customer-list-stats', 'driver')).status, 403);
    assert.equal((await request('/api/deliveries/customer-list-stats', 'denied')).status, 403);
    assert.equal(aggregateCalls.length, 0);
    assert.equal(finds, 0);

    const res = await request('/api/deliveries/customer-list-stats', 'dispatcher');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data[0].customerId, 'C-A');
    assert.equal(body.data[0].totalDeliveries, 6);
    assert.equal(20 - body.data[0].totalDeliveries, 14);
    assert.equal(aggregateCalls.length, 1);
    assert.equal(JSON.stringify(aggregateCalls[0]).includes('"$limit"'), false);
    assert.deepEqual(aggregateCalls[0], customerListStatsPipeline());
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
