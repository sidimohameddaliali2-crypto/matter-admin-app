import matterApiService, { describeMatterApiError } from './matterApiService.js';
import MenuSelectionRecord from '../models/MenuSelectionRecord.js';

/**
 * Everything to do with pausing a customer's Matter deliveries for a day they
 * skipped in the menu-selection link, and choosing which day their delivery
 * resumes on. Pulled out of routes/menus.js (2026-10-20) because this logic
 * now has three call sites that must never disagree with each other:
 *   1. previewSkipPauses — a read-only "here's what would happen" shown to
 *      the customer in the pause-confirmation calendar, BEFORE they confirm.
 *   2. applyConfirmedPauses — actually calls Matter, using exactly the dates
 *      the customer confirmed (not a server recompute — see select-meals).
 *   3. reconcilePendingPausesForRecord — the fallback sweep for anything that
 *      still has no outcome (an old client, or a synchronous apply that
 *      didn't get a chance to run), rebuilt from the same pieces so it can
 *      never compute a different resume date than the preview did for the
 *      same inputs.
 * Deliberately self-contained (duplicates the trivial date helpers rather
 * than importing them from routes/menus.js) so it has no dependency on the
 * route file and can be unit-tested on its own (see the companion .test.js).
 */

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

const isWeekendKey = (dateKey) => {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  const day = new Date(y, m - 1, d).getDay();
  return day === 0 || day === 6;
};

/**
 * Resolves the customer's CURRENT Matter subscription (customer id wins over
 * a possibly-stale stored subscription id, since the subscription id changes
 * on every renewal but the customer id is permanent) and its cycle_end_date
 * plus current pause state. No writes.
 *
 * Returns { subscription, subscriptionId, cycleEndKey, existingPaused: Set,
 * usedReturn: Set } on success, or { error } when nothing could be resolved —
 * mirrors the failure reasons processSkippedDayPauses used to produce inline.
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
      const detail = await matterApiService.getSubscription(resolvedSubscriptionId);
      subscription = detail?.data || null;
      detailData = subscription;
    } else {
      const list = await matterApiService.listSubscriptions({ email, pageSize: 1 });
      subscription = list?.data?.[0] || null;
    }
    if (!subscription) {
      return { error: 'No Matter website subscription found for this customer' };
    }
    if (!detailData) {
      const detail = await matterApiService.getSubscription(subscription.subscription_id);
      detailData = detail?.data || null;
    }
    const cycleEndKey = toDayKey(detailData?.cycle_end_date || subscription.cycle_end_date);
    if (!cycleEndKey) {
      return { error: 'Subscription has no cycle_end_date to place the resume day after' };
    }

    let existingPaused = new Set();
    let usedReturn = new Set();
    try {
      const pauseState = await matterApiService.getSubscriptionPauses(subscription.subscription_id);
      existingPaused = new Set((pauseState?.paused_days || pauseState?.data?.paused_days || []).map(toDayKey));
      usedReturn = new Set((pauseState?.resumed_days || pauseState?.data?.resumed_days || []).map(toDayKey));
    } catch (err) {
      // Non-fatal — we can still suggest/apply pauses, just can't dedupe
      // against days Matter already has paused/reserved.
      console.error('resolveSubscriptionContext: failed to read existing pauses:', err.message);
    }

    return { subscription, subscriptionId: subscription.subscription_id, cycleEndKey, existingPaused, usedReturn };
  } catch (err) {
    return { error: describeMatterApiError(err) || err.message || 'Failed to reach the Matter API' };
  }
}

/**
 * PURE — no network. Given the subscription's cycle end and its current
 * pause/resume-day state, suggest a resume date for each of `skippedDateKeys`
 * (in the order given), one resume day per skip starting the day after
 * cycle_end_date, skipping days already used as a resume day this run,
 * already-paused days, and (unless weekendEnabled) weekends. A date already
 * in `existingPaused` doesn't consume a resume slot at all — it's reported as
 * already paused.
 *
 * Returns a Map<dateKey, { alreadyPaused: boolean, resumeDate: string|null }>.
 */
export function suggestResumeDates({ skippedDateKeys, cycleEndKey, existingPaused, usedReturn, weekendEnabled }) {
  const paused = new Set(existingPaused || []);
  const used = new Set(usedReturn || []);
  const out = new Map();
  if (!cycleEndKey) {
    (skippedDateKeys || []).forEach((d) => out.set(toDayKey(d), { alreadyPaused: false, resumeDate: null }));
    return out;
  }

  let cursor = addDaysToDateKey(cycleEndKey, 1);
  const nextResumeDate = () => {
    while (used.has(cursor) || paused.has(cursor) || (!weekendEnabled && isWeekendKey(cursor))) {
      cursor = addDaysToDateKey(cursor, 1);
    }
    const chosen = cursor;
    used.add(chosen);
    cursor = addDaysToDateKey(cursor, 1);
    return chosen;
  };

  for (const raw of skippedDateKeys || []) {
    const dateKey = toDayKey(raw);
    if (!dateKey) continue;
    if (paused.has(dateKey)) {
      out.set(dateKey, { alreadyPaused: true, resumeDate: null });
      continue;
    }
    out.set(dateKey, { alreadyPaused: false, resumeDate: nextResumeDate() });
  }
  return out;
}

/**
 * Read-only orchestration for the pre-submit preview the customer sees in the
 * pause-confirmation calendar. Never calls createSubscriptionPause.
 */
export async function previewSkipPauses({ email, matterSubscriptionId, matterCustomerId, skippedDateKeys, weekendEnabled }) {
  const ctx = await resolveSubscriptionContext({ email, matterSubscriptionId, matterCustomerId });
  if (ctx.error) {
    return {
      subscriptionId: null,
      pauses: (skippedDateKeys || []).map((date) => ({ date: toDayKey(date), alreadyPaused: false, suggestedResumeDate: null, error: ctx.error }))
    };
  }
  const suggested = suggestResumeDates({
    skippedDateKeys,
    cycleEndKey: ctx.cycleEndKey,
    existingPaused: ctx.existingPaused,
    usedReturn: ctx.usedReturn,
    weekendEnabled
  });
  return {
    subscriptionId: ctx.subscriptionId,
    pauses: (skippedDateKeys || []).map((date) => {
      const key = toDayKey(date);
      const s = suggested.get(key) || { alreadyPaused: false, resumeDate: null };
      return { date: key, alreadyPaused: s.alreadyPaused, suggestedResumeDate: s.resumeDate };
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
    } catch (err) {
      results.push({ date, pauseStatus: 'failed', error: describeMatterApiError(err) || err.message || 'Matter rejected the pause' });
    }
  }
  return results;
}

/**
 * Safety-net sweep for a single MenuSelectionRecord: re-resolves the
 * subscription, suggests resume dates for anything still pending/failed (no
 * confirmed decision was ever applied — e.g. an old client that never saw
 * the calendar), applies them, and writes the real outcomes back. Built from
 * the same resolve/suggest/apply pieces the interactive flow uses, so it can
 * never diverge from what the customer would have been shown.
 */
export async function reconcilePendingPausesForRecord({ weeklyMenuId, email, weekendEnabled, matterSubscriptionId, matterCustomerId }) {
  const record = await MenuSelectionRecord.findOne({ weeklyMenuId, email }).select('skippedDays').lean();
  if (!record || !Array.isArray(record.skippedDays) || record.skippedDays.length === 0) return;

  const pending = record.skippedDays.filter((s) => s.pauseStatus === 'pending' || s.pauseStatus === 'failed');
  if (pending.length === 0) return;

  const ctx = await resolveSubscriptionContext({ email, matterSubscriptionId, matterCustomerId });
  const results = new Map();
  if (ctx.error) {
    pending.forEach((s) => results.set(toDayKey(s.date), { pauseStatus: 'failed', error: ctx.error }));
  } else {
    const suggested = suggestResumeDates({
      skippedDateKeys: pending.map((s) => s.date),
      cycleEndKey: ctx.cycleEndKey,
      existingPaused: ctx.existingPaused,
      usedReturn: ctx.usedReturn,
      weekendEnabled
    });
    const decisions = pending.map((s) => {
      const key = toDayKey(s.date);
      const sug = suggested.get(key) || { alreadyPaused: false, resumeDate: null };
      return { date: key, action: 'pause', alreadyPaused: sug.alreadyPaused, resumeDate: sug.resumeDate };
    });
    const applied = await applyConfirmedPauses({ subscriptionId: ctx.subscriptionId, decisions });
    applied.forEach((r) => results.set(r.date, r));
  }

  const fresh = await MenuSelectionRecord.findOne({ weeklyMenuId, email }).select('skippedDays').lean();
  if (!fresh) return;
  const merged = (fresh.skippedDays || []).map((s) => {
    const r = results.get(toDayKey(s.date));
    if (!r) return s;
    return {
      date: s.date,
      pauseStatus: r.pauseStatus,
      resumeDate: r.resumeDate || s.resumeDate,
      subscriptionId: r.subscriptionId || s.subscriptionId,
      error: r.pauseStatus === 'failed' ? r.error : undefined,
      processedAt: new Date()
    };
  });
  await MenuSelectionRecord.updateOne({ weeklyMenuId, email }, { $set: { skippedDays: merged } });
}

export { toDayKey, addDaysToDateKey, isWeekendKey };
