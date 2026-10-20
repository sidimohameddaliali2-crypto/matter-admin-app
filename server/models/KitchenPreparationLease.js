import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  _id: String,
  owner: { type: String, required: true },
  expiresAt: { type: Date, required: true },
});
export default mongoose.model('KitchenPreparationLease', schema);
