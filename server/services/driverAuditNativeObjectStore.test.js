import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const module = () => import('./driverAuditNativeObjectStore.js');
const env = { DRIVER_AUDIT_NATIVE_OBJECT_STORE: 'spaces', SPACES_ENDPOINT: 'fra1.digitaloceanspaces.com',
  SPACES_REGION: 'fra1', SPACES_BUCKET: 'example-driver-photos', SPACES_KEY: 'fictional', SPACES_SECRET: 'fictional' };
const lookup = () => ({ version: 1, kind: 'existing-photo-alias-lookup-candidates-v1', sourceMappingSha256: 'b'.repeat(64),
  candidateOnly: true, existingObjectBytesVerified: false,
  expectedStorage: { endpoint: 'https://fra1.digitaloceanspaces.com', region: 'fra1', bucket: 'example-driver-photos', keyPrefix: 'photos/' },
  entries: [{ sha256: 'a'.repeat(64), size: 100, keys: ['photos/delivery-123.jpg'] }] });
async function fixture(t, value = lookup()) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-photo-map-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from(JSON.stringify(value)), sha256 = hash(bytes), file = path.join(root, sha256 + '.json');
  await fs.writeFile(file, bytes, { mode: 0o600 });
  return { root, file, env: { ...env, DRIVER_AUDIT_NATIVE_PHOTO_CANDIDATES_SHA256: sha256 } };
}

test('the legacy native object store does not require Spaces or a photo candidate file', async () => {
  const { createDriverAuditNativeObjectStore: create } = await module();
  assert.equal(await create({ env: {} }), undefined);
  assert.equal(await create({ env: { DRIVER_AUDIT_NATIVE_OBJECT_STORE: 'mongo' } }), undefined);
  await assert.rejects(create({ env: { DRIVER_AUDIT_NATIVE_OBJECT_STORE: 'unknown' } }), /object store/i);
});

test('native photo candidates require owned exact bytes and the same destination bucket', async t => {
  const { readDriverAuditPhotoCandidates: read } = await module(), f = await fixture(t);
  const saved = await read({ env: f.env, root: f.root });
  assert.deepEqual(saved.get('a'.repeat(64)), { size: 100, keys: ['photos/delivery-123.jpg'] });
  await assert.rejects(read({ env: { ...f.env, SPACES_BUCKET: 'another-bucket' }, root: f.root }), /destination/i);
  await fs.appendFile(f.file, ' ');
  await assert.rejects(read({ env: f.env, root: f.root }), /integrity/i);
});

test('a candidate file made public between inspection and opening is rejected', async t => {
  const { readDriverAuditPhotoCandidates: read } = await module(), f = await fixture(t), original = fs.open;
  fs.open = async function (file, ...args) {
    if (file === f.file) await fs.chmod(file, 0o644);
    return original.call(this, file, ...args);
  };
  try { await assert.rejects(read({ env: f.env, root: f.root }), /private|changed/); }
  finally { fs.open = original; }
});

test('photo lookup refuses traversal, duplicate hashes and unknown payload fields', async t => {
  const { readDriverAuditPhotoCandidates: read } = await module();
  for (const mutate of [v => { v.entries[0].keys = ['photos/../private.txt']; },
    v => { v.entries.push(structuredClone(v.entries[0])); }, v => { v.entries[0].payload = {}; },
    v => { v.candidateOnly = false; }]) {
    const value = lookup(); mutate(value); const f = await fixture(t, value);
    await assert.rejects(read({ env: f.env, root: f.root }));
  }
});

test('fresh photo hints accept only original owned upload URLs and cannot widen storage access', async t => {
  const { createDriverAuditNativeObjectStore: create } = await module(), f = await fixture(t);
  const store = await create({ env: f.env, photoCandidatesRoot: f.root, client: { send() { throw Error('A hint must not contact storage'); } } });
  const hint = { sha256: 'c'.repeat(64), size: 200 };
  assert.equal(store.offerSourcePhotoCandidate({ ...hint, url: 'https://example-driver-photos.fra1.cdn.digitaloceanspaces.com/photos/delivery-1.png' }), true);
  for (const url of ['https://foreign.invalid/photos/delivery-1.png',
    'https://example-driver-photos.fra1.cdn.digitaloceanspaces.com/photos/delivery-1.png?resize=1',
    'https://example-driver-photos.fra1.cdn.digitaloceanspaces.com/photos/%2e%2e/private.json',
    'https://example-driver-photos.fra1.cdn.digitaloceanspaces.com/photos/../photos/delivery-1.png',
    'https://example-driver-photos.fra1.cdn.digitaloceanspaces.com/other/file.jpg']) {
    assert.equal(store.offerSourcePhotoCandidate({ ...hint, url }), false);
  }
});
