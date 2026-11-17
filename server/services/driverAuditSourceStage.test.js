import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { stageDriverAuditSource, stageDriverAuditSourceProof } from '../scripts/driverAuditSourceStage.js';
import { driverAuditSourceDataStore, readDriverAuditSourceConfig } from './driverAuditSource.js';

const hash = value => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'source-stage-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const module = Buffer.from('export default async function(req,res){res.writeHead(200);res.end("{\\"status\\":\\"disabled\\"}");}');
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    files: [{ path: 'source/api/collector.mjs', sha256: hash(module), bytes: module.length }],
    entrypoints: [{ id: 'delivery', module: 'source/api/collector.mjs', exportName: 'default', method: 'GET',
      path: '/api/collector?task=delivery', schedule: '* * * * *', timeZone: 'UTC', maxDurationSeconds: 300,
      requiredEnvironment: ['CRON_SECRET', 'MATTER_DELIVERY_ENABLED'] }],
  }));
  const bundle = { version: 1, manifestSha256: hash(manifest), nodeExecutable: process.execPath,
    nodeVersion: process.version,
    files: [{ path: 'manifest.private.json', dataBase64: manifest.toString('base64') },
      { path: 'source/api/collector.mjs', dataBase64: module.toString('base64') }] };
  const environmentBytes = Buffer.from(JSON.stringify({ CRON_SECRET: 'c'.repeat(32), MATTER_DELIVERY_ENABLED: '0' }));
  const args = () => {
    const compressed = gzipSync(JSON.stringify(bundle));
    return { sourceRoot: root, compressed, expectedBundleSha256: hash(compressed),
      expectedManifestSha256: hash(manifest), environmentBytes, nodeExecutable: process.execPath };
  };
  return { root, bundle, args, environmentBytes };
}

test('private source staging verifies the entire package, saves exact configuration and is idempotent', async t => {
  const f = await fixture(t);
  const result = await stageDriverAuditSource(f.args());
  assert.equal(result.status, 'staged');
  const config = JSON.parse(await fs.readFile(result.configFile));
  assert.equal(config.manifestSha256, f.bundle.manifestSha256);
  assert.equal((await fs.stat(config.environment.path)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readFile(config.environment.path), f.environmentBytes);
  assert.equal((await stageDriverAuditSource(f.args())).status, 'already-staged');
  assert.equal(await fs.stat(path.join(path.dirname(result.configFile), 'source-state.private.json')).catch(error => error.code), 'ENOENT');
});

test('source staging rejects corrupt compressed bytes, path traversal and an unlisted code file', async t => {
  const f = await fixture(t);
  await assert.rejects(stageDriverAuditSource({ ...f.args(), expectedBundleSha256: 'f'.repeat(64) }), /bundle.*integrity/i);
  f.bundle.files.push({ path: '../escape', dataBase64: Buffer.from('escape').toString('base64') });
  await assert.rejects(stageDriverAuditSource(f.args()), /path/i);
  f.bundle.files.pop();
  f.bundle.files.push({ path: 'source/extra.mjs', dataBase64: Buffer.from('export{}').toString('base64') });
  await assert.rejects(stageDriverAuditSource(f.args()), /unlisted|inventory/i);
  assert.equal(await fs.stat(path.join(f.root, f.bundle.manifestSha256)).catch(error => error.code), 'ENOENT');
});

test('source staging preserves an existing release when environment or bundle identity changes', async t => {
  const f = await fixture(t);
  const staged = await stageDriverAuditSource(f.args());
  const before = await fs.readFile(staged.configFile);
  const changed = Buffer.from(JSON.stringify({ CRON_SECRET: 'd'.repeat(32), MATTER_DELIVERY_ENABLED: '0' }));
  await assert.rejects(stageDriverAuditSource({ ...f.args(), environmentBytes: changed }), /different|changed/i);
  assert.deepEqual(await fs.readFile(staged.configFile), before);
  await fs.writeFile(staged.configFile, '{"version":2}', { mode: 0o600 });
  await assert.rejects(stageDriverAuditSource(f.args()), /configuration.*changed/i);
});

test('a cache-enabled source release is staged only with the managed cache path', async t => {
  const f = await fixture(t);
  const sourceRoot = path.join(f.root, 'driver-audit-source');
  await fs.mkdir(sourceRoot, { mode: 0o700 });
  const marker = 'source/integration/hosted/archive-read-cache.mjs';
  const cacheModule = Buffer.from('export {};');
  const [manifest] = f.bundle.files;
  const original = JSON.parse(Buffer.from(manifest.dataBase64, 'base64'));
  original.files.push({ path: marker, bytes: cacheModule.length, sha256: hash(cacheModule) });
  const updated = Buffer.from(JSON.stringify(original));
  manifest.dataBase64 = updated.toString('base64');
  f.bundle.manifestSha256 = hash(updated);
  f.bundle.files.push({ path: marker, dataBase64: cacheModule.toString('base64') });
  const args = { ...f.args(), sourceRoot, expectedManifestSha256: f.bundle.manifestSha256 };
  const stage = cacheDirectory => stageDriverAuditSource({ ...args, environmentBytes: Buffer.from(JSON.stringify({
    ...JSON.parse(f.environmentBytes), MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY: cacheDirectory,
  })) });
  await assert.rejects(stage(undefined), /managed builder archive cache/i);
  await assert.rejects(stage(path.join(f.root, 'originals')), /managed builder archive cache/i);
  const cacheDirectory = path.join(f.root, 'driver-audits', 'a'.repeat(64), 'work', 'archive-cache');
  const staged = await stage(cacheDirectory);
  assert.equal((await readDriverAuditSourceConfig(staged.configFile)).archiveCacheDirectory, cacheDirectory);
});

async function sidiFixture(t) {
  const f = await fixture(t);
  const sourceRoot = path.join(f.root, 'driver-audit-source');
  await fs.mkdir(sourceRoot, { mode: 0o700 });
  const [savedManifest] = f.bundle.files;
  const manifest = JSON.parse(Buffer.from(savedManifest.dataBase64, 'base64'));
  for (const relative of ['source/integration/hosted/native-backend.mjs',
    'source/integration/hosted/archive-read-cache.mjs', 'source/integration/cloud/native-poll-progress.mjs']) {
    const bytes = Buffer.from('export {};');
    manifest.files.push({ path: relative, sha256: hash(bytes), bytes: bytes.length });
    f.bundle.files.push({ path: relative, dataBase64: bytes.toString('base64') });
  }
  Object.assign(manifest, { managedSourceExecutionHost: 'sidi', managedSourceExecutionAdmission: 'fixed-host-v1' });
  const environment = { ...JSON.parse(f.environmentBytes), DRIVER_AUDIT_EXECUTION_HOST: 'sidi',
    MATTER_SUPABASE_SECRET: 'fictional-source-credential',
    MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY: path.join(f.root, 'driver-audits', 'a'.repeat(64), 'work', 'archive-cache') };
  const stage = async () => {
    const bytes = Buffer.from(JSON.stringify(manifest));
    savedManifest.dataBase64 = bytes.toString('base64');
    f.bundle.manifestSha256 = hash(bytes);
    return stageDriverAuditSource({ ...f.args(), sourceRoot, expectedManifestSha256: hash(bytes),
      environmentBytes: Buffer.from(JSON.stringify(environment)) });
  };
  return { ...f, manifest, environment, stage };
}

test('Sidi source execution keeps Supabase selection and requires the pinned runtime capability', async t => {
  const f = await sidiFixture(t);
  const staged = await f.stage();
  const checked = await readDriverAuditSourceConfig(staged.configFile);
  assert.equal(checked.dataStore, 'supabase');
  assert.equal(checked.executionHost, 'sidi');
  assert.equal(checked.environment.DRIVER_AUDIT_DATA_STORE, undefined);
});

test('host execution cannot be enabled on an unqualified or mislabeled source export', async t => {
  for (const change of [f => { delete f.manifest.managedSourceExecutionHost; },
    f => { f.manifest.managedSourceExecutionAdmission = 'unbounded'; },
    f => { f.environment.DRIVER_AUDIT_EXECUTION_HOST = 'other'; },
    f => { f.environment.MONGODB_URI = 'mongodb://fictional.invalid/unused'; }]) {
    const f = await sidiFixture(t);
    change(f);
    await assert.rejects(f.stage(), /execution|capability|app database/i);
    assert.deepEqual(await fs.readdir(path.join(f.root, 'driver-audit-source')), []);
  }
});

test('proof staging writes pinned JSON evidence without creating activation or changing source files', async t => {
  const f = await fixture(t);
  const source = await stageDriverAuditSource(f.args());
  const root = path.dirname(source.configFile);
  const proofBytes = Buffer.from('{"version":1,"verified":true}');
  const envelope = Buffer.from(JSON.stringify({ version: 1,
    files: [{ path: 'backup.private.json', sha256: hash(proofBytes), dataBase64: proofBytes.toString('base64') }] }));
  const compressed = gzipSync(envelope);
  const args = { root, compressed, expectedSha256: hash(compressed) };
  assert.equal((await stageDriverAuditSourceProof(args)).status, 'proof-staged');
  assert.deepEqual(await fs.readFile(path.join(root, 'proofs', hash(compressed), 'backup.private.json')), proofBytes);
  assert.equal((await stageDriverAuditSourceProof(args)).status, 'proof-staged');
  assert.equal(await fs.stat(path.join(root, 'deployment-source.private.json')).catch(error => error.code), 'ENOENT');
});

test('proof staging refuses paths that could change source code or runtime controls', async t => {
  const f = await fixture(t);
  const source = await stageDriverAuditSource(f.args());
  for (const file of ['../source.json', 'source.json', 'subdir/evidence.json', 'evidence.mjs']) {
    const bytes = Buffer.from('{}');
    const compressed = gzipSync(JSON.stringify({ version: 1, files: [{ path: file, sha256: hash(bytes), dataBase64: bytes.toString('base64') }] }));
    await assert.rejects(stageDriverAuditSourceProof({ root: path.dirname(source.configFile), compressed, expectedSha256: hash(compressed) }), /path/i);
  }
});

test('native source selection requires its adapter and reuses the app connection', () => {
  const files = [{ path: 'source/integration/hosted/native-backend.mjs' }];
  assert.equal(driverAuditSourceDataStore(files, {}), 'supabase');
  assert.equal(driverAuditSourceDataStore(files, { DRIVER_AUDIT_DATA_STORE: 'mongo' }), 'mongo');
  assert.throws(() => driverAuditSourceDataStore([], { DRIVER_AUDIT_DATA_STORE: 'mongo' }), /does not support/);
  assert.throws(() => driverAuditSourceDataStore(files, { DRIVER_AUDIT_DATA_STORE: 'other' }), /Unknown/);
  assert.throws(() => driverAuditSourceDataStore(files, {
    DRIVER_AUDIT_DATA_STORE: 'mongo', MONGODB_URI: 'another-connection',
  }), /app database/);
});
