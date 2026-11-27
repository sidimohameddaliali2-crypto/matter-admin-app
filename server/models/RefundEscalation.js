import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  delivery: { type: mongoose.Schema.Types.ObjectId, ref: 'Delivery', required: true },
  stage: { type: String, enum: ['adrian_24h', 'jana_48h'], required: true },
  pendingAt: { type: Date, required: true }, dueAt: { type: Date, required: true },
  recipient: String, messageKey: { type: String, required: true },
  state: { type: String, enum: ['queued', 'sending', 'uncertain', 'needs_review', 'sent', 'cancelled'], default: 'queued' },
  attempts: { type: Number, default: 0 }, leaseUntil: Date, nextAttemptAt: Date, firstAttemptAt: Date,
  sentAt: Date, messageId: String, errorCode: String
}, { timestamps: true });
schema.index({ delivery: 1, stage: 1 }, { unique: true });
schema.index({ state: 1, dueAt: 1, nextAttemptAt: 1, leaseUntil: 1 });
export default mongoose.model('RefundEscalation', schema);
