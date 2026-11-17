import mongoose from 'mongoose';
import { FIXED_SELECTION_DEADLINES } from '../config/selectionDeadlines.js';

const breakfastPresetSchema = new mongoose.Schema({
  breakfastName: { type: String, default: '' },
  C: { type: Number, default: 0 },
  P: { type: Number, default: 0 },
  F: { type: Number, default: 0 },
  V: { type: Number, default: 80 },
  isLargeBreakfast: { type: Boolean, default: false }
}, { _id: false });

const snackOptionSchema = new mongoose.Schema({
  name: { type: String, required: true },
  // Ingredient/allergen tags this snack contains (e.g. "Dairy", "Nuts") —
  // matched against the customer's exclusion list, not the snack's name.
  exclusions: { type: [String], default: [] },
  C: { type: Number, default: 0 },
  P: { type: Number, default: 0 },
  F: { type: Number, default: 0 }
}, { _id: false });

const mainMealOptionSchema = new mongoose.Schema({
  name: { type: String, required: true },
  type: { type: String, enum: ['chicken', 'beef', 'fish'], required: true },
  exclusions: { type: [String], default: [] }
}, { _id: false });

const breakfastOptionSchema = new mongoose.Schema({
  name: { type: String, required: true },
  // Ingredient/allergen tags this breakfast contains — matched against the
  // customer's exclusion list, same as snack/main-meal options. Macros are
  // NOT stored here: they're resolved at read time by name against the
  // menu's breakfastPresetsByName (the same global preset system used by
  // the kitchen weight calculator), so one upload feeds both.
  exclusions: { type: [String], default: [] }
}, { _id: false });

// Matter Core plan customers get a simpler, purely positional rotation: no
// type (chicken/beef/fish), no exclusion filtering — a customer needing 2
// meals just gets list[0] and list[1], in the order the kitchen entered them.
const matterCoreMealOptionSchema = new mongoose.Schema({
  name: { type: String, required: true }
}, { _id: false });

const weeklyMenuSchema = new mongoose.Schema({
  // Menu info
  title: {
    type: String,
    required: true
  },
  description: String,
  
  // Week range
  startDate: {
    type: Date,
    required: true
  },
  endDate: {
    type: Date,
    required: true
  },
  
  // Menu items organized by day and meal type
  meals: [{
    date: Date,
    mealType: {
      type: String,
      enum: ['breakfast', 'main', 'snack']
    },
    items: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MenuItem'
    }]
  }],
  
  // Meal plans included
  mealPlans: [{
    type: String,
    enum: ['Standard', 'Customized', 'Premium', 'Vegan', 'Keto', 'Paleo', 'Bodybuilder', 'Lean 2 Meal', 'Lean 3 Meal', 'Thrive 2 Meal', 'Thrive 3 Meal', 'Perform 2 Meal', 'Perform 3 Meal']
  }],
  
  // Sharing
  shareLink: {
    token: {
      type: String,
      unique: true,
      index: true
    },
    createdAt: Date,
    expiresAt: Date,
    isActive: {
      type: Boolean,
      default: true
    }
  },
  
  // Status
  isPublished: {
    type: Boolean,
    default: false
  },
  isActive: {
    type: Boolean,
    default: true
  },
  
  // Per-day selection deadlines — a fixed company-wide policy (see
  // config/selectionDeadlines.js), not something set per menu. Always
  // (re)applied by routes/menus.js on create and update; this schema default
  // is just a defensive fallback for any doc created some other way.
  selectionDeadlines: {
    type: [{
      deliveryDay: {
        type: String,
        enum: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
      },
      // How many days before the delivery day the deadline falls
      // e.g. 3 means the deadline is 3 days before the delivery date
      daysBefore: {
        type: Number,
        default: 3
      },
      // Time of day for the deadline in HH:MM (24h)
      deadlineTime: {
        type: String,
        default: '23:59'
      }
    }],
    default: FIXED_SELECTION_DEADLINES
  },

  // Completion Message
  enableCompletionMessage: {
    type: Boolean,
    default: false
  },
  completionMessage: {
    type: String,
    default: 'Your meal selections have been saved successfully.'
  },

  // Kitchen list breakfast presets imported from CSV/Excel.
  breakfastPreset: {
    type: breakfastPresetSchema,
    default: () => ({})
  },
  breakfastPresetsByName: {
    type: Map,
    of: breakfastPresetSchema,
    default: () => ({})
  },

  // Kitchen-defined snack ingredient options per date (YYYY-MM-DD keys), split
  // into a "first snack" and "second snack" pool. The customer never chooses
  // these — Auto-Assign fills each day's snack slots by drawing slot 1 (and
  // every odd-numbered slot) from `first`, slot 2 (and every even-numbered
  // slot) from `second`, each pick random within its pool and excluding
  // anything on the customer's exclusion list.
  snackOptionsByDate: {
    type: Map,
    of: {
      first: { type: [snackOptionSchema], default: [] },
      second: { type: [snackOptionSchema], default: [] }
    },
    default: () => ({})
  },

  // Kitchen-defined main meal rotation per date: up to 3 primary options
  // cycled through in order (not random), plus a fallback pool used only
  // when a customer's exclusions rule out all 3 primary options.
  mainMealOptionsByDate: {
    type: Map,
    of: {
      mainMeals: { type: [mainMealOptionSchema], default: [] },
      subMeals: { type: [mainMealOptionSchema], default: [] }
    },
    default: () => ({})
  },

  // Kitchen-defined breakfast rotation per date (YYYY-MM-DD keys) — which
  // breakfast names (from breakfastPresetsByName) are offered that day, and
  // their exclusion tags. Used by Auto-Assign Main Meals to fill a
  // customer's breakfast slot when their profile has breakfastInclude set.
  breakfastOptionsByDate: {
    type: Map,
    of: [breakfastOptionSchema],
    default: () => ({})
  },

  // Kitchen-defined meal rotation per date for Matter Core plan customers —
  // a plain ordered list (no type, no exclusions). Auto-populate assigns
  // these positionally: a customer needing N meals gets list[0]..list[N-1]
  // (offset by however many they already have that day), first breakfast
  // option and first snack option/pool pick, no randomization or exclusion
  // filtering — Matter Core customers get whatever's next on the list.
  matterCoreMealOptionsByDate: {
    type: Map,
    of: [matterCoreMealOptionSchema],
    default: () => ({})
  },

  // Analytics
  viewCount: {
    type: Number,
    default: 0
  },
  selectionCount: {
    type: Number,
    default: 0
  },
  
  // Internal transaction fence; does not alter the staff edit timestamp.
  partnerBreakfastSyncRevision: { type: Number, default: 0 },

  // Tracking
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
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

weeklyMenuSchema.index({ startDate: 1, endDate: 1 });
weeklyMenuSchema.index({ 'shareLink.token': 1 });
weeklyMenuSchema.index({ isActive: 1, isPublished: 1 });

export default mongoose.model('WeeklyMenu', weeklyMenuSchema);
