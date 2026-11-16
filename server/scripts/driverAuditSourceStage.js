import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  driverAuditSourceHash,
  driverAuditSourceArchiveCacheDirectory,
  driverAuditSourceDataStore,
  readPrivateDriverAuditSource,
  requirePrivateDriverAuditSourceDirectory,
  verifyDriverAuditSource,
  writeDriverAuditSourceState,
} from '../services/driverAuditSource.js';

const hashPattern = /^[a-f0-9]{64}$/;
function requireStage(condition, message) {
  if (!condition) throw new Error(message);
}

async function privateDirectory(directory) {
  await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  await requirePrivateDriverAuditSourceDirectory(directory);
}

async function stageFile(root, relative, bytes) {
  const segments = relative.split('/');
  let directory = root;
  for (const segment of segments.slice(0, -1)) {
    directory = path.join(directory, segment);
    await privateDirectory(directory);
  }
  const file = path.join(root, ...segments);
  try {
    const existing = await readPrivateDriverAuditSource(file);
    requireStage(existing.equals(bytes), 'Staged source file changed.');
    return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function stageDriverAuditSource({ sourceRoot, compressed, expectedBundleSha256, expectedManifestSha256, environmentBytes, nodeExecutable }) {
  requireStage(Buffer.isBuffer(compressed) && compressed.length > 0 && compressed.length <= 1024 * 1024
    && hashPattern.test(expectedBundleSha256 ?? '') && driverAuditSourceHash(compressed) === expectedBundleSha256,
  'Source bundle integrity failure.');
  requireStage(hashPattern.test(expectedManifestSha256 ?? '') && Buffer.isBuffer(environmentBytes)
    && environmentBytes.length <= 64 * 1024, 'Invalid private source inputs.');
  const bundle = JSON.parse(gunzipSync(compressed, { maxOutputLength: 16 * 1024 * 1024 }));
  requireStage(bundle.version === 1 && bundle.manifestSha256 === expectedManifestSha256 && Array.isArray(bundle.files)
    && bundle.files.length > 0 && bundle.files.length <= 4097 && bundle.nodeExecutable === nodeExecutable
    && path.isAbsolute(nodeExecutable ?? '') && /^v\d+\.\d+\.\d+$/.test(bundle.nodeVersion ?? ''), 'Invalid source bundle configuration.');
  const files = new Map();
  for (const entry of bundle.files) {
    requireStage(typeof entry.path === 'string' && entry.path.length <= 1024
      && entry.path.split('/').every(part => part !== '.' && part !== '..' && /^[a-zA-Z0-9_.-]+$/.test(part)),
    'Invalid source bundle path.');
    requireStage(!files.has(entry.path) && typeof entry.dataBase64 === 'string'
      && /^[A-Za-z0-9+/]*={0,2}$/.test(entry.dataBase64), 'Invalid source bundle file.');
    const bytes = Buffer.from(entry.dataBase64, 'base64');
    requireStage(bytes.toString('base64') === entry.dataBase64, 'Invalid source bundle encoding.');
    files.set(entry.path, bytes);
  }
  const manifestBytes = files.get('manifest.private.json');
  requireStage(manifestBytes && driverAuditSourceHash(manifestBytes) === expectedManifestSha256, 'Source manifest integrity failure.');
  const manifest = JSON.parse(manifestBytes);
  requireStage(Array.isArray(manifest.files) && files.size === manifest.files.length + 1
    && manifest.files.every(entry => files.has(entry.path) && entry.path.startsWith('source/')
      && files.get(entry.path).length === entry.bytes && driverAuditSourceHash(files.get(entry.path)) === entry.sha256),
  'Source bundle inventory has missing or unlisted files.');
  const environment = JSON.parse(environmentBytes);
  requireStage(environment && typeof environment === 'object' && !Array.isArray(environment)
    && Object.entries(environment).every(([key, value]) => /^[A-Z][A-Z0-9_]*$/.test(key) && typeof value === 'string'),
  'Invalid source environment.');
  await requirePrivateDriverAuditSourceDirectory(sourceRoot);
  const target = path.join(sourceRoot, expectedManifestSha256);
  driverAuditSourceArchiveCacheDirectory(target, manifest.files, environment);
  driverAuditSourceDataStore(manifest.files, environment);
  const staging = path.join(sourceRoot, '.staging-' + expectedBundleSha256);
  const environmentSha256 = driverAuditSourceHash(environmentBytes);
  const expectedReceipt = { version: 1, bundleSha256: expectedBundleSha256, manifestSha256: expectedManifestSha256,
    environmentSha256, nodeExecutable, nodeVersion: bundle.nodeVersion };
  const config = { version: 1, root: target, runtimeRoot: path.join(target, 'runtime'), manifestSha256: expectedManifestSha256,
    nodeExecutable, nodeVersion: bundle.nodeVersion,
    environment: { path: path.join(target, 'environment.private.json'), sha256: environmentSha256 },
    gatewayCredential: environment.AI_GATEWAY_API_KEY ? { environmentKey: 'AI_GATEWAY_API_KEY' } : null };
  try {
    await requirePrivateDriverAuditSourceDirectory(target);
    const saved = JSON.parse(await readPrivateDriverAuditSource(path.join(target, 'stage.private.json')));
    requireStage(JSON.stringify(saved) === JSON.stringify(expectedReceipt), 'A different source bundle or environment is already staged.');
    await verifyDriverAuditSource({ runtimeRoot: path.join(target, 'runtime'), expectedSha256: expectedManifestSha256 });
    requireStage(driverAuditSourceHash(await readPrivateDriverAuditSource(path.join(target, 'environment.private.json'))) === environmentSha256,
      'Staged source environment changed.');
    const savedConfig = JSON.parse(await readPrivateDriverAuditSource(path.join(target, 'source.json')));
    requireStage(JSON.stringify(savedConfig) === JSON.stringify(config), 'Staged source configuration changed.');
    return { status: 'already-staged', manifestSha256: expectedManifestSha256, configFile: path.join(target, 'source.json') };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await privateDirectory(staging);
  const runtimeRoot = path.join(staging, 'runtime');
  await privateDirectory(runtimeRoot);
  for (const [relative, bytes] of files) await stageFile(runtimeRoot, relative, bytes);
  await verifyDriverAuditSource({ runtimeRoot, expectedSha256: expectedManifestSha256 });
  await stageFile(staging, 'environment.private.json', environmentBytes);
  await writeDriverAuditSourceState(path.join(staging, 'source.json'), config);
  await writeDriverAuditSourceState(path.join(staging, 'stage.private.json'), expectedReceipt);
  await fs.rename(staging, target);
  const directory = await fs.open(sourceRoot, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
  return { status: 'staged', manifestSha256: expectedManifestSha256, configFile: path.join(target, 'source.json') };
}

export async function stageDriverAuditSourceProof({ root, compressed, expectedSha256 }) {
  requireStage(Buffer.isBuffer(compressed) && compressed.length > 0 && compressed.length <= 36 * 1024
    && hashPattern.test(expectedSha256 ?? '') && driverAuditSourceHash(compressed) === expectedSha256,
  'Source proof envelope integrity failure.');
  const envelope = JSON.parse(gunzipSync(compressed, { maxOutputLength: 4 * 1024 * 1024 }));
  requireStage(envelope.version === 1 && Array.isArray(envelope.files) && envelope.files.length > 0
    && envelope.files.length <= 64, 'Invalid source proof envelope.');
  const names = new Set();
  const files = envelope.files.map(file => {
    requireStage(typeof file.path === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}\.private\.json$/.test(file.path)
      && !names.has(file.path), 'Invalid source proof path.');
    names.add(file.path);
    requireStage(typeof file.dataBase64 === 'string' && hashPattern.test(file.sha256 ?? ''), 'Invalid source proof encoding.');
    const bytes = Buffer.from(file.dataBase64, 'base64');
    requireStage(bytes.toString('base64') === file.dataBase64 && driverAuditSourceHash(bytes) === file.sha256,
      'Source proof file integrity failure.');
    const parsed = JSON.parse(bytes);
    requireStage(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'Source proof must be a JSON object.');
    return { path: file.path, bytes };
  });
  await requirePrivateDriverAuditSourceDirectory(root);
  const base = path.join(root, 'proofs');
  await privateDirectory(base);
  const directory = path.join(base, expectedSha256);
  await privateDirectory(directory);
  for (const file of files) await stageFile(directory, file.path, file.bytes);
  return { status: 'proof-staged', proofRoot: directory, files: files.length, envelopeSha256: expectedSha256 };
}
