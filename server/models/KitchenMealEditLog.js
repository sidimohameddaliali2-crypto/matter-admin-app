import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  menuId: { type: mongoose.Schema.Types.ObjectId, required: true },
  customerId: { type: String, required: true },
  date: { type: String, required: true },
  actorId: { type: String, required: true }, actorName: { type: String, required: true },
  action: { type: String, enum: ['add', 'change', 'delete', 'restore'], required: true },
  before: mongoose.Schema.Types.Mixed, after: mongoose.Schema.Types.Mixed,
  quantity: Number, reason: String, summary: String,
}, { timestamps: true });
schema.index({ menuId: 1, customerId: 1, _id: -1 });
export default mongoose.model('KitchenMealEditLog', schema);
