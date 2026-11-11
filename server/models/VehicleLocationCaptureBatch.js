import mongoose from 'mongoose';

// One durable record per scheduled sampling tick. Payloads are immutable after
// capture; pending work survives restart. Lease expiry is not a retention TTL.
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  tickAt: { type: Date, required: true },
  state: { type: String, enum: ['collecting', 'pending', 'complete', 'failed'], required: true },
  owner: String,
  fence: { type: Number, required: true },
  leaseUntil: Date,
  attempts: { type: Number, default: 1 },
  payload: mongoose.Schema.Types.Mixed,
  payloadSha256: String,
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true },
  completedAt: Date,
  failureCode: String,
}, { minimize: false });

schema.index({ state: 1, leaseUntil: 1, tickAt: 1 });
// Read-only day-scoped health queries do not constrain state.
schema.index({ tickAt: 1 });
export default mongoose.model('VehicleLocationCaptureBatch', schema);
