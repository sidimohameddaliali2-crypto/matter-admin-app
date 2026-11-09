import mongoose from 'mongoose';
const { Schema } = mongoose;
const schema = new Schema({
  source: { type: String, required: true, maxlength: 100 }, scope: { type: String, required: true, maxlength: 200 },
  externalConversationId: { type: String, required: true, maxlength: 250 },
  customerId: { type: String, default: null, maxlength: 200 }, customerName: { type: String, maxlength: 250 },
  sourceRevision: { type: Number, min: 1, default: 1 }, lastMessageAt: Date,
  coverageFrom: Date, coverageTo: Date,
  coverageStatus: { type: String, enum: ['complete', 'partial', 'unknown'], default: 'unknown' },
  sourceMetadata: Schema.Types.Mixed,
}, { timestamps: true });
schema.index({ source: 1, scope: 1, externalConversationId: 1 }, { unique: true });
schema.index({ source: 1, lastMessageAt: -1, _id: -1 });
export default mongoose.models.ServiceConversation || mongoose.model('ServiceConversation', schema);
