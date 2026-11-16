import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { packDriverAuditMongoTexts } from './driverAuditMongoText.js';
import { isDriverAuditTechnicalKey } from './driverAuditLiveImport.js';
import { createDriverAuditTechnicalState } from './driverAuditTechnicalState.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sha256 = /^[a-f0-9]{64}$/;
const keyPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/;
const writeConcern = { w: 'majority', j: true, wtimeoutMS: 10000 };
const transactionOptions = { readConcern: { level: 'snapshot' }, writeConcern, readPreference: 'primary' };

function requireImport(condition, message) {
  if (!condition) throw Error(message);
}

function checkedText(text) {
  requireImport(typeof text === 'string' && Buffer.byteLength(text) <= 32 * 1024 * 1024,
    'Invalid original reporting document');
  const value = JSON.parse(text);
  requireImport(value && typeof value === 'object' && !Array.isArray(value), 'Invalid original reporting JSON');
}

// Staging keeps original keys, revisions and receipts. Repeating a verified
// item reads it back. A differing revision or payload requires a fresh import.
export async function importDriverAuditMongoDocuments({ db, client, objects, documents, importSha256, previousImportSha256 }) {
  requireImport(sha256.test(importSha256 || ''), 'A pinned reporting import is required');
  const control = db.collection('driverAuditNativeControl');
  const heads = db.collection('driverAuditNativeDocuments');
  const technical = createDriverAuditTechnicalState({ db, objects });
  const previous = await control.findOne({ _id: 'authority' });
  const advance = previous?.status === 'staging' && sha256.test(previousImportSha256 || '')
    && previous.importSha256 === previousImportSha256 && previousImportSha256 !== importSha256;
  const allowForward = advance || previous?.status === 'staging' && previous.importSha256 === importSha256
    && sha256.test(previousImportSha256 || '') && previous.previousImportSha256 === previousImportSha256;
  requireImport(!previous || previous.status === 'staging' && (previous.importSha256 === importSha256 || advance),
    'The native reporting authority is already selected or another import is staged');
  await control.updateOne({ _id: 'authority' }, { $setOnInsert: {
    status: 'staging', importSha256, verified: false, oldWritersFenced: false,
  } }, { upsert: true, writeConcern });
  if (advance) {
    const changed = await control.updateOne({
      _id: 'authority', status: 'staging', importSha256: previousImportSha256, writeFence: previous.writeFence,
    }, {
      $set: { importSha256, previousImportSha256 },
      $inc: { writeFence: 1 },
      $unset: { paritySha256: '', verifiedWriteFence: '', verifiedAt: '' },
    }, { writeConcern });
    requireImport(changed.matchedCount === 1, 'The staged native import changed before the final delta');
  }
  let imported = 0;
  let reused = 0;
  const fingerprint = createHash('sha256');
  for await (const row of documents) {
    requireImport(keyPattern.test(row.key) && Number.isSafeInteger(row.revision) && row.revision > 0,
      'Invalid original reporting identity');
    checkedText(row.body_text);
    const bodySha256 = hash(row.body_text);
    const session = client.startSession();
    let existing = false;
    try {
      await session.withTransaction(async () => {
        const authority = await control.findOne({ _id: 'authority' }, { session });
        requireImport(authority?.status === 'staging' && authority.importSha256 === importSha256,
          'Native reporting import authority changed');
        // A writer touching this gate conflicts with a concurrent activation.
        await control.updateOne({ _id: 'authority' }, { $inc: { writeFence: 1 } }, { session });
        const prior = await heads.findOne({ _id: row.key }, { session });
        if (prior) {
          if (prior.revision === row.revision && prior.body_sha256 === bodySha256) {
            existing = true;
            return;
          }
          requireImport(allowForward && prior.revision < row.revision
            && prior.importedRevision === prior.revision && prior.importedBodySha256 === prior.body_sha256,
          'The native reporting document differs from the pinned original');
        }
        const recovery = isDriverAuditTechnicalKey(row.key)
          ? technical.prepare({ key: row.key, revision: row.revision, body: row.body_text }) : null;
        const payload = recovery ? { body_control: recovery.references.body }
          : { body_ref: await objects.putBytes(gzipSync(Buffer.from(row.body_text)), { session }) };
        const replacement = { revision: row.revision, body_sha256: bodySha256, ...payload,
          importedBy: importSha256, importedRevision: row.revision, importedBodySha256: bodySha256 };
        if (prior) await heads.updateOne({ _id: row.key, revision: prior.revision }, { $set: replacement,
          $unset: recovery ? { body_ref: '', body_text: '' } : { body_control: '', body_text: '' },
        }, { session });
        else await heads.insertOne({ _id: row.key, ...replacement }, { session });
        if (recovery) await technical.store(recovery, session);
      }, transactionOptions);
    } finally { await session.endSession(); }
    const saved = await heads.findOne({ _id: row.key });
    const actual = saved.body_control ? await technical.read(saved.body_control)
      : gunzipSync(await objects.readBytes(saved.body_ref, { maxBytes: 33 * 1024 * 1024 }),
        { maxOutputLength: 32 * 1024 * 1024 }).toString();
    requireImport(actual === row.body_text,
      'Original reporting document readback differs');
    fingerprint.update(JSON.stringify([row.key, row.revision, bodySha256]) + '\n');
    if (existing) reused++;
    else imported++;
  }
  return { verified: true, imported, reused, documents: imported + reused, sha256: fingerprint.digest('hex') };
}

export async function importDriverAuditMongoReceipts({ db, client, objects, receipts, importSha256, collectorRevisions = [] }) {
  requireImport(sha256.test(importSha256 || ''), 'A pinned receipt import is required');
  const stored = db.collection('driverAuditNativeReceipts');
  const control = db.collection('driverAuditNativeControl');
  let count = 0;
  async function commit(batch) {
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        const authority = await control.findOne({ _id: 'authority' }, { session });
        requireImport(authority?.status === 'staging' && authority.importSha256 === importSha256,
          'Native reporting import authority changed');
        await control.updateOne({ _id: 'authority' }, { $inc: { writeFence: 1 } }, { session });
        const fresh = [];
        for (const row of batch) {
          const body_sha256 = hash(row.body_text);
          const event_sha256 = hash(row.event_text);
          const prior = await stored.findOne({ key: row.key, revision: row.revision }, { session });
          if (prior) {
            requireImport(prior.event_id === row.event_id && prior.request_sha256 === row.request_sha256
              && prior.body_sha256 === body_sha256 && prior.event_sha256 === event_sha256
              && prior.created_at === row.created_at,
            'An original receipt differs from its existing native copy');
            continue;
          }
          fresh.push({ ...row, body_sha256, event_sha256 });
        }
        if (fresh.length) {
          const references = await packDriverAuditMongoTexts({ objects, session,
            texts: fresh.flatMap(row => [row.body_text, row.event_text]) });
          await stored.insertMany(fresh.map((row, index) => ({
            key: row.key, revision: row.revision, event_id: row.event_id, request_sha256: row.request_sha256,
            body_sha256: row.body_sha256, event_sha256: row.event_sha256,
            body_ref: references[index * 2], event_ref: references[index * 2 + 1],
            created_at: row.created_at, importedBy: importSha256,
          })), { session });
        }
      }, transactionOptions);
    } finally { await session.endSession(); }
  }
  let batch = [];
  let bytes = 0;
  for await (const row of receipts) {
    requireImport(!isDriverAuditTechnicalKey(row.key), 'Historical bookkeeping belongs in its verified backup');
    requireImport(row.key !== 'collector-state' || collectorRevisions.includes(row.revision),
      'Only required collector checkpoint receipts belong in the live import');
    requireImport(keyPattern.test(row.key) && Number.isSafeInteger(row.revision) && row.revision > 0
      && typeof row.event_id === 'string' && sha256.test(row.request_sha256),
    'Invalid original reporting receipt');
    checkedText(row.body_text);
    checkedText(row.event_text);
    requireImport(typeof row.created_at === 'string' && Number.isFinite(Date.parse(row.created_at)),
      'The original receipt creation clock is required');
    requireImport(hash(row.body_text) === row.body_sha256, 'Original receipt body hash differs');
    const size = Buffer.byteLength(row.body_text) + Buffer.byteLength(row.event_text);
    if (batch.length && (batch.length === 64 || bytes + size > 8 * 1024 * 1024)) {
      await commit(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(row);
    bytes += size;
    count++;
  }
  if (batch.length) await commit(batch);
  return { verified: true, receipts: count };
}

export async function importDriverAuditMongoHistorical({ db, client, objects, records, importSha256 }) {
  requireImport(sha256.test(importSha256 || ''), 'A pinned historical import is required');
  const allowed = new Set(['reporting.delivery', 'reporting.issue', 'reporting.retained_row',
    'reporting.run', 'review_private.response']);
  const collection = db.collection('driverAuditNativeHistorical');
  const control = db.collection('driverAuditNativeControl');
  const fingerprint = createHash('sha256');
  let count = 0;
  async function commit(batch) {
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        const authority = await control.findOne({ _id: 'authority' }, { session });
        requireImport(authority?.status === 'staging' && authority.importSha256 === importSha256,
          'The historical import authority changed');
        await control.updateOne({ _id: 'authority' }, { $inc: { writeFence: 1 } }, { session });
        for (const row of batch) {
          const rowSha256 = hash(row.body_text);
          const id = hash(JSON.stringify([row.namespace, rowSha256]));
          const prior = await collection.findOne({ _id: id }, { session });
          if (prior) {
            requireImport(prior.rowSha256 === rowSha256 && prior.namespace === row.namespace,
              'An original historical row differs');
            continue;
          }
          const body_ref = await objects.putBytes(gzipSync(Buffer.from(row.body_text)), { session });
          await collection.insertOne({ _id: id, namespace: row.namespace, rowSha256, body_ref,
            importedBy: importSha256 }, { session });
        }
      }, transactionOptions);
    } finally { await session.endSession(); }
  }
  let batch = [];
  let bytes = 0;
  for await (const row of records) {
    requireImport(allowed.has(row.namespace), 'Historical import is outside Driver Reports');
    checkedText(row.body_text);
    const size = Buffer.byteLength(row.body_text);
    if (batch.length && (batch.length === 32 || bytes + size > 8 * 1024 * 1024)) {
      await commit(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(row);
    bytes += size;
    fingerprint.update(JSON.stringify([row.namespace, hash(row.body_text)]) + '\n');
    count++;
  }
  if (batch.length) await commit(batch);
  return { verified: true, records: count, sha256: fingerprint.digest('hex') };
}

export async function verifyDriverAuditMongoAuthority({ db, rpc, original, importSha256, verifyResults }) {
  requireImport(typeof verifyResults === 'function', 'Saved result and GPS preservation verification is required');
  const control = db.collection('driverAuditNativeControl');
  const started = await control.findOne({ _id: 'authority' });
  requireImport(started?.status === 'staging' && started.importSha256 === importSha256,
    'The native import is unavailable');
  const fields = ['collector-state', 'review-journal'];
  for (const row of original) {
    requireImport(keyPattern.test(row.key), 'Invalid original state key');
    const saved = await rpc('matter_hosted_state_read', { p_key: row.key });
    requireImport(saved.revision === row.revision && saved.body_text === row.body_text,
      'The reporting data or review history differs from the original');
  }
  const keys = new Set(original.map(row => row.key));
  requireImport(fields.every(key => keys.has(key)), 'Original collector and review state are required');
  const result = await verifyResults();
  requireImport(result?.verified === true && result.resultsEqual === true && result.gpsEqual === true
    && result.reviewHistoryEqual === true && result.photosEqual === true,
  'The saved results, GPS, original photos or review history differ');
  const proof = { verified: true, importSha256, documents: original.length, result };
  const paritySha256 = hash(JSON.stringify(proof));
  const saved = await control.updateOne({
    _id: 'authority', status: 'staging', importSha256, writeFence: started.writeFence,
  }, { $set: { paritySha256, verifiedWriteFence: started.writeFence, verifiedAt: new Date() } }, { writeConcern });
  requireImport(saved.matchedCount === 1, 'The native import changed during verification');
  return { ...proof, paritySha256 };
}

export async function activateDriverAuditMongoAuthority({ db, importSha256, paritySha256, fence }) {
  requireImport(sha256.test(importSha256 || '') && sha256.test(paritySha256 || ''),
    'Pinned native import and preservation proofs are required');
  const now = Date.now();
  const stoppedAt = Date.parse(fence?.stoppedAt);
  const backupAt = Date.parse(fence?.backupAt);
  const validUntil = Date.parse(fence?.validUntil);
  requireImport(fence?.oldWritersFenced === true && fence?.oldReviewsFenced === true
    && fence?.leasesDrained === true && Number.isFinite(stoppedAt)
    && backupAt >= stoppedAt && backupAt <= now && validUntil > now && validUntil - stoppedAt <= 30 * 60_000,
  'The old collector and review writers need a fresh final backup and a verified fence');
  const result = await db.collection('driverAuditNativeControl').updateOne({
    _id: 'authority', status: 'staging', importSha256, paritySha256,
    $expr: { $eq: ['$writeFence', '$verifiedWriteFence'] },
  }, { $set: { status: 'active', verified: true, paritySha256, oldWritersFenced: true,
    oldReviewsFenced: true, activatedAt: new Date(), fence } }, { writeConcern });
  requireImport(result.matchedCount === 1, 'The native reporting import changed before activation');
  return { status: 'active', importSha256, paritySha256 };
}
