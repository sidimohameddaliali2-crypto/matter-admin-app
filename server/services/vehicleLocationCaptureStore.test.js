import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Batch from '../models/VehicleLocationCaptureBatch.js';
import {
  createVehicleLocationCaptureStore, captureTickId, captureObservationId,
  CAPTURE_MAX_BYTES, CAPTURE_MAX_ROWS,
} from './vehicleLocationCaptureStore.js';

const tick = new Date('2026-01-01T00:00:00Z');
const row = vehicleNo => ({ vehicleNo, latitude: 25, longitude: 55,
  gpsTime: new Date('2026-01-01T00:00:00Z'), recordedAt: tick, driver: null });
const clone = value => structuredClone(value);
const equal = (a, b) => a instanceof Date || b instanceof Date ? +new Date(a) === +new Date(b) : a === b;
function matches(doc, filter) {
  return Object.entries(filter).every(([key, condition]) => {
    const value = doc[key];
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      return Object.entries(condition).every(([operator, expected]) => {
        if (operator === '$exists') return (value !== undefined) === expected;
        if (operator === '$gt') return value > expected;
        if (operator === '$lte') return value <= expected;
        if (operator === '$in') return expected.some(item => equal(value, item));
        throw Error(`Fixture does not support ${operator}`);
      });
    }
    return equal(value, condition);
  });
}
function fixture() {
  let time = +tick, owner = 0, bulkFailure = null, completionFailure = false;
  const documents = new Map(), points = new Map(), writes = [];
  const apply = (doc, update, inserted = false) => {
    if (inserted) Object.assign(doc, clone(update.$setOnInsert || {}));
    Object.assign(doc, clone(update.$set || {}));
    for (const [key, increment] of Object.entries(update.$inc || {})) doc[key] = (doc[key] || 0) + increment;
    for (const key of Object.keys(update.$unset || {})) delete doc[key];
  };
  const find = (filter, sort) => [...documents.values()].filter(doc => matches(doc, filter)).sort((a, b) => {
    for (const [key, direction] of Object.entries(sort || {})) {
      if (a[key] < b[key]) return -direction;
      if (a[key] > b[key]) return direction;
    }
    return 0;
  })[0];
  const batches = {
    findOneAndUpdate: async (filter, update, options = {}) => {
      writes.push({ kind: 'batch', options });
      let doc = find(filter, options.sort);
      if (!doc && options.upsert) {
        if (documents.has(filter._id)) throw Object.assign(Error('duplicate'), { code: 11000 });
        doc = { _id: filter._id };apply(doc, update, true);documents.set(doc._id, doc);
      } else if (doc) apply(doc, update);
      return doc ? clone(doc) : null;
    },
    findOne: filter => ({ lean: async () => { const doc = find(filter);return doc ? clone(doc) : null; } }),
    updateOne: async (filter, update, options) => {
      writes.push({ kind: 'batch', options });
      const doc = find(filter);if (!doc) return { matchedCount: 0 };
      apply(doc, update);
      if (completionFailure && update.$set?.state === 'complete') throw Error('lost completion acknowledgement');
      return { matchedCount: 1 };
    },
  };
  const history = {
    bulkWrite: async (operations, options) => {
      writes.push({ kind: 'history', options });
      let applied = 0;
      for (const { updateOne } of operations) {
        const id = String(updateOne.filter._id);
        if (!points.has(id)) points.set(id, { ...updateOne.update.$setOnInsert });
        applied++;
        if (bulkFailure && applied >= bulkFailure.after) {
          if (bulkFailure.advance) time += bulkFailure.advance;
          throw Error('simulated acknowledgement/write failure');
        }
      }
      return { acknowledged: true };
    },
    countDocuments: async filter => filter._id.$in.filter(id => points.get(String(id))?.captureBatchId === filter.captureBatchId).length,
  };
  const options = { batches, history, clock: () => new Date(time), ownerId: () => `worker-${++owner}`, leaseMs: 1000, chunkSize: 2 };
  return { store: createVehicleLocationCaptureStore(options), createWorker: () => createVehicleLocationCaptureStore(options),
    documents, points, writes, setTime: next => { time = next; },
    failBulk: value => { bulkFailure = value; }, failCompletion: value => { completionFailure = value; }, batches, history };
}
const input = { rows: [row('V1'), row('V2'), row('V3')], summary: { fleetRows: 3 }, sourceReferences: [] };

test('one stable tick across workers, deterministic row IDs, acknowledged completion', async () => {
  const f = fixture(), a = f.store, b = f.createWorker();
  const [first, second] = await Promise.all([a.claimTick(tick), b.claimTick(tick)]);
  assert.ok(first);assert.equal(second, null);
  const saved = await a.saveBatch(first, input);
  const result = await a.persistBatch(saved);
  assert.equal(result.status, 'complete');assert.equal(result.storedRows, 3);
  assert.equal(f.points.size, 3);assert.equal(await b.claimTick(tick), null);
  assert.equal(String(captureObservationId(first.batchId, 0)), String(captureObservationId(first.batchId, 0)));
  assert.notEqual(String(captureObservationId(first.batchId, 0)), String(captureObservationId(first.batchId, 1)));
  assert.ok(f.writes.every(write => write.options.writeConcern.w === 'majority' && write.options.writeConcern.j === true));
});

test('partial insert survives restart and retries the exact payload once', async () => {
  const f = fixture(), lease = await f.store.saveBatch(await f.store.claimTick(tick), input);
  f.failBulk({ after: 1 });await assert.rejects(f.store.persistBatch(lease));
  assert.equal(f.points.size, 1);await f.store.release(lease, 'WRITE_FAILED');
  f.failBulk(null);const restarted = f.createWorker(), pending = await restarted.claimPending();
  assert.deepEqual(pending.payload.rows.map(p => p.vehicleNo), ['V1', 'V2', 'V3']);
  assert.equal((await restarted.persistBatch(pending)).storedRows, 3);assert.equal(f.points.size, 3);
});

test('lost bulk acknowledgement replays already saved rows without duplicates', async () => {
  const f = fixture(), lease = await f.store.saveBatch(await f.store.claimTick(tick), { ...input, rows: input.rows.slice(0, 2) });
  f.failBulk({ after: 2 });await assert.rejects(f.store.persistBatch(lease));
  assert.equal(f.points.size, 2);f.setTime(+tick + 1001);f.failBulk(null);
  const retry = await f.createWorker().claimPending();await f.store.persistBatch(retry);
  assert.equal(f.points.size, 2);
});

test('lost completion acknowledgement cannot reopen a complete batch', async () => {
  const f = fixture(), lease = await f.store.saveBatch(await f.store.claimTick(tick), input);
  f.failCompletion(true);await assert.rejects(f.store.persistBatch(lease));
  await f.store.release(lease, 'UNKNOWN_ACK');
  assert.equal(f.documents.get(lease.batchId).state, 'complete');assert.equal(await f.store.claimPending(), null);
});

test('stale owner cannot change payload, complete or release a newer lease', async () => {
  const f = fixture(), old = await f.store.saveBatch(await f.store.claimTick(tick), input);
  f.setTime(+tick + 1001);const newer = await f.createWorker().claimPending();assert.equal(newer.fence, old.fence + 1);
  await assert.rejects(f.store.persistBatch(old), { code: 'CAPTURE_LEASE_LOST' });
  await assert.rejects(f.store.saveBatch(old, input), { code: 'CAPTURE_LEASE_LOST' });
  await f.store.release(old, 'FAILED');assert.equal(f.documents.get(old.batchId).owner, newer.owner);
  assert.equal((await f.store.persistBatch(newer)).status, 'complete');
});

test('saved payload is immutable and repeated save is idempotent', async () => {
  const f = fixture(), lease = await f.store.claimTick(tick);
  await f.store.saveBatch(lease, input);await f.store.saveBatch(lease, input);
  await assert.rejects(f.store.saveBatch(lease, { ...input, rows: [row('OTHER')] }), { code: 'CAPTURE_PAYLOAD_CONFLICT' });
  f.documents.get(lease.batchId).payload.rows[0].vehicleNo = 'TAMPERED';
  await assert.rejects(f.store.persistBatch(lease), { code: 'CAPTURE_PAYLOAD_CHANGED' });assert.equal(f.points.size, 0);
});

test('expired unsaved tick becomes failed and is never refetched under the old tick', async () => {
  const f = fixture(), lease = await f.store.claimTick(tick);f.setTime(+tick + 1001);
  assert.equal(await f.store.claimTick(tick), null);assert.equal(f.documents.get(lease.batchId).state, 'failed');
  assert.equal(f.documents.get(lease.batchId).failureCode, 'CAPTURE_INTERRUPTED');
  assert.equal(await f.store.claimPending(), null);
  assert.ok(await f.store.claimTick(new Date(+tick + 1000)));
});

test('recovery seals abandoned unsaved polls even when their tick is never retried', async () => {
  const f = fixture(), lease = await f.store.claimTick(tick);f.setTime(+tick + 1001);
  assert.equal(await f.store.claimPending(), null);assert.equal(f.documents.get(lease.batchId).state, 'failed');
});

test('release preserves pending input and does not store sensitive error messages', async () => {
  const f = fixture(), lease = await f.store.claimTick(tick);
  await f.store.release(lease, 'private connection string');
  const batch = f.documents.get(lease.batchId);assert.equal(batch.state, 'failed');assert.equal(batch.failureCode, 'CAPTURE_FAILED');
  assert.equal(await f.store.claimTick(tick), null);
});

test('bounded payloads fail before saving and empty successful outcomes remain explicit', async () => {
  const f = fixture(), lease = await f.store.claimTick(tick);
  await assert.rejects(f.store.saveBatch(lease, { rows: Array(CAPTURE_MAX_ROWS + 1).fill(row('V1')) }), { code: 'CAPTURE_BATCH_TOO_LARGE' });
  await assert.rejects(f.store.saveBatch(lease, { rows: [], summary: { detail: 'x'.repeat(CAPTURE_MAX_BYTES) } }), { code: 'CAPTURE_BATCH_TOO_LARGE' });
  await assert.rejects(f.store.saveBatch(lease, { rows: [{ ...row('V1'), latitude: NaN }] }), { code: 'INVALID_CAPTURE_PAYLOAD' });
  await f.store.saveBatch(lease, { rows: [], summary: { fleetRows: 0, missingVehicles: 2 } });
  const result = await f.store.persistBatch(lease);assert.equal(result.storedRows, 0);assert.equal(result.missingVehicles, 2);
});

test('failed acknowledgement verification leaves the batch pending', async () => {
  const f = fixture(), lease = await f.store.saveBatch(await f.store.claimTick(tick), input);
  f.history.countDocuments = async () => 0;
  await assert.rejects(f.store.persistBatch(lease), { code: 'CAPTURE_ROWS_UNCONFIRMED' });
  assert.equal(f.documents.get(lease.batchId).state, 'pending');
});

test('invalid clocks and store options fail closed; model has no retention TTL', async () => {
  assert.throws(() => captureTickId(null), { code: 'INVALID_CAPTURE_CLOCK' });
  assert.throws(() => createVehicleLocationCaptureStore({ leaseMs: 0 }), { code: 'INVALID_CAPTURE_STORE_OPTIONS' });
  const f = fixture();await assert.rejects(f.store.claimTick(new Date(+tick + 1)), { code: 'FUTURE_CAPTURE_TICK' });
  const doc = new Batch({ _id: captureTickId(tick), tickAt: tick, state: 'collecting', fence: 1, createdAt: tick, updatedAt: tick });
  await doc.validate();assert.ok(Batch.schema.indexes().every(([, options]) => options.expireAfterSeconds === undefined));
  assert.ok(Batch.schema.indexes().some(([keys]) => JSON.stringify(keys) === JSON.stringify({ tickAt: 1 })));
  assert.ok(Batch.schema.indexes().some(([keys]) => JSON.stringify(keys) === JSON.stringify({ state: 1, leaseUntil: 1, tickAt: 1 })));
  assert.ok(captureObservationId('fixture', 0) instanceof mongoose.Types.ObjectId);
});

test('lease expiry during a write cannot complete a batch and recovery stays idempotent', async () => {
  const f = fixture(), lease = await f.store.saveBatch(await f.store.claimTick(tick), { ...input, rows: input.rows.slice(0, 2) });
  const bulkWrite = f.history.bulkWrite;
  f.history.bulkWrite = async (...args) => {
    await bulkWrite(...args);f.setTime(+tick + 1001);return { acknowledged: true };
  };
  await assert.rejects(f.store.persistBatch(lease), { code: 'CAPTURE_LEASE_LOST' });
  assert.equal(f.documents.get(lease.batchId).state, 'pending');assert.equal(f.points.size, 2);
  f.history.bulkWrite = bulkWrite;
  const recovered = await f.createWorker().claimPending();await f.store.persistBatch(recovered);
  assert.equal(f.points.size, 2);assert.equal(f.documents.get(lease.batchId).state, 'complete');
});

test('an unknown save acknowledgement recovers the retained immutable payload', async () => {
  const f = fixture(), lease = await f.store.claimTick(tick);
  const update = f.batches.findOneAndUpdate;let throwOnce = true;
  f.batches.findOneAndUpdate = async (...args) => {
    const result = await update(...args);
    if (throwOnce && args[1].$set?.payloadSha256) { throwOnce = false;throw Error('lost save acknowledgement'); }
    return result;
  };
  await assert.rejects(f.store.saveBatch(lease, input));
  await f.store.release(lease, 'UNKNOWN_ACK');
  const recovered = await f.createWorker().claimPending();assert.ok(recovered.payload);
  await f.store.persistBatch(recovered);assert.equal(f.points.size, 3);
});

test('history model casts durable row values without stripping batch provenance', async t => {
  const { default: History } = await import('../models/VehicleLocationHistory.js');
  let persisted;
  t.mock.method(History.collection, 'bulkWrite', (operations, _options, callback) => {
    persisted = operations[0].updateOne.update.$setOnInsert;
    callback(null, { acknowledged: true, matchedCount: 0, upsertedCount: 1 });
  });
  const id = captureObservationId('fixture-batch', 0);
  await History.bulkWrite([{ updateOne: { filter: { _id: id }, upsert: true,
    update: { $setOnInsert: { ...row('V1'), recordedAt: tick.toISOString(), gpsTime: null,
      captureBatchId: 'fixture-batch', captureRow: 0, speedKph: 0,
      sourceReceipt: { receiptId: 'fixture-receipt', sha256: 'a'.repeat(64), kind: 'live', responseReceivedAt: tick.toISOString() } } },
  } }]);
  assert.equal(persisted.captureBatchId, 'fixture-batch');assert.equal(persisted.captureRow, 0);
  assert.ok(persisted.recordedAt instanceof Date);assert.equal(persisted.gpsTime, null);
  assert.equal(persisted.speedKph, 0);assert.equal(persisted.sourceReceipt.receiptId, 'fixture-receipt');
});

test('recorder recovery uses retained rows without fetching a replacement fleet', async () => {
  const { createVehicleLocationRecorder } = await import('./vehicleLocationCapture.js');
  const f = fixture();let fleetReads = 0;
  const recorderOptions = { isConfigured: () => true, store: f.store, clock: () => tick,
    getFleet: async () => { fleetReads++;return [row('V1'), row('V2')]; }, getDrivers: async () => [] };
  f.failBulk({ after: 1 });const recorder = createVehicleLocationRecorder(recorderOptions);
  assert.equal((await recorder()).status, 'failed');assert.equal(f.points.size, 1);
  f.failBulk(null);
  const restarted = createVehicleLocationRecorder({ ...recorderOptions, store: f.createWorker() });
  assert.equal((await restarted()).status, 'already-claimed');assert.equal(f.points.size, 2);assert.equal(fleetReads, 1);
  assert.equal(f.documents.get(captureTickId(tick)).state, 'complete');
});
