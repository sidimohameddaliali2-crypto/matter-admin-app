import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import User from '../models/User.js';
import Staff from '../models/ServiceStaffProfile.js';
import Conversation from '../models/ServiceConversation.js';
import Message from '../models/ServiceMessage.js';
import Issue from '../models/ServiceIssue.js';
import Review from '../models/ServiceReview.js';
import Action from '../models/ServiceAction.js';
import Command from '../models/ServiceCommand.js';
import Allocation from '../models/ServiceAllocationState.js';
import { claimNextReview, saveReviewDraft, submitServiceReview, skipServiceReview, reassignServiceReview, createServiceAction, updateServiceAction, allocateServiceReviews, configureServiceStaff, createServiceCalibration, getServiceIssueDetail, getScopedServiceData, requestServiceCorrection, resolveServiceCorrection, createServiceEpisode } from '../services/customerServiceWorkflow.js';

// CI must opt in to an isolated MongoDB replica set. Never use MONGODB_URI.
const uri = process.env.CUSTOMER_SERVICE_TEST_MONGODB_URI;
const enabled = Boolean(uri && process.env.CUSTOMER_SERVICE_TEST_ISOLATED === 'true');
const dbName = `matter_service_test_${randomUUID().replaceAll('-', '')}`;
let supervisor, reviewer, other, profile, otherProfile;
before(async () => {
  if (!enabled) return;
  await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 5000 });
  assert.equal(mongoose.connection.name, dbName);
  const identity = await mongoose.connection.db.admin().command({ hello: 1 });
  assert.ok(identity.setName, 'Transactions require an explicitly isolated replica set');
  await Promise.all([User, Staff, Conversation, Message, Issue, Review, Action, Command, Allocation].map(m => m.init()));
  const actors = await User.create(['supervisor', 'reviewer', 'other'].map(name => ({ email: `${name}@fixture.invalid`, password: randomUUID(), role: 'admin', isActive: true })));
  [supervisor, reviewer, other] = actors;
  const profiles = await Staff.create(actors.map((u, i) => ({ userId: u._id, mode: i === 0 ? 'supervisor' : 'reviewer', enabled: true, availableMinutes: 60, displayName: `Fixture ${i}` })));
  profile = profiles[1]; otherProfile = profiles[2];
});
after(async () => {
  if (!enabled) return;
  // Only this process's randomly named database collections can be removed.
  if (mongoose.connection.name === dbName) {
    for (const collection of await mongoose.connection.db.listCollections().toArray()) await mongoose.connection.db.collection(collection.name).drop();
  }
  await mongoose.disconnect();
});
const run = (name, fn) => test(name, { skip: !enabled }, fn);
const requestId = () => randomUUID();
async function fixture(owner = reviewer._id, overrides = {}) {
  const conversation = await Conversation.create({ source: 'fixture', scope: 'isolated', externalConversationId: requestId(), sourceRevision: 1 });
  const customerMessage = await Message.create({ source: 'fixture', scope: 'isolated', externalMessageId: requestId(), conversationId: conversation._id, authorType: 'customer', sentAt: new Date(Date.now() - 1000), type: 'text', text: 'Please correct my meal.' });
  const message = await Message.create({ source: 'fixture', scope: 'isolated', externalMessageId: requestId(), conversationId: conversation._id, authorId: supervisor._id, authorType: 'staff', sentAt: new Date(), type: 'text', text: 'We sent the wrong meal. Kitchen is preparing the correction.' });
  const issue = await Issue.create({ conversationId: conversation._id, customerId: 'fixture-customer', customerName: 'Fixture customer', sourceRevision: 1, evidenceMessageIds: [customerMessage._id, message._id], contributorIds: [supervisor._id], ...overrides });
  const review = await Review.create({ issueId: issue._id, reviewerId: owner, status: owner ? 'assigned' : 'pending', sourceRevision: 1 });
  return { conversation, issue, review, message, customerMessage };
}
async function claim() { return claimNextReview({ actor: reviewer, profile, requestId: requestId() }); }
function submission(active, message, extra = {}) { return { reviewId: active._id, version: active.version, sourceRevision: 1, verdict: 'needs_work', summary: 'Correction required', note: 'Wrong meal confirmed by customer', categoryIds: ['wrong_meals'], outcome: 'open', evidenceMessageIds: [message._id], confirmIssueBoundary: true, requestId: requestId(), actor: reviewer, profile, ...extra }; }

run('concurrent Next calls return one active review and retain the next assigned record', async () => {
  const a = await fixture(); const b = await fixture();
  const [one, two] = await Promise.all([claim(), claim()]);
  assert.equal(String(one._id), String(two._id));
  assert.equal(await Review.countDocuments({ reviewerId: reviewer._id, status: 'in_review' }), 1);
  assert.equal(await Review.countDocuments({ _id: { $in: [a.review._id, b.review._id] }, status: 'assigned' }), 1);
  await Review.updateMany({ reviewerId: reviewer._id }, { $set: { status: 'skipped', leaseUntil: null } });
});
run('duplicate submit returns committed result, preserves responder and creates one action', async () => {
  const f = await fixture(); const active = await claim(); const id = requestId();
  const args = submission(active, f.message, { requestId: id, action: { description: 'Confirm meal correction', ownerId: reviewer._id, dueAt: new Date(Date.now() + 3600000).toISOString() } });
  const [one, two] = await Promise.all([submitServiceReview(args), submitServiceReview(args)]);
  assert.equal(String(one.action._id), String(two.action._id));
  assert.equal(await Action.countDocuments({ reviewId: active._id }), 1);
  assert.equal((await Issue.findById(f.issue._id)).contributorIds[0].toString(), supervisor._id.toString());
  await assert.rejects(submitServiceReview({ ...args, actor: other, profile: otherProfile }), /another|request|scope|assigned/i);
});
run('expired lease retains draft and stale source revision blocks submission', async () => {
  const f = await fixture(); let active = await claim();
  await saveReviewDraft({ reviewId: active._id, version: active.version, draft: { summary: 'Retain this' }, actor: reviewer, profile });
  await Review.updateOne({ _id: active._id }, { $set: { leaseUntil: new Date(0) } });
  active = await claim();
  assert.equal(active.draft.summary, 'Retain this');
  await Issue.updateOne({ _id: f.issue._id }, { $inc: { sourceRevision: 1 } });
  await assert.rejects(submitServiceReview(submission(active, f.message)), /source|evidence|changed/i);
  assert.equal((await Review.findById(active._id)).status, 'in_review');
  await Review.updateOne({ _id: active._id }, { $set: { status: 'skipped' } });
});
run('failed action insertion rolls back review, issue changes and idempotency result', async () => {
  const f = await fixture(); const active = await claim();
  await Action.collection.createIndex({ description: 1 }, { unique: true, name: 'fixture_reject_duplicate_action' });
  const description = `duplicate-${requestId()}`;
  await Action.create({ issueId: f.issue._id, description, status: 'unassigned' });
  const args = submission(active, f.message, { action: { description, ownerId: reviewer._id, dueAt: new Date().toISOString() } });
  await assert.rejects(submitServiceReview(args));
  assert.equal((await Review.findById(active._id)).status, 'in_review');
  assert.equal((await Review.findById(active._id)).revisions.length, 0);
  assert.equal(await Command.countDocuments({ requestId: args.requestId }), 0);
  await Action.collection.dropIndex('fixture_reject_duplicate_action');
  await Review.updateOne({ _id: active._id }, { $set: { status: 'skipped' } });
});
run('self-review, wrong owner and stale versions cannot save or transfer work', async () => {
  const f = await fixture(reviewer._id, { contributorIds: [reviewer._id] });
  await assert.rejects(claim(), /self|contributor/i);
  await assert.rejects(reassignServiceReview({ reviewId: f.review._id, ownerId: other._id, reason: 'Transfer', version: 1, requestId: requestId(), actor: reviewer, profile }), /supervisor/i);
  await assert.rejects(saveReviewDraft({ reviewId: f.review._id, version: 0, draft: {}, actor: other, profile: otherProfile }), /assigned|scope/i);
  await Review.updateOne({ _id: f.review._id }, { $set: { status: 'skipped' } });
});
run('waiting and completion preserve the customer promise and record actual effect evidence', async () => {
  const f = await fixture(null);
  const dueAt = new Date(Date.now() + 3600000);
  const action = await Action.create({ issueId: f.issue._id, ownerId: reviewer._id, description: 'Deliver correction', status: 'assigned', dueAt, promisedDueAt: dueAt });
  const waiting = await updateServiceAction({ id: action._id, version: action.version, status: 'waiting', reason: 'Kitchen confirmation', nextCheckAt: new Date(Date.now() + 600000), requestId: requestId(), actor: reviewer, profile });
  assert.equal(new Date(waiting.promisedDueAt).getTime(), dueAt.getTime());
  await assert.rejects(updateServiceAction({ id: action._id, version: waiting.version, status: 'completed', evidence: { note: 'Replied' }, requestId: requestId(), actor: reviewer, profile }), /actual/i);
  const completed = await updateServiceAction({ id: action._id, version: waiting.version, status: 'completed', evidence: { note: 'Customer confirmed correct meal received', confirmedEffect: true }, requestId: requestId(), actor: reviewer, profile });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.history.at(-1).actorId.toString(), reviewer._id.toString());
});
run('two allocators serialize and cannot exceed pending caps or duplicate assignment', async () => {
  await Review.updateMany({}, { $set: { status: 'skipped' } });
  const unassigned = await Promise.all(Array.from({ length: 8 }, () => fixture(null)));
  const supProfile = await Staff.findOne({ userId: supervisor._id });
  await Staff.updateOne({ userId: supervisor._id }, { $set: { availableMinutes: 0 } });
  await Promise.all([allocateServiceReviews({ actor: supervisor, profile: supProfile, requestId: requestId() }), allocateServiceReviews({ actor: supervisor, profile: supProfile, requestId: requestId() })]);
  const assigned = await Review.find({ _id: { $in: unassigned.map(f => f.review._id) }, status: 'assigned' });
  assert.equal(assigned.length, 4);
  for (const id of [reviewer._id, other._id]) assert.equal(assigned.filter(r => r.reviewerId.toString() === id.toString()).length, 2);
});
run('skipping preserves history, draft and assignment credit without completing the review', async () => {
  await Review.updateMany({}, { $set: { status: 'skipped' } });
  const f = await fixture(); let active = await claim();
  active = await saveReviewDraft({ reviewId: active._id, version: active.version, draft: { summary: 'Need more evidence' }, actor: reviewer, profile });
  const skipped = await skipServiceReview({ reviewId: active._id, version: active.version, reason: 'Unclear sender', requestId: requestId(), actor: reviewer, profile });
  assert.equal(skipped.status, 'pending');
  assert.equal(skipped.reviewerId, null);
  assert.equal(skipped.draft.summary, 'Need more evidence');
  assert.ok(skipped.skippedBy.some(id => id.toString() === reviewer._id.toString()));
  assert.equal(skipped.revisions.length, 0);
  assert.equal(String(skipped.issueId._id || skipped.issueId), String(f.issue._id));
});
run('an empty Next result is durable and safely replayed', async () => {
  await Review.updateMany({}, { $set: { status: 'skipped' } });
  const args = { actor: reviewer, requestId: requestId() };
  assert.equal(await claimNextReview(args), null);
  assert.equal(await claimNextReview(args), null);
  assert.equal(await Command.countDocuments({ requestId: args.requestId }), 1);
});
run('unmapped source staff cannot be graded negatively or positively', async () => {
  const f = await fixture(reviewer._id, { sourceMetadata: { unmappedStaff: true } });
  const active = await claim();
  await assert.rejects(submitServiceReview(submission(active, f.message)), /attribution|mapping/i);
  const saved = await submitServiceReview(submission(active, f.message, { verdict: 'insufficient', outcome: 'unknown', note: 'Sender mapping unavailable' }));
  assert.equal(saved.review.status, 'awaiting_evidence');
  assert.equal(saved.review.revisions.at(-1).verdict, 'insufficient');
});
run('calibration is blind to other reviewers and leaves canonical issue unchanged', async () => {
  await Review.updateMany({}, { $set: { status: 'skipped' } });
  const f = await fixture(); const active = await claim();
  await submitServiceReview(submission(active, f.message));
  const supProfile = await Staff.findOne({ userId: supervisor._id });
  await createServiceCalibration({ actor: supervisor, profile: supProfile, reviewId: active._id, ownerId: other._id, requestId: requestId() });
  const independent = await claimNextReview({ actor: other, requestId: requestId() });
  const detail = await getServiceIssueDetail({ issueId: f.issue._id, actor: other, profile: otherProfile });
  assert.equal(detail.reviews.length, 1);
  assert.equal(detail.reviews[0].sampleType, 'calibration');
  await submitServiceReview(submission(independent, f.message, { actor: other, profile: otherProfile, summary: 'Independent calibration summary' }));
  assert.equal((await Issue.findById(f.issue._id)).summary, 'Correction required');
});
run('supervisor correction retains the original submission when reopening for rework', async () => {
  await Review.updateMany({}, { $set: { status: 'skipped' } });
  const f = await fixture(); const active = await claim();
  const saved = await submitServiceReview(submission(active, f.message));
  const requested = await requestServiceCorrection({ actor: reviewer, reviewId: active._id, version: saved.review.version, reason: 'Check source timing', requestId: requestId() });
  await assert.rejects(resolveServiceCorrection({ actor: reviewer, reviewId: active._id, index: 0, version: requested.version, decision: 'rework', resolution: 'Recheck', requestId: requestId() }), /supervisor/i);
  const resolved = await resolveServiceCorrection({ actor: supervisor, reviewId: active._id, index: 0, version: requested.version, decision: 'rework', resolution: 'Review time evidence again', ownerId: reviewer._id, requestId: requestId() });
  assert.equal(resolved.status, 'assigned');
  assert.equal(resolved.revisions.length, 1);
  assert.equal(resolved.correctionRequests[0].status, 'resolved');
  assert.equal(resolved.draft.summary, 'Correction required');
});
run('a supervisor doing calibration cannot read the prior reviewer judgement through list, claim or detail', async () => {
  await Review.updateMany({}, { $set: { status: 'skipped' } });
  const f = await fixture(reviewer._id, { contributorIds: [other._id] }); const active = await claim();
  await submitServiceReview(submission(active, f.message));
  await Staff.updateOne({ userId: supervisor._id }, { $set: { availableMinutes: 60 } });
  await createServiceCalibration({ actor: supervisor, reviewId: active._id, ownerId: supervisor._id, requestId: requestId() });
  const independent = await claimNextReview({ actor: supervisor, requestId: requestId() });
  assert.equal(independent.issue.summary, '');
  const supProfile = await Staff.findOne({ userId: supervisor._id });
  const detail = await getServiceIssueDetail({ issueId: f.issue._id, actor: supervisor, profile: supProfile });
  assert.equal(detail.reviews.length, 1);
  assert.equal(detail.issue.summary, '');
  const list = await getScopedServiceData({ actor: supervisor, profile: supProfile });
  assert.equal(list.reviews.filter(r => String(r.issueId) === String(f.issue._id)).length, 1);
});
run('two confirmed episodes in a conversation stay separate without copying source messages', async () => {
  await Review.updateMany({}, { $set: { status: 'skipped' } });
  const f = await fixture(); const active = await claim();
  await submitServiceReview(submission(active, f.message));
  const customer = await Message.create({ source: 'fixture', scope: 'isolated', externalMessageId: requestId(), conversationId: f.conversation._id, authorType: 'customer', sentAt: new Date(Date.now() + 1000), type: 'text', text: 'My coupon also failed.' });
  const reply = await Message.create({ source: 'fixture', scope: 'isolated', externalMessageId: requestId(), conversationId: f.conversation._id, authorId: supervisor._id, authorType: 'staff', sentAt: new Date(Date.now() + 2000), type: 'text', text: 'Checking your coupon.' });
  const original = await Issue.findById(f.issue._id);
  const args = { actor: supervisor, issueId: original._id, version: original.version, evidenceMessageIds: [customer._id, reply._id], summary: 'Coupon problem', categoryIds: ['coupons_discounts'], requestId: requestId() };
  const episode = await createServiceEpisode(args);
  assert.notEqual(String(episode.issue._id), String(original._id));
  assert.equal(await Issue.countDocuments({ conversationId: original.conversationId }), 2);
  assert.equal(await Message.countDocuments({ conversationId: original.conversationId }), 4);
  assert.equal(episode.review.sampleType, 'targeted');
  assert.equal(episode.issue.contributorIds[0].toString(), supervisor._id.toString());
  assert.equal(String((await createServiceEpisode(args)).issue._id), String(episode.issue._id));
  await assert.rejects(createServiceEpisode({ ...args, actor: reviewer, requestId: requestId() }), /supervisor/i);
});
run('live membership enforcement denies inactive owners, disabled reviewers and supervisor promotion by ordinary members', async () => {
  await Review.updateMany({}, { $set: { status: 'skipped' } });
  const settings = { actor: supervisor, userId: reviewer._id, mode: 'reviewer', enabled: true, availableMinutes: 60, displayName: 'Fixture reviewer', externalAuthorIds: ['fixture:isolated:sender-one'] };
  await assert.rejects(configureServiceStaff({ ...settings, actor: reviewer, mode: 'supervisor' }), /super administrator/i);
  await assert.rejects(configureServiceStaff({ ...settings, mode: 'supervisor' }), /super administrator/i);
  await configureServiceStaff(settings);
  await assert.rejects(configureServiceStaff({ ...settings, userId: other._id }), /already mapped/i);
  await configureServiceStaff({ ...settings, enabled: false });
  await assert.rejects(claim(), /membership/i);
  await configureServiceStaff(settings);
  await User.updateOne({ _id: reviewer._id }, { $set: { isActive: false } });
  await assert.rejects(claim(), /active staff/i);
  await User.updateOne({ _id: reviewer._id }, { $set: { isActive: true } });
});
run('isolated Mongo allocation gives a 1:2 share for declared 60:120 minute capacity', async () => {
  await Review.updateMany({}, { $set: { status: 'skipped' } });
  await Staff.updateOne({ userId: supervisor._id }, { $set: { availableMinutes: 0 } });
  await Staff.updateOne({ userId: other._id }, { $set: { availableMinutes: 120 } });
  const fixtures = await Promise.all(Array.from({ length: 3 }, () => fixture(null)));
  const result = await allocateServiceReviews({ actor: supervisor, requestId: requestId(), now: new Date(Date.now() + 3 * 86400000) });
  assert.equal(result.assignments.length, 3);
  const assigned = await Review.find({ _id: { $in: fixtures.map(f => f.review._id) } });
  assert.equal(assigned.filter(r => r.reviewerId.toString() === reviewer._id.toString()).length, 1);
  assert.equal(assigned.filter(r => r.reviewerId.toString() === other._id.toString()).length, 2);
});
run('customer-only evidence cannot silently grade every original responder', async () => {
  await Review.updateMany({}, { $set: { status: 'skipped' } });
  const f = await fixture(); const active = await claim();
  await assert.rejects(submitServiceReview(submission(active, f.customerMessage)), /human staff message/i);
  assert.equal((await Review.findById(active._id)).revisions.length, 0);
});
run('a new follow-up atomically reopens a resolved issue and retry does not duplicate the obligation', async () => {
  const f = await fixture(reviewer._id, { outcome: 'resolved' });
  const args = { actor: reviewer, issueId: f.issue._id, description: 'Follow up on missing replacement', ownerId: reviewer._id, dueAt: new Date(Date.now() + 3600000), requestId: requestId() };
  const action = await createServiceAction(args);
  const reopened = await Issue.findById(f.issue._id);
  assert.equal(reopened.outcome, 'open');
  assert.equal(reopened.version, f.issue.version + 1);
  assert.equal(String((await createServiceAction(args))._id), String(action._id));
  assert.equal(await Action.countDocuments({ issueId: f.issue._id }), 1);
  assert.equal((await Issue.findById(f.issue._id)).version, reopened.version);
});
run('disabled staff mappings stay unique, access stays denied and non-staff targets cannot be enrolled', async () => {
  const settings = { actor: supervisor, userId: reviewer._id, mode: 'reviewer', enabled: false, availableMinutes: 0, displayName: 'Historical responder', externalAuthorIds: ['fixture:isolated:historical-sender'] };
  await configureServiceStaff(settings);
  await assert.rejects(configureServiceStaff({ ...settings, userId: other._id, enabled: true }), /already mapped/i);
  await assert.rejects(claim(), /membership/i);
  const driver = await User.create({ email: 'driver-fixture@fixture.invalid', password: randomUUID(), role: 'driver', isActive: true });
  await assert.rejects(configureServiceStaff({ ...settings, userId: driver._id, externalAuthorIds: [] }), /staff role/i);
  await configureServiceStaff({ ...settings, enabled: true, availableMinutes: 60 });
});
run('dated capacity is preserved, real dates validated and every manual assignment respects it', async () => {
  await Review.updateMany({}, { $set: { status: 'skipped' } });
  const settings = { actor: supervisor, userId: reviewer._id, mode: 'reviewer', enabled: true, availableMinutes: 60, displayName: 'Dated reviewer', externalAuthorIds: [] };
  await assert.rejects(configureServiceStaff({ ...settings, availabilityDate: '2026-02-30' }), /date/i);
  await configureServiceStaff({ ...settings, availabilityDate: '2001-02-03' });
  assert.equal((await configureServiceStaff(settings)).availabilityDate, '2001-02-03');
  const f = await fixture(other._id);
  await assert.rejects(reassignServiceReview({ actor: supervisor, reviewId: f.review._id, version: f.review.version, ownerId: reviewer._id, reason: 'Test dated capacity', requestId: requestId() }), /availability|service date/i);
  await assert.rejects(createServiceCalibration({ actor: supervisor, reviewId: f.review._id, ownerId: reviewer._id, requestId: requestId() }), /availability|service date/i);
  await Review.updateOne({ _id: f.review._id }, { $set: { status: 'submitted' }, $push: { revisions: { actorId: other._id, at: new Date(), sourceRevision: 1, verdict: 'insufficient', summary: 'Fixture submission', outcome: 'unknown', evidenceMessageIds: [] }, correctionRequests: { actorId: other._id, at: new Date(), reason: 'Recheck', status: 'open' } } });
  await assert.rejects(resolveServiceCorrection({ actor: supervisor, reviewId: f.review._id, index: 0, version: f.review.version, ownerId: reviewer._id, decision: 'rework', resolution: 'Test dated capacity', requestId: requestId() }), /availability|service date/i);
  await configureServiceStaff({ ...settings, availabilityDate: null });
});
run('skipped calibration permanently excludes all original reviewers and revisions', async () => {
  await Review.updateMany({}, { $set: { status: 'skipped' } });
  await Staff.updateOne({ userId: other._id }, { $set: { availableMinutes: 60 } });
  const f = await fixture(); const active = await claim();
  await submitServiceReview(submission(active, f.message));
  const independent = await createServiceCalibration({ actor: supervisor, reviewId: active._id, ownerId: other._id, requestId: requestId() });
  assert.ok(independent.excludedReviewerIds.some(id => String(id) === String(reviewer._id)));
  const claimed = await claimNextReview({ actor: other, requestId: requestId() });
  const skipped = await skipServiceReview({ actor: other, reviewId: claimed._id, version: claimed.version, reason: 'Evidence unclear', requestId: requestId() });
  const allocation = await allocateServiceReviews({ actor: supervisor, requestId: requestId() });
  assert.ok(!allocation.assignments.some(a => String(a.reviewId) === String(skipped._id)));
  await assert.rejects(reassignServiceReview({ actor: supervisor, reviewId: skipped._id, version: skipped.version, ownerId: reviewer._id, reason: 'Return to original', requestId: requestId() }), /independent|original reviewer/i);
  await Review.updateOne({ _id: active._id }, { $push: { revisions: { actorId: other._id, at: new Date(), sourceRevision: 1, verdict: 'insufficient', summary: 'Prior opinion', outcome: 'unknown' } } });
  await assert.rejects(createServiceCalibration({ actor: supervisor, reviewId: active._id, ownerId: other._id, requestId: requestId() }), /independent|original reviewer/i);
});
run('only the action owner acknowledges seen, and transfer resets prior acknowledgement', async () => {
  const f = await fixture(null);
  const action = await Action.create({ issueId: f.issue._id, ownerId: reviewer._id, description: 'Seen acknowledgement fixture', status: 'assigned', dueAt: new Date(Date.now() + 3600000) });
  const supervised = await updateServiceAction({ actor: supervisor, id: action._id, version: action.version, status: 'in_progress', note: 'Supervisor check', requestId: requestId() });
  assert.ok(!supervised.seenAt);
  const acknowledged = await updateServiceAction({ actor: reviewer, id: action._id, version: supervised.version, status: 'in_progress', note: 'Owner started', requestId: requestId() });
  assert.ok(acknowledged.seenAt);
  const transferred = await updateServiceAction({ actor: supervisor, id: action._id, version: acknowledged.version, status: 'assigned', ownerId: other._id, reason: 'Shift handoff', requestId: requestId() });
  assert.equal(transferred.seenAt, null);
  const checked = await updateServiceAction({ actor: supervisor, id: action._id, version: transferred.version, status: 'in_progress', note: 'Supervisor checked transfer', requestId: requestId() });
  assert.equal(checked.seenAt, null);
  const accepted = await updateServiceAction({ actor: other, id: action._id, version: checked.version, status: 'in_progress', note: 'New owner started', requestId: requestId() });
  assert.ok(accepted.seenAt);
});
run('readable customer text cannot turn unavailable staff audio into a handling grade', async () => {
  await Review.updateMany({}, { $set: { status: 'skipped' } });
  const f = await fixture();
  await Message.updateOne({ _id: f.message._id }, { $set: { type: 'audio', text: '', mediaState: 'unavailable' } });
  const active = await claim();
  const args = submission(active, f.message, { evidenceMessageIds: [f.customerMessage._id, f.message._id] });
  await assert.rejects(submitServiceReview(args), /available evidence.*assessed staff/i);
  await assert.rejects(submitServiceReview({ ...args, verdict: 'good', requestId: requestId() }), /available evidence.*assessed staff/i);
  assert.equal((await Review.findById(active._id)).revisions.length, 0);
  assert.equal(await Command.countDocuments({ requestId: args.requestId }), 0);
  const unknown = await submitServiceReview({ ...args, verdict: 'insufficient', outcome: 'unknown', note: 'The staff voice recording is unavailable', requestId: requestId() });
  assert.equal(unknown.review.status, 'awaiting_evidence');
});
run('each assessed staff member needs their own readable text or verified available media', async () => {
  await Review.updateMany({}, { $set: { status: 'skipped' } });
  const f = await fixture(reviewer._id, { contributorIds: [supervisor._id, other._id] });
  const missingVoice = await Message.create({ source: 'fixture', scope: 'isolated', externalMessageId: requestId(), conversationId: f.conversation._id, authorId: other._id, authorType: 'staff', sentAt: new Date(), type: 'audio', text: 'Audio file unavailable', mediaState: 'missing' });
  const active = await claim();
  const args = submission(active, f.message, { evidenceMessageIds: [f.customerMessage._id, f.message._id, missingVoice._id] });
  await assert.rejects(submitServiceReview(args), /available evidence.*assessed staff/i);
  assert.equal((await Review.findById(active._id)).revisions.length, 0);
  // This test-owned update represents a subsequently verified media resource;
  // normal imports cannot manufacture media availability from a placeholder.
  await Message.updateOne({ _id: missingVoice._id }, { $set: { text: '', mediaState: 'available' } });
  const saved = await submitServiceReview(args);
  assert.deepEqual(saved.review.revisions.at(-1).assessedContributorIds.map(String).sort(), [supervisor._id, other._id].map(String).sort());
  assert.equal(saved.review.status, 'submitted');
});
