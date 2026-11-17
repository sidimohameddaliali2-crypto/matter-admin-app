import mongoose from 'mongoose';

const partnerMenuItemSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  mealType: {
    type: String,
    enum: ['breakfast', 'main', 'snack', 'bowl', 'wraps-buns', 'oats'],
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
  // Synced breakfasts use exact serving dates; an envelope alone would also
  // offer a repeated Monday/Friday dish on the intervening days.
  availableDates: { type: [Date], default: undefined },
  menuSelectionDatesByMenu: { type: Map, of: [Date], default: undefined },
  breakfastSyncKey: { type: String, default: undefined },
  breakfastScheduleRevision: { type: Number, default: 0 },
  category: { type: String, default: '' },
  ingredients: { type: [String], default: [] },
  sortOrder: { type: Number, default: 0 },
  // 'menu-selection' = auto-synced from a published WeeklyMenu's chicken/beef/fish
  // rotation (see services/menuSelectionPartnerSync.js) — its availability window
  // is managed by that sync, not an admin. 'manual' = entered directly in this menu.
  source: { type: String, enum: ['manual', 'menu-selection'], default: 'manual' }
}, { timestamps: true });

partnerMenuItemSchema.index({ mealType: 1, sortOrder: 1 });
// Only normalized breakfast keys participate; legacy items can be adopted
// without deleting or re-keying order/invoice references.
partnerMenuItemSchema.index({ breakfastSyncKey: 1 }, { unique: true,
  partialFilterExpression: { source: 'menu-selection', mealType: 'breakfast', breakfastSyncKey: { $type: 'string' } } });

export default mongoose.model('PartnerMenuItem', partnerMenuItemSchema);
