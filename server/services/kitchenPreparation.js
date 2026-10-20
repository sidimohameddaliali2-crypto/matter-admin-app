import { randomUUID } from 'node:crypto';
import KitchenPreparationLease from '../models/KitchenPreparationLease.js';

const running = new Map();
const LEASE_MS = 5 * 60 * 1000;

// Mongo leases also serialize preparation across PM2 workers when Redis is down.
export const withKitchenPreparation = (key, task) => {
  if (running.has(key)) return running.get(key);
  const promise = (async () => {
    const owner = randomUUID();
    try {
      await KitchenPreparationLease.findOneAndUpdate(
        { _id: key, expiresAt: { $lte: new Date() } },
        { $set: { owner, expiresAt: new Date(Date.now() + LEASE_MS) } },
        { upsert: true, new: true }
      );
    } catch (error) {
      if (error.code !== 11000) throw error;
      const busy = new Error('Kitchen preparation is already running. Please wait.');
      busy.statusCode = 409;
      busy.code = 'KITCHEN_PREPARATION_BUSY';
      throw busy;
    }
    let leaseLost = false;
    const timer = setInterval(() => {
      KitchenPreparationLease.updateOne(
        { _id: key, owner }, { $set: { expiresAt: new Date(Date.now() + LEASE_MS) } }
      ).then((result) => { if (!result.matchedCount) leaseLost = true; }).catch(() => { leaseLost = true; });
    }, 30000);
    timer.unref?.();
    try {
      const result = await task();
      if (leaseLost) throw new Error('Kitchen preparation lost its lock. Refresh before exporting.');
      return result;
    } finally {
      clearInterval(timer);
      await KitchenPreparationLease.deleteOne({ _id: key, owner });
    }
  })().finally(() => { running.delete(key); });
  running.set(key, promise);
  return promise;
};

export const preparationHasFailures = (value) => {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) =>
    (key === 'error' && !!item)
    || (/^skipped.*NoOptions?$/.test(key) && Number(item) > 0)
    || preparationHasFailures(item)
  );
};
