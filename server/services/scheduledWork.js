import { randomUUID } from 'node:crypto';
import ScheduledWork from '../models/ScheduledWork.js';
import { businessOffsetMs } from '../utils/businessDate.js';

const lostLease = () => Object.assign(new Error('Scheduled work ownership was lost'), { code: 'WORK_LEASE_LOST' });

// All lease expiry comparisons use database time, not the individual worker's
// clock. Never fall back to an in-memory lock when MongoDB is unavailable.
export const mongoWorkStore = {
  async acquire(name, owner, leaseMs, slot) {
    try {
      await ScheduledWork.updateOne({ _id: name }, { $setOnInsert: { leaseUntil: new Date(0), completedSlot: -1 } }, { upsert: true, maxTimeMS: 5000 });
    } catch (error) { if (error.code !== 11000) throw error; }
    const record = await ScheduledWork.findOneAndUpdate({ _id: name,
      $expr: { $lte: ['$leaseUntil', '$$NOW'] },
      ...(slot == null ? {} : { completedSlot: { $lt: slot } }),
    }, [{ $set: { owner: { $literal: owner }, leaseUntil: { $add: ['$$NOW', leaseMs] } } }], { new: true, maxTimeMS: 5000 }).lean();
    if (record) return 'acquired';
    const existing = await ScheduledWork.findById(name).select('completedSlot').lean();
    return slot != null && existing?.completedSlot >= slot ? 'completed' : 'busy';
  },
  async renew(name, owner, leaseMs) {
    const result = await ScheduledWork.updateOne({ _id: name, owner, $expr: { $gt: ['$leaseUntil', '$$NOW'] } },
      [{ $set: { leaseUntil: { $add: ['$$NOW', leaseMs] } } }], { maxTimeMS: 5000 });
    return result.matchedCount === 1;
  },
  async complete(name, owner, slot) {
    const result = await ScheduledWork.updateOne({ _id: name, owner, $expr: { $gt: ['$leaseUntil', '$$NOW'] } },
      { $set: { completedSlot: slot, leaseUntil: new Date(0) }, $unset: { owner: '' } }, { maxTimeMS: 5000 });
    return result.matchedCount === 1;
  },
  async release(name, owner) {
    await ScheduledWork.updateOne({ _id: name, owner }, { $set: { leaseUntil: new Date(0) }, $unset: { owner: '' } }, { maxTimeMS: 5000 });
  },
};

export function createWorkCoordinator({ store = mongoWorkStore, leaseMs = 120000, setTimer = setInterval, clearTimer = clearInterval } = {}) {
  return async function withWork(name, work, { slot = null } = {}) {
    const owner = randomUUID();
    const acquired = await store.acquire(name, owner, leaseMs, slot);
    if (acquired !== 'acquired') return { skipped: true, reason: acquired };
    let failure = null;
    let renewing = null;
    const assertOwned = async () => {
      if (failure) throw failure;
      if (!renewing) renewing = (async () => {
        try { if (!await store.renew(name, owner, leaseMs)) throw lostLease(); }
        catch (error) { failure = Object.assign(lostLease(), { cause: error }); throw failure; }
        finally { renewing = null; }
      })();
      await renewing;
    };
    const heartbeat = setTimer(() => { assertOwned().catch(() => {}); }, Math.floor(leaseMs / 3));
    heartbeat?.unref?.();
    try {
      await assertOwned();
      const value = await work({ assertOwned, slot });
      clearTimer(heartbeat);
      if (renewing) await renewing;
      if (failure) throw failure;
      if (slot != null && value?.complete === false) throw new Error('Scheduled work incomplete; retry required');
      if (slot != null && !value?.skipped && !await store.complete(name, owner, slot)) throw lostLease();
      return value;
    } finally {
      clearTimer(heartbeat);
      // An expired worker cannot release its successor's lease.
      await store.release(name, owner);
    }
  };
}
export const withScheduledWork = createWorkCoordinator();

const activeSchedulers = new Map();
export function workSlot(now, intervalMs, offsetMs = 0) {
  return Math.floor((now + offsetMs) / intervalMs);
}
export function scheduleWork({ name, run, intervalMs, offsetMs = 0, immediate = true, startupOffsetMs }) {
  if (activeSchedulers.has(name)) return activeSchedulers.get(name);
  if (!Number.isFinite(intervalMs) || intervalMs < 1000) throw new Error('Invalid scheduled interval');
  let stopped = false, timer, startup = immediate && startupOffsetMs != null;
  const slotAt = now => workSlot(now, intervalMs, offsetMs);
  const untilBoundary = () => Math.max(100, (slotAt(Date.now()) + 1) * intervalMs - offsetMs - Date.now());
  const queue = delay => { if (!stopped) { timer = setTimeout(tick, delay); timer.unref?.(); } };
  const tick = async () => {
    let retry = false;
    try {
      // Startup catch-up has a calendar-day identity independent of the
      // normal run hour. Restarting after midnight must not reuse yesterday's
      // 6 AM slot and miss a newly requested delivery date.
      const result = await withScheduledWork(`scheduled:${name}${startup ? ':startup' : ''}`, run,
        { slot: startup ? workSlot(Date.now(), intervalMs, startupOffsetMs) : slotAt(Date.now()) });
      retry = result?.skipped && result.reason === 'busy';
      if (!retry) startup = false;
    } catch (error) { retry = true; console.error(`[${name}] Scheduled work failed; retrying:`, error.message); }
    queue(retry ? Math.min(60000, untilBoundary()) : untilBoundary());
  };
  const stop = () => { if (stopped) return; stopped = true; clearTimeout(timer); activeSchedulers.delete(name); };
  activeSchedulers.set(name, stop);
  queue(immediate ? 0 : untilBoundary());
  return stop;
}
export const scheduleDailyWork = ({ hour = 0, ...options }) => {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('Invalid scheduled business hour');
  return scheduleWork({ ...options, intervalMs: 86400000, offsetMs: businessOffsetMs() - hour * 3600000 });
};
