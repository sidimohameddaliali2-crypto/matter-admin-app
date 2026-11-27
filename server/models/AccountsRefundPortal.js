import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  mailbox: { type: String, required: true, unique: true },
  tokenHash: { type: String, required: true, unique: true, select: false },
  tokenNonce: { type: String, required: true, select: false },
  expiresAt: { type: Date, required: true }
}, { timestamps: true });
export default mongoose.model('AccountsRefundPortal', schema);
