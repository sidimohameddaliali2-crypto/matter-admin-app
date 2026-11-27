import mongoose from 'mongoose';

const { Schema } = mongoose;

const changeSchema = new Schema({
  sourceVehicleId: { type: String, required: true },
  vehicleClass: { type: String, required: true, enum: ['bike', 'van', 'car', 'truck'] },
  // Kept only in Sidi's receipt for audit and legacy projection validation.
  trackerAlias: { type: String, default: null },
  previousDriverId: { type: String, default: null },
  driverId: { type: String, default: null },
}, { _id: false });

const receiptSchema = new Schema({
  operationId: { type: String, required: true, unique: true, immutable: true },
  actorId: { type: String, required: true, immutable: true },
  requestHash: { type: String, required: true, select: false, immutable: true },
  sourceVersion: { type: Number, required: true, unique: true, immutable: true },
  previousReceiptId: { type: Schema.Types.ObjectId, default: null, immutable: true },
  kind: { type: String, required: true, enum: ['assign', 'swap', 'end'], immutable: true },
  effectiveAt: { type: Date, required: true, immutable: true },
  changes: { type: [changeSchema], required: true, immutable: true },
}, { versionKey: false, autoCreate: false, autoIndex: false });

receiptSchema.index({ 'changes.sourceVehicleId': 1, sourceVersion: -1 });
receiptSchema.index({ 'changes.driverId': 1, effectiveAt: 1 });
receiptSchema.index({ 'changes.previousDriverId': 1, effectiveAt: 1 });

export default mongoose.model('FleetAssignmentReceipt', receiptSchema);
