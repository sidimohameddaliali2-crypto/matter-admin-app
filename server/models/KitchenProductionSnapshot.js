import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  menuId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  date: { type: String, required: true },
  status: { type: String, enum: ['running', 'ready', 'failed'], required: true },
  sourceVersion: String,
  payload: mongoose.Schema.Types.Mixed,
  error: String,
  expiresAt: { type: Date, required: true },
}, { timestamps: true });
schema.index({ menuId: 1, date: 1, createdAt: -1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export default mongoose.model('KitchenProductionSnapshot', schema);
