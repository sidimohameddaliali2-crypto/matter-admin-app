import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { BSON, MongoClient } from 'mongodb';
import { createDriverAuditDataBackend } from './driverAuditDataBackend.js';
import { createDriverAuditMongoArchive } from './driverAuditMongoArchive.js';
import { createDriverAuditMongoRpc } from './driverAuditMongoRpc.js';
import { createDriverAuditPollProgress } from './driverAuditPollProgress.js';

const uri = process.env.MONGO_TEST_URI;
const skip = !uri;
const hash = value => createHash('sha256').update(value).digest('hex');
const capacityBytes = 64 * 1024 * 1024;
let client;

before(async () => {
  if (!uri) return;
  assert(/^mongodb:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?\//.test(uri),
    'Polling progress tests require an isolated localhost replica set');
  client = new MongoClient(uri, { maxPoolSize: 8, serverSelectionTimeoutMS: 5000 });
  await client.connect();
});
after(async () => { await client?.close(); });

function delivery(index = 0) {
  return { version: 1, kind: 'native-delivery-poll-progress',
    schedule: { pending: [], lastDay: '2026-11-17', sourceAttempts: {}, lastAttempts: {}, observations: {}, gaps: [] },
    photoCursor: index, photoSourceHalt: null, lastPoll: null, lastSuccessfulPollAt: null, lastDataChangeAt: null };
}

function write(lease, expectedRevision, value = delivery(), key = 'native-progress:delivery') {
  const body = JSON.stringify(value), bodySha256 = hash(body);
  return { key, lease, expectedRevision, body,
    eventId: 'progress-' + hash(JSON.stringify([key, expectedRevision, bodySha256])),
    event: JSON.stringify({ kind: 'native-poll-progress', key, phase: 'schedule', bodySha256 }),
    request: JSON.stringify({ key, expectedRevision, bodySha256 }) };
}

async function fixture(t) {
  const db = client.db('driver_audit_progress_test_' + randomUUID().replaceAll('-', ''));
  t.after(async () => { await db.dropDatabase(); });
  const backend = await createDriverAuditDataBackend({ db, staging: true,
    env: { DRIVER_AUDIT_DATA_STORE: 'mongo', DRIVER_AUDIT_NATIVE_CAPACITY_BYTES: String(capacityBytes) } });
  const objects = createDriverAuditMongoArchive({ db, client, capacityBytes });
  const bytes = Buffer.from('fictional original photo/GPS object; retain exact bytes');
  await objects.putVerifiedObject(hash(bytes) + '.gz', bytes);
  await db.collection('driverAuditNativeDocuments').insertMany([
    { _id: 'collector-state', revision: 7, body_text: '{ "head": "original-report" }' },
    { _id: 'review-journal', revision: 3, body_text: '{ "originalReview": "retain" }' },
    { _id: 'photo-grading-budget', revision: 5, body_text: '{"uncertainAttempt":{"hold":123}}' },
  ]);
  const protectedSnapshot = async () => ({
    documents: hash(BSON.serialize({ rows: await db.collection('driverAuditNativeDocuments')
      .find({ _id: { $in: ['collector-state', 'review-journal', 'photo-grading-budget'] } }).sort({ _id: 1 }).toArray() })),
    files: hash(BSON.serialize({ rows: await db.collection('driverAuditNativeFiles').find().sort({ _id: 1 }).toArray() })),
    chunks: hash(BSON.serialize({ rows: await db.collection('driverAuditNativeChunks').find().sort({ _id: 1 }).toArray() })),
    protectedReceipts: await db.collection('driverAuditNativeReceipts').countDocuments({ technical: { $ne: true } }),
  });
  const ownerId = randomUUID(), lease = { ownerId,
    ...await backend.rpc('matter_hosted_lease_acquire', { p_owner: ownerId, p_ttl: 30 }) };
  return { db, objects, rpc: backend.rpc, progress: backend.pollProgress, lease, protectedSnapshot };
}

test('real native progress uses technical recovery without creating evidence or changing original heads', { skip }, async t => {
  const f = await fixture(t), before = await f.protectedSnapshot();
  for (let revision = 0; revision < 4; revision++) {
    const args = write(f.lease, revision, delivery(revision));
    const saved = await f.progress.compareAndSwap(args);
    assert.equal(saved.revision, revision + 1);
    assert.equal(saved.body_text, args.body);
  }
  const row = await f.db.collection('driverAuditNativeDocuments').findOne({ _id: 'native-progress:delivery' });
  assert(row.body_control);
  assert.equal(row.body_ref, undefined);
  assert.equal(await f.db.collection('driverAuditNativeTechnicalRecords').countDocuments({ key: row._id }), 4);
  assert.equal(await f.db.collection('driverAuditNativeReceipts').countDocuments({ key: row._id, technical: true }), 4);
  assert.deepEqual(await f.protectedSnapshot(), before);
  assert.deepEqual(await f.progress.read({ key: row._id }), { revision: 4, body: JSON.stringify(delivery(3)) });
});

test('real progress retries commit once and competing revisions have one winner', { skip }, async t => {
  const f = await fixture(t), before = await f.protectedSnapshot(), args = write(f.lease, 0);
  const replay = await Promise.all([f.progress.compareAndSwap(args), f.progress.compareAndSwap(args)]);
  assert.deepEqual(replay.map(row => row.replayed).sort(), [false, true]);
  const competing = await Promise.allSettled([f.progress.compareAndSwap(write(f.lease, 1, delivery(1))),
    f.progress.compareAndSwap(write(f.lease, 1, delivery(2)))]);
  assert.equal(competing.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(competing.find(row => row.status === 'rejected').reason.code, 'PT409');
  assert.equal(await f.db.collection('driverAuditNativeReceipts').countDocuments({ key: args.key }), 2);
  assert.deepEqual(await f.protectedSnapshot(), before);
});

test('real expired recovery pruning retains current heads and never deletes original evidence', { skip }, async t => {
  const f = await fixture(t), before = await f.protectedSnapshot();
  await f.progress.compareAndSwap(write(f.lease, 0));
  await f.db.collection('driverAuditNativeTechnicalRecords').updateMany({}, { $set: { expires_at: new Date(0) } });
  assert.equal((await f.progress.read({ key: 'native-progress:delivery' })).revision, 1,
    'The current progress head must survive its recovery expiry');
  const usedBefore = (await f.db.collection('driverAuditNativeControl').findOne({ _id: 'capacity' })).technicalBytes;
  await f.progress.compareAndSwap(write(f.lease, 1, delivery(1)));
  const current = await f.db.collection('driverAuditNativeDocuments').findOne({ _id: 'native-progress:delivery' });
  assert.equal(await f.db.collection('driverAuditNativeTechnicalRecords').countDocuments(), 1);
  assert.equal(await f.db.collection('driverAuditNativeReceipts').countDocuments({ key: current._id }), 1);
  assert.equal(await f.db.collection('driverAuditNativeReceipts').countDocuments({ key: current._id, revision: 1 }), 0);
  assert.equal(await f.db.collection('driverAuditNativeTechnicalChunks').countDocuments({ recordId: current.body_control.recordId }), 2);
  const capacity = await f.db.collection('driverAuditNativeControl').findOne({ _id: 'capacity' });
  assert(capacity.technicalBytes <= usedBefore + 64);
  assert(capacity.technicalBytes < 64 * 1024 * 1024);
  assert.deepEqual(await f.protectedSnapshot(), before);
  assert.equal((await f.progress.read({ key: current._id })).revision, 2);
});

test('real lease handoff after progress admission rejects the previous owner before any write', { skip }, async t => {
  const f = await fixture(t), before = await f.protectedSnapshot();
  let admit, resume;
  const admitted = new Promise(resolve => { admit = resolve; }), resumed = new Promise(resolve => { resume = resolve; });
  let pause = true;
  const db = { collection(name) {
    const collection = f.db.collection(name);
    if (name !== 'driverAuditNativeLeases') return collection;
    return new Proxy(collection, { get(target, property) {
      if (property === 'findOneAndUpdate') return async (...args) => {
        if (pause) { pause = false; admit(); await resumed; }
        return target.findOneAndUpdate(...args);
      };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
  const progress = createDriverAuditPollProgress({ rpc: createDriverAuditMongoRpc({ db, client, objects: f.objects }) });
  const stale = assert.rejects(progress.compareAndSwap(write(f.lease, 0)), { code: 'PT409' });
  try {
    await admitted;
    assert.equal(await f.rpc('matter_hosted_lease_release', { p_owner: f.lease.ownerId, p_token: f.lease.token }), true);
    const ownerId = randomUUID();
    const next = await f.rpc('matter_hosted_lease_acquire', { p_owner: ownerId, p_ttl: 30 });
    assert.notEqual(next.token, f.lease.token);
  } finally { resume(); }
  await stale;
  assert.equal((await f.progress.read({ key: 'native-progress:delivery' })).revision, 0);
  assert.equal(await f.db.collection('driverAuditNativeTechnicalRecords').countDocuments(), 0);
  assert.deepEqual(await f.protectedSnapshot(), before);
});

test('real lease expiry during progress persistence aborts metadata, receipt and quota together', { skip }, async t => {
  const f = await fixture(t), before = await f.protectedSnapshot();
  const expiry = Date.now() + 1500;
  await f.db.collection('driverAuditNativeLeases').updateOne({ _id: 'collector' }, { $set: { expires_at: new Date(expiry) } });
  let entered = 0;
  const objects = { ...f.objects, async reserveTechnicalBytes(bytes, options) {
    entered++; assert(Date.now() < expiry, 'The real persistence phase must start with a valid lease');
    await f.objects.reserveTechnicalBytes(bytes, options);
    await new Promise(resolve => setTimeout(resolve, Math.max(1, expiry - Date.now() + 50)));
  } };
  const progress = createDriverAuditPollProgress({ rpc: createDriverAuditMongoRpc({ db: f.db, client, objects }) });
  const priorCapacity = await f.db.collection('driverAuditNativeControl').findOne({ _id: 'capacity' });
  await assert.rejects(progress.compareAndSwap(write(f.lease, 0)), { code: 'PT409' });
  assert.equal(entered, 1);
  assert.equal((await f.progress.read({ key: 'native-progress:delivery' })).revision, 0);
  assert.equal(await f.db.collection('driverAuditNativeTechnicalRecords').countDocuments(), 0);
  assert.equal(await f.db.collection('driverAuditNativeTechnicalChunks').countDocuments(), 0);
  assert.equal(await f.db.collection('driverAuditNativeReceipts').countDocuments(), 0);
  assert.deepEqual(await f.db.collection('driverAuditNativeControl').findOne({ _id: 'capacity' }), priorCapacity);
  assert.deepEqual(await f.protectedSnapshot(), before);
});
