import matterApiService, { describeMatterApiError } from './matterApiService.js';
import { matterWeekendEnabled } from './matterSubscriptionContract.js';

// Menu-link pauses use only resume dates explicitly chosen by the customer.
// The preview reads availability; it never generates or books resume dates.

const toDayKey = (value) => {
  if (!value) return '';
  const s = String(value);
  return s.length >= 10 ? s.slice(0, 10) : s;
};

const addDaysToDateKey = (dateKey, days) => {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

export function expandSaturdaySkips(dates, deliveryDates) {
  const result = new Set(dates);
  const eligible = new Set(deliveryDates || []);
  for (const key of dates) {
    if (new Date(`${key}T00:00:00Z`).getUTCDay() !== 6) continue;
    const sunday = addDaysToDateKey(key, 1);
    if (eligible.has(sunday)) result.add(sunday);
  }
  return [...result].sort();
}

/**
 * Resolves the customer's CURRENT Matter subscription (customer id wins over
 * a possibly-stale stored subscription id, since the subscription id changes
 * on every renewal but the customer id is permanent) and its delivery calendar
 * plus current pause state. No writes.
 *
 * Returns { subscription, subscriptionId, existingPaused: Set,
 * usedReturn: Set } on success, or { error } when nothing could be resolved.
 */
export async function resolveSubscriptionContext({ email, matterSubscriptionId, matterCustomerId }) {
  let subscription = null;
  try {
    let detailData = null;
    let resolvedSubscriptionId = matterSubscriptionId;
    if (matterCustomerId) {
      const byCustomer = await matterApiService.listSubscriptions({ customerId: matterCustomerId, pageSize: 10 });
      const rows = byCustomer?.data || [];
      const current = rows.find((row) => row.subscription_status === 'active') || rows[0];
      if (current?.subscription_id) resolvedSubscriptionId = current.subscription_id;
    }
    if (resolvedSubscriptionId) {
      try {
        const detail = await matterApiService.getSubscription(resolvedSubscriptionId);
        subscription = detail?.data || null;
        detailData = subscription;
      } catch (err) {
        // Renewals replace subscription IDs. Retry an exact email lookup on
        // not-found only; auth errors and outages must keep their real error.
        if (!email || err?.response?.status !== 404) throw err;
      }
    }
    if (!subscription && email) {
      // Bypass the nutrition cache: it can still hold the previous cycle's ID.
      const list = await matterApiService.listSubscriptions({ email: String(email).trim().toLowerCase(), pageSize: 10 });
      const rows = list?.data || [];
      subscription = rows.find((row) => row.subscription_status === 'active') || rows[0] || null;
    }
    if (!subscription) {
      return { error: 'No Matter website subscription found for this customer' };
    }
    if (!detailData) {
      const detail = await matterApiService.getSubscription(subscription.subscription_id);
      detailData = detail?.data || null;
    }
    if (!Array.isArray(detailData?.delivery_schedule)) {
      return { error: 'Unable to verify active deliveries with Matter. Please retry.' };
    }
    const activeDeliveryDates = new Set(detailData.delivery_schedule
      .filter((entry) => entry.status === 'active').map((entry) => toDayKey(entry.date)));
    let existingPaused = new Set();
    let usedReturn = new Set();
    try {
      const pauseState = await matterApiService.getSubscriptionPauses(subscription.subscription_id);
      existingPaused = new Set((pauseState?.paused_days || pauseState?.data?.paused_days || []).map(toDayKey));
      usedReturn = new Set((pauseState?.resumed_days || pauseState?.data?.resumed_days || []).map(toDayKey));
    } catch (err) {
      // Non-fatal — we can still validate/apply chosen dates, just can't dedupe
      // against days Matter already has paused/reserved.
      console.error('resolveSubscriptionContext: failed to read existing pauses:', err.message);
    }

    return { subscription, subscriptionId: subscription.subscription_id, existingPaused, usedReturn, activeDeliveryDates, weekendEnabled: matterWeekendEnabled(detailData) };
  } catch (err) {
    return { error: describeMatterApiError(err) || err.message || 'Failed to reach the Matter API' };
  }
}

// Validate before saving meals or calling Matter. An unconfirmed skip must
// never fall through to automatic resume-date selection.
export function validateRequiredResumeDates({ skippedDateKeys, decisions, alreadyPaused = new Set() }) {
  const byDate = new Map((decisions || []).map((d) => [toDayKey(d.date), d]));
  const used = new Set();
  const skipped = new Set(skippedDateKeys || []);
  for (const date of skipped) {
    if (alreadyPaused.has(date)) continue;
    const decision = byDate.get(date);
    const resume = decision?.resumeDate;
    const valid = typeof resume === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(resume)
      && !Number.isNaN(Date.parse(`${resume}T00:00:00Z`))
      && new Date(`${resume}T00:00:00Z`).toISOString().slice(0, 10) === resume;
    if (decision?.action !== 'pause' || !valid) return `Choose an exact resume date for the paused day ${date}.`;
    if (resume <= date || skipped.has(resume)) return `The resume date for ${date} must follow the paused day and cannot be another paused day.`;
    if (used.has(resume)) return 'Choose a different resume date for each paused day.';
    used.add(resume);
  }
  return null;
}

/**
 * Read-only orchestration for the pre-submit preview the customer sees in the
 * pause-confirmation calendar. Never calls createSubscriptionPause.
 */
export async function previewSkipPauses({ email, matterSubscriptionId, matterCustomerId, skippedDateKeys }) {
  const ctx = await resolveSubscriptionContext({ email, matterSubscriptionId, matterCustomerId });
  if (ctx.error) {
    return {
      subscriptionId: null,
      availabilityError: ctx.error,
      pauses: (skippedDateKeys || []).map((date) => ({ date: toDayKey(date), alreadyPaused: false, resumeDate: null, error: ctx.error }))
    };
  }
  skippedDateKeys = expandSaturdaySkips(skippedDateKeys, new Set([...ctx.activeDeliveryDates, ...ctx.existingPaused]));
  return {
    subscriptionId: ctx.subscriptionId,
    weekendEnabled: ctx.weekendEnabled,
    activeDeliveryDates: [...ctx.activeDeliveryDates],
    unavailableDates: [...new Set([...ctx.existingPaused, ...ctx.usedReturn])],
    pauses: (skippedDateKeys || []).map((date) => {
      const key = toDayKey(date);
      return { date: key, alreadyPaused: ctx.existingPaused.has(key), resumeDate: null };
    })
  };
}

/**
 * Applies the customer's CONFIRMED decisions — exactly what they saw and
 * approved in the calendar, never a server recompute (the preview already
 * ran; re-deriving here risks showing one date and booking another). Each
 * decision is { date, action: 'pause'|'decline', resumeDate }. A 'decline'
 * never touches Matter. Per-date failures are caught and returned, never
 * thrown — a rejected pause must never fail the customer's whole submission.
 *
 * Returns an array of { date, pauseStatus: 'success'|'already_paused'|
 * 'failed'|'declined', resumeDate, subscriptionId, error }.
 */
export async function applyConfirmedPauses({ subscriptionId, decisions }) {
  const results = [];
  // Recheck the live schedule at confirmation: a delivery may have been
  // added after the customer opened the calendar. Never write on lookup failure.
  let activeDates = new Set();
  let scheduleError = null;
  if (subscriptionId && (decisions || []).some((d) => d.action !== 'decline' && !d.alreadyPaused)) {
    try {
      const detail = await matterApiService.getSubscription(subscriptionId);
      if (!Array.isArray(detail?.data?.delivery_schedule)) throw new Error('Matter delivery schedule is unavailable');
      activeDates = new Set(detail.data.delivery_schedule.filter((d) => d.status === 'active').map((d) => toDayKey(d.date)));
    } catch (err) {
      scheduleError = describeMatterApiError(err) || err.message;
    }
  }
  const chosenDates = new Set();
  const pauseDates = new Set((decisions || []).map((d) => toDayKey(d.date)));
  for (const decision of decisions || []) {
    const date = toDayKey(decision?.date);
    if (!date) continue;
    if (decision.action === 'decline') {
      results.push({ date, pauseStatus: 'declined' });
      continue;
    }
    if (decision.alreadyPaused) {
      results.push({ date, pauseStatus: 'already_paused', subscriptionId });
      continue;
    }
    const resumeDate = toDayKey(decision.resumeDate);
    if (scheduleError || activeDates.has(resumeDate) || chosenDates.has(resumeDate) || pauseDates.has(resumeDate) || resumeDate <= date) {
      results.push({ date, pauseStatus: 'failed', error: scheduleError || 'Resume date is unavailable or already has an active delivery' });
      continue;
    }
    if (!subscriptionId || !resumeDate) {
      results.push({ date, pauseStatus: 'failed', error: !subscriptionId ? 'No Matter subscription resolved' : 'No resume date given' });
      continue;
    }
    try {
      await matterApiService.createSubscriptionPause(subscriptionId, {
        pausedDays: [date],
        chosenDays: [resumeDate],
        reason: 'Customer skipped this day in the menu selection link'
      });
      results.push({ date, pauseStatus: 'success', resumeDate, subscriptionId });
      chosenDates.add(resumeDate);
    } catch (err) {
      results.push({ date, pauseStatus: 'failed', error: describeMatterApiError(err) || err.message || 'Matter rejected the pause' });
    }
  }
  return results;
}

export { toDayKey, addDaysToDateKey };
