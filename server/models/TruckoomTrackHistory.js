import mongoose from 'mongoose';

// A shared vehicle/day cache, separate from locally sampled GPS and its driver snapshots.
const point = new mongoose.Schema({ latitude: Number, longitude: Number, gpsTime: Date, recordedAt: Date, qualityFlags: [String] }, { _id: false });
const schema = new mongoose.Schema({ _id: String, fetchedAt: Date, responseReceivedAt: Date, points: [point], qualityObservations: [point], lastRefreshAt: Date, lastRefreshOutcome: String, sourceReceipt: mongoose.Schema.Types.Mixed });
export default mongoose.model('TruckoomTrackHistory', schema);
