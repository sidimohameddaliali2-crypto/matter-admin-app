import {cloudWorkflowModel} from '../services/customerServiceCloudWorkflow.js';
import mongoose from 'mongoose';
const schema = new mongoose.Schema({ _id: { type: String, default: 'global' }, version: { type: Number, default: 0 }, cursor: { type: Number, default: 0 } }, { timestamps: true });
export default cloudWorkflowModel(mongoose.models.ServiceAllocationState || mongoose.model('ServiceAllocationState', schema));
