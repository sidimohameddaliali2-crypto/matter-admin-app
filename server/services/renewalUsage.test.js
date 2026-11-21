import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import Delivery from '../models/Delivery.js';
import deliveriesRouter from '../routes/deliveries.js';
import {
  RENEWAL_IGNORED_STATUSES,
  remainingEntitlement,
  renewalUsagePipeline,
  summarizeRenewalUsage,
} from './renewalUsage.js';

const COUNTING_STATUSES = ['assigned', 'pending', 'on_route', 'picked_up', 'failed', 'completed'];

test('C-A stays at 6 consumed and 14 remaining when 600 other rows exist and its own rows are last', () => {
  const rows = [];
  for (let i = 0; i < 600; i += 1) {
    rows.push({
      customerId: `OTHER-${i}`,
      status: 'delivered',
      scheduledTime: '2024-01-01T00:00:00.000Z',
    });
  }
  COUNTING_STATUSES.forEach((status, index) => {
    rows.push({
      customerId: 'C-A',
      status,
      scheduledTime: `2026-03-${String(index + 1).padStart(2, '0')}T08:00:00.000Z`,
    });
  });
  rows.push({
    customerId: 'C-A',
    status: 'cancelled',
    scheduledTime: '2026-12-01T08:00:00.000Z',
  });
  rows.push({
    customerId: 'C-A',
    status: 'Cancelled',
    scheduledTime: '2026-12-02T08:00:00.000Z',
  });

  const summary = summarizeRenewalUsage(rows);
  const customer = summary.find((row) => row.customerId === 'C-A');
  assert.equal(customer.used, 6);
  assert.equal(remainingEntitlement(20, customer.used), 14);
  assert.equal(customer.lastScheduledTime, '2026-03-06T08:00:00.000Z');
  assert.equal(summary.length, 601);
  assert.equal(remainingEntitlement(20, 25), -5);
});

test('renewal usage pipeline has no row limit and excludes cancelled statuses', () => {
  const pipeline = renewalUsagePipeline();
  const serialized = JSON.stringify(pipeline);
  assert.equal(serialized.includes('"$limit"'), false);
  assert.equal(serialized.includes('"$skip"'), false);
  assert.equal(pipeline.some((stage) => Object.prototype.hasOwnProperty.call(stage, '$limit')), false);
  assert.deepEqual(pipeline[0].$match.status.$nin, [...RENEWAL_IGNORED_STATUSES]);
  assert.equal(pipeline[1].$group.used.$sum, 1);
  assert.deepEqual(pipeline[1].$group.lastScheduledTime, { $max: '$scheduledTime' });
  assert.equal(pipeline[0].$match.scheduledTime, undefined);
});

test('renewal usage route aggregates instead of reading the capped delivery list', async () => {
  const original = {
    secret: process.env.JWT_SECRET,
    findById: User.findById,
    aggregate: Delivery.aggregate,
    find: Delivery.find,
  };
  process.env.JWT_SECRET = 'renewal-usage-test-secret';
  const users = {
    renewal: { _id: 'renewal', role: 'viewer', isActive: true, permissionsConfigured: true, permissions: { renewal: true } },
    driver: { _id: 'driver', role: 'driver', isActive: true },
    dispatcher: { _id: 'dispatcher', role: 'dispatcher', isActive: true },
  };
  User.findById = (id) => ({ select: async () => users[id] || null });
  const aggregateCalls = [];
  let finds = 0;
  Delivery.aggregate = async (pipeline) => {
    aggregateCalls.push(pipeline);
    return [{ customerId: 'C-A', used: 6, lastScheduledTime: new Date('2026-03-06T08:00:00.000Z') }];
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
    assert.equal((await request('/api/deliveries/renewal-usage')).status, 401);
    assert.equal((await request('/api/deliveries/renewal-usage', 'driver')).status, 403);
    assert.equal((await request('/api/deliveries/renewal-usage', 'dispatcher')).status, 403);
    assert.equal(aggregateCalls.length, 0);
    assert.equal(finds, 0);

    const res = await request('/api/deliveries/renewal-usage', 'renewal');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data[0].customerId, 'C-A');
    assert.equal(body.data[0].used, 6);
    assert.equal(remainingEntitlement(20, body.data[0].used), 14);
    assert.equal(aggregateCalls.length, 1);
    assert.equal(JSON.stringify(aggregateCalls[0]).includes('"$limit"'), false);
    assert.deepEqual(aggregateCalls[0], renewalUsagePipeline());
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
