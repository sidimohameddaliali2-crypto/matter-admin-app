import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import Customer from '../models/Customer.js';
import Delivery from '../models/Delivery.js';
import customersRouter from '../routes/customers.js';
import authRouter from '../routes/auth.js';
import externalRouter from '../routes/externalDeliveryApi.js';
import { authenticateStaffToken } from '../middleware/auth.js';
import { authenticateSocket, registerStaffSocket } from '../middleware/socketAuth.js';

// Exercise the complete HTTP middleware chain, with no database or external API.
test('staff API and socket security boundaries', async (t) => {
  const original = {
    secret: process.env.JWT_SECRET, keys: process.env.DELIVERY_API_KEYS,
    findById: User.findById, findOne: User.findOne, create: User.create,
    customerFind: Customer.find, customerUpdate: Customer.findOneAndUpdate,
    deliveryExists: Delivery.exists, deliveryFindOne: Delivery.findOne,
  };
  process.env.JWT_SECRET = 'security-test-fixture-secret';
  process.env.DELIVERY_API_KEYS = 'fixture:security-test-api-key';
  const users = {
    admin: { _id: 'admin', role: 'admin', isActive: true },
    super_admin: { _id: 'super_admin', role: 'super_admin', isActive: true },
    dispatcher: { _id: 'dispatcher', role: 'dispatcher', isActive: true },
    driver: { _id: 'driver', role: 'driver', isActive: true },
    kitchen: { _id: 'kitchen', role: 'kitchen', isActive: true },
    inactive: { _id: 'inactive', role: 'admin', isActive: false },
    denied: { _id: 'denied', role: 'dispatcher', isActive: true, permissionsConfigured: true, permissions: { customers: false } },
    renewal: { _id: 'renewal', role: 'viewer', isActive: true, permissionsConfigured: true, permissions: { renewal: true } },
  };
  User.findById = (id) => ({ select: async () => users[id] || null });
  User.findOne = async () => null;
  let creates = 0;
  User.create = async (input) => { creates++; return { ...input, _id: 'new-user' }; };
  let reads = 0;
  let writes = 0;
  Customer.find = () => {
    reads++;
    return { select() { return this; }, sort() { return this; }, async limit() { return [{ customerId: 'fixture' }]; } };
  };
  Customer.findOneAndUpdate = async () => { writes++; return { customerId: 'fixture' }; };
  Delivery.exists = async ({ customerId, driver }) => customerId === 'assigned' && driver === 'driver';
  Delivery.findOne = (filter) => {
    assert.equal(filter.driver, 'driver');
    return { sort() { return this; }, async lean() { return { address: 'Assigned address', zone: 'Fixture' }; } };
  };
  const tokenFor = (id) => jwt.sign({ id }, process.env.JWT_SECRET);
  const app = express();
  app.use(express.json());
  app.use('/api/customers', customersRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/external/deliveries', externalRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { user, token, method = 'GET', body } = {}) => fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(user || token ? { Authorization: `Bearer ${token || tokenFor(user)}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    await t.test('every customer route rejects missing or invalid authentication before data access', async () => {
      for (const layer of customersRouter.stack.filter((entry) => entry.route)) {
        for (const method of Object.keys(layer.route.methods)) {
          const path = '/api/customers' + layer.route.path.replace(/:[^/]+/g, 'fixture');
          for (const token of [undefined, 'invalid', tokenFor('inactive'), jwt.sign({ partnerId: 'fixture' }, process.env.JWT_SECRET)]) {
            const res = await request(path, { method: method.toUpperCase(), token });
            assert.equal(res.status, 401, `${method} ${path}`);
          }
        }
      }
      assert.equal(reads, 0);
      assert.equal(writes, 0);
    });
    await t.test('authorized staff can list customers and dispatchers can update them', async () => {
      const res = await request('/api/customers', { user: 'dispatcher' });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).count, 1);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal((await request('/api/customers/fixture', { user: 'dispatcher', method: 'PATCH', body: { firstName: 'Fixture' } })).status, 200);
      assert.equal(writes, 1);
    });
    await t.test('drivers and kitchen cannot list customers or edit them; explicit permission denial blocks writes', async () => {
      for (const user of ['driver', 'kitchen']) {
        assert.equal((await request('/api/customers', { user })).status, 403);
        assert.equal((await request('/api/customers/fixture', { user, method: 'PATCH', body: { firstName: 'Fixture' } })).status, 403);
      }
      assert.equal((await request('/api/customers/fixture', { user: 'denied', method: 'PATCH', body: { firstName: 'Fixture' } })).status, 403);
      assert.equal(writes, 1);
    });
    await t.test('renewal staff retain read access without gaining arbitrary customer writes', async () => {
      assert.equal((await request('/api/customers', { user: 'renewal' })).status, 200);
      assert.equal((await request('/api/customers/fixture', { user: 'renewal', method: 'PATCH', body: { firstName: 'Fixture' } })).status, 403);
    });
    await t.test('drivers cannot request another customer location', async () => {
      assert.equal((await request('/api/customers/unassigned/location', { user: 'driver' })).status, 403);
      const assigned = await request('/api/customers/assigned/location', { user: 'driver' });
      assert.equal(assigned.status, 200);
      assert.equal((await assigned.json()).data.address, 'Assigned address');
    });
    const registration = { email: 'fixture@example.invalid', password: 'fixture-only-password', firstName: 'Fixture', lastName: 'User', role: 'super_admin' };
    await t.test('registration requires an admin and respects the super-admin hierarchy', async () => {
      for (const [user, expected] of [[undefined, 401], ['driver', 403], ['dispatcher', 403], ['admin', 403]]) {
        assert.equal((await request('/api/auth/register', { user, method: 'POST', body: registration })).status, expected);
      }
      assert.equal(creates, 0);
      assert.equal((await request('/api/auth/register', { user: 'admin', method: 'POST', body: { ...registration, role: 'driver' } })).status, 201);
      assert.equal((await request('/api/auth/register', { user: 'super_admin', method: 'POST', body: registration })).status, 201);
      assert.equal(creates, 2);
    });
    await t.test('staff authentication fails closed without a configured JWT secret', async () => {
      const token = tokenFor('admin');
      delete process.env.JWT_SECRET;
      await assert.rejects(authenticateStaffToken(token));
      process.env.JWT_SECRET = 'security-test-fixture-secret';
    });
    await t.test('external delivery API still rejects missing and invalid keys', async () => {
      assert.equal((await request('/api/external/deliveries')).status, 401);
      assert.equal((await request('/api/external/deliveries', { token: 'invalid-key' })).status, 401);
    });
    await t.test('sockets reject anonymous, invalid, inactive and non-staff credentials', async () => {
      for (const token of [undefined, 'invalid', tokenFor('inactive'), jwt.sign({ memberId: 'fixture' }, process.env.JWT_SECRET)]) {
        await authenticateSocket({ handshake: { auth: { token } }, data: {} }, (error) => assert.equal(error.message, 'Not authorized'));
      }
      const socket = { handshake: { auth: { token: tokenFor('driver') } }, data: {} };
      await authenticateSocket(socket, (error) => assert.equal(error, undefined));
      assert.equal(socket.data.user._id, 'driver');
    });
    await t.test('driver rooms are restricted to self and client events cannot forge status broadcasts', () => {
      const rooms = [];
      const handlers = {};
      registerStaffSocket({ data: { user: users.driver }, join: (room) => rooms.push(room), on: (event, handler) => { handlers[event] = handler; } });
      assert.deepEqual(rooms, ['driver:driver']);
      handlers['driver:join']('someone-else');
      assert.deepEqual(rooms, ['driver:driver']);
      assert.equal(handlers['delivery:statusUpdate'], undefined);
      assert.equal(handlers['driver:statusUpdate'], undefined);
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    User.findById = original.findById;
    User.findOne = original.findOne;
    User.create = original.create;
    Customer.find = original.customerFind;
    Customer.findOneAndUpdate = original.customerUpdate;
    Delivery.exists = original.deliveryExists;
    Delivery.findOne = original.deliveryFindOne;
    if (original.secret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = original.secret;
    if (original.keys === undefined) delete process.env.DELIVERY_API_KEYS;
    else process.env.DELIVERY_API_KEYS = original.keys;
  }
});
