import mongoose from 'mongoose';

// Staging capture store only: original JPEG bytes, separate from business proof/URLs.
const schema = new mongoose.Schema({
  accountId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  photoId: { type: String, required: true, maxlength: 128, immutable: true },
  eventId: { type: String, required: true, maxlength: 128, immutable: true },
  deliveryId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  ledgerPayloadHash: { type: String, required: true, immutable: true },
  contentMd5: { type: String, required: true, immutable: true },
  contentSha256: { type: String, required: true, immutable: true },
  byteSize: { type: Number, required: true, max: 750000, immutable: true },
  originalBytes: { type: Buffer, required: true, immutable: true, select: false },
  serverRecordedAt: { type: Date, required: true, immutable: true },
  associationVerified: { type: Boolean, required: true, immutable: true },
}, { versionKey: false, strict: 'throw', collection: 'driver_capture_photos' });
schema.index({ accountId: 1, photoId: 1 }, { unique: true });
schema.index({ accountId: 1, eventId: 1 }, { unique: true });
export default mongoose.models.DriverCapturePhoto || mongoose.model('DriverCapturePhoto', schema);
