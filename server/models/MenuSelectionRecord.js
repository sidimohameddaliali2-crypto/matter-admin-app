import mongoose from 'mongoose';

/**
 * MenuSelectionRecord
 *
 * Stores a customer's meal selections for a specific weekly menu.
 * Unlike Customer.selectedMeals (which is overwritten each time a customer
 * submits for any menu), this collection keeps one record per customer+menu
 * so that admin can always view full historical selections for any menu link.
 */
const menuSelectionRecordSchema = new mongoose.Schema({
  weeklyMenuId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WeeklyMenu',
    required: true,
    index: true
  },
  // Primary join to Customer going forward. Records created/updated before
  // this field existed (or where matching couldn't resolve a Customer) may
  // have this unset — see the {weeklyMenuId, email} fallback index below and
  // server/scripts/migrate-customer-ref.js for backfilling existing records.
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    index: true
  },
  email: {
    type: String,
    required: true,
    index: true,
    lowercase: true,
    trim: true
  },
  customerId: {
    type: String,
    index: true
  },
  firstName: String,
  lastName: String,
  mealExclusion: String,
  // The Matter subscription this selection was submitted against — captured
  // from meal-profile's response at sign-in time and logged here on save,
  // since the customer-facing flow now resolves identity/plan data directly
  // from Matter (by exact email) rather than via internal Customer matching.
  matterSubscriptionId: String,

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
    // Set only for mealType: 'snack' — the randomly-assigned ingredient's
    // macros, already divided by that day's snack count.
    snackMacros: {
      C: Number,
      P: Number,
      F: Number
    },
    // True for meals filled in by kitchen staff via "Auto-Assign Main Meals" /
    // "Auto-Assign Snacks" (server/routes/menus.js) rather than picked by the
    // customer. Kept out of the customer-facing menu-selection preview
    // (GET /menus/customers/:customerId/meal-profile) — visible only in the
    // Kitchen List — so customers are never shown a choice they didn't make.
    isAutoAssigned: {
      type: Boolean,
      default: false
    },
    // A sauce/garnish exclusion match is never shown to the customer or
    // blocked — the meal is added normally, and this flag (plus the matched
    // terms) is surfaced only in the Kitchen List so staff know to swap that
    // component before it goes out.
    needsSauceChange: {
      type: Boolean,
      default: false
    },
    needsGarnishChange: {
      type: Boolean,
      default: false
    },
    sauceConflict: [String],
    garnishConflict: [String],
    // Free-text note manually flagged via Kitchen List's "Upload Meal
    // Remarks" bulk upload (matched by customer + date + meal name) —
    // kitchen staff mark a specific meal for any correction (e.g. "carb",
    // "veg", "extra spicy" — whatever the source sheet says), shown next to
    // that meal both in Kitchen List and on the Day Kitchen Paper PDF as
    // "Change {remark}". An empty remark clears it, same convention as dayNotes.
    remark: {
      type: String,
      default: ''
    },
    // Set by auto-assign only when EVERY dish that day hit the customer's
    // exclusions and it had to give one anyway (a slot is never left empty) —
    // the exclusions this dish clashes with. Shown as "Needs attention" on the
    // Kitchen List and kitchen paper so it's swapped before it goes out.
    exclusionConflict: [String]
  }],

  // Kitchen-only notes for this customer on a specific delivery day (e.g.
  // "leave at the gate", "double-check exclusions with the customer") —
  // never shown to the customer, surfaced in Kitchen List and printed on the
  // Day Kitchen Paper for that date. One entry per date; an empty note for a
  // date removes that entry rather than storing a blank string.
  dayNotes: [{
    date: { type: String, required: true }, // "YYYY-MM-DD"
    note: { type: String, required: true }
  }],

  // Days the customer chose to skip in the menu-selection link. Each entry
  // tracks the outcome of the automatic Matter subscription pause created for
  // that day (paused day + resume day placed after the cycle end). Surfaced
  // in the admin selections view only — never sent to the customer.
  skippedDays: [{
    date: { type: String },              // "YYYY-MM-DD"
    pauseStatus: {
      type: String,
      // 'declined' (2026-10-20): the customer reviewed this skip in the
      // pause-confirmation calendar and chose not to pause Matter deliveries
      // for it — the menu day still shows skipped, but no Matter call is made.
      enum: ['pending', 'success', 'already_paused', 'failed', 'declined'],
      default: 'pending'
    },
    resumeDate: { type: String },        // "YYYY-MM-DD" assigned after cycle end (on success)
    subscriptionId: { type: String },
    error: { type: String },             // failure detail shown next to the date in admin
    processedAt: { type: Date }
  }],

  submittedAt: {
    type: Date,
    default: Date.now
  }
  ,
  macros: {
    total: {
      C: Number,
      P: Number,
      F: Number,
      calories: Number
    },
    presets: {
      breakfast: {
        C: Number,
        P: Number,
        F: Number
      },
      snack: {
        C: Number,
        P: Number,
        F: Number
      }
    },
    perMeal: [{ C: Number, P: Number, F: Number, V: Number }]
  }
}, {
  timestamps: true
});

// Unique: one record per customer per weekly menu. Partial (only applies once
// `customer` is set) rather than a plain unique index on the whole
// collection, because MongoDB partial indexes can't express "customer is
// missing" (no $exists:false/$not support) — there's deliberately no
// fallback index protecting not-yet-linked records; those are an edge case
// (customerMatchService resolves a Customer on every write path now) that
// needs a human's attention anyway, not a database constraint.
menuSelectionRecordSchema.index(
  { weeklyMenuId: 1, customer: 1 },
  { unique: true, partialFilterExpression: { customer: { $type: 'objectId' } } }
);

export default mongoose.model('MenuSelectionRecord', menuSelectionRecordSchema);
