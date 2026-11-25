import MenuSelectionRecord from '../models/MenuSelectionRecord.js';
import { cacheDeletePattern } from '../config/cache.js';
import matterApiService from './matterApiService.js';
import { menuPlanOwnsDate } from './menuPlanSchedule.js';

// Owner (2026-11-12): a Matter admin may undo a confirmed menu-link pause.
// Only an explicitly active date on the SAME subscription proves that undo;
// missing dates, renewals, failed pauses and unavailable calendars do not.
export async function reconcileMenuSkippedDays(record, nutrition, calendar = nutrition) {
  if (nutrition?.previous_plan) await reconcileMenuSkippedDays(record, nutrition.previous_plan, calendar);
  if (nutrition?.upcoming_plan) await reconcileMenuSkippedDays(record, nutrition.upcoming_plan, calendar);
  if (!record || !Array.isArray(nutrition?.active_delivery_dates)) return record;
  const ownsDate = date => menuPlanOwnsDate(calendar, nutrition, date);
  const active = new Set(nutrition.active_delivery_dates.filter(ownsDate));
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
    const parentId = nutrition.source_parent_subscription_id;
    try {
      // After activation the standalone calendar is authoritative, even
      // while the predecessor still advertises an embedded upcoming copy.
      subscription = (await matterApiService.getSubscription(nutrition.subscription_id))?.data;
    } catch (error) {
      if (!parentId || error?.response?.status !== 404) throw error;
    }
    if (parentId && (!subscription || subscription.subscription_status === 'scheduled')) {
      const embedded = (await matterApiService.getSubscription(parentId))?.data?.upcoming_plan;
      subscription = embedded || subscription;
    }
    if (parentId && String(subscription?.customer_id ?? '') !== String(nutrition.customer_id)) {
      throw new Error('Matter customer identity could not be verified.');
    }
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
    .filter((day) => day.status === 'active').map((day) => String(day.date).slice(0, 10)).filter(ownsDate));
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

export function restoredMenuSkipDates(record, nutrition, calendar = nutrition) {
  const active = new Set((nutrition?.active_delivery_dates || []).filter(date => menuPlanOwnsDate(calendar, nutrition, date)));
  const skipped = new Set((record?.skippedDays || []).map((s) => s.date));
  const upcoming = nutrition?.upcoming_plan ? restoredMenuSkipDates(record, nutrition.upcoming_plan, calendar) : [];
  const previous = nutrition?.previous_plan ? restoredMenuSkipDates(record, nutrition.previous_plan, calendar) : [];
  return [...new Set([...previous, ...upcoming, ...(record?.unpausedDays || []).filter((s) =>
    String(s.subscriptionId) === String(nutrition?.subscription_id)
    && active.has(s.date) && !skipped.has(s.date)).map((s) => s.date)])];
}
