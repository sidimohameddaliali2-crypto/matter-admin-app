import mongoose from 'mongoose';

// Mongo lease keeps all PM2 workers from creating the same remote geofences.
const schema = new mongoose.Schema({
  _id: String, owner: String, expiresAt: Date,
});
export default mongoose.model('TrackerSyncLease', schema);
