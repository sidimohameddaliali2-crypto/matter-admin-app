import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createDriverAuditSupabaseArchive } from './driverAuditSupabaseArchive.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const env = { SPACES_BUCKET: 'fixture-photos', SPACES_REGION: 'fra1', SPACES_ENDPOINT: 'fra1.digitaloceanspaces.com' };
const photoUrl = 'https://fixture-photos.fra1.cdn.digitaloceanspaces.com/photos/fixture.jpg';
const bytes = Buffer.from('fictional preserved delivery photo'), key = hash(bytes) + '.gz';
const alias = { version: 1, provider: 'spaces', identitySha256: 'a'.repeat(64), kind: 'existing-photo-v1',
  key: 'photos/fixture.jpg', size: bytes.length, sha256: hash(bytes), etag: '"fixture-etag"', versionId: null };
function fixture({ original = bytes, existing, corrupt = false, missing = false, failRegister = false, retentionFails = false } = {}) {
  const aliases = new Map(existing ? [[key, { ...alias }]] : []), calls = [], originals = new Map(original ? [[key, original]] : []);
  let originalWrites = 0, photoReads = 0, checks = 0;
  const archive = createDriverAuditSupabaseArchive({ env, archive: {
    async assertPrivate() { return { bucket: 'matter-report-archive', public: false }; },
    async readObject(k) { calls.push('supabase-read'); if (!originals.has(k)) throw Error('Original missing'); return [originals.get(k)]; },
    async putVerifiedObject(k, b) { originalWrites++; originals.set(k, Buffer.from(b)); return { key: k, verified: true }; },
  }, async rpc(name, args) {
    calls.push(name);
    if (name.endsWith('_register')) { if (failRegister) throw Error('Registration failed'); if (!aliases.has(args.p_key)) aliases.set(args.p_key, args.p_reference); }
    return { reference: aliases.get(args.p_key) ?? null };
  }, photoStore: {
    identitySha256: alias.identitySha256,
    async assertExistingPhotoRetention() { checks++; if (retentionFails) throw Error('Photos expire'); return { verified: true, existingPhotosExpire: false }; },
    async verifyExistingPhoto(value) {
      calls.push('verify-photo');
      if (missing) throw Object.assign(Error('NoSuchKey'), { name: 'NoSuchKey' });
      if (corrupt) throw Error('Photo integrity failure');
      assert.equal(value.sha256, hash(bytes)); return { ...alias };
    },
    async readExistingPhoto() { photoReads++; if (missing) throw Error('Admitted photo missing'); return corrupt ? Buffer.from('changed') : bytes; },
  } });
  return { archive, aliases, originals, calls, counts: () => ({ originalWrites, photoReads, checks }) };
}

test('old Supabase archive bytes read unchanged with no writes or photo admission', async () => {
  const f = fixture();
  assert.deepEqual(Buffer.concat(await f.archive.readObject(key)), bytes);
  assert.equal(f.counts().originalWrites, 0);
  assert.equal(f.aliases.size, 0);
  assert.equal(f.counts().photoReads, 0);
});

test('a new verified photo keeps only its immutable original-upload reference', async () => {
  const f = fixture({ original: null });
  assert.equal(f.archive.offerSourcePhotoCandidate({ sha256: hash(bytes), size: bytes.length, url: photoUrl }), true);
  const result = await f.archive.putVerifiedObject(key, bytes);
  assert.equal(result.reusedExistingPhoto, true);
  assert.equal(f.counts().originalWrites, 0);
  assert.equal(f.aliases.size, 1);
  assert.equal(f.originals.size, 0);
  assert.deepEqual(Buffer.concat(await f.archive.readObject(key)), bytes);
  assert.equal(f.counts().checks, 1);
});

test('reload reads the admitted alias and does not need the temporary source hint', async () => {
  const f = fixture({ original: null, existing: true });
  assert.deepEqual(Buffer.concat(await f.archive.readObject(key)), bytes);
  assert.equal((await f.archive.putVerifiedObject(key, bytes)).reusedExistingPhoto, true);
  assert.equal(f.counts().originalWrites, 0);
});

test('missing or changed uploads before admission preserve original caller bytes in Supabase', async () => {
  for (const options of [{ missing: true }, { corrupt: true }]) {
    const f = fixture({ ...options, original: null });
    f.archive.offerSourcePhotoCandidate({ sha256: hash(bytes), size: bytes.length, url: photoUrl });
    await f.archive.putVerifiedObject(key, bytes);
    assert.equal(f.counts().originalWrites, 1);
    assert.equal(f.aliases.size, 0);
    assert.deepEqual(f.originals.get(key), bytes);
  }
});

test('an admitted missing or changed photo fails visibly without replacing the saved reference', async () => {
  for (const options of [{ missing: true }, { corrupt: true }]) {
    const f = fixture({ ...options, original: null, existing: true });
    await assert.rejects(f.archive.readObject(key), /missing|integrity/);
    await assert.rejects(f.archive.putVerifiedObject(key, bytes), /missing|integrity/);
    assert.equal(f.counts().originalWrites, 0);
    assert.deepEqual(f.aliases.get(key), alias);
  }
});

test('an unavailable alias preserves access to the exact original Supabase photo when it already exists', async () => {
  for (const options of [{ missing: true }, { corrupt: true }]) {
    const f = fixture({ ...options, existing: true });
    assert.deepEqual(Buffer.concat(await f.archive.readObject(key)), bytes);
    assert.equal((await f.archive.putVerifiedObject(key, bytes)).verified, true);
    assert.equal(f.counts().originalWrites, 0);
    assert.deepEqual(f.aliases.get(key), alias);
  }
});

test('a narrow caller bound fails before photo or original fallback bytes are read', async () => {
  const f = fixture({ existing: true, missing: true });
  await assert.rejects(f.archive.readObject(key, { maxBytes: 1 }), /bound/);
  assert.equal(f.counts().photoReads, 0);
  assert.equal(f.calls.includes('supabase-read'), false);
});

test('inconclusive retention or a failed alias commit cannot cause an image copy', async () => {
  for (const options of [{ retentionFails: true }, { failRegister: true }]) {
    const f = fixture({ ...options, original: null });
    f.archive.offerSourcePhotoCandidate({ sha256: hash(bytes), size: bytes.length, url: photoUrl });
    await assert.rejects(f.archive.putVerifiedObject(key, bytes));
    assert.equal(f.counts().originalWrites, 0);
    assert.equal(f.aliases.size, 0);
  }
});

test('foreign and noncanonical photo hints do not become references', async () => {
  const f = fixture();
  for (const url of [photoUrl + '?token=fixture', photoUrl.replace('fixture-photos.', 'foreign.'),
    photoUrl.replace('/photos/', '/photos/a/../'), ' ' + photoUrl]) {
    assert.equal(f.archive.offerSourcePhotoCandidate({ sha256: hash(bytes), size: bytes.length, url }), false);
  }
  await f.archive.putVerifiedObject(key, bytes);
  assert.equal(f.counts().originalWrites, 1);
  assert.equal(f.aliases.size, 0);
});

test('ordinary JSON objects remain in the existing private archive', async () => {
  const f = fixture(), payload = Buffer.from('{"fixture":true}'), jsonKey = hash(payload) + '.json';
  await f.archive.putVerifiedObject(jsonKey, payload);
  assert.deepEqual(Buffer.concat(await f.archive.readObject(jsonKey)), payload);
  assert.equal(f.aliases.size, 0);
  assert.equal(f.calls.some(name => name.includes('photo_alias')), false);
});
