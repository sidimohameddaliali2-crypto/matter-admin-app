import mongoose from 'mongoose';

// Permanent Matter customer identity, deliberately independent of subscriptions
// and duplicate internal Customer documents. Never stores dietary restrictions.
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  blockedSnacks: [{ _id: false, key: { type: String, required: true }, name: { type: String, required: true } }],
  version: { type: Number, default: 0 },
  history: [{ _id: false, at: Date, actor: String, before: [String], after: [String] }],
}, { timestamps: true });

export default mongoose.model('KitchenSnackRule', schema);
