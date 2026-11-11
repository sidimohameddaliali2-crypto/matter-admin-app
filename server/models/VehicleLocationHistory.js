import mongoose from 'mongoose';

// Owner (2026-10-09): "I want to collect historical data... save the point
// the driver are doing" — Truckoom's own API has no route-trail/playback
// endpoint in the original docs; the 2026-10-22 contract now documents
// getVehicleTrackLogs (cached separately in TruckoomTrackHistory). This app
// originally built its own history by sampling server/jobs/recordVehicleLocations.js
// every minute and keeping every point (no automatic purge — owner chose
// "keep forever"). driver is a point-in-time snapshot of whichever User was
// mapped to this vehicleNo at the moment it was recorded (via
// User.profile.truckoomVehicleNo) — kept even if that mapping later changes,
// as a dated configuration observation; this does not prove who physically drove.
const vehicleLocationHistorySchema = new mongoose.Schema({
  vehicleNo: {
    type: String,
    required: true,
    trim: true,
  },
  driver: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  latitude: {
    type: Number,
    default: null,
  },
  longitude: {
    type: Number,
    default: null,
  },
  recordedAt: {
    type: Date,
    required: true,
    default: Date.now,
  },
  gpsTime: Date,
  captureBatchId: String,
  captureRow: Number,
  sourceReceipt: mongoose.Schema.Types.Mixed,
  sourceRow: Number,
  trackerServerTime: Date,
  rawGpsTime: String,
  rawTrackerServerTime: String,
  speedKph: Number,
  ignition: String,
  trackerStatus: String,
  locationSource: String,
  fixAgeMs: Number,
  qualityFlags: [String],
  driverCandidates: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  driverMappingState: String,
});

vehicleLocationHistorySchema.index({ vehicleNo: 1, recordedAt: 1 });
vehicleLocationHistorySchema.index({ driver: 1, recordedAt: 1 });

export default mongoose.model('VehicleLocationHistory', vehicleLocationHistorySchema);
