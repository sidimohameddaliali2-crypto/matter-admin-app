import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import drivers from './drivers.js';
import users from './users.js';
import auth from './auth.js';
import upload from './upload.js';
import employees from './employees.js';
import User from '../models/User.js';
import Delivery from '../models/Delivery.js';

const actorId = '507f1f77bcf86cd799439011';
const targetId = '507f1f77bcf86cd799439012';
const query = value => {
  const q = {};
  for (const name of ['select', 'populate', 'sort', 'skip', 'limit']) q[name] = () => q;
  q.lean = async () => value;
  q.then = (resolve, reject) => Promise.resolve(value).then(resolve, reject);
  return q;
};
async function fixture(t) {
  const previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'staff-boundary-fixture-private-key';
  t.after(() => { if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous; });
  const state = { actor: { _id: actorId, id: actorId, role: 'dispatcher', isActive: true, sessionVersion: 0 }, reads: 0, saves: 0, filters: [] };
  state.target = { _id: targetId, role: 'driver', isActive: true, email: 'fixture@example.com', password: 'private-hash', pushTokens: [{ token: 'private-push' }], sessionVersion: 7,
    profile: { firstName: 'Fixture', phone: 'fixture-phone', nationalId: 'private-id', baseSalary: 8000, licenseNumber: 'private-license', vacation: { allowanceDays: 30 }, deductions: [{ amount: 100 }] },
    save: async () => { state.saves++; }, toObject() { const { save, toObject, ...data } = this; return data; } };
  t.mock.method(User, 'findById', id => {
    if (String(id) === actorId) return query(state.actor);
    state.reads++; return query(state.target);
  });
  t.mock.method(User, 'find', filter => { state.reads++; state.filters.push(filter); return query([state.target]); });
  t.mock.method(User, 'findOne', () => { state.reads++; return query(state.target); });
  t.mock.method(User, 'findByIdAndUpdate', () => { state.saves++; return query(state.target); });
  t.mock.method(User, 'findOneAndUpdate', () => { state.saves++; return query(state.target); });
  t.mock.method(Delivery, 'aggregate', async () => []);
  t.mock.method(Delivery, 'find', () => { state.reads++; return query([]); });
  t.mock.method(Delivery, 'countDocuments', async () => 0);
  const app = express(); app.use(express.json());
  app.use('/api/drivers', drivers); app.use('/api/users/drivers', drivers);
  app.use('/api/users', users); app.use('/api/auth', auth); app.use('/api/upload', upload);
  app.use('/api/employees', employees);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const token = jwt.sign({ id: actorId, sessionVersion: 0 }, process.env.JWT_SECRET);
  const request = (path, { method = 'GET', body, anonymous = false } = {}) => fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
    method, headers: { ...(!anonymous ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined
  });
  return { state, request };
}

test('both driver mounts reject anonymous and low-permission reads before database work', async t => {
  const { state, request } = await fixture(t);
  for (const prefix of ['/drivers', '/users/drivers']) {
    for (const path of ['', '/locations', `/${targetId}`, `/${targetId}/location`, `/${targetId}/stats`, `/${targetId}/stats/weekly`, `/${targetId}/stats/monthly`]) {
      assert.equal((await request(prefix + path, { anonymous: true })).status, 401);
      for (const role of ['kitchen', 'yellowblock_user']) {
        state.actor.role = role;
        assert.equal((await request(prefix + path)).status, 403, `${role} ${path}`);
      }
    }
  }
  assert.equal(state.reads, 0);
  state.actor = { ...state.actor, role: 'admin', permissionsConfigured: true, permissions: { drivers: false, deliveries: false, fleet: false, live_map: false, bags: false, reports: false } };
  assert.equal((await request('/drivers')).status, 403);
  assert.equal((await request(`/drivers/${targetId}`, { method: 'PUT', body: { firstName: 'Changed' } })).status, 403);
  assert.equal(state.saves, 0);
  state.actor.isActive = false;
  assert.equal((await request('/drivers')).status, 401);
});

test('dispatcher directory and map are operational; administrator retains authorized HR view', async t => {
  const { state, request } = await fixture(t);
  for (const path of ['/drivers', '/users/drivers', '/drivers/locations']) {
    const response = await request(path); assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const data = await response.json(); assert.equal(data[0].profile.firstName, 'Fixture');
    const serialized = JSON.stringify(data);
    for (const field of ['private-id', 'private-hash', 'private-push', 'private-license', 'baseSalary', 'deductions', 'sessionVersion']) assert(!serialized.includes(field), field);
  }
  assert.equal((await request(`/drivers/${targetId}`)).status, 403);
  state.actor.role = 'admin';
  const data = await (await request('/drivers')).json();
  assert.equal(data[0].profile.nationalId, 'private-id'); assert.equal(data[0].password, undefined); assert.equal(data[0].pushTokens, undefined);
  const map = await (await request('/drivers/locations')).json(); assert.equal(map[0].profile.nationalId, undefined);
});

test('drivers can read and update their own operational data, never a teammate record', async t => {
  const { state, request } = await fixture(t); state.actor.role = 'driver';
  const response = await request('/drivers'); assert.equal(response.status, 200);
  assert.equal(state.filters.at(-1)._id, actorId);
  for (const path of [`/${targetId}`, `/${targetId}/location`, `/${targetId}/stats/weekly`, '/locations']) assert.equal((await request('/drivers' + path)).status, 403);
  const body = { latitude: 25.2, longitude: 55.3 };
  assert.equal((await request(`/drivers/${targetId}/location`, { method: 'PUT', body })).status, 403);
  state.target._id = actorId;
  const own = await request(`/drivers/${actorId}/location`, { method: 'PUT', body }); assert.equal(own.status, 200);
  assert.equal((await own.json()).driver.profile.nationalId, undefined);
  assert.equal((await request(`/drivers/${actorId}/stats/weekly`)).status, 200);
});

test('shared logo changes require administrator before upload handling; prototype returns is removed', async t => {
  const { state, request } = await fixture(t);
  assert.equal((await request('/upload/bag-tag-logo', { method: 'POST', anonymous: true })).status, 401);
  for (const role of ['driver', 'viewer', 'kitchen', 'dispatcher', 'manager']) {
    state.actor.role = role;
    assert.equal((await request('/upload/bag-tag-logo', { method: 'POST' })).status, 403);
  }
  state.actor.role = 'admin';
  assert.equal((await request('/upload/bag-tag-logo', { method: 'POST' })).status, 400);
  assert.equal((await request('/drivers/returns', { method: 'POST' })).status, 404);
});

test('user-management permission and super-admin target boundary block account changes', async t => {
  const { state, request } = await fixture(t);
  assert.equal((await request(`/users/${targetId}`)).status, 403);
  assert.equal(state.reads, 0);
  assert.equal((await request(`/users/${actorId}`, { method: 'PUT', body: { permissions: { users: true } } })).status, 403);
  state.actor = { ...state.actor, role: 'admin', permissionsConfigured: true, permissions: { users: false } };
  for (const [path, method] of [['/users', 'GET'], ['/users', 'POST'], ['/auth/register', 'POST'], [`/users/${targetId}`, 'PUT']]) assert.equal((await request(path, { method, body: method === 'POST' ? {} : undefined })).status, 403);
  state.actor.permissions.users = true; state.target.role = 'super_admin';
  assert.equal((await request(`/users/${targetId}`, { method: 'PUT', body: { firstName: 'Changed' } })).status, 403);
  assert.equal((await request(`/users/${targetId}`, { method: 'PUT', body: { isActive: false } })).status, 403);
  assert.equal(state.saves, 0);
  state.target.role = 'driver';
  assert.equal((await request(`/users/${targetId}`, { method: 'PUT', body: { permissions: { users: 'true' } } })).status, 400);
  const update = await request(`/users/${targetId}`, { method: 'PUT', body: { firstName: 'Changed' } });
  assert.equal(update.status, 200); assert.equal(state.saves, 1);
  const result = await update.json(); assert.equal(result.password, undefined); assert.equal(result.sessionVersion, undefined); assert.equal(result.pushTokens, undefined);
});

test('self profile update returns an allowlisted account response', async t => {
  const { request } = await fixture(t);
  const response = await request('/auth/profile', { method: 'PUT', body: { firstName: 'Fixture' } });
  assert.equal(response.status, 200);
  const { data } = await response.json();
  for (const key of ['password', 'pushTokens', 'sessionVersion']) assert.equal(data.user[key], undefined);
});

test('employee administration honors explicit permission denial as well as role boundaries', async t => {
  const { state, request } = await fixture(t);
  for (const role of ['driver', 'viewer', 'kitchen', 'dispatcher']) {
    state.actor.role = role;
    assert.equal((await request('/employees')).status, 403);
  }
  state.actor = { ...state.actor, role: 'manager', permissionsConfigured: true, permissions: { employees: false } };
  assert.equal((await request('/employees')).status, 403);
  assert.equal(state.reads, 0);
});
