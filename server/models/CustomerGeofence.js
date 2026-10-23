import mongoose from 'mongoose';

// One saved customer pin per Dubai business day. Keep this local record after
// deleting the remote fence so old deliveries and offline proofs retain identity.
const schema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  customerId: String,
  lat: Number,
  lng: Number,
  radiusMetres: { type: Number, default: 50 },
  truckoomId: String,
  businessDate: { type: String, index: true },
  deletedAt: Date,
}, { timestamps: true });

export default mongoose.model('CustomerGeofence', schema);
