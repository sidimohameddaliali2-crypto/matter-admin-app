import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { openDriverAuditHostedIndexBundle, sealDriverAuditHostedIndexBundle } from './driverAuditHostedIndexBundle.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const releaseSha = 'a'.repeat(40);
const descriptorSha256 = 'b'.repeat(64);
const script = fileURLToPath(new URL('./driverAuditHostedIndexBundle.js', import.meta.url));

async function fixture(t) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hosted-index-bundle-')));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const stageRoot = path.join(parent, 'verified-index'), objectsRoot = path.join(stageRoot, 'objects');
  await fs.mkdir(stageRoot, { mode: 0o700 });
  await fs.mkdir(objectsRoot, { mode: 0o700 });
  const bodies = ['fictional interval index', 'fictional archive page'].map(text => Buffer.from(text));
  const objects = new Map(bodies.map(bytes => [sha(bytes) + '.gz', bytes]));
  for (const [name, bytes] of objects) await fs.writeFile(path.join(objectsRoot, name), bytes, { mode: 0o600 });
  const lightView = { sha256: sha(bodies[0]), size: bodies[0].length };
  const candidate = json({ descriptor: { sha256: descriptorSha256 }, servingPackage: { collectorRevision: 12 }, lightView });
  const stagedIndex = json({ version: 1, published: false, activated: false, collectorRevision: 12,
    originalDescriptorSha256: descriptorSha256, originalGpsPhotosReviewsRemainInExistingArchive: true,
    independentParitySha256: 'c'.repeat(64), lightView, objectCount: objects.size,
    objectBytes: bodies.reduce((sum, body) => sum + body.length, 0),
    archives: [...objects].map(([key, bytes]) => ({ key, bytes: bytes.length })) });
  const proof = json({ proof: 'fictional protected verification receipt' });
  await fs.writeFile(path.join(stageRoot, 'candidate.private.json'), candidate, { mode: 0o600 });
  await fs.writeFile(path.join(stageRoot, 'staged-index.private.json'), stagedIndex, { mode: 0o600 });
  return { parent, objectsRoot, objects, candidate, stagedIndex, proof, stageRoot, key: randomBytes(32), releaseSha };
}

test('binds the encrypted index to the release and recovers every exact byte only after authentication', async t => {
  const f = await fixture(t);
  const bundle = await sealDriverAuditHostedIndexBundle(f);
  const again = await sealDriverAuditHostedIndexBundle(f);
  assert.notDeepEqual(bundle, again, 'each sealed copy uses a fresh nonce and session identity');
  for (const privateBytes of [f.candidate, f.stagedIndex, f.proof, ...f.objects.values()]) {
    assert.equal(bundle.includes(privateBytes), false);
  }
  assert.deepEqual(await openDriverAuditHostedIndexBundle({ bundle, key: f.key, releaseSha }),
    { candidate: f.candidate, stagedIndex: f.stagedIndex, proof: f.proof, objects: f.objects });
  await assert.rejects(openDriverAuditHostedIndexBundle({ bundle, key: f.key, releaseSha: 'd'.repeat(40) }));
  await assert.rejects(openDriverAuditHostedIndexBundle({ bundle, key: randomBytes(32), releaseSha }));
});

test('rejects truncation, appended bytes, tampering, and aborted opening', async t => {
  const f = await fixture(t);
  const bundle = await sealDriverAuditHostedIndexBundle(f);
  const tampered = Buffer.from(bundle);
  tampered[tampered.length - 1] ^= 1;
  for (const invalid of [bundle.subarray(0, -1), Buffer.concat([bundle, Buffer.from([0])]), tampered]) {
    await assert.rejects(openDriverAuditHostedIndexBundle({ bundle: invalid, key: f.key, releaseSha }));
  }
  await assert.rejects(openDriverAuditHostedIndexBundle({ bundle, key: f.key, releaseSha, signal: AbortSignal.abort() }),
    { name: 'AbortError' });
});

test('refuses undeclared objects, symlinks, borrowed hard links, and altered bytes', async t => {
  const f = await fixture(t);
  const [objectName, original] = f.objects.entries().next().value;
  const object = path.join(f.objectsRoot, objectName), outside = path.join(f.parent, 'outside');
  const extra = path.join(f.objectsRoot, 'undeclared');
  await fs.writeFile(extra, 'foreign', { mode: 0o600 });
  await assert.rejects(sealDriverAuditHostedIndexBundle(f));
  await fs.unlink(extra);
  await fs.rename(object, outside);
  await fs.symlink(outside, object);
  await assert.rejects(sealDriverAuditHostedIndexBundle(f));
  await fs.unlink(object);
  await fs.link(outside, object);
  await assert.rejects(sealDriverAuditHostedIndexBundle(f));
  await fs.unlink(object);
  await fs.writeFile(object, Buffer.alloc(original.length, 1), { mode: 0o600 });
  await assert.rejects(sealDriverAuditHostedIndexBundle(f));
  assert.deepEqual(await fs.readFile(outside), original);
});

test('refuses an admitted pointer, mismatched binding, invalid proof and repeated inventory row', async t => {
  const f = await fixture(t);
  const file = path.join(f.stageRoot, 'staged-index.private.json'), index = JSON.parse(f.stagedIndex);
  for (const changed of [{ ...index, activated: true }, { ...index, collectorRevision: 13 },
    { ...index, archives: [index.archives[0], index.archives[0]] }]) {
    await fs.writeFile(file, json(changed));
    await assert.rejects(sealDriverAuditHostedIndexBundle(f));
  }
  await fs.writeFile(file, f.stagedIndex);
  await assert.rejects(sealDriverAuditHostedIndexBundle({ ...f, proof: Buffer.from('[]') }));
});

async function cli(args, key, stdin = false) {
  const env = { ...process.env };
  delete env.DRIVER_AUDIT_INDEX_BUNDLE_KEY;
  if (!stdin) env.DRIVER_AUDIT_INDEX_BUNDLE_KEY = key.toString('base64');
  const child = spawn(process.execPath, [script, ...args], { env, stdio: 'pipe' });
  const result = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8').on('data', chunk => { result.stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { result.stderr += chunk; });
  const close = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve({ ...result, code }));
  });
  child.stdin.end(stdin ? key.toString('base64') + '\n' : undefined);
  return close;
}

test('CLI reads the secret privately, writes ciphertext only, and preserves an occupied destination', async t => {
  const f = await fixture(t), proof = path.join(f.parent, 'release-proof.private.json');
  const output = path.join(f.parent, 'index.bundle');
  await fs.writeFile(proof, f.proof, { mode: 0o600 });
  const args = ['seal', f.stageRoot, proof, releaseSha, output];
  const sealed = await cli(args, f.key, true);
  const bundle = await fs.readFile(output);
  assert.deepEqual(sealed, { stdout: JSON.stringify({ status: 'sealed', bytes: bundle.length }) + '\n', stderr: '', code: 0 });
  assert.equal((await fs.lstat(output)).mode & 0o777, 0o600);
  assert.deepEqual(await cli(['open', output, releaseSha], f.key),
    { stdout: JSON.stringify({ status: 'verified', objects: f.objects.size }) + '\n', stderr: '', code: 0 });
  assert.deepEqual(await cli(args, f.key), { stdout: '', stderr: 'Hosted report index bundle operation stopped.\n', code: 1 });
  assert.deepEqual(await fs.readFile(output), bundle);
  assert.deepEqual((await fs.readdir(f.parent)).sort(), ['index.bundle', 'release-proof.private.json', 'verified-index']);
});
