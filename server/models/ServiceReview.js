import mongoose from 'mongoose';
import { SERVICE_RUBRIC_VERSION, SERVICE_TAXONOMY_VERSION } from '../config/customerServiceCategories.js';
const { Schema } = mongoose;
const schema = new Schema({
  issueId: { type: Schema.Types.ObjectId, ref: 'ServiceIssue', required: true, index: true },
  sampleKey: { type: String, default: 'primary' },
  sampleType: { type: String, enum: ['baseline', 'targeted', 'calibration', 'legacy'], default: 'baseline' },
  sampleSeed: String, eligibleDenominator: Number, policyVersion: String,
  reviewerId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  status: { type: String, enum: ['pending', 'assigned', 'in_review', 'submitted', 'awaiting_evidence', 'skipped'], default: 'pending', index: true },
  version: { type: Number, min: 1, default: 1 }, sourceRevision: { type: Number, min: 1, default: 1 },
  leaseUntil: { type: Date, default: null }, claimedAt: Date, assignedAt: Date, submittedAt: Date, seenAt: Date,
  stale: { type: Boolean, default: false }, draft: { type: Schema.Types.Mixed, default: {} },
  skippedBy: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  excludedReviewerIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  allocationReason: String,
  assignmentHistory: [{ _id: false, actorId: { type: Schema.Types.ObjectId, ref: 'User' }, reviewerId: { type: Schema.Types.ObjectId, ref: 'User' }, previousReviewerId: { type: Schema.Types.ObjectId, ref: 'User' }, at: Date, reason: String, dateKey: String, policyVersion: String }],
  revisions: [{ _id: false, actorId: { type: Schema.Types.ObjectId, ref: 'User' }, at: Date, sourceRevision: Number, verdict: { type: String, enum: ['good', 'needs_work', 'insufficient'] }, summary: String, note: String, categoryIds: [String], outcome: String, evidenceMessageIds: [{ type: Schema.Types.ObjectId, ref: 'ServiceMessage' }], assessedContributorIds: [{ type: Schema.Types.ObjectId, ref: 'User' }], provisional: Boolean, rubricVersion: { type: String, default: SERVICE_RUBRIC_VERSION }, taxonomyVersion: { type: String, default: SERVICE_TAXONOMY_VERSION } }],
  correctionRequests: [{ _id: false, actorId: { type: Schema.Types.ObjectId, ref: 'User' }, at: Date, reason: String, status: { type: String, enum: ['open', 'resolved'], default: 'open' }, resolvedBy: { type: Schema.Types.ObjectId, ref: 'User' }, resolvedAt: Date, resolution: String }],
}, { timestamps: true });
schema.index({ issueId: 1, sampleKey: 1 }, { unique: true });
schema.index({ reviewerId: 1, status: 1, assignedAt: 1 });
schema.index({ reviewerId: 1 }, { unique: true, partialFilterExpression: { status: 'in_review' }, name: 'one_active_service_review_per_reviewer' });
export default mongoose.models.ServiceReview || mongoose.model('ServiceReview', schema);
