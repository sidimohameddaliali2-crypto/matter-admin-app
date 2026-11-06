import mongoose from 'mongoose';
const { Schema } = mongoose;
const schema = new Schema({
  requestId: { type: String, required: true, unique: true, maxlength: 180 },
  actorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  kind: { type: String, required: true }, fingerprint: { type: String, required: true },
  result: { type: Schema.Types.Mixed, default: null },
}, { timestamps: true });
export default mongoose.models.ServiceCommand || mongoose.model('ServiceCommand', schema);
