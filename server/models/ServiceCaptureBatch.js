import mongoose from 'mongoose';
const { Schema } = mongoose;
const schema = new Schema({
  requestId: { type: String, required: true, unique: true, maxlength: 180 },
  source: { type: String, required: true }, scope: { type: String, required: true },
  from: Date, to: Date,
  status: { type: String, enum: ['received', 'processing', 'completed', 'partial', 'failed'], default: 'received' },
  counts: Schema.Types.Mixed, error: String, coverage: Schema.Types.Mixed, exceptions: [Schema.Types.Mixed],
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' }, checkpoint: Schema.Types.Mixed,
}, { timestamps: true });
export default mongoose.models.ServiceCaptureBatch || mongoose.model('ServiceCaptureBatch', schema);
