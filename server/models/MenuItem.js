import mongoose from 'mongoose';

// One ingredient pulled from a Supy recipe, with a per-ingredient toggle for
// whether it's shown to the customer (visible: true) or kept backend-only
// (visible: false) — exclusion/allergen matching always checks every
// ingredient regardless of this flag; it only controls customer display.
const taggedIngredientSchema = new mongoose.Schema({
  name: { type: String, required: true },
  visible: { type: Boolean, default: true }
}, { _id: false });

const menuItemSchema = new mongoose.Schema({
  // From Athleat
  athleatId: String,
  itemDate: Date,
  mealType: {
    type: String,
    enum: ['breakfast', 'main', 'snack'],
    required: true
  },
  mealName: {
    type: String,
    required: true
  },
  mealPlan: {
    type: String,
    enum: ['Standard', 'Customized', 'Premium', 'Vegan', 'Keto', 'Paleo', 'Bodybuilder', 'Lean 2 Meal', 'Lean 3 Meal', 'Thrive 2 Meal', 'Thrive 3 Meal', 'Perform 2 Meal', 'Perform 3 Meal'],
    default: 'Standard'
  },
  
  // Description and details
  description: String,
  ingredients: String,
  proteinSource: {
    type: String,
    default: ''
  },
  category: {
    type: String,
    enum: ['WARM', 'COLD', ''],
    default: ''
  },
  intolerances: {
    type: String,
    default: ''
  },
  garnish: {
    type: String,
    default: ''
  },
  veg: String,
  sauce: String,
  // Protein type for kitchen-list grouping and the main-meal rotation.
  // Named portionType (not proteinType) to match the "Portion" component
  // label used throughout the meal editor.
  portionType: {
    type: String,
    enum: ['chicken', 'beef', 'fish', ''],
    default: ''
  },
  // Which rotation pool this meal belongs to for a given day — 'main' (today's
  // primary chicken/beef/fish options) or 'sub' (fallback used only when a
  // customer's exclusions rule out all primary options). Distinct from the
  // existing `category` field above (WARM/COLD serving temperature).
  rotationCategory: {
    type: String,
    enum: ['main', 'sub', ''],
    default: ''
  },
  // Additive tag, independent of rotationCategory (main/sub) — marks this
  // meal as also eligible for the Matter Core plan's own rotation
  // (matterCoreMealOptionsByDate / runAssignMatterCoreMeals), which ignores
  // portionType/chicken-beef-fish and just cycles through eligible meals in
  // order for that day.
  usedForCorePlan: {
    type: Boolean,
    default: false
  },
  // Ingredients pulled from the Supy recipe selected for each component —
  // separate from proteinSource/carbs/veg/sauce (which hold the searched
  // recipe's own name, shown to the customer) so exclusion matching can
  // check the real ingredients internally without changing what the
  // customer sees. Each is tagged per-ingredient (see taggedIngredientSchema).
  portionIngredients: { type: [taggedIngredientSchema], default: [] },
  carbIngredients: { type: [taggedIngredientSchema], default: [] },
  vegIngredients: { type: [taggedIngredientSchema], default: [] },
  sauceIngredients: { type: [taggedIngredientSchema], default: [] },
  instructions: String,
  image: String, // URL to image
  
  // Nutritional info
  calories: {
    type: Number,
    default: 0
  },
  protein: {
    type: Number,
    default: 0
  },
  carbs: {
    type: String,
    default: ''
  },
  fat: {
    type: Number,
    default: 0
  },
  fiber: {
    type: Number,
    default: 0
  },
  
  // Allergen information
  allergens: [String], // e.g., ['gluten', 'dairy', 'nuts']
  isVegan: {
    type: Boolean,
    default: false
  },
  isGlutenFree: {
    type: Boolean,
    default: false
  },
  
  // Full Cycle Menu meal/component snapshot. Display fields above remain the
  // customer-facing menu; this snapshot retains internal dietary rule metadata.
  cycleMeal: { type: mongoose.Schema.Types.Mixed, default: undefined },

  // Availability
  isAvailable: {
    type: Boolean,
    default: true
  },
  price: {
    type: Number,
    default: 0,
    min: 0
  },
  
  // Tracking
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

menuItemSchema.index({ itemDate: 1, mealType: 1 });
menuItemSchema.index({ mealPlan: 1 });

export default mongoose.model('MenuItem', menuItemSchema);
