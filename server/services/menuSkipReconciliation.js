import MenuSelectionRecord from '../models/MenuSelectionRecord.js';
import { cacheDeletePattern } from '../config/cache.js';
import matterApiService from './matterApiService.js';

// Owner (2026-11-12): a Matter admin may undo a confirmed menu-link pause.
// Only an explicitly active date on the SAME subscription proves that undo;
// missing dates, renewals, failed pauses and unavailable calendars do not.
export async function reconcileMenuSkippedDays(record, nutrition) {
  if (!record || !Array.isArray(nutrition?.active_delivery_dates)) return record;
  const active = new Set(nutrition.active_delivery_dates);
  const candidates = (record.skippedDays || []).filter((skip) =>
    ['success', 'already_paused'].includes(skip.pauseStatus)
    && String(skip.subscriptionId || record.matterSubscriptionId || '') === String(nutrition.subscription_id || '')
    && !!nutrition.subscription_id && active.has(skip.date));
  if (!candidates.length) return record;
  // The caller's calendar may have been fetched BEFORE these saved pauses.
  // Confirm after reading them; an older active snapshot is not an admin undo.
  // Keep the conditional write below to protect pauses changed after this read.
  let subscription;
  try {
    subscription = (await matterApiService.getSubscription(nutrition.subscription_id))?.data;
  } catch {
    // Avoid passing Axios request configuration/credentials into route logs.
    const error = new Error('Could not confirm your delivery calendar. Reopen the menu before continuing.');
    error.statusCode = 503;
    throw error;
  }
  if (String(subscription?.subscription_id || '') !== String(nutrition.subscription_id)
      || !Array.isArray(subscription?.delivery_schedule)) {
    const error = new Error('Could not confirm your delivery calendar. Reopen the menu before continuing.');
    error.statusCode = 503;
    throw error;
  }
  const confirmedActive = new Set(subscription.delivery_schedule
    .filter((day) => day.status === 'active').map((day) => String(day.date).slice(0, 10)));
  // Profile responses and subsequent kitchen eligibility checks must also use
  // the confirming calendar, rather than falling back to the stale snapshot.
  nutrition.active_delivery_dates = [...confirmedActive];
  const restored = candidates.filter((skip) => confirmedActive.has(skip.date));
  for (const skip of restored) {
    const match = {
      date: skip.date, pauseStatus: skip.pauseStatus,
      ...(skip._id ? { _id: skip._id } : {}),
      ...(skip.processedAt ? { processedAt: skip.processedAt } : {}),
    };
    const history = {
      date: skip.date, resumeDate: skip.resumeDate,
      subscriptionId: String(nutrition.subscription_id), unpausedAt: new Date(),
    };
    // Conditional removal and history are atomic: never erase a concurrent
    // new pause or archive the same old pause twice.
    const result = await MenuSelectionRecord.updateOne(
      { _id: record._id, skippedDays: { $elemMatch: match } },
      { $pull: { skippedDays: match }, $push: { unpausedDays: history } },
    );
    if (result.matchedCount !== 1) {
      const error = new Error('Your delivery calendar changed. Reopen the menu before continuing.');
      error.statusCode = 409;
      throw error;
    }
    record.skippedDays = record.skippedDays.filter((entry) => entry.date !== skip.date);
    record.unpausedDays = [...(record.unpausedDays || []), history];
  }
  if (restored.length) {
    await cacheDeletePattern(`menu:${record.weeklyMenuId}:autoPopulated:*`);
  }
  return record;
}

export function restoredMenuSkipDates(record, nutrition) {
  const active = new Set(nutrition?.active_delivery_dates || []);
  const skipped = new Set((record?.skippedDays || []).map((s) => s.date));
  return [...new Set((record?.unpausedDays || []).filter((s) =>
    String(s.subscriptionId) === String(nutrition?.subscription_id)
    && active.has(s.date) && !skipped.has(s.date)).map((s) => s.date))];
}
