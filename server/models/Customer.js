import mongoose from 'mongoose';

const customerSchema = new mongoose.Schema({
  // Basic information
  customerId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  email: {
    type: String,
    sparse: true,
    index: true,
    lowercase: true,
    trim: true
  },
  cpf: {
    type: String,
    sparse: true,
    index: true
  },
  firstName: String,
  lastName: String,
  phone: String,
  company: String,
  address: String,

  // Manual override for the automatic email/phone/name match against a
  // Matter website subscription (see GET /api/customers/match). Set from
  // Customer Management's "Internal Customer Match" panel when the
  // subscription's email/phone don't match anything here automatically —
  // once set, it takes priority over the auto-match every time, so a
  // dispatcher never has to re-link the same customer twice.
  matterSubscriptionId: {
    type: String,
    default: null,
    index: true,
    sparse: true
  },

  // Matter's own customer id. Unlike the subscription id (which changes every
  // time a customer renews or re-subscribes, leaving the link above dead),
  // this stays the same for the life of the customer, so lookups go through
  // it first and re-point matterSubscriptionId at the current subscription
  // automatically (see services/matterNutritionLookup.js). Not unique: a
  // customer who exists twice internally shares one Matter customer id.
  matterCustomerId: {
    type: String,
    default: null,
    index: true,
    sparse: true
  },

  // Geocoded location, cached here (not just per-delivery) so a customer's
  // address is only ever sent to Google Geocoding once. Every delivery for
  // this customer — past, present, and future — and every Optimize Routes
  // run reuses this instead of re-geocoding. `address` records which address
  // string produced it: if the stored address is edited, it no longer
  // matches and the cache is treated as stale (re-resolved on next use).
  // `source: 'unresolved'` is a deliberate negative cache — the address
  // failed to geocode plausibly last time, so don't retry it against Google
  // on every single lookup, only when the address actually changes.
  gpsLocation: {
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    source: { type: String, default: null }, // 'google' | 'link' | 'manual' | 'unresolved'
    address: { type: String, default: null },
    geocodedAt: { type: Date, default: null }
  },
  macros: {
    C: { type: Number, default: 0 },
    P: { type: Number, default: 0 },
    F: { type: Number, default: 0 }
  },

  // Links this customer to a B2B Partner (gym/cafe/etc) whose members order
  // through the regular Menu Selection flow instead of — or alongside — the
  // Partner's à-la-carte ordering. Set from Customer Management or when a
  // customer record is provisioned for a Partner's member. See Partner.js
  // `menuSelectionEnabled` / `presetMacros`.
  partner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Partner',
    default: null,
    index: true
  },
  // Bypasses the mealPerDay cap in the customer-facing menu-selection UI.
  // Typically set alongside `partner` for a menuSelectionEnabled Partner —
  // their members select freely with no daily meal limit.
  unlimitedMeals: {
    type: Boolean,
    default: false
  },

  // Meal preferences from Athleat
  mealPerDay: {
    type: Number,
    default: 1,
    min: 0,
    max: 5
  },
  breakfastInclude: {
    type: Boolean,
    default: false
  },
  mealSnack: {
    type: Boolean,
    default: false
  },
  snackCount: {
    type: Number,
    default: 0,
    min: 0
  },
  mealPlan: {
    type: String,
    enum: ['Standard', 'Customized', 'Premium', 'Vegan', 'Keto', 'Paleo', 'Bodybuilder', 'Lean 2 Meal', 'Lean 3 Meal', 'Thrive 2 Meal', 'Thrive 3 Meal', 'Perform 2 Meal', 'Perform 3 Meal'],
    default: 'Standard'
  },
  mealExclusion: {
    type: String,
    default: ''
  },
  
  // Data source
  dataSource: {
    type: String,
    default: 'WebData'
  },
  
  // Athleat sync
  athleatId: String,
  athleatModId: String, // For optimistic locking
  athleatSyncedAt: Date,
  uuid: String, // uuid_Customer - THE KEY FOR RELATIONSHIPS with Orders
  
  // Weekly menu selection
  selectedMeals: [{
    date: Date,
    mealType: {
      type: String,
      enum: ['breakfast', 'main', 'snack']
    },
    menuItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MenuItem'
    },
    mealName: String,
    description: String,
    slotNumber: Number,
    proteinChoice: String,
    vegChoice: String,
    carbChoice: String,
    sauceChoice: String,
    manualProteinType: {
      type: String,
      enum: ['', 'chicken', 'beef', 'fish'],
      default: ''
    },
    quantity: {
      type: Number,
      default: 1,
      min: 1
    },
    carbVegAction: {
      type: String,
      enum: ['kept', 'replace']
    },
    carbVegConflict: [String],
    carbConflict: [String],
    vegConflict: [String],
    // See MenuSelectionRecord.js for the fuller comment — never shown to the
    // customer, surfaced only in the Kitchen List.
    needsSauceChange: {
      type: Boolean,
      default: false
    },
    needsGarnishChange: {
      type: Boolean,
      default: false
    },
    sauceConflict: [String],
    garnishConflict: [String]
  }],
  
  // Current week info
  currentWeekMenu: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WeeklyMenu'
  },
  lastMenuSelectionDate: Date,
  
  // Preferences
  dietaryRestrictions: [String],
  allergies: [String],
  preferences: String,
  weekend: {
    type: Boolean,
    default: false
  },
  
  // Plan cycle / subscription
  planStartDate: {
    type: Date,
    default: null
  },
  cycleDuration: {
    type: Number,
    default: 0
  },
  amountPaid: {
    type: String,
    default: ''
  },
  discount: {
    type: String,
    default: ''
  },

  // System fields
  isActive: {
    type: Boolean,
    default: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Indexes for searches
customerSchema.index({ customerId: 1 }, { unique: true });
customerSchema.index({ email: 1 }, { unique: true, sparse: true }); // Sparse allows multiple null values
customerSchema.index({ athleatId: 1 }, { sparse: true });
// One Matter subscription can only ever belong to one internal customer.
// Enforced here at the DB level in addition to the clear-then-set app logic
// in POST /api/customers/match/link. A plain `sparse` index doesn't work
// here: the field's own `default: null` means "unset" is stored as a
// literal null, not an absent field, and sparse only excludes absent fields
// — so a sparse+unique index still collides on every null (confirmed live,
// 2026-10-13, after the index had silently drifted to non-unique for this
// exact reason and let a real duplicate customer through). A partial index
// with an explicit $type filter correctly excludes both null and missing.
customerSchema.index(
  { matterSubscriptionId: 1 },
  { unique: true, partialFilterExpression: { matterSubscriptionId: { $type: 'string' } } }
);

export default mongoose.model('Customer', customerSchema);
