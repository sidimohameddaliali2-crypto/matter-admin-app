import mongoose from 'mongoose';

const deliveryChangeSchema = new mongoose.Schema({
  customerId: {
    type: String,
    required: true,
    index: true
  },
  customerName: {
    type: String,
    required: true
  },
  customerPhone: String,
  scheduledDate: {
    type: Date,
    required: true,
    index: true
  },
  changes: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: {}
  },
  status: {
    type: String,
    enum: ['pending', 'applied', 'failed', 'cancelled'],
    default: 'pending'
  },
  appliedAt: Date,
  appliedToDelivery: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Delivery'
  },
  appliedOrderIds: {type:[mongoose.Schema.Types.ObjectId], default:undefined, select:false},
  reason: String,
  uploadedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false // Made optional to support system-generated changes
  },
  fileReference: String, // Original file name or reference
  matchConfidence: {
    type: Number,
    default: 0 // 0-100 score for how well we matched the customer
  },
  matchingFields: [String], // Which fields were used for matching (customerId, phone, etc.)
  rangeBatchId: {
    type: String,
    index: true,
    required: false
  },
  rangeStartDate: Date,
  rangeEndDate: Date,
  rangeSequence: Number,
  rangeCount: Number
}, {
  timestamps: true
});

// Index for efficient pending changes lookup
deliveryChangeSchema.index({ scheduledDate: 1, status: 1 });
deliveryChangeSchema.index({ customerId: 1, scheduledDate: 1 });
deliveryChangeSchema.index({ rangeBatchId: 1, scheduledDate: 1 });

export default mongoose.model('DeliveryChange', deliveryChangeSchema);