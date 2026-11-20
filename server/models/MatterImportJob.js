import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  date: { type: String, required: true, index: true },
  // Present only while queued/running. Concurrent clicks share one active job.
  activeKey: { type: String, unique: true, sparse: true },
  status: { type: String, enum: ['queued', 'running', 'completed', 'incomplete', 'failed'], required: true },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  owner: String,
  leaseUntil: Date,
  startedAt: Date,
  finishedAt: Date,
  progress: mongoose.Schema.Types.Mixed,
  result: mongoose.Schema.Types.Mixed,
  message: String
}, { timestamps: true });
schema.index({ date: 1, createdAt: -1 });
export default mongoose.model('MatterImportJob', schema);
