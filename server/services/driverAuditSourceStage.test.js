import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { stageDriverAuditSource, stageDriverAuditSourceProof } from '../scripts/driverAuditSourceStage.js';

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
