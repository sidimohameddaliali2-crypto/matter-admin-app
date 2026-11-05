import mongoose from 'mongoose';

// A shared vehicle/day cache, separate from locally sampled GPS and its driver snapshots.
const point = new mongoose.Schema({ latitude: Number, longitude: Number, gpsTime: Date }, { _id: false });
const schema = new mongoose.Schema({ _id: String, fetchedAt: Date, points: [point] });
export default mongoose.model('TruckoomTrackHistory', schema);
