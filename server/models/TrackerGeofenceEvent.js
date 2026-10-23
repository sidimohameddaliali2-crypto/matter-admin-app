import mongoose from 'mongoose';

// Permanent evidence, independent of Truckoom's remote fence lifecycle.
const schema = new mongoose.Schema({
  _id: String,
  name: { type: String, required: true },
  vehicleNo: { type: String, required: true },
  flag: { type: String, enum: ['entry', 'exit'], required: true },
  at: { type: Date, required: true },
});
schema.index({ name: 1, at: 1 });
export default mongoose.model('TrackerGeofenceEvent', schema);
