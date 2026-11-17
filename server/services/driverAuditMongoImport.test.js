import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { MongoClient } from 'mongodb';
import { createDriverAuditMongoArchive } from './driverAuditMongoArchive.js';
import { createDriverAuditMongoRpc, initializeDriverAuditMongoRpc } from './driverAuditMongoRpc.js';
import { createDriverAuditDataBackend } from './driverAuditDataBackend.js';
import { activateDriverAuditMongoAuthority, importDriverAuditMongoDocuments, importDriverAuditMongoReceipts,
  verifyDriverAuditMongoAuthority } from './driverAuditMongoImport.js';

const uri = process.env.MONGO_TEST_URI;
const firstHash = 'a'.repeat(64);
const nextHash = 'b'.repeat(64);
const capacityBytes = 16 * 1024 * 1024;
const original = [
  { key: 'collector-state', revision: 1, body_text: '{"source":"original"}' },
  { key: 'review-journal', revision: 1, body_text: '{"originalReview":true}' },
];

function twoPhaseAuthorityFixture() {
  const now = Date.now(), hash = value => createHash('sha256').update(value).digest('hex');
  const sourceFence = { version: 2, mode: 'reporting-database-capability-v2', sourceProjectRef: 'trhhjfgfmxofxhnzocks',
    phase1ExecutionId: 'phase1-real', phase2ExecutionId: 'phase2-real', transactionId: '123457',
    admissionBlockedAt: new Date(now - 40 * 60000).toISOString(), dataWritesBlockedAt: new Date(now - 10 * 60000).toISOString(),
    commitObservedAt: new Date(now - 10 * 60000 + 1000).toISOString(), prePhase2DrainAt: new Date(now - 11 * 60000).toISOString(),
    initialCursor: new Date(Math.floor((now - 41 * 60000) / 60000) * 60000).toISOString(),
    backupAt: new Date(now - 2 * 60000).toISOString(), validUntil: new Date(now + 20 * 60000).toISOString() };
  for (const name of ['sourceReleaseSha256', 'sourceFenceSha256', 'capabilityAuditSha256', 'legacyRuntimeSha256', 'legacyEntrypointsSha256',
    'phase1ReceiptSha256', 'phase1SQLSha256', 'phase2ReceiptSha256', 'phase2SQLSha256', 'beforeCatalogSha256', 'afterCatalogSha256',
    'checkpointSha256', 'backupReceiptSha256', 'parityReceiptSha256']) sourceFence[name] = hash(name);
  let authority = { _id: 'authority', status: 'staging', importSha256: firstHash, writeFence: 1 }, updates = 0;
  const db = { collection(name) { assert.equal(name, 'driverAuditNativeControl'); return {
    async findOne() { return structuredClone(authority); },
    async updateOne(query, change) {
      const match = Object.entries(query).every(([key, value]) => key === '$expr'
        ? authority.writeFence === authority.verifiedWriteFence
        : value && typeof value === 'object' && '$exists' in value ? Object.hasOwn(authority, key) === value.$exists : authority[key] === value);
      if (!match) return { matchedCount: 0 };
      updates++; Object.assign(authority, change.$set);
      for (const key of Object.keys(change.$unset || {})) delete authority[key];
      return { matchedCount: 1 };
    },
  }; } };
  const verify = extra => verifyDriverAuditMongoAuthority({ db, original, importSha256: firstHash, sourceFence,
    rpc: async (_, { p_key }) => { const value = original.find(row => row.key === p_key); return { revision: value.revision, body_text: value.body_text }; },
    verifyResults: async () => ({ verified: true, resultsEqual: true, gpsEqual: true, photosEqual: true, reviewHistoryEqual: true }), ...extra });
  const fence = () => ({ mode: sourceFence.mode, sourceFence, oldWritersFenced: true, oldReviewsFenced: true, leasesDrained: true,
    backupAt: sourceFence.backupAt, validUntil: sourceFence.validUntil });
  return { db, sourceFence, verify, fence, row: () => authority, updates: () => updates };
}

test('two-phase authority binds the exact source origins to native parity and preserves the original admission time', async () => {
  const f = twoPhaseAuthorityFixture(), proof = await f.verify();
  assert.match(proof.sourceFenceSha256, /^[a-f0-9]{64}$/);
  assert.equal(f.row().verifiedSourceFenceSha256, proof.sourceFenceSha256);
  await activateDriverAuditMongoAuthority({ db: f.db, importSha256: firstHash, paritySha256: proof.paritySha256, fence: f.fence() });
  assert.equal(f.row().status, 'active');
  assert.equal(f.row().fence.sourceFence.admissionBlockedAt, f.sourceFence.admissionBlockedAt);
});

test('two-phase activation rejects origin drift, stale closure, a changed write fence and legacy downgrade', async t => {
  for (const reason of ['origins', 'expiry', 'write', 'legacy', 'backup', 'unbound']) await t.test(reason, async () => {
    const f = twoPhaseAuthorityFixture(), proof = await f.verify(reason === 'unbound' ? { sourceFence: undefined } : {});
    let fence = f.fence();
    if (reason === 'origins') f.sourceFence.phase2ReceiptSha256 = 'f'.repeat(64);
    if (reason === 'expiry') { f.sourceFence.validUntil = new Date(Date.parse(f.sourceFence.dataWritesBlockedAt) + 30 * 60000 + 1).toISOString(); fence = f.fence(); }
    if (reason === 'write') f.row().writeFence++;
    if (reason === 'legacy') fence = { oldWritersFenced: true, oldReviewsFenced: true, leasesDrained: true,
      stoppedAt: f.sourceFence.dataWritesBlockedAt, backupAt: f.sourceFence.backupAt, validUntil: f.sourceFence.validUntil };
    if (reason === 'backup') fence.backupAt = f.sourceFence.dataWritesBlockedAt;
    await assert.rejects(activateDriverAuditMongoAuthority({ db: f.db, importSha256: firstHash, paritySha256: proof.paritySha256, fence }));
    assert.equal(f.row().status, 'staging');
  });
});

async function fixture(t) {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db('driver_audit_import_test_' + randomUUID().replaceAll('-', ''));
  t.after(async () => { await db.dropDatabase(); await client.close(); });
  await initializeDriverAuditMongoRpc({ db, client });
  const objects = createDriverAuditMongoArchive({ db, client, capacityBytes });
  const rpc = createDriverAuditMongoRpc({ db, client, objects });
  return { db, client, objects, rpc };
}

test('a staged final delta resumes an interrupted import and keeps original revisions', { skip: !uri }, async t => {
  const f = await fixture(t);
  await importDriverAuditMongoDocuments({ ...f, documents: original, importSha256: firstHash });
  const next = original.map(row => ({ ...row, revision: 2, body_text: '{"originalAndNew":true}' }));
  const failAfterFirst = async function* () { yield next[0]; throw Error('Import interrupted'); };
  await assert.rejects(importDriverAuditMongoDocuments({
    ...f, documents: failAfterFirst(), importSha256: nextHash, previousImportSha256: firstHash,
  }), /interrupted/);
  await importDriverAuditMongoDocuments({
    ...f, documents: next, importSha256: nextHash, previousImportSha256: firstHash,
  });
  for (const row of next) assert.deepEqual(await f.rpc('matter_hosted_state_read', { p_key: row.key }),
    { revision: row.revision, body_text: row.body_text });
  await assert.rejects(importDriverAuditMongoDocuments({ ...f, documents: original, importSha256: nextHash }),
    /differs/);
});

test('packed original receipts preserve clocks and exact recovery bytes without repeating whole checkpoints', { skip: !uri }, async t => {
  const f = await fixture(t);
  await importDriverAuditMongoDocuments({ ...f, documents: original, importSha256: firstHash });
  const digest = text => createHash('sha256').update(text).digest('hex');
  const payload = randomBytes(256 * 1024).toString('hex');
  const rows = Array.from({ length: 70 }, (_, index) => {
    const body_text = JSON.stringify({ payload, revision: index + 1, originalText: 'دبي 😀' });
    return { key: 'original-packed-history', revision: index + 1, event_id: 'original-receipt-' + index,
      request_sha256: digest('original-request-' + index), body_sha256: digest(body_text), body_text,
      event_text: JSON.stringify({ originalEvent: index }), created_at: '2026-11-16T10:22:54.899341+00:00' };
  });
  const input = { ...f, receipts: rows, importSha256: firstHash };
  await importDriverAuditMongoReceipts(input);
  const used = (await f.objects.status()).usedBytes;
  assert.ok(used < 3 * 1024 * 1024, 'Repeated checkpoint history must fit the packed allowance');
  for (const row of rows) {
    const [saved] = await f.rpc('matter_hosted_state_receipts', { p_key: row.key, p_after: row.revision - 1, p_limit: 1 });
    for (const field of ['body_text', 'event_text', 'body_sha256', 'request_sha256', 'created_at']) {
      assert.equal(saved[field], row[field]);
    }
  }
  await importDriverAuditMongoReceipts(input);
  assert.equal((await f.objects.status()).usedBytes, used);
  await assert.rejects(importDriverAuditMongoReceipts({ ...input,
    receipts: [{ ...rows[0], created_at: '2026-11-16T10:22:54.899342+00:00' }] }), /differs/);
});

test('native activation requires exact preservation proof and a final fence for both review and collector writers',
  { skip: !uri }, async t => {
    const f = await fixture(t);
    await importDriverAuditMongoDocuments({ ...f, documents: original, importSha256: firstHash });
    const env = { DRIVER_AUDIT_DATA_STORE: 'mongo', DRIVER_AUDIT_NATIVE_CAPACITY_BYTES: String(capacityBytes),
      MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY: '/tmp/fictional-driver-report-cache' };
    await assert.rejects(createDriverAuditDataBackend({ db: f.db, env }), /verified native/);
    const proof = await verifyDriverAuditMongoAuthority({
      ...f, original, importSha256: firstHash,
      verifyResults: async () => ({
        verified: true, resultsEqual: true, gpsEqual: true, photosEqual: true, reviewHistoryEqual: true,
      }),
    });
    const now = Date.now();
    const fence = { oldWritersFenced: true, oldReviewsFenced: false, leasesDrained: true,
      stoppedAt: new Date(now - 2000).toISOString(), backupAt: new Date(now - 1000).toISOString(),
      validUntil: new Date(now + 120000).toISOString() };
    const request = { db: f.db, importSha256: firstHash, paritySha256: proof.paritySha256, fence };
    await assert.rejects(activateDriverAuditMongoAuthority(request), /review writers/);
    await assert.rejects(activateDriverAuditMongoAuthority({ ...request, fence: { ...fence, oldReviewsFenced: true },
      paritySha256: 'c'.repeat(64) }), /changed before activation/);
    await activateDriverAuditMongoAuthority({ ...request, fence: { ...fence, oldReviewsFenced: true } });
    assert.equal((await createDriverAuditDataBackend({ db: f.db, env })).kind, 'mongo');
    await assert.rejects(importDriverAuditMongoDocuments({ ...f, documents: original, importSha256: firstHash }),
      /already selected/);
  });

test('live imports preserve current budget attempts but refuse historical technical receipts', { skip: !uri }, async t => {
  const f = await fixture(t);
  const body_text = '{"spentMicros":123,"attempts":{"old":{"status":"uncertain","reservedMicros":456}}}';
  const documents = [{ key: 'photo-grading-budget', revision: 84, body_text }];
  await importDriverAuditMongoDocuments({ ...f, documents, importSha256: firstHash });
  assert.deepEqual(await f.rpc('matter_hosted_state_read', { p_key: documents[0].key }), { revision: 84, body_text });
  assert.equal(await f.db.collection('driverAuditNativeChunks').countDocuments(), 0);
  const digest = text => createHash('sha256').update(text).digest('hex');
  await assert.rejects(importDriverAuditMongoReceipts({ ...f, importSha256: firstHash, receipts: [{
    ...documents[0], event_id: 'old-budget-event', body_sha256: digest(body_text),
    request_sha256: digest('original'), event_text: '{"kind":"budget"}', created_at: '2026-11-16T10:00:00Z',
  }] }), /bookkeeping.*backup/i);
  assert.equal(await f.db.collection('driverAuditNativeReceipts').countDocuments(), 0);
});
