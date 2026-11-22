import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { createReportingVercelIdentity, isReportingVercelRead } from './reportingVercelIdentity.js';

const fixtureTime = 1795353600;
const fixtureIssuer = 'https://oidc.vercel.com/populus-ai';
const fixtureAudience = 'https://matterapp.online/api/external/reporting';
const fixtureSubject = 'owner:populus-ai:project:matter-private-reporting:environment:';
const fixtureId = '68f7dd671bcace41b9a6d7e3';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256', use: 'sig' };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

function token(claimOverrides = {}, headerOverrides = {}) {
  const header = { typ: 'JWT', alg: 'RS256', kid: jwk.kid, ...headerOverrides };
  const claims = {
    iss: fixtureIssuer, aud: fixtureAudience, sub: fixtureSubject + 'preview',
    iat: fixtureTime - 30, nbf: fixtureTime - 30, exp: fixtureTime + 600,
    owner_id: 'team_kVKDtA3C2ZkzLbDfHtCNz225', project_id: 'prj_9vDb9dhZlbcF4H4jxwsbY3G4AVqU',
    environment: 'preview', ...claimOverrides,
  };
  const inputs = encode(header) + '.' + encode(claims);
  return inputs + '.' + sign('RSA-SHA256', Buffer.from(inputs), privateKey).toString('base64url');
}

function request(path = '/changes', bearer = token(), method = 'GET', headers = {}) {
  return { method, path, headers: { authorization: 'Bearer ' + bearer, ...headers } };
}

function verifier(overrides = {}) {
  const calls = [];
  const env = { MATTER_REPORTING_VERCEL_OIDC_ENABLED: '1', MATTER_REPORTING_CAPTURE_ENABLED: '1', ...overrides };
  const authorize = createReportingVercelIdentity({
    env,
    now: () => fixtureTime,
    async fetchImpl(url, options) {
      calls.push({ url, redirect: options.redirect });
      return Response.json({ keys: [jwk] });
    },
  });
  return { authorize, calls };
}

test('accepts only the scoped reporting reads and reuses the pinned Vercel keys', async () => {
  const { authorize, calls } = verifier();
  for (const path of ['/changes', '/readiness', '/deliveries/' + fixtureId, '/days/2026-11-22/ids',
    '/gps-batches/vehicle-location%3A2026-11-22T10%3A00%3A00.000Z']) {
    assert.equal(await authorize(request(path)), true, path);
  }
  assert.deepEqual(calls, [{ url: fixtureIssuer + '/.well-known/jwks', redirect: 'error' }]);
  for (const path of ['/deliveries', '/days/2026-11-22', '/gps-batches', '/arbitrary', '/api/external/deliveries/' + fixtureId]) {
    assert.equal(isReportingVercelRead(request(path)), false, path);
  }
  assert.equal(await authorize(request('/changes', token(), 'POST')), false);
  assert.equal(await authorize(request('/changes', token(), 'HEAD')), false);
  assert.equal(isReportingVercelRead(request('/changes', 'legacy-api-key')), false);
  assert.equal(isReportingVercelRead(request('/changes', token(), 'GET', { 'x-api-key': 'legacy-key' })), false);
});

test('rejects broader, stale, future, malformed, and tampered identities', async () => {
  const { authorize, calls } = verifier();
  for (const claims of [
    { aud: 'https://vercel.com/populus-ai' }, { aud: [fixtureAudience] }, { iss: 'https://oidc.vercel.com' },
    { owner_id: 'team_other' }, { project_id: 'prj_other' }, { sub: fixtureSubject + 'development' },
    { environment: 'production', sub: fixtureSubject + 'production' }, { exp: undefined },
    { exp: fixtureTime }, { nbf: fixtureTime + 31 }, { iat: fixtureTime + 31 }, { exp: fixtureTime + 7200 },
  ]) {
    assert.equal(await authorize(request('/changes', token(claims))), false, JSON.stringify(claims));
  }
  assert.equal(await authorize(request('/changes', token({}, { alg: 'none' }))), false);
  assert.equal(await authorize(request('/changes', token({}, { kid: ['fixture'] }))), false);
  assert.equal(calls.length, 0);

  const [header, body, signature] = token().split('.');
  const changed = encode({ ...JSON.parse(Buffer.from(body, 'base64url')), exp: fixtureTime + 1200 });
  assert.equal(await authorize(request('/changes', [header, changed, signature].join('.'))), false);
  assert.equal(await authorize(request('/changes', token({}, { kid: 'unknown' }))), false);
  assert.equal(calls.length, 1);
});

test('requires explicit opt-in and keeps source data off before capture', async () => {
  const disabled = verifier({ MATTER_REPORTING_VERCEL_OIDC_ENABLED: '0' });
  assert.equal(await disabled.authorize(request('/readiness')), false);
  assert.equal(disabled.calls.length, 0);
  const readiness = verifier({ MATTER_REPORTING_CAPTURE_ENABLED: '0' });
  assert.equal(await readiness.authorize(request('/deliveries/' + fixtureId)), false);
  assert.equal(await readiness.authorize(request('/readiness')), true);
  const production = verifier({ MATTER_REPORTING_VERCEL_OIDC_PRODUCTION_ENABLED: '1' });
  assert.equal(await production.authorize(request('/changes', token({
    environment: 'production', sub: fixtureSubject + 'production',
  }))), true);
});
