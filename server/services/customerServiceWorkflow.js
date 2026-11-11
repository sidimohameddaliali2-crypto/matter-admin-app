import {withConversationHistory} from './customerServiceConversationHistory.js';
import {isVerifiedServiceActor} from './customerServiceStaffAuth.js';
import {sourceStaffDirectory,sourceStaffIdentity,sourceStaffUser,sourceStaffUsers} from './customerServiceStaffDirectory.js';
import {cloudWorkflowEnabled,cloudWorkflowTransaction} from './customerServiceCloudWorkflow.js';
import {readCloudEvidence} from './customerServiceCloudEvidence.js';
import {publishCloudInbox,cloudInbox,cloudSqlText as lit} from './customerServiceCloudStore.js';
import {messageDisplay} from './customerServiceInbox.js';
import {isServiceStaffReply} from './customerServiceMessageEvidence.js';
import mongoose from 'mongoose';
import { createHash, randomUUID } from 'node:crypto';
import User from '../models/User.js';
import Staff from '../models/ServiceStaffProfile.js';
import Issue from '../models/ServiceIssue.js';
import Message from '../models/ServiceMessage.js';
import Review from '../models/ServiceReview.js';
import Action from '../models/ServiceAction.js';
import Command from '../models/ServiceCommand.js';
import Allocation from '../models/ServiceAllocationState.js';
import { SERVICE_CATEGORY_IDS, SERVICE_RUBRIC_VERSION, SERVICE_TAXONOMY_VERSION } from '../config/customerServiceCategories.js';
import { getServiceSnapshot, getServiceIssueFilter } from './customerServiceReports.js';
import { captureRange } from './customerServiceCaptureFormat.js';
import { SERVICE_POLICY, SERVICE_STAFF_ROLES, serviceId, serviceError, getServiceCapabilities, assertServiceRecordAccess, allocateReviewBatch, selectReviewCohort, validateReviewSubmission, validateActionUpdate } from './customerServicePolicy.js';

const fail = (message, code = 409) => { throw serviceError(message, code); };
const oid = value => /^[a-f\d]{24}$/i.test(serviceId(value));
const validId = (value, label = 'record') => { if (!oid(value)) fail(`Invalid ${label} ID.`, 400); return serviceId(value); };
const validVersion = value => { if (!Number.isInteger(value) || value < 1) fail('Provide the current record version.', 400); };
const text = (value, max = 4000) => typeof value === 'string' && value.trim() && value.length <= max;
const asDate = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value) : null;
const plain = value => value?.toObject ? value.toObject() : value;
export const serviceDateKey = (now = new Date()) => new Date(new Date(now).getTime() + 4 * 3600000).toISOString().slice(0, 10);
const name = user => [user?.profile?.firstName, user?.profile?.lastName].filter(Boolean).join(' ') || 'Unnamed staff';

function canonical(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (value._bsontype === 'ObjectId') return String(value);
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export async function context(actor, session) {
  validId(actor?._id, 'actor');
  const user = isVerifiedServiceActor(actor) ? actor : await User.findById(actor._id).select('role isActive profile permissions permissionsConfigured').session(session).lean();
  const profile = await Staff.findOne({ userId: actor._id }).session(session).lean();
  if (!user?.isActive) fail('Active staff authentication required.', 403);
  return { actor: user, profile, capabilities: getServiceCapabilities(user, profile) };
}
function membership(ctx) { if (!ctx.capabilities.view) fail('Active customer-service membership required.', 403); }
function supervisor(ctx) { if (!ctx.capabilities.supervise) fail('A customer-service supervisor must perform this operation.', 403); }

async function ensureAllocationState() {
  // Provision lazily on the first authorized command. Unique _id arbitrates
  // concurrent first use across processes without an in-memory mutex.
  try { await Allocation.updateOne({ _id: 'global' }, { $setOnInsert: { version: 0, cursor: 0 } }, { upsert: true }); }
  catch (error) { if (error.code !== 11000) throw error; }
}
export async function mutate({ actor, requestId, kind, payload = {}, setup = false }, operation) {
  if (kind !== 'draft' && requestId === undefined) fail('Provide a stable request ID before saving this command.', 400);
  if (requestId !== undefined && (typeof requestId !== 'string' || !/^[a-zA-Z0-9:._-]{8,180}$/.test(requestId))) fail('Provide a stable request ID of 8–180 letters, digits or :._-.', 400);
  const key = requestId, hash = fingerprint({ kind, payload });
  if(cloudWorkflowEnabled())return cloudWorkflowTransaction(async()=>{
    const ctx=await context(actor,null);if(!setup)membership(ctx);
    if(key){const prior=await Command.findOne({requestId:key}).lean();if(prior){if(serviceId(prior.actorId)!==serviceId(actor._id)||prior.kind!==kind||prior.fingerprint!==hash)fail('Request ID was already used for another actor or command.');return prior.result;}}
    await ensureAllocationState();
    const state=await Allocation.findOneAndUpdate({_id:'global'},{$inc:{version:1}},{new:true});
    const result=await operation(ctx,null,state);
    if(key)await Command.create([{requestId:key,actorId:actor._id,kind,fingerprint:hash,result:plain(result)}]);
    return result;
  });
  await cloudInbox()?.refresh?.();
  await ensureAllocationState();
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      // Acquiring the shared write before reading the queue makes claims,
      // membership changes and allocation serializable across PM2 workers.
      const state = await Allocation.findOneAndUpdate({ _id: 'global' }, { $inc: { version: 1 } }, { new: true, session });
      const ctx = await context(actor, session);
      if (!setup) membership(ctx);
      if (key) {
        const prior = await Command.findOne({ requestId: key }).session(session).lean();
        if (prior) {
          if (serviceId(prior.actorId) !== serviceId(actor._id) || prior.kind !== kind || prior.fingerprint !== hash) fail('Request ID was already used for another actor or command.');
          result = prior.result;
          return;
        }
      }
      result = await operation(ctx, session, state);
      if (key) await Command.create([{ requestId: key, actorId: actor._id, kind, fingerprint: hash, result: plain(result) }], { session });
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 10000 });
    await publishCloudInbox();
    return result;
  } catch (error) {
    // Transactions are required. Never fall back to separate unsafe writes.
    if (error.code === 20 || /Transaction numbers are only allowed|replica set member/i.test(error.message || '')) fail('Customer-service writes require MongoDB transaction support. Nothing was saved.', 503);
    throw error;
  } finally { await session.endSession(); }
}

async function reviewWithIssue(review, session) {
  if (!review) return null;
  const record = plain(review);
  const issue = await Issue.findById(record.issueId).session(session).lean();
  return { ...record, issue: record.sampleType === 'calibration' && !record.revisions?.length ? blindIssue(issue) : issue };
}
async function getReview(id, session) {
  validId(id, 'review');
  const review = await Review.findById(id).session(session);
  if (!review) fail('Review not found.', 404);
  return review;
}
function ownReview(ctx, review) { assertServiceRecordAccess({ ...ctx, record: review, operation: 'review' }); }
async function noSelfReview(actor, issue) {
  if(cloudWorkflowEnabled() && await cloudInbox().store.query(`SELECT EXISTS(SELECT 1 FROM gallabox_private.inbox_record m JOIN gallabox_private.inbox_record p ON p.kind='servicestaffprofiles' AND p.body->>'userId'=${lit(serviceId(actor._id))} WHERE m.kind='servicemessages' AND m.body->>'conversationId'=${lit(serviceId(issue.conversationId))} AND p.body->'externalAuthorIds' ? ((m.body->>'source')||':'||(m.body->>'scope')||':'||(m.body->>'externalAuthorId')))`)) fail('Self-review is not allowed: this staff member contributed to the conversation.',403);
  if ((issue.contributorIds || []).some(id => serviceId(id) === serviceId(actor._id))) fail('Self-review is not allowed: this staff member contributed to the conversation.', 403);
}
function independentReviewer(review, reviewerId) {
  if ((review.excludedReviewerIds || []).some(id => serviceId(id) === serviceId(reviewerId))) fail('Independent calibration cannot be assigned to an original reviewer.', 403);
}
function currentReview(review, version, now) {
  validVersion(version);
  if (review.version !== version) fail('The review changed. Reload it before saving.');
  if (review.status !== 'in_review') fail('Start this assigned review before saving.');
  if (!review.leaseUntil || review.leaseUntil <= now) fail('The review lease expired. Reload the current review; its draft is retained.');
}
export async function eligibleOwner(ownerId, session) {
  validId(ownerId, 'owner');
  const source=await sourceStaffIdentity(ownerId);
  if(source){const profile=await Staff.findOne({userId:ownerId}).session(session).lean();if(!profile?.enabled || !await sourceStaffUser(ownerId))fail('Choose an active staff member with a linked app login.',400);return profile;}
  if(cloudWorkflowEnabled()&&mongoose.connection.readyState!==1)fail('Choose an active staff member with a linked app login.',400);
  const user = await User.findById(ownerId).select('isActive role').session(session).lean();
  const profile = await Staff.findOne({ userId: ownerId }).session(session).lean();
  if (!getServiceCapabilities(user, profile).workActions) fail('Choose an active customer-service owner.', 400);
  return profile;
}
function reviewAvailability(profile, now = new Date()) {
  if (profile.availableMinutes <= 0) fail('Choose a reviewer with declared review capacity.', 400);
  if (profile.availabilityDate && profile.availabilityDate !== serviceDateKey(now)) fail('The reviewer availability is for another service date.', 400);
}
async function evidenceForIssue(ids, issue, session) {
  if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => !oid(id))) fail('Use valid evidence message IDs.', 400);
  const unique = [...new Set(ids.map(serviceId))];
  const messages = cloudInbox()?await readCloudEvidence({_id:{$in:unique},conversationId:issue.conversationId}):await Message.find({ _id: { $in: unique }, conversationId: issue.conversationId }).session(session).lean();
  if (messages.length !== unique.length) fail('Evidence must belong to this conversation.', 400);
  if (issue.episodeFrom && messages.some(m => m.sentAt < issue.episodeFrom) || issue.episodeTo && messages.some(m => m.sentAt > issue.episodeTo)) fail('Evidence is outside this issue episode.', 400);
  return messages;
}
async function issueForScope(id, ctx, session) {
  validId(id, 'issue');
  const issue = await Issue.findById(id).session(session).lean();
  if (!issue) fail('Issue not found.', 404);
  if (!ctx.capabilities.supervise) {
    const review = await Review.exists({ issueId: id, reviewerId: ctx.actor._id }).session(session);
    const action = !review && await Action.exists({ issueId: id, ownerId: ctx.actor._id }).session(session);
    if (!review && !action) fail('Only your assigned issue records are available.', 403);
  }
  return issue;
}

export async function claimNextReview({ actor, requestId = randomUUID(), now = new Date(), filters = {} }) {
  if(!filters||typeof filters!=='object'||Array.isArray(filters))fail('Provide valid review filters.',400);
  const selected={};
  for(const key of ['from','to','categoryId','q']){
    if(filters[key]===undefined||filters[key]==='')continue;
    if(typeof filters[key]!=='string'||filters[key].length>(key==='q'?200:80))fail('Provide valid review filters.',400);
    selected[key]=filters[key];
  }
  try{captureRange(selected);}catch{fail('Provide a valid review date range.',400);}
  const filtered=Object.keys(selected).length>0;
  // Keep the original empty payload fingerprint for unfiltered command replay.
  return mutate({ actor, requestId, kind: 'claim',payload:filtered?{filters:selected}:{} }, async (ctx, session) => {
    const visible=filtered?(await getServiceSnapshot({userId:actor._id,supervise:false,filters:selected})).issues.map(i=>serviceId(i._id)):null;
    let review = await Review.findOne({ reviewerId: actor._id, status: 'in_review' }).sort({ claimedAt: 1, _id: 1 }).session(session);
    if(review&&visible&&!visible.includes(serviceId(review.issueId)))fail('Finish your open review or choose All time.',409);
    if (!review) review = await Review.findOne({ reviewerId: actor._id, status: 'assigned',...(visible?{issueId:{$in:visible}}:{}) }).sort({ assignedAt: 1, createdAt: 1, _id: 1 }).session(session);
    if (!review) return null;
    independentReviewer(review, actor._id);
    const issue = await Issue.findById(review.issueId).session(session);
    if (!issue) fail('The assigned issue is unavailable.', 404);
    await noSelfReview(ctx.actor, issue);
    if (review.status !== 'in_review' || !review.leaseUntil || review.leaseUntil <= now || review.sourceRevision !== issue.sourceRevision || review.stale) {
      review.status = 'in_review'; review.leaseUntil = new Date(now.getTime() + SERVICE_POLICY.leaseMs);
      review.claimedAt ||= now; review.seenAt = now; review.sourceRevision = issue.sourceRevision; review.stale = false; review.version++;
      await review.save({ session });
    }
    return reviewWithIssue(review, session);
  });
}
export async function saveReviewDraft({ reviewId, version, draft, actor, now = new Date() }) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft) || Buffer.byteLength(JSON.stringify(draft)) > 30000) fail('Provide a review draft up to 30 KB.', 400);
  // Store only review fields, never caller supplied actor, assignment or status.
  const allowed = ['summary', 'note', 'verdict', 'categoryIds', 'outcome', 'evidenceMessageIds', 'action', 'confirmIssueBoundary'];
  const saved = Object.fromEntries(allowed.filter(key => draft[key] !== undefined).map(key => [key, draft[key]]));
  return mutate({ actor, kind: 'draft', payload: { reviewId, version, draft: saved } }, async (ctx, session) => {
    const review = await getReview(reviewId, session); ownReview(ctx, review); currentReview(review, version, now);
    independentReviewer(review, actor._id);
    review.draft = saved; review.version++; review.leaseUntil = new Date(now.getTime() + SERVICE_POLICY.leaseMs);
    await review.save({ session });
    return reviewWithIssue(review, session);
  });
}

async function addAction({ issue, reviewId = null, input, ctx, session, now }) {
  if (!text(input.description, 4000)) fail('Describe the required customer follow-up.', 400);
  const dueAt = asDate(input.dueAt);
  if (!dueAt) fail('Choose an action due date and time.', 400);
  const ownerId = input.ownerId ? validId(input.ownerId, 'owner') : null;
  if (ownerId && !ctx.capabilities.assignRequests) fail('Assignment permission is required. Ask the head to assign this legacy action.', 403);
  if (ownerId) await eligibleOwner(ownerId, session);
  const promisedDueAt = input.promisedDueAt ? asDate(input.promisedDueAt) : null;
  if (input.promisedDueAt && !promisedDueAt) fail('Choose a valid customer promise time.', 400);
  if (promisedDueAt && (!input.promiseMessageId || !oid(input.promiseMessageId))) fail('Link the source message containing the customer promise.', 400);
  if (input.promiseMessageId) {
    const [promise]=await evidenceForIssue([input.promiseMessageId], issue, session);
    if(promise.internalNote===true||promise.sourceMetadata?.nativeEvent?.kind==='internal_note')fail('An internal note cannot establish a customer promise.',400);
  }
  const status = ownerId ? 'assigned' : 'unassigned';
  if (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 4000)) fail('Use an action note up to 4000 characters.', 400);
  const [action] = await Action.create([{ issueId: issue._id, reviewId, customerName: issue.customerName, description: input.description.trim(), ownerId, dueAt, promisedDueAt, promiseMessageId: input.promiseMessageId || null, status, history: [{ actorId: ctx.actor._id, at: now, event: 'created', status, ownerId, dueAt, promisedDueAt, note: input.note || '' }] }], { session });
  if (issue.outcome !== 'open') {
    await Issue.updateOne({ _id: issue._id }, { $set: { outcome: 'open' }, $inc: { version: 1 } }, { session });
    issue.outcome = 'open'; issue.version = (issue.version || 1) + 1;
  }
  return action.toObject();
}
export async function submitServiceReview(input) {
  const { actor, reviewId, version, sourceRevision, requestId, now = new Date() } = input;
  const submission = validateReviewSubmission(input);
  return mutate({ actor, requestId, kind: 'submit', payload: { reviewId, version, sourceRevision, ...submission, action: input.action, confirmIssueBoundary: input.confirmIssueBoundary } }, async (ctx, session) => {
    const review = await getReview(reviewId, session); ownReview(ctx, review); currentReview(review, version, now);
    independentReviewer(review, actor._id);
    const issue = await Issue.findById(review.issueId).session(session);
    if (!issue) fail('Issue not found.', 404);
    await noSelfReview(ctx.actor, issue);
    if (!Number.isInteger(sourceRevision) || sourceRevision !== issue.sourceRevision || review.sourceRevision !== sourceRevision || review.stale) fail('Source evidence changed. Reload the review before submitting.');
    const evidence = await evidenceForIssue(submission.evidenceMessageIds, issue, session);
    const assessed = [...new Set(evidence.filter(m => isServiceStaffReply(m) && m.authorId).map(m => serviceId(m.authorId)))];
    if (submission.verdict !== 'insufficient') {
      if (issue.sourceMetadata?.unmappedStaff || !issue.contributorIds?.length) fail('Staff attribution is unresolved. Use Not enough information until source mapping is verified.', 400);
      if (!assessed.length) fail('Select a verified human staff message to identify whose handling was assessed, or use Not enough information.', 400);
      const availableStaff = new Set(evidence.filter(m => isServiceStaffReply(m) && m.authorId && ((m.type === 'text' && m.text?.trim()) || m.mediaState === 'available')).map(m => serviceId(m.authorId)));
      if (assessed.some(id => !availableStaff.has(id))) fail('Available evidence from each assessed staff member is required. Select their readable text or verified available media, or use Not enough information.', 400);
      if (issue.boundaryState === 'needs_review' && input.confirmIssueBoundary !== true) fail('Confirm the selected evidence describes one issue before grading.', 400);
    }
    if (review.sampleType === 'calibration' && input.action) fail('Record calibration independently; create any operational follow-up through the issue action queue.', 400);
    if (submission.outcome === 'resolved') {
      if (!text(submission.note) || !evidence.length) fail('Resolution requires evidence and a note confirming the actual requested effect.', 400);
      if (input.action || await Action.exists({ issueId: issue._id, status: { $ne: 'completed' } }).session(session)) fail('Open customer actions prevent confirmed issue resolution.');
    }
    review.revisions.push({ actorId: actor._id, at: now, sourceRevision, ...submission, assessedContributorIds: assessed, provisional: submission.outcome !== 'resolved', rubricVersion: SERVICE_RUBRIC_VERSION, taxonomyVersion: SERVICE_TAXONOMY_VERSION });
    review.status = submission.verdict === 'insufficient' ? 'awaiting_evidence' : 'submitted';
    review.sourceRevision = sourceRevision; review.stale = false; review.submittedAt = now; review.leaseUntil = null; review.version++;
    await review.save({ session });
    if (review.sampleType !== 'calibration') {
      issue.summary = submission.summary; issue.categoryIds = submission.categoryIds; issue.outcome = submission.outcome;
    }
    issue.version++;
    if (review.sampleType !== 'calibration' && input.confirmIssueBoundary === true && evidence.length) {
      issue.boundaryState = 'confirmed'; issue.evidenceMessageIds = submission.evidenceMessageIds;
      issue.episodeFrom = evidence.reduce((d, m) => m.sentAt < d ? m.sentAt : d, evidence[0].sentAt);
      issue.episodeTo = evidence.reduce((d, m) => m.sentAt > d ? m.sentAt : d, evidence[0].sentAt);
    }
    // Writing the read issue makes a concurrent capture transaction conflict,
    // preventing an obsolete source snapshot from being committed as current.
    await issue.save({ session });
    const action = input.action ? await addAction({ issue, reviewId, input: input.action, ctx, session, now }) : null;
    return { review: await reviewWithIssue(review, session), issue: issue.toObject(), action };
  });
}
export async function skipServiceReview({ reviewId, version, reason, requestId, actor, now = new Date() }) {
  if (!text(reason, 2000)) fail('Explain why this review needs another pass.', 400);
  return mutate({ actor, requestId, kind: 'skip', payload: { reviewId, version, reason } }, async (ctx, session) => {
    const review = await getReview(reviewId, session); ownReview(ctx, review); currentReview(review, version, now);
    review.assignmentHistory.push({ actorId: actor._id, previousReviewerId: review.reviewerId, reviewerId: null, at: now, reason: `Skipped: ${reason}` });
    review.skippedBy.addToSet(actor._id); review.reviewerId = null; review.status = 'pending'; review.leaseUntil = null; review.version++;
    await review.save({ session });
    return reviewWithIssue(review, session);
  });
}
export async function reassignServiceReview({ reviewId, ownerId, reason, version, requestId, actor, now = new Date() }) {
  if (!text(reason, 2000)) fail('Provide a reassignment reason.', 400);
  validVersion(version); validId(ownerId, 'reviewer');
  return mutate({ actor, requestId, kind: 'reassign', payload: { reviewId, ownerId, reason, version } }, async (ctx, session) => {
    supervisor(ctx);
    const review = await getReview(reviewId, session);
    if (review.version !== version) fail('Review changed. Reload before reassigning.');
    independentReviewer(review, ownerId);
    if (['submitted', 'awaiting_evidence'].includes(review.status)) fail('Submitted reviews remain historical. Request correction or calibration instead.');
    const owner = await eligibleOwner(ownerId, session);
    reviewAvailability(owner, now);
    const issue = await Issue.findById(review.issueId).session(session).lean();
    await noSelfReview({ _id: ownerId }, issue);
    if (await Review.countDocuments({ reviewerId: ownerId, status: 'assigned', _id: { $ne: review._id } }).session(session) >= SERVICE_POLICY.pendingCap) fail('The selected reviewer already has the maximum pending work.');
    review.assignmentHistory.push({ actorId: actor._id, previousReviewerId: review.reviewerId, reviewerId: ownerId, at: now, reason, dateKey: serviceDateKey(now), policyVersion: SERVICE_POLICY.version });
    review.reviewerId = ownerId; review.status = 'assigned'; review.assignedAt = now; review.claimedAt = null; review.leaseUntil = null; review.seenAt = null; review.version++;
    await review.save({ session });
    return reviewWithIssue(review, session);
  });
}
export async function createServiceAction({ issueId, actor, requestId, ...input }) {
  return mutate({ actor, requestId, kind: 'action.create', payload: { issueId, ...input } }, async (ctx, session) => {
    const issue = await issueForScope(issueId, ctx, session);
    return addAction({ issue, input, ctx, session, now: new Date() });
  });
}
export async function updateServiceAction(input) {
  const { id, version, requestId, actor, now = new Date() } = input;
  validId(id, 'action'); validVersion(version);
  const payload = Object.fromEntries(['id', 'version', 'status', 'ownerId', 'reason', 'note', 'dueAt', 'nextCheckAt', 'evidence'].map(key => [key, input[key]]));
  return mutate({ actor, requestId, kind: 'action.update', payload }, async (ctx, session) => {
    const action = await Action.findById(id).session(session);
    if (!action) fail('Action not found.', 404);
    assertServiceRecordAccess({ ...ctx, record: action, operation: 'action' });
    if (action.version !== version) fail('This action changed. Reload before saving.');
    const update = validateActionUpdate(action, input), previousOwnerId = action.ownerId;
    const ownerId = input.ownerId === undefined ? serviceId(action.ownerId) || null : input.ownerId ? validId(input.ownerId, 'owner') : null;
    if (!ctx.capabilities.assignRequests && ownerId !== serviceId(action.ownerId)) fail('A supervisor must transfer action ownership.', 403);
    if (ownerId) await eligibleOwner(ownerId, session);
    if (serviceId(ownerId) !== serviceId(action.ownerId) && !text(input.reason, 2000)) fail('Ownership changes require a reason.', 400);
    if (!ownerId && update.status !== 'unassigned') fail('Assign an owner before progressing this action.', 400);
    if (ownerId && update.status === 'unassigned') fail('An assigned action cannot be marked unassigned.', 400);
    if (update.evidence?.messageIds) {
      const issue = await Issue.findById(action.issueId).session(session).lean();
      await evidenceForIssue(update.evidence.messageIds, issue, session);
    }
    action.status = update.status; action.ownerId = ownerId; action.dueAt = update.dueAt;
    action.nextCheckAt = update.status === 'waiting' ? update.nextCheckAt : null;
    action.waitingReason = update.status === 'waiting' ? update.reason : '';
    if (update.status === 'completed') { action.completedAt = now; action.completionEvidence = update.evidence; }
    else action.completedAt = null;
    if (serviceId(previousOwnerId) !== serviceId(ownerId)) action.seenAt = null;
    if (ownerId && serviceId(actor._id) === serviceId(ownerId)) action.seenAt ||= now;
    action.version++;
    action.history.push({ actorId: actor._id, at: now, event: update.status === 'completed' ? 'completed' : 'updated', status: update.status, ownerId, previousOwnerId, dueAt: action.dueAt, promisedDueAt: action.promisedDueAt, nextCheckAt: action.nextCheckAt, reason: update.reason, note: update.note, evidence: update.evidence });
    await action.save({ session });
    // Reopening an obligation also reopens attention on the linked issue.
    if (update.status !== 'completed') await Issue.updateOne({ _id: action.issueId, outcome: 'resolved' }, { $set: { outcome: 'open' }, $inc: { version: 1 } }, { session });
    return action.toObject();
  });
}

export async function allocateServiceReviews({ actor, requestId = randomUUID(), now = new Date() }) {
  return mutate({ actor, requestId, kind: 'allocate' }, async (ctx, session, state) => {
    supervisor(ctx);
    const dateKey = serviceDateKey(now);
    const profiles = await Staff.find({ enabled: true }).session(session).lean();
    const users = cloudWorkflowEnabled()&&mongoose.connection.readyState!==1?[]:await User.find({ _id: { $in: profiles.map(p => p.userId) } }).select('isActive role').session(session).lean();
    for(const u of await sourceStaffUsers(profiles.map(p=>p.userId)))if(!users.some(existing=>serviceId(existing._id)===serviceId(u._id)))users.push(u);
    const userMap = new Map(users.map(u => [serviceId(u._id), u]));
    const staff = profiles.map(p => ({ ...p, availableMinutes: p.availabilityDate && p.availabilityDate !== dateKey ? 0 : p.availableMinutes, user: userMap.get(serviceId(p.userId)) }));
    const reviews = await Review.find({ $or: [{ status: { $in: ['assigned', 'in_review'] } }, { 'assignmentHistory.dateKey': dateKey }] }).session(session).lean();
    const credit = {};
    for (const review of reviews) for (const event of review.assignmentHistory || []) if (event.dateKey === dateKey && event.reviewerId) credit[serviceId(event.reviewerId)] = (credit[serviceId(event.reviewerId)] || 0) + 1;
    const queued = await Review.find({ status: 'pending', reviewerId: null }).sort({ sampleType:-1,createdAt: 1, _id: 1 }).limit(1000).session(session).lean();
    const issues = await Issue.find({ _id: { $in: queued.map(r => r.issueId) } }).session(session).lean();
    const issueMap = new Map(issues.map(i => [serviceId(i._id), i]));
    const seed=`${dateKey}:${state.version}`;
    const slots=staff.filter(p=>p.enabled&&p.user?.isActive&&p.availableMinutes>0).length*SERVICE_POLICY.pendingCap;
    const cohort=selectReviewCohort({issues,seed,policy:{sampleSize:slots}});
    const cohortMap=new Map(cohort.map(i=>[serviceId(i._id),i]));
    const result = allocateReviewBatch({ cases: queued.filter(r => issueMap.has(serviceId(r.issueId))&&(['calibration','targeted'].includes(r.sampleType)||cohortMap.has(serviceId(r.issueId)))).map(r => ({ ...r,priority:r.sampleType==='targeted'?'urgent':issueMap.get(serviceId(r.issueId)).priority,contributorIds: issueMap.get(serviceId(r.issueId)).contributorIds })), staff, assignments: reviews, assignedCounts: credit, cursor: state.cursor });
    for (const assignment of result.assignments) {
      const original=queued.find(r=>serviceId(r._id)===assignment.reviewId);
      const selected=cohortMap.get(assignment.issueId);
      const sample=original?.sampleType==='calibration'?{}:{sampleType:original?.sampleType==='targeted'?'targeted':selected?.sampleType||'baseline',sampleSeed:seed,eligibleDenominator:issues.length,policyVersion:SERVICE_POLICY.version};
      const updated = await Review.updateOne({ _id: assignment.reviewId, status: 'pending', reviewerId: null }, { $set: { ...sample,reviewerId: assignment.reviewerId, status: 'assigned', assignedAt: now, allocationReason: assignment.reason }, $inc: { version: 1 }, $push: { assignmentHistory: { actorId: actor._id, reviewerId: assignment.reviewerId, at: now, reason: assignment.reason, dateKey, policyVersion: SERVICE_POLICY.version } } }, { session });
      if (updated.modifiedCount !== 1) fail('Concurrent queue change. No allocation was committed.');
    }
    await Allocation.updateOne({ _id: 'global' }, { $set: { cursor: result.nextCursor } }, { session });
    return { ...result, dateKey, policyVersion: SERVICE_POLICY.version, scanned: queued.length, moreQueued: queued.length === 1000 };
  });
}

export async function configureServiceStaff({ actor, userId, mode = 'reviewer', enabled, availableMinutes = 0, displayName = '', externalAuthorIds, availabilityDate, reason = '', requestId = randomUUID() }) {
  validId(userId, 'staff');
  if (!['reviewer', 'supervisor'].includes(mode) || typeof enabled !== 'boolean' || !Number.isInteger(availableMinutes) || availableMinutes < 0 || availableMinutes > 1440 || typeof displayName !== 'string' || displayName.length > 160) fail('Choose a service role, enabled state, display label and 0–1440 planned minutes.', 400);
  if (availabilityDate !== undefined && availabilityDate !== null && (typeof availabilityDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(availabilityDate) || !asDate(`${availabilityDate}T00:00:00Z`) || asDate(`${availabilityDate}T00:00:00Z`).toISOString().slice(0, 10) !== availabilityDate)) fail('Use a real availability service date.', 400);
  if (externalAuthorIds !== undefined && (!Array.isArray(externalAuthorIds) || externalAuthorIds.length > 50 || externalAuthorIds.some(id => typeof id !== 'string' || !/^[^:]+:[^:]+:.{1,250}$/.test(id) || id.length > 500))) fail('Source author mappings must include source:account:sender.', 400);
  return mutate({ actor, requestId, kind: 'team', payload: { userId, mode, enabled, availableMinutes, displayName, externalAuthorIds, availabilityDate, reason }, setup: true }, async (ctx, session) => {
    const existing = await Staff.findOne({ userId }).session(session);
    if (mode === 'supervisor' || existing?.mode === 'supervisor') {
      if (!ctx.capabilities.setup) fail('Only an authorized super administrator can configure supervisors.', 403);
    } else if (!ctx.capabilities.supervise && !ctx.capabilities.setup) fail('A customer-service supervisor must configure reviewer membership.', 403);
    const target = await sourceStaffUser(userId) || (cloudWorkflowEnabled()&&mongoose.connection.readyState!==1?null:await User.findById(userId).select('isActive role').session(session).lean());
    if (!target || enabled && !target.isActive) fail('Choose an existing active staff account.', 400);
    if (!SERVICE_STAFF_ROLES.includes(target.role)) fail('Choose an internal staff role; driver and portal accounts are not eligible.', 400);
    const mappings = externalAuthorIds === undefined ? existing?.externalAuthorIds || [] : [...new Set(externalAuthorIds)];
    if (mappings.length && await Staff.exists({ userId: { $ne: userId }, externalAuthorIds: { $in: mappings } }).session(session)) fail('A source sender is already mapped to another staff identity.');
    const values = { mode, enabled, availableMinutes, displayName: displayName.trim(), externalAuthorIds: mappings, availabilityDate: availabilityDate === undefined ? existing?.availabilityDate || null : availabilityDate };
    const history = { actorId: actor._id, at: new Date(), before: existing ? { mode: existing.mode, enabled: existing.enabled, availableMinutes: existing.availableMinutes, displayName: existing.displayName, externalAuthorIds: existing.externalAuthorIds, availabilityDate: existing.availabilityDate } : null, after: values, reason };
    if (existing) { Object.assign(existing, values); existing.history.push(history); await existing.save({ session }); return existing.toObject(); }
    const [profile] = await Staff.create([{ userId, ...values, history: [history] }], { session });
    return profile.toObject();
  });
}

export async function getServiceTeam({ actor, profile }) {
  const caps = getServiceCapabilities(actor, profile);
  if (!caps.supervise && !caps.setup) fail('Supervisor or initial setup access required.', 403);
  const users = cloudWorkflowEnabled()&&mongoose.connection.readyState!==1?[]:await User.find({ role: { $in: SERVICE_STAFF_ROLES } }).select('_id profile.firstName profile.lastName isActive').sort({ 'profile.firstName': 1 }).lean();
  for(const u of await sourceStaffUsers())if(!users.some(existing=>serviceId(existing._id)===serviceId(u._id)))users.push(u);
  let members = await Staff.find({}).populate('userId', '_id profile.firstName profile.lastName isActive').lean();
  const directory=await sourceStaffDirectory();if(directory.length){const linked=new Set(directory.filter(p=>p.loginLinked).map(p=>p.userId));for(let n=users.length-1;n>=0;n--)if(!linked.has(serviceId(users[n]._id)))users.splice(n,1);members=members.filter(p=>linked.has(serviceId(p.userId)));}
  return { members: caps.supervise ? members : members.map(p => ({ _id: p._id, userId: p.userId, mode: p.mode, enabled: p.enabled, displayName: p.displayName })), candidates: users.map(u => ({ _id: u._id, displayName: name(u), isActive: u.isActive })) };
}
export async function getServiceOwners() {
  if(cloudWorkflowEnabled()){
    const staff=await sourceStaffDirectory();
    if(staff.length){const enabled=new Set((await Staff.find({enabled:true}).select('userId').lean()).map(p=>serviceId(p.userId)));const actions=await Action.find({status:{$ne:'completed'}}).select('ownerId').lean();return staff.filter(p=>p.loginLinked&&enabled.has(p.userId)).map(p=>({...p,_id:p.userId,openActions:actions.filter(a=>serviceId(a.ownerId)===p.userId).length}));}
  }
  const profiles = await Staff.find({ enabled: true }).populate('userId', '_id isActive role profile.firstName profile.lastName').lean();
  const counts = await Action.aggregate([{ $match: { status: { $ne: 'completed' }, ownerId: { $ne: null } } }, { $group: { _id: '$ownerId', count: { $sum: 1 } } }]);
  const workloads = new Map(counts.map(c => [serviceId(c._id), c.count]));
  return profiles.filter(p => p.userId?.isActive && SERVICE_STAFF_ROLES.includes(p.userId.role)).map(p => ({ _id: p.userId._id, userId: p.userId._id, displayName: p.displayName || name(p.userId), name: p.displayName || name(p.userId), availableMinutes: p.availableMinutes, openActions: workloads.get(serviceId(p.userId)) || 0 }));
}

const blindIssue = issue => issue ? { ...issue, summary: '', categoryIds: [], outcome: 'unknown', independentCalibration: true } : null;
function blindCalibrationRecords(reviews, actor) {
  const blind = new Set(reviews.filter(r => r.sampleType === 'calibration' && serviceId(r.reviewerId) === serviceId(actor._id) && !r.revisions?.length).map(r => serviceId(r.issueId)));
  return { blind, reviews: reviews.filter(r => !blind.has(serviceId(r.issueId)) || serviceId(r.reviewerId) === serviceId(actor._id)) };
}
// Directory lists need scope and issue references, not the capped reporting snapshot.
export async function getScopedServiceIssues({actor,profile,filters={},customerId,issueIds,referencesOnly=false}) {
  const caps=getServiceCapabilities(actor,profile);if(!caps.view)fail('Active customer-service membership required.',403);
  const filter=await getServiceIssueFilter({userId:actor._id,supervise:caps.supervise,filters});
  if(customerId!==undefined)filter.customerId=customerId;
  if(issueIds)filter.$and=[...(filter.$and||[]),{_id:{$in:issueIds}}];
  const issues=await Issue.find(filter).sort({updatedAt:-1,_id:1}).select(referencesOnly?'_id conversationId customerId customerName summary':'-sourceMetadata').lean();
  const blind=new Set((await Review.distinct('issueId',{issueId:{$in:issues.map(i=>i._id)},reviewerId:actor._id,sampleType:'calibration','revisions.0':{$exists:false}})).map(serviceId));
  const visible=issues.map(i=>blind.has(serviceId(i._id))?blindIssue(i):i);
  return referencesOnly?visible:withConversationHistory(visible);
}
export async function getOwnServiceReviews({actor,profile,filters={}}){
 if(!getServiceCapabilities(actor,profile).view)fail('Active customer-service membership required.',403);
 if(!await Review.exists({reviewerId:actor._id}))return [];
 const snapshot=await getServiceSnapshot({userId:actor._id,supervise:false,filters});
 const {blind,reviews}=blindCalibrationRecords(snapshot.reviews,actor);
 const byId=new Map(snapshot.issues.map(i=>[serviceId(i._id),blind.has(serviceId(i._id))?blindIssue(i):i]));
 return reviews.map(r=>({...r,issue:byId.get(serviceId(r.issueId))||null}));
}
export async function getScopedServiceData({ actor, profile, filters = {} }) {
  const caps = getServiceCapabilities(actor, profile);
  if (!caps.view) fail('Active customer-service membership required.', 403);
  const snapshot = await getServiceSnapshot({ userId: actor._id, supervise: caps.supervise, filters });
  const { blind, reviews } = blindCalibrationRecords(snapshot.reviews, actor);
  const issues = snapshot.issues.map(i => blind.has(serviceId(i._id)) ? blindIssue(i) : i);
  const issueMap = new Map(issues.map(i => [serviceId(i._id), i]));
  return { issues, reviews: reviews.map(r => ({ ...r, issue: issueMap.get(serviceId(r.issueId)) || null })), actions: snapshot.actions };
}
export async function getServiceIssueDetail({ issueId, actor, profile }) {
  const ctx = { actor, profile, capabilities: getServiceCapabilities(actor, profile) }; membership(ctx);
  let issue = await issueForScope(issueId, ctx, null);
  const [messages, reviews, actions] = await Promise.all([
    cloudInbox()?readCloudEvidence({conversationId:issue.conversationId}):Message.find({ conversationId: issue.conversationId }).sort({ sentAt: 1, externalMessageId: 1 }).select('-sourceRow').lean(),
    Review.find({ issueId, ...(ctx.capabilities.supervise ? {} : { reviewerId: actor._id }) }).lean(),
    Action.find({ issueId, ...(ctx.capabilities.supervise ? {} : { ownerId: actor._id }) }).lean(),
  ]);
  const independent = blindCalibrationRecords(reviews, actor);
  if (independent.blind.has(serviceId(issueId))) issue = blindIssue(issue);
  return { issue, messages:messages.map(({sourceMetadata,...message})=>({...message,display:messageDisplay({...message,sourceMetadata}),internalNote:message.internalNote===true||sourceMetadata?.nativeEvent?.kind==='internal_note'})), reviews: independent.reviews, actions };
}

export async function requestServiceCorrection({ actor, reviewId, version, reason, requestId }) {
  validVersion(version); if (!text(reason, 2000)) fail('Explain the requested correction.', 400);
  return mutate({ actor, requestId, kind: 'correction', payload: { reviewId, version, reason } }, async (ctx, session) => {
    const review = await getReview(reviewId, session);
    if (!ctx.capabilities.supervise) ownReview(ctx, review);
    if (review.version !== version) fail('Review changed. Reload before requesting correction.');
    if (!review.revisions.length) fail('Submit a review before requesting correction.');
    review.correctionRequests.push({ actorId: actor._id, at: new Date(), reason, status: 'open' }); review.version++;
    await review.save({ session }); return reviewWithIssue(review, session);
  });
}
export async function createServiceCalibration({ actor, reviewId, ownerId, requestId }) {
  validId(ownerId, 'reviewer');
  return mutate({ actor, requestId, kind: 'calibration', payload: { reviewId, ownerId } }, async (ctx, session) => {
    supervisor(ctx); const original = await getReview(reviewId, session);
    const excludedReviewerIds = [...new Set([original.reviewerId, ...(original.revisions || []).map(r => r.actorId), ...(original.assignmentHistory || []).map(h => h.reviewerId), ...(original.excludedReviewerIds || [])].filter(Boolean).map(serviceId))];
    if (excludedReviewerIds.includes(serviceId(ownerId))) fail('Choose an independent second reviewer who was not an original reviewer.', 400);
    const owner = await eligibleOwner(ownerId, session);
    reviewAvailability(owner);
    const issue = await Issue.findById(original.issueId).session(session).lean(); await noSelfReview({ _id: ownerId }, issue);
    if (await Review.countDocuments({ reviewerId: ownerId, status: 'assigned' }).session(session) >= SERVICE_POLICY.pendingCap) fail('This reviewer has reached the pending limit.');
    const existing = await Review.findOne({ issueId: issue._id, sampleKey: `calibration:${serviceId(original._id)}:${serviceId(ownerId)}` }).session(session);
    if (existing) return reviewWithIssue(existing, session);
    const [review] = await Review.create([{ issueId: issue._id, sampleKey: `calibration:${serviceId(original._id)}:${serviceId(ownerId)}`, sampleType: 'calibration', reviewerId: ownerId, excludedReviewerIds, status: 'assigned', assignedAt: new Date(), sourceRevision: issue.sourceRevision, allocationReason: 'independent_calibration', assignmentHistory: [{ actorId: actor._id, reviewerId: ownerId, at: new Date(), reason: 'Independent calibration', dateKey: serviceDateKey() }] }], { session });
    return reviewWithIssue(review, session);
  });
}

export async function resolveServiceCorrection({ actor, reviewId, index, version, decision, resolution, ownerId, requestId }) {
  validVersion(version);
  if (!Number.isInteger(index) || index < 0 || !['uphold', 'rework'].includes(decision) || !text(resolution, 4000)) fail('Choose a correction request, decision and explanation.', 400);
  return mutate({ actor, requestId, kind: 'correction.resolve', payload: { reviewId, index, version, decision, resolution, ownerId } }, async (ctx, session) => {
    supervisor(ctx);
    const review = await getReview(reviewId, session);
    if (review.version !== version) fail('Review changed. Reload before resolving the request.');
    const request = review.correctionRequests[index];
    if (!request || request.status !== 'open') fail('This correction request is no longer open.');
    if (decision === 'rework') {
      const target = ownerId || review.reviewerId;
      independentReviewer(review, target);
      const owner = await eligibleOwner(target, session);
      reviewAvailability(owner);
      const issue = await Issue.findById(review.issueId).session(session).lean();
      await noSelfReview({ _id: target }, issue);
      if (await Review.countDocuments({ _id: { $ne: review._id }, reviewerId: target, status: 'assigned' }).session(session) >= SERVICE_POLICY.pendingCap) fail('This reviewer has reached the pending limit.');
      review.assignmentHistory.push({ actorId: actor._id, previousReviewerId: review.reviewerId, reviewerId: target, at: new Date(), reason: `Correction: ${resolution}`, dateKey: serviceDateKey() });
      review.reviewerId = target; review.status = 'assigned'; review.leaseUntil = null; review.claimedAt = null; review.assignedAt = new Date(); review.seenAt = null;
      review.sourceRevision = issue.sourceRevision; review.stale = false;
      const last = plain(review.revisions.at(-1));
      review.draft = { summary: last?.summary || '', note: last?.note || '', verdict: last?.verdict || 'insufficient', categoryIds: last?.categoryIds || [], outcome: last?.outcome || 'unknown', evidenceMessageIds: last?.evidenceMessageIds || [] };
    }
    request.status = 'resolved'; request.resolvedBy = actor._id; request.resolvedAt = new Date(); request.resolution = `${decision}: ${resolution}`;
    review.version++;
    await review.save({ session });
    return reviewWithIssue(review, session);
  });
}

export async function createServiceEpisode({ actor, issueId, version, evidenceMessageIds, summary = '', categoryIds = [], requestId }) {
  validVersion(version);
  if (!Array.isArray(categoryIds) || categoryIds.some(id => !SERVICE_CATEGORY_IDS.includes(id)) || typeof summary !== 'string' || summary.length > 8000) fail('Use the shared categories and a summary up to 8000 characters.', 400);
  return mutate({ actor, requestId, kind: 'episode', payload: { issueId, version, evidenceMessageIds, summary, categoryIds } }, async (ctx, session) => {
    supervisor(ctx);
    const original = await issueForScope(issueId, ctx, session);
    if (original.version !== version) fail('Issue changed. Reload before creating another episode.');
    if (original.boundaryState !== 'confirmed') fail('First confirm the existing issue evidence, then separate another issue episode.', 400);
    const evidence = await evidenceForIssue(evidenceMessageIds, { ...original, episodeFrom: null, episodeTo: null }, session);
    if (!evidence.length) fail('Select the source messages for this separate issue.', 400);
    const selected = evidence.map(m => serviceId(m._id)).sort();
    const siblings = await Issue.find({ conversationId: original.conversationId, boundaryState: 'confirmed' }).session(session).lean();
    if (siblings.some(s => (s.evidenceMessageIds || []).some(id => selected.includes(serviceId(id))))) fail('These messages already belong to a confirmed issue. Use multiple categories for the same issue, or select a separate episode.', 400);
    const episodeFrom = evidence.reduce((d, m) => m.sentAt < d ? m.sentAt : d, evidence[0].sentAt);
    const episodeTo = evidence.reduce((d, m) => m.sentAt > d ? m.sentAt : d, evidence[0].sentAt);
    const span = cloudInbox()?await readCloudEvidence({conversationId:original.conversationId,sentAt:{$gte:episodeFrom,$lte:episodeTo}}):await Message.find({ conversationId: original.conversationId, sentAt: { $gte: episodeFrom, $lte: episodeTo } }).session(session).lean();
    const contributors = [...new Set(span.filter(m => isServiceStaffReply(m) && m.authorId).map(m => serviceId(m.authorId)))];
    const episodeKey = `episode:${fingerprint(selected).slice(0, 32)}`;
    const [issue] = await Issue.create([{ conversationId: original.conversationId, episodeKey, customerId: original.customerId, customerName: original.customerName, categoryIds: [...new Set(categoryIds)], summary: summary.trim(), outcome: 'unknown', sourceRevision: original.sourceRevision, contributorIds: contributors, evidenceMessageIds: selected, boundaryState: 'confirmed', episodeFrom, episodeTo, sourceMetadata: { createdBy: serviceId(actor._id), originIssueId: serviceId(original._id), unmappedStaff: span.some(m => isServiceStaffReply(m) && !m.authorId) } }], { session });
    const [review] = await Review.create([{ issueId: issue._id, sampleKey: 'primary', sampleType: 'targeted', status: 'pending', sourceRevision: issue.sourceRevision, policyVersion: SERVICE_POLICY.version, allocationReason: 'supervisor_episode' }], { session });
    // The original is written as well, so concurrent source capture cannot
    // create a split against an obsolete conversation revision.
    await Issue.updateOne({ _id: original._id, version }, { $inc: { version: 1 } }, { session });
    return { issue: issue.toObject(), review: await reviewWithIssue(review, session) };
  });
}
