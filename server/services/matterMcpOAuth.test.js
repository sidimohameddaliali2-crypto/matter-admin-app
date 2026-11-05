import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMatterOAuthProvider, mcpOAuthUrls } from './matterMcpOAuth.js';
import { hashMcpToken } from './matterMcpAuth.js';
import { createMcpOAuthIntegration } from '../routes/mcpOAuth.js';
import { createMcpRouter } from '../routes/mcp.js';
import { createMcpOAuthStore } from './matterMcpOAuthStore.js';

const staffId = '0123456789abcdef01234567';
const callback = 'https://chatgpt.com/connector_platform/oauth/callback';
const verifier = 'v'.repeat(64);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const scope = 'deliveries:read deliveries:write';

function memoryStore(now) {
  const records = new Map();
  const active = record => record && record.expiresAt > now();
  return {
    records,
    async put(kind, key, payload, expiresAt) { records.set(`${kind}|${key}`, { kind, key, payload: structuredClone(payload), expiresAt: expiresAt ? +expiresAt : Infinity }); },
    async get(kind, key) { const record = records.get(`${kind}|${key}`); return active(record) ? structuredClone(record.payload) : undefined; },
    async take(kind, key) { const record = records.get(`${kind}|${key}`); records.delete(`${kind}|${key}`); return active(record) ? structuredClone(record.payload) : undefined; },
    async findGrant(field, hash) { return structuredClone([...records.values()].find(record => record.kind === 'grant' && active(record)
      && (record.payload[field] === hash || (field === 'refreshHash' && record.payload.usedRefreshHashes?.includes(hash))))); },
    async rotate(key, previousHash, payload, expiresAt) {
      const record = records.get(`grant|${key}`);
      if (!active(record) || record.payload.refreshHash !== previousHash) return null;
      records.set(`grant|${key}`, { ...record, payload: structuredClone(payload), expiresAt: +expiresAt });
      return records.get(`grant|${key}`);
    },
    async revoke(clientId, hash) {
      for (const [key, record] of records) {
        if (record.kind === 'grant' && record.payload.clientId === clientId
          && [record.payload.accessHash, record.payload.refreshHash].includes(hash)) records.delete(key);
      }
    },
    async revokeGrant(key) { records.delete(`grant|${key}`); },
  };
}

async function fixture() {
  let clock = Date.now();
  let user = { _id: staffId, isActive: true, role: 'admin', permissionsConfigured: false };
  const env = { ENABLE_MATTER_MCP: 'true', JWT_SECRET: 'oauth-test-only',
    MATTER_MCP_CREDENTIALS: JSON.stringify([{ userId: staffId, sha256: hashMcpToken('fixture-key'), allowWrites: true }]) };
  const store = memoryStore(() => clock);
  const options = { env, store, findUser: async identifier => identifier === staffId ? user : null, now: () => clock };
  const provider = createMatterOAuthProvider(options);
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  const integration = createMcpOAuthIntegration({ env, provider, authenticate: (req, res, next) => {
    if (req.headers.authorization !== 'Bearer fixture-staff-session') return res.sendStatus(401);
    req.user = user;
    next();
  } });
  app.use(integration.router);
  app.use('/api/mcp', createMcpRouter({ env, findUser: options.findUser, oauthProvider: provider,
    fetchImpl: async () => ({ ok: true, json: async () => ({ success: true, data: { deliveries: [] } }) }) }));
  const listener = app.listen(0, '127.0.0.1');
  await new Promise(resolve => listener.once('listening', resolve));
  const base = `http://127.0.0.1:${listener.address().port}`;
  const call = (path, { body, form, ...rest } = {}) => fetch(new URL(path, base), {
    ...rest, redirect: 'manual', method: body || form ? 'POST' : 'GET',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...rest.headers },
    ...(body ? { body: JSON.stringify(body) } : form ? { body: new URLSearchParams(form) } : {}),
  });
  const register = async () => {
    const response = await call('/api/mcp/oauth/register', { body: { redirect_uris: [callback], token_endpoint_auth_method: 'none', client_name: '<script>untrusted</script>' } });
    assert.equal(response.status, 201);
    return response.json();
  };
  const start = async (client, parameters = {}) => {
    const query = new URLSearchParams({ client_id: client.client_id, response_type: 'code', redirect_uri: callback,
      code_challenge: challenge, code_challenge_method: 'S256', resource: provider.urls.resource, scope, state: 'original-state', ...parameters });
    const response = await call(`/api/mcp/oauth/authorize?${query}`);
    const html = await response.text();
    assert.equal(response.status, 200, html);
    assert.ok(html.includes('&lt;script&gt;untrusted&lt;/script&gt;'));
    assert.ok(response.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
    assert.ok(response.headers.get('set-cookie').includes('HttpOnly'));
    assert.ok(response.headers.get('set-cookie').includes('Secure'));
    return { requestId: /name="requestId" value="([^"]+)"/.exec(html)[1], csrf: /name="csrf" value="([^"]+)"/.exec(html)[1],
      cookie: response.headers.get('set-cookie').split(';')[0] };
  };
  const approve = (pending, extras = {}, headers = {}) => call('/api/mcp/oauth/consent', {
    headers: { Authorization: 'Bearer fixture-staff-session', Origin: provider.urls.origin, Cookie: pending.cookie, ...headers },
    body: { requestId: pending.requestId, csrf: pending.csrf, allowWrites: true, ...extras },
  });
  const issueCode = async (client, extras = {}) => {
    const pending = await start(client);
    const response = await approve(pending, extras);
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    const redirect = new URL(result.redirect);
    assert.equal(redirect.origin, 'https://chatgpt.com');
    assert.equal(redirect.searchParams.get('state'), 'original-state');
    return redirect.searchParams.get('code');
  };
  const exchange = (client, code, extras = {}) => call('/api/mcp/oauth/token', { form: {
    client_id: client.client_id, grant_type: 'authorization_code', code, code_verifier: verifier,
    redirect_uri: callback, resource: provider.urls.resource, ...extras,
  } });
  return { env, store, provider, options, base, call, register, start, approve, issueCode, exchange,
    advance: milliseconds => { clock += milliseconds; }, changeUser: value => { user = value; },
    close: async () => { listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); } };
}

test('OAuth metadata advertises PKCE and DCR through public API paths while disabled MCP stays closed', async () => {
  const setup = await fixture();
  try {
    const response = await setup.call('/api/mcp', { body: {} });
    assert.equal(response.status, 401);
    assert.ok(response.headers.get('www-authenticate').includes('resource_metadata="https://matterapp.online/api/mcp/oauth/resource"'));
    const resource = await (await setup.call('/api/mcp/oauth/resource')).json();
    assert.equal(resource.resource, setup.provider.urls.resource);
    for (const path of ['/.well-known/oauth-authorization-server/api/mcp/oauth', '/api/mcp/oauth/.well-known/oauth-authorization-server']) {
      const metadata = await (await setup.call(path)).json();
      assert.equal(metadata.issuer, resource.authorization_servers[0]);
      assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
      assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ['none']);
      assert.equal(metadata.token_endpoint, 'https://matterapp.online/api/mcp/oauth/token');
    }
    const rejected = await setup.call('/api/mcp/oauth/register', { body: { redirect_uris: ['https://attacker.example/callback'] } });
    assert.equal(rejected.status, 400);
    const openRedirect = await setup.call('/api/mcp/oauth/register', { body: { redirect_uris: ['https://chatgpt.com/redirect?url=https://attacker.example'] } });
    assert.equal(openRedirect.status, 400);
    for (const redirect of ['https://chatgpt.com/connector_platform_oauth_redirect', 'https://chatgpt.com/connector/oauth/callback-id-123']) {
      const registered = await setup.call('/api/mcp/oauth/register', { body: { redirect_uris: [redirect], token_endpoint_auth_method: 'none' } });
      assert.equal(registered.status, 201);
    }
    assert.throws(() => mcpOAuthUrls({ MATTER_MCP_PUBLIC_URL: 'http://attacker.example/api/mcp' }));
    setup.env.ENABLE_MATTER_MCP = 'false';
    assert.equal((await setup.call('/api/mcp/oauth/resource')).status, 404);
    assert.equal((await setup.call('/api/mcp/oauth/register', { body: {} })).status, 404);
  } finally { await setup.close(); }
});

test('authorization is browser-bound and requires staff consent; codes are PKCE-protected and single use', async () => {
  const setup = await fixture();
  try {
    const client = await setup.register();
    assert.equal(client.client_secret, undefined);
    const pending = await setup.start(client);
    assert.equal((await setup.approve(pending, {}, { Authorization: 'Bearer invalid' })).status, 401);
    assert.equal((await setup.approve(pending, {}, { Origin: 'https://attacker.example' })).status, 403);
    assert.equal((await setup.approve(pending, { csrf: 'x'.repeat(43) })).status, 400);
    assert.equal((await setup.approve(pending, {}, { Cookie: '' })).status, 400);
    const consent = await setup.approve(pending);
    const code = new URL((await consent.json()).redirect).searchParams.get('code');
    assert.equal((await setup.approve(pending)).status, 400);
    assert.equal((await setup.exchange(client, code, { code_verifier: 'wrong'.repeat(12) })).status, 400);
    assert.equal((await setup.exchange(client, code, { redirect_uri: `${callback}/wrong` })).status, 400);
    assert.equal((await setup.exchange(client, code, { resource: 'https://other.example/api/mcp' })).status, 400);
    const tokensResponse = await setup.exchange(client, code);
    assert.equal(tokensResponse.status, 200);
    const tokens = await tokensResponse.json();
    assert.equal(tokens.scope, scope);
    assert.equal((await setup.exchange(client, code)).status, 400);
    const persisted = JSON.stringify([...setup.store.records.values()]);
    for (const secret of [code, tokens.access_token, tokens.refresh_token, pending.csrf, pending.cookie.split('=')[1]]) assert.ok(!persisted.includes(secret));
    const restarted = createMatterOAuthProvider(setup.options);
    assert.equal((await restarted.verifyAccessToken(tokens.access_token)).user._id, staffId);
    const mcp = new Client({ name: 'oauth-test', version: '1.0.0' });
    try {
      await mcp.connect(new StreamableHTTPClientTransport(new URL(`${setup.base}/api/mcp`), { requestInit: {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      } }));
      const tools = (await mcp.listTools()).tools;
      assert.ok(tools.some(tool => tool.name === 'matter_create_delivery'));
      assert.deepEqual(tools.find(tool => tool.name === 'matter_create_delivery')._meta.securitySchemes[0].scopes,
        ['deliveries:read', 'deliveries:write']);
    } finally { await mcp.close(); }
  } finally { await setup.close(); }
});

test('authorization codes and refresh grants expire independently of Mongo TTL cleanup; clients survive', async () => {
  const setup = await fixture();
  try {
    const client = await setup.register();
    const expiredCode = await setup.issueCode(client);
    setup.advance(61000);
    assert.equal((await setup.exchange(client, expiredCode)).status, 400);
    const tokens = await (await setup.exchange(client, await setup.issueCode(client))).json();
    setup.advance(30 * 24 * 60 * 60 * 1000 + 1);
    await assert.rejects(setup.provider.exchangeRefreshToken(client, tokens.refresh_token), /expired/);
    assert.equal((await setup.provider.clientsStore.getClient(client.client_id)).client_id, client.client_id);
  } finally { await setup.close(); }
});

test('read-only consent and changing staff policy cannot gain edit access; expired forms do not issue codes', async () => {
  const setup = await fixture();
  try {
    const client = await setup.register();
    const pending = await setup.start(client);
    const code = await setup.issueCode(client, { allowWrites: false });
    const tokens = await (await setup.exchange(client, code)).json();
    assert.equal(tokens.scope, 'deliveries:read');
    assert.equal((await setup.provider.verifyAccessToken(tokens.access_token)).allowWrites, false);
    await assert.rejects(setup.provider.exchangeRefreshToken(client, tokens.refresh_token, ['deliveries:read', 'deliveries:write']), /expand/);
    setup.advance(11 * 60 * 1000);
    assert.equal((await setup.approve(pending)).status, 400);
    setup.env.MATTER_MCP_CREDENTIALS = '[]';
    await assert.rejects(setup.provider.verifyAccessToken(tokens.access_token), /removed/);
  } finally { await setup.close(); }
});

test('OAuth refresh is rotated atomically, scopes cannot expand, and revocation affects the owning client only', async () => {
  const setup = await fixture();
  try {
    const client = await setup.register();
    const other = await setup.register();
    const code = await setup.issueCode(client);
    const tokens = await (await setup.exchange(client, code)).json();
    await setup.provider.revokeToken(other, { token: tokens.refresh_token });
    assert.ok(await setup.provider.verifyAccessToken(tokens.access_token));
    await assert.rejects(setup.provider.exchangeRefreshToken(other, tokens.refresh_token), /invalid/);
    setup.advance(16 * 60 * 1000);
    await assert.rejects(setup.provider.verifyAccessToken(tokens.access_token), /expired/);
    const competing = await Promise.allSettled([
      setup.provider.exchangeRefreshToken(client, tokens.refresh_token),
      setup.provider.exchangeRefreshToken(client, tokens.refresh_token),
    ]);
    assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1);
    const rotated = competing.find(result => result.status === 'fulfilled').value;
    await assert.rejects(setup.provider.verifyAccessToken(rotated.access_token), /revoked/);
    await assert.rejects(setup.provider.exchangeRefreshToken(client, tokens.refresh_token), /invalid|used/);
    const fresh = await (await setup.exchange(client, await setup.issueCode(client))).json();
    const refreshed = await setup.provider.exchangeRefreshToken(client, fresh.refresh_token);
    assert.ok(await setup.provider.verifyAccessToken(refreshed.access_token));
    await assert.rejects(setup.provider.exchangeRefreshToken(client, fresh.refresh_token), /replay/);
    await assert.rejects(setup.provider.verifyAccessToken(refreshed.access_token), /revoked/);
    const revocable = await (await setup.exchange(client, await setup.issueCode(client))).json();
    const wrongIssuer = createMatterOAuthProvider({ ...setup.options, env: { ...setup.env, MATTER_MCP_PUBLIC_URL: 'https://other.example/api/mcp' } });
    await assert.rejects(wrongIssuer.verifyAccessToken(revocable.access_token), /expired|revoked/);
    await setup.provider.revokeToken(client, { token: revocable.access_token });
    await assert.rejects(setup.provider.verifyAccessToken(revocable.access_token), /revoked/);
    await assert.rejects(setup.provider.exchangeRefreshToken(client, revocable.refresh_token), /invalid/);
  } finally { await setup.close(); }
});

test('OAuth access is rechecked when staff is deactivated, demoted, denied deliveries, or restricted to reading', async () => {
  const setup = await fixture();
  try {
    const client = await setup.register();
    const tokens = await (await setup.exchange(client, await setup.issueCode(client))).json();
    for (const user of [{ _id: staffId, role: 'admin', isActive: false }, { _id: staffId, role: 'driver', isActive: true },
      { _id: staffId, role: 'admin', isActive: true, permissionsConfigured: true, permissions: { deliveries: false } }]) {
      setup.changeUser(user);
      await assert.rejects(setup.provider.verifyAccessToken(tokens.access_token), /removed/);
    }
    setup.changeUser({ _id: staffId, role: 'admin', isActive: true });
    const entries = JSON.parse(setup.env.MATTER_MCP_CREDENTIALS);
    entries[0].allowWrites = false;
    setup.env.MATTER_MCP_CREDENTIALS = JSON.stringify(entries);
    assert.equal((await setup.provider.verifyAccessToken(tokens.access_token)).allowWrites, false);
  } finally { await setup.close(); }
});

test('Mongo OAuth adapter filters expired records and uses atomic refresh and single-use operations', async () => {
  const calls = [];
  const query = filter => { calls.push(filter); return { lean: async () => null }; };
  const store = createMcpOAuthStore({
    findOne: query, findOneAndDelete: query,
    findOneAndUpdate: (filter, update, options) => { assert.equal(options.new, true); assert.ok(update.$set.payload); return query(filter); },
    deleteMany: async filter => calls.push(filter),
  });
  await store.get('code', 'hash');
  await store.take('pending', 'hash');
  await store.rotate('grant', 'old-refresh-hash', { scopes: ['deliveries:read'] }, new Date());
  assert.ok(calls.every(filter => filter.expiresAt.$gt instanceof Date));
  assert.equal(calls[2]['payload.refreshHash'], 'old-refresh-hash');
});
