import mongoose from 'mongoose';

// Shared operations library. WeeklyMenu/MenuItem remain independent dated copies.
const schema = new mongoose.Schema({
  _id: { type: String, default: 'shared' },
  revision: { type: Number, required: true, default: 0 },
  catalogue: { type: mongoose.Schema.Types.Mixed, required: true },
  boards: { type: mongoose.Schema.Types.Mixed, required: true },
  cycles: { type: [mongoose.Schema.Types.Mixed], default: undefined },
  aliases: { type: [{ from: String, to: String, _id: false }], default: [] },
  recovery: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true, minimize: false });

export default mongoose.model('MealCreationState', schema);
