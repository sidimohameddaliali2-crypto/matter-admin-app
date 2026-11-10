import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import mongoose from 'mongoose';
import TruckoomGpsReceipt from '../models/TruckoomGpsReceipt.js';

const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_COMPRESSED_BYTES = 8 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const error = code => Object.assign(new Error(code), { code });

// Keep all fields on permitted source rows, including rejected coordinates and
// clocks. Do not archive other companies or request/authentication credentials.
export function scopedLiveGpsPayload(payload, companyName) {
  const rows = payload?.root?.VehicleData;
  if (!Array.isArray(rows)) return { shape: 'invalid_live_envelope', result: payload?.result ?? null };
  return { shape: 'account_scoped_live_rows', rows: rows.filter(row => row?.Company === companyName) };
}

export function scopedHistoryGpsPayload(payload, vehicleNo) {
  const rows = payload?.data;
  if (!Array.isArray(rows)) return { shape: 'invalid_history_envelope', result: payload?.result ?? null };
  const selected = rows.filter(row => String(row?.vehicleNumber).trim() === String(vehicleNo));
  return { shape: 'vehicle_scoped_history_rows', result: payload.result, rows: selected,
    excludedIdentityRows: rows.length - selected.length };
}

export function createGpsEvidenceStore({ store = TruckoomGpsReceipt,
  available = () => mongoose.connection.readyState === 1, newId = randomUUID } = {}) {
  return async function retainGpsResponse({ kind, scope, requestStartedAt, responseReceivedAt, payload }) {
    if (!available()) throw error('GPS_ARCHIVE_UNAVAILABLE');
    const started = new Date(requestStartedAt), received = new Date(responseReceivedAt);
    if (!['live', 'history'].includes(kind) || !Number.isFinite(+started)
      || !Number.isFinite(+received) || +started > +received) throw error('GPS_ARCHIVE_INVALID_RECEIPT');
    const bytes = Buffer.from(JSON.stringify(payload));
    if (bytes.length > MAX_JSON_BYTES) throw error('GPS_ARCHIVE_RESPONSE_TOO_LARGE');
    const compressed = gzipSync(bytes);
    if (compressed.length > MAX_COMPRESSED_BYTES) throw error('GPS_ARCHIVE_RESPONSE_TOO_LARGE');
    const receiptId = newId(), sha256 = digest(bytes);
    const document = { _id: receiptId, kind, scope, requestStartedAt: started,
      responseReceivedAt: received, payloadSha256: sha256, payloadBytes: bytes.length,
      encoding: 'gzip-json-v1', payload: compressed };
    // A single immutable document avoids a partially published multi-object
    // receipt. Unknown acknowledgements are not treated as successful captures.
    // Model.create uses save(), whose Mongoose option filter accepts wtimeout.
    await store.create([document], { writeConcern: { w: 'majority', j: true, wtimeout: 10000 } });
    return { receiptId, sha256, kind, responseReceivedAt: received.toISOString() };
  };
}

export function decodeGpsReceipt(receipt) {
  if (receipt.encoding !== 'gzip-json-v1' || receipt.payloadBytes > MAX_JSON_BYTES) throw error('GPS_ARCHIVE_INVALID_RECEIPT');
  // Lean/native Mongo reads return BSON Binary, while hydrated documents and
  // fixture inputs expose Buffer. Buffer.from(Binary) silently yields no bytes.
  const payload = receipt.payload?._bsontype === 'Binary'
    ? receipt.payload.value(true) : receipt.payload;
  const bytes = gunzipSync(Buffer.from(payload), { maxOutputLength: MAX_JSON_BYTES });
  if (bytes.length !== receipt.payloadBytes || digest(bytes) !== receipt.payloadSha256) throw error('GPS_ARCHIVE_HASH_MISMATCH');
  return JSON.parse(bytes);
}

export const retainGpsResponse = createGpsEvidenceStore();
