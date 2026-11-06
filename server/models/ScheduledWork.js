import mongoose from 'mongoose';

// _id is MongoDB's built-in unique key. Keep completed slots across restarts;
// a TTL index here would make a completed daily task eligible again.
const schema = new mongoose.Schema({
  _id: String,
  owner: String,
  leaseUntil: { type: Date, default: () => new Date(0) },
  completedSlot: { type: Number, default: -1 },
}, { versionKey: false, writeConcern: { w: 'majority' } });
export default mongoose.model('ScheduledWork', schema);
