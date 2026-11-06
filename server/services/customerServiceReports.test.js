import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeServiceSnapshot } from './customerServiceReports.js';
import { captureRange, normalizeServiceMessage } from './customerServiceCaptureFormat.js';

const asOf = '2026-11-06T08:00:00.000Z';
const revision = (verdict, extra = {}) => ({
  at: '2026-11-06T07:00:00.000Z', sourceRevision: 2, verdict,
  summary: 'Evidence-backed judgment', provisional: false, ...extra,
});
function reportFixture() {
  return {
    asOf, filters: { from: '2026-11-06', to: '2026-11-06' },
    issues: [
      { _id: 'issue-1', conversationId: 'thread-1', customerId: 'customer-1', categoryIds: ['ordering', 'coupons_discounts'], outcome: 'resolved', evidenceState: 'available' },
      { _id: 'issue-2', conversationId: 'thread-1', customerId: 'customer-1', categoryIds: ['wrong_meals'], outcome: 'open', evidenceState: 'partial' },
      { _id: 'issue-3', conversationId: 'thread-2', customerId: '', categoryIds: [], outcome: 'unknown', evidenceState: 'missing' },
      { _id: 'issue-4', conversationId: 'thread-3', customerId: 'customer-3', categoryIds: ['renewal'], outcome: 'open', evidenceState: 'available' },
    ],
    reviews: [
      { _id: 'review-1', issueId: 'issue-1', reviewerId: 'staff-1', status: 'submitted', sampleType: 'baseline', stale: false, revisions: [revision('needs_work'), revision('good')] },
      { _id: 'review-2', issueId: 'issue-1', reviewerId: 'staff-2', status: 'submitted', sampleType: 'calibration', stale: false, revisions: [revision('needs_work')] },
      { _id: 'review-3', issueId: 'issue-2', reviewerId: 'staff-1', status: 'submitted', sampleType: 'baseline', stale: false, revisions: [revision('good', { provisional: true })] },
      { _id: 'review-4', issueId: 'issue-3', reviewerId: 'staff-1', status: 'submitted', sampleType: 'targeted', stale: false, revisions: [revision('insufficient')] },
      { _id: 'review-5', issueId: 'issue-4', reviewerId: 'staff-2', status: 'submitted', sampleType: 'targeted', stale: true, revisions: [revision('needs_work')] },
      { _id: 'review-6', issueId: 'issue-4', reviewerId: 'staff-2', status: 'assigned', sampleType: 'baseline', stale: false, revisions: [] },
    ],
    actions: [
      { _id: 'action-1', issueId: 'issue-1', ownerId: 'staff-1', status: 'completed', dueAt: '2026-11-05T08:00:00.000Z' },
      { _id: 'action-2', issueId: 'issue-2', ownerId: 'staff-1', status: 'waiting', dueAt: '2026-11-06T07:00:00.000Z', nextCheckAt: '2026-11-07T08:00:00.000Z' },
      { _id: 'action-3', issueId: 'issue-2', ownerId: null, status: 'unassigned' },
      { _id: 'action-4', issueId: 'issue-3', ownerId: 'staff-2', status: 'assigned', dueAt: '2026-11-07T08:00:00.000Z' },
      { _id: 'action-5', issueId: 'issue-4', ownerId: 'staff-1', status: 'in_progress', dueAt: asOf },
    ],
    profiles: [
      { userId: { _id: 'staff-1', profile: { firstName: 'Fixture', lastName: 'One' } }, displayName: 'Reviewer one', availableMinutes: 60 },
      { userId: { _id: 'staff-2', profile: { firstName: 'Fixture', lastName: 'Two' } }, displayName: 'Reviewer two', availableMinutes: 120 },
    ],
    capture: { createdAt: '2026-11-06T06:00:00.000Z', from: '2026-11-05T20:00:00.000Z', to: '2026-11-06T20:00:00.000Z', status: 'completed' },
  };
}

test('coverage counts unique issues once despite multiple categories, reviews and submitted revisions', () => {
  const snapshot = reportFixture();

  const report = summarizeServiceSnapshot(snapshot);

  assert.equal(report.coverage.eligible, 4);
  assert.equal(report.coverage.reviewed, 4);
  assert.equal(report.reviewWorkload.reduce((total, row) => total + row.reviewed, 0), 5);
  assert.equal(report.asOf, asOf);
});

test('latest submitted evidence exposes insufficient, provisional and stale judgments separately', () => {
  const snapshot = reportFixture();

  const report = summarizeServiceSnapshot(snapshot);

  assert.equal(report.coverage.insufficient, 1);
  assert.equal(report.coverage.provisional, 1);
  assert.equal(report.coverage.stale, 1);
});

test('final quality excludes calibration, provisional, insufficient and stale reviews', () => {
  const snapshot = reportFixture();

  const report = summarizeServiceSnapshot(snapshot);

  assert.deepEqual(report.quality.baseline, { assessed: 1, good: 1, needsWork: 0 });
  assert.deepEqual(report.quality.targeted, { assessed: 0, good: 0, needsWork: 0 });
});

test('baseline and targeted quality keep their own denominators and use the latest revision', () => {
  const snapshot = reportFixture();
  snapshot.reviews[4].stale = false;
  snapshot.reviews[4].revisions.push(revision('good'));

  const report = summarizeServiceSnapshot(snapshot);

  assert.deepEqual(report.quality.baseline, { assessed: 1, good: 1, needsWork: 0 });
  assert.deepEqual(report.quality.targeted, { assessed: 1, good: 1, needsWork: 0 });
});

test('waiting does not remove overdue promises and completed actions do not inflate backlog', () => {
  const snapshot = reportFixture();

  const report = summarizeServiceSnapshot(snapshot);

  assert.deepEqual(report.actions, { open: 4, overdue: 1, unassigned: 1 });
  assert.deepEqual(report.reviewWorkload.map(row => ({
    userId: row.userId, availableMinutes: row.availableMinutes, reviewed: row.reviewed,
    remaining: row.remaining, openActions: row.openActions, overdueActions: row.overdueActions,
  })), [
    { userId: 'staff-1', availableMinutes: 60, reviewed: 3, remaining: 0, openActions: 2, overdueActions: 1 },
    { userId: 'staff-2', availableMinutes: 120, reviewed: 2, remaining: 1, openActions: 1, overdueActions: 0 },
  ]);
});

test('empty capture remains visibly unknown and cannot imply live coverage or completed review work', () => {
  const snapshot = { issues: [], reviews: [], actions: [], profiles: [], capture: null, asOf, filters: {} };

  const report = summarizeServiceSnapshot(snapshot);

  assert.equal(report.coverage.eligible, 0);
  assert.equal(report.coverage.reviewed, 0);
  assert.equal(report.capture.lastSuccessAt, null);
  assert.match(report.capture.status, /no capture|unknown|not verified/i);
});

test('report date boundaries use Dubai midnight independently of the process timezone', () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    const range = captureRange({ from: '2026-11-06', to: '2026-11-06' });

    assert.equal(range.from.toISOString(), '2026-11-05T20:00:00.000Z');
    assert.equal(range.to.toISOString(), '2026-11-06T20:00:00.000Z');
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});

test('invalid and reversed report dates fail instead of producing an all-dates report', () => {
  for (const filters of [
    { from: '2026-02-30', to: '2026-03-01' },
    { from: '2026-11-07', to: '2026-11-06' },
    { from: '2026-11-06' },
    { from: '06/11/2026', to: '06/11/2026' },
  ]) {
    assert.throws(() => captureRange(filters), /date|range/i);
  }
});

test('impossible message calendar dates cannot silently roll into another service day', () => {
  const base = { externalMessageId: 'fixture-message', externalConversationId: 'fixture-thread', text: 'Evidence', type: 'text' };

  for (const sentAt of ['2026-02-29T08:00:00Z', '2026-02-30T08:00:00+04:00', '2026-04-31T08:00:00Z', '2026-11-06T25:00:00Z']) {
    assert.throws(() => normalizeServiceMessage({ ...base, sentAt }, { source: 'fixture', scope: 'isolated' }), /date|time/i, sentAt);
  }
});
