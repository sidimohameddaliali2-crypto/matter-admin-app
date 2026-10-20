// Run with: npm test (node --test) from server/.
// Pure-fixture tests for the resume-date algorithm — no DB, no Matter API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestResumeDates, applyConfirmedPauses, previewSkipPauses, resolveSubscriptionContext } from './matterPauseResumeService.js';
import matterApiService from './matterApiService.js';

test('one skip, clean subscription -> resumes the day after cycle end', () => {
  const out = suggestResumeDates({
    skippedDateKeys: ['2026-10-21'],
    cycleEndKey: '2026-10-25',
    existingPaused: new Set(),
    usedReturn: new Set(),
    weekendEnabled: true
  });
  assert.deepEqual(out.get('2026-10-21'), { alreadyPaused: false, resumeDate: '2026-10-26' });
});

test('multiple skips in one batch get sequential resume days, in order', () => {
  const out = suggestResumeDates({
    skippedDateKeys: ['2026-10-21', '2026-10-22', '2026-10-23'],
    cycleEndKey: '2026-10-25',
    existingPaused: new Set(),
    usedReturn: new Set(),
    weekendEnabled: true
  });
  assert.equal(out.get('2026-10-21').resumeDate, '2026-10-26');
  assert.equal(out.get('2026-10-22').resumeDate, '2026-10-27');
  assert.equal(out.get('2026-10-23').resumeDate, '2026-10-28');
});

test('weekends are skipped for a customer who does not take weekend deliveries', () => {
  // cycle ends Thursday 2026-10-22 -> first candidate Fri 10-23 is fine (not weekend),
  // so push the cycle end forward to land the first candidate ON a weekend.
  const out = suggestResumeDates({
    skippedDateKeys: ['2026-10-21'],
    cycleEndKey: '2026-10-23', // Friday -> first candidate Sat 10-24
    existingPaused: new Set(),
    usedReturn: new Set(),
    weekendEnabled: false
  });
  // Sat 10-24 and Sun 10-25 are skipped; lands on Mon 10-26.
  assert.equal(out.get('2026-10-21').resumeDate, '2026-10-26');
});

test('weekends are NOT skipped for a customer who does take weekend deliveries', () => {
  const out = suggestResumeDates({
    skippedDateKeys: ['2026-10-21'],
    cycleEndKey: '2026-10-23', // Friday -> first candidate Sat 10-24
    existingPaused: new Set(),
    usedReturn: new Set(),
    weekendEnabled: true
  });
  assert.equal(out.get('2026-10-21').resumeDate, '2026-10-24');
});

test('a date Matter already has paused is reported as already-paused, consuming no resume slot', () => {
  const out = suggestResumeDates({
    skippedDateKeys: ['2026-10-21', '2026-10-22'],
    cycleEndKey: '2026-10-25',
    existingPaused: new Set(['2026-10-21']),
    usedReturn: new Set(),
    weekendEnabled: true
  });
  assert.deepEqual(out.get('2026-10-21'), { alreadyPaused: true, resumeDate: null });
  // The second skip still gets the FIRST available resume slot — the
  // already-paused date didn't consume one.
  assert.equal(out.get('2026-10-22').resumeDate, '2026-10-26');
});

test('a resume day Matter already has booked (usedReturn) is skipped over', () => {
  const out = suggestResumeDates({
    skippedDateKeys: ['2026-10-21'],
    cycleEndKey: '2026-10-25',
    existingPaused: new Set(),
    usedReturn: new Set(['2026-10-26']),
    weekendEnabled: true
  });
  assert.equal(out.get('2026-10-21').resumeDate, '2026-10-27');
});

test('no cycle_end_date -> every date reported with a null resume date, no crash', () => {
  const out = suggestResumeDates({
    skippedDateKeys: ['2026-10-21', '2026-10-22'],
    cycleEndKey: null,
    existingPaused: new Set(),
    usedReturn: new Set(),
    weekendEnabled: true
  });
  assert.deepEqual(out.get('2026-10-21'), { alreadyPaused: false, resumeDate: null });
  assert.deepEqual(out.get('2026-10-22'), { alreadyPaused: false, resumeDate: null });
});

test('suggestions skip active Matter deliveries after cycle end', () => {
  const out = suggestResumeDates({
    skippedDateKeys: ['2026-10-21', '2026-10-22'], cycleEndKey: '2026-10-25',
    activeDeliveryDates: ['2026-10-26', '2026-10-28'], weekendEnabled: true,
  });
  assert.equal(out.get('2026-10-21').resumeDate, '2026-10-27');
  assert.equal(out.get('2026-10-22').resumeDate, '2026-10-29');
});

test('preview exposes active delivery dates from Matter and excludes them from suggestions', async (t) => {
  t.mock.method(matterApiService, 'getSubscription', async () => ({ data: {
    subscription_id: 'sub', cycle_end_date: '2026-10-25', delivery_schedule: [
      { date: '2026-10-26', status: 'active' }, { date: '2026-10-27', status: 'paused' },
    ],
  } }));
  t.mock.method(matterApiService, 'getSubscriptionPauses', async () => ({ paused_days: [], resumed_days: [] }));
  const result = await previewSkipPauses({ matterSubscriptionId: 'sub', skippedDateKeys: ['2026-10-21'], weekendEnabled: true });
  assert.deepEqual(result.activeDeliveryDates, ['2026-10-26']);
  assert.equal(result.pauses[0].suggestedResumeDate, '2026-10-27');
});

test('confirmation rechecks Matter and never writes an active or duplicate resume date', async (t) => {
  t.mock.method(matterApiService, 'getSubscription', async () => ({ data: {
    delivery_schedule: [{ date: '2026-10-26', status: 'active' }],
  } }));
  const write = t.mock.method(matterApiService, 'createSubscriptionPause', async () => ({}));
  const result = await applyConfirmedPauses({ subscriptionId: 'sub', decisions: [
    { date: '2026-10-21', resumeDate: '2026-10-26' },
    { date: '2026-10-22', resumeDate: '2026-10-27' },
    { date: '2026-10-23', resumeDate: '2026-10-27' },
  ] });
  assert.deepEqual(result.map((r) => r.pauseStatus), ['failed', 'success', 'failed']);
  assert.equal(write.mock.callCount(), 1);
  assert.deepEqual(write.mock.calls[0].arguments[1].chosenDays, ['2026-10-27']);
});

test('Matter schedule failures prevent pause writes', async (t) => {
  t.mock.method(matterApiService, 'getSubscription', async () => { throw new Error('Offline'); });
  const write = t.mock.method(matterApiService, 'createSubscriptionPause', async () => ({}));
  const result = await applyConfirmedPauses({ subscriptionId: 'sub', decisions: [{ date: '2026-10-21', resumeDate: '2026-10-27' }] });
  assert.equal(result[0].pauseStatus, 'failed');
  assert.equal(write.mock.callCount(), 0);
});

test('an expired subscription ID is refreshed by exact email after a 404', async (t) => {
  const get = t.mock.method(matterApiService, 'getSubscription', async (id) => {
    if (id === 'old-cycle') throw Object.assign(new Error('Subscription not found.'), { response: { status: 404 } });
    return { data: { subscription_id: id, cycle_end_date: '2026-11-20', delivery_schedule: [] } };
  });
  const list = t.mock.method(matterApiService, 'listSubscriptions', async () => ({ data: [
    { subscription_id: 'ended-cycle', subscription_status: 'cancelled' },
    { subscription_id: 'current-cycle', subscription_status: 'active' },
  ] }));
  t.mock.method(matterApiService, 'getSubscriptionPauses', async () => ({}));
  const ctx = await resolveSubscriptionContext({ email: 'Customer@Example.com', matterSubscriptionId: 'old-cycle' });
  assert.equal(ctx.subscriptionId, 'current-cycle');
  assert.equal(list.mock.calls[0].arguments[0].email, 'customer@example.com');
  assert.deepEqual(get.mock.calls.map((c) => c.arguments[0]), ['old-cycle', 'current-cycle']);
});

test('an API outage does not trigger a different subscription lookup', async (t) => {
  t.mock.method(matterApiService, 'getSubscription', async () => {
    throw Object.assign(new Error('Unavailable'), { response: { status: 503 } });
  });
  const list = t.mock.method(matterApiService, 'listSubscriptions', async () => ({ data: [] }));
  const ctx = await resolveSubscriptionContext({ email: 'customer@example.com', matterSubscriptionId: 'sub' });
  assert.equal(ctx.error, 'Unavailable');
  assert.equal(list.mock.callCount(), 0);
});
