import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { MongoClient } from 'mongodb';
import { createDriverAuditMongoArchive } from './driverAuditMongoArchive.js';
import { createDriverAuditSpacesArchive, driverAuditSpacesArchivePrefix,
  validateDriverAuditSpacesArchiveReference } from './driverAuditSpacesArchive.js';

const uri = process.env.MONGO_TEST_URI, skip = !uri;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const capacityBytes = 32 * 1024 * 1024;
let client;
before(async () => {
  if (!uri) return;
  assert(/^mongodb:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?\//.test(uri),
    'Hybrid archive tests require an isolated localhost replica set');
  client = new MongoClient(uri, { maxPoolSize: 12, serverSelectionTimeoutMS: 5000 });
  await client.connect();
});
after(async () => { await client?.close(); });

function objectStore(options = {}) {
  const objects = options.objects || new Map(), identitySha256 = options.identitySha256 || 'c'.repeat(64);
  const calls = { put: 0, reads: 0, uploads: 0, deletes: 0 };
  return { identitySha256, objects, calls,
    async assertPrivate() { return { public: false, identitySha256 }; },
    async putVerifiedObject(key, bytes, { signal } = {}) {
      signal?.throwIfAborted(); calls.put++;
      await options.beforePut?.(key, bytes);
      const full = driverAuditSpacesArchivePrefix + key, previous = objects.get(full);
      if (previous && !previous.equals(bytes)) throw Error('Fictional external integrity failure');
      if (!previous) { objects.set(full, Buffer.from(bytes)); calls.uploads++; }
      await options.afterPut?.(key, bytes);
      const result = { version: 1, provider: 'spaces', identitySha256,
        key: full, size: bytes.length, sha256: hash(bytes) };
      return options.reference ? options.reference(result) : Object.freeze(result);
    },
    async readBytes(reference, { maxBytes, signal } = {}) {
      signal?.throwIfAborted(); calls.reads++;
      const checked = validateDriverAuditSpacesArchiveReference(reference, { identitySha256 });
      const bytes = objects.get(checked.key);
      if (!bytes) throw Object.assign(Error('Fictional external object unavailable'), { code: 'storage_not_found' });
      if (bytes.length > maxBytes || bytes.length !== checked.size || hash(bytes) !== checked.sha256) {
        throw Error('Fictional external integrity failure');
      }
      return Buffer.from(bytes);
    },
  };
}

async function fixture(t, options = {}) {
  const db = client.db('driver_audit_hybrid_test_' + randomUUID().replaceAll('-', ''));
  t.after(async () => { await db.dropDatabase(); });
  const store = options.store || objectStore();
  const archive = createDriverAuditMongoArchive({ db, client, capacityBytes: options.capacityBytes || capacityBytes,
    objectStore: store });
  return { db, store, archive };
}

test('real hybrid metadata charges once and leaves protected state and review bytes in Mongo transactions', { skip }, async t => {
  const f = await fixture(t), bytes = Buffer.from('fictional immutable photo with original GPS metadata'), key = hash(bytes) + '.gz';
  await f.archive.putVerifiedObject(key, bytes);
  const file = await f.db.collection('driverAuditNativeFiles').findOne({ _id: key });
  assert(file.externalReference);
  assert.equal(file.reference, undefined);
  assert.equal(await f.db.collection('driverAuditNativeChunks').countDocuments(), 0);
  assert.equal((await f.archive.status()).usedBytes, bytes.length + 1024);
  assert.deepEqual(await f.db.collection('driverAuditNativeControl').findOne({ _id: 'archive-object-store' }),
    { _id: 'archive-object-store', version: 1, provider: 'spaces', identitySha256: f.store.identitySha256 });
  assert.deepEqual(Buffer.concat(await f.archive.readObject(key)), bytes);
  const state = Buffer.from('{"originalReviews":["retain"],"originalPaidHold":9}');
  const reference = await f.archive.putBytes(state);
  assert(reference.chunks.length > 0);
  assert.deepEqual(await f.archive.readBytes(reference), state);
  assert.equal(f.store.calls.put, 1, 'Mutable/protected state never enters external storage');
  const before = await f.archive.status(), count = await f.db.collection('driverAuditNativeChunks').countDocuments();
  const session = client.startSession();
  try {
    await assert.rejects(session.withTransaction(async () => {
      await f.archive.putBytes(Buffer.from('interrupted changed review'), { session });
      throw Error('Interrupted protected state transaction');
    }), /Interrupted/);
  } finally { await session.endSession(); }
  assert.deepEqual(await f.archive.status(), before);
  assert.equal(await f.db.collection('driverAuditNativeChunks').countDocuments(), count);
  assert.deepEqual(await f.archive.readBytes(reference), state);
});

test('real hybrid reads retain original Mongo files without uploading or changing their quota', { skip }, async t => {
  const f = await fixture(t), legacy = createDriverAuditMongoArchive({ db: f.db, client, capacityBytes });
  const bytes = Buffer.from('exact original imported archive'), key = hash(bytes) + '.gz';
  await legacy.putVerifiedObject(key, bytes);
  const original = await f.db.collection('driverAuditNativeFiles').findOne({ _id: key }), before = await legacy.status();
  await f.archive.putVerifiedObject(key, bytes);
  assert.deepEqual(Buffer.concat(await f.archive.readObject(key)), bytes);
  assert.deepEqual(await f.db.collection('driverAuditNativeFiles').findOne({ _id: key }), original);
  assert.deepEqual(await f.archive.status(), before);
  assert.equal(f.store.calls.put, 0);
  assert.equal(await f.db.collection('driverAuditNativeControl').countDocuments({ _id: 'archive-object-store' }), 0);
});

test('real hybrid restart and concurrent retries admit one reference and one quota charge', { skip }, async t => {
  const f = await fixture(t), bytes = Buffer.alloc(5000, 3), key = hash(bytes) + '.gz';
  await Promise.all(Array.from({ length: 8 }, () => f.archive.putVerifiedObject(key, bytes)));
  const reopened = createDriverAuditMongoArchive({ db: f.db, client, capacityBytes, objectStore: f.store });
  await reopened.putVerifiedObject(key, bytes);
  assert.deepEqual(Buffer.concat(await reopened.readObject(key)), bytes);
  assert.equal((await reopened.status()).usedBytes, bytes.length + 1024);
  assert.equal(await f.db.collection('driverAuditNativeFiles').countDocuments(), 1);
  assert.equal(await f.db.collection('driverAuditNativeChunks').countDocuments(), 0);
  assert.equal(f.store.calls.uploads, 1);
});

test('external upload failure preserves reusable bytes without committing a reference or quota', { skip }, async t => {
  let fail = true;
  const store = objectStore({ afterPut() { if (fail) { fail = false; throw Error('Fictional uncertain upload'); } } });
  const f = await fixture(t, { store }), bytes = Buffer.from('retain uncertain external upload'), key = hash(bytes) + '.gz';
  await assert.rejects(f.archive.putVerifiedObject(key, bytes), /uncertain upload/);
  assert.equal(await f.db.collection('driverAuditNativeFiles').countDocuments(), 0);
  assert.equal((await f.archive.status()).usedBytes, 0);
  assert.equal(store.objects.size, 1);
  await f.archive.putVerifiedObject(key, bytes);
  assert.equal(store.calls.uploads, 1);
  assert.equal((await f.archive.status()).usedBytes, bytes.length + 1024);
});

test('external readback precedes a real metadata transaction and failed admission never deletes the blob', { skip }, async t => {
  const f = await fixture(t), bytes = Buffer.from('retain after metadata failure'), key = hash(bytes) + '.gz';
  let fail = true;
  const db = { collection(name) {
    const collection = f.db.collection(name);
    return new Proxy(collection, { get(target, property) {
      if (name === 'driverAuditNativeFiles' && property === 'insertOne') return async (...args) => {
        assert(args[1].session.inTransaction());
        assert(f.store.objects.has(driverAuditSpacesArchivePrefix + key));
        if (fail) { fail = false; throw Error('Fictional metadata interruption'); }
        return target.insertOne(...args);
      };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
  const archive = createDriverAuditMongoArchive({ db, client, capacityBytes, objectStore: f.store });
  await assert.rejects(archive.putVerifiedObject(key, bytes), /metadata interruption/);
  assert.equal(await f.db.collection('driverAuditNativeFiles').countDocuments(), 0);
  assert.equal((await archive.status()).usedBytes, 0);
  assert.equal(f.store.objects.size, 1);
  await archive.putVerifiedObject(key, bytes);
  assert.equal(f.store.calls.uploads, 1);
  assert.equal((await archive.status()).usedBytes, bytes.length + 1024);
});

test('external identity is pinned before upload and competing configurations cannot write foreign blobs', { skip }, async t => {
  const f = await fixture(t), bytes = Buffer.from('same exact immutable bytes'), key = hash(bytes) + '.gz';
  const originalPut = f.store.putVerifiedObject;
  f.store.putVerifiedObject = async (...args) => {
    const pinned = await f.db.collection('driverAuditNativeControl').findOne({ _id: 'archive-object-store' });
    assert.equal(pinned.identitySha256, f.store.identitySha256);
    return originalPut(...args);
  };
  await f.archive.putVerifiedObject(key, bytes);
  const other = objectStore({ identitySha256: 'd'.repeat(64) });
  const foreign = createDriverAuditMongoArchive({ db: f.db, client, capacityBytes, objectStore: other });
  await assert.rejects(foreign.putVerifiedObject(key, bytes), /identity|reference|store differs/);
  await assert.rejects(foreign.readObject(key), /identity|reference|store differs/);
  assert.equal(other.calls.put, 0);
  assert.equal(other.objects.size, 0);
  const absent = createDriverAuditMongoArchive({ db: f.db, client, capacityBytes });
  await assert.rejects(absent.readObject(key), /external|Spaces|store/);
});

test('invalid external receipts, unavailable bodies and corrupt stored references fail without fallback', { skip }, async t => {
  for (const mutate of [ref => ({ ...ref }), ref => Object.freeze({ ...ref, size: ref.size + 1 }),
    ref => Object.freeze({ ...ref, identitySha256: 'e'.repeat(64) }),
    ref => Object.freeze({ ...ref, key: 'photos/arbitrary.gz' })]) {
    const f = await fixture(t, { store: objectStore({ reference: mutate }) });
    const bytes = Buffer.from('valid original'), key = hash(bytes) + '.gz';
    await assert.rejects(f.archive.putVerifiedObject(key, bytes), /reference|frozen/);
    assert.equal(await f.db.collection('driverAuditNativeFiles').countDocuments(), 0);
    assert.equal((await f.archive.status()).usedBytes, 0);
  }
  const f = await fixture(t), bytes = Buffer.from('another original'), key = hash(bytes) + '.gz';
  await f.archive.putVerifiedObject(key, bytes);
  f.store.objects.clear();
  await assert.rejects(f.archive.readObject(key), { code: 'storage_not_found' });
  await f.db.collection('driverAuditNativeFiles').updateOne({ _id: key },
    { $set: { 'externalReference.sha256': 'a'.repeat(64) } });
  await assert.rejects(f.archive.readObject(key), /reference|integrity/);
});

test('capacity races and cancellation never admit unpaid metadata or delete another producer object', { skip }, async t => {
  const f = await fixture(t, { capacityBytes: 2000 });
  const a = Buffer.alloc(700, 1), b = Buffer.alloc(700, 2);
  const results = await Promise.allSettled([f.archive.putVerifiedObject(hash(a) + '.gz', a),
    f.archive.putVerifiedObject(hash(b) + '.gz', b)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'AUDIT_CAPACITY');
  assert.equal(await f.db.collection('driverAuditNativeFiles').countDocuments(), 1);
  assert.equal((await f.archive.status()).usedBytes, 1724);
  assert.equal(f.store.calls.deletes, 0);
  const controller = new AbortController();
  const store = objectStore({ afterPut() { controller.abort(Error('Fictional cancellation after verified upload')); } });
  const cancelled = await fixture(t, { store });
  await assert.rejects(cancelled.archive.putVerifiedObject(hash(a) + '.gz', a, { signal: controller.signal }), /cancellation/);
  assert.equal(await cancelled.db.collection('driverAuditNativeFiles').countDocuments(), 0);
  assert.equal((await cancelled.archive.status()).usedBytes, 0);
  assert.equal(store.objects.size, 1);
});

test('real hybrid stores a verified original photo alias without copying or changing the existing upload', { skip }, async t => {
  const bytes = Buffer.from('fictional exact original Sidi photo'), key = hash(bytes) + '.gz';
  const photoKey = 'photos/delivery-fictional-preserved.jpg', objects = new Map([[photoKey, bytes]]), calls = [];
  const store = createDriverAuditSpacesArchive({
    env: { SPACES_KEY: 'fictional', SPACES_SECRET: 'fictional', SPACES_BUCKET: 'fictional-archive',
      SPACES_ENDPOINT: 'nyc3.digitaloceanspaces.com', SPACES_REGION: 'nyc3' },
    lookupExistingPhoto: () => ({ key: photoKey }),
    anonymousFetch: async url => {
      assert(!new URL(url).pathname.startsWith('/photos/'));
      return { status: 403, body: { async cancel() {} } };
    },
    client: { async send(command) {
      const name = command.constructor.name, input = command.input; calls.push({ name, input });
      const error = (code, status) => Object.assign(Error(code), { name: code, $metadata: { httpStatusCode: status } });
      if (name === 'GetBucketPolicyCommand') throw error('NoSuchBucketPolicy', 404);
      if (name === 'GetObjectAclCommand') return { Owner: { ID: 'fixture-owner' }, Grants: [
        { Grantee: { Type: 'CanonicalUser', ID: 'fixture-owner' }, Permission: 'FULL_CONTROL' }] };
      if (name === 'PutObjectCommand') {
        assert(input.Key.startsWith(driverAuditSpacesArchivePrefix));
        if (objects.has(input.Key)) throw error('PreconditionFailed', 412);
        objects.set(input.Key, Buffer.from(input.Body)); return {};
      }
      if (!objects.has(input.Key)) throw error('NoSuchKey', 404);
      const saved = objects.get(input.Key);
      return { ContentLength: saved.length, ETag: '"fictional-original-etag"',
        Body: (async function* () { yield saved; })() };
    } },
  });
  const f = await fixture(t, { store });
  await f.archive.putVerifiedObject(key, bytes);
  const original = await f.db.collection('driverAuditNativeFiles').findOne({ _id: key });
  assert.equal(original.externalReference.kind, 'existing-photo-v1');
  assert.equal(original.externalReference.key, photoKey);
  assert.equal((await f.archive.status()).usedBytes, bytes.length + 1024);
  assert.equal(await f.db.collection('driverAuditNativeChunks').countDocuments(), 0);
  assert(!objects.has(driverAuditSpacesArchivePrefix + key));
  assert.deepEqual(Buffer.concat(await f.archive.readObject(key)), bytes);
  assert(!calls.some(call => call.input.Key === photoKey && call.name !== 'GetObjectCommand'));
  objects.set(photoKey, Buffer.from('mutated current Sidi photo'));
  await assert.rejects(f.archive.readObject(key), /integrity/);
  assert.deepEqual(await f.db.collection('driverAuditNativeFiles').findOne({ _id: key }), original,
    'A failed historical alias read cannot silently relabel its reference');
  assert(!objects.has(driverAuditSpacesArchivePrefix + key));
});

test('real admission rechecks destination identity and rolls back cancellation during file insertion', { skip }, async t => {
  let f;
  const store = objectStore({ async afterPut() {
    await f.db.collection('driverAuditNativeControl').updateOne({ _id: 'archive-object-store' },
      { $set: { identitySha256: 'd'.repeat(64) } });
  } });
  f = await fixture(t, { store });
  const bytes = Buffer.from('fictional immutable original'), key = hash(bytes) + '.gz';
  await assert.rejects(f.archive.putVerifiedObject(key, bytes), /identity/);
  assert.equal(await f.db.collection('driverAuditNativeFiles').countDocuments(), 0);
  assert.equal((await f.archive.status()).usedBytes, 0);
  assert.equal(store.objects.size, 1);
  const g = await fixture(t), controller = new AbortController();
  const db = { collection(name) {
    const collection = g.db.collection(name);
    return new Proxy(collection, { get(target, property) {
      if (name === 'driverAuditNativeFiles' && property === 'insertOne') return async (...args) => {
        const result = await target.insertOne(...args);
        controller.abort(Error('Fictional cancellation inside metadata transaction')); return result;
      };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
  const archive = createDriverAuditMongoArchive({ db, client, capacityBytes, objectStore: g.store });
  await assert.rejects(archive.putVerifiedObject(key, bytes, { signal: controller.signal }), /cancellation/);
  assert.equal(await g.db.collection('driverAuditNativeFiles').countDocuments(), 0);
  assert.equal((await archive.status()).usedBytes, 0);
  assert.equal(g.store.objects.size, 1);
});

test('real hybrid rejects ambiguous metadata and an adapter returning bytes outside its verified reference', { skip }, async t => {
  const f = await fixture(t), bytes = Buffer.from('fictional original'), key = hash(bytes) + '.gz';
  await f.archive.putVerifiedObject(key, bytes);
  f.store.readBytes = async () => Buffer.alloc(bytes.length, 0);
  await assert.rejects(f.archive.readObject(key), /integrity/);
  await f.db.collection('driverAuditNativeFiles').updateOne({ _id: key }, { $set: {
    reference: { version: 1, size: bytes.length, sha256: hash(bytes), chunks: [] },
  } });
  await assert.rejects(f.archive.readObject(key), /ambiguous/);
  assert.equal(await f.db.collection('driverAuditNativeChunks').countDocuments(), 0);
});

test('optional source photo offers forward only to the strict app-owned facade without archive writes', { skip }, async t => {
  const f = await fixture(t), args = { sha256: 'a'.repeat(64), size: 123,
    url: 'https://fictional.example.invalid/photos/original.jpg' };
  assert.equal(f.archive.offerExistingPhotoCandidate, undefined);
  let called = 0;
  f.store.offerSourcePhotoCandidate = value => { called++; assert.deepEqual(value, args); return true; };
  const archive = createDriverAuditMongoArchive({ db: f.db, client, capacityBytes, objectStore: f.store });
  assert.equal(archive.offerExistingPhotoCandidate(args), true);
  assert.equal(called, 1);
  assert.equal(f.store.calls.put, 0);
  assert.equal(await f.db.collection('driverAuditNativeFiles').countDocuments(), 0);
  assert.equal(await f.db.collection('driverAuditNativeChunks').countDocuments(), 0);
  assert.equal(await f.db.collection('driverAuditNativeControl').countDocuments(), 0);
});
