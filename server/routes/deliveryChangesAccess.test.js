import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import axios from 'axios';
import router from './deliveryChanges.js';
import User from '../models/User.js';
import Delivery from '../models/Delivery.js';
import Change from '../models/DeliveryChange.js';

const staffId = '507f1f77bcf86cd799439011';
const changeId = '507f1f77bcf86cd799439012';
const deliveryId = '507f1f77bcf86cd799439013';
const input = { customerId: 'fixture-customer', customerName: 'Fixture Customer', scheduledDate: '2099-01-01', changes: { notes: 'Fixture change' } };
function query(value) {
  const chain = {};
  for (const method of ['populate', 'select', 'sort', 'limit', 'skip']) chain[method] = () => chain;
  chain.lean = async () => value;
  chain.then = (resolve, reject) => Promise.resolve(value).then(resolve, reject);
  return chain;
}
async function fixture(t) {
  const previous = { key: process.env.JWT_SECRET, slack: process.env.ENABLE_SLACK_NOTIFICATIONS };
  process.env.JWT_SECRET = 'delivery-changes-fixture-signing-key';
  process.env.ENABLE_SLACK_NOTIFICATIONS = '0';
  t.after(() => {
    for (const [name, value] of [['JWT_SECRET', previous.key], ['ENABLE_SLACK_NOTIFICATIONS', previous.slack]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const state = { actor: { _id: staffId, id: staffId, role: 'dispatcher', isActive: true, sessionVersion: 0, permissionsConfigured: true, permissions: { delivery_changes: true } }, reads: 0, saved: [], updates: [], logs: [] };
  t.mock.method(console, 'log', (...args) => { state.logs.push(args); });
  t.mock.method(console, 'error', () => {});
  t.mock.method(axios, 'post', () => assert.fail('No external notifications may be sent during fixture tests'));
  t.mock.method(User, 'findById', () => ({ select: async () => state.actor }));
  t.mock.method(User, 'findOne', async () => { state.reads++; return null; });
  t.mock.method(Change.prototype, 'save', async function () { state.saved.push(this.toObject()); return this; });
  t.mock.method(Change.prototype, 'populate', async function () { return this; });
  t.mock.method(Delivery, 'find', () => { state.reads++; return query([]); });
  const delivery = { _id: deliveryId, customerId: input.customerId, scheduledTime: new Date(input.scheduledDate), notes: 'Previous', timeline: [], save: async function () { return this; }, toObject() { const { save, toObject, ...data } = this; return data; } };
  t.mock.method(Delivery, 'findOne', () => { state.reads++; return query(delivery); });
  t.mock.method(Delivery, 'findByIdAndUpdate', async (id, update) => { state.updates.push(update); return { ...delivery, ...update.$set, toObject: delivery.toObject }; });
  t.mock.method(Delivery, 'findById', () => query(delivery));
  const change = { _id: changeId, customerId: input.customerId, scheduledDate: new Date(input.scheduledDate), status: 'pending', changes: input.changes, save: async function () { return this; } };
  t.mock.method(Change, 'findById', () => { state.reads++; return query(change); });
  t.mock.method(Change, 'find', () => { state.reads++; return query([]); });
  t.mock.method(Change, 'countDocuments', async () => 0);
  const app = express(); app.use(express.json()); app.use('/api/delivery-changes', router);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const token = jwt.sign({ id: staffId, sessionVersion: 0 }, process.env.JWT_SECRET, { algorithm: 'HS256' });
  const request = (path, { method = 'GET', body, anonymous = false } = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/delivery-changes${path}`, {
    method, headers: { ...(!anonymous ? { Authorization: `Bearer ${token}` } : {}), ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  return { state, request, token };
}

test('every operational/diagnostic/upload path rejects anonymous and unpermitted accounts before model work', async t => {
  const { state, request } = await fixture(t);
  const paths = [['', 'GET'], ['/manual', 'POST'], ['/pending', 'GET'], [`/debug/${changeId}`, 'GET'], ['/debug/customer/fixture', 'GET'], [`/${changeId}/apply`, 'POST'], [`/apply/${changeId}`, 'POST'], ['/upload', 'POST'], ['/test', 'GET'], ['/test-post', 'POST']];
  for (const [path, method] of paths) assert.equal((await request(path, { method, anonymous: true })).status, 401, path);
  for (const role of ['driver', 'viewer', 'kitchen']) {
    state.actor = { ...state.actor, role, permissionsConfigured: false };
    for (const [path, method] of paths) assert.equal((await request(path, { method })).status, 403, `${role} ${path}`);
  }
  state.actor = { ...state.actor, role: 'admin', permissionsConfigured: true, permissions: { delivery_changes: false } };
  assert.equal((await request('/manual', { method: 'POST', body: input })).status, 403);
  state.actor.isActive = false;
  assert.equal((await request('')).status, 401);
  assert.equal(state.reads, 0);
  assert.equal(state.saved.length, 0);
});

test('diagnostics are admin-only and obsolete echo endpoints are removed', async t => {
  const { state, request } = await fixture(t);
  assert.equal((await request(`/debug/${changeId}`)).status, 403);
  assert.equal((await request('/debug/customer/fixture')).status, 403);
  assert.equal(state.reads, 0);
  state.actor.role = 'admin';
  const debug = await request(`/debug/${changeId}`);
  assert.equal(debug.status, 200);
  assert.equal(debug.headers.get('cache-control'), 'no-store');
  assert.equal((await request('/debug/customer/fixture')).status, 200);
  assert.equal((await request('/test')).status, 404);
  assert.equal((await request('/test-post', { method: 'POST', body: {} })).status, 404);
});

test('authorized manual changes retain staff attribution and reject unbounded ranges/fields before writes', async t => {
  const { state, request, token } = await fixture(t);
  const invalid = [
    { ...input, endDate: '2101-01-01' }, { ...input, endDate: '2098-12-31' },
    { ...input, scheduledDate: 'invalid' }, { ...input, customerId: { $ne: null } },
    { ...input, changes: { status: 'delivered' } }, { ...input, daysOfWeek: [8] },
  ];
  for (const body of invalid) assert.equal((await request('/manual', { method: 'POST', body })).status, 400);
  assert.equal(state.reads, 0);
  const result = await request('/manual', { method: 'POST', body: { ...input, endDate: '2099-01-02' } });
  assert.equal(result.status, 201);
  assert.equal((await result.json()).count, 2);
  assert.equal(state.saved.length, 2);
  assert.equal(String(state.saved[0].uploadedBy), staffId);
  assert(!JSON.stringify(state.logs).includes(token), 'Authorization header must not be logged');
});

test('CSV uploads work under ESM and reject oversized rows/batches before any change writes', async t => {
  const { state, request } = await fixture(t);
  const upload = content => {
    const body = new FormData(); body.set('file', new Blob([content], { type: 'text/csv' }), 'changes.csv');
    return request('/upload', { method: 'POST', body });
  };
  const header = 'customerId,customerName,scheduledDate,endDate,notes\n';
  const valid = await upload(header + 'fixture,Fixture,2099-01-01,,Fixture note\n');
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).processed, 1);
  const count = state.saved.length; const reads = state.reads;
  assert.equal((await upload(header + Array.from({ length: 501 }, () => 'fixture,Fixture,2099-01-01,,Fixture note\n').join(''))).status, 400);
  assert.equal((await upload(header + Array.from({ length: 3 }, () => 'fixture,Fixture,2099-01-01,2099-12-31,Fixture note\n').join(''))).status, 400);
  assert.equal((await upload(header + `fixture,Fixture,2099-01-01,,${'x'.repeat(65536)}\n`)).status, 400);
  assert.equal(state.saved.length, count);
  assert.equal(state.reads, reads);
});

test('authorized dispatchers can list/apply changes without diagnostics and pagination is bounded', async t => {
  const { state, request } = await fixture(t);
  const list = await request(''); assert.equal(list.status, 200);
  assert.equal((await list.json()).currentPage, 1);
  const reads = state.reads;
  for (const query of ['?limit=0', '?limit=100000', '?page=-1', '?limit=2.5']) assert.equal((await request(query)).status, 400);
  assert.equal(state.reads, reads);
  assert.equal((await request(`/${changeId}/apply`, { method: 'POST' })).status, 200);
  assert(state.updates.length > 0);
});
