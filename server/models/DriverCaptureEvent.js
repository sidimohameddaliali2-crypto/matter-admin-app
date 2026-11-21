import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  eventId: { type: String, required: true, maxlength: 128, immutable: true },
  payloadHash: { type: String, required: true, immutable: true },
  originalEvent: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
  serverReceivedAt: { type: Date, required: true, immutable: true },
  // Server-side recording time, not a claimed Mongo physical commit timestamp.
  serverRecordedAt: { type: Date, required: true, immutable: true },
  associationVerified: { type: Boolean, default: false, immutable: true },
  ledgerOnly: { type: Boolean, default: true, immutable: true },
}, { versionKey: false, strict: 'throw', collection: 'driver_capture_events' });

// No TTL: expiring retry identities could silently create duplicate ledger entries.
schema.index({ accountId: 1, eventId: 1 }, { unique: true });
export default mongoose.models.DriverCaptureEvent || mongoose.model('DriverCaptureEvent', schema);
