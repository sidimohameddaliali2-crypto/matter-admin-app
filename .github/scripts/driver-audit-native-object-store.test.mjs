import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { before, after, test } from 'node:test';
import { proposeNativeObjectStoreEnvironment, replaceNativeObjectStorePrivateFile, validateNativeObjectStoreStartupBaseline,
  readNativeObjectStorePrivateFile,
  measureNativeObjectStoreClusterHeadroom, nativeObjectStoreMongoLocationSha256,
  validateNativeObjectStoreLifecycle, readNativeObjectStoreRetention,
  captureNativeObjectStorePreingest, initialNativeExternalizationJournal, externalizeNativeArchive, runDriverAuditNativeObjectStore }
  from './driver-audit-native-object-store.mjs';
import { createDriverAuditMongoArchive } from '../../server/services/driverAuditMongoArchive.js';
import { validateDriverAuditSpacesArchiveReference } from '../../server/services/driverAuditSpacesArchive.js';
import { readDriverAuditPhotoCandidates } from '../../server/services/driverAuditNativeObjectStore.js';
import { acquireWorkerLock } from '../../server/vendor/driver-audits/integration/hosted/worker-lock.mjs';

const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { MongoClient, BSON } = require('mongodb'), dotenv = require('dotenv');
const hash = value => createHash('sha256').update(value).digest('hex'), json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const identitySha256 = hash(JSON.stringify({ version: 1, provider: 'spaces', endpoint: 'https://fra1.digitaloceanspaces.com',
  bucket: 'fixture-owned-bucket', prefix: 'driver-reports/archive/v1/' })), capacityBytes = 16 * 1024 ** 3;
const uri = process.env.MONGO_TEST_URI, skip = !uri; let client;
before(async () => { if (!uri) return;
  assert(/^mongodb:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?\//.test(uri), 'Object-store tests require an isolated localhost replica');
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 }); await client.connect(); });
after(async () => { await client?.close(); });

test('preparation preserves every original byte and parsed setting while changing only the two archive keys', () => {
  const before = Buffer.from('JWT_SECRET="fictional secret"\nDRIVER_AUDIT_DATA_STORE=supabase\nDRIVER_AUDIT_NATIVE_OBJECT_STORE=mongo\nOTHER="retain # literal"\n');
  const result = proposeNativeObjectStoreEnvironment({ base: Buffer.from('BASE=keep\n'), before, lookupSha256: 'a'.repeat(64), parse: dotenv.parse });
  assert(result.after.subarray(0, before.length).equals(before));
  assert.equal(result.values.JWT_SECRET, 'fictional secret'); assert.equal(result.values.OTHER, 'retain # literal');
  assert.equal(result.values.DRIVER_AUDIT_DATA_STORE, 'supabase'); assert.equal(result.values.DRIVER_AUDIT_NATIVE_OBJECT_STORE, 'spaces');
  assert.throws(() => proposeNativeObjectStoreEnvironment({ base: Buffer.alloc(0), before: Buffer.from('DRIVER_AUDIT_DATA_STORE=mongo\n'),
    lookupSha256: 'a'.repeat(64), parse: dotenv.parse }), /Supabase/);
});
test('startup proof rejects settings written after the actual API startup or an already selected native backend', () => {
  const snapshot = { apiStartedAtMs: Date.now() - 1000 };
  assert.doesNotThrow(() => validateNativeObjectStoreStartupBaseline({ snapshot, baseMtimeMs: 0, localMtimeMs: 0, values: {}, env: {} }));
  assert.throws(() => validateNativeObjectStoreStartupBaseline({ snapshot, baseMtimeMs: 0, localMtimeMs: Date.now(), values: {}, env: {} }), /startup/);
  assert.throws(() => validateNativeObjectStoreStartupBaseline({ snapshot, baseMtimeMs: 0, localMtimeMs: 0,
    values: { DRIVER_AUDIT_DATA_STORE: 'mongo' }, env: {} }), /Supabase/);
});
test('atomic environment and journal writes retain an intervening edit instead of overwriting it', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'object-store-cas-'))); t.after(() => fs.rm(root, { recursive: true }));
  const file = path.join(root, 'fixture.private.json'), before = Buffer.from('original'); await fs.writeFile(file, before, { mode: 0o600 });
  await assert.rejects(replaceNativeObjectStorePrivateFile(file, before, Buffer.from('planned'), () => fs.writeFile(file, 'concurrent edit')), /changed during/);
  assert.equal(await fs.readFile(file, 'utf8'), 'concurrent edit');
});
test('private control reads reject actual chmod at open/read boundaries and pathname replacement after reading', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'object-store-private-read-')));
  t.after(() => fs.rm(root, { recursive: true }));
  for (const kind of ['chmod-before-open', 'chmod-after-read', 'replace-after-read']) await t.test(kind, async () => {
    const file = path.join(root, kind + '.private.json'); await fs.writeFile(file, 'original private control', { mode: 0o600 });
    const originalOpen = fs.open;
    fs.open = async (name, ...args) => {
      if (name === file && kind === 'chmod-before-open') await fs.chmod(file, 0o666);
      const handle = await originalOpen(name, ...args);
      if (name === file && kind !== 'chmod-before-open') {
        const originalRead = handle.readFile;
        handle.readFile = async (...args) => {
          const bytes = await originalRead.apply(handle, args);
          if (kind === 'chmod-after-read') await fs.chmod(file, 0o666);
          else { const replacement = file + '.replacement'; await fs.writeFile(replacement, 'replacement private control', { mode: 0o600 }); await fs.rename(replacement, file); }
          return bytes;
        };
      }
      return handle;
    };
    try { await assert.rejects(readNativeObjectStorePrivateFile(file), /Private file changed/); }
    finally { fs.open = originalOpen; }
  });
});

test('retention proof accepts no policy, disabled expirations and unrelated cleanup without storing policy bodies', () => {
  const accepted = [[], [{ Status: 'Disabled', Expiration: { Days: 1 } }],
    [{ ID: 'private fixture policy identifier', Status: 'Enabled', Filter: { Prefix: 'temporary-transfer/' }, Expiration: { Days: 1 } }],
    [{ Status: 'Enabled', Filter: { Prefix: '' }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }]];
  for (const Rules of accepted) {
    const proof = validateNativeObjectStoreLifecycle({ Rules }, { identitySha256 });
    assert.equal(proof.verified, true); assert.equal(proof.relevantExpirationRules, 0);
    assert(!JSON.stringify(proof).includes('private fixture policy identifier')); assert(!Object.hasOwn(proof, 'Rules'));
  }
  const none = validateNativeObjectStoreLifecycle({}, { identitySha256, noConfiguration: true });
  assert.equal(none.configured, false); assert.equal(none.bucketConfigurationChanged, false);
  assert.equal(none.ownerDeletionOutsideApplicationNotPrevented, true);
  assert.throws(() => validateNativeObjectStoreLifecycle({}, { identitySha256 }), /bound/);
});
test('current and noncurrent expiration overlapping either retained prefix fail even with tag or size predicates', () => {
  const scopes = [{}, { Prefix: '' }, { Prefix: 'driver-reports/' }, { Filter: { Prefix: 'driver-reports/archive/v1/deep/' } },
    { Filter: { Prefix: 'photos/' } }, { Filter: { Tag: { Key: 'expire', Value: 'yes' } } },
    { Filter: { And: { Prefix: 'photos/', Tags: [{ Key: 'expire', Value: 'yes' }], ObjectSizeGreaterThan: 1024 } } }];
  for (const action of ['Expiration', 'NoncurrentVersionExpiration']) for (const scope of scopes)
    assert.throws(() => validateNativeObjectStoreLifecycle({ Rules: [{ Status: 'Enabled', ...scope, [action]: { Days: 1 } }] },
      { identitySha256 }), /expiration/);
  for (const rule of [{ Status: 'Unknown' }, { Status: 'Enabled', Filter: { UnknownPredicate: true } },
    { Status: 'Enabled', Prefix: 'safe/', Filter: { Prefix: 'photos/' } }, { Status: 'Enabled', FutureExpiration: { Days: 1 } }])
    assert.throws(() => validateNativeObjectStoreLifecycle({ Rules: [rule] }, { identitySha256 }));
});
test('retention uses only a bounded read against the bound destination; unsupported and ambiguous failures remain failures', async () => {
  const env = { SPACES_ENDPOINT: 'fra1.digitaloceanspaces.com', SPACES_REGION: 'fra1', SPACES_BUCKET: 'fixture-owned-bucket',
    SPACES_KEY: 'fixture-existing-key', SPACES_SECRET: 'fixture-existing-secret' };
  for (const kind of ['configured', 'missing', 'unsupported', 'wrong-bucket', 'auth']) {
    let sends = 0, destroyed = 0;
    class GetBucketLifecycleConfigurationCommand { constructor(input) { this.input = input; } }
    class S3Client { constructor(options) { assert.equal(options.credentials.accessKeyId, env.SPACES_KEY); }
      async send(command, options) { sends++; assert(command instanceof GetBucketLifecycleConfigurationCommand);
        assert.deepEqual(command.input, { Bucket: env.SPACES_BUCKET }); assert(options.abortSignal instanceof AbortSignal);
        if (kind === 'missing') throw Object.assign(Error('fixture secret'), { name: 'NoSuchLifecycleConfiguration' });
        if (kind === 'unsupported') throw Object.assign(Error('fixture secret'), { name: 'NotImplemented', $metadata: { httpStatusCode: 501 } });
        if (kind === 'wrong-bucket') throw Object.assign(Error('fixture secret'), { name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } });
        if (kind === 'auth') throw Object.assign(Error('fixture secret'), { name: 'AccessDenied' });
        return { Rules: [] }; }
      destroy() { destroyed++; }
    }
    const run = () => readNativeObjectStoreRetention({ env, identitySha256, S3Client, GetBucketLifecycleConfigurationCommand });
    if (['configured', 'missing'].includes(kind)) assert.equal((await run()).verified, true);
    else await assert.rejects(run(), error => !error.message.includes('fixture secret') && /unavailable or unsupported/.test(error.message));
    assert.equal(sends, 1); assert.equal(destroyed, 1);
    await assert.rejects(readNativeObjectStoreRetention({ env, identitySha256: '0'.repeat(64), S3Client, GetBucketLifecycleConfigurationCommand }), /identity differs/);
    assert.equal(sends, 1);
  }
});

function quotaFixture(options = {}) {
  const quota = { limitBytes: 5 * 1024 ** 3, basis: 'actual-provider-limit-error-5120-mib', evidenceSha256: hash('actual fixture quota error'),
    locationSha256: nativeObjectStoreMongoLocationSha256('mongodb+srv://fixture-user:private-password@fixture.example.invalid/test') };
  const names = ['admin', 'private-retained-database', 'test'], calls = []; let lists = 0, hellos = 0, active = 0, maximumActive = 0, clock = Date.now();
  const client = { db(name) { return { databaseName: name, async command(value) {
    calls.push({ name, value });
    assert.equal(value.maxTimeMS, 5000);
    if (value.hello) { hellos++; return { ok: 1, setName: options.datasourceDrift && hellos > 1 ? 'different-private-cluster' : 'fixture-private-cluster', hosts: ['private-host:27017'] }; }
    if (value.listDatabases) {
      assert.equal(name, 'admin'); assert.equal(value.authorizedDatabases, false); assert.equal(value.nameOnly, true); lists++;
      if (options.enumerationDenied) throw Object.assign(Error('private permission details'), { code: 13 });
      return { ok: 1, databases: (options.tooMany ? Array.from({ length: 65 }, (_, n) => 'db' + n) : options.censusDrift && lists > 1 ? [...names, 'new-private-database'] : names)
        .map(name => ({ name })), ...(options.partial ? { partialResultsReturned: true } : {}) };
    }
    assert.equal(value.dbStats, 1); assert.equal(value.scale, 1); active++; maximumActive = Math.max(active, maximumActive);
    try {
      await new Promise(resolve => setTimeout(resolve, 2));
      if (options.statsDenied && name === 'private-retained-database') throw Error('private stats denied');
      if (options.stale) clock += 21000;
      return { ok: 1, db: name, dataSize: name === 'private-retained-database' ? options.otherBytes ?? 2000 : 100,
        ...(options.missingSize && name === 'test' ? {} : { indexSize: 100 }) };
    } finally { active--; }
  } }; } };
  return { quota, calls, run: extra => measureNativeObjectStoreClusterHeadroom({ client, targetDatabase: 'test', quota,
    locationSha256: quota.locationSha256, now: () => clock, ...extra }), get active() { return active; }, get maximumActive() { return maximumActive; } };
}
test('cluster quota proof includes every enumerated database and binds the actual limit and datasource without raw names', async () => {
  const f = quotaFixture(), proof = await f.run();
  assert.equal(proof.verified, true); assert.equal(proof.allDatabasesEnumerated, true); assert.equal(proof.databaseCount, 3);
  assert.equal(proof.clusterUsedBytes, 2500); assert.equal(proof.clusterHeadroomBytes, 5 * 1024 ** 3 - 2500);
  assert(f.maximumActive <= 4); assert.equal(f.active, 0);
  for (const privateValue of ['private-retained-database', 'private-host', 'fixture.example.invalid', 'private-password'])
    assert(!JSON.stringify(proof).includes(privateValue));
  assert.equal(f.calls.filter(row => row.value.listDatabases).length, 2);
  const wrong = quotaFixture(); await assert.rejects(wrong.run({ locationSha256: '0'.repeat(64) }), /explicitly pinned/); assert.equal(wrong.calls.length, 0);
  await assert.rejects(wrong.run({ quota: { ...wrong.quota, limitBytes: 10 * 1024 ** 3 } }), /explicitly pinned/);
});
test('a mostly empty target cannot claim headroom when another database exhausts the same cluster quota', async () => {
  const f = quotaFixture({ otherBytes: 5 * 1024 ** 3 - 256 * 1024 ** 2 });
  await assert.rejects(f.run(), /Complete fresh cluster-wide quota proof unavailable/); assert.equal(f.active, 0);
});
test('quota sampling rejects incomplete privilege, unknown size, census/source drift, excess databases and stale samples', async t => {
  for (const flag of ['enumerationDenied', 'statsDenied', 'missingSize', 'censusDrift', 'datasourceDrift', 'tooMany', 'partial', 'stale']) await t.test(flag, async () => {
    const f = quotaFixture({ [flag]: true });
    await assert.rejects(f.run(), error => /Complete fresh cluster-wide quota proof unavailable/.test(error.message)
      && !error.message.includes('private'));
    assert.equal(f.active, 0); assert(f.maximumActive <= 4);
  });
});

async function fileStore(root) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 }); const aliases = new Map(); let gets = 0, puts = 0;
  const filename = key => path.join(root, key);
  return { identitySha256, aliases, get gets() { return gets; }, get puts() { return puts; },
    async assertPrivate() { return { provider: 'spaces', identitySha256, public: false }; },
    async readBytes(ref, { signal } = {}) { signal?.throwIfAborted(); gets++;
      validateDriverAuditSpacesArchiveReference(ref, { identitySha256 }); const bytes = await fs.readFile(filename(ref.key));
      assert.equal(bytes.length, ref.size); assert.equal(hash(bytes), ref.sha256); return bytes; },
    async putVerifiedObject(key, bytes, { signal } = {}) { signal?.throwIfAborted();
      const candidate = aliases.get(hash(bytes));
      const ref = candidate ? { version: 1, provider: 'spaces', identitySha256, key: candidate, size: bytes.length, sha256: hash(bytes),
        kind: 'existing-photo-v1', etag: '"' + hash(bytes) + '"', versionId: null }
        : { version: 1, provider: 'spaces', identitySha256, key: 'driver-reports/archive/v1/' + key, size: bytes.length, sha256: hash(bytes) };
      if (!candidate) {
        await fs.mkdir(path.dirname(filename(ref.key)), { recursive: true, mode: 0o700 });
        try { await fs.writeFile(filename(ref.key), bytes, { flag: 'wx', mode: 0o600 }); puts++; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      assert((await this.readBytes(ref, { signal })).equals(bytes)); return validateDriverAuditSpacesArchiveReference(ref, { key, bytes: bytes.length });
    }, async addAlias(bytes) {
      const key = 'photos/' + hash(bytes) + '.jpg'; await fs.mkdir(path.dirname(filename(key)), { recursive: true, mode: 0o700 });
      await fs.writeFile(filename(key), bytes, { mode: 0o600 }); aliases.set(hash(bytes), key); return filename(key);
    } };
}
async function fixture(t, { shared = false } = {}) {
  const db = client.db('driver_audit_externalize_' + randomUUID().replaceAll('-', ''));
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'object-store-fixture-')));
  t.after(async () => { await db.dropDatabase(); await fs.rm(root, { recursive: true }); });
  const archive = createDriverAuditMongoArchive({ db, client, capacityBytes }), store = await fileStore(path.join(root, 'provider'));
  const prefix = shared ? Buffer.alloc(4 * 1024 ** 2, 9) : Buffer.from('original-');
  const originals = [Buffer.concat([prefix, Buffer.from('A')]), Buffer.concat([prefix, Buffer.from('B')])];
  for (const bytes of originals) await archive.putVerifiedObject(hash(bytes) + '.gz', bytes);
  const standalone = await archive.putBytes(Buffer.from('original standalone data must remain'));
  await db.collection('driverAuditControl').insertOne({ _id: 'head', originalServingGeneration: 'original-report' });
  await db.collection('deliveries').insertOne({ _id: 'fixture-business-record', original: true });
  const capture = () => captureNativeObjectStorePreingest({ db, identitySha256, validateExternalReference: validateDriverAuditSpacesArchiveReference });
  const plan = { version: 1, kind: 'unused-native-archive-externalization-v1', targetDatabase: db.databaseName, identitySha256,
    implementationSha256: hash('pinned fixture provider with full file GET readback'), before: await capture() };
  let journal = initialNativeExternalizationJournal(hash(json(plan))), checkpoints = 0;
  const run = extra => externalizeNativeArchive({ db, client, archive, objectStore: store, validateExternalReference: validateDriverAuditSpacesArchiveReference,
    plan, journal, async saveJournal(value) { journal = value; checkpoints++; }, ...extra });
  return { db, root, store, archive, originals, plan, capture, run, standalone, get journal() { return journal; }, get checkpoints() { return checkpoints; } };
}
test('real Mongo/file-provider move preserves every object and business row, reuses existing photos and keeps one bounded journal', { skip }, async t => {
  const f = await fixture(t), photo = f.originals[0], alias = await f.store.addAlias(photo), prior = await fs.readFile(alias);
  const result = await f.run(); assert.equal(result.complete, true); assert.equal(result.objectsCompleted, 2);
  assert.equal(f.checkpoints, 1); assert.equal(f.store.puts, 1); assert((await fs.readFile(alias)).equals(prior));
  assert.equal(await f.db.collection('driverAuditNativeFiles').countDocuments({ externalReference: { $exists: true } }), 2);
  assert.equal(await f.db.collection('driverAuditNativeReceipts').countDocuments(), 0);
  assert.equal(await f.db.collection('deliveries').countDocuments({ original: true }), 1);
  assert.equal((await f.archive.readBytes(f.standalone)).toString(), 'original standalone data must remain');
  const refs = await f.db.collection('driverAuditNativeFiles').find().toArray();
  assert(refs.some(row => row.externalReference.kind === 'existing-photo-v1'));
  for (const row of refs) assert.equal(hash(await f.store.readBytes(row.externalReference)), row._id.slice(0, 64));
  const gets = f.store.gets; assert.equal((await f.run()).complete, true); assert.equal(f.store.gets, gets, 'Completed journal reuse must not reread the whole archive');
});
test('shared chunks survive until their last legacy owner moves and logical charge/refund matches exact remaining metadata', { skip }, async t => {
  const f = await fixture(t, { shared: true }), sharedSha = hash(Buffer.alloc(4 * 1024 ** 2, 9));
  const first = await f.run({ limits: { objects: 1 } }); assert.equal(first.complete, false); assert.equal(first.completedPrefixVerified, true);
  assert(await f.db.collection('driverAuditNativeChunks').findOne({ _id: sharedSha }));
  const second = await f.run(); assert.equal(second.complete, true); assert.equal(await f.db.collection('driverAuditNativeChunks').findOne({ _id: sharedSha }), null);
  const final = await f.capture(); assert.equal(final.capacity.usedBytes, second.nativeLogicalUsedBytes);
});
test('provider readback failure drains all admitted work and leaves original Mongo bytes and allocation intact', { skip }, async t => {
  const f = await fixture(t), before = await f.capture(); let active = 0;
  const store = { ...f.store, async putVerifiedObject() { active++; try { await new Promise(resolve => setTimeout(resolve, 10)); throw Error('fixture failed full GET readback'); } finally { active--; } } };
  await assert.rejects(f.run({ objectStore: store }), /failed full GET/); assert.equal(active, 0);
  assert.deepEqual(await f.capture(), before); assert.equal(f.checkpoints, 0);
});
test('a genuine reference or capacity race arriving after upload prevents the metadata swap', { skip }, async t => {
  for (const kind of ['genuine', 'capacity']) await t.test(kind, async t => {
    const f = await fixture(t), prior = await f.db.collection('driverAuditNativeFiles').find().toArray(); let injected = false;
    const store = { ...f.store, async putVerifiedObject(...args) {
      const result = await f.store.putVerifiedObject(...args);
      if (!injected) { injected = true;
        if (kind === 'genuine') await f.db.collection('driverAuditNativeDocuments').insertOne({ _id: 'original-genuine-head', body_text: '{"retain":true}' });
        else await f.db.collection('driverAuditNativeControl').updateOne({ _id: 'capacity' }, { $inc: { usedBytes: 1 } }); }
      return result;
    } };
    await assert.rejects(f.run({ objectStore: store }), /native reference|capacity changed/);
    assert.deepEqual(await f.db.collection('driverAuditNativeFiles').find().toArray(), prior);
    assert.equal(f.checkpoints, 0);
  });
});
test('Mongo failure after file CAS rolls back pointer, old chunks and capacity together', { skip }, async t => {
  const f = await fixture(t), before = await f.capture();
  const db = { databaseName: f.db.databaseName, listCollections: (...args) => f.db.listCollections(...args), collection(name) {
    const collection = f.db.collection(name); return new Proxy(collection, { get(target, key) {
      if (name === 'driverAuditNativeChunks' && key === 'deleteMany') return async () => { throw Error('fixture transaction deletion failure'); };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
  await assert.rejects(f.run({ db }), /transaction deletion failure/); assert.deepEqual(await f.capture(), before);
  assert.equal((await f.run()).complete, true);
});
test('commit-before-journal interruption recovers only that batch with full GET and never double-refunds', { skip }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.run({ async saveJournal() { throw Error('fixture checkpoint interruption'); } }), /checkpoint interruption/);
  assert.equal(f.journal.cursor, 0);
  const allocation = (await f.capture()).capacity.usedBytes, puts = f.store.puts;
  assert.equal((await f.run()).complete, true); assert.equal((await f.capture()).capacity.usedBytes, allocation);
  assert.equal(f.store.puts, puts);
});
test('a changed completed reference, unknown native collection or staging authority prevents resume', { skip }, async t => {
  const f = await fixture(t); await f.run({ limits: { objects: 1 } });
  await f.db.collection('driverAuditNativeControl').insertOne({ _id: 'authority', status: 'staging' });
  await assert.rejects(f.run(), /authority/); await f.db.collection('driverAuditNativeControl').deleteOne({ _id: 'authority' });
  await f.db.collection('driverAuditNativeUnknownReference').insertOne({ _id: 'protect' });
  await assert.rejects(f.run(), /native reference/); await f.db.collection('driverAuditNativeUnknownReference').deleteOne({ _id: 'protect' });
  const first = await f.db.collection('driverAuditNativeFiles').findOne({ externalReference: { $exists: true } });
  await f.db.collection('driverAuditNativeFiles').updateOne({ _id: first._id }, { $set: { 'externalReference.key': 'driver-reports/archive/v1/' + first._id.replace(/.$/, 'n') } });
  await assert.rejects(f.run());
});

async function hostFixture(t, options = {}) {
  const f = await fixture(t), appRoot = path.join(f.root, 'app'), server = path.join(appRoot, 'server');
  const sessionId = randomUUID(), folder = path.join(server, '.private/driver-audit-native-transfer', sessionId),
    syncRoot = path.join(server, '.private/driver-audits', 'f'.repeat(64));
  for (const root of [folder, syncRoot, path.join(server, 'services')]) await fs.mkdir(root, { recursive: true, mode: 0o700 });
  for (const name of ['driverAuditMongoArchive.js', 'driverAuditSpacesArchive.js', 'driverAuditNativeObjectStore.js']) {
    await fs.copyFile(new URL('../../server/services/' + name, import.meta.url), path.join(server, 'services', name));
  }
  const env = { MONGODB_URI: 'mongodb://127.0.0.1:1/test', JWT_SECRET: 'preserve-private-fixture',
    DRIVER_AUDIT_DATA_STORE: 'supabase', DRIVER_AUDIT_REPLICA_GC_ENABLED: '0',
    SPACES_ENDPOINT: 'fra1.digitaloceanspaces.com', SPACES_REGION: 'fra1', SPACES_BUCKET: 'fixture-owned-bucket',
    SPACES_KEY: 'fictional-private-key', SPACES_SECRET: 'fictional-private-secret' };
  const originalEnv = Buffer.from(Object.entries(env).map(([key, value]) => key + '=' + JSON.stringify(value)).join('\n') + '\n');
  const localFile = path.join(server, '.env.local'); await fs.writeFile(localFile, originalEnv, { mode: 0o600 });
  await fs.writeFile(path.join(server, '.env'), 'BASE_SETTING=unchanged\n', { mode: 0o600 });
  for (const file of [localFile, path.join(server, '.env')]) await fs.utimes(file, new Date('2020-01-01'), new Date('2020-01-01'));
  const lookup = { version: 1, kind: 'existing-photo-alias-lookup-candidates-v1', sourceMappingSha256: hash('original fixture mapping'),
    candidateOnly: true, existingObjectBytesVerified: false,
    expectedStorage: { endpoint: 'https://fra1.digitaloceanspaces.com', region: 'fra1', bucket: 'fixture-owned-bucket', keyPrefix: 'photos/' },
    entries: [{ sha256: hash(f.originals[0]), size: f.originals[0].length, keys: ['photos/original.jpg'] }] };
  const lookupBytes = json(lookup), template = { version: 1, kind: 'native-preingest-object-store-v1', targetDatabase: 'test', capacityBytes,
    lookupSha256: hash(lookupBytes), destinationIdentitySha256: options.wrongDestination ? '8'.repeat(64) : identitySha256,
    quota: { limitBytes: 5 * 1024 ** 3, basis: 'actual-provider-limit-error-5120-mib', evidenceSha256: hash('fictional provider quota error'),
      locationSha256: nativeObjectStoreMongoLocationSha256(env.MONGODB_URI) } };
  const templateBytes = json(template), inputs = [['lookup.private.json', lookupBytes], ['object-store-template.private.json', templateBytes]];
  for (const [name, bytes] of inputs) await fs.writeFile(path.join(folder, name), bytes, { mode: 0o600 });
  const state = { version: 1, sessionId, targetDatabase: 'test', capacityBytes, inventorySha256: hash('encrypted fixture transfer'), createdAt: Date.now() - 1000,
    plan: { inventorySha256: hash('encrypted fixture transfer'), objectCount: 2, objectBytes: inputs.reduce((sum, [, bytes]) => sum + bytes.length, 0) } };
  const received = { version: 1, sessionId, targetDatabase: 'test', status: 'transfer-received', verified: true, authorityChanged: false,
    inventorySha256: state.inventorySha256, objects: 2, bytes: state.plan.objectBytes, completedAt: new Date().toISOString(),
    inputFiles: inputs.map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: hash(bytes) })) };
  await fs.writeFile(path.join(folder, 'session.private.json'), json(state), { mode: 0o600 });
  await fs.writeFile(path.join(folder, 'received.private.json'), json(received), { mode: 0o600 });
  const processes = [{ name: 'matter-delivery-api', pm_id: 0, pid: process.pid,
    pm2_env: { status: 'online', pm_cwd: appRoot, pm_exec_path: '/usr/bin/npm', args: ['start', '--prefix', 'server'], pm_uptime: Date.now() - 1000 } },
  { name: 'matter-driver-audit-sync', pm_id: 1, pid: 0, pm2_env: { status: 'stopped', pm_cwd: server,
    pm_exec_path: path.join(server, 'scripts/driverAuditSync.js'), args: ['--config', path.join(syncRoot, 'sync.json')] } }];
  const db = { databaseName: 'test', collection: name => f.db.collection(name), listCollections: (...args) => f.db.listCollections(...args) };
  const quotaClient = { startSession: () => client.startSession(), db(name) { return { databaseName: name, async command(value) {
    if (value.hello) return { ok: 1, setName: 'fixture-private-cluster', hosts: ['fixture-private-host:27017'] };
    if (value.listDatabases) { assert.equal(name, 'admin'); assert.equal(value.authorizedDatabases, false); return { ok: 1, databases: [{ name: 'admin' }, { name: 'test' }] }; }
    assert.equal(value.dbStats, 1); assert.equal(value.scale, 1);
    if (name === 'admin') return { ok: 1, db: name, dataSize: 100, indexSize: 100 };
    assert.equal(name, 'test'); const result = await f.db.command(value);
    return { ...result, db: name, ...(options.lowHeadroom ? { dataSize: 5 * 1024 ** 3 - 100, indexSize: 0 } : {}) };
  } }; } };
  let privacyChecks = 0, retentionChecks = 0, apiRestartCalls = 0, closed = 0;
  const store = { ...f.store, async assertPrivate() { privacyChecks++;
    if (options.failAfterEnvironmentCommit && (await fs.readFile(localFile, 'utf8')).includes('DRIVER_AUDIT_NATIVE_OBJECT_STORE=spaces')) {
      if (options.nativeUseOnFailure === 'authority') await f.db.collection('driverAuditNativeControl').insertOne({ _id: 'authority', status: 'active' });
      if (options.nativeUseOnFailure === 'genuine') await f.db.collection('driverAuditNativeDocuments').insertOne({ _id: 'genuine-new-reference', original: true });
      throw Error('fixture provider failed after commit');
    }
    return f.store.assertPrivate(); } };
  const adapters = { platform: 'linux', env,
    async systemFile(file) { assert.equal(file, '/usr/bin/npm'); return { realpath: '/usr/lib/node_modules/npm/bin/npm-cli.js',
      isFile: true, uid: 0, mode: 0o100644, bytes: 100, sha256: hash('root-owned npm fixture') }; },
    async exec(command, args) {
      if (command === 'git') return { stdout: args[0] === 'rev-parse' ? 'a'.repeat(40) + '\n' : '' };
      if (command === 'pm2' && args[0] === 'jlist') return { stdout: JSON.stringify(processes) };
      apiRestartCalls++; throw Error('Unexpected process mutation');
    }, async load(name) {
      if (name === 'loadEnv.js') return {};
      if (name === 'node_modules/dotenv/lib/main.js') return { default: dotenv };
      if (name === 'vendor/driver-audits/integration/hosted/worker-lock.mjs') return { acquireWorkerLock };
      if (name === 'services/driverAuditSpacesArchive.js') return { validateDriverAuditSpacesArchiveReference };
      if (name === 'services/driverAuditMongoArchive.js') return { createDriverAuditMongoArchive };
      if (name === 'node_modules/@aws-sdk/client-s3/dist-cjs/index.js') return {
        GetBucketLifecycleConfigurationCommand: class { constructor(input) { this.input = input; } },
        S3Client: class { async send(command) {
          assert.deepEqual(command.input, { Bucket: env.SPACES_BUCKET }); retentionChecks++;
          return { Rules: options.expiringPhotos ? [{ Status: 'Enabled', Filter: { Prefix: 'photos/' }, Expiration: { Days: 1 } }] : [] };
        } destroy() {} } };
      if (name === 'services/driverAuditNativeObjectStore.js') return { createDriverAuditNativeObjectStore: async options => {
        await readDriverAuditPhotoCandidates({ env: options.env, root: options.photoCandidatesRoot }); return store;
      } };
      if (name === 'node_modules/mongoose/index.js') return { default: { createConnection: () => ({ db,
        getClient: () => quotaClient, asPromise: async () => {}, close: async () => { closed++;
          if (options.failCloseOnce && closed === 1) throw Error('fixture connection close failed'); } }) } };
      throw Error('Unexpected host module ' + name);
    } };
  const run = (operation = 'prepare-object-store', extra = {}) => runDriverAuditNativeObjectStore({ operation, sessionId,
    templateSha256: hash(templateBytes), expectedSha: 'a'.repeat(40), appRoot, ...extra }, adapters);
  return { ...f, appRoot, server, folder, env, originalEnv, localFile, lookupBytes, received, processes, adapters, run,
    get privacyChecks() { return privacyChecks; }, get retentionChecks() { return retentionChecks; },
    get apiRestartCalls() { return apiRestartCalls; }, get closed() { return closed; } };
}

test('host preparation installs exact private lookup, changes only two settings and never restarts or selects native data', { skip }, async t => {
  const f = await hostFixture(t), before = await f.capture(), result = await f.run();
  assert.equal(result.verified, true); assert.equal(result.reportingBackend, 'supabase'); assert.equal(f.apiRestartCalls, 0);
  assert.equal(result.retentionVerified, true); assert.match(result.retentionPolicySha256, /^[a-f0-9]{64}$/);
  const prep = JSON.parse(await fs.readFile(path.join(f.folder, 'object-store-preparation-plan.private.json')));
  assert.equal(prep.retention.verified, true); assert.deepEqual(prep.retention.retainedPrefixes, ['driver-reports/archive/v1/', 'photos/']);
  const actual = await fs.readFile(f.localFile); assert(actual.subarray(0, f.originalEnv.length).equals(f.originalEnv));
  assert.equal(dotenv.parse(actual).DRIVER_AUDIT_DATA_STORE, 'supabase');
  const lookupFile = path.join(f.server, '.private/driver-audit-native-photo-candidates', hash(f.lookupBytes) + '.json');
  assert((await fs.readFile(lookupFile)).equals(f.lookupBytes)); assert.equal((await fs.stat(lookupFile)).mode & 0o777, 0o600);
  assert.deepEqual(await f.capture(), before); assert.equal((await f.run()).preparationSha256, result.preparationSha256);
  assert((await fs.readFile(f.localFile)).equals(actual)); assert(f.closed >= 2);
});
test('host provider failure after setting commit rolls back only the exact original environment bytes', { skip }, async t => {
  const f = await hostFixture(t, { failAfterEnvironmentCommit: true });
  await assert.rejects(f.run(), /provider failed after commit/);
  assert((await fs.readFile(f.localFile)).equals(f.originalEnv)); assert.equal(f.apiRestartCalls, 0);
});
test('automatic rollback retains the prepared settings and failure evidence when authority or genuine use appears', { skip }, async t => {
  for (const nativeUseOnFailure of ['authority', 'genuine']) await t.test(nativeUseOnFailure, async t => {
    const f = await hostFixture(t, { failAfterEnvironmentCommit: true, nativeUseOnFailure });
    await assert.rejects(f.run(), error => error.phase === 'object-store-rollback-blocked');
    const values = dotenv.parse(await fs.readFile(f.localFile)); assert.equal(values.DRIVER_AUDIT_NATIVE_OBJECT_STORE, 'spaces');
    assert.equal(values.DRIVER_AUDIT_DATA_STORE, 'supabase'); assert.equal(f.apiRestartCalls, 0);
    const failure = JSON.parse(await fs.readFile(path.join(f.folder, 'object-store-preparation-failure.private.json')));
    assert.equal(failure.automaticRollbackApplied, false); assert.equal(failure.plannedAfterEnvironmentRetained, true);
    assert.equal((await fs.stat(path.join(f.folder, 'object-store-preparation-failure.private.json'))).mode & 0o777, 0o600);
    if (nativeUseOnFailure === 'authority') assert.equal((await f.db.collection('driverAuditNativeControl').findOne({ _id: 'authority' })).status, 'active');
    else assert.equal(await f.db.collection('driverAuditNativeDocuments').countDocuments({ original: true }), 1);
  });
});
test('recovery cannot forge two-key settings or redirect the immutable before/after filenames', { skip }, async t => {
  for (const kind of ['extra-setting', 'redirect-before', 'redirect-after']) await t.test(kind, async t => {
    const f = await hostFixture(t); await f.run(); await fs.writeFile(f.localFile, f.originalEnv);
    const prepFile = path.join(f.folder, 'object-store-preparation-plan.private.json'), prep = JSON.parse(await fs.readFile(prepFile));
    if (kind === 'extra-setting') {
      const file = path.join(f.folder, prep.rollback.afterFile), forged = Buffer.concat([await fs.readFile(file), Buffer.from('DRIVER_AUDIT_DATA_STORE=mongo\nUNRELATED_UNAPPROVED=1\n')]);
      await fs.writeFile(file, forged); prep.afterEnvironmentSha256 = hash(forged); prep.rollback.requireCurrentAfterSha256 = hash(forged);
    } else prep.rollback[kind === 'redirect-before' ? 'beforeFile' : 'afterFile'] = '../../outside.private.bin';
    await fs.writeFile(prepFile, json(prep));
    await assert.rejects(f.run(), /fixed original storage recovery|preserved storage preparation/);
    assert((await fs.readFile(f.localFile)).equals(f.originalEnv)); assert.equal(f.apiRestartCalls, 0);
  });
});
test('a database close error still releases every held lifecycle lock before retry', { skip }, async t => {
  const f = await hostFixture(t, { failCloseOnce: true });
  await assert.rejects(f.run(), /connection close failed/);
  assert.equal((await f.run()).verified, true); assert.equal(f.closed, 2);
});
test('wrong destination, headroom, receipt, worker, API executable or retention reject before settings change', { skip }, async t => {
  for (const kind of ['destination', 'headroom', 'receipt', 'source', 'api-args', 'npm-owner', 'expiry']) await t.test(kind, async t => {
    const f = await hostFixture(t, { wrongDestination: kind === 'destination', lowHeadroom: kind === 'headroom', expiringPhotos: kind === 'expiry' });
    if (kind === 'receipt') { f.received.completedAt = new Date(Date.now() + 100000).toISOString();
      await fs.writeFile(path.join(f.folder, 'received.private.json'), json(f.received), { mode: 0o600 }); }
    if (kind === 'source') f.processes.push({ name: 'matter-driver-audit-source', pm2_env: { status: 'stopped' } });
    if (kind === 'api-args') f.processes[0].pm2_env.args = ['run', 'different-script'];
    if (kind === 'npm-owner') { const original = f.adapters.systemFile; f.adapters.systemFile = async file => ({ ...await original(file), uid: 1000 }); }
    await assert.rejects(f.run()); assert((await fs.readFile(f.localFile)).equals(f.originalEnv));
    assert.equal(f.apiRestartCalls, 0);
  });
});
test('host externalization requires exact preparation and uses its independent immutable plan plus one current journal', { skip }, async t => {
  const f = await hostFixture(t), prepared = await f.run();
  await assert.rejects(f.run('externalize-native-archive', { profileSha256: '0'.repeat(64) }), /exact completed storage preparation/);
  const before = await f.capture(), planned = await f.run('externalize-native-archive', { profileSha256: prepared.preparationSha256 });
  assert.equal(planned.applyPending, true); assert.equal(planned.status, 'unused-native-archive-externalization-planned');
  assert.deepEqual(await f.capture(), before); assert.equal(f.store.puts, 0);
  const result = await f.run('externalize-native-archive', { profileSha256: planned.externalizationPlanSha256 });
  assert.equal(result.complete, true); assert.equal(result.authorityChanged, false); assert.equal(f.apiRestartCalls, 0);
  const names = await fs.readdir(f.folder);
  assert.equal(names.filter(name => name.includes('externalization-current')).length, 1);
  assert.equal(names.filter(name => name.includes('externalization-plan')).length, 1);
  assert.equal(names.filter(name => name.includes('receipt')).length, 0);
  assert.equal((await f.run('externalize-native-archive', { profileSha256: planned.externalizationPlanSha256 })).complete, true);
});

test('the existing manual bridge preserves the authentication diagnostic and routes both reviewed object-store operations', async () => {
  const workflow = await fs.readFile(new URL('../workflows/driver-audit-native-handoff.yml', import.meta.url), 'utf8');
  const bridge = await fs.readFile(new URL('./driver-audit-native-handoff.mjs', import.meta.url), 'utf8');
  for (const name of ['prepare-object-store', 'externalize-native-archive']) { assert(workflow.includes('- ' + name)); assert(bridge.includes("'" + name + "'")); }
  assert.match(workflow, /prepare-object-store\|externalize-native-archive\) operator=object-store/);
  assert.match(workflow, /inspect-database-config\) operator=database-check/);
  assert.match(bridge, /operator\.runDriverAuditNativeObjectStore\(common\)/);
  assert.match(bridge, /operator\.runDriverAuditNativeDatabaseCheck\(\{ \.\.\.common, recipientPublicKey \}\)/);
});
