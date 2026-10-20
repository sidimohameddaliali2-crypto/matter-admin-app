import mongoose from 'mongoose';

const partnerMenuItemSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  mealType: {
    type: String,
    enum: ['main', 'snack', 'bowl', 'wraps-buns', 'oats'],
    required: true
  },
  description: { type: String, default: '' },
  price: { type: Number, required: true, min: 0 },
  // Selling price applied to every partner unless that partner has its own
  // SpacePrice override (sub-menu price). Falls back to base price if unset.
  sellingPrice: { type: Number, default: null, min: 0 },
  isAvailable: { type: Boolean, default: true },
  availableFrom: { type: Date, default: null },
  availableTo: { type: Date, default: null },
  category: { type: String, default: '' },
  ingredients: { type: [String], default: [] },
  sortOrder: { type: Number, default: 0 },
  // 'menu-selection' = auto-synced from a published WeeklyMenu's chicken/beef/fish
  // rotation (see services/menuSelectionPartnerSync.js) — its availability window
  // is managed by that sync, not an admin. 'manual' = entered directly in this menu.
  source: { type: String, enum: ['manual', 'menu-selection'], default: 'manual' }
}, { timestamps: true });

partnerMenuItemSchema.index({ mealType: 1, sortOrder: 1 });

export default mongoose.model('PartnerMenuItem', partnerMenuItemSchema);
