import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { MongoClient } from 'mongodb';
import { createDriverAuditMongoArchive } from './driverAuditMongoArchive.js';
import { createDriverAuditMongoRpc, initializeDriverAuditMongoRpc } from './driverAuditMongoRpc.js';
import { createDriverAuditDataBackend } from './driverAuditDataBackend.js';
import { activateDriverAuditMongoAuthority, importDriverAuditMongoDocuments,
  verifyDriverAuditMongoAuthority } from './driverAuditMongoImport.js';

const uri = process.env.MONGO_TEST_URI;
const firstHash = 'a'.repeat(64);
const nextHash = 'b'.repeat(64);
const capacityBytes = 16 * 1024 * 1024;
const original = [
  { key: 'collector-state', revision: 1, body_text: '{"source":"original"}' },
  { key: 'review-journal', revision: 1, body_text: '{"originalReview":true}' },
];

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

test('native activation requires exact preservation proof and a final fence for both review and collector writers',
  { skip: !uri }, async t => {
    const f = await fixture(t);
    await importDriverAuditMongoDocuments({ ...f, documents: original, importSha256: firstHash });
    const env = { DRIVER_AUDIT_DATA_STORE: 'mongo', DRIVER_AUDIT_NATIVE_CAPACITY_BYTES: String(capacityBytes) };
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
