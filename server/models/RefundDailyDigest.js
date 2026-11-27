import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  kind: { type: String, enum: ['accounts', 'jana'], required: true }, dateKey: { type: String, required: true }, recipient: String,
  messageKey: { type: String, required: true }, state: { type: String, enum: ['queued', 'sending', 'uncertain', 'needs_review', 'sent', 'cancelled'], default: 'queued' },
  attempts: { type: Number, default: 0 }, leaseUntil: Date, nextAttemptAt: Date, firstAttemptAt: Date, sentAt: Date, messageId: String, errorCode: String, count: Number
}, { timestamps: true });
schema.index({ kind: 1, dateKey: 1 }, { unique: true });
export default mongoose.model('RefundDailyDigest', schema);
