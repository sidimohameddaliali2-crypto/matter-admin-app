import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  kind: { type: String, required: true, enum: ['client', 'pending', 'code', 'grant'] },
  key: { type: String, required: true },
  payload: { type: mongoose.Schema.Types.Mixed, required: true },
  expiresAt: { type: Date, required() { return this.kind !== 'client'; } },
});
schema.index({ kind: 1, key: 1 }, { unique: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
schema.index({ kind: 1, 'payload.accessHash': 1 });
schema.index({ kind: 1, 'payload.refreshHash': 1 });
schema.index({ kind: 1, 'payload.usedRefreshHashes': 1 });

export default mongoose.model('McpOAuthRecord', schema);
