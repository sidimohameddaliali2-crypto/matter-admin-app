import assert from 'node:assert/strict';
import test from 'node:test';
import { createDriverAuditStaffProxy, createDriverAuditHttpServer } from './driverAuditHttp.js';
import { createDriverAuditAuth } from './driverAuditAuth.js';

const user = { _id: 'a'.repeat(24), email: 'staff@invalid.example', role: 'manager', permissions: { reports: true } };
test('the report process uses the existing staff endpoint and keeps report permissions and deactivation checks', async () => {
  const calls = [];
  const verify = createDriverAuditStaffProxy({ async fetchImpl(url, options) {
    calls.push({ url, options }); return Response.json({ success: true, data: { user } });
  } });
  assert.equal((await verify('fixture-token')).isActive, true);
  assert.equal(calls[0].url, 'http://127.0.0.1:5000/api/auth/me');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer fixture-token');
  for (const changed of [{ ...user, isActive: false }, { ...user, permissions: { reports: false } }, { ...user, role: 'driver' }]) {
    const authenticateStaffToken = createDriverAuditStaffProxy({ fetchImpl: async () => Response.json({ success: true, data: { user: changed } }) });
    const auth = createDriverAuditAuth({ authenticateStaffToken, secret: 'fictional-signing-secret-long-enough', origin: 'https://app.invalid.example' });
    await assert.rejects(auth.issue('Bearer fixture-token'));
  }
});

test('an unavailable or oversized staff response cannot grant a report session', async () => {
  for (const response of [() => new Response('denied', { status: 401 }), () => new Response('x'.repeat(65537)),
    () => Response.json({ success: true, data: { user: { ...user, _id: 'invalid' } } })]) {
    const verify = createDriverAuditStaffProxy({ fetchImpl: async () => response() });
    await assert.rejects(verify('fixture-token'));
  }
});

test('standalone reporting mounts without opening an operational database', async t => {
  let initialized = 0, closed = false;
  const env = { DRIVER_AUDIT_EXECUTION_HOST: 'sidi', DRIVER_AUDIT_DATA_STORE: 'supabase',
    DRIVER_AUDIT_ENABLED: '1', DRIVER_AUDIT_IMPORT_ENABLED: '0', DRIVER_AUDIT_ORIGIN: 'https://app.invalid.example' };
  const service = await createDriverAuditHttpServer({ env, backend: { kind: 'supabase', executionHost: 'sidi',
    transferAccounting: 'supabase-http-bytes-v1', rpc: async () => assert.fail('Unexpected report data read'),
    archive: { readObject() {}, putVerifiedObject() {} }, close: async () => { closed = true; } },
    createIntegration({ db, dependencies }) {
      initialized++;
      assert.throws(db, /does not use MongoDB/);
      assert.equal(dependencies.backend.kind, 'supabase');
      const handler = (req, res, next) => next(); handler.prewarm = async () => false; return handler;
    } });
  t.after(() => service.close());
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + service.server.address().port;
  const health = await fetch(origin + '/health');
  assert.equal(health.status, 503);
  const status = await health.json();
  assert.equal(status.dataStore, 'supabase');
  assert.equal(status.ready, false);
  assert.equal((await fetch(origin + '/not-a-report')).status, 404);
  assert.equal(initialized, 1);
  await service.close();
  assert.equal(closed, true);
});
