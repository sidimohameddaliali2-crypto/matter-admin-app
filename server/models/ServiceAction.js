import mongoose from 'mongoose';
const { Schema } = mongoose;
const evidence = new Schema({ note: { type: String, maxlength: 4000 }, confirmedEffect: { type: Boolean, default: false }, messageIds: [{ type: Schema.Types.ObjectId, ref: 'ServiceMessage' }] }, { _id: false });
const schema = new Schema({
  issueId: { type: Schema.Types.ObjectId, ref: 'ServiceIssue', required: true, index: true },
  reviewId: { type: Schema.Types.ObjectId, ref: 'ServiceReview', default: null },
  customerName: { type: String, maxlength: 250, default: '' }, description: { type: String, required: true, maxlength: 4000 },
  ownerId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  status: { type: String, enum: ['unassigned', 'assigned', 'in_progress', 'waiting', 'completed'], default: 'unassigned', index: true },
  dueAt: Date, promisedDueAt: Date, promiseMessageId: { type: Schema.Types.ObjectId, ref: 'ServiceMessage' },
  nextCheckAt: Date, waitingReason: String, completedAt: Date, seenAt: Date,
  version: { type: Number, min: 1, default: 1 }, completionEvidence: evidence,
  history: [{ _id: false, actorId: { type: Schema.Types.ObjectId, ref: 'User' }, at: Date, event: String, status: String, ownerId: { type: Schema.Types.ObjectId, ref: 'User' }, previousOwnerId: { type: Schema.Types.ObjectId, ref: 'User' }, dueAt: Date, promisedDueAt: Date, nextCheckAt: Date, reason: String, note: String, evidence }],
}, { timestamps: true });
export default mongoose.models.ServiceAction || mongoose.model('ServiceAction', schema);
