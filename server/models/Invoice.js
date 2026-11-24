import mongoose from 'mongoose';

const invoiceSchema = new mongoose.Schema({
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'SpaceOrder', required: true },
  space: { type: mongoose.Schema.Types.ObjectId, ref: 'Partner', required: true },
  type: { type: String, enum: ['partner', 'matter'], required: true },
  status: { type: String, enum: ['draft', 'locked'], default: 'draft' },
  billedToName: { type: String, trim: true, default: '' },
  invoiceNumber: { type: String, unique: true },
  totalRevenue: { type: Number, default: 0 }, // partner price total
  totalCost: { type: Number, default: 0 },    // COGS total (matter only)
  totalMargin: { type: Number, default: 0 },  // revenue - cost (matter only)
  lockedAt: Date
}, { timestamps: true });

invoiceSchema.index({ space: 1, type: 1, createdAt: -1 });
invoiceSchema.index({ order: 1, type: 1 });

invoiceSchema.pre('save', async function (next) {
  if (!this.invoiceNumber) {
    const year = new Date().getFullYear();
    const count = await this.constructor.countDocuments();
    const prefix = this.type === 'matter' ? 'STMT' : 'INV';
    this.invoiceNumber = `${prefix}-${year}-${String(count + 1).padStart(5, '0')}`;
  }
  next();
});

export default mongoose.model('Invoice', invoiceSchema);
