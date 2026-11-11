import {cloudWorkflowModel} from '../services/customerServiceCloudWorkflow.js';
import mongoose from 'mongoose';
import { SERVICE_CATEGORY_IDS, SERVICE_TAXONOMY_VERSION } from '../config/customerServiceCategories.js';
const { Schema } = mongoose;
const schema = new Schema({
  conversationId: { type: Schema.Types.ObjectId, ref: 'ServiceConversation', required: true, index: true },
  episodeKey: { type: String, default: 'primary', maxlength: 250 },
  customerId: { type: String, default: null, maxlength: 200 }, customerName: { type: String, maxlength: 250, default: '' },
  categoryIds: [{ type: String, enum: SERVICE_CATEGORY_IDS }], taxonomyVersion: { type: String, default: SERVICE_TAXONOMY_VERSION },
  outcome: { type: String, enum: ['open', 'resolved', 'unknown'], default: 'unknown' },
  summary: { type: String, maxlength: 8000, default: '' },
  sourceRevision: { type: Number, min: 1, default: 1 }, version: { type: Number, min: 1, default: 1 },
  contributorIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  evidenceMessageIds: [{ type: Schema.Types.ObjectId, ref: 'ServiceMessage' }],
  boundaryState: { type: String, enum: ['confirmed', 'needs_review'], default: 'needs_review' },
  evidenceState: { type: String, enum: ['available', 'partial', 'missing', 'unknown'], default: 'unknown' },
  priority: { type: String, enum: ['normal', 'urgent'], default: 'normal' },
  episodeFrom: Date, episodeTo: Date, sourceMetadata: Schema.Types.Mixed,
}, { timestamps: true });
schema.index({ conversationId: 1, episodeKey: 1 }, { unique: true });
export default cloudWorkflowModel(mongoose.models.ServiceIssue || mongoose.model('ServiceIssue', schema));
