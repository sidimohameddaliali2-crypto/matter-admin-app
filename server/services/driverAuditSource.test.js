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
  runDriverAuditSourceChild,
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

test('overlapping schedules preserve independent tasks and skip a busy route without a concurrent duplicate', async t => {
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
  assert.equal(calls.includes('gps'), true);
  finish();
  await scheduler.drain();
  const state = JSON.parse(await fs.readFile(path.join(f.root, 'state.private.json')));
  assert.equal(state.jobs['same-route'].status, 'busy');
  assert.equal(state.jobs.delivery.status, 'complete');
  assert.equal(state.jobs.delivery.scheduledAt, minute);
  assert.equal(state.jobs.delivery.lastSkippedAt, '2026-11-16T04:02:00.000Z');
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
  const source = 'export default async function(req,res){if(process.env.UNRELATED_APP_SECRET)throw Error("leaked app secret");res.writeHead(200);res.end(JSON.stringify({status:"disabled",private:"do not return"}));}';
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
