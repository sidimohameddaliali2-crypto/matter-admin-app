import mongoose from 'mongoose';

// A whole service-day manifest is one concurrency boundary: no half-imported
// assignments or single-sided stock transfer can become visible.
const schema = new mongoose.Schema({
  serviceDate: { type: String, required: true, unique: true },
  revision: { type: Number, required: true },
  requestId: { type: String, required: true },
  importHash: { type: String, required: true },
  routes: { type: [mongoose.Schema.Types.Mixed], required: true },
  transfers: { type: [mongoose.Schema.Types.Mixed], required: true },
  state: { type: mongoose.Schema.Types.Mixed, required: true },
  receipts: { type: [mongoose.Schema.Types.Mixed], default: [] },
  revisionHistory: { type: [mongoose.Schema.Types.Mixed], default: [] },
  participantIds: [String],
  cancelled: { type: Boolean, default: false },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  cancellation: mongoose.Schema.Types.Mixed
}, { timestamps: true, optimisticConcurrency: true, minimize: false });

export default mongoose.model('ExternalRoutePlan', schema);
