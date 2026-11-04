import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { authenticateMcpCredential, hashMcpToken } from './matterMcpAuth.js';
import { businessDateRange, createMatterApiClient, createMatterMcpServer } from './matterMcpService.js';
import { createMcpRouter } from '../routes/mcp.js';
import Delivery from '../models/Delivery.js';
import User from '../models/User.js';

const userId = '0123456789abcdef01234567';
const recordId = 'abcdef0123456789abcdef01';
const credential = `matter_mcp_${'a'.repeat(43)}`;
const staff = { _id: userId, isActive: true, role: 'dispatcher', permissionsConfigured: false };
const credentialsJson = JSON.stringify([{ userId, sha256: hashMcpToken(credential), allowWrites: true }]);

async function connectFixture(context, request) {
  const server = createMatterMcpServer({ ...context, request });
  const client = new Client({ name: 'matter-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test('MCP authentication uses active staff and effective permissions, not just a matching credential', async () => {
  const options = { credentialsJson, findUser: async identifier => { assert.equal(identifier, userId); return staff; } };
  const context = await authenticateMcpCredential(`Bearer ${credential}`, options);
  assert.equal(context.allowWrites, true);
  assert.equal(context.permissions.deliveries, true);
  await assert.rejects(authenticateMcpCredential(`Bearer ${credential}`, { ...options, credentialsJson: '[]' }), { statusCode: 401 });
  for (const user of [null, { ...staff, isActive: false }, { ...staff, role: 'driver' },
    { ...staff, permissionsConfigured: true, permissions: { deliveries: false } }]) {
    await assert.rejects(authenticateMcpCredential(`Bearer ${credential}`, { ...options, findUser: async () => user }));
  }
  for (const authorization of [undefined, 'Bearer external-api-key', 'Bearer staff-jwt', `${credential}`]) {
    await assert.rejects(authenticateMcpCredential(authorization, options), { statusCode: 401 });
  }
});

test('malformed credential configuration fails closed and missing write capability is read-only', async () => {
  for (const invalid of ['not json', '{}', '[null]', JSON.stringify([{ userId, sha256: 'bad' }]),
    JSON.stringify([{ userId, sha256: hashMcpToken(credential), allowWrites: 'true' }])]) {
    await assert.rejects(authenticateMcpCredential(`Bearer ${credential}`, {
      credentialsJson: invalid, findUser: async () => staff,
    }), { statusCode: 503 });
  }
  const context = await authenticateMcpCredential(`Bearer ${credential}`, {
    credentialsJson: JSON.stringify([{ userId, sha256: hashMcpToken(credential) }]), findUser: async () => staff,
  });
  assert.equal(context.allowWrites, false);
});

test('business dates use configured day boundaries, including leap days, and reject invalid dates', () => {
  assert.deepEqual(businessDateRange('2026-11-05'), {
    dateFrom: '2026-11-04T20:00:00.000Z', dateTo: '2026-11-05T19:59:59.999Z',
  });
  assert.equal(businessDateRange('2024-02-29', 0).dateFrom, '2024-02-29T00:00:00.000Z');
  assert.throws(() => businessDateRange('2026-02-29'));
  assert.throws(() => businessDateRange('2026-11-05', NaN));
});

test('read-only credentials cannot discover or call mutating tools, and customer permission is enforced', async () => {
  const fixture = await connectFixture({ permissions: { deliveries: true }, allowWrites: false }, async () => {
    assert.fail('No API call is expected');
  });
  try {
    const tools = (await fixture.client.listTools()).tools;
    assert.deepEqual(tools.map(tool => tool.name).sort(), ['matter_get_delivery', 'matter_list_deliveries']);
    assert.ok(tools.every(tool => tool.annotations.readOnlyHint));
    const result = await fixture.client.callTool({ name: 'matter_create_delivery', arguments: {} });
    assert.equal(result.isError, true);
  } finally { await fixture.close(); }
});

test('delivery listing translates business dates and preserves pagination; customer lookup uses actual API', async () => {
  const calls = [];
  const fixture = await connectFixture({ permissions: { deliveries: true, customers: true }, allowWrites: false },
    async (...args) => { calls.push(args); return { success: true, data: [] }; });
  try {
    await fixture.client.callTool({ name: 'matter_list_deliveries', arguments: { date: '2026-11-05', page: 2, limit: 10 } });
    assert.deepEqual(calls[0], ['GET', '/deliveries', { query: { page: 2, limit: 10, view: 'records',
      dateFrom: '2026-11-04T20:00:00.000Z', dateTo: '2026-11-05T19:59:59.999Z' } }]);
    await fixture.client.callTool({ name: 'matter_search_customers', arguments: { search: 'Customer' } });
    assert.deepEqual(calls[1], ['GET', '/customers', { query: { search: 'Customer', limit: 10 } }]);
    const invalid = await fixture.client.callTool({ name: 'matter_list_deliveries', arguments: { date: '2026-02-29' } });
    assert.equal(invalid.isError, true);
    assert.equal(calls.length, 2);
  } finally { await fixture.close(); }
});

test('create/edit tools call existing routes with explicit timezone and reject unsupported update fields', async () => {
  const calls = [];
  const fixture = await connectFixture({ permissions: { deliveries: true }, allowWrites: true },
    async (...args) => { calls.push(args); return { success: true, data: { delivery: { _id: recordId } } }; });
  try {
    const body = { customerId: 'CUSTOMER-123', customerName: 'Customer', address: 'Known saved address',
      scheduledTime: '2026-11-05T08:00:00+04:00', company: 'Matter', type: 'Delivery' };
    const created = await fixture.client.callTool({ name: 'matter_create_delivery', arguments: body });
    assert.ok(!created.isError);
    assert.deepEqual(calls[0], ['POST', '/deliveries', { body }]);
    const invalidTime = await fixture.client.callTool({ name: 'matter_create_delivery',
      arguments: { ...body, scheduledTime: '2026-11-05T08:00:00' } });
    assert.equal(invalidTime.isError, true);
    for (const changes of [{}, { status: 'delivered' }, { matterRevenue: 5 }, { gpsLocation: { lat: 25, lng: 55 } }]) {
      const result = await fixture.client.callTool({ name: 'matter_update_delivery',
        arguments: { deliveryId: recordId, changes, changeReason: 'User request' } });
      assert.equal(result.isError, true);
    }
    await fixture.client.callTool({ name: 'matter_update_delivery', arguments: {
      deliveryId: recordId, changes: { notes: 'Use reception' }, changeReason: 'User request',
    } });
    assert.deepEqual(calls[1], ['PUT', `/deliveries/${recordId}`, { body: { notes: 'Use reception', changeReason: 'User request' } }]);
    assert.equal(calls.length, 2);
    const invalidId = await fixture.client.callTool({ name: 'matter_get_delivery', arguments: { deliveryId: '../auth/me' } });
    assert.equal(invalidId.isError, true);
    assert.equal(calls.length, 2);
  } finally { await fixture.close(); }
});

test('API bridge never follows redirects or retries uncertain writes', async () => {
  let attempts = 0;
  const request = createMatterApiClient({ baseUrl: 'http://127.0.0.1:5000/api', token: 'fixture-token',
    fetchImpl: async (url, options) => {
      attempts += 1;
      assert.equal(url.pathname, '/api/deliveries');
      assert.equal(options.headers.Authorization, 'Bearer fixture-token');
      assert.equal(options.redirect, 'error');
      throw new Error('timeout');
    } });
  await assert.rejects(request('POST', '/deliveries', { body: {} }), /look up|Look up/);
  assert.equal(attempts, 1);
  const failure = createMatterApiClient({ baseUrl: 'http://127.0.0.1:5000/api', token: 'fixture-token',
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ message: 'Server error' }) }) });
  await assert.rejects(failure('PUT', `/deliveries/${recordId}`, { body: {} }), /may have been saved/);
});

test('MCP lookup finds a booked Sunday hidden by dispatch combining without carrying Sundays into Saturday', async (context) => {
  const { default: deliveriesRouter } = await import('../routes/deliveries.js');
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'weekend-lookup-fixture-secret';
  const driverId = '111111111111111111111111';
  const saturdayId = '222222222222222222222222';
  const sundayOnlyId = '333333333333333333333333';
  const records = [
    { _id: saturdayId, customerId: 'CUSTOMER-123', type: 'Delivery', driver: driverId,
      scheduledTime: new Date('2026-11-07T08:00:00+04:00') },
    { _id: recordId, customerId: 'CUSTOMER-123', type: 'Delivery', driver: driverId,
      scheduledTime: new Date('2026-11-08T08:00:00+04:00') },
    { _id: sundayOnlyId, customerId: 'SUNDAY-ONLY', type: 'Delivery', driver: 'other-driver',
      scheduledTime: new Date('2026-11-08T08:00:00+04:00') },
  ];
  const matchingRecords = filter => records.filter(record => {
    if (filter.customerId && (typeof filter.customerId === 'string'
      ? record.customerId !== filter.customerId : !filter.customerId.$in.includes(record.customerId))) return false;
    if (filter.type && record.type !== filter.type) return false;
    if (filter.driver && record.driver !== filter.driver) return false;
    const bounds = filter.scheduledTime || {};
    return (!bounds.$gte || record.scheduledTime >= bounds.$gte)
      && (!bounds.$lte || record.scheduledTime <= bounds.$lte)
      && (!bounds.$lt || record.scheduledTime < bounds.$lt);
  });
  context.mock.method(User, 'findById', identifier => ({ select: async () => identifier === userId
    ? staff : identifier === driverId ? { _id: driverId, isActive: true, role: 'driver' } : null }));
  context.mock.method(Delivery, 'find', filter => {
    let limit = Infinity;
    let skip = 0;
    return {
      populate() { return this; }, select() { return this; }, sort() { return this; },
      limit(value) { limit = value; return this; }, skip(value) { skip = value; return this; },
      async lean() { return matchingRecords(filter).slice(skip, skip + limit).map(record => ({ ...record })); },
    };
  });
  context.mock.method(Delivery, 'countDocuments', async filter => matchingRecords(filter).length);
  const app = express();
  app.use('/api/deliveries', deliveriesRouter);
  const listener = app.listen(0, '127.0.0.1');
  await new Promise(resolve => listener.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${listener.address().port}/api`;
  const staffToken = jwt.sign({ id: userId }, process.env.JWT_SECRET);
  const fixture = await connectFixture({ permissions: { deliveries: true }, allowWrites: false },
    createMatterApiClient({ baseUrl, token: staffToken }));
  try {
    const sundayQuery = new URLSearchParams({ ...businessDateRange('2026-11-08'), customerId: 'CUSTOMER-123' });
    const dispatch = await fetch(`${baseUrl}/deliveries?${sundayQuery}`, {
      headers: { Authorization: `Bearer ${staffToken}` },
    });
    assert.equal(dispatch.status, 200);
    assert.deepEqual((await dispatch.json()).data.deliveries, []);

    const lookup = await fixture.client.callTool({ name: 'matter_list_deliveries', arguments: {
      date: '2026-11-08', customerId: 'CUSTOMER-123',
    } });
    assert.ok(!lookup.isError);
    const result = JSON.parse(lookup.content[0].text);
    assert.deepEqual(result.data.deliveries.map(record => record._id), [recordId]);
    assert.equal(result.data.pagination.total, 1);

    const saturdayQuery = new URLSearchParams({ dateFrom: '2026-11-06T20:00:00.000Z', dateTo: '2026-11-07T20:00:00.000Z' });
    const saturday = await fetch(`${baseUrl}/deliveries?${saturdayQuery}`, {
      headers: { Authorization: `Bearer ${staffToken}` },
    });
    const saturdayRecords = (await saturday.json()).data.deliveries;
    assert.deepEqual(saturdayRecords.map(record => record._id), [saturdayId, sundayOnlyId]);
    assert.equal(saturdayRecords[0].combinedSunday.deliveryId, recordId);
    const saturdayLookup = await fixture.client.callTool({ name: 'matter_list_deliveries', arguments: { date: '2026-11-07' } });
    assert.deepEqual(JSON.parse(saturdayLookup.content[0].text).data.deliveries.map(record => record._id), [saturdayId]);

    const page = await fixture.client.callTool({ name: 'matter_list_deliveries', arguments: {
      date: '2026-11-08', page: 2, limit: 1,
    } });
    const paginated = JSON.parse(page.content[0].text).data;
    assert.deepEqual(paginated.deliveries.map(record => record._id), [sundayOnlyId]);
    assert.equal(paginated.pagination.total, 2);
    assert.equal(paginated.pagination.pages, 2);

    const driver = await fetch(`${baseUrl}/deliveries?${sundayQuery}&view=records`, {
      headers: { Authorization: `Bearer ${jwt.sign({ id: driverId }, process.env.JWT_SECRET)}` },
    });
    assert.deepEqual((await driver.json()).data.deliveries.map(record => record._id), [recordId]);
    const driverAll = await fetch(`${baseUrl}/deliveries?view=records`, {
      headers: { Authorization: `Bearer ${jwt.sign({ id: driverId }, process.env.JWT_SECRET)}` },
    });
    assert.deepEqual((await driverAll.json()).data.deliveries.map(record => record._id), [saturdayId, recordId]);
    assert.equal((await fetch(`${baseUrl}/deliveries?view=records`)).status, 401);
  } finally {
    await fixture.close();
    listener.closeAllConnections();
    await new Promise(resolve => listener.close(resolve));
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
});

test('HTTP MCP discovery and writes use the same active staff identity through loopback', async () => {
  const env = { ENABLE_MATTER_MCP: 'true', MATTER_MCP_CREDENTIALS: credentialsJson, JWT_SECRET: 'fixture-secret-only' };
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use('/api/mcp', createMcpRouter({ env, findUser: async () => staff,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const token = options.headers.Authorization.slice(7);
      const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
      assert.equal(decoded.id, userId);
      assert.equal(decoded.exp - decoded.iat, 60);
      assert.notEqual(token, credential);
      return { ok: true, json: async () => ({ success: true, data: { delivery: { _id: recordId } } }) };
    } }));
  const listener = app.listen(0, '127.0.0.1');
  await new Promise(resolve => listener.once('listening', resolve));
  const endpoint = new URL(`http://127.0.0.1:${listener.address().port}/api/mcp`);
  const client = new Client({ name: 'matter-http-test', version: '1.0.0' });
  try {
    assert.equal((await fetch(endpoint, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: {
      Authorization: `Bearer ${credential}`, Origin: 'https://unknown.example',
    } })).status, 403);
    await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: {
      headers: { Authorization: `Bearer ${credential}` },
    } }));
    assert.equal((await client.listTools()).tools.length, 5);
    const result = await client.callTool({ name: 'matter_get_delivery', arguments: { deliveryId: recordId } });
    assert.ok(!result.isError);
    assert.equal(calls[0].url.origin, endpoint.origin);
    assert.equal(calls[0].url.pathname, `/api/deliveries/${recordId}`);
    env.MATTER_MCP_CREDENTIALS = '[]';
    assert.equal((await fetch(endpoint, { headers: { Authorization: `Bearer ${credential}` } })).status, 401);
    env.ENABLE_MATTER_MCP = 'false';
    assert.equal((await fetch(endpoint)).status, 404);
  } finally {
    await client.close();
    listener.closeAllConnections();
    await new Promise(resolve => listener.close(resolve));
  }
});
