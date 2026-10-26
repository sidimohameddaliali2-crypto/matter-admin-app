import mongoose from 'mongoose';

const SlackLogSchema = new mongoose.Schema(
  {
    type: { type: String, required: true },
    text: { type: String, required: true },
    payload: { type: Object },
    webhookUrl: { type: String },
    channel: { type: String },
    ts: { type: String },
    responseStatus: { type: Number },
    responseError: { type: String },
    // Associations
    communicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Communication' },
    deliveryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Delivery' },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Partner' },
    partnerOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'SpaceOrder' },
    customerId: { type: String },
    customerName: { type: String },
    bagIds: [{ type: String }],
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

SlackLogSchema.index({ createdAt: -1 });
SlackLogSchema.index({ type: 1, createdAt: -1 });
SlackLogSchema.index({ customerId: 1, createdAt: -1 });
SlackLogSchema.index({ communicationId: 1, createdAt: -1 });

const SlackLog = mongoose.model('SlackLog', SlackLogSchema);
export default SlackLog;
