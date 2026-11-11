import {cloudWorkflowModel} from '../services/customerServiceCloudWorkflow.js';
import mongoose from 'mongoose';
const { Schema } = mongoose;
const schema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  displayName: { type: String, maxlength: 160, default: '' },
  mode: { type: String, enum: ['reviewer', 'supervisor'], required: true },
  grants: {type: [String], enum: ['assignRequests','approveExceptions','closeSensitive','managePolicies','reportingAccess'], default: []},
  enabled: { type: Boolean, default: false },
  availableMinutes: { type: Number, min: 0, max: 1440, default: 0 },
  availabilityDate: { type: String, default: null },
  externalAuthorIds: { type: [String], default: [] },
  history: [{ _id: false, actorId: { type: Schema.Types.ObjectId, ref: 'User' }, at: Date, before: Schema.Types.Mixed, after: Schema.Types.Mixed, reason: String }],
}, { timestamps: true });
export default cloudWorkflowModel(mongoose.models.ServiceStaffProfile || mongoose.model('ServiceStaffProfile', schema));
