import mongoose from 'mongoose';

// Recovery copies created by explicitly approved reconciliation. Read by the
// selections endpoint to recognize aliases recreated by legacy app processes.
const schema = new mongoose.Schema({
  retainedSelectionId: mongoose.Schema.Types.ObjectId,
  matterCustomerId: String,
  original: mongoose.Schema.Types.Mixed,
}, { strict: false, autoCreate: false, autoIndex: false });

export default mongoose.model('MenuSelectionArchive', schema, 'menuselectionrecordarchives');
