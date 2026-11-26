import { hasDatedMenuPlans, menuNutritionForDate, menuPausedDeliveryDates, menuPlanDates, menuPlanOwnsDate, menuReservedDates } from './menuPlanSchedule.js';
import matterApiService, { describeMatterApiError, buildNutritionResult } from './matterApiService.js';

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
export async function resolveSubscriptionContext({ email, matterSubscriptionId, matterCustomerId, date }) {
  let subscription = null;
  try {
    let detailData = null;
    const verifiedNutrition = matterCustomerId
      ? await matterApiService.getKitchenNutrition({ customerId: matterCustomerId }) : null;
    if (!verifiedNutrition && matterSubscriptionId) {
      try {
        const detail = await matterApiService.getSubscription(matterSubscriptionId);
        subscription = detail?.data || null;
        detailData = subscription;
      } catch (err) {
        // Renewals replace subscription IDs. Retry an exact email lookup on
        // not-found only; auth errors and outages must keep their real error.
        if (!email || err?.response?.status !== 404) throw err;
      }
    }
    if (!verifiedNutrition && !subscription && email) {
      // Bypass the nutrition cache: it can still hold the previous cycle's ID.
      const list = await matterApiService.listSubscriptions({ email: String(email).trim().toLowerCase(), pageSize: 10 });
      const rows = list?.data || [];
      subscription = rows.find((row) => row.subscription_status === 'active') || rows[0] || null;
    }
    if (!verifiedNutrition && !subscription) {
      return { error: 'No Matter website subscription found for this customer' };
    }
    if (!verifiedNutrition && !detailData) {
      const detail = await matterApiService.getSubscription(subscription.subscription_id);
      detailData = detail?.data || null;
    }
    const rootNutrition = await matterApiService.withPriorKitchenSubscription(verifiedNutrition || buildNutritionResult(detailData || {}), date);
    const selectedPlan = date ? menuNutritionForDate(rootNutrition, date) : rootNutrition;
    const datedPlans = hasDatedMenuPlans(rootNutrition);
    const allActiveDeliveryDates = datedPlans ? menuPlanDates(rootNutrition) : null;
    if (!Array.isArray(selectedPlan.active_delivery_dates)) {
      return { error: 'Unable to verify active deliveries with Matter. Please retry.' };
    }
    const selectedId = selectedPlan.subscription_id;
    const ownsDate = date => menuPlanOwnsDate(rootNutrition, selectedPlan, date);
    const activeDeliveryDates = new Set(selectedPlan.active_delivery_dates.filter(ownsDate));
    let existingPaused = new Set(selectedPlan.paused_delivery_dates || []);
    let usedReturn = new Set(selectedPlan.reserved_resume_dates || []);
    try {
      const pauseState = await matterApiService.getSubscriptionPauses(selectedId);
      existingPaused = new Set([...existingPaused, ...(pauseState?.paused_days || pauseState?.data?.paused_days || []).map(toDayKey)]);
      usedReturn = new Set([...usedReturn, ...(pauseState?.resumed_days || pauseState?.data?.resumed_days || []).map(toDayKey)]);
    } catch (err) {
      // Non-fatal — we can still validate/apply chosen dates, just can't dedupe
      // against days Matter already has paused/reserved.
      console.error('resolveSubscriptionContext: failed to read existing pauses:', err.message);
    }

    existingPaused = new Set([...existingPaused].filter(ownsDate));
    const allUnavailableDates = [...new Set([...menuReservedDates(rootNutrition), ...existingPaused, ...usedReturn])];
    const allPausedDeliveryDates = menuPausedDeliveryDates(rootNutrition);
    return { allUnavailableDates, allPausedDeliveryDates, subscriptionId: selectedId, existingPaused, usedReturn,
      activeDeliveryDates, allActiveDeliveryDates, datedPlans, weekendEnabled: selectedPlan.weekend_enabled === true };
  } catch (err) {
    return { error: describeMatterApiError(err) || err.message || 'Failed to reach the Matter API' };
  }
}

// Validate before saving meals or calling Matter. An unconfirmed skip must
// never fall through to automatic resume-date selection.
export function validateRequiredResumeDates({ skippedDateKeys, decisions, alreadyPaused = new Set(), blockedResumeDates = [] }) {
  const byDate = new Map((decisions || []).map((d) => [toDayKey(d.date), d]));
  const used = new Set();
  const skipped = new Set(skippedDateKeys || []);
  const blockedResumes = new Set([...skipped, ...blockedResumeDates]);
  for (const date of skipped) {
    if (alreadyPaused.has(date)) continue;
    const decision = byDate.get(date);
    const resume = decision?.resumeDate;
    const valid = typeof resume === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(resume)
      && !Number.isNaN(Date.parse(`${resume}T00:00:00Z`))
      && new Date(`${resume}T00:00:00Z`).toISOString().slice(0, 10) === resume;
    if (decision?.action !== 'pause' || !valid) return `Choose an exact resume date for the paused day ${date}.`;
    if (resume <= date || blockedResumes.has(resume)) return `The resume date for ${date} must follow the paused day and cannot be another paused day.`;
    if (used.has(resume)) return 'Choose a different resume date for each paused day.';
    used.add(resume);
  }
  return null;
}

/**
 * Read-only orchestration for the pre-submit preview the customer sees in the
 * pause-confirmation calendar. Never calls createSubscriptionPause.
 */
export async function previewSkipPauses({ email, matterSubscriptionId, matterCustomerId, skippedDateKeys, restoredSkipDates = [], existingSkips = [], expandWeekends = true }) {
  const ctx = await resolveSubscriptionContext({ email, matterSubscriptionId, matterCustomerId, date: skippedDateKeys?.[0] });
  if (ctx.error) {
    return {
      subscriptionId: null,
      availabilityError: ctx.error,
      pauses: (skippedDateKeys || []).map((date) => ({ date: toDayKey(date), alreadyPaused: false, resumeDate: null, error: ctx.error }))
    };
  }
  const explicitDates = new Set(skippedDateKeys);
  if (expandWeekends) {
    const expanded = expandSaturdaySkips(skippedDateKeys.filter(date => !existingSkips.includes(date)),
      new Set([...(ctx.allActiveDeliveryDates || ctx.activeDeliveryDates), ...(ctx.allPausedDeliveryDates || []), ...ctx.existingPaused]));
    skippedDateKeys = [...new Set([...explicitDates, ...expanded.filter(date => !restoredSkipDates.includes(date))])].sort();
  }
  if (ctx.datedPlans && (skippedDateKeys || []).length > 1) {
    const previews = await Promise.all(skippedDateKeys.map(date => previewSkipPauses({ email, matterSubscriptionId, matterCustomerId, skippedDateKeys: [date], restoredSkipDates, existingSkips, expandWeekends: false })));
    const error = previews.find(preview => preview.availabilityError);
    if (error) return error;
    return { subscriptionId: null, weekendEnabled: previews.some(preview => preview.weekendEnabled),
      activeDeliveryDates: [...new Set(previews.flatMap(preview => preview.activeDeliveryDates || []))],
      unavailableDates: [...new Set(previews.flatMap(preview => preview.unavailableDates || []))],
      pauses: [...new Map(previews.flatMap(preview => preview.pauses || []).map(pause => [pause.date, pause])).values()] };
  }
  return {
    subscriptionId: ctx.subscriptionId,
    weekendEnabled: ctx.weekendEnabled,
    activeDeliveryDates: ctx.allActiveDeliveryDates || [...ctx.activeDeliveryDates],
    unavailableDates: [...new Set([...ctx.allUnavailableDates, ...existingSkips])],
    pauses: (skippedDateKeys || []).map((date) => {
      const key = toDayKey(date);
      return { date: key, subscriptionId: ctx.subscriptionId, alreadyPaused: ctx.existingPaused.has(key), resumeDate: null };
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
export async function applyConfirmedPauses({ subscriptionId, decisions, matterCustomerId }) {
  const results = [];
  // Recheck the live schedule at confirmation: a delivery may have been
  // added after the customer opened the calendar. Never write on lookup failure.
  let activeDates = new Set();
  let pausableDates = new Set();
  let scheduleError = null;
  if (subscriptionId && (decisions || []).some((d) => d.action !== 'decline' && !d.alreadyPaused)) {
    try {
      if (matterCustomerId) {
        const source = await matterApiService.getKitchenNutrition({ customerId: matterCustomerId });
        const earliestDate = decisions.filter(decision => decision.action !== 'decline').map(decision => toDayKey(decision.date)).sort()[0];
        const current = await matterApiService.withPriorKitchenSubscription(source, earliestDate);
        for (const decision of decisions) {
          if (decision.action === 'decline') continue;
          const plan = menuNutritionForDate(current, decision.date);
          if (String(plan.subscription_id) !== String(subscriptionId) || !Array.isArray(plan.active_delivery_dates)) throw new Error('Your Matter plan changed. Reopen the menu before pausing.');
          if (plan.active_delivery_dates.includes(toDayKey(decision.date))) pausableDates.add(toDayKey(decision.date));
        }
        const eligible = menuPlanDates(current);
        activeDates = new Set([...eligible, ...menuReservedDates(current)]);
        pausableDates = new Set([...pausableDates].filter(date => eligible.includes(date)));
      } else {
        const detail = await matterApiService.getSubscription(subscriptionId);
        if (!Array.isArray(detail?.data?.delivery_schedule)) throw new Error('Matter delivery schedule is unavailable');
        activeDates = new Set(detail.data.delivery_schedule.filter((d) => d.status === 'active').map((d) => toDayKey(d.date)));
        pausableDates = activeDates;
      }
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
    if (!scheduleError && subscriptionId && !pausableDates.has(date)) {
      results.push({ date, pauseStatus: 'failed', error: 'Matter does not confirm an active delivery for this date.' });
      continue;
    }
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
