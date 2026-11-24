import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import deliveriesRouter from './deliveries.js';
import User from '../models/User.js';
import Delivery from '../models/Delivery.js';
import { MATTER_IMPORT_IDENTITIES } from '../config/matterImportIdentity.js';
import { removeClientMatterImportIdentity } from '../middleware/matterImportIdentityInput.js';

test('reserved identities cannot be supplied as dotted paths, nested bulk values or rename destinations', () => {
  for (const [field] of MATTER_IMPORT_IDENTITIES) {
    const payload = { [field]: 'forged', [`${field}.nested`]: 'forged',
      deliveries: [{ [field]: 'forged', customerName: 'Synthetic' }],
      $set: { [field]: 'forged', address: 'Keep' }, $rename: { address: field, [field]: 'address' } };
    removeClientMatterImportIdentity(payload);
    assert.equal(payload[field], undefined);
    assert.equal(payload[`${field}.nested`], undefined);
    assert.deepEqual(payload.deliveries, [{ customerName: 'Synthetic' }]);
    assert.deepEqual(payload.$set, { address: 'Keep' });
    assert.deepEqual(payload.$rename, {});
  }
});

test('single and bulk HTTP create routes remove reserved import keys before their write boundary', async t => {
  const previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'synthetic-manual-import-identity-test';
  t.after(() => { if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous; });
  t.mock.method(User, 'findById', id => ({ select: async () => ({ _id: id, isActive: true, role: 'dispatcher' }) }));
  t.mock.method(console, 'error', () => {});
  const writes = [];
  t.mock.method(Delivery, 'create', async row => { writes.push(structuredClone(row)); throw new Error('Synthetic write boundary reached'); });
  t.mock.method(Delivery, 'insertMany', async rows => { writes.push(...structuredClone(rows)); throw new Error('Synthetic write boundary reached'); });
  const app = express();
  app.use(express.json()); app.use('/api/deliveries', deliveriesRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/deliveries`;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ id: 'synthetic-staff' }, process.env.JWT_SECRET, { algorithm: 'HS256' })}` };
  const body = { customerId: 'MANUAL', customerName: 'Synthetic Manual', type: 'Delivery', scheduledTime: '2026-11-22T01:00:00Z',
    address: 'Synthetic address', zone: 'Test zone', gpsLocation: { lat: 25.1, lng: 55.2 },
    ...Object.fromEntries(MATTER_IMPORT_IDENTITIES.map(([field]) => [field, 'forged-key'])) };
  for (const [path, payload] of [['', body], ['/bulk', { deliveries: [body] }]]) {
    const response = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(payload) });
    assert.equal(response.status, 500); // Deliberately stop before persistence/side effects.
    assert.equal(writes.length, path ? 2 : 1);
    for (const [field] of MATTER_IMPORT_IDENTITIES) assert.equal(writes.at(-1)[field], undefined);
    assert.equal(writes.at(-1).customerId, 'MANUAL');
  }
});
