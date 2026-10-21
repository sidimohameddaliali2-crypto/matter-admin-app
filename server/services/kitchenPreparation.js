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

// Report only assignment failures, never the source nutrition payload or API errors' request config.
export const kitchenPreparationFailure = (summary, dateKey) => {
  const failures = [];
  const stages = {
    assignedMainMeals: 'Standard plan',
    assignedSnacks: 'Standard plan snacks',
    assignedSnacksOnly: 'Standard plan snacks',
    assignedMatterCore: 'Matter Core',
    assignedMatterCoreSnacksOnly: 'Matter Core',
  };
  for (const [key, label] of Object.entries(stages)) {
    const result = summary[key];
    if (!result) continue;
    if (result.error) failures.push({ stage: label, reason: String(result.error) });
    for (const [counter, mealType] of Object.entries({ skippedNoOption: 'main', skippedNoOptions: 'snack', skippedBreakfastNoOption: 'breakfast', skippedSnackNoOption: 'snack' })) {
      const count = Number(result[counter]) || 0;
      if (count > 0) failures.push({ stage: label, mealType, count,
        reason: mealType === 'main' && label === 'Matter Core'
          ? 'Configure enough Matter Core meal options for this date, or mark dishes "Also tag for Core Plan" in Menu Management.'
          : `No available ${mealType} option for the remaining selections. Check this date's menu options and customer exclusions.` });
    }
  }
  const detail = failures.map(({ stage, mealType, count, reason }) =>
    `${stage}${mealType ? `: ${count} ${mealType} slot(s) unassigned` : ''}. ${reason}`).join(' ');
  const error = new Error(`Kitchen preparation for ${dateKey} is incomplete. ${detail || 'Check the remaining menu assignments and retry.'}`);
  error.statusCode = 409;
  error.code = 'KITCHEN_ASSIGNMENT_INCOMPLETE';
  error.failures = failures;
  return error;
};
