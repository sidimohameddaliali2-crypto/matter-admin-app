import mongoose from 'mongoose';

const milestone = new mongoose.Schema({
  at: Date,
  actor: String,
  courier: String,
  photoTaken: Boolean,
}, { _id: false });

const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  status: { type: String, enum: ['pending', 'in_preparation', 'prepared', 'collected', 'delivered'], required: true },
  driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  driverName: String,
  orderName: String,
  customerName: String,
  emirate: String,
  in_preparation: milestone,
  prepared: milestone,
  collected: milestone,
  delivered: milestone,
  displayPhoto: { type: Buffer, select: false },
  boxedPhoto: { type: Buffer, select: false },
  deliveryPhoto: { type: Buffer, select: false },
});

schema.index({ driverId: 1, status: 1 });

export default mongoose.model('YellowblockOrderWorkflow', schema);
