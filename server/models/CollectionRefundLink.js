import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  delivery: { type: mongoose.Schema.Types.ObjectId, ref: 'Delivery', required: true, unique: true },
  tokenHash: { type: String, required: true, unique: true, select: false },
  tokenNonce: { type: String, required: true, select: false },
  expiresAt: { type: Date, required: true },
  recipient: { type: String, required: true },
  messageKey: { type: String, required: true },
  state: { type: String, enum: ['queued', 'sending', 'sent', 'uncertain', 'failed', 'needs_review', 'cancelled'], default: 'queued' },
  attempts: { type: Number, default: 0 },
  firstAttemptAt: Date, nextAttemptAt: Date, leaseUntil: Date, sentAt: Date,
  messageId: String, errorCode: String, usedAt: Date,
  events: [{ _id: false, at: Date, state: String, actorName: String, messageId: String }]
}, { timestamps: true });
schema.index({ state: 1, nextAttemptAt: 1, leaseUntil: 1 });
export default mongoose.model('CollectionRefundLink', schema);
