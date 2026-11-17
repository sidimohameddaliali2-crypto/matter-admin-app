import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  runDriverAuditQualificationChild,
  stageDriverAuditQualification,
  verifyDriverAuditSourceHostQualification,
} from '../scripts/driverAuditSourceQualify.js';

const hash = value => createHash('sha256').update(value).digest('hex');

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

async function replayFixture(t, { network = false, nativeReplay = false } = {}) {
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
    'collector-state': { head, lastCapture: { runId: 'example' } },
    'capture:example': { runId: 'example', ref: { key } },
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
    '  response.end(JSON.stringify(called ? {status:"not-due"} : {status:"complete",collected:1,failed:0}));',
    '  called = true;',
    '}',
  ].join('\n'));
  const entrypoint = { module: 'source/collector.mjs', method: 'GET', path: '/api/collector?task=delivery', schedule: '* * * * *' };
  const inputFile = path.join(work, 'input.private.json');
  await fs.writeFile(inputFile, JSON.stringify({ root: work, runtimeRoot, entrypoint, stateFile, objectsRoot, expected, nativeReplay }));
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
