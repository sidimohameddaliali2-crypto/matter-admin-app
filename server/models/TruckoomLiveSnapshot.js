import mongoose from 'mongoose';

// Shared across PM2 workers even when Redis is unavailable. Claim the next
// upstream request atomically and retain only normalized fleet information.
const schema = new mongoose.Schema({
  _id: String,
  requestId: String,
  nextRequestAt: Date,
  fetchedAt: Date,
  vehicles: [mongoose.Schema.Types.Mixed],
});
export default mongoose.model('TruckoomLiveSnapshot', schema);
