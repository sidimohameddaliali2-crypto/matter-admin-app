import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createDriverAuditStaffProxy, createDriverAuditHttpServer, readerActorHeader } from './driverAuditHttp.js';
import { createDriverAuditAuth } from './driverAuditAuth.js';
import { createAutomaticHostedPreview } from '../vendor/driver-audits/integration/cloud/automatic-hosted-preview.mjs';

const user = { _id: 'a'.repeat(24), email: 'staff@invalid.example', role: 'manager', permissions: { reports: true },
  profile: { firstName: 'Fictional', lastName: 'Reviewer', phone: 'never passed to the report reader' } };
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

test('the app reader requires its private loopback key before serving or preparing reports', async t => {
  let calls = 0;
  const key = 'k'.repeat(43);
  const env = { DRIVER_AUDIT_EXECUTION_HOST: 'sidi', DRIVER_AUDIT_DATA_STORE: 'supabase',
    DRIVER_AUDIT_ENABLED: '1', DRIVER_AUDIT_IMPORT_ENABLED: '0', DRIVER_AUDIT_ORIGIN: 'https://app.invalid.example' };
  const service = await createDriverAuditHttpServer({ env, ingressKey: key, staffPort: 5050,
    backend: { kind: 'supabase', executionHost: 'sidi', transferAccounting: 'supabase-http-bytes-v1',
      rpc: async () => assert.fail('Unexpected report data read'), archive: { readObject() {}, putVerifiedObject() {} } },
    async fetchImpl(url) {
      assert.equal(url, 'http://127.0.0.1:5050/api/auth/me');
      return Response.json({ success: true, data: { user } });
    },
    createIntegration({ authenticateStaffToken, dependencies }) {
      const auth = createDriverAuditAuth({ authenticateStaffToken, secret: 'fictional-signing-secret-long-enough',
        origin: env.DRIVER_AUDIT_ORIGIN });
      const handler = async (req, res) => {
        calls++;
        const session = await auth.authenticate(req.headers.cookie);
        dependencies.onStaffAuthenticated(res, session.activityActor);
        res.end('staff');
      };
      handler.prewarm = async () => { calls++; return false; };
      return handler;
    },
  });
  t.after(() => service.close());
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + service.server.address().port;
  assert.equal((await fetch(origin + '/health')).status, 404);
  assert.equal((await fetch(origin + '/api/reporting/status', {
    headers: { 'x-matter-report-reader': 'x'.repeat(43) },
  })).status, 404);
  assert.equal(calls, 0);
  const signed = await fetch(origin + '/api/reporting/status', {
    headers: { 'x-matter-report-reader': key, Cookie: 'matter_driver_audit_v2=fixture-token' },
  });
  assert.equal(signed.status, 200);
  assert.equal(await signed.text(), 'staff');
  assert.deepEqual(JSON.parse(Buffer.from(signed.headers.get(readerActorHeader), 'base64url')), {
    id: user._id, name: 'Fictional Reviewer', role: 'manager', kind: 'staff',
  });
  assert.equal(calls, 1);
});

test('readiness requires the exact prepared descriptor even when browser generation and report hash match', async t => {
  const sha = value => createHash('sha256').update(value).digest('hex');
  const at = '2026-11-18T06:30:00.000Z', generation = sha('same browser generation'), reportHash = sha('same report');
  const manifestSha256 = sha('source manifest'), sourceBasis = sha('source basis');
  const makeHead = content => {
    const descriptorSha256 = sha(content);
    const identity = { generation, reportHash, manifestSha256, descriptorSha256 };
    return { version: 1, generation, reportHash,
      descriptor: { version: 1, domain: 'previewPackage', path: 'descriptor.json', kind: 'immutable-evidence',
        size: content.length, sha256: descriptorSha256, chunks: [{ offset: 0, size: content.length, sha256: descriptorSha256 }] },
      servingPackage: { version: 1, dataStore: 'supabase', collectorRevision: 42, sourceBasis, manifestSha256 },
      closureReceipt: { version: 1, status: 'verified', sourceBasis, ...identity, checkedAt: at,
        checks: { archive: true, photos: true, reviewHistory: true } },
      restore: { version: 1, archive: 'matter-report-archive', verified: true, ...identity }, visibleCutoffAt: at };
  };
  let head = makeHead('original descriptor'), coordinator;
  const publication = Buffer.from(JSON.stringify({ head: { manifest: { sha256: generation }, reportHash } }));
  const env = { DRIVER_AUDIT_EXECUTION_HOST: 'sidi', DRIVER_AUDIT_DATA_STORE: 'supabase',
    DRIVER_AUDIT_ENABLED: '1', DRIVER_AUDIT_IMPORT_ENABLED: '0' };
  const service = await createDriverAuditHttpServer({ env,
    backend: { kind: 'supabase', executionHost: 'sidi', transferAccounting: 'supabase-http-bytes-v1',
      async rpc(name) {
        assert.equal(name, 'matter_hosted_state_read');
        return { revision: 1, body_text: JSON.stringify(head) };
      }, archive: { readObject() {}, putVerifiedObject() {} } },
    createIntegration({ dependencies: { store } }) {
      coordinator = createAutomaticHostedPreview({ loadPointer: () => store.head(), async loadPackage() {
        return { manifest: { 'publication.private.json': sha(publication) },
          has: () => true, read: () => publication, readAsync: async () => publication };
      }, createRuntime: () => () => {} });
      coordinator.prewarm = async () => {
        if (!coordinator.status().active) await coordinator.refresh();
        return true;
      };
      return coordinator;
    },
  });
  t.after(() => service.close());
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + service.server.address().port + '/health';
  assert.equal((await fetch(url)).status, 200);
  head = makeHead('new descriptor with the same visible report');
  assert.equal((await fetch(url)).status, 503);
  await coordinator.refresh();
  const checked = await fetch(url);
  assert.equal(checked.status, 200);
  assert.equal((await checked.json()).collectorRevision, 42);
});

test('a historical request and a new report share the two-generation preparation limit', async () => {
  const sha = value => createHash('sha256').update(value).digest('hex');
  const pointer = (name, previous) => ({ version: 1, generation: sha(name),
    reportHash: sha(name + '-report'), descriptor: { name }, previous });
  const first = pointer('first'), second = pointer('second', first), third = pointer('third', second);
  let head = second, finishLoad, finishRead;
  const loads = [], loadBlocked = new Promise(resolve => { finishLoad = resolve; });
  const readBlocked = new Promise(resolve => { finishRead = resolve; });
  let startedRead, startedLoad;
  const reading = new Promise(resolve => { startedRead = resolve; });
  const loading = new Promise(resolve => { startedLoad = resolve; });
  const coordinator = createAutomaticHostedPreview({ refreshOnRequest: false, maxHandlers: 2,
    restorePrevious: true, limitPreparation: true, loadPointer: async () => head,
    async loadPackage({ pointer: value }) {
      loads.push(value.descriptor.name);
      if (value.generation === first.generation) {
        startedLoad();
        await loadBlocked;
      }
      const body = Buffer.from(JSON.stringify({ head: { manifest: { sha256: value.generation },
        reportHash: value.reportHash } }));
      return { manifest: { 'publication.private.json': sha(body) },
        has: () => true, read: () => body, readAsync: async () => body };
    },
    createRuntime: ({ packageOverride }) => async () => {
      if (packageOverride.generation === first.generation) {
        startedRead();
        await readBlocked;
      }
      return packageOverride.generation;
    },
  });
  await coordinator.refresh();
  const oldRequest = coordinator({ url: '/?generation=' + first.generation });
  await loading;
  try {
    head = third;
    await coordinator.refresh();
    assert.deepEqual(loads, ['second', 'first']);
    assert.equal(await coordinator({ url: '/' }), second.generation);
    finishLoad();
    await reading;
    await coordinator.refresh();
    assert.deepEqual(loads, ['second', 'first']);
    assert.equal(await coordinator({ url: '/' }), second.generation);
  } finally {
    finishLoad();
    finishRead();
  }
  assert.equal(await oldRequest, first.generation);
  await coordinator.refresh();
  assert.deepEqual(loads, ['second', 'first', 'third']);
  assert.equal(await coordinator({ url: '/' }), third.generation);
  assert.equal(await coordinator({ url: '/?generation=' + second.generation }), second.generation);
});
