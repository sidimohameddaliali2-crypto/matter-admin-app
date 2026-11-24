import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import {validPartnerUrl} from '../services/partnerDeliverySettings.js';

const partnerContactSchema = new mongoose.Schema({
  fullName: { type: String, trim: true, default: '' },
  email: { type: String, trim: true, lowercase: true, default: '',
    match: [/^$|^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Enter a valid contact email address'] },
  phone: { type: String, trim: true, default: '' }
}, { _id: false });

const partnerSchema = new mongoose.Schema({
  businessName: { type: String, required: true, trim: true },
  // Label shown in the partner app header: MATTER RETAIL / MEMBER / PARTNER.
  accountCategory: { type: String, enum: ['retail', 'member', 'partner'], default: 'partner' },
  businessType: {
    type: String,
    enum: ['cafe', 'gym', 'restaurant', 'other'],
    required: true
  },
  contactName: { type: String, required: true, trim: true },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  password: { type: String, required: true, select: false },
  phone: { type: String, default: '' },
  // Optional business contacts, separate from the partner login identity.
  pointOfContact: { type: partnerContactSchema, default: undefined, validate: { validator: value => value !== null, message: 'Contact must be an object; leave its fields blank to clear it' } },
  // Finance/owner details are admin-only, including populated partner records.
  financeContact: { type: partnerContactSchema, default: undefined, select: false, validate: { validator: value => value !== null, message: 'Contact must be an object; leave its fields blank to clear it' } },
  ownerContact: { type: partnerContactSchema, default: undefined, select: false, validate: { validator: value => value !== null, message: 'Contact must be an object; leave its fields blank to clear it' } },
  address: { type: String, default: '' },
  minimumOrder: { type: Number, default: 0, min: 0 },
  defaultDeliveryTime: { type: String, default: null },
  weekendsDisabled: { type: Boolean, default: false },
  deliveryTimeSlots: { type: [String], default: undefined, validate: {
    validator: slots => slots == null || (slots.length > 0 && slots.length <= 20 && slots.every(slot => typeof slot === 'string' && slot.trim() === slot && slot.length > 0 && slot.length <= 80) && new Set(slots).size === slots.length),
    message: 'Provide 1–20 unique delivery times (up to 80 characters each).'
  } },
  invoiceBusinessName: { type: String, trim: true, default: '', maxlength: 200 },
  deliveryAddress: { type: String, trim: true, default: '', maxlength: 2000 },
  deliveryRecipientPhone: { type: String, trim: true, default: '', maxlength: 80 },
  websiteUrl: { type: String, trim: true, default: '', maxlength: 2000, validate: {validator: value => validPartnerUrl(value), message: 'Enter a valid http or https website URL.'} },
  instagramUrl: { type: String, trim: true, default: '', maxlength: 2000, validate: {validator: value => validPartnerUrl(value, true), message: 'Enter a valid Instagram profile URL.'} },
  // Logo / profile picture URL (DigitalOcean Spaces, or local /uploads when
  // Spaces isn't configured) — uploaded via POST /api/admin/partners/upload-picture.
  profilePicture: { type: String, default: '' },
  // Stable opaque token for the member self-registration link / QR. Generated lazily.
  memberInviteToken: { type: String, unique: true, index: true, sparse: true },
  // When true, this partner's members order through the regular customer
  // Menu Selection flow (weekly menu) rather than — or in addition to —
  // the à-la-carte partner ordering. Customers linked via Customer.partner
  // get an unlimited daily meal count and this preset macro target instead
  // of picking their own macros. See Customer.js `partner` / `unlimitedMeals`.
  menuSelectionEnabled: { type: Boolean, default: false },
  presetMacros: {
    C: { type: Number, default: 0 },
    P: { type: Number, default: 0 },
    F: { type: Number, default: 0 }
  },
  isActive: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  lastLogin: Date
}, { timestamps: true });

partnerSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

partnerSchema.methods.correctPassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

export default mongoose.model('Partner', partnerSchema);
