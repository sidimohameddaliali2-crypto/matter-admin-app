import mongoose from 'mongoose';

// Append-only, complete observations. Accounts disappearing from the current
// API must not erase their previously observed payments or pricing history.
const schema = new mongoose.Schema({
  observedAt: { type: Date, required: true, index: true },
  lastVerifiedAt: { type: Date, required: true },
  sourceHash: { type: String, required: true },
  profiles: { type: [mongoose.Schema.Types.Mixed], required: true },
}, { versionKey: false });
export default mongoose.model('MatterSalesSnapshot', schema);
