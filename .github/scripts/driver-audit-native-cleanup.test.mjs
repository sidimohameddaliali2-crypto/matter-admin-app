import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { parseNativeCleanupInventory, planNativeStagingCleanup, applyNativeStagingCleanup, runDriverAuditNativeCleanup }
  from './driver-audit-native-cleanup.mjs';
import { createDriverAuditMongoArchive } from '../../server/services/driverAuditMongoArchive.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { MongoClient } = require('mongodb');
const uri = process.env.MONGO_TEST_URI, skip = !uri;
let client;
before(async () => {
  if (!uri) return;
  assert(/^mongodb:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?\//.test(uri), 'Cleanup tests require an isolated localhost replica');
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 }); await client.connect();
});
after(async () => { await client?.close(); });
const bytes = Buffer.from(JSON.stringify({ key: 'a'.repeat(64) + '.gz', bytes: 1 }) + '\n');
function backupFor(inventoryBytes) {
  const rows = inventoryBytes.toString().trim().split('\n').map(JSON.parse);
  return { version: 1, kind: 'verified-original-cleanup-backup', verified: true, originalsPreserved: true,
    encryptedBackupPreserved: true, allCandidateOriginalBytesHashVerified: true, ciphertextAndSessionsPreserved: true,
    inventorySha256: hash(inventoryBytes), objects: rows.length, bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    locatorsSha256: hash('fictional retained locators'), originalPreservationProofSha256: hash('fictional byte proof') };
}
test('cleanup requires exact original inventory and preserved verified backup pins', () => {
  const backup = backupFor(bytes); assert.equal(parseNativeCleanupInventory(bytes, backup).length, 1);
  for (const change of [{ originalsPreserved: false }, { inventorySha256: hash('other') },
    { allCandidateOriginalBytesHashVerified: false }, { ciphertextAndSessionsPreserved: false }]) {
    assert.throws(() => parseNativeCleanupInventory(bytes, { ...backup, ...change }));
  }
  assert.throws(() => parseNativeCleanupInventory(Buffer.from(bytes.toString().repeat(2)), backupFor(Buffer.from(bytes.toString().repeat(2)))));
  const input = Buffer.from(JSON.stringify({ key: 'a'.repeat(64) + '.gz', bytes: 1, kind: 'input', name: 'source.private.json' }) + '\n');
  assert.throws(() => parseNativeCleanupInventory(input, backupFor(input)));
});
test('host cleanup refuses dirty tracked or untracked server helpers before loading any code or database', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cleanup-checkout-')));
  t.after(() => fs.rm(root, { recursive: true }));
  const request = { operation: 'plan-native-cleanup', sessionId: randomUUID(), templateSha256: hash('fictional template'),
    expectedSha: 'a'.repeat(40), appRoot: root };
  let loaded = 0;
  for (const dirty of ['tracked', 'untracked']) {
    const called = [];
    await assert.rejects(runDriverAuditNativeCleanup(request, { platform: 'linux', async exec(command, args) {
      called.push(args);
      if (args[0] === 'rev-parse') return { stdout: request.expectedSha + '\n' };
      if (args[0] === 'diff' && dirty === 'tracked') throw Error('fixture tracked helper differs');
      if (args[0] === 'ls-files') return { stdout: 'server/services/fictional-untracked-helper.js\n' };
      return { stdout: '' };
    }, load() { loaded++; throw Error('Host modules must remain unloaded'); } }), /tracked|Untracked/);
    assert(called.some(args => args[0] === 'diff' && args.includes('server')));
  }
  assert.equal(loaded, 0);
});

async function fixture(t) {
  const db = client.db('driver_audit_cleanup_' + randomUUID().replaceAll('-', ''));
  t.after(() => db.dropDatabase());
  const archive = createDriverAuditMongoArchive({ db, client, capacityBytes: 16 * 1024 ** 3 });
  const shared = Buffer.alloc(4 * 1024 ** 2, 7), a = Buffer.concat([shared, Buffer.from('A')]), b = Buffer.concat([shared, Buffer.from('B')]);
  const key = hash(a) + '.gz', keeper = hash(b) + '.gz';
  await archive.putVerifiedObject(key, a); await archive.putVerifiedObject(keeper, b);
  const standalone = await archive.putBytes(Buffer.from('fictional original anonymous reference; retain'));
  await db.collection('driverAuditControl').insertOne({ _id: 'head', head: { originalServing: true } });
  await db.collection('deliveries').insertOne({ _id: 'fictional-delivery', unchanged: true });
  const inventoryBytes = Buffer.from(JSON.stringify({ key, bytes: a.length }) + '\n'), backup = backupFor(inventoryBytes);
  const binding = { candidateSessionId: randomUUID(), templateSha256: hash('fictional reviewed template'), backupSha256: hash(JSON.stringify(backup)) };
  const plan = await planNativeStagingCleanup({ db, inventoryBytes, backup, binding });
  let intent;
  const apply = (extra = {}) => applyNativeStagingCleanup({ db, client, plan, inventoryBytes, backup,
    saveIntent(value) { if (intent) assert.deepEqual(value, intent); else intent = value; }, ...extra });
  return { db, archive, a, b, key, keeper, standalone, inventoryBytes, backup, binding, plan, apply, intent: () => intent };
}
test('real read-only plan checks metadata closure without rereading target bytes and retains shared chunks', { skip }, async t => {
  const f = await fixture(t), original = await f.db.collection('driverAuditNativeControl').findOne({ _id: 'capacity' });
  assert.equal(f.plan.selectedFiles.length, 1); assert.equal(f.plan.removeChunks.length, 1);
  assert.equal(f.plan.removeChunks[0].size, 1);
  assert.equal(f.plan.reclaimBytes, 1025);
  assert.deepEqual(await f.db.collection('driverAuditNativeControl').findOne({ _id: 'capacity' }), original);
  assert.equal(await f.db.collection('driverAuditNativeFiles').countDocuments(), 2);
  assert.equal(f.plan.targetBytesRead, false); assert.equal(f.plan.targetByteParityAsserted, false);
  let reads = 0;
  const wrapped = { databaseName: f.db.databaseName, listCollections: (...args) => f.db.listCollections(...args), collection(name) {
    const collection = f.db.collection(name);
    return new Proxy(collection, { get(target, key) {
      if (name === 'driverAuditNativeChunks' && key === 'find') return (query, options) => {
        assert.equal(options?.projection?.bytes, 0, 'Target binary payload reads are forbidden'); reads++; return target.find(query, options);
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
  assert.equal((await planNativeStagingCleanup({ ...f, db: wrapped })).targetBytesRead, false); assert(reads >= 2);
});
test('real cleanup changes only candidate files, proven orphan chunks and exact capacity', { skip }, async t => {
  const f = await fixture(t), head = await f.db.collection('driverAuditControl').findOne({ _id: 'head' });
  const result = await f.apply(); assert.equal(result.verified, true); assert(f.intent());
  assert.equal(await f.db.collection('driverAuditNativeFiles').findOne({ _id: f.key }), null);
  assert(Buffer.concat(await f.archive.readObject(f.keeper)).equals(f.b));
  assert.equal((await f.archive.readBytes(f.standalone)).toString(), 'fictional original anonymous reference; retain');
  assert.deepEqual(await f.db.collection('driverAuditControl').findOne({ _id: 'head' }), head);
  assert.equal(await f.db.collection('deliveries').countDocuments({ _id: 'fictional-delivery', unchanged: true }), 1);
  assert.equal((await f.db.collection('driverAuditNativeControl').findOne({ _id: 'capacity' })).usedBytes, f.plan.expectedUsedBytes);
  assert.equal(await f.db.collection('driverAuditNativeControl').findOne({ _id: 'authority' }), null);
});
test('any authority, genuine record, receipt, history, review or unknown native reference prevents deletion', { skip }, async t => {
  const f = await fixture(t);
  for (const status of ['staging', 'active']) {
    await f.db.collection('driverAuditNativeControl').insertOne({ _id: 'authority', status });
    await assert.rejects(f.apply(), /absent native authority/);
    await f.db.collection('driverAuditNativeControl').deleteOne({ _id: 'authority' });
  }
  for (const suffix of ['Documents', 'Receipts', 'Historical', 'ReviewContexts', 'ReviewFiles', 'UnknownReference']) {
    const collection = f.db.collection('driverAuditNative' + suffix); await collection.insertOne({ _id: 'fictional-original' });
    await assert.rejects(f.apply(), /blocks cleanup/); await collection.deleteOne({ _id: 'fictional-original' });
  }
  assert.equal(await f.db.collection('driverAuditNativeFiles').countDocuments(), 2); assert.equal(f.intent(), undefined);
});
test('changed native references, serving pointer and tampered deletion scopes fail closed', { skip }, async t => {
  const f = await fixture(t);
  const wrong = structuredClone(f.plan); wrong.selectedFiles.push(f.keeper);
  await assert.rejects(f.apply({ plan: wrong }), /outside its exact inventory/);
  await f.db.collection('driverAuditControl').updateOne({ _id: 'head' }, { $set: { changed: true } });
  await assert.rejects(f.apply(), /serving report pointer changed/);
  await f.db.collection('driverAuditControl').updateOne({ _id: 'head' }, { $unset: { changed: '' } });
  await f.db.collection('driverAuditNativeFiles').updateOne({ _id: f.keeper }, { $set: { 'reference.chunks.0.size': 1 } });
  await assert.rejects(f.apply(), /Invalid native file reference|changed native staging/);
  assert.equal(f.intent(), undefined);
});
test('new metadata fields or a changed candidate inside a deletion boundary are retained for review', { skip }, async t => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(f.apply({ async safety() {
    if (++calls === 2) await f.db.collection('driverAuditNativeFiles').updateOne({ _id: f.key }, { $set: { 'reference.storageBackend': 'fictional-new-reference' } });
  } }), /Invalid native file reference/);
  assert.equal(await f.db.collection('driverAuditNativeFiles').countDocuments({ _id: f.key }), 1);
  await f.db.collection('driverAuditNativeFiles').updateOne({ _id: f.key }, { $unset: { 'reference.storageBackend': '' } });
  await f.db.collection('driverAuditNativeFiles').updateOne({ _id: f.key }, { $set: { 'reference.chunks.0.originalReference': true } });
  await assert.rejects(f.apply(), /Invalid native file reference/);
});
test('a new unknown native reference collection at a deletion boundary prevents that deletion', { skip }, async t => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(f.apply({ async safety() {
    if (++calls === 2) await f.db.collection('driverAuditNativeNewReference').insertOne({ _id: 'fictional-retained-reference' });
  } }), /blocks cleanup/);
  assert.equal(await f.db.collection('driverAuditNativeFiles').countDocuments({ _id: f.key }), 1);
});
test('interruption after file deletion preserves conservative quota and retries only the original reviewed subset', { skip }, async t => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(f.apply({ safety() { if (++calls === 3) throw Error('fictional interrupted holder'); } }), /interrupted/);
  assert.equal(await f.db.collection('driverAuditNativeFiles').findOne({ _id: f.key }), null);
  assert.equal((await f.db.collection('driverAuditNativeControl').findOne({ _id: 'capacity' })).usedBytes, f.plan.before.capacity.usedBytes);
  assert(f.intent());
  assert.equal((await f.apply()).verified, true);
  assert.equal((await f.apply()).verified, true);
  assert(Buffer.concat(await f.archive.readObject(f.keeper)).equals(f.b));
});
test('quota-blocked refund happens after deletion commits and remains exactly recoverable', { skip }, async t => {
  const f = await fixture(t); let updateAttempts = 0;
  const wrapped = { databaseName: f.db.databaseName, listCollections: (...args) => f.db.listCollections(...args), collection(name) {
    const collection = f.db.collection(name);
    return new Proxy(collection, { get(target, key) {
      if (name === 'driverAuditNativeControl' && key === 'updateOne') return async (...args) => {
        updateAttempts++; assert.equal(await f.db.collection('driverAuditNativeChunks').countDocuments({ _id: f.plan.removeChunks[0]._id }), 0);
        throw Object.assign(Error('fictional Atlas quota update rejection'), { code: 8000 });
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
  await assert.rejects(f.apply({ db: wrapped }), { code: 8000 }); assert.equal(updateAttempts, 1);
  assert.equal(await f.db.collection('driverAuditNativeFiles').countDocuments({ _id: f.key }), 0);
  assert.equal((await f.db.collection('driverAuditNativeControl').findOne({ _id: 'capacity' })).usedBytes, f.plan.before.capacity.usedBytes);
  assert.equal((await f.apply()).nativeUsedBytes, f.plan.expectedUsedBytes);
});
test('native capacity drift or an active native lease blocks planning', { skip }, async t => {
  const f = await fixture(t);
  await f.db.collection('driverAuditNativeControl').updateOne({ _id: 'capacity' }, { $inc: { usedBytes: 1 } });
  await assert.rejects(planNativeStagingCleanup({ ...f }), /capacity is not the exact/);
  await f.db.collection('driverAuditNativeControl').updateOne({ _id: 'capacity' }, { $inc: { usedBytes: -1 } });
  await f.db.collection('driverAuditNativeLeases').insertOne({ _id: 'collector', expires_at: new Date(Date.now() + 100000) });
  await assert.rejects(planNativeStagingCleanup({ ...f }), /lease is active/);
});
test('an early refund cannot undercount chunks that still exist at a retry boundary', { skip }, async t => {
  const f = await fixture(t);
  await f.db.collection('driverAuditNativeControl').updateOne({ _id: 'capacity' }, { $set: { usedBytes: f.plan.expectedUsedBytes } });
  await assert.rejects(f.apply(), /never undercount/);
  assert.equal(await f.db.collection('driverAuditNativeFiles').countDocuments({ _id: f.key }), 1);
  assert.equal(f.intent(), undefined);
});
