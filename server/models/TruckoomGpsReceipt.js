import mongoose from 'mongoose';

// Immutable account-scoped GPS responses. No TTL: source evidence is retained.
// The payload is gzip-compressed JSON, not the original HTTP wire encoding.
const schema = new mongoose.Schema({
  _id: String,
  kind: { type: String, enum: ['live', 'history'], required: true },
  scope: { type: mongoose.Schema.Types.Mixed, required: true },
  requestStartedAt: { type: Date, required: true },
  responseReceivedAt: { type: Date, required: true },
  payloadSha256: { type: String, required: true },
  payloadBytes: { type: Number, required: true },
  encoding: { type: String, default: 'gzip-json-v1' },
  payload: { type: Buffer, required: true, select: false },
}, { versionKey: false });
schema.index({ kind: 1, responseReceivedAt: 1 });
export default mongoose.model('TruckoomGpsReceipt', schema);
