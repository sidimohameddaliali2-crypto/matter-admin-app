import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { isDriverAuditTechnicalKey } from './driverAuditLiveImport.js';

export const driverAuditTechnicalRecoveryMs = 15 * 60_000;
const maxText = 32 * 1024 * 1024;
const partBytes = 4 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const binary = row => Buffer.isBuffer(row?.bytes) ? row.bytes : row?.bytes?.value?.(true);

// Only explicit technical keys enter this store. Its values are independently
// owned, so pruning a retry never removes an immutable evidence chunk.
export function createDriverAuditTechnicalState({ db, objects }) {
  const records = db.collection('driverAuditNativeTechnicalRecords');
  const chunks = db.collection('driverAuditNativeTechnicalChunks');
  const documents = db.collection('driverAuditNativeDocuments');
  const receipts = db.collection('driverAuditNativeReceipts');

  async function now(session) {
    const row = await db.collection('driverAuditNativeArchiveControl').aggregate([
      { $match: { _id: 'total' } }, { $project: { _id: 0, now: '$$NOW' } },
    ], { session }).next();
    if (!(row?.now instanceof Date)) throw Error('Native recovery clock is unavailable');
    return row.now;
  }

  function prepare({ key, revision, body, event = null }) {
    if (!isDriverAuditTechnicalKey(key) || !Number.isSafeInteger(revision) || revision < 1) {
      throw Error('Native recovery storage is restricted to technical state');
    }
    const recordId = hash(JSON.stringify([key, revision]));
    const parts = [];
    const references = {};
    for (const [field, text] of [['body', body], ['event', event]]) {
      if (text === null && field === 'event') continue;
      if (typeof text !== 'string' || Buffer.byteLength(text) > maxText) throw Error('Technical state exceeds its text bound');
      const plain = Buffer.from(text), packed = gzipSync(plain);
      const count = Math.ceil(packed.length / partBytes);
      references[field] = { version: 1, recordId, field, sha256: hash(plain),
        plainBytes: plain.length, packedBytes: packed.length, parts: count };
      for (let offset = 0, index = 0; offset < packed.length; offset += partBytes, index++) {
        parts.push({ _id: recordId + ':' + field + ':' + index, recordId,
          bytes: Buffer.from(packed.subarray(offset, offset + partBytes)) });
      }
    }
    const chargedBytes = parts.reduce((sum, part) => sum + part.bytes.length + 1024, 0)
      + 1024 + (event === null ? 0 : 1024);
    return { recordId, key, revision, references, parts, chargedBytes };
  }

  async function prune(session, time) {
    const expired = await records.find({ expires_at: { $lte: time } }, { session }).toArray();
    if (!expired.length) return;
    const heads = await documents.find({ _id: { $in: [...new Set(expired.map(row => row.key))] } }, { session }).toArray();
    const current = new Set(heads.map(row => row.body_control?.recordId).filter(Boolean));
    const remove = expired.filter(row => !current.has(row._id));
    if (!remove.length) return;
    const ids = remove.map(row => row._id);
    // Payload, retry receipt and quota are retired in the same transaction.
    await chunks.deleteMany({ recordId: { $in: ids } }, { session });
    await receipts.deleteMany({ technical: true, 'body_control.recordId': { $in: ids } }, { session });
    await records.deleteMany({ _id: { $in: ids } }, { session });
    await objects.releaseTechnicalBytes(remove.reduce((sum, row) => sum + row.chargedBytes, 0), { session });
  }

  async function store(prepared, session) {
    if (!session?.inTransaction()) throw Error('Native recovery needs its state transaction');
    const time = await now(session);
    // The caller has already selected the new head inside this transaction.
    await prune(session, time);
    await objects.reserveTechnicalBytes(prepared.chargedBytes, { session });
    await chunks.insertMany(prepared.parts, { session });
    await records.insertOne({ _id: prepared.recordId, key: prepared.key, revision: prepared.revision,
      chargedBytes: prepared.chargedBytes, created_at: time,
      expires_at: new Date(time.getTime() + driverAuditTechnicalRecoveryMs) }, { session });
  }

  async function read(reference, session) {
    if (reference?.version !== 1 || !/^[a-f0-9]{64}$/.test(reference.recordId || '')
        || !['body', 'event'].includes(reference.field) || !/^[a-f0-9]{64}$/.test(reference.sha256 || '')
        || !Number.isSafeInteger(reference.plainBytes) || reference.plainBytes < 0 || reference.plainBytes > maxText
        || !Number.isSafeInteger(reference.packedBytes) || reference.packedBytes < 1 || reference.packedBytes > maxText + 1024 * 1024
        || reference.parts !== Math.ceil(reference.packedBytes / partBytes)) {
      throw Error('Invalid native recovery reference');
    }
    const parts = [];
    for (let index = 0; index < reference.parts; index++) {
      const row = await chunks.findOne({ _id: reference.recordId + ':' + reference.field + ':' + index }, { session });
      const value = binary(row);
      if (!value || value.length !== Math.min(partBytes, reference.packedBytes - index * partBytes)) {
        throw Error('Native recovery payload is unavailable');
      }
      parts.push(value);
    }
    const bytes = gunzipSync(Buffer.concat(parts, reference.packedBytes), { maxOutputLength: maxText });
    if (bytes.length !== reference.plainBytes || hash(bytes) !== reference.sha256) throw Error('Native recovery text differs');
    return bytes.toString('utf8');
  }

  return { prepare, store, read };
}
