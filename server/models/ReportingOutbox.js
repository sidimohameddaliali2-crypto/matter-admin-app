import mongoose from 'mongoose';

const { Schema } = mongoose;

const reportingCounterSchema = new Schema({
  _id: String,
  lastVersion: { type: Number, required: true },
}, { versionKey: false, autoCreate: false, autoIndex: false });

const reportingEventSchema = new Schema({
  sourceVersion: { type: Number, required: true, unique: true },
  eventType: { type: String, required: true, enum: ['delivery.changed', 'delivery.removed', 'gps.batch-committed', 'fleet.assignment-changed'] },
  subjectId: { type: String, required: true },
  occurredAt: { type: Date, required: true },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: () => new Date(0) },
  deliveredAt: Date,
  leaseId: String,
  leaseUntil: Date,
}, { versionKey: false, autoCreate: false, autoIndex: false });

reportingEventSchema.index({ deliveredAt: 1, nextAttemptAt: 1, sourceVersion: 1 });

export const ReportingCounter = mongoose.model('ReportingCounter', reportingCounterSchema);
export const ReportingOutbox = mongoose.model('ReportingOutbox', reportingEventSchema);
