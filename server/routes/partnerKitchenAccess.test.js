import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import SpaceOrder from '../models/SpaceOrder.js';
import menus from './menus.js';

test('partner kitchen feed requires staff authentication and kitchen page permissions', async t => {
  const oldSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'kitchen-order-fixture-secret';
  t.after(() => { if (oldSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = oldSecret; });
  const users = {
    kitchen: { _id: 'kitchen', role: 'kitchen', isActive: true },
    admin: { _id: 'admin', role: 'admin', isActive: true },
    driver: { _id: 'driver', role: 'driver', isActive: true },
    denied: { _id: 'denied', role: 'kitchen', isActive: true, permissionsConfigured: true, permissions: { kitchen_list: false, kitchen_counting: false } },
    allowed: { _id: 'allowed', role: 'manager', isActive: true, permissionsConfigured: true, permissions: { kitchen_counting: true } },
  };
  t.mock.method(User, 'findById', id => ({ select: async () => users[id] }));
  let reads = 0;
  t.mock.method(SpaceOrder, 'find', () => {
    reads++;
    return { populate() { return this; }, sort: async () => [] };
  });
  const app = express(); app.use('/api/menus', menus);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/menus/kitchen-partner-orders?date=2026-10-31`;
  const request = id => fetch(url, { headers: id ? { Authorization: `Bearer ${jwt.sign({ id }, process.env.JWT_SECRET)}` } : {} });
  assert.equal((await request()).status, 401);
  assert.equal((await request('driver')).status, 403);
  assert.equal((await request('denied')).status, 403);
  assert.equal(reads, 0);
  for (const id of ['kitchen', 'admin', 'allowed']) {
    const response = await request(id);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.totalQuantity, 0);
  }
  assert.equal(reads, 3);
});
