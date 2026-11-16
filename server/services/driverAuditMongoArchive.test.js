import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { MongoClient } from 'mongodb';
import { createDriverAuditMongoArchive } from './driverAuditMongoArchive.js';
import { createDriverAuditMongoRpc, initializeDriverAuditMongoRpc } from './driverAuditMongoRpc.js';
import { driverAuditLocalReaderBudget } from './driverAuditDataBackend.js';
import { createCloudState } from '../vendor/driver-audits/integration/cloud/cloud-state.mjs';
import { createBudgetedAuditState } from '../vendor/driver-audits/integration/cloud/driver-audit-archive.mjs';
import { createBudgetedArchiveReader } from '../vendor/driver-audits/integration/cloud/budgeted-archive-reader.mjs';

const uri = process.env.MONGO_TEST_URI;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, capacityBytes = 32 * 1024 * 1024) {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db('driver_audit_native_test_' + randomUUID().replaceAll('-', ''));
  t.after(async () => { await db.dropDatabase(); await client.close(); });
  const archive = createDriverAuditMongoArchive({ db, client, capacityBytes });
  return { db, client, archive };
}

test('native archive reuses immutable chunks and verifies exact bytes after reconnecting', { skip: !uri }, async t => {
  const f = await fixture(t);
  const bytes = Buffer.concat([Buffer.alloc(4 * 1024 * 1024, 1), Buffer.from('original GPS and review evidence')]);
  const key = digest(bytes) + '.gz';
  const first = await f.archive.putVerifiedObject(key, bytes);
  assert.equal(first.verified, true);
  const before = await f.db.collection('driverAuditNativeControl').findOne({ _id: 'capacity' });
  await Promise.all(Array.from({ length: 3 }, () => f.archive.putVerifiedObject(key, bytes)));
  const after = await f.db.collection('driverAuditNativeControl').findOne({ _id: 'capacity' });
  assert.equal(after.usedBytes, before.usedBytes);
  assert.equal(await f.db.collection('driverAuditNativeChunks').countDocuments(), 2);
  const reopened = createDriverAuditMongoArchive({ db: f.db, client: f.client, capacityBytes: 32 * 1024 * 1024 });
  assert.deepEqual(Buffer.concat(await reopened.readObject(key, { maxBytes: bytes.length })), bytes);
  await assert.rejects(reopened.readObject(key, { maxBytes: bytes.length - 1 }), /limit/);
  await assert.rejects(reopened.putVerifiedObject(key, Buffer.from('replacement')), /binding/);
});

test('native quota rejects an incomplete import without storing a partial object', { skip: !uri }, async t => {
  const f = await fixture(t, 2048);
  const bytes = Buffer.alloc(2048, 2);
  await assert.rejects(f.archive.putVerifiedObject(digest(bytes) + '.gz', bytes), { code: 'AUDIT_CAPACITY' });
  assert.equal(await f.db.collection('driverAuditNativeFiles').countDocuments(), 0);
  assert.equal(await f.db.collection('driverAuditNativeChunks').countDocuments(), 0);
});

test('native state blobs participate in the caller transaction and reject corrupt stored evidence', { skip: !uri }, async t => {
  const f = await fixture(t);
  const bytes = Buffer.from('original state including verified GPS');
  const session = f.client.startSession();
  try {
    await assert.rejects(session.withTransaction(async () => {
      await f.archive.putBytes(bytes, { session });
      throw Error('Interrupted state commit');
    }), /Interrupted/);
  } finally { await session.endSession(); }
  assert.equal(await f.db.collection('driverAuditNativeChunks').countDocuments(), 0);
  const reference = await f.archive.putBytes(bytes);
  await f.db.collection('driverAuditNativeChunks').updateOne({ _id: reference.chunks[0].sha256 },
    { $set: { bytes: Buffer.from('corrupt') } });
  await assert.rejects(f.archive.readBytes(reference, { maxBytes: bytes.length }), /integrity/);
});

test('bounded native reads preserve exhausted external-transfer ledgers without writing new usage receipts', { skip: !uri }, async t => {
  const f = await fixture(t);
  await initializeDriverAuditMongoRpc({ db: f.db, client: f.client });
  const rpc = createDriverAuditMongoRpc({ db: f.db, client: f.client, objects: f.archive });
  const state = createCloudState({ rpc });
  const key = 'reader-budget';
  const body = '{"preservedOriginalLedger":"exhausted"}';
  await state.compareAndSwap({ key, expectedRevision: 0, eventId: 'native-ledger-fixture', body,
    event: '{"kind":"original-ledger"}' });
  const bytes = Buffer.from('Original saved photograph');
  const objectKey = digest(bytes) + '.gz';
  await f.archive.putVerifiedObject(objectKey, bytes);
  const before = await state.read(key);
  const receipts = await f.db.collection('driverAuditNativeReceipts').countDocuments();
  const reader = createBudgetedArchiveReader({ transport: f.archive, maxConcurrent: 4,
    budget: driverAuditLocalReaderBudget });
  assert.deepEqual(Buffer.concat(await reader.readObject(objectKey, { maxBytes: bytes.length })), bytes);
  const bounded = createBudgetedAuditState({ state, budgetState: state, responseLimit: 1024,
    budgetOverride: driverAuditLocalReaderBudget });
  assert.deepEqual(await bounded.read(key), before);
  assert.deepEqual(await bounded.read(key), before);
  const tooSmall = createBudgetedAuditState({ state, responseLimit: 1, budgetOverride: driverAuditLocalReaderBudget });
  await assert.rejects(tooSmall.read(key), /reader bound/);
  await assert.rejects(reader.readObject(objectKey, { maxBytes: bytes.length - 1 }), /limit|bound/);
  assert.deepEqual(await state.read(key), before);
  assert.equal(await f.db.collection('driverAuditNativeReceipts').countDocuments(), receipts);
});
