import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { Server } from 'socket.io';
import User from '../models/User.js';
import authRouter from '../routes/auth.js';
import { protect, authenticateStaffToken } from '../middleware/auth.js';
import { authenticateSocket, registerStaffSocket } from '../middleware/socketAuth.js';
import { generateStaffToken } from './staffSessionService.js';

// Real hashing, Mongoose save hooks, HTTP middleware and Socket.IO connections;
// only persistence is replaced with fixtures. Never connect to a live database.
test('staff password changes revoke sessions without expiring routine logins', { timeout: 30000 }, async (t) => {
  const original = {
    secret: process.env.JWT_SECRET,
    findById: User.findById,
    findOne: User.findOne,
    updateOne: User.collection.updateOne,
    collectionFindOne: User.collection.findOne
  };
  process.env.JWT_SECRET = 'staff-session-test-fixture-only';
  const userId = '650000000000000000000001';
  const otherId = '650000000000000000000002';
  const concurrentId = '650000000000000000000003';
  const password = 'fixture-current-password';
  const hashed = await bcrypt.hash(password, 4);
  const records = new Map([userId, otherId, concurrentId].map((_id) => [_id, {
    _id, email: `${_id}@example.invalid`, password: hashed,
    role: 'driver', isActive: true, profile: { firstName: 'Fixture' }
  }]));
  const writes = [];
  const queryFor = (record) => ({
    select: async () => record ? User.hydrate(structuredClone(record)) : null,
    then: (resolve, reject) => Promise.resolve(record ? User.hydrate(structuredClone(record)) : null).then(resolve, reject)
  });
  User.findById = (id) => queryFor(records.get(String(id)));
  User.findOne = ({ email }) => queryFor([...records.values()].find((record) => record.email === email));
  User.collection.findOne = async ({ _id }) => structuredClone(records.get(String(_id)) || null);
  const setField = (record, field, value) => {
    const keys = field.split('.');
    const last = keys.pop();
    const parent = keys.reduce((value, key) => value[key] ||= {}, record);
    parent[last] = value;
  };
  User.collection.updateOne = async (filter, update) => {
    const record = records.get(String(filter._id));
    if (!record) return { matchedCount: 0, modifiedCount: 0 };
    writes.push(structuredClone(update));
    for (const [field, value] of Object.entries(update.$set || {})) setField(record, field, value);
    for (const [field, value] of Object.entries(update.$inc || {})) {
      assert.ok(!field.includes('.'), 'fixture increments are top-level');
      record[field] = (record[field] || 0) + value;
    }
    return { matchedCount: 1, modifiedCount: 1 };
  };

  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.get('/protected', protect, (req, res) => res.json({ id: String(req.user._id) }));
  const server = http.createServer(app);
  const io = new Server(server);
  app.set('io', io);
  io.use(authenticateSocket);
  io.on('connection', (socket) => {
    registerStaffSocket(socket).then(() => {
      if (socket.connected) socket.emit('test:ready');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { token, method = 'GET', body } = {}) => fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const legacy = (id) => jwt.sign({ id, iat: 946684800 }, process.env.JWT_SECRET);
  const sockets = [];
  const connect = (token) => new Promise((resolve, reject) => {
    const client = new WebSocket(base.replace('http:', 'ws:') + '/socket.io/?EIO=4&transport=websocket');
    const events = [];
    const closed = new Promise((done) => client.addEventListener('close', done, { once: true }));
    const timer = setTimeout(() => { client.close(); reject(new Error('Socket test timed out')); }, 4000);
    sockets.push(client);
    client.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Socket transport failed')); });
    client.addEventListener('message', ({ data }) => {
      const packet = String(data);
      if (packet.startsWith('0')) client.send('40' + JSON.stringify({ token }));
      if (packet === '2') client.send('3');
      if (packet.startsWith('44')) {
        clearTimeout(timer);
        client.close();
        reject(new Error(JSON.parse(packet.slice(2)).message));
      }
      if (packet.startsWith('42')) {
        const [event] = JSON.parse(packet.slice(2));
        events.push(event);
        if (event === 'test:ready') {
          clearTimeout(timer);
          resolve({ client, events, closed });
        }
      }
    });
  });
  let oldToken;
  let otherToken;
  try {
    await t.test('legacy and new version-zero sessions remain usable without a scheduled expiry', async () => {
      oldToken = legacy(userId);
      otherToken = legacy(otherId);
      assert.equal((await request('/protected', { token: oldToken })).status, 200);
      const res = await request('/api/auth/login', {
        method: 'POST', body: { email: records.get(userId).email, password }
      });
      assert.equal(res.status, 200);
      const { token } = (await res.json()).data;
      const claims = jwt.verify(token, process.env.JWT_SECRET);
      assert.equal(claims.sessionVersion, 0);
      assert.equal(claims.exp, undefined);
      assert.equal((await request('/protected', { token })).status, 200);
      assert.equal(records.get(userId).sessionVersion ?? 0, 0, 'ordinary login does not revoke sessions');
    });

    await t.test('a wrong current password makes no credential or session changes', async () => {
      const before = writes.length;
      const res = await request('/api/auth/change-password', {
        token: oldToken, method: 'PUT', body: { currentPassword: 'incorrect', newPassword: 'fixture-new-password' }
      });
      assert.equal(res.status, 401);
      assert.equal(writes.length, before);
      assert.equal((await request('/protected', { token: oldToken })).status, 200);
    });

    await t.test('password changes revoke old HTTP tokens and live sockets, without affecting another user', async () => {
      const active = await connect(oldToken);
      const other = await connect(otherToken);
      const versionZeroToken = generateStaffToken({ _id: userId, sessionVersion: 0 });
      const res = await request('/api/auth/change-password', {
        token: oldToken, method: 'PUT', body: { currentPassword: password, newPassword: 'fixture-new-password' }
      });
      assert.equal(res.status, 200);
      assert.equal(records.get(userId).sessionVersion, 1);
      assert.equal(await bcrypt.compare('fixture-new-password', records.get(userId).password), true);
      assert.equal(await bcrypt.compare(password, records.get(userId).password), false);
      assert.equal(writes.at(-1).$inc.sessionVersion, 1);
      for (const token of [oldToken, versionZeroToken]) {
        assert.equal((await request('/protected', { token })).status, 401);
        await assert.rejects(connect(token), /Not authorized/);
      }
      await active.closed;
      assert.ok(active.events.includes('auth:revoked'));
      assert.equal(other.client.readyState, WebSocket.OPEN);
      assert.equal(other.events.includes('auth:revoked'), false);
      assert.equal((await request('/protected', { token: otherToken })).status, 200);
    });

    await t.test('only the new password signs in and obtains working version-one HTTP and socket access', async () => {
      const login = (candidate) => request('/api/auth/login', {
        method: 'POST', body: { email: records.get(userId).email, password: candidate }
      });
      assert.equal((await login(password)).status, 401);
      const res = await login('fixture-new-password');
      assert.equal(res.status, 200);
      const token = (await res.json()).data.token;
      assert.equal(jwt.verify(token, process.env.JWT_SECRET).sessionVersion, 1);
      assert.equal((await request('/protected', { token })).status, 200);
      assert.equal((await connect(token)).client.readyState, WebSocket.OPEN);
      assert.equal(records.get(userId).sessionVersion, 1, 'login must not increment the counter');
    });

    await t.test('invalid version types and tampered signatures cannot bypass revocation', async () => {
      for (const sessionVersion of [null, -1, 0, '1', 1.5]) {
        const token = jwt.sign({ id: userId, sessionVersion }, process.env.JWT_SECRET);
        await assert.rejects(authenticateStaffToken(token));
      }
      const forged = jwt.sign({ id: userId, sessionVersion: 1 }, 'different-fixture-secret');
      await assert.rejects(authenticateStaffToken(forged));
    });

    await t.test('two password saves from the same starting version use atomic increments', async () => {
      const first = User.hydrate(structuredClone(records.get(concurrentId)));
      const second = User.hydrate(structuredClone(records.get(concurrentId)));
      first.password = 'fixture-first-change';
      second.password = 'fixture-second-change';
      await first.save();
      const intermediate = generateStaffToken(first);
      assert.equal((await authenticateStaffToken(intermediate)).sessionVersion, 1);
      await second.save();
      assert.equal(records.get(concurrentId).sessionVersion, 2);
      await assert.rejects(authenticateStaffToken(intermediate));
      assert.equal(writes.at(-1).$inc.sessionVersion, 1);
    });

    await t.test('a password change between handshake and room registration cannot retain a stale socket', async () => {
      const rooms = [];
      const events = [];
      let disconnected = false;
      const token = generateStaffToken({ _id: otherId, sessionVersion: 0 });
      const user = await authenticateStaffToken(token);
      await registerStaffSocket({
        data: { user }, handshake: { auth: { token } },
        join: async (room) => { rooms.push(room); records.get(otherId).sessionVersion = 1; },
        emit: (event) => events.push(event),
        disconnect: (close) => { disconnected = close; },
        on: () => assert.fail('revoked sockets must not register handlers')
      });
      assert.deepEqual(rooms, [`staff:${otherId}`]);
      assert.deepEqual(events, ['auth:revoked']);
      assert.equal(disconnected, true);
    });

    await t.test('a missed cross-worker revocation is caught by the socket database recheck', async () => {
      const token = generateStaffToken({ _id: concurrentId, sessionVersion: 2 });
      const user = await authenticateStaffToken(token);
      const handlers = {};
      const events = [];
      let close;
      const closed = new Promise((resolve) => { close = resolve; });
      await registerStaffSocket({
        data: { user }, handshake: { auth: { token } }, join: async () => {},
        emit: (event) => events.push(event),
        on: (event, handler) => { handlers[event] = handler; },
        disconnect: (force) => { handlers.disconnect(); close(force); }
      }, { recheckIntervalMs: 10 });
      // Simulate a password write on another worker with no Redis notification.
      records.get(concurrentId).sessionVersion = 3;
      let timeout;
      try {
        const forced = await Promise.race([
          closed,
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Recheck did not close socket')), 1500); })
        ]);
        assert.equal(forced, true);
        assert.deepEqual(events, ['auth:revoked']);
      } finally {
        clearTimeout(timeout);
        handlers.disconnect();
      }
    });
  } finally {
    for (const client of sockets) client.close();
    io.disconnectSockets(true);
    server.closeAllConnections();
    await new Promise((resolve) => io.close(resolve));
    User.findById = original.findById;
    User.findOne = original.findOne;
    User.collection.updateOne = original.updateOne;
    User.collection.findOne = original.collectionFindOne;
    if (original.secret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = original.secret;
  }
});
