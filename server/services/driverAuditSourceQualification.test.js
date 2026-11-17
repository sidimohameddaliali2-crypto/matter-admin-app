import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as qualification from '../scripts/driverAuditSourceQualify.js';
import { withDriverAuditHeavyWork } from './driverAuditHeavyWork.js';
import {
  runDriverAuditQualificationChild,
  stageDriverAuditQualification,
  verifyDriverAuditSourceHostQualification,
} from '../scripts/driverAuditSourceQualify.js';

const hash = value => createHash('sha256').update(value).digest('hex');

async function heldQualificationFixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'audit-held-qualification-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const server = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
  const root = path.join(base, 'driver-audit-source', 'a'.repeat(64));
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const syncRoot = path.join(server, '.private/driver-audits', 'b'.repeat(64));
  const api = { name: 'matter-delivery-api', pid: process.pid, pm2_env: { status: 'online' } };
  const source = { name: 'matter-driver-audit-source', pid: 0, pm2_env: { status: 'stopped' } };
  const sync = { name: 'matter-driver-audit-sync', pid: 0, pm2_env: { status: 'stopped',
    pm_cwd: server, pm_exec_path: path.join(server, 'scripts/driverAuditSync.js'), args: ['--config', path.join(syncRoot, 'sync.json')] } };
  const events = [], heavyRoot = path.join(base, 'driver-audit-heavy-work');
  const config = { root, get runtime() { throw Error('Fixture stops before external replay'); } };
  const supervisor = async () => { events.push('observe:' + sync.pm2_env.status); return structuredClone([api, source, sync]); };
  const options = { config, commit: 'a'.repeat(40), fixtureSha256: 'c'.repeat(64), supervisor };
  const owned = async () => assert.equal(await fs.readFile(path.join(heavyRoot, 'work.lock'), 'utf8'), String(process.pid));
  const expectedReplayFailure = /Exact Linux host qualification|Fixture stops before external replay/;
  return { root, heavyRoot, source, sync, events, options, owned, expectedReplayFailure };
}

test('shared held sync lifecycle runs a callback without exposing the private qualification token', async t => {
  assert.equal(typeof qualification.withDriverAuditHeldQualificationSync, 'function');
  const f = await heldQualificationFixture(t); let stopped = 0;
  const result = await qualification.withDriverAuditHeldQualificationSync({ ...f.options,
    async startSync() { await f.owned(); f.sync.pid = process.pid; f.sync.pm2_env.status = 'online'; },
    async stopSync() { await f.owned(); stopped++; f.sync.pid = 0; f.sync.pm2_env.status = 'stopped'; },
  }, async function () {
    assert.equal(arguments.length, 0); await f.owned(); assert.equal(f.sync.pm2_env.status, 'online');
    return { existingOnlineVerifierCompleted: true };
  });
  assert.deepEqual(result, { existingOnlineVerifierCompleted: true }); assert.equal(stopped, 1);
  assert.equal(f.events.at(-1), 'observe:stopped');
  await assert.rejects(fs.readFile(path.join(f.heavyRoot, 'work.lock')), { code: 'ENOENT' });
});

test('cancellation during successful pause cleanup rejects after stopped observation and lease release', async t => {
  const f = await heldQualificationFixture(t), controller = new AbortController();
  await assert.rejects(qualification.withDriverAuditHeldQualificationSync({ ...f.options, signal: controller.signal,
    async startSync() { await f.owned(); f.sync.pid = process.pid; f.sync.pm2_env.status = 'online'; },
    async stopSync() {
      await f.owned(); f.sync.pid = 0; f.sync.pm2_env.status = 'stopped';
      controller.abort(Object.assign(Error('cancelled during durable cleanup'), { code: 'interrupted' }));
    },
  }, async () => ({ verified: true })), { code: 'interrupted' });
  assert.equal(f.events.at(-1), 'observe:stopped');
  await assert.rejects(fs.readFile(path.join(f.heavyRoot, 'work.lock')), { code: 'ENOENT' });
});

test('held qualification owns real admission before sync starts and stops it before queued writers can advance', async t => {
  assert.equal(typeof qualification.qualifyDriverAuditSourceWhileHeld, 'function');
  const f = await heldQualificationFixture(t), controls = [], waiting = [], work = [], advances = [];
  const run = qualification.qualifyDriverAuditSourceWhileHeld({ ...f.options,
    async startSync() {
      await f.owned(); f.events.push('start');
      f.sync.pid = process.pid; f.sync.pm2_env.status = 'online';
      for (const owner of ['sync', 'source']) {
        const controller = new AbortController(); controls.push(controller);
        let queued; waiting.push(new Promise(resolve => { queued = resolve; }));
        work.push(withDriverAuditHeavyWork({ root: f.heavyRoot, owner, pollMs: 5, signal: controller.signal,
          onWaiting: () => queued() }, async () => { advances.push(owner); }));
      }
      await Promise.all(waiting);
      assert.deepEqual(advances, []);
    },
    async stopSync() {
      await f.owned(); f.events.push('stop'); assert.deepEqual(advances, []);
      for (const controller of controls) controller.abort();
      await Promise.all(work.map(item => assert.rejects(item, { code: 'AUDIT_ADMISSION_CANCELLED' })));
      f.sync.pid = 0; f.sync.pm2_env.status = 'stopped';
    } });
  await assert.rejects(run, f.expectedReplayFailure);
  assert.equal(f.source.pm2_env.status, 'stopped'); assert.equal(f.sync.pm2_env.status, 'stopped');
  assert.deepEqual(advances, []); assert.equal(f.events[0], 'observe:stopped');
  assert.ok(f.events.indexOf('start') < f.events.indexOf('stop'));
  assert.equal(f.events.at(-1), 'observe:stopped');
  await assert.rejects(fs.readFile(path.join(f.heavyRoot, 'work.lock')), { code: 'ENOENT' });
  assert.equal(await withDriverAuditHeavyWork({ root: f.heavyRoot, owner: 'sync', pollMs: 5 }, async () => 'released'), 'released');
});

test('a partially failed sync start is stopped inside the held lease', async t => {
  assert.equal(typeof qualification.qualifyDriverAuditSourceWhileHeld, 'function');
  const f = await heldQualificationFixture(t); let stopped = 0;
  await assert.rejects(qualification.qualifyDriverAuditSourceWhileHeld({ ...f.options,
    async startSync() { await f.owned(); f.sync.pid = process.pid; f.sync.pm2_env.status = 'online'; throw Error('start interrupted'); },
    async stopSync() { await f.owned(); stopped++; f.sync.pid = 0; f.sync.pm2_env.status = 'stopped'; },
  }), /start interrupted/);
  assert.equal(stopped, 1); assert.equal(f.events.at(-1), 'observe:stopped');
  await assert.rejects(fs.readFile(path.join(f.heavyRoot, 'work.lock')), { code: 'ENOENT' });
});

test('cancellation during sync start stops the real lifecycle before releasing admission', async t => {
  const f = await heldQualificationFixture(t), controller = new AbortController(); let stopped = 0;
  await assert.rejects(qualification.qualifyDriverAuditSourceWhileHeld({ ...f.options, signal: controller.signal,
    async startSync() {
      await f.owned(); f.sync.pid = process.pid; f.sync.pm2_env.status = 'online';
      controller.abort(Object.assign(Error('qualification cancelled during startup'), { code: 'interrupted' }));
    },
    async stopSync() { await f.owned(); stopped++; f.sync.pid = 0; f.sync.pm2_env.status = 'stopped'; },
  }), { code: 'interrupted' });
  assert.equal(stopped, 1); assert.equal(f.events.at(-1), 'observe:stopped');
  await assert.rejects(fs.readFile(path.join(f.heavyRoot, 'work.lock')), { code: 'ENOENT' });
});

test('real repeated process interrupts cannot release held admission before sync stops', async t => {
  const f = await heldQualificationFixture(t);
  const moduleFile = fileURLToPath(new URL('../scripts/driverAuditSourceQualify.js', import.meta.url));
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import {qualifyDriverAuditSourceWhileHeld} from ${JSON.stringify(moduleFile)};
    const sync=${JSON.stringify(f.sync)}, source=${JSON.stringify(f.source)};
    const api={name:'matter-delivery-api',pid:process.pid,pm2_env:{status:'online'}};
    const marker=()=>{}; process.on('SIGHUP',marker);
    const before=Object.fromEntries(['SIGTERM','SIGINT','SIGHUP'].map(name=>[name,process.listenerCount(name)]));
    const owned=async()=>assert.equal(await fs.readFile(${JSON.stringify(path.join(f.heavyRoot, 'work.lock'))},'utf8'),String(process.pid));
    let stops=0;
    await assert.rejects(qualifyDriverAuditSourceWhileHeld({
      config:{root:${JSON.stringify(f.root)}},commit:'a'.repeat(40),fixtureSha256:'c'.repeat(64),
      supervisor:async()=>structuredClone([api,source,sync]),
      async startSync(){
        await owned(); sync.pid=process.pid; sync.pm2_env.status='online';
        process.kill(process.pid,'SIGTERM'); await new Promise(resolve=>setTimeout(resolve,20));
      },
      async stopSync(){
        await owned();
        if(++stops===1){
          for(const name of ['SIGTERM','SIGTERM','SIGINT','SIGHUP'])process.kill(process.pid,name);
          await new Promise(resolve=>setTimeout(resolve,20));
          throw Error('temporary pause failure');
        }
        sync.pid=0; sync.pm2_env.status='stopped';
      }
    }),{code:'interrupted'});
    assert.equal(stops,2);
    await assert.rejects(fs.readFile(${JSON.stringify(path.join(f.heavyRoot, 'work.lock'))}),{code:'ENOENT'});
    for(const name of ['SIGTERM','SIGINT','SIGHUP'])assert.equal(process.listenerCount(name),before[name]);
    process.off('SIGHUP',marker);
    console.log('held-interrupt-cleanup-verified');
  `;
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script],
    { timeout: 10000, maxBuffer: 1024 * 1024, env });
  assert.match(stdout, /held-interrupt-cleanup-verified/);
});

test('a pause failure retains real admission until the actual worker is observed stopped', async t => {
  assert.equal(typeof qualification.qualifyDriverAuditSourceWhileHeld, 'function');
  const f = await heldQualificationFixture(t); let stops = 0;
  await assert.rejects(qualification.qualifyDriverAuditSourceWhileHeld({ ...f.options,
    async startSync() { await f.owned(); f.sync.pid = process.pid; f.sync.pm2_env.status = 'online'; },
    async stopSync() {
      await f.owned();
      if (++stops === 1) throw Error('transient supervisor pause failure');
      f.sync.pid = 0; f.sync.pm2_env.status = 'stopped';
    },
  }), f.expectedReplayFailure);
  assert.equal(stops, 2); assert.equal(f.events.at(-1), 'observe:stopped');
  await assert.rejects(fs.readFile(path.join(f.heavyRoot, 'work.lock')), { code: 'ENOENT' });
});

test('a stopped worker with failed durable pause completion retains admission until callback succeeds', async t => {
  const f = await heldQualificationFixture(t); let stops = 0;
  await assert.rejects(qualification.qualifyDriverAuditSourceWhileHeld({ ...f.options,
    async startSync() { await f.owned(); f.sync.pid = process.pid; f.sync.pm2_env.status = 'online'; },
    async stopSync() {
      await f.owned(); f.sync.pid = 0; f.sync.pm2_env.status = 'stopped';
      if (++stops === 1) throw Error('durable process save failed after pause');
    },
  }), f.expectedReplayFailure);
  assert.equal(stops, 2); assert.equal(f.events.at(-1), 'observe:stopped');
  await assert.rejects(fs.readFile(path.join(f.heavyRoot, 'work.lock')), { code: 'ENOENT' });
});

test('held qualification refuses an already-running source or sync before invoking lifecycle callbacks', async t => {
  assert.equal(typeof qualification.qualifyDriverAuditSourceWhileHeld, 'function');
  for (const name of ['source', 'sync']) {
    const f = await heldQualificationFixture(t); f[name].pm2_env.status = 'online'; f[name].pid = process.pid;
    await assert.rejects(qualification.qualifyDriverAuditSourceWhileHeld({ ...f.options,
      startSync: async () => assert.fail('must preserve the existing worker'),
      stopSync: async () => assert.fail('must preserve the existing worker'),
    }), /Stop the source worker|stopped.*sync|sync.*stopped/i);
  }
});

test('ordinary qualification rejects fabricated or serialized held-lease tokens', async () => {
  for (const heldQualificationLease of [{}, { root: '/private/driver-audit-heavy-work' }, true, 'owned', JSON.parse('{"active":true}')]) {
    await assert.rejects(qualification.qualifyDriverAuditSource({ config: { root: '/private/driver-audit-source/example' },
      heldQualificationLease, fixtureSha256: 'c'.repeat(64), supervisor: async () => assert.fail('forged lease reached workers') }), /owned.*lease|lease.*owned/i);
  }
});

test('qualification stages only the verified saved input and declared archive bytes', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'audit-qualification-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = Buffer.from(JSON.stringify({ rows: [] }));
  const object = Buffer.from('verifiable saved archive object');
  const key = hash(object) + '.gz';
  const runtimeManifestSha256 = '1'.repeat(64);
  const expected = { reportHash: '2'.repeat(64), generation: '3'.repeat(64), retainedSignature: '4'.repeat(64),
    records: 1, history: 1, acceptedGrades: 1, writeKeys: [key], sourceRows: 1 };
  const fixture = { version: 1, runtimeManifestSha256, savedState: { sha256: hash(state), dataBase64: state.toString('base64') },
    objects: [{ key, bytes: object.length }], expected };
  const calls = [];
  const compressed = gzipSync(JSON.stringify(fixture));
  const fixtureSha256 = hash(compressed);
  const archive = { async readObject(request, { maxBytes }) {
    calls.push({ request, maxBytes });
    return [request === key ? object : compressed];
  } };
  const staged = await stageDriverAuditQualification({ root, fixtureSha256, runtimeManifestSha256, archive });
  assert.deepEqual(calls.map(call => call.request), [fixtureSha256 + '.gz', key]);
  assert.deepEqual(await fs.readFile(staged.stateFile), state);
  assert.deepEqual(await fs.readFile(path.join(staged.objectsRoot, key)), object);
  assert.equal((await fs.stat(staged.stateFile)).mode & 0o777, 0o600);
  assert.deepEqual(staged.expected, expected);
});

test('qualification rejects undeclared files, invalid object names and excess storage before downloading them', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'audit-qualification-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = Buffer.from('{"rows":[]}');
  const config = { version: 1, runtimeManifestSha256: '1'.repeat(64), savedState: { sha256: hash(state), dataBase64: state.toString('base64') },
    expected: { reportHash: '2'.repeat(64), generation: '3'.repeat(64), retainedSignature: '4'.repeat(64),
      records: 1, history: 1, acceptedGrades: 1, writeKeys: ['5'.repeat(64) + '.gz'], sourceRows: 1 } };
  for (const objects of [[{ key: '../escape.gz', bytes: 10 }],
    Array.from({ length: 15 }, (_, index) => ({ key: index.toString(16).padStart(64, '0') + '.gz', bytes: 8 * 1024 * 1024 }))]) {
    const compressed = gzipSync(JSON.stringify({ ...config, objects }));
    const fixtureSha256 = hash(compressed);
    const archive = { async readObject(key) {
      assert.equal(key, fixtureSha256 + '.gz');
      return [compressed];
    } };
    await assert.rejects(stageDriverAuditQualification({ root, fixtureSha256, runtimeManifestSha256: config.runtimeManifestSha256, archive }),
      /archive inventory|archive size/i);
    assert.deepEqual(await fs.readdir(root), []);
  }
});

test('start accepts only a complete exact Linux host qualification receipt', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'audit-host-receipt-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const digest = value => value.repeat(64);
  const fixtureSha256 = digest('1');
  const config = { root, configSha256: digest('2'), manifestSha256: digest('3'),
    environmentReference: { sha256: digest('4') }, nodeExecutable: '/private/node22', nodeVersion: 'v22.23.4' };
  const commit = 'a'.repeat(40);
  const builder = { builderSha256: digest('5'), rendererBuild: { sha256: digest('6') }, journals: { sha256: digest('7') } };
  const nodeExecutable = '/private/builder22';
  const nodeVersion = 'v22.23.4';
  const nodeArgs = ['--max-old-space-size=3072'];
  const file = path.join(root, 'qualification-' + fixtureSha256 + '.private.json');
  const verify = reference => verifyDriverAuditSourceHostQualification({ config, commit, reference, builder, nodeExecutable, nodeVersion, nodeArgs });
  await assert.rejects(verify(null), /qualification reference/i);
  const source = { status: 'verified', platform: 'linux', nodeVersion: config.nodeVersion, networkAttempts: 0 };
  const measurement = { samples: 5, peakApiRssBytes: 1, peakSyncRssBytes: 2, minimumAvailableBytes: 900 * 1024 * 1024 };
  const complete = { version: 1, status: 'verified', verified: true, checkedAt: new Date().toISOString(),
    fixtureSha256, commit, configSha256: config.configSha256, manifestSha256: config.manifestSha256,
    environmentSha256: config.environmentReference.sha256, nodeExecutable: config.nodeExecutable, nodeVersion: config.nodeVersion,
    source: { ...source, failureRetry: true }, sourceAfterBuilder: source,
    builder: { ...source, builderSha256: builder.builderSha256, rendererSha256: builder.rendererBuild.sha256,
      journalsSha256: builder.journals.sha256, nodeExecutable, nodeVersion, nodeArgs },
    measurements: Object.fromEntries(['source', 'builder', 'source-after-builder'].map(phase => [phase, measurement])) };
  const save = async receipt => {
    const bytes = JSON.stringify(receipt);
    await fs.writeFile(file, bytes, { mode: 0o600 });
    return { fixtureSha256, receiptSha256: hash(bytes) };
  };
  for (const changes of [{ status: 'partial', verified: false }, { sourceAfterBuilder: null }, { commit: 'b'.repeat(40) },
    { environmentSha256: digest('8') }, { nodeVersion: 'v24.21.0' },
    { builder: { ...complete.builder, builderSha256: digest('8') } }]) {
    await assert.rejects(verify(await save({ ...complete, ...changes })), /incomplete|changed/i);
  }
  const reference = await save(complete);
  assert.deepEqual(await verify(reference), complete);
  await assert.rejects(verify({ ...reference, receiptSha256: digest('0') }), /integrity/i);
  const nativeConfig = { ...config, environment: { DRIVER_AUDIT_DATA_STORE: 'mongo' } };
  const verifyNative = reference => verifyDriverAuditSourceHostQualification({ config: nativeConfig, commit, reference,
    builder, nodeExecutable, nodeVersion, nodeArgs });
  await assert.rejects(verifyNative(reference), /incomplete|changed/i);
  const native = { ...complete,
    builder: { ...complete.builder, nativeManagedArchiveCache: true },
    source: { ...complete.source, executionAdmission: 'fixed-host-v1', executionLedgersPreserved: true, nativeManagedArchiveCache: true },
    sourceAfterBuilder: { ...complete.sourceAfterBuilder, executionAdmission: 'fixed-host-v1', executionLedgersPreserved: true,
      nativeManagedArchiveCache: true } };
  assert.deepEqual(await verifyNative(await save(native)), native);
  const verifyProgress = reference => verifyDriverAuditSourceHostQualification({
    config: { ...nativeConfig, runtime: { files: [{ path: 'source/integration/cloud/native-poll-progress.mjs' }] } },
    commit, reference, builder, nodeExecutable, nodeVersion, nodeArgs });
  await assert.rejects(verifyProgress(await save(native)), /polling progress/i);
  const progress = { ...native,
    source: { ...native.source, nativeNoChangeDuplicateFree: true, outputObjects: 0, failureKind: 'progress' },
    sourceAfterBuilder: { ...native.sourceAfterBuilder, nativeNoChangeDuplicateFree: true, outputObjects: 0, failureKind: null } };
  assert.deepEqual(await verifyProgress(await save(progress)), progress);
  for (const changes of [{ nativeNoChangeDuplicateFree: false }, { outputObjects: 1 }, { failureKind: 'publication' }]) {
    await assert.rejects(verifyProgress(await save({ ...progress, source: { ...progress.source, ...changes } })), /polling progress/i);
  }
  await save(complete);

  const cacheRoot = path.join(root, 'archive-cache');
  const verifySharedCache = (reference, cacheDirectory = cacheRoot) => verifyDriverAuditSourceHostQualification({
    config: { ...config, archiveCacheDirectory: cacheDirectory }, commit, reference,
    builder: { ...builder, cacheRoot }, nodeExecutable, nodeVersion, nodeArgs,
  });
  await assert.rejects(verifySharedCache(reference), /archive cache/i);
  const shared = { ...complete, sourceArchiveCacheDirectory: cacheRoot,
    source: { ...complete.source, archiveReads: { requests: 50, bytes: 147_000_000 } },
    sourceAfterBuilder: { ...complete.sourceAfterBuilder, archiveReads: { requests: 3, bytes: 230_000 } } };
  const sharedReference = await save(shared);
  assert.deepEqual(await verifySharedCache(sharedReference), shared);
  await assert.rejects(verifySharedCache(sharedReference, path.join(root, 'other-cache')), /archive cache/i);
  await assert.rejects(verifySharedCache(await save({ ...shared, sourceAfterBuilder: {
    ...shared.sourceAfterBuilder, archiveReads: { requests: 50, bytes: 147_000_000 },
  } })), /archive cache/i);
  const nativeShared = { ...native, sourceArchiveCacheDirectory: cacheRoot,
    source: { ...native.source, nativeArchiveCacheEnabled: true, archiveReads: { requests: 50, bytes: 147_000_000 } },
    sourceAfterBuilder: { ...native.sourceAfterBuilder, nativeArchiveCacheEnabled: true, archiveReads: { requests: 3, bytes: 230_000 } },
    builder: { ...native.builder, nativeArchiveCacheEnabled: true } };
  const verifyNativeShared = reference => verifyDriverAuditSourceHostQualification({
    config: { ...nativeConfig, archiveCacheDirectory: cacheRoot }, commit, reference,
    builder: { ...builder, cacheRoot }, nodeExecutable, nodeVersion, nodeArgs,
  });
  assert.deepEqual(await verifyNativeShared(await save(nativeShared)), nativeShared);
  await assert.rejects(verifyNativeShared(await save({ ...nativeShared,
    builder: { ...nativeShared.builder, nativeArchiveCacheEnabled: false } })), /archive cache/i);
  await assert.rejects(verifyNativeShared(await save({ ...nativeShared,
    source: { ...nativeShared.source, nativeArchiveCacheEnabled: false } })), /archive cache/i);
  await assert.rejects(verifyNativeShared(await save({ ...nativeShared,
    builder: { ...nativeShared.builder, nativeManagedArchiveCache: false } })), /incomplete|changed/i);
});

async function replayFixture(t, { network = false, nativeReplay = false, nativePollProgress = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'audit-child-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const work = path.join(root, 'work');
  const outside = path.join(root, 'protected.private.json');
  await fs.writeFile(outside, '{}', { mode: 0o600 });
  const objectsRoot = path.join(work, 'objects');
  const runtimeRoot = path.join(work, 'runtime');
  const app = path.join(runtimeRoot, 'source');
  await fs.mkdir(objectsRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(app, 'integration/cloud'), { recursive: true, mode: 0o700 });
  const capture = Buffer.from('{"snapshot":{"rows":[{}]}}');
  const key = hash(capture) + '.gz';
  await fs.writeFile(path.join(objectsRoot, key), capture, { mode: 0o600 });
  const head = { source: { day: '2026-11-15', observedAt: '2026-11-15T17:55:33Z' }, reportHash: 'a'.repeat(64), manifest: { sha256: 'b'.repeat(64) } };
  const stateFile = path.join(work, 'state.json');
  const state = Object.entries({
    'collector-state': { head, lastCapture: { runId: 'stream-123' } },
    'capture:stream-123': { runId: 'stream-123', ref: { key } },
    'worker-budget': {},
  }).map(([key, body]) => ({ key, revision: 1, body: JSON.stringify(body) }));
  await fs.writeFile(stateFile, JSON.stringify({ rows: state }));
  const rows = [{ key: 'record', assessmentHash: 'assessment', photo: { grade: 1 }, findings: [], delivery: {} }];
  const expected = { reportHash: head.reportHash, generation: head.manifest.sha256, retainedSignature: hash(JSON.stringify(rows)),
    sourceRows: 1, records: 1, history: 1, acceptedGrades: 1, writeKeys: [] };
  await fs.writeFile(path.join(app, 'integration/cloud/repository.mjs'), 'export const createCloudRepository = () => ({});');
  await fs.writeFile(path.join(app, 'integration/cloud/publication.mjs'), 'export const createCloudPublication = () => ({loadCurrent:()=>(' +
    JSON.stringify({ head, historyCount: 1, app: { queries: { reporting_validated_deliveries: { rows } } } }) + ')});');
  await fs.writeFile(path.join(app, 'collector.mjs'), [
    'import assert from "node:assert/strict";',
    'import fs from "node:fs/promises";',
    'import {createHash,randomUUID} from "node:crypto";',
    'let called = false;',
    'export default async function (request, response) {',
    '  assert.equal(process.env.QUALIFICATION_PROTECTED_VALUE, undefined);',
    nativeReplay ? [
      '  assert.equal(process.env.DRIVER_AUDIT_DATA_STORE, "mongo");',
      '  assert.equal(process.env.MONGODB_URI, undefined);',
      '  const backend = globalThis[Symbol.for("matter.driver-audit.native-backend")];',
      '  assert.equal(backend.kind, "mongo");',
      '  assert.equal(backend.archive.managedReadCache, true);',
      '  const archived = Buffer.concat(await backend.archive.readObject(' + JSON.stringify(key) + '));',
      '  assert.equal(archived.toString(), ' + JSON.stringify(capture.toString()) + ');',
      '  const before = await backend.rpc("matter_hosted_state_read", {p_key:"worker-budget"});',
      '  assert.equal(before.body_text, "{}");',
      '  const budget = backend.createExecutionBudget();',
      '  const reservation = await budget.reserve();',
      '  assert.equal(reservation.allowed, true);',
      '  assert.equal((await budget.settle(reservation, {elapsedMs:0})).chargedMicros, 0);',
      '  assert.deepEqual(await backend.rpc("matter_hosted_state_read", {p_key:"worker-budget"}), before);',
    ].join('\n') : '  assert.equal(process.env.DRIVER_AUDIT_DATA_STORE, undefined);',
    '  await assert.rejects(fs.readFile(' + JSON.stringify(outside) + '), { code:"ERR_ACCESS_DENIED" });',
    network ? '  try { await fetch("https://source.invalid/"); } catch {}' : '',
    nativePollProgress ? [
      '  if(!called){',
      '    const backend=globalThis[Symbol.for("matter.driver-audit.native-backend")],key="native-progress:delivery";',
      '    assert.equal((await backend.rpc("matter_hosted_state_read",{p_key:"collector-state"})).body_text,' +
        JSON.stringify(state.find(row => row.key === 'collector-state').body) + ');',
      '    const hash=x=>createHash("sha256").update(x).digest("hex"),ownerId=randomUUID();',
      '    const lease={ownerId,...await backend.rpc("matter_hosted_lease_acquire",{p_owner:ownerId,p_ttl:240})};',
      '    const value=await backend.pollProgress.read({key});',
      '    const body=JSON.stringify({version:1,kind:"native-delivery-poll-progress",schedule:{pending:[]},photoCursor:0,',
      '      photoSourceHalt:null,lastPoll:null,lastSuccessfulPollAt:null,lastDataChangeAt:null});',
      '    const bodySha256=hash(body),expectedRevision=value.revision;',
      '    try{await backend.pollProgress.compareAndSwap({key,lease,expectedRevision,body,',
      '      eventId:"progress-"+hash(JSON.stringify([key,expectedRevision,bodySha256])),',
      '      event:JSON.stringify({kind:"native-poll-progress",key,phase:"settled",bodySha256}),',
      '      request:JSON.stringify({key,expectedRevision,bodySha256})});}',
      '    catch(error){await backend.rpc("matter_hosted_lease_release",{p_owner:ownerId,p_token:lease.token});',
      '      response.end(JSON.stringify({status:"needs-inspection",failed:1}));return;}',
      '    await backend.rpc("matter_hosted_lease_release",{p_owner:ownerId,p_token:lease.token});',
      '  }',
    ].join('\n') : '',
    '  response.end(JSON.stringify(called ? {status:"not-due"} : {status:"complete",collected:1,failed:0}));',
    '  called = true;',
    '}',
  ].join('\n'));
  const entrypoint = { module: 'source/collector.mjs', method: 'GET', path: '/api/collector?task=delivery', schedule: '* * * * *' };
  const inputFile = path.join(work, 'input.private.json');
  await fs.writeFile(inputFile, JSON.stringify({ root: work, runtimeRoot, entrypoint, stateFile, objectsRoot, expected, nativeReplay,
    nativePollProgress, failPublication: nativePollProgress }));
  return { mode: 'source', root: work, inputFile, executable: process.execPath, args: ['--max-old-space-size=3072'],
    readRoots: [runtimeRoot], timeoutMs: 5000 };
}

test('qualification child accepts verified source replay in an isolated process', async t => {
  const fixture = await replayFixture(t);
  process.env.QUALIFICATION_PROTECTED_VALUE = 'local-test-value';
  t.after(() => { delete process.env.QUALIFICATION_PROTECTED_VALUE; });
  const child = runDriverAuditQualificationChild(fixture);
  try {
    const receipt = await child.result;
    assert.equal(receipt.status, 'verified');
    assert.equal(receipt.networkAttempts, 0);
    assert.equal(receipt.nodeVersion, process.version);
    assert.ok(receipt.peakRssBytes > 0);
  } finally { await child.stop(); }
});

test('qualification child rejects a handler that attempts an undeclared request', async t => {
  const child = runDriverAuditQualificationChild(await replayFixture(t, { network: true }));
  try { await assert.rejects(child.result, /isolated qualification failed/i); }
  finally { await child.stop(); }
});

test('native qualification uses fixed host admission and preserved saved ledgers without credentials or network', async t => {
  const child = runDriverAuditQualificationChild(await replayFixture(t, { nativeReplay: true }));
  try {
    const receipt = await child.result;
    assert.equal(receipt.status, 'verified');
    assert.equal(receipt.executionAdmission, 'fixed-host-v1');
    assert.equal(receipt.executionLedgersPreserved, true);
    assert.equal(receipt.networkAttempts, 0);
  } finally { await child.stop(); }
});

test('native qualification tests failed progress retry while unchanged evidence emits no new objects', async t => {
  const child = runDriverAuditQualificationChild(await replayFixture(t, { nativeReplay: true, nativePollProgress: true }));
  try {
    const receipt = await child.result;
    assert.equal(receipt.status, 'verified');
    assert.equal(receipt.outputObjects, 0);
    assert.equal(receipt.nativeNoChangeDuplicateFree, true);
    assert.equal(receipt.failureKind, 'progress');
    assert.equal(receipt.networkAttempts, 0);
  } finally { await child.stop(); }
});

test('native qualification rejects accidental legacy HTTP access instead of accepting a simulated hosted write', async t => {
  const fixture = await replayFixture(t, { nativeReplay: true });
  const input = JSON.parse(await fs.readFile(fixture.inputFile));
  await fs.appendFile(path.join(input.runtimeRoot, 'source/collector.mjs'),
    '\nawait fetch("https://legacy-reporting.invalid/rest/v1/rpc/matter_hosted_state_read",' +
    '{method:"POST",body:JSON.stringify({p_key:"worker-budget"})});\n');
  const child = runDriverAuditQualificationChild(fixture);
  try { await assert.rejects(child.result, /isolated qualification failed/i); }
  finally { await child.stop(); }
});

test('native qualification reuses the managed isolated disk cache across cold and warm processes', async t => {
  const cold = await replayFixture(t, { nativeReplay: true });
  const input = JSON.parse(await fs.readFile(cold.inputFile));
  const cacheDirectory = path.join(path.dirname(cold.root), 'source-archive-cache');
  await fs.mkdir(cacheDirectory, { mode: 0o700 });
  await fs.writeFile(cold.inputFile, JSON.stringify({ ...input, archiveCacheDirectory: cacheDirectory }));
  const coldChild = runDriverAuditQualificationChild({ ...cold, archiveCacheDirectory: cacheDirectory });
  let first;
  try { first = await coldChild.result; }
  finally { await coldChild.stop(); }
  assert.equal(first.nativeManagedArchiveCache, true);
  assert.equal(first.nativeArchiveCacheEnabled, true);
  assert.equal(first.archiveReads.requests, 1);
  assert.ok(first.archiveReads.bytes > 0);

  const warmRoot = path.join(path.dirname(cold.root), 'source-after-builder');
  await fs.mkdir(warmRoot, { mode: 0o700 });
  const warmInput = path.join(warmRoot, 'input.private.json');
  await fs.writeFile(warmInput, JSON.stringify({ ...input, root: warmRoot, archiveCacheDirectory: cacheDirectory }));
  const warmChild = runDriverAuditQualificationChild({ ...cold, root: warmRoot, inputFile: warmInput,
    archiveCacheDirectory: cacheDirectory, readRoots: [...cold.readRoots, cold.root] });
  try {
    const second = await warmChild.result;
    assert.equal(second.nativeManagedArchiveCache, true);
    assert.equal(second.nativeArchiveCacheEnabled, true);
    assert.equal(second.archiveReads.requests, 0);
    assert.equal(second.archiveReads.bytes, 0);
    assert.equal(second.reportHash, first.reportHash);
  } finally { await warmChild.stop(); }
});

for (const mode of ['legacy', 'native', 'unqualified']) test('qualification builder ' + mode + ' cache ownership is checked before building', async t => {
  const nativeReplay = mode !== 'legacy';
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'audit-builder-child-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const work = path.join(root, 'work');
  const codeRoot = path.join(root, 'code');
  const archiveBaseline = path.join(root, 'original');
  const sourceRoot = path.join(root, 'source');
  const objectsRoot = path.join(root, 'objects');
  const baselineRoot = path.join(work, 'baseline');
  const cacheRoot = path.join(root, 'cache');
  const archiveCacheDirectory = nativeReplay ? path.join(root, 'source-archive-cache') : undefined;
  for (const directory of [work, archiveBaseline, sourceRoot, objectsRoot, baselineRoot, cacheRoot,
    path.join(codeRoot, 'integration/cloud'), path.join(codeRoot, 'scripts')]) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (archiveCacheDirectory) await fs.mkdir(archiveCacheDirectory, { mode: 0o700 });
  const asset = Buffer.from('expected immutable dependency');
  const key = hash(asset) + '.gz';
  const builderSha256 = 'b'.repeat(64);
  const candidateManifestSha256 = 'c'.repeat(64);
  await fs.writeFile(path.join(sourceRoot, 'replayed-source.private.json'), '{"revision":1,"body":"{}"}');
  await fs.writeFile(path.join(codeRoot, 'integration/cloud/automatic-release.mjs'), 'export const automaticReleaseBasis=()=>"basis";');
  await fs.writeFile(path.join(codeRoot, 'integration/cloud/repository.mjs'),
    'export const createCloudRepository=()=>({pin:async()=>({publication:{}})});');
  if (nativeReplay) await fs.writeFile(path.join(codeRoot, 'integration/cloud/automatic-release-source.mjs'), [
    'import assert from "node:assert/strict";',
    'export const supportsManagedArchiveCache=' + (mode === 'native') + ';',
    'export let sourceCalled=false;',
    'export function createAutomaticReleaseSource({stateStore,archiveTransport,cacheRoot,skipCacheWrite}) {',
    '  assert.equal(skipCacheWrite,true);',
    '  assert.equal(archiveTransport.managedReadCache,true);',
    '  assert.equal(cacheRoot,' + JSON.stringify(archiveCacheDirectory) + ');',
    '  return async()=>{sourceCalled=true;return {savedState:await stateStore.read("collector-state"),publication:{},transport:archiveTransport};};',
    '}',
  ].join('\n'));
  await fs.writeFile(path.join(codeRoot, 'integration/cloud/automatic-release-build.mjs'), [
    'import assert from "node:assert/strict";',
    'import fs from "node:fs/promises";',
    'import path from "node:path";',
    'export const compactDirectBuildVersion=1;',
    'export async function buildAutomaticRelease({source,output,baselineRoot,checkSpace}) {',
    nativeReplay ? '  assert.equal((await import("./automatic-release-source.mjs")).sourceCalled,true);' : '',
    '  await checkSpace();',
    '  await assert.rejects(fs.writeFile(' + JSON.stringify(path.join(archiveBaseline, 'forbidden')) + ', ""), {code:"ERR_ACCESS_DENIED"});',
    '  let data = "";',
    '  for await (const chunk of await source.transport.readObject(' + JSON.stringify(key) + ', {maxBytes:64})) data+=chunk;',
    '  assert.equal(data, "expected immutable dependency");',
    '  await fs.link(path.join(baselineRoot,"pinned"),path.join(output,"copied"));',
    '  return {privateRoot:output};',
    '}',
  ].join('\n'));
  await fs.writeFile(path.join(baselineRoot, 'pinned'), 'owned scratch file');
  await fs.writeFile(path.join(codeRoot, 'scripts/run-automatic-report.mjs'),
    'export const validateAutomaticCandidate=async()=>({ok:true,manifestSha256:' + JSON.stringify(candidateManifestSha256) + '});');
  const inputFile = path.join(work, 'input.private.json');
  await fs.writeFile(inputFile, JSON.stringify({ root: work, sourceRoot, objectsRoot, diskReserve: { start: 1, inProgress: 1 },
    nativeReplay, archiveCacheDirectory,
    builder: { codeRoot, baselineRoot, archiveBaseline, initialBaseline: archiveBaseline, cacheRoot, builderSha256,
      baselineManifestSha256: 'd'.repeat(64), compactDirectBuildVersion: 1 } }));
  const requests = [];
  const child = runDriverAuditQualificationChild({ mode: 'builder', root: work, inputFile, executable: process.execPath, args: [],
    readRoots: [sourceRoot, objectsRoot, archiveBaseline, codeRoot, cacheRoot], timeoutMs: 5000, archiveCacheDirectory,
    async readArchive(objectKey, maxBytes) {
      requests.push({ key: objectKey, maxBytes });
      const file = path.join(work, objectKey);
      await fs.writeFile(file, asset, { flag: 'wx', mode: 0o600 });
      return file;
    } });
  try {
    if (mode === 'unqualified') {
      await assert.rejects(child.result, /isolated qualification failed/i);
      assert.deepEqual(requests, []);
      return;
    }
    const result = await child.result;
    assert.equal(result.builderSha256, builderSha256);
    assert.equal(result.candidateManifestSha256, candidateManifestSha256);
    assert.equal(result.networkAttempts, 0);
    if (nativeReplay) {
      assert.equal(result.nativeManagedArchiveCache, true);
      assert.equal(result.nativeArchiveCacheEnabled, true);
      assert.deepEqual(await fs.readFile(path.join(archiveCacheDirectory, key)), asset);
      assert.deepEqual(await fs.readdir(cacheRoot), []);
    }
    assert.deepEqual(requests, [{ key, maxBytes: 64 }]);
    assert.doesNotThrow(() => process.kill(child.pid, 0));
  } finally { await child.stop(); }
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  assert.deepEqual(await fs.readdir(archiveBaseline), []);
});
