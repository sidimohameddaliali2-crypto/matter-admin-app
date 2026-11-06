import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateReviewBatch, selectReviewCohort, classifyServiceTiming, validateReviewSubmission, validateActionUpdate } from './customerServicePolicy.js';
import { SERVICE_CATEGORIES } from '../config/customerServiceCategories.js';
const staff = (id, minutes = 60) => ({ userId: id, enabled: true, mode: 'reviewer', availableMinutes: minutes, user: { isActive: true, role: 'admin' } });
const cases = (n) => Array.from({ length: n }, (_, i) => ({ _id: String(i), contributorIds: [], createdAt: new Date(i) }));
test('taxonomy preserves ordering, renewal, coupons, meals and nutrition as separate categories', () => {
  const ids = SERVICE_CATEGORIES.map(c => c.id);
  for (const id of ['ordering', 'renewal', 'coupons_discounts', 'wrong_meals', 'wrong_nutrition']) assert.ok(ids.includes(id));
  assert.equal(ids.length, new Set(ids).size);
});
test('equal capacity alternates while unequal capacity shares work 1:2', () => {
  assert.deepEqual(allocateReviewBatch({ cases: cases(4), staff: [staff('a'), staff('b')] }).assignments.map(a => a.reviewerId), ['a', 'b', 'a', 'b']);
  const result = allocateReviewBatch({ cases: cases(6), staff: [staff('a'), staff('b', 120)], policy: { pendingCap: 8 } });
  assert.equal(result.assignments.filter(a => a.reviewerId === 'a').length, 2);
  assert.equal(result.assignments.filter(a => a.reviewerId === 'b').length, 4);
});
test('capacity, absence, self review, skipped staff and pending limits are respected', () => {
  const result = allocateReviewBatch({ cases: [{ _id: 'x', contributorIds: ['a'], skippedBy: ['b'] }], staff: [staff('a'), staff('b'), staff('c', 0), { ...staff('d'), user: { isActive: false } }] });
  assert.equal(result.assignments.length, 0);
  assert.equal(result.unassigned[0].reason, 'no_eligible_capacity');
  const full = allocateReviewBatch({ cases: cases(1), staff: [staff('a')], assignments: [{ reviewerId: 'a', status: 'in_review' }, { reviewerId: 'a', status: 'assigned' }, { reviewerId: 'a', status: 'assigned' }] });
  assert.equal(full.assignments.length, 0);
});
test('completed and skipped allocation credit is retained so skipping never earns preferential work', () => {
  const result = allocateReviewBatch({ cases: cases(1), staff: [staff('a'), staff('b')], assignedCounts: { a: 8, b: 1 } });
  assert.equal(result.assignments[0].reviewerId, 'b');
});
test('skipped independent calibration never returns to an original reviewer', () => {
  const result = allocateReviewBatch({ cases: [{ _id: 'independent', contributorIds: [], skippedBy: ['b'], excludedReviewerIds: ['a'] }], staff: [staff('a'), staff('b'), staff('c')] });
  assert.equal(result.assignments[0].reviewerId, 'c');
});
test('sampling is reproducible, keeps targeted separate and records the eligible denominator', () => {
  const issues = cases(8).map((c, i) => ({ ...c, priority: i < 4 ? 'urgent' : 'normal' }));
  const first = selectReviewCohort({ issues, seed: 'fixed', policy: { sampleSize: 3 } });
  assert.deepEqual(first, selectReviewCohort({ issues, seed: 'fixed', policy: { sampleSize: 3 } }));
  assert.equal(first.filter(c => c.sampleType === 'baseline').length, 3);
  assert.ok(first.some(c => c.sampleType === 'targeted'));
  assert.ok(first.every(c => c.eligibleDenominator === 8));
});
test('timing excludes known bots and retains unanswered and unknown attribution', () => {
  const messages = [{ authorType: 'customer', sentAt: '2026-11-06T10:00:00Z' }, { authorType: 'bot', sentAt: '2026-11-06T10:00:01Z' }, { authorType: 'staff', sentAt: '2026-11-06T10:05:00Z' }, { authorType: 'customer', sentAt: '2026-11-06T10:06:00Z' }];
  const result = classifyServiceTiming(messages);
  assert.equal(result.firstHumanReplySeconds, 300);
  assert.equal(result.unansweredCustomerMessages, 1);
  assert.equal(result.assignmentToReplySeconds, null);
  assert.equal(result.businessHoursWaitSeconds, null);
  assert.ok(classifyServiceTiming([...messages, { authorType: 'unknown', sentAt: '2026-11-06T10:07:00Z' }]).unknowns.includes('unknown_authors'));
});
test('negative grading requires supporting evidence and unknowns remain insufficient', () => {
  assert.throws(() => validateReviewSubmission({ verdict: 'needs_work', summary: 'Reason', categoryIds: [], outcome: 'open', evidenceMessageIds: [] }), /evidence/i);
  assert.throws(() => validateReviewSubmission({ verdict: 'good', summary: 'ok', categoryIds: ['invented'], outcome: 'resolved', evidenceMessageIds: [] }), /category/i);
  assert.equal(validateReviewSubmission({ verdict: 'insufficient', summary: 'Audio unavailable', categoryIds: [], outcome: 'unknown', evidenceMessageIds: [] }).verdict, 'insufficient');
});
test('waiting keeps promises and completion requires actual effect confirmation', () => {
  const action = { status: 'assigned', ownerId: 'a', dueAt: '2026-11-06T10:00:00Z', promisedDueAt: '2026-11-06T10:00:00Z' };
  assert.throws(() => validateActionUpdate(action, { status: 'waiting', reason: 'Supplier' }), /next check/i);
  assert.throws(() => validateActionUpdate(action, { status: 'completed', evidence: { note: 'We replied' } }), /actual/i);
  const update = validateActionUpdate(action, { status: 'waiting', reason: 'Supplier', nextCheckAt: '2026-11-07T10:00:00Z' });
  assert.equal(update.promisedDueAt, action.promisedDueAt);
  assert.equal(update.dueAt, action.dueAt);
});
