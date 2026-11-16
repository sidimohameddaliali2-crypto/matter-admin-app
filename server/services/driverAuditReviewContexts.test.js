import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { MongoClient } from 'mongodb';
import { archiveBytes } from '../vendor/driver-audits/integration/cloud/repository.mjs';
import { createCloudReportService } from '../vendor/driver-audits/integration/cloud/report-service.mjs';
import { createDriverAuditMongoArchive } from './driverAuditMongoArchive.js';
import { importDriverAuditReviewContexts, createDriverAuditReviewContexts } from './driverAuditReviewContexts.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const uri = process.env.MONGO_TEST_URI;
const missing = () => { throw Object.assign(Error('Original path absent'), { code: 'ENOENT' }); };

test('old human review contexts survive a newer catalog with exact photo dependencies and explicit old gaps', { skip: !uri }, async t => {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db('driver_audit_context_test_' + randomUUID().replaceAll('-', ''));
  t.after(async () => { await db.dropDatabase(); await client.close(); });
  const archive = createDriverAuditMongoArchive({ db, client, capacityBytes: 16 * 1024 * 1024 });
  const importSha256 = sha('context-import');
  await db.collection('driverAuditNativeControl').insertOne({ _id: 'authority', status: 'staging', importSha256 });
  const snapshotHash = sha('original-human-report'), missingHash = sha('already-missing');
  const snapshot = { snapshotHash, rows: [{ key: 'original-issue', delivery: { gps: [25, 55] } }] };
  const manifest = await archiveBytes(archive, gzipSync(JSON.stringify(snapshot)), {
    domain: 'state', path: 'review-snapshots/' + snapshotHash + '.json.gz',
  });
  const photo = Buffer.from('original-photo'), photoHash = sha(photo);
  const photoManifest = await archiveBytes(archive, photo, { domain: 'objects', path: photoHash });
  const documents = [{ key: 'preview-gps-map-20261106:review-journal', body_text: JSON.stringify({
    records: { reportingReviews: [{ data: { snapshotHash } }, { data: { snapshotHash: missingHash } }] },
  }) }];
  const contexts = [
    { snapshotHash, availability: 'available', manifest, provenance: [{ scope: 'original-staff', catalogSha256: sha('catalog') }] },
    { snapshotHash: missingHash, availability: 'source-missing', provenance: [{ scope: 'original-staff', catalogSha256: sha('catalog') }] },
  ];
  const dependencies = [{ snapshotHash, files: [photoManifest] }, { snapshotHash: missingHash, files: [] }];
  await assert.rejects(importDriverAuditReviewContexts({ db, archive, documents, contexts: contexts.slice(0, 1), importSha256 }), /coverage/);
  const args = { db, archive, documents, contexts, dependencies, importSha256 };
  const first = await importDriverAuditReviewContexts(args);
  assert.equal(first.available, 1);
  assert.equal(first.sourceMissing, 1);
  const used = (await archive.status()).usedBytes;
  await importDriverAuditReviewContexts(args);
  assert.equal((await archive.status()).usedBytes, used);
  const reader = createDriverAuditReviewContexts({ db, archive });
  const current = { getHead: async () => ({ reportHash: sha('newer') }), readFile: missing, resolveFile: missing };
  const repository = reader.attach(current);
  const report = createCloudReportService({ repository, reviewStore: {}, identityStore: {} });
  assert.deepEqual(await report.snapshotFor(snapshotHash), snapshot);
  assert.deepEqual(await repository.readFile('objects', photoHash, { maxBytes: photo.length }), photo);
  await assert.rejects(report.snapshotFor(missingHash), { code: 'ENOENT' });
  await assert.rejects(repository.readFile('state', 'unrelated/private.json', { maxBytes: 100 }), { code: 'ENOENT' });
  await assert.rejects(repository.readFile('objects', photoHash, { maxBytes: 1 }), /Invalid retained manifest/);
  const corrupt = reader.attach({ ...current, readFile: async () => { throw Error('Original integrity failure'); } });
  await assert.rejects(corrupt.readFile('objects', photoHash, { maxBytes: 100 }), /Original integrity/);
  await assert.rejects(importDriverAuditReviewContexts({ ...args, contexts: contexts.map((row, i) => i ? row : {
    ...row, provenance: [{ scope: 'changed', catalogSha256: sha('changed') }],
  }) }), /differs/);
  assert.deepEqual(await importDriverAuditReviewContexts({ ...args, verifyOnly: true }), first);
  await db.collection('driverAuditNativeControl').updateOne({ _id: 'authority' }, { $set: { status: 'active' } });
  await assert.rejects(importDriverAuditReviewContexts(args), /authority changed/);
});
