import mongoose from 'mongoose';

const thirdPartyDeliveryAssignmentSchema = new mongoose.Schema(
  {
    shopifyOrderId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    orderNumber: {
      type: String,
      default: '',
      trim: true,
    },
    customerName: {
      type: String,
      default: '',
      trim: true,
    },
    customerPhone: {
      type: String,
      default: '',
      trim: true,
    },
    city: {
      type: String,
      default: '',
      trim: true,
    },
    addressLine1: {
      type: String,
      default: '',
      trim: true,
    },
    items: [
      {
        title: {
          type: String,
          default: '',
          trim: true,
        },
        quantity: {
          type: Number,
          default: 1,
          min: 1,
        },
      },
    ],
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ThirdPartyDeliveryCompany',
      required() { return !this.courierName; },
      index: true,
    },
    courierName: { type: String, trim: true },
    assignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    assignedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

export default mongoose.model('ThirdPartyDeliveryAssignment', thirdPartyDeliveryAssignmentSchema);
