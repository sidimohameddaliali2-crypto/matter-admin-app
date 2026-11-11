import { createHash, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import VehicleLocationCaptureBatch from '../models/VehicleLocationCaptureBatch.js';
import VehicleLocationHistory from '../models/VehicleLocationHistory.js';

export const CAPTURE_MAX_ROWS = 2000;
export const CAPTURE_MAX_BYTES = 4 * 1024 * 1024;
const WRITE_OPTIONS = { writeConcern: { w: 'majority', j: true, wtimeoutMS: 10000 } };
const digest = value => createHash('sha256').update(value).digest('hex');
const failure = code => Object.assign(new Error(code), { code });
const safeCode = code => typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'CAPTURE_FAILED';
const asDate = value => {
  if (!(value instanceof Date) && !['string', 'number'].includes(typeof value)) throw failure('INVALID_CAPTURE_CLOCK');
  const date = new Date(value);
  if (!Number.isFinite(+date)) throw failure('INVALID_CAPTURE_CLOCK');
  return date;
};
const plain = value => value?.toObject ? value.toObject() : value;
const handle = batch => batch ? {
  batchId: batch._id, owner: batch.owner, fence: batch.fence,
  tickAt: batch.tickAt, payload: batch.payload,
} : null;

export function captureTickId(tickAt) {
  return `vehicle-location:${asDate(tickAt).toISOString()}`;
}

export function captureObservationId(batchId, rowIndex) {
  return new mongoose.Types.ObjectId(digest(`vehicle-location-observation-v1:${batchId}:${rowIndex}`).slice(0, 24));
}

// Only JSON data crosses the outbox boundary. Date/ObjectId JSON forms are
// restored by the history model; unsupported values fail rather than disappear.
function snapshot(value) {
  const bytes = JSON.stringify(value, (_key, item) => {
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol'
      || typeof item === 'number' && !Number.isFinite(item)) throw failure('INVALID_CAPTURE_PAYLOAD');
    return item;
  });
  if (typeof bytes !== 'string') throw failure('INVALID_CAPTURE_PAYLOAD');
  return JSON.parse(bytes);
}

function preparePayload(batchId, input) {
  if (!input || !Array.isArray(input.rows) || input.rows.length > CAPTURE_MAX_ROWS) throw failure('CAPTURE_BATCH_TOO_LARGE');
  const payload = snapshot({ rows: input.rows, summary: input.summary || {}, sourceReferences: input.sourceReferences || [] });
  payload.rows = payload.rows.map((row, captureRow) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw failure('INVALID_CAPTURE_PAYLOAD');
    const { _id: ignoredId, ...fields } = row;
    return { ...fields, captureBatchId: batchId, captureRow };
  });
  const bytes = JSON.stringify(payload);
  if (Buffer.byteLength(bytes) > CAPTURE_MAX_BYTES
    || mongoose.mongo.BSON.calculateObjectSize({ payload }) > CAPTURE_MAX_BYTES) throw failure('CAPTURE_BATCH_TOO_LARGE');
  return { payload, payloadSha256: digest(bytes) };
}

export function createVehicleLocationCaptureStore({
  batches = VehicleLocationCaptureBatch,
  history = VehicleLocationHistory,
  clock = () => new Date(),
  ownerId = randomUUID,
  leaseMs = 120000,
  chunkSize = 100,
} = {}) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000
    || !Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 500) throw failure('INVALID_CAPTURE_STORE_OPTIONS');
  const now = () => asDate(clock());
  const ownership = (lease, at = now()) => ({
    _id: lease.batchId, owner: lease.owner, fence: lease.fence,
    state: { $in: ['collecting', 'pending'] }, leaseUntil: { $gt: at },
  });

  async function claimTick(tickAt) {
    const at = now(), tick = asDate(tickAt), owner = ownerId();
    if (+tick > +at) throw failure('FUTURE_CAPTURE_TICK');
    const id = captureTickId(tick);
    let batch;
    try {
      batch = plain(await batches.findOneAndUpdate({ _id: id }, { $setOnInsert: {
        _id: id, tickAt: tick, state: 'collecting', owner, fence: 1,
        leaseUntil: new Date(+at + leaseMs), attempts: 1, createdAt: at, updatedAt: at,
      } }, { upsert: true, new: true, setDefaultsOnInsert: false, ...WRITE_OPTIONS }));
    } catch (error) {
      if (error.code !== 11000) throw error;
      return null;
    }
    if (batch?.owner === owner && batch.state === 'collecting') return handle(batch);
    // An interrupted, unsaved poll is an explicit failed tick. A later live
    // response must never be presented as the response to that original poll.
    await batches.updateOne({ _id: id, state: 'collecting', payloadSha256: { $exists: false }, leaseUntil: { $lte: at } }, {
      $set: { state: 'failed', failureCode: 'CAPTURE_INTERRUPTED', updatedAt: at },
    }, WRITE_OPTIONS);
    return null;
  }

  async function claimPending() {
    const at = now();
    // Seal at most one abandoned unsaved poll per call. Keep this bounded so
    // maintenance cannot starve the next scheduled live capture.
    await batches.findOneAndUpdate({ state: 'collecting', payloadSha256: { $exists: false }, leaseUntil: { $lte: at } }, {
      $set: { state: 'failed', failureCode: 'CAPTURE_INTERRUPTED', updatedAt: at },
    }, { sort: { tickAt: 1, _id: 1 }, new: true, ...WRITE_OPTIONS });
    return handle(plain(await batches.findOneAndUpdate({ state: 'pending', leaseUntil: { $lte: at } }, {
      $set: { owner: ownerId(), leaseUntil: new Date(+at + leaseMs), updatedAt: at },
      $inc: { fence: 1, attempts: 1 },
    }, { sort: { tickAt: 1, _id: 1 }, new: true, ...WRITE_OPTIONS })));
  }

  async function saveBatch(lease, input) {
    const at = now(), saved = preparePayload(lease.batchId, input);
    const batch = plain(await batches.findOneAndUpdate({ ...ownership(lease, at), payloadSha256: { $exists: false } }, {
      $set: { ...saved, state: 'pending', updatedAt: at },
    }, { new: true, ...WRITE_OPTIONS }));
    if (batch) return handle(batch);
    // A repeated save after an ambiguous acknowledgement may only reuse the
    // exact immutable payload already saved by this lease.
    const previous = await batches.findOne(ownership(lease)).lean();
    if (previous?.payloadSha256 === saved.payloadSha256) return handle(previous);
    throw failure(previous?.payloadSha256 ? 'CAPTURE_PAYLOAD_CONFLICT' : 'CAPTURE_LEASE_LOST');
  }

  async function renew(lease) {
    const at = now();
    const result = await batches.updateOne(ownership(lease, at), {
      $set: { leaseUntil: new Date(+at + leaseMs), updatedAt: at },
    }, WRITE_OPTIONS);
    if (result.matchedCount !== 1) throw failure('CAPTURE_LEASE_LOST');
  }

  async function persistBatch(lease) {
    const batch = await batches.findOne({ ...ownership(lease), state: 'pending' }).lean();
    if (!batch) throw failure('CAPTURE_LEASE_LOST');
    if (!batch.payload || digest(JSON.stringify(batch.payload)) !== batch.payloadSha256) throw failure('CAPTURE_PAYLOAD_CHANGED');
    const { rows } = batch.payload;
    for (let start = 0; start < rows.length; start += chunkSize) {
      await renew(lease);
      const chunk = rows.slice(start, start + chunkSize);
      const ids = chunk.map(row => captureObservationId(lease.batchId, row.captureRow));
      // Replaying a prefix after a partial/unknown acknowledgement cannot
      // duplicate rows. An expired worker can only insert the same immutable
      // batch rows; the fenced completion below still refuses its ownership.
      await history.bulkWrite(chunk.map((row, index) => ({ updateOne: {
        filter: { _id: ids[index] }, update: { $setOnInsert: { ...row, _id: ids[index] } }, upsert: true,
      } })), { ordered: false, ...WRITE_OPTIONS });
      const acknowledged = await history.countDocuments({ _id: { $in: ids }, captureBatchId: lease.batchId });
      if (acknowledged !== chunk.length) throw failure('CAPTURE_ROWS_UNCONFIRMED');
    }
    const at = now();
    const result = await batches.updateOne({ ...ownership(lease, at), state: 'pending', payloadSha256: batch.payloadSha256 }, {
      $set: { state: 'complete', completedAt: at, updatedAt: at },
      $unset: { failureCode: 1 },
    }, WRITE_OPTIONS);
    if (result.matchedCount !== 1) throw failure('CAPTURE_LEASE_LOST');
    return { ...batch.payload.summary, status: 'complete', batchId: lease.batchId, storedRows: rows.length };
  }

  async function release(lease, code) {
    const at = now();
    // Never release a newer owner's lease. A saved payload stays retryable;
    // an unsaved attempt remains an explicit failure rather than a fresh poll.
    const filter = { _id: lease.batchId, owner: lease.owner, fence: lease.fence, state: { $in: ['collecting', 'pending'] } };
    const batch = await batches.findOne(filter).lean();
    if (!batch) return;
    await batches.updateOne(filter, { $set: {
      state: batch.payloadSha256 ? 'pending' : 'failed',
      leaseUntil: at, updatedAt: at, failureCode: safeCode(code),
    } }, WRITE_OPTIONS);
  }

  return { claimTick, claimPending, saveBatch, persistBatch, release };
}
