import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  verifyDriverAuditSource,
  sourceScheduleMatches,
  createDriverAuditSourceScheduler,
  invokeDriverAuditSourceHandler,
  writeDriverAuditSourceState,
  readDriverAuditSourceConfig,
  verifyDriverAuditSourceRelease,
  driverAuditReportingFunctionCatalogSha256,
  runDriverAuditSourceChild,
  driverAuditSourceBackendEnvironment,
} from './driverAuditSource.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const minute = '2026-11-16T04:01:00.000Z';

async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'driver-audit-source-')));
  const root = path.join(base, 'release');
  await fs.mkdir(root, { mode: 0o700 });
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  await fs.mkdir(path.join(runtimeRoot, 'source/api'), { recursive: true, mode: 0o700 });
  const modulePath = 'source/api/collector.mjs';
  const moduleBytes = 'export default async function(req,res){res.writeHead(200);res.end(JSON.stringify({status:"disabled"}));}\n';
  await fs.writeFile(path.join(runtimeRoot, modulePath), moduleBytes, { mode: 0o600 });
  const entrypoint = {
    id: 'delivery', module: modulePath, exportName: 'default', method: 'GET',
    path: '/api/collector?task=delivery', schedule: '1 4,16 * * *', timeZone: 'UTC',
    maxDurationSeconds: 300, requiredEnvironment: ['CRON_SECRET', 'MATTER_DELIVERY_ENABLED'],
  };
  const manifest = { schemaVersion: 1, files: [{ path: modulePath, sha256: hash(moduleBytes), bytes: Buffer.byteLength(moduleBytes) }], entrypoints: [entrypoint] };
  const saveManifest = async () => {
    const bytes = JSON.stringify(manifest);
    await fs.writeFile(path.join(runtimeRoot, 'manifest.private.json'), bytes, { mode: 0o600 });
    return hash(bytes);
  };
  const expectedSha256 = await saveManifest();
  return { root, runtimeRoot, manifest, entrypoint, expectedSha256, saveManifest };
}

test('source verification pins the complete private source tree before loading handlers', async t => {
  const f = await fixture(t);
  const verified = await verifyDriverAuditSource({ runtimeRoot: f.runtimeRoot, expectedSha256: f.expectedSha256 });
  assert.equal(verified.entrypoints[0].path, '/api/collector?task=delivery');
  await fs.appendFile(path.join(f.runtimeRoot, f.entrypoint.module), '// changed');
  await assert.rejects(verifyDriverAuditSource({ runtimeRoot: f.runtimeRoot, expectedSha256: f.expectedSha256 }), /integrity/i);
});

test('source verification refuses a changed manifest, traversal, symlinks and unlisted source files', async t => {
  const f = await fixture(t);
  await assert.rejects(verifyDriverAuditSource({ runtimeRoot: f.runtimeRoot, expectedSha256: 'f'.repeat(64) }), /manifest/i);
  f.manifest.files[0].path = '../escape.mjs';
  await assert.rejects(verifyDriverAuditSource({ runtimeRoot: f.runtimeRoot, expectedSha256: await f.saveManifest() }), /path/i);
  f.manifest.files[0].path = f.entrypoint.module;
  const sha256 = await f.saveManifest();
  await fs.writeFile(path.join(f.runtimeRoot, 'source/unlisted.mjs'), 'export default 1;', { mode: 0o600 });
  await assert.rejects(verifyDriverAuditSource({ runtimeRoot: f.runtimeRoot, expectedSha256: sha256 }), /unlisted/i);
  await fs.unlink(path.join(f.runtimeRoot, 'source/unlisted.mjs'));
  const source = path.join(f.runtimeRoot, f.entrypoint.module);
  await fs.rename(source, path.join(f.root, 'saved.mjs'));
  await fs.symlink(path.join(f.root, 'saved.mjs'), source);
  await assert.rejects(verifyDriverAuditSource({ runtimeRoot: f.runtimeRoot, expectedSha256: sha256 }), /private|regular|symlink/i);
});

test('source verification rejects world-readable code and invalid or duplicated schedule identities', async t => {
  const f = await fixture(t);
  await fs.chmod(path.join(f.runtimeRoot, f.entrypoint.module), 0o644);
  await assert.rejects(verifyDriverAuditSource({ runtimeRoot: f.runtimeRoot, expectedSha256: f.expectedSha256 }), /private|owner/i);
  await fs.chmod(path.join(f.runtimeRoot, f.entrypoint.module), 0o600);
  f.entrypoint.schedule = '60 * * * *';
  await assert.rejects(verifyDriverAuditSource({ runtimeRoot: f.runtimeRoot, expectedSha256: await f.saveManifest() }), /schedule/i);
  f.entrypoint.schedule = '1 4,16 * * *';
  f.manifest.entrypoints.push({ ...f.entrypoint });
  await assert.rejects(verifyDriverAuditSource({ runtimeRoot: f.runtimeRoot, expectedSha256: await f.saveManifest() }), /identity|duplicate/i);
});

test('UTC schedules retain lists, ranges, steps and standard day matching', () => {
  assert.equal(sourceScheduleMatches('1 4,16 * * *', new Date(minute)), true);
  assert.equal(sourceScheduleMatches('1 4,16 * * *', new Date('2026-11-16T08:01:00Z')), false);
  assert.equal(sourceScheduleMatches('8-58/10 * * * *', new Date('2026-11-16T04:18:00Z')), true);
  assert.equal(sourceScheduleMatches('8-58/10 * * * *', new Date('2026-11-16T04:19:00Z')), false);
  assert.equal(sourceScheduleMatches('0 0 1 * 1', new Date('2026-11-16T00:00:00Z')), true);
  assert.equal(sourceScheduleMatches('0 0 * * 7', new Date('2026-11-15T00:00:00Z')), true);
  assert.throws(() => sourceScheduleMatches('*/0 * * * *', new Date(minute)), /schedule/i);
});

test('durable claims prevent duplicate dispatch and retain disabled outcomes across restart', async t => {
  const f = await fixture(t);
  const stateFile = path.join(f.root, 'state.private.json');
  const invocations = [];
  const options = {
    entrypoints: [f.entrypoint], stateFile, configSha256: 'a'.repeat(64),
    initialCursor: '2026-11-16T04:00:00.000Z',
    invoke: async entry => { invocations.push(entry.id); return { status: 'disabled', httpStatus: 200 }; },
  };
  const scheduler = await createDriverAuditSourceScheduler(options);
  await scheduler.tick(new Date(minute));
  await scheduler.drain();
  await scheduler.tick(new Date(minute));
  assert.deepEqual(invocations, ['delivery']);
  const saved = JSON.parse(await fs.readFile(stateFile));
  assert.equal(saved.jobs.delivery.status, 'disabled');
  const restarted = await createDriverAuditSourceScheduler(options);
  await restarted.tick(new Date(minute));
  await restarted.drain();
  assert.deepEqual(invocations, ['delivery']);
});

test('overlapping schedules queue durably and execute one source child at a time', async t => {
  const f = await fixture(t);
  let finish;
  const active = new Promise(resolve => { finish = resolve; });
  const calls = [];
  const entries = [
    { ...f.entrypoint, schedule: '* * * * *' },
    { ...f.entrypoint, id: 'same-route', schedule: '* * * * *' },
    { ...f.entrypoint, id: 'gps', path: '/api/collector?task=gps', schedule: '* * * * *' },
  ];
  const scheduler = await createDriverAuditSourceScheduler({
    entrypoints: entries, stateFile: path.join(f.root, 'state.private.json'), configSha256: 'a'.repeat(64),
    initialCursor: '2026-11-16T04:00:00.000Z',
    invoke: async entry => { calls.push(entry.id); if (entry.id === 'delivery') await active; return { httpStatus: 200, status: 'complete' }; },
  });
  await scheduler.tick(new Date(minute));
  await scheduler.tick(new Date('2026-11-16T04:02:00.000Z'));
  assert.equal(calls.filter(id => id === 'delivery').length, 1);
  assert.equal(calls.includes('same-route'), false);
  assert.deepEqual(calls, ['delivery']);
  const waiting = JSON.parse(await fs.readFile(path.join(f.root, 'state.private.json')));
  assert.equal(waiting.pending.length, 6);
  finish();
  await scheduler.drain();
  const state = JSON.parse(await fs.readFile(path.join(f.root, 'state.private.json')));
  assert.deepEqual(calls, ['delivery', 'same-route', 'gps', 'delivery', 'same-route', 'gps']);
  assert.equal(state.pending.length, 0);
  assert.equal(state.jobs['same-route'].status, 'complete');
  assert.equal(state.jobs.delivery.status, 'complete');
  assert.equal(state.jobs.delivery.scheduledAt, '2026-11-16T04:02:00.000Z');
});

test('queued source work resumes after restart and preserves jobs admitted before stop', async t => {
  const f = await fixture(t);
  const stateFile = path.join(f.root, 'state.private.json');
  const options = { entrypoints: [{ ...f.entrypoint, schedule: '* * * * *' }], stateFile,
    configSha256: 'a'.repeat(64), initialCursor: '2026-11-16T04:00:00.000Z' };
  let finish;
  const scheduler = await createDriverAuditSourceScheduler({ ...options,
    invoke: async () => { await new Promise(resolve => { finish = resolve; }); return { status: 'complete', httpStatus: 200 }; } });
  await scheduler.tick(new Date(minute));
  await scheduler.tick(new Date('2026-11-16T04:02:00.000Z'));
  scheduler.stop();
  finish();
  await scheduler.drain();
  assert.equal(JSON.parse(await fs.readFile(stateFile)).pending.length, 1);
  let calls = 0;
  const restarted = await createDriverAuditSourceScheduler({ ...options,
    invoke: async () => { calls++; return { status: 'complete', httpStatus: 200 }; } });
  await restarted.tick(new Date('2026-11-16T04:02:00.000Z'));
  await restarted.drain();
  assert.equal(calls, 1);
  assert.equal(JSON.parse(await fs.readFile(stateFile)).pending.length, 0);
});

test('an admitted occurrence is not dispatched twice after an interrupted result save', async t => {
  const f = await fixture(t);
  const stateFile = path.join(f.root, 'state.private.json');
  const configSha256 = 'a'.repeat(64);
  await writeDriverAuditSourceState(stateFile, { version: 1, configSha256, lastScanAt: minute,
    jobs: { delivery: { scheduledAt: minute, status: 'running' } },
    pending: [{ id: 'delivery', scheduledAt: minute }, { id: 'delivery', scheduledAt: '2026-11-16T04:02:00.000Z' }] });
  const calls = [];
  const scheduler = await createDriverAuditSourceScheduler({ stateFile, configSha256, entrypoints: [f.entrypoint],
    invoke: async (_entry, options) => { calls.push(options.scheduledAt); await options.onAdmission(); return { status: 'complete', httpStatus: 200 }; } });
  await scheduler.tick(new Date(minute));
  await scheduler.drain();
  assert.deepEqual(calls, ['2026-11-16T04:02:00.000Z']);
});

test('failed and interrupted jobs retain claims while missed minutes do not create a replay burst', async t => {
  const f = await fixture(t);
  const stateFile = path.join(f.root, 'state.private.json');
  const configSha256 = 'a'.repeat(64);
  await writeDriverAuditSourceState(stateFile, {
    version: 1, configSha256, lastScanAt: minute,
    jobs: { delivery: { scheduledAt: minute, status: 'running' } },
  });
  let calls = 0;
  const scheduler = await createDriverAuditSourceScheduler({
    entrypoints: [{ ...f.entrypoint, schedule: '* * * * *' }], stateFile, configSha256,
    invoke: async () => { calls++; throw Error('private credential must never be logged'); },
  });
  assert.equal(JSON.parse(await fs.readFile(stateFile)).jobs.delivery.status, 'interrupted');
  await scheduler.tick(new Date('2026-11-16T04:10:00.000Z'));
  await scheduler.drain();
  const saved = JSON.parse(await fs.readFile(stateFile));
  assert.equal(calls, 1);
  assert.equal(saved.missedMinutes, 8);
  assert.equal(saved.jobs.delivery.status, 'failed');
  assert.equal(JSON.stringify(saved).includes('private credential'), false);
  scheduler.stop();
  await scheduler.tick(new Date('2026-11-16T04:11:00.000Z'));
  assert.equal(calls, 1);
});

test('a fresh cutover advances existing schedule state through the old writer fence', async t => {
  const f = await fixture(t);
  const stateFile = path.join(f.root, 'state.private.json');
  const configSha256 = 'a'.repeat(64);
  await writeDriverAuditSourceState(stateFile, { version: 1, configSha256,
    lastScanAt: '2026-11-16T04:00:00.000Z', jobs: { delivery: { scheduledAt: minute, status: 'complete' } } });
  let calls = 0;
  const scheduler = await createDriverAuditSourceScheduler({ stateFile, configSha256,
    entrypoints: [{ ...f.entrypoint, schedule: '* * * * *' }], initialCursor: '2026-11-16T04:10:00.000Z',
    invoke: async () => { calls++; return { status: 'complete', httpStatus: 200 }; } });
  await scheduler.tick(new Date('2026-11-16T04:10:00.000Z'));
  await scheduler.drain();
  assert.equal(calls, 0);
  assert.equal(scheduler.snapshot().jobs.delivery.status, 'complete');
  await scheduler.tick(new Date('2026-11-16T04:11:00.000Z'));
  await scheduler.drain();
  assert.equal(calls, 1);
});

test('handler adapter preserves cron requests and disabled behavior without exposing response data', async t => {
  const f = await fixture(t);
  const env = { CRON_SECRET: 'c'.repeat(32), MATTER_DELIVERY_ENABLED: '0' };
  const result = await invokeDriverAuditSourceHandler(async (req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/api/collector?task=delivery');
    assert.equal(req.headers.authorization, 'Bearer ' + env.CRON_SECRET);
    assert.equal(req.headers['x-vercel-cron-schedule'], '1 4,16 * * *');
    assert.equal(req.headers['user-agent'], 'vercel-cron/1.0');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'disabled', secret: 'do not retain' }));
  }, { entrypoint: f.entrypoint, environment: env });
  assert.deepEqual(result, { httpStatus: 200, status: 'disabled' });
  await assert.rejects(invokeDriverAuditSourceHandler(async (_req, res) => {
    res.writeHead(503); res.end('private failure');
  }, { entrypoint: f.entrypoint, environment: env }), /handler/i);
  await assert.rejects(invokeDriverAuditSourceHandler(async (_req, res) => {
    res.writeHead(200); res.end('{"status":"unexpected"}');
  }, { entrypoint: f.entrypoint, environment: env }), /status/i);
});

test('handler results retain partial work, deferred reasons and unsettled budget state', async t => {
  const f = await fixture(t);
  const result = await invokeDriverAuditSourceHandler(async (_req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'needs-inspection', failed: 2, completed: 3, pending: 4,
      reason: 'publication-contended', budgetSettlement: 'retained', privateRecord: 'excluded' }));
  }, { entrypoint: f.entrypoint, environment: { CRON_SECRET: 'c'.repeat(32) } });
  assert.deepEqual(result, { httpStatus: 200, status: 'needs-inspection', failed: 2, completed: 3, pending: 4,
    reason: 'publication-contended', budgetSettlement: 'retained' });
});

async function configuredFixture(t) {
  const f = await fixture(t);
  const environment = { CRON_SECRET: 'c'.repeat(32), MATTER_DELIVERY_ENABLED: '0' };
  const environmentBytes = JSON.stringify(environment);
  await fs.writeFile(path.join(f.root, 'environment.private.json'), environmentBytes, { mode: 0o600 });
  const config = {
    version: 1, root: f.root, runtimeRoot: f.runtimeRoot, manifestSha256: f.expectedSha256,
    environment: { path: path.join(f.root, 'environment.private.json'), sha256: hash(environmentBytes) },
    nodeVersion: process.version, nodeExecutable: process.execPath,
    gatewayCredential: null,
  };
  const configFile = path.join(f.root, 'source.json');
  const configBytes = JSON.stringify(config);
  await fs.writeFile(configFile, configBytes, { mode: 0o600 });
  return { ...f, config, configFile, configSha256: hash(configBytes), environment };
}

test('private source config binds environment bytes and Node version without merging host secrets', async t => {
  const f = await configuredFixture(t);
  const checked = await readDriverAuditSourceConfig(f.configFile);
  assert.deepEqual(checked.environment, f.environment);
  assert.equal(checked.configSha256, f.configSha256);
  await fs.appendFile(f.config.environment.path, ' ');
  await assert.rejects(readDriverAuditSourceConfig(f.configFile), /environment/i);
});

test('source configuration pins its qualified executable path', async t => {
  const f = await configuredFixture(t);
  f.config.nodeExecutable = '/unqualified/node';
  await fs.writeFile(f.configFile, JSON.stringify(f.config), { mode: 0o600 });
  await assert.rejects(readDriverAuditSourceConfig(f.configFile), /executable|Node/i);
});

test('Sidi Supabase backend selection excludes inherited native connection settings without changing either input', () => {
  const config = { executionHost: 'sidi', dataStore: 'supabase', environment: {
    DRIVER_AUDIT_EXECUTION_HOST: 'sidi', MATTER_SUPABASE_SECRET: 'fictional-staged-source' } };
  const app = { DRIVER_AUDIT_DATA_STORE: 'mongo', MONGODB_URI: 'mongodb://fixture.invalid/never-open',
    DRIVER_AUDIT_NATIVE_CAPACITY_BYTES: '17179869184', DRIVER_AUDIT_SUPABASE_SECRET: 'fictional-inherited-alias' };
  const before = structuredClone({ config, app });
  const environment = driverAuditSourceBackendEnvironment(config, app);
  assert.equal(environment.DRIVER_AUDIT_DATA_STORE, 'supabase');
  assert.equal(environment.MONGODB_URI, undefined);
  assert.equal(environment.DRIVER_AUDIT_NATIVE_CAPACITY_BYTES, undefined);
  assert.equal(environment.DRIVER_AUDIT_SUPABASE_SECRET, 'fictional-staged-source');
  assert.deepEqual({ config, app }, before);
});

test('cutover requires fresh hash-pinned recovery, parity, credential and stopped-source receipts', async t => {
  const f = await configuredFixture(t);
  const now = new Date(minute);
  const release = {
    version: 1, verified: true, configSha256: f.configSha256, runtimeManifestSha256: f.expectedSha256,
    environmentSha256: f.config.environment.sha256, verifiedAt: minute, validUntil: '2026-11-16T04:16:00.000Z',
    initialCursor: '2026-11-16T04:00:00.000Z', nodeVersion: process.version,
  };
  for (const kind of ['backup', 'parity', 'credentials', 'sourceFence']) {
    const value = { version: 1, verified: true, kind, runtimeManifestSha256: f.expectedSha256 };
    if (kind === 'sourceFence') Object.assign(value, { writersStopped: true, leasesDrained: true, initialCursor: release.initialCursor, validUntil: release.validUntil });
    const bytes = JSON.stringify(value);
    const file = path.join(f.root, kind + '.private.json');
    await fs.writeFile(file, bytes, { mode: 0o600 });
    release[kind] = { path: file, sha256: hash(bytes) };
  }
  release.backup.path = 'backup.private.json';
  const releaseFile = path.join(f.root, 'release.private.json');
  const bytes = JSON.stringify(release);
  await fs.writeFile(releaseFile, bytes, { mode: 0o600 });
  const checked = await readDriverAuditSourceConfig(f.configFile);
  assert.equal((await verifyDriverAuditSourceRelease(checked, { path: releaseFile, sha256: hash(bytes) }, now)).release.initialCursor,
    '2026-11-16T04:00:00.000Z');
  await assert.rejects(verifyDriverAuditSourceRelease(checked, { path: releaseFile, sha256: hash(bytes) }, new Date('2026-11-16T04:17:00Z')), /expired|fresh/i);
  await fs.appendFile(release.parity.path, ' ');
  await assert.rejects(verifyDriverAuditSourceRelease(checked, { path: releaseFile, sha256: hash(bytes) }, now), /receipt|integrity/i);
});

async function capabilityFenceFixture(t) {
  const f = await configuredFixture(t);
  const config = { ...await readDriverAuditSourceConfig(f.configFile), dataStore: 'mongo',
    environment: { ...f.environment, DRIVER_AUDIT_DATA_STORE: 'mongo' } };
  const release = { version: 1, verified: true, configSha256: config.configSha256,
    runtimeManifestSha256: config.manifestSha256, environmentSha256: config.environmentReference.sha256,
    nodeVersion: process.version, initialCursor: '2026-11-16T04:00:00.000Z',
    verifiedAt: '2026-11-16T04:10:00.000Z', validUntil: '2026-11-16T04:25:00.000Z' };
  const save = async (name, value) => {
    const raw = JSON.stringify(value), file = path.join(f.root, name + '.private.json');
    await fs.writeFile(file, raw, { mode: 0o600 });
    return { path: name + '.private.json', sha256: hash(raw) };
  };
  const backup = { version: 1, verified: true, kind: 'backup', uncertainAttemptsBaseline: {
    count: 5, sha256: 'c'.repeat(64), snapshotId: 'fictional-final-snapshot',
    sourceSnapshotSha256: 'd'.repeat(64), restoreVerificationSha256: 'e'.repeat(64),
  } };
  for (const kind of ['backup', 'parity', 'credentials']) release[kind] = await save(kind,
    kind === 'backup' ? backup : { version: 1, verified: true, kind });
  const common = { version: 1, verified: true, sourceProjectRef: 'trhhjfgfmxofxhnzocks',
    legacyRuntimeSha256: 'a'.repeat(64), legacyEntrypointsSha256: 'b'.repeat(64),
    admissionBlockedAt: '2026-11-16T04:00:10.000Z', checkedAt: '2026-11-16T04:06:30.000Z' };
  const mutators = ['archive_consume(uuid,uuid,bigint)', 'archive_consume(uuid,uuid,bigint,text)',
    'archive_release(uuid)', 'archive_reserve(uuid,bigint)', 'collector_cas(uuid,bigint,bigint,text,text,text,text)',
    'collector_cas_review(uuid,bigint,bigint,bigint,text,text,text,text)', 'lease_acquire(uuid,integer)',
    'lease_release(uuid,bigint)', 'qualification_cas(uuid,bigint,bigint,text,text,text,text)',
    'qualification_lease_acquire(uuid,integer)', 'qualification_lease_release(uuid,bigint)',
    'state_cas(text,bigint,text,text,text,text)'];
  const fenced = [...mutators.map(name => 'matter_reporting_hosted.' + name), ...mutators.map(name => 'public.matter_hosted_' + name),
    'public.matter_hosted_gps_retention_register(jsonb,jsonb,jsonb)', 'public.matter_hosted_preview_road_cache(text,text,uuid,jsonb)'];
  const internal = ['archive_capacity(bigint)', 'deny_receipt_change()', 'gps_retention_watch()',
    'lease_assert(uuid,bigint)', 'membership_lookup(uuid)', 'membership_provision(uuid,text,boolean,bigint,text,text)',
    'qualification_lease_assert(uuid,bigint)', 'session_active(uuid,uuid)', 'state_cas_internal(text,bigint,text,text,text,text)',
    'state_read(text)', 'state_receipts(text,bigint,integer)'];
  const publicReads = ['archive_capacity(bigint)', 'gps_retention_inventory(text)', 'lease_assert(uuid,bigint)',
    'membership_lookup(uuid)', 'membership_provision(uuid,text,boolean,bigint,text,text)', 'qualification_lease_assert(uuid,bigint)',
    'session_active(uuid,uuid)', 'state_read(text)', 'state_read_if_changed(text,bigint)', 'state_receipts(text,bigint,integer)'];
  const functions = [...fenced, ...internal.map(name => 'matter_reporting_hosted.' + name),
    ...publicReads.map(name => 'public.matter_hosted_' + name)].map(identity => ({ identity, owner: 'postgres',
    beforeDefinitionSha256: hash(identity), definitionSha256: hash(identity), beforeAclSha256: hash(identity + '-acl'),
    aclSha256: hash(identity + (fenced.includes(identity) ? '-revoked' : '-acl')),
    beforeApiExecutableRoles: ['matter_reporting_hosted.state_cas_internal(text,bigint,text,text,text,text)',
      'matter_reporting_hosted.deny_receipt_change()', 'matter_reporting_hosted.gps_retention_watch()'].includes(identity) ? [] : ['service_role'],
    apiExecutableRoles: fenced.includes(identity) || ['matter_reporting_hosted.state_cas_internal(text,bigint,text,text,text,text)',
      'matter_reporting_hosted.deny_receipt_change()', 'matter_reporting_hosted.gps_retention_watch()'].includes(identity) ? [] : ['service_role'] }));
  const fingerprints = Object.fromEntries(['documents', 'receipts', 'archive', 'reservations', 'roadCache', 'capabilities']
    .map(name => [name, hash('fictional-' + name)]));
  const uncertainAttempts = { beforeCount: 5, afterCount: 5, beforeSha256: 'c'.repeat(64), afterSha256: 'c'.repeat(64) };
  const proofs = {
    capabilityAudit: { ...common, id: 'capabilities-1', kind: 'reporting-capability-audit',
      capabilitySha256: fingerprints.capabilities,
      baselineCatalogSha256: hash('fictional-baseline'), functions, apiRoles: ['PUBLIC', 'anon', 'authenticated', 'service_role'],
      ownerBypassRoles: ['postgres', 'supabase_admin'], roleMembershipSha256: hash('fictional-membership'), serviceRoleCannotAssumeOwner: true,
      roadCache: { identity: 'matter_preview_cache.road_geometry', apiWritableRoles: [], selectPreserved: true,
        beforeAclSha256: hash('road-before'), aclSha256: hash('road-after') },
      sqlCron: [4, 5].map(id => ({ id, active: false, owner: 'postgres', beforeCommandSha256: hash('job-' + id), commandSha256: hash('job-' + id) })),
      unrelatedBeforeSha256: hash('unrelated'), unrelatedAfterSha256: hash('unrelated'), rawStorageAndGatewayRevoked: false },
    drainAudit: { ...common, id: 'drain-1', kind: 'reporting-drain-audit', activeLeases: 0, activeReportingTransactions: 0,
      activeSqlCronRuns: 0, activeProviderWork: 0, privilegedReportingWriters: 0,
      admissionGraphSha256: hash('fictional-admission-graph'), ownerAuditSha256: hash('fictional-owner-audit'), uncertainAttempts },
    quietAudit: { ...common, id: 'quiet-1', kind: 'reporting-quiet-window',
      samples: [{ id: 'sample-before', at: '2026-11-16T04:00:30.000Z', sha256: hash('sample-before'), fingerprints },
        { id: 'sample-after', at: '2026-11-16T04:05:30.000Z', sha256: hash('sample-after'), fingerprints: { ...fingerprints } }] },
    checkpoint: { ...common, id: 'checkpoint-1', kind: 'reporting-final-checkpoint', snapshotId: 'fictional-final-snapshot',
      sourceSnapshotSha256: backup.uncertainAttemptsBaseline.sourceSnapshotSha256,
      restoreVerificationSha256: backup.uncertainAttemptsBaseline.restoreVerificationSha256,
      capturedAt: '2026-11-16T04:06:30.000Z', initialCursor: release.initialCursor, collectorRevision: 7, reviewRevision: 1,
      backupReceiptSha256: release.backup.sha256, parityReceiptSha256: release.parity.sha256,
      fingerprints: { ...fingerprints }, uncertainAttempts: { ...uncertainAttempts } },
  };
  const fence = { ...common, id: 'fence-1', mode: 'reporting-database-capability-v1', writersStopped: false,
    checkedAt: '2026-11-16T04:07:00.000Z', initialCursor: release.initialCursor, validUntil: release.validUntil };
  async function verify(now = new Date(release.verifiedAt)) {
    for (const [name, proof] of Object.entries(proofs)) fence[name] = { ...await save(name, proof), id: proof.id };
    release.sourceFence = await save('sourceFence', fence);
    const reference = await save('release', release);
    return verifyDriverAuditSourceRelease(config, { ...reference, path: path.join(f.root, reference.path) }, now);
  }
  return { ...f, config, fence, proofs, release, backup, verify, save };
}

test('native cutover accepts identified database capability evidence without claiming stopped cron processes', async t => {
  const f = await capabilityFenceFixture(t);
  const checked = await f.verify();
  assert.equal(checked.release.initialCursor, f.release.initialCursor);
  assert.equal(f.fence.writersStopped, false);
  assert.equal(f.proofs.drainAudit.uncertainAttempts.afterCount, 5);
});

async function hostingAdmissionFixture(t) {
  const f = await capabilityFenceFixture(t), cap = f.proofs.capabilityAudit;
  Object.assign(f.config, { dataStore: 'supabase', executionHost: 'sidi', environment: { DRIVER_AUDIT_EXECUTION_HOST: 'sidi' } });
  Object.assign(f.release, { verifiedAt: '2026-11-16T04:15:00.000Z' });
  Object.assign(f.fence, { mode: 'reporting-hosting-admission-v1', oldHostingAdmissionsFenced: true,
    sharedReportingRpcWritesUsable: true, checkedAt: '2026-11-16T04:14:30.000Z' });
  for (const row of cap.functions) {
    row.aclSha256 = row.beforeAclSha256;
    row.apiExecutableRoles = [...row.beforeApiExecutableRoles];
  }
  const internal = cap.functions.find(row => row.identity.startsWith('matter_reporting_hosted.state_cas_internal('));
  internal.definitionSha256 = hash('fictional-hosting-admission-guard');
  Object.assign(f.fence, { hostingAdmissionSqlSha256: hash('hosting-sql'), hostingGuardDefinitionSha256: internal.definitionSha256 });
  Object.assign(cap, { kind: 'reporting-hosting-admission-audit', checkedAt: f.fence.checkedAt,
    oldHostingAdmissionsFenced: true, sharedReportingRpcWritesUsable: true, paidGradingPolicyUnchanged: true });
  const origin = { version: 1, verified: true, kind: 'reporting-hosting-admission-origin-v1',
    sourceProjectRef: f.fence.sourceProjectRef, executionId: 'hosting-origin-1', sqlSha256: hash('hosting-sql'),
    transactionId: '234567', backendPid: 321, commitBeforeAt: f.fence.admissionBlockedAt,
    commitAfterAt: '2026-11-16T04:00:11.000Z', admissionBlockedAt: f.fence.admissionBlockedAt,
    beforeObservationAt: '2026-11-16T04:00:09.000Z', afterObservationAt: '2026-11-16T04:00:12.000Z',
    beforeObservationSha256: hash('hosting-before'), afterObservationSha256: hash('hosting-after'),
    legacyRuntimeSha256: f.fence.legacyRuntimeSha256, legacyEntrypointsSha256: f.fence.legacyEntrypointsSha256,
    originalInternalDefinitionSha256: internal.beforeDefinitionSha256, hostingGuardDefinitionSha256: internal.definitionSha256,
    guardFunctionIdentity: internal.identity, oldHostingAdmissionsFenced: true, sharedReportingRpcWritesUsable: true,
    paidGradingPolicyUnchanged: true, originalRolesSchemasRelationsAndGallaboxPreserved: true,
    cronJobsDisabled: [4, 5], hostingBudgetPolicyCount: 11, applied: true, alreadyClosed: false, reapplied: false };
  origin.appRpcFunctions = ['progress_read(text)', 'progress_cas(text,uuid,bigint,bigint,text,text,text,text)',
    'photo_alias_read(text)', 'photo_alias_register(text,jsonb)', 'read_egress_read()',
    'read_egress_reserve(uuid,bigint,bigint)', 'read_egress_settle(uuid,bigint,bigint)'].map(signature => ({
    identity: 'public.matter_hosted_app_' + signature, owner: 'postgres', definitionSha256: hash('definition-' + signature),
    aclSha256: hash('acl-' + signature), apiExecutableRoles: ['service_role'] }));
  const appCatalog = hash(JSON.stringify([...origin.appRpcFunctions].sort((left, right) => left.identity < right.identity ? -1 : 1)));
  Object.assign(origin, { appRpcCatalogSha256: appCatalog, beforeAppRpcCatalogSha256: appCatalog, afterAppRpcCatalogSha256: appCatalog });
  f.fence.appRpcCatalogSha256 = cap.appRpcCatalogSha256 = appCatalog;
  origin.appHelperFunctions = ['compact_json(json,integer)', 'deny_alias_change()', 'egress_summary(timestamp with time zone)',
    'matches_schema(jsonb,jsonb)', 'progress_schema(boolean)', 'prune_egress(timestamp with time zone)',
    'valid_alias(text,jsonb)', 'valid_key(text)', 'valid_scalar(jsonb,text,integer)', 'validate_progress(text,text)',
    'validation_progress_schema()'].map(signature => ({ identity: 'matter_reporting_app.' + signature, owner: 'postgres',
    definitionSha256: hash('private-definition-' + signature), aclSha256: hash('private-acl-' + signature), apiExecutableRoles: [] }));
  const appHelperCatalog = hash(JSON.stringify([...origin.appHelperFunctions].sort((left, right) => left.identity < right.identity ? -1 : 1)));
  Object.assign(origin, { appHelperCatalogSha256: appHelperCatalog, beforeAppHelperCatalogSha256: appHelperCatalog,
    afterAppHelperCatalogSha256: appHelperCatalog });
  f.fence.appHelperCatalogSha256 = cap.appHelperCatalogSha256 = appHelperCatalog;
  f.config.runtime.entrypoints = Array.from({ length: 13 }, (_, index) => ({ ...f.config.runtime.entrypoints[0], id: 'original-job-' + index }));
  const requestHandlers = ['collector', 'index', 'morning-gps', 'private-validation', 'qualify-publication', 'qualify']
    .map(name => ({ module: 'source/api/' + name + '.mjs', exportName: 'default', maxDurationSeconds: 300 }));
  const directPaths = [
    ...['/api/collector', '/api/collector?task=auto', '/api/collector?verify=1', '/api/collector?verify=photo']
      .map(path => ({ module: 'source/api/collector.mjs', method: 'GET', path, admission: 'worker-or-reader-budget-before-operation' })),
    { module: 'source/api/qualify.mjs', method: 'POST', path: '/api/qualify', admission: 'worker-budget-before-qualification' },
    { module: 'source/api/qualify-publication.mjs', method: 'POST', path: '/api/qualify-publication', admission: 'permanently-closed-503' },
    ...['delivery-identities', 'fresh-run', 'api-refresh', 'reviews/migrate'].map(name => ({ module: 'source/api/index.mjs',
      method: 'POST', path: '/api/reporting/' + name, admission: 'reader-budget-before-service-initialization' })),
    { module: 'source/api/index.mjs', method: 'POST', path: '/api/reporting/reviews', admission: 'intentionally-preserved-human-review-write' }];
  const graph = { version: 1, kind: 'legacy-hosting-admission-review', verified: true, sourceProjectRef: f.fence.sourceProjectRef,
    legacyRuntimeSha256: f.fence.legacyRuntimeSha256, legacyEntrypointsSha256: f.fence.legacyEntrypointsSha256,
    coveredEntrypoints: 13, maximumRuntimeMs: 300000, graceMs: 60000,
    allProviderNetworkRequiresCommittedAdmission: true, paidModelCallsAdditionallyRequireUniquePaidAttempt: true,
    gradeResultDurableBeforePaidSettlement: true, sharedHumanReviewWritesRemainAllowed: true,
    actualWorkDrainedByThisReview: false, cronProcessesStopped: false, allDatabaseWritesFenced: false,
    paidLedgerFrozen: false, productionSqlExecuted: false, sourceMutations: 0,
    entrypoints: structuredClone(f.config.runtime.entrypoints), requestHandlers, directPaths,
    originalFiles: Array.from({ length: 131 }, (_, index) => ({ path: 'source/original-' + index + '.mjs', bytes: 1, sha256: hash('original-' + index) })),
    localFixture: { fixtureSha256: hash('graph-fixture'), logSha256: hash('graph-log'), groups: 5, scheduleCases: 13,
      manualAndPreviewCases: 11, sourceCalls: 0, providerCalls: 0, actualDatabaseCalls: 0 } };
  const fingerprints = Object.fromEntries(['hostingLedgers', 'admissionGraph', 'providerWork', 'leases'].map(key => [key, hash('hosting-' + key)]));
  origin.afterHostingControlSha256 = cap.hostingControlSha256 = fingerprints.admissionGraph;
  const uncertain = { ...f.proofs.drainAudit.uncertainAttempts, scope: 'baseline-subset', beforeTotalCount: 6, afterTotalCount: 6 };
  Object.assign(f.proofs.drainAudit, { kind: 'reporting-hosting-drain-audit', checkedAt: '2026-11-16T04:06:20.000Z',
    possibleReportingHttpQueue: 0, uncertainAttempts: uncertain, hostingControlSha256: fingerprints.admissionGraph });
  Object.assign(f.proofs.quietAudit, { kind: 'reporting-hosting-quiet-window', checkedAt: '2026-11-16T04:11:30.000Z',
    samples: [{ id: 'hosting-sample-before', sha256: hash('hosting-sample-before'), at: '2026-11-16T04:06:30.000Z', fingerprints },
      { id: 'hosting-sample-after', sha256: hash('hosting-sample-after'), at: '2026-11-16T04:11:30.000Z', fingerprints: { ...fingerprints } }] });
  Object.assign(f.backup.uncertainAttemptsBaseline, { sha256: hash('original-whole-paid-ledger'), subsetSha256: 'c'.repeat(64) });
  f.release.backup = await f.save('backup', f.backup);
  const checkpoint = f.proofs.checkpoint;
  Object.assign(checkpoint, { checkedAt: '2026-11-16T04:14:00.000Z', capturedAt: '2026-11-16T04:12:00.000Z',
    uncertainAttempts: { ...uncertain }, hostingFingerprints: fingerprints,
    collectorBodySha256: hash('actual-collector'), reviewBodySha256: hash('actual-review'),
    sourceReadback: { checkedAt: '2026-11-16T04:14:00.000Z', collectorRevision: 7, reviewRevision: 1,
      collectorBodySha256: hash('actual-collector'), reviewBodySha256: hash('actual-review') } });
  checkpoint.backupReceiptSha256 = f.release.backup.sha256;
  const parity = { version: 1, verified: true, kind: 'supabase-sidi-source-parity-v1', dataStore: 'supabase',
    configSha256: f.config.configSha256, runtimeManifestSha256: f.config.manifestSha256,
    environmentSha256: f.config.environmentReference.sha256, collectorRevision: 7, reviewRevision: 1,
    collectorBodySha256: checkpoint.collectorBodySha256, reviewBodySha256: checkpoint.reviewBodySha256,
    hostQualification: { fixtureSha256: hash('original-fixture'), receiptSha256: hash('actual-linux-receipt') } };
  f.release.parity = await f.save('parity', parity);
  checkpoint.parityReceiptSha256 = f.release.parity.sha256;
  const credentialEvidence = { version: 1, verified: true, environmentSha256: f.config.environmentReference.sha256 };
  const evidence = await f.save('credentialEvidence', credentialEvidence);
  f.release.credentials = await f.save('credentials', { version: 1, verified: true,
    environmentSha256: f.config.environmentReference.sha256, evidenceSha256: evidence.sha256, evidence });
  const verify = async (now = new Date(f.release.verifiedAt)) => {
    const graphBytes = Buffer.from(JSON.stringify(graph)), graphSha256 = hash(graphBytes);
    cap.admissionGraph = { sha256: graphSha256, dataBase64: graphBytes.toString('base64') };
    f.fence.hostingAdmissionGraphSha256 = graphSha256;
    f.proofs.drainAudit.admissionGraphSha256 = graphSha256;
    f.proofs.quietAudit.admissionGraphSha256 = graphSha256;
    const project = row => ({ identity: row.identity, owner: row.owner, definitionSha256: row.definitionSha256,
      aclSha256: row.aclSha256, apiExecutableRoles: row.apiExecutableRoles });
    origin.functions = cap.functions.map(project);
    origin.beforeCatalogSha256 = driverAuditReportingFunctionCatalogSha256(cap.functions.map(row => project({ ...row,
      definitionSha256: row.beforeDefinitionSha256, aclSha256: row.beforeAclSha256, apiExecutableRoles: row.beforeApiExecutableRoles })));
    origin.afterCatalogSha256 = driverAuditReportingFunctionCatalogSha256(origin.functions);
    cap.baselineCatalogSha256 = origin.beforeCatalogSha256;
    const bytes = Buffer.from(JSON.stringify(origin));
    cap.hostingAdmissionReceipt = { sha256: hash(bytes), dataBase64: bytes.toString('base64') };
    f.fence.hostingAdmissionReceiptSha256 = hash(bytes);
    f.proofs.drainAudit.hostingAdmissionReceiptSha256 = f.proofs.quietAudit.hostingAdmissionReceiptSha256 = hash(bytes);
    f.proofs.quietAudit.drainAuditSha256 = (await f.save('drainAudit', f.proofs.drainAudit)).sha256;
    return f.verify(now);
  };
  return { ...f, origin, graph, parity, credentialEvidence, evidence, verify };
}

test('Sidi Supabase handoff fences only old hosting admissions and retains the original uncertain subset', async t => {
  const f = await hostingAdmissionFixture(t);
  const checked = await f.verify();
  assert.equal(checked.release.initialCursor, f.release.initialCursor);
  assert.equal(checked.validatedFence, undefined);
  assert.equal(f.fence.writersStopped, false);
  assert.equal(f.proofs.drainAudit.uncertainAttempts.afterTotalCount, 6);
});

test('Supabase hosting handoff rejects broadened revocation, stale origins, shortened drain and changed backup heads', async t => {
  for (const change of [f => { f.config.executionHost = null; }, f => { f.config.dataStore = 'mongo'; },
    f => { f.fence.writersStopped = true; }, f => { f.origin.sharedReportingRpcWritesUsable = false; },
    f => { f.fence.mode = 'stopped-process'; f.fence.writersStopped = true; f.fence.leasesDrained = true; },
    f => { f.origin.reapplied = true; }, f => { f.origin.admissionBlockedAt = '2026-11-16T04:01:00.000Z'; },
    f => { f.origin.commitAfterAt = '2026-11-16T04:04:00.000Z'; },
    f => { f.proofs.drainAudit.checkedAt = '2026-11-16T04:06:10.000Z'; },
    f => { f.proofs.quietAudit.samples[0].at = '2026-11-16T04:05:00.000Z'; },
    f => { f.proofs.quietAudit.samples[1].fingerprints.hostingLedgers = hash('changed-hosting-ledger'); },
    f => { f.proofs.checkpoint.sourceReadback.collectorRevision++; },
    f => { f.proofs.checkpoint.uncertainAttempts.afterSha256 = hash('lost-original-uncertain'); },
    f => { f.release.validUntil = f.fence.validUntil = '2026-11-16T04:30:10.001Z'; },
    f => { f.origin.hostingBudgetPolicyCount = 10; },
    f => { f.origin.appRpcFunctions[0].apiExecutableRoles = ['PUBLIC', 'service_role']; },
    f => { f.origin.beforeAppRpcCatalogSha256 = hash('different-app-rpc-before'); },
    f => { f.fence.appRpcCatalogSha256 = hash('wrong-reviewed-app-rpcs'); },
    f => { f.proofs.capabilityAudit.hostingControlSha256 = hash('different-physical-control-state'); },
    f => { const row = f.proofs.capabilityAudit.functions.find(row => row.identity.startsWith('public.matter_hosted_collector_cas(')); row.apiExecutableRoles = []; },
    f => { const row = f.proofs.capabilityAudit.functions.find(row => row.identity.startsWith('public.matter_hosted_state_read(')); row.definitionSha256 = hash('unrelated-edit'); }]) {
    const f = await hostingAdmissionFixture(t); await change(f);
    await assert.rejects(f.verify(), /hosting|Supabase|drain|quiet|origin|checkpoint|window|scope|catalog|uncertain/i);
  }
});

test('the hosting credential wrapper cannot relink a verified evidence file from another environment', async t => {
  const f = await hostingAdmissionFixture(t);
  const evidence = await f.save('credentialEvidence', { ...f.credentialEvidence, environmentSha256: hash('foreign-environment') });
  f.release.credentials = await f.save('credentials', { version: 1, verified: true,
    environmentSha256: f.config.environmentReference.sha256, evidenceSha256: evidence.sha256, evidence });
  await assert.rejects(f.verify(), /credential|environment/i);
});

test('hosting admission binds the complete owner-only app helper schema independently of public RPCs', async t => {
  for (const change of [f => { delete f.fence.appHelperCatalogSha256; },
    f => { f.fence.appHelperCatalogSha256 = hash('wrong-reviewed-helper-catalog'); },
    f => { f.proofs.capabilityAudit.appHelperCatalogSha256 = hash('different-audit-helpers'); },
    f => { f.origin.beforeAppHelperCatalogSha256 = hash('old-private-schema'); },
    f => { f.origin.afterAppHelperCatalogSha256 = hash('drifted-private-schema'); },
    f => { f.origin.appHelperFunctions[0].definitionSha256 = hash('changed-private-schema'); },
    f => { f.origin.appHelperFunctions.pop(); },
    f => { f.origin.appHelperFunctions[0].identity = f.origin.appHelperFunctions[1].identity; },
    f => { f.origin.appHelperFunctions[0].identity = 'matter_reporting_app.unknown_helper()'; },
    f => { f.origin.appHelperFunctions[0].owner = 'service_role'; },
    f => { f.origin.appHelperFunctions[0].apiExecutableRoles = ['service_role']; }]) {
    const f = await hostingAdmissionFixture(t); change(f);
    await assert.rejects(f.verify(), /hosting|helper|catalog|scope/i);
  }
});

test('hosting admission requires complete exact original schedule and direct-path coverage', async t => {
  for (const change of [f => { f.graph.coveredEntrypoints = 12; }, f => { f.graph.entrypoints.pop(); },
    f => { f.graph.entrypoints[0].schedule = '0 0 * * *'; },
    f => { f.graph.directPaths.find(row => row.path.endsWith('/reviews')).admission = 'blocked'; },
    f => { f.graph.requestHandlers.pop(); }, f => { f.graph.allProviderNetworkRequiresCommittedAdmission = false; },
    f => { f.graph.actualWorkDrainedByThisReview = true; }, f => { f.graph.originalFiles.pop(); }]) {
    const f = await hostingAdmissionFixture(t); change(f);
    await assert.rejects(f.verify(), /hosting|graph|coverage|entrypoint|scope/i);
  }
});

async function twoPhaseCapabilityFixture(t) {
  const f = await capabilityFenceFixture(t), cap = f.proofs.capabilityAudit;
  const admissionBlockedAt = '2026-11-16T03:35:00.000Z', dataWritesBlockedAt = '2026-11-16T04:00:00.000Z';
  for (const proof of Object.values(f.proofs)) Object.assign(proof, { admissionBlockedAt, dataWritesBlockedAt });
  Object.assign(f.fence, { mode: 'reporting-database-capability-v2', admissionBlockedAt, dataWritesBlockedAt,
    initialCursor: '2026-11-16T03:34:00.000Z' });
  f.release.initialCursor = f.proofs.checkpoint.initialCursor = f.fence.initialCursor;
  const original = cap.functions.map(row => ({ identity: row.identity, owner: row.owner,
    definitionSha256: row.beforeDefinitionSha256, aclSha256: row.beforeAclSha256, apiExecutableRoles: row.beforeApiExecutableRoles }));
  const internal = original.find(row => row.identity.startsWith('matter_reporting_hosted.state_cas_internal('));
  const functions = structuredClone(original);
  functions.find(row => row.identity === internal.identity).definitionSha256 = hash('fictional-admission-guard');
  const phase1 = { version: 1, kind: 'provider-admission-fence-phase1', verified: true, sourceProjectRef: f.fence.sourceProjectRef,
    executionId: 'actual-phase1-execution', sqlSha256: hash('phase1-sql'), legacyRuntimeSha256: f.fence.legacyRuntimeSha256,
    legacyEntrypointsSha256: f.fence.legacyEntrypointsSha256, transactionId: '123456', backendPid: 123,
    commitBeforeAt: '2026-11-16T03:34:59.000Z', commitAfterAt: admissionBlockedAt, admissionBlockedAt,
    beforeObservationAt: '2026-11-16T03:34:58.000Z', afterObservationAt: '2026-11-16T03:35:02.000Z',
    beforeObservationSha256: hash('phase1-before'), afterObservationSha256: hash('phase1-after'),
    beforeCatalogSha256: driverAuditReportingFunctionCatalogSha256(original),
    afterCatalogSha256: driverAuditReportingFunctionCatalogSha256(functions), baselineCatalogSha256: cap.baselineCatalogSha256,
    internalDefinitionSha256: hash('fictional-admission-guard'), functions, applied: true, alreadyClosed: false, reapplied: false,
    providerAdmissionsBlocked: true, downstreamSettlementsPreserved: true, all11ProviderBudgetPoliciesGuarded: true,
    originalRoleSchemaRoadAndGallaboxControlsPreserved: true, cronJobsDisabled: [4, 5] };
  const prePhase2Drain = { ...structuredClone(f.proofs.drainAudit), id: 'pre-phase2-drain', sha256: hash('phase2-before'),
    checkedAt: '2026-11-16T03:59:00.000Z', possibleReportingHttpQueue: 0 };
  const phase2 = { version: 1, kind: 'reporting-data-write-fence-phase2', verified: true, sourceProjectRef: phase1.sourceProjectRef,
    executionId: 'actual-phase2-execution', sqlSha256: hash('phase2-sql'), legacyRuntimeSha256: phase1.legacyRuntimeSha256,
    legacyEntrypointsSha256: phase1.legacyEntrypointsSha256, transactionId: '123457', backendPid: 124,
    commitBeforeAt: dataWritesBlockedAt, commitAfterAt: '2026-11-16T04:00:01.000Z', admissionBlockedAt, dataWritesBlockedAt,
    beforeObservationAt: prePhase2Drain.checkedAt, afterObservationAt: '2026-11-16T04:00:02.000Z',
    beforeObservationSha256: prePhase2Drain.sha256, afterObservationSha256: hash('phase2-after'),
    beforeCatalogSha256: phase1.afterCatalogSha256, afterCatalogSha256: driverAuditReportingFunctionCatalogSha256(cap.functions),
    phase1ExecutionId: phase1.executionId, phase1SQLSha256: phase1.sqlSha256, originalInternalDefinitionSha256: internal.definitionSha256,
    originalDefinitionRestored: true, reportingFunctions: 47, revokedMutators: 26,
    applied: true, alreadyClosed: false, reapplied: false, prePhase2Drain };
  const refreshOrigins = () => {
    phase1.afterCatalogSha256 = driverAuditReportingFunctionCatalogSha256(phase1.functions);
    const raw1 = Buffer.from(JSON.stringify(phase1)); phase2.phase1ReceiptSha256 = hash(raw1);
    cap.phase1Receipt = { sha256: hash(raw1), dataBase64: raw1.toString('base64') };
    const raw2 = Buffer.from(JSON.stringify(phase2)); cap.phase2Receipt = { sha256: hash(raw2), dataBase64: raw2.toString('base64') };
    f.fence.phase1ReceiptSha256 = hash(raw1); f.fence.phase2ReceiptSha256 = hash(raw2);
  };
  refreshOrigins();
  return { ...f, phase1, phase2, refreshOrigins };
}

test('native two-phase v2 retains the old admission clock and uses the real full-closure bound for its window', async t => {
  const f = await twoPhaseCapabilityFixture(t), result = await f.verify();
  assert.equal(result.validatedFence.mode, 'reporting-database-capability-v2');
  assert.equal(result.validatedFence.admissionBlockedAt, f.phase1.commitAfterAt);
  assert.equal(result.validatedFence.dataWritesBlockedAt, f.phase2.commitBeforeAt);
  assert.equal(result.validatedFence.commitObservedAt, f.phase2.commitAfterAt);
  assert(Date.parse(f.release.validUntil) - Date.parse(f.fence.admissionBlockedAt) > 30 * 60000);
  assert.deepEqual((await f.verify()).validatedFence, result.validatedFence);
});

test('v2 rejects clock relabeling, replayed closure, mismatched catalogs, missing drain and changed paid evidence', async t => {
  for (const change of [
    f => { f.phase2.reapplied = true; }, f => { f.phase2.alreadyClosed = true; },
    f => { f.phase2.executionId = f.phase1.executionId; }, f => { f.phase2.transactionId = f.phase1.transactionId; },
    f => { f.phase2.commitAfterAt = '2026-11-16T04:01:00.000Z'; },
    f => { f.phase2.beforeObservationAt = f.phase2.commitAfterAt; },
    f => { f.phase2.beforeCatalogSha256 = f.phase2.afterCatalogSha256; },
    f => { f.phase2.originalDefinitionRestored = false; },
    f => { f.phase2.prePhase2Drain.activeProviderWork = 1; },
    f => { f.phase2.prePhase2Drain.uncertainAttempts.afterSha256 = hash('changed-paid-ledger'); },
    f => { f.phase2.prePhase2Drain.checkedAt = '2026-11-16T03:40:59.000Z'; f.phase2.beforeObservationAt = f.phase2.prePhase2Drain.checkedAt; },
    f => { f.phase1.functions[0].apiExecutableRoles = []; },
    f => { f.fence.validUntil = f.release.validUntil = '2026-11-16T04:30:00.001Z'; },
    f => { f.phase2.commitBeforeAt = f.fence.dataWritesBlockedAt = '2026-11-16T03:35:01.000Z'; },
    f => { f.phase1.commitAfterAt = '2026-11-16T03:36:00.000Z'; },
  ]) {
    const f = await twoPhaseCapabilityFixture(t); change(f); f.refreshOrigins();
    await assert.rejects(f.verify(), /phase|capability|closure|drain|catalog|fence|window/i);
  }
});

test('fresh v2 audits cannot renew an expired full-closure clock even when all receipt identities and clocks agree', async t => {
  const f = await twoPhaseCapabilityFixture(t);
  const admission = '2026-11-16T03:00:00.000Z', closure = '2026-11-16T03:35:00.000Z';
  Object.assign(f.phase1, { admissionBlockedAt: admission, commitBeforeAt: '2026-11-16T02:59:59.000Z', commitAfterAt: admission,
    beforeObservationAt: '2026-11-16T02:59:58.000Z', afterObservationAt: '2026-11-16T03:00:02.000Z' });
  Object.assign(f.phase2, { admissionBlockedAt: admission, dataWritesBlockedAt: closure, commitBeforeAt: closure,
    commitAfterAt: '2026-11-16T03:35:01.000Z', beforeObservationAt: '2026-11-16T03:34:00.000Z', afterObservationAt: '2026-11-16T03:35:02.000Z' });
  f.phase2.prePhase2Drain.checkedAt = f.phase2.beforeObservationAt;
  for (const proof of Object.values(f.proofs)) Object.assign(proof, { admissionBlockedAt: admission, dataWritesBlockedAt: closure });
  Object.assign(f.fence, { admissionBlockedAt: admission, dataWritesBlockedAt: closure, initialCursor: '2026-11-16T02:59:00.000Z' });
  f.release.initialCursor = f.proofs.checkpoint.initialCursor = f.fence.initialCursor;
  f.refreshOrigins();
  await assert.rejects(f.verify(), /phase2 full-closure window|fresh validated/i);
});

test('v2 origin bytes are independently pinned and capability mode remains native only', async t => {
  for (const reason of ['missing', 'tampered', 'legacy', 'scope']) {
    const f = await twoPhaseCapabilityFixture(t);
    if (reason === 'missing') delete f.proofs.capabilityAudit.phase1Receipt;
    if (reason === 'tampered') f.proofs.capabilityAudit.phase2Receipt.dataBase64 = Buffer.from('{}').toString('base64');
    if (reason === 'legacy') f.config.dataStore = 'supabase';
    if (reason === 'scope') { f.phase1.originalRoleSchemaRoadAndGallaboxControlsPreserved = false; f.refreshOrigins(); }
    await assert.rejects(f.verify(), /phase|capability|native|embedded|catalog/i);
  }
});

test('database capability mode cannot replace the legacy stopped-process proof', async t => {
  const f = await capabilityFenceFixture(t);
  f.config.dataStore = 'supabase';
  delete f.config.environment.DRIVER_AUDIT_DATA_STORE;
  await assert.rejects(f.verify(), /native|capability/i);
});

test('capability fence refuses incomplete rights, altered scope and undrained provider or owner work', async t => {
  const cases = [
    f => { f.fence.writersStopped = true; },
    f => { f.fence.processesStopped = true; },
    f => { delete f.proofs.drainAudit.id; },
    f => { f.proofs.capabilityAudit.functions.pop(); },
    f => { f.proofs.capabilityAudit.functions[1].identity = f.proofs.capabilityAudit.functions[0].identity; },
    f => { f.proofs.capabilityAudit.functions[0].apiExecutableRoles = ['service_role']; },
    f => { f.proofs.capabilityAudit.functions[0].definitionSha256 = 'f'.repeat(64); },
    f => { f.proofs.capabilityAudit.functions[26].aclSha256 = 'f'.repeat(64); },
    f => { f.proofs.capabilityAudit.functions.find(row => row.identity.startsWith('matter_reporting_hosted.state_cas_internal(')).apiExecutableRoles = ['service_role']; },
    f => { f.proofs.capabilityAudit.functions.find(row => row.identity === 'matter_reporting_hosted.deny_receipt_change()').apiExecutableRoles = ['service_role']; },
    f => { f.proofs.capabilityAudit.functions.find(row => row.identity === 'matter_reporting_hosted.gps_retention_watch()').apiExecutableRoles = ['service_role']; },
    f => { f.proofs.capabilityAudit.functions.find(row => row.identity === 'public.matter_hosted_state_read(text)').apiExecutableRoles = []; },
    f => { f.proofs.capabilityAudit.roadCache.apiWritableRoles = ['service_role']; },
    f => { f.proofs.capabilityAudit.sqlCron[1].active = true; },
    f => { f.proofs.capabilityAudit.unrelatedAfterSha256 = 'f'.repeat(64); },
    f => { f.proofs.capabilityAudit.serviceRoleCannotAssumeOwner = false; },
    f => { f.proofs.drainAudit.activeProviderWork = 1; },
    f => { f.proofs.drainAudit.activeLeases = 1; },
    f => { f.proofs.drainAudit.activeReportingTransactions = 1; },
    f => { f.proofs.drainAudit.privilegedReportingWriters = 1; },
    f => { f.proofs.drainAudit.activeSqlCronRuns = 1; },
    f => { delete f.proofs.drainAudit.admissionGraphSha256; },
    f => { f.proofs.drainAudit.uncertainAttempts.afterCount = 0; },
  ];
  for (const [index, change] of cases.entries()) await t.test(String(index), async t => {
    const f = await capabilityFenceFixture(t); change(f);
    await assert.rejects(f.verify(), /capability|fence|catalog|drain|uncertain/i);
  });
});

test('capability fence requires fresh independent quiet samples and a later matching final checkpoint', async t => {
  const cases = [
    f => { f.proofs.drainAudit.id = f.proofs.capabilityAudit.id; },
    f => { f.proofs.drainAudit.legacyRuntimeSha256 = 'f'.repeat(64); },
    f => { f.proofs.drainAudit.sourceProjectRef = 'another-project'; },
    f => { f.proofs.quietAudit.samples[1].at = '2026-11-16T04:05:29.999Z'; },
    f => { f.proofs.quietAudit.samples[0].at = '2026-11-16T03:59:59.000Z'; },
    f => { f.proofs.quietAudit.samples[1].id = f.proofs.quietAudit.samples[0].id; },
    f => { f.proofs.quietAudit.samples[1].fingerprints.receipts = 'f'.repeat(64); },
    f => { f.proofs.capabilityAudit.capabilitySha256 = 'f'.repeat(64); },
    f => { f.proofs.checkpoint.fingerprints.archive = 'f'.repeat(64); },
    f => { f.proofs.checkpoint.capturedAt = '2026-11-16T04:05:29.000Z'; },
    f => { f.proofs.checkpoint.backupReceiptSha256 = 'f'.repeat(64); },
    f => { f.proofs.checkpoint.initialCursor = '2026-11-16T03:59:00.000Z'; },
    f => { f.proofs.checkpoint.uncertainAttempts.afterSha256 = 'f'.repeat(64); },
    f => { f.fence.checkedAt = '2026-11-16T04:11:00.000Z'; },
    f => { f.fence.validUntil = '2026-11-16T04:24:59.999Z'; },
  ];
  for (const [index, change] of cases.entries()) await t.test(String(index), async t => {
    const f = await capabilityFenceFixture(t); change(f);
    await assert.rejects(f.verify(), /capability|fence|quiet|checkpoint|uncertain/i);
  });
});

test('capability fence independently pins each proof file and both native configuration fields', async t => {
  const f = await capabilityFenceFixture(t);
  await f.verify();
  const file = path.join(f.root, 'release.private.json'), raw = await fs.readFile(file);
  const reference = { path: file, sha256: hash(raw) };
  await fs.appendFile(path.join(f.root, 'drainAudit.private.json'), ' ');
  await assert.rejects(verifyDriverAuditSourceRelease(f.config, reference, new Date(f.release.verifiedAt)), /integrity/i);
  await f.verify();
  delete f.config.environment.DRIVER_AUDIT_DATA_STORE;
  await assert.rejects(f.verify(), /native|capability/i);
});

test('self-consistent attempt claims must match the independently pinned restored backup baseline', async t => {
  const f = await capabilityFenceFixture(t);
  for (const proof of [f.proofs.drainAudit, f.proofs.checkpoint]) {
    proof.uncertainAttempts = { beforeCount: 0, afterCount: 0, beforeSha256: 'f'.repeat(64), afterSha256: 'f'.repeat(64) };
  }
  await assert.rejects(f.verify(), /uncertain|baseline/i);
});

test('native fence requires the restored backup baseline and binds its complete snapshot identity', async t => {
  for (const field of ['count', 'sha256', 'snapshotId', 'sourceSnapshotSha256', 'restoreVerificationSha256']) {
    await t.test('missing ' + field, async t => {
      const f = await capabilityFenceFixture(t);
      delete f.backup.uncertainAttemptsBaseline[field];
      f.release.backup = await f.save('backup', f.backup);
      f.proofs.checkpoint.backupReceiptSha256 = f.release.backup.sha256;
      await assert.rejects(f.verify(), /baseline|checkpoint|uncertain/i);
    });
  }
  for (const field of ['snapshotId', 'sourceSnapshotSha256', 'restoreVerificationSha256']) {
    await t.test('different ' + field, async t => {
      const f = await capabilityFenceFixture(t);
      f.proofs.checkpoint[field] = field === 'snapshotId' ? 'another-snapshot' : 'f'.repeat(64);
      await assert.rejects(f.verify(), /checkpoint|baseline/i);
    });
  }
});

test('native quiet evidence expires against the actual verification time before a still-valid release expires', async t => {
  const f = await capabilityFenceFixture(t);
  f.release.validUntil = f.fence.validUntil = '2026-11-16T04:40:00.000Z';
  // Quiet evidence ended at 04:05:30. The release remains valid until 04:40.
  await assert.rejects(f.verify(new Date('2026-11-16T04:35:30.001Z')), /quiet|fresh/i);
  assert.equal((await f.verify(new Date('2026-11-16T04:35:30.000Z'))).release.verified, true);
  await assert.rejects(f.verify(new Date('2026-11-16T04:39:59.999Z')), /fence|quiet|fresh/i);
  // Restart verification deliberately uses the recorded activation instant.
  assert.equal((await f.verify(new Date(f.release.verifiedAt))).release.verified, true);
});

test('the independently pinned backup baseline identifies the restored snapshot and exact uncertain attempts', async t => {
  const cases = [
    backup => { delete backup.uncertainAttemptsBaseline; },
    backup => { delete backup.uncertainAttemptsBaseline.count; },
    backup => { backup.uncertainAttemptsBaseline.count = -1; },
    backup => { backup.uncertainAttemptsBaseline.sha256 = 'f'.repeat(64); },
    backup => { backup.uncertainAttemptsBaseline.snapshotId = 'another-snapshot'; },
    backup => { backup.uncertainAttemptsBaseline.sourceSnapshotSha256 = 'f'.repeat(64); },
    backup => { delete backup.uncertainAttemptsBaseline.restoreVerificationSha256; },
    backup => { backup.uncertainAttemptsBaseline.restoreVerificationSha256 = 'f'.repeat(64); },
  ];
  for (const [index, change] of cases.entries()) await t.test(String(index), async t => {
    const f = await capabilityFenceFixture(t), backup = JSON.parse(await fs.readFile(path.join(f.root, 'backup.private.json')));
    change(backup);
    f.release.backup = await f.save('backup', backup);
    f.proofs.checkpoint.backupReceiptSha256 = f.release.backup.sha256;
    await assert.rejects(f.verify(), /baseline|checkpoint|uncertain/i);
  });
  const f = await capabilityFenceFixture(t), backup = JSON.parse(await fs.readFile(path.join(f.root, 'backup.private.json')));
  // The restored count is the authority; the validator does not hardcode five.
  backup.uncertainAttemptsBaseline.count = 6;
  backup.uncertainAttemptsBaseline.sha256 = hash('fictional restored six-attempt inventory');
  f.release.backup = await f.save('backup', backup);
  f.proofs.checkpoint.backupReceiptSha256 = f.release.backup.sha256;
  for (const proof of [f.proofs.drainAudit, f.proofs.checkpoint]) proof.uncertainAttempts = {
    beforeCount: 6, afterCount: 6, beforeSha256: backup.uncertainAttemptsBaseline.sha256,
    afterSha256: backup.uncertainAttemptsBaseline.sha256,
  };
  assert.equal((await f.verify()).release.verified, true);
});

test('source config rejects stale OIDC values and requires a bound Gateway key when grading is enabled', async t => {
  const f = await configuredFixture(t);
  async function setEnvironment(value, gatewayCredential = null) {
    const bytes = JSON.stringify(value);
    await fs.writeFile(f.config.environment.path, bytes, { mode: 0o600 });
    f.config.environment.sha256 = hash(bytes);
    f.config.gatewayCredential = gatewayCredential;
    await fs.writeFile(f.configFile, JSON.stringify(f.config), { mode: 0o600 });
  }
  await setEnvironment({ ...f.environment, VERCEL_OIDC_TOKEN: 'expired' });
  await assert.rejects(readDriverAuditSourceConfig(f.configFile), /OIDC/i);
  await setEnvironment({ ...f.environment, MATTER_PHOTO_GRADE_ENABLED: '1' });
  await assert.rejects(readDriverAuditSourceConfig(f.configFile), /Gateway/i);
  await setEnvironment({ ...f.environment, MATTER_PHOTO_GRADE_ENABLED: '1', AI_GATEWAY_API_KEY: 'key-test' }, { environmentKey: 'AI_GATEWAY_API_KEY' });
  assert.equal((await readDriverAuditSourceConfig(f.configFile)).gatewayCredential, 'key-test');
});

test('a source child runs the pinned handler with isolated environment and returns only bounded status', async t => {
  const f = await configuredFixture(t);
  const source = 'export default async function(req,res){if(process.env.UNRELATED_APP_SECRET)throw Error("leaked app secret");if(!process.execArgv.includes("--max-old-space-size=3072"))throw Error("missing heap cap");res.writeHead(200);res.end(JSON.stringify({status:"disabled",private:"do not return"}));}';
  await fs.writeFile(path.join(f.runtimeRoot, f.entrypoint.module), source, { mode: 0o600 });
  f.manifest.files[0] = { path: f.entrypoint.module, bytes: Buffer.byteLength(source), sha256: hash(source) };
  f.config.manifestSha256 = await f.saveManifest();
  await fs.writeFile(f.configFile, JSON.stringify(f.config), { mode: 0o600 });
  const config = await readDriverAuditSourceConfig(f.configFile);
  const old = process.env.UNRELATED_APP_SECRET;
  process.env.UNRELATED_APP_SECRET = 'private';
  try {
    assert.deepEqual(await runDriverAuditSourceChild(config, f.entrypoint), { httpStatus: 200, status: 'disabled' });
  } finally {
    if (old === undefined) delete process.env.UNRELATED_APP_SECRET;
    else process.env.UNRELATED_APP_SECRET = old;
  }
});

test('a hanging source child is killed after its scheduled execution bound', async t => {
  const f = await configuredFixture(t);
  const source = 'export default async function(){await new Promise(()=>setInterval(()=>{},100));}';
  await fs.writeFile(path.join(f.runtimeRoot, f.entrypoint.module), source, { mode: 0o600 });
  f.manifest.files[0] = { path: f.entrypoint.module, bytes: Buffer.byteLength(source), sha256: hash(source) };
  f.config.manifestSha256 = await f.saveManifest();
  await fs.writeFile(f.configFile, JSON.stringify(f.config), { mode: 0o600 });
  const config = await readDriverAuditSourceConfig(f.configFile);
  await assert.rejects(runDriverAuditSourceChild(config, { ...f.entrypoint, maxDurationSeconds: 1 }), /time|execution/i);
});

test('a source child waits behind a heavy builder without spending its execution timeout', async t => {
  const f = await configuredFixture(t);
  const config = await readDriverAuditSourceConfig(f.configFile);
  const { withDriverAuditHeavyWork } = await import('./driverAuditHeavyWork.js');
  const root = path.join(f.root, '../../driver-audit-heavy-work');
  let finish;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const builder = withDriverAuditHeavyWork({ root, owner: 'sync' }, async () => {
    started(); await new Promise(resolve => { finish = resolve; });
  });
  await ready;
  let admitted = false;
  const child = runDriverAuditSourceChild(config, { ...f.entrypoint, maxDurationSeconds: 1 }, {
    onAdmission: async () => { admitted = true; },
  });
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(admitted, false);
  finish();
  await builder;
  assert.equal((await child).status, 'disabled');
  assert.equal(admitted, true);
});

test('stopping a source child waiting for heavy admission retains the builder lock', async t => {
  const f = await configuredFixture(t);
  const config = await readDriverAuditSourceConfig(f.configFile);
  const { withDriverAuditHeavyWork } = await import('./driverAuditHeavyWork.js');
  const root = path.join(f.root, '../../driver-audit-heavy-work');
  let finish;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const builder = withDriverAuditHeavyWork({ root, owner: 'sync' }, async () => {
    started(); await new Promise(resolve => { finish = resolve; });
  });
  await ready;
  const cancellation = new AbortController();
  const child = runDriverAuditSourceChild(config, f.entrypoint, { signal: cancellation.signal });
  cancellation.abort();
  await assert.rejects(child, { code: 'AUDIT_ADMISSION_CANCELLED' });
  finish();
  await builder;
});

test('a source child declares readiness before accepting its invocation', async t => {
  const f = await configuredFixture(t);
  const config = await readDriverAuditSourceConfig(f.configFile);
  const script = fileURLToPath(new URL('../scripts/driverAuditSource.js', import.meta.url));
  const child = fork(script, ['--config', f.configFile, '--child'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => child.kill('SIGKILL'));
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('source child did not become ready')), 1000);
    child.once('message', value => { clearTimeout(timer); resolve(value); });
  });
  assert.deepEqual(ready, { version: 1, ready: true });
  child.send({ version: 1, configSha256: config.configSha256, id: f.entrypoint.id, probe: true });
  const result = await new Promise(resolve => child.once('message', resolve));
  assert.equal(result.result.status, 'checked');
});

test('the SQLite source lock rejects a live duplicate and recovers process-death receipts', async t => {
  const f = await fixture(t);
  const { acquireWorkerLock } = await import('../vendor/driver-audits/integration/hosted/worker-lock.mjs');
  const lockFile = path.join(f.root, 'source-worker.lock');
  const lock = await acquireWorkerLock(lockFile);
  await assert.rejects(acquireWorkerLock(lockFile), /already active/i);
  await lock.release();
  const module = fileURLToPath(new URL('../vendor/driver-audits/integration/hosted/worker-lock.mjs', import.meta.url));
  const childFile = path.join(f.root, 'lock-child.mjs');
  await fs.writeFile(childFile, `import {acquireWorkerLock} from ${JSON.stringify(module)};await acquireWorkerLock(process.argv[2]);process.send('locked');setInterval(()=>{},1000);`);
  const child = fork(childFile, [lockFile], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
  child.kill('SIGKILL');
  await new Promise(resolve => child.once('exit', resolve));
  const recovered = await acquireWorkerLock(lockFile);
  assert.equal(recovered.recovered, true);
  await recovered.release();
});

test('the supervised script publishes job failure state, drains and resumes its saved minute', async t => {
  const f = await configuredFixture(t);
  const source = 'import fs from "node:fs/promises";export default async function(req,res){await fs.appendFile(new URL("../../runs.private.log",import.meta.url),Math.floor(Date.now()/60000)+"\\n");res.writeHead(200);res.end(JSON.stringify({status:"needs-inspection",failed:2}));}';
  f.entrypoint.schedule = '* * * * *';
  f.manifest.files[0] = { path: f.entrypoint.module, bytes: Buffer.byteLength(source), sha256: hash(source) };
  await fs.writeFile(path.join(f.runtimeRoot, f.entrypoint.module), source, { mode: 0o600 });
  f.config.manifestSha256 = await f.saveManifest();
  await fs.writeFile(f.configFile, JSON.stringify(f.config), { mode: 0o600 });
  const config = await readDriverAuditSourceConfig(f.configFile);
  const now = Date.now();
  const cursor = new Date(Math.floor(now / 60000) * 60000 - 60000).toISOString();
  const expires = new Date(now + 10 * 60000).toISOString();
  const release = { version: 1, verified: true, configSha256: config.configSha256,
    runtimeManifestSha256: config.manifestSha256, environmentSha256: config.environmentReference.sha256,
    nodeVersion: process.version, initialCursor: cursor, verifiedAt: new Date(now - 1000).toISOString(), validUntil: expires };
  for (const kind of ['backup', 'parity', 'credentials', 'sourceFence']) {
    const proof = { version: 1, verified: true, ...(kind === 'sourceFence'
      ? { writersStopped: true, leasesDrained: true, initialCursor: cursor, validUntil: expires } : {}) };
    const bytes = JSON.stringify(proof);
    const file = path.join(f.root, kind + '.private.json');
    await fs.writeFile(file, bytes, { mode: 0o600 });
    release[kind] = { path: file, sha256: hash(bytes) };
  }
  const releaseBytes = JSON.stringify(release);
  const releaseFile = path.join(f.root, 'release.private.json');
  await fs.writeFile(releaseFile, releaseBytes, { mode: 0o600 });
  await writeDriverAuditSourceState(path.join(f.root, 'deployment-source.private.json'), {
    version: 1, verified: true, status: 'active', configSha256: config.configSha256, manifestSha256: config.manifestSha256,
    verifiedAt: new Date(now).toISOString(), release: { path: releaseFile, sha256: hash(releaseBytes) },
  });
  const script = fileURLToPath(new URL('../scripts/driverAuditSource.js', import.meta.url));
  const children = [];
  t.after(() => children.forEach(child => child.kill('SIGKILL')));
  const start = () => {
    const child = fork(script, ['--config', f.configFile], { env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    children.push(child);
    return child;
  };
  const waitStatus = async match => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = await fs.readFile(path.join(f.root, 'source-status.private.json'), 'utf8').then(JSON.parse).catch(() => null);
      if (status && match(status)) return status;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail('source process did not publish expected status');
  };
  const child = start();
  const first = await waitStatus(status => status.pid === child.pid && status.jobs?.delivery?.status === 'needs-inspection');
  assert.equal(first.jobs.delivery.failed, 2);
  child.kill('SIGTERM');
  assert.equal(await new Promise(resolve => child.once('exit', resolve)), 0);
  await waitStatus(status => status.status === 'stopped');
  const restarted = start();
  await waitStatus(status => status.pid === restarted.pid && status.status === 'ready');
  restarted.kill('SIGTERM');
  assert.equal(await new Promise(resolve => restarted.once('exit', resolve)), 0);
  const minutes = (await fs.readFile(path.join(f.runtimeRoot, 'runs.private.log'), 'utf8')).trim().split('\n');
  assert.equal(new Set(minutes).size, minutes.length);
});
