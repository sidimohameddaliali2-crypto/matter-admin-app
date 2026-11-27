import { createHmac, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { ReportingCounter, ReportingOutbox } from '../models/ReportingOutbox.js';

const counterId = 'reporting-v1';
const batchSize = 10;
const sendTimeoutMs = 8_000;
const leaseMs = 30_000;
const tickMs = 5_000;
const receiptMaxBytes = 1024;
const majorityWriteConcern = { w: 'majority', wtimeout: 10_000 };
const workIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
let initialization;

export function reportingCaptureEnabled(env = process.env) {
  return env.MATTER_REPORTING_CAPTURE_ENABLED === '1';
}

export function reportingTransactionTopology(hello) {
  const topology = hello?.msg === 'isdbgrid' ? 'sharded'
    : typeof hello?.setName === 'string' && hello.setName.length > 0 ? 'replica_set' : 'unsupported';
  const minWireVersion = topology === 'sharded' ? 8 : 7;
  const supported = hello?.ok === 1 && topology !== 'unsupported'
    && Number.isFinite(hello.logicalSessionTimeoutMinutes) && hello.logicalSessionTimeoutMinutes > 0
    && Number.isSafeInteger(hello.maxWireVersion) && hello.maxWireVersion >= minWireVersion;
  return { topology, supported, writable: supported && hello.isWritablePrimary === true && hello.readOnly !== true };
}

export async function inspectReportingMongoTopology() {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
    return { topology: 'unavailable', supported: false, writable: false };
  }
  return reportingTransactionTopology(await mongoose.connection.db.admin().command({ hello: 1 }));
}

export async function readReportingWatermark(session) {
  const query = ReportingCounter.findById(counterId).read('primary');
  if (session) query.session(session);
  else query.readConcern('majority');
  const latest = (await query.lean())?.lastVersion ?? 0;
  if (!Number.isSafeInteger(latest) || latest < 0) throw new Error('Invalid reporting version');
  return latest;
}

async function initializeOutbox() {
  if (!initialization) {
    initialization = (async () => {
      const topology = await inspectReportingMongoTopology();
      if (!topology.writable) throw new Error('Writable MongoDB transaction topology is required for reporting capture');
      await Promise.all([ReportingCounter, ReportingOutbox].map(async model => {
        try { await model.createCollection(); }
        catch (error) { if (error.code !== 48) throw error; }
      }));
      await ReportingOutbox.createIndexes();
      try {
        await ReportingCounter.updateOne({ _id: counterId }, { $setOnInsert: { lastVersion: 0 } }, { upsert: true });
      } catch (error) {
        // Another app instance can initialize the same counter after startup.
        if (error.code !== 11000 || !await ReportingCounter.exists({ _id: counterId })) throw error;
      }
    })().catch(error => {
      initialization = undefined;
      throw error;
    });
  }
  return initialization;
}

export async function withReportingEvents(write) {
  if (!reportingCaptureEnabled()) return write(undefined, async () => {});
  await initializeOutbox();
  return mongoose.connection.transaction(async session => {
    async function enqueue(eventType, subjectIds, occurredAt) {
      const ids = [...new Set(subjectIds.map(String))];
      if (ids.length === 0) return;
      const result = await ReportingCounter.findOneAndUpdate({ _id: counterId },
        { $inc: { lastVersion: ids.length } }, { new: true, session }).lean();
      if (!Number.isSafeInteger(result?.lastVersion) || result.lastVersion < ids.length) {
        throw new Error('Reporting event sequence is unavailable');
      }
      const first = result.lastVersion - ids.length + 1;
      const eventClock = occurredAt ?? new Date();
      const events = ids.map((subjectId, index) => ({ eventType, subjectId, occurredAt: eventClock, sourceVersion: first + index }));
      await ReportingOutbox.insertMany(events, { session });
      return events;
    }
    return write(session, enqueue);
  }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
}

export async function recordReportingDeliveryChanges(session, enqueue, ids, collection) {
  if (!session || ids.length === 0) return;
  const events = await enqueue('delivery.changed', ids);
  // An internal source revision is evidence metadata. Keep the real business
  // updatedAt from the original write and bypass document hooks on this stamp.
  const result = await collection.bulkWrite(events.map(({ subjectId, sourceVersion }) => ({ updateOne: {
    filter: { _id: new mongoose.Types.ObjectId(subjectId) },
    update: { $set: { reportingVersion: sourceVersion } },
  } })), { session });
  if (result.matchedCount !== events.length) throw new Error('Reporting delivery version could not be recorded');
}

// For existing ordered updates with stable membership throughout the batch:
// ID-only assignments (including repeated IDs) or disjoint guarded updates.
export function bulkWriteReportingDeliveries(model, operations) {
  if (!reportingCaptureEnabled() || operations.length === 0) return model.bulkWrite(operations);
  return withReportingEvents(async (session, enqueue) => {
    const filters = operations.map(operation => {
      const filter = (operation.updateOne ?? operation.updateMany)?.filter;
      if (!filter?._id) throw new Error('Reporting bulk updates require an explicit delivery ID filter');
      return filter;
    });
    const matched = await model.find({ $or: filters }).session(session).select('_id').lean();
    const result = await model.bulkWrite(operations, { session });
    if (result.matchedCount < matched.length) throw new Error('Reporting bulk delivery membership changed');
    if (result.modifiedCount > 0) {
      await recordReportingDeliveryChanges(session, enqueue, matched.map(delivery => delivery._id), model.collection);
    }
    return result;
  });
}

export function updateReportingDelivery(model, id, update) {
  return withReportingEvents(async (session, enqueue) => {
    const delivery = await model.findByIdAndUpdate(id, update, { new: true, runValidators: true, session });
    if (delivery) {
      await recordReportingDeliveryChanges(session, enqueue, [delivery._id], model.collection);
      if (session) delivery.$session(null);
    }
    return delivery;
  });
}

export async function saveReportingDelivery(delivery) {
  if (!reportingCaptureEnabled()) return delivery.save();
  const originalSession = delivery.$session();
  try {
    return await withReportingEvents(async (session, enqueue) => {
      const saved = await delivery.save({ session });
      await recordReportingDeliveryChanges(session, enqueue, [delivery._id], delivery.constructor.collection);
      return saved;
    });
  } finally {
    delivery.$session(originalSession);
  }
}

export function reportingEnvelope(row) {
  return {
    eventId: 'reporting-v1:' + row.sourceVersion,
    eventType: row.eventType,
    subjectId: row.subjectId,
    sourceVersion: row.sourceVersion,
    occurredAt: row.occurredAt.toISOString(),
  };
}

export function signReportingEvent(row, signingSecret, now = new Date()) {
  const body = JSON.stringify(reportingEnvelope(row));
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const digest = createHmac('sha256', signingSecret).update(timestamp + '.').update(body).digest('hex');
  return { body, headers: {
    'content-type': 'application/json',
    'x-matter-timestamp': timestamp,
    'x-matter-signature': 'sha256=' + digest,
  } };
}

function intQuery(value, name, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)
      || !Number.isSafeInteger(Number(value)) || Number(value) > max) {
    throw Object.assign(new Error('Invalid ' + name), { statusCode: 400 });
  }
  return Number(value);
}

export function reportingChangesQuery(query) {
  const after = intQuery(query.after ?? '0', 'after');
  const limit = intQuery(query.limit ?? '200', 'limit', 200);
  const through = query.through === undefined ? null : intQuery(query.through, 'through');
  if (limit < 1 || (through !== null && through < after)) {
    throw Object.assign(new Error('Invalid reporting change bounds'), { statusCode: 400 });
  }
  return { after, through, limit };
}

export async function readReportingChanges(query) {
  const { after, through, limit } = reportingChangesQuery(query);
  const latest = await readReportingWatermark();
  const stop = through ?? latest;
  if (after > stop || stop > latest) {
    throw Object.assign(new Error('Reporting cursor is ahead of the source'), { statusCode: 400 });
  }
  const rows = await ReportingOutbox.find({ sourceVersion: { $gt: after, $lte: stop } })
    .read('primary').readConcern('majority').sort({ sourceVersion: 1 }).limit(limit).lean();
  const cursor = rows.at(-1)?.sourceVersion ?? after;
  if ((cursor < stop && rows.length < limit) || rows.some((row, index) => row.sourceVersion !== after + index + 1)) {
    throw new Error('Reporting change history is incomplete');
  }
  return { data: rows.map(reportingEnvelope), cursor, through: stop, hasMore: cursor < stop };
}

function emitterSettings(env) {
  if (env.MATTER_REPORTING_EMITTER_ENABLED !== '1') return null;
  const url = new URL(env.MATTER_REPORTING_WEBHOOK_URL ?? '');
  const signingSecret = env.MATTER_REPORTING_WEBHOOK_SECRET;
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || typeof signingSecret !== 'string' || signingSecret.length < 32) {
    throw new Error('Reporting emitter settings are invalid');
  }
  return { url, signingSecret };
}

function retryDelay(attempts) {
  return Math.min(60 * 60_000, 15_000 * 2 ** Math.min(attempts, 10));
}

export async function isReportingWebhookReceipt(response) {
  const expectedStatus = response.status === 202 ? 'accepted' : response.status === 200 ? 'duplicate' : null;
  if (!response.body) return false;
  if (!expectedStatus || response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    await response.body.cancel().catch(() => {});
    return false;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > receiptMaxBytes) return false;
      chunks.push(value);
    }
    const receipt = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    return receipt?.status === expectedStatus && typeof receipt.workId === 'string' && workIdPattern.test(receipt.workId);
  } catch {
    return false;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function publishOne(settings) {
  const now = new Date();
  const leaseId = randomUUID();
  const row = await ReportingOutbox.findOneAndUpdate({
    deliveredAt: null, nextAttemptAt: { $lte: now },
    $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }],
  }, {
    $set: { leaseId, leaseUntil: new Date(+now + leaseMs) },
    $inc: { attempts: 1 },
  }, { sort: { sourceVersion: 1 }, new: true, writeConcern: majorityWriteConcern }).lean();
  if (!row) return false;

  let accepted = false;
  try {
    const response = await fetch(settings.url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(sendTimeoutMs),
      ...signReportingEvent(row, settings.signingSecret),
    });
    accepted = await isReportingWebhookReceipt(response);
  } catch {
    // A timeout or lost response can replay the same immutable event ID.
  }
  const state = accepted ? { deliveredAt: new Date() } : { nextAttemptAt: new Date(Date.now() + retryDelay(row.attempts)) };
  await ReportingOutbox.updateOne({ _id: row._id, leaseId }, {
    $set: state, $unset: { leaseId: 1, leaseUntil: 1 },
  }, { writeConcern: majorityWriteConcern });
  return true;
}

export function startReportingEmitter(env = process.env) {
  let settings;
  try { settings = emitterSettings(env); }
  catch { console.error('Reporting emitter settings are invalid'); }
  if (!settings) return;
  let running = false;
  async function drain() {
    if (running || mongoose.connection.readyState !== 1) return;
    running = true;
    try {
      for (let index = 0; index < batchSize && await publishOne(settings); index++) {
        // Each event is acknowledged before the next claim.
      }
    } catch {
      console.error('Reporting outbox could not be drained');
    } finally {
      running = false;
    }
  }
  return setInterval(drain, tickMs).unref();
}
