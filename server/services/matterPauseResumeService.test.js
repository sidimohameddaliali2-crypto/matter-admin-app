// Run with: npm test (node --test) from server/.
// Fixture tests for customer-chosen resume dates — no DB, no Matter API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyConfirmedPauses, previewSkipPauses, resolveSubscriptionContext, validateRequiredResumeDates, expandSaturdaySkips } from './matterPauseResumeService.js';
import matterApiService from './matterApiService.js';
import { matterWeekendEnabled } from './matterSubscriptionContract.js';

test('preview exposes availability without generating any resume dates or requiring cycle end', async (t) => {
  t.mock.method(matterApiService, 'getSubscription', async () => ({ data: {
    subscription_id: 'sub', delivery_schedule: [
      { date: '2026-10-26', status: 'active' }, { date: '2026-10-27', status: 'paused' },
    ],
  } }));
  t.mock.method(matterApiService, 'getSubscriptionPauses', async () => ({ paused_days: [], resumed_days: [] }));
  const result = await previewSkipPauses({ matterSubscriptionId: 'sub', skippedDateKeys: ['2026-10-21'], weekendEnabled: true });
  assert.deepEqual(result.activeDeliveryDates, ['2026-10-26']);
  assert.equal(result.pauses[0].resumeDate, null);
  assert.equal('suggestedResumeDate' in result.pauses[0], false);
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

test('Matter weekend deliveries override a false internal flag, including when the weekend is paused', () => {
  assert.equal(matterWeekendEnabled({ delivery_schedule: [{ date: '2026-10-24', status: 'paused' }] }, false), true);
  assert.equal(matterWeekendEnabled({ delivery_schedule: [{ date: '2026-10-23', status: 'active' }] }, true), false);
  assert.equal(matterWeekendEnabled({}, true), true);
});

test('preview allows weekend selection without proposing any resume dates', async (t) => {
  t.mock.method(matterApiService, 'getSubscription', async () => ({ data: {
    subscription_id: 'sub', cycle_end_date: '2026-11-13', delivery_schedule: [
      { date: '2026-10-24', status: 'active' },
      { date: '2026-11-13', status: 'active' },
    ],
  } }));
  t.mock.method(matterApiService, 'getSubscriptionPauses', async () => ({}));
  const result = await previewSkipPauses({ matterSubscriptionId: 'sub', skippedDateKeys: ['2026-10-24'], weekendEnabled: false });
  assert.equal(result.weekendEnabled, true);
  assert.equal(result.pauses[0].resumeDate, null);
});

test('every paused day requires its own explicit resume date; a partial selection cannot submit', () => {
  const skippedDateKeys = ['2026-10-28', '2026-10-30', '2026-10-31'];
  const decisions = [
    { date: '2026-10-28', action: 'pause', resumeDate: '2026-11-12' },
    { date: '2026-10-30', action: 'pause', resumeDate: '2026-11-13' },
  ];
  assert.match(validateRequiredResumeDates({ skippedDateKeys, decisions }), /2026-10-31/);
  assert.match(validateRequiredResumeDates({ skippedDateKeys, decisions: [] }), /2026-10-28/);
  decisions.push({ date: '2026-10-31', action: 'pause', resumeDate: '2026-11-14' });
  assert.equal(validateRequiredResumeDates({ skippedDateKeys, decisions }), null);
});

test('invalid, duplicate, declined, or earlier resume dates are rejected; existing verified pauses need no new selection', () => {
  for (const resumeDate of [null, '2026-02-30', '2026-10-21', '2026-10-20']) {
    assert.ok(validateRequiredResumeDates({ skippedDateKeys: ['2026-10-21'], decisions: [{ date: '2026-10-21', action: 'pause', resumeDate }] }));
  }
  assert.ok(validateRequiredResumeDates({ skippedDateKeys: ['2026-10-21'], decisions: [{ date: '2026-10-21', action: 'decline', resumeDate: '2026-11-12' }] }));
  assert.ok(validateRequiredResumeDates({ skippedDateKeys: ['2026-10-21', '2026-10-22'], decisions: ['2026-10-21', '2026-10-22'].map((date) => ({ date, action: 'pause', resumeDate: '2026-11-12' })) }));
  assert.equal(validateRequiredResumeDates({ skippedDateKeys: ['2026-10-21'], decisions: [], alreadyPaused: new Set(['2026-10-21']) }), null);
});

test('Saturday preview includes Sunday without generating replacements', async (t) => {
  t.mock.method(matterApiService, 'getSubscription', async () => ({ data: {
    subscription_id: 'sub', cycle_end_date: '2026-11-20', delivery_schedule: [
      { date: '2026-10-31', status: 'active' },
      { date: '2026-11-01', status: 'active' },
      { date: '2026-11-13', status: 'active' },
    ],
  } }));
  t.mock.method(matterApiService, 'getSubscriptionPauses', async () => ({}));
  const result = await previewSkipPauses({ matterSubscriptionId: 'sub', skippedDateKeys: ['2026-10-31'] });
  assert.deepEqual(result.pauses.map((p) => [p.date, p.resumeDate]), [
    ['2026-10-31', null], ['2026-11-01', null],
  ]);
  const sundayOnly = await previewSkipPauses({ matterSubscriptionId: 'sub', skippedDateKeys: ['2026-11-01'] });
  assert.deepEqual(sundayOnly.pauses.map((p) => p.date), ['2026-11-01']);
});

test('Saturday never invents a Sunday delivery when the customer has none', () => {
  assert.deepEqual(expandSaturdaySkips(['2026-10-31'], ['2026-10-31']), ['2026-10-31']);
  assert.deepEqual(expandSaturdaySkips(['2026-11-01'], ['2026-10-31', '2026-11-01']), ['2026-11-01']);
});

test('a customer-chosen free date before cycle end is applied exactly without automatic replacement', async (t) => {
  t.mock.method(matterApiService, 'getSubscription', async () => ({ data: {
    cycle_end_date: '2026-12-30', delivery_schedule: [{ date: '2026-10-25', status: 'active' }],
  } }));
  const write = t.mock.method(matterApiService, 'createSubscriptionPause', async () => ({}));
  const result = await applyConfirmedPauses({ subscriptionId: 'sub', decisions: [
    { date: '2026-10-21', action: 'pause', resumeDate: '2026-10-23' },
  ] });
  assert.equal(result[0].pauseStatus, 'success');
  assert.deepEqual(write.mock.calls[0].arguments[1].chosenDays, ['2026-10-23']);
});
