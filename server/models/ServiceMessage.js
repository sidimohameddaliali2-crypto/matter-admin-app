import mongoose from 'mongoose';
const { Schema } = mongoose;
const schema = new Schema({
  source: { type: String, required: true, maxlength: 100 }, scope: { type: String, required: true, maxlength: 200 },
  externalMessageId: { type: String, required: true, maxlength: 250 }, externalConversationId: { type: String, maxlength: 250 },
  conversationId: { type: Schema.Types.ObjectId, ref: 'ServiceConversation', required: true, index: true },
  authorId: { type: Schema.Types.ObjectId, ref: 'User', default: null }, externalAuthorId: { type: String, maxlength: 250 },
  internalNote: { type: Boolean, default: false },
  authorType: { type: String, enum: ['customer', 'staff', 'bot', 'system', 'unknown'], default: 'unknown' },
  authorName: { type: String, maxlength: 250, default: '' }, sentAt: { type: Date, required: true },
  type: { type: String, maxlength: 60, default: 'text' }, text: { type: String, maxlength: 100000, default: '' },
  mediaState: { type: String, enum: ['available', 'missing', 'unavailable', 'not_applicable', 'unknown'], default: 'unknown' },
  sourceRow: Schema.Types.Mixed, importId: String, sourceMetadata: Schema.Types.Mixed,
}, { timestamps: true });
schema.index({ source: 1, scope: 1, externalMessageId: 1 }, { unique: true });
schema.index({ conversationId: 1, sentAt: 1, externalMessageId: 1 });
schema.index({ conversationId: 1, sentAt: -1, _id: -1 });
export default mongoose.models.ServiceMessage || mongoose.model('ServiceMessage', schema);
