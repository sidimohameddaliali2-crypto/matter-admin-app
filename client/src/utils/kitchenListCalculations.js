import { kitchenInputErrors, KITCHEN_FORMULA_VERSION } from './kitchenIntegrity';

const normalizeText = (value) => String(value || '').trim().toLowerCase();

const calculateCalories = ({ C = 0, P = 0, F = 0 }) => {
  const carbs = Number(C) || 0;
  const protein = Number(P) || 0;
  const fat = Number(F) || 0;
  return Math.round((protein * 4) + (carbs * 4) + (fat * 9));
};

const getDateKey = (value) => {
  if (!value) return 'unknown-date';

  if (typeof value === 'string') {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) {
      return `${match[1]}-${match[2]}-${match[3]}`;
    }
  }

  // Meal dates arrive as UTC-midnight Date objects (Mongo returns
  // "YYYY-MM-DD" strings parsed via `new Date(...)`, which is UTC midnight
  // per spec) — reading them back with local getters shifts the day
  // backward in any timezone behind UTC, misfiling a meal into the wrong
  // day's macro bucket. UTC getters read the same calendar date it was built from.
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  const y = parsed.getUTCFullYear();
  const m = String(parsed.getUTCMonth() + 1).padStart(2, '0');
  const d = String(parsed.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const getProteinMealWeight = (grams) => {
  const rounded = Math.round(Number(grams) || 0);
  if (rounded < 25) return 100;
  if (rounded <= 29) return 100;
  if (rounded <= 35) return 120;
  if (rounded <= 40) return 140;
  if (rounded <= 45) return 160;
  if (rounded <= 50) return 180;
  if (rounded <= 55) return 200;
  if (rounded <= 60) return 220;
  return 240;
};

const getCarbMealWeight = (grams) => {
  const rounded = Math.round(Number(grams) || 0);
  if (rounded <= 10) return 20;
  if (rounded <= 15) return 50;
  if (rounded <= 20) return 70;
  if (rounded <= 24) return 85;
  if (rounded <= 30) return 100;
  if (rounded <= 35) return 115;
  if (rounded <= 40) return 135;
  if (rounded <= 45) return 150;
  if (rounded <= 50) return 155;
  if (rounded <= 55) return 160;
  if (rounded <= 60) return 165;
  if (rounded <= 65) return 180;
  if (rounded <= 70) return 200;
  if (rounded <= 75) return 210;
  return 225;
};

const FIXED_PLAN_MEAL_MACROS = {
  lean: { C: 35, P: 30, F: 15 },
  thrive: { C: 65, P: 40, F: 20 },
  perform: { C: 75, P: 50, F: 33 }
};

// "Lean Plan 1/2", "Thrive Plan 1/2", "Perform Plan 1/2" → fixed per-meal macros.
// Anything else (Custom, Matter Core, ...) returns null and is left alone.
const getFixedPlanMealMacros = (planName) => {
  const match = normalizeText(planName).match(/^(lean|thrive|perform) plan [12]$/);
  return match ? { ...FIXED_PLAN_MEAL_MACROS[match[1]] } : null;
};

const normalizeBreakfastName =(value) => normalizeText(String(value || '').replace(/\s+/g, ' ').trim());

const simplifyBreakfastName = (value) => normalizeText(
  String(value || '')
    .replace(/&/g, ' and ')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
);

  const compactBreakfastName = (value) => simplifyBreakfastName(value).replace(/\s+/g, '');

const getDefaultBreakfastPreset = (preset = {}) => {
  return {
    name: String(preset.breakfastName || '').trim(),
    C: Number(preset.C) || 0,
    P: Number(preset.P) || 0,
    F: Number(preset.F) || 0,
    V: Number(preset.V) || 80,
    isLargeBreakfast: !!preset.isLargeBreakfast
  };
};

// Per-meal breakfast-preset matching falls back to up to 3 scans over the
// whole preset table (simplified-name, compact-name, substring) whenever
// there's no exact key hit — called once per meal, per customer, on every
// recompute. Indexing the simplified/compact scans as Maps (built once per
// distinct `presetsByName` object, cached by object identity) turns that
// into O(1) lookups; only the inherently-O(n) substring fallback still
// scans, but with its candidate keys precomputed instead of re-normalized
// per meal. `presetsByName` is a freshly-built object on every real preset
// reload (never mutated in place), so WeakMap identity caching invalidates
// correctly and automatically.
const breakfastPresetIndexCache = new WeakMap();
const getBreakfastPresetIndex = (map) => {
  let index = breakfastPresetIndexCache.get(map);
  if (index) return index;

  const bySimplifiedKey = new Map();
  const byCompactKey = new Map();
  const entries = [];
  Object.entries(map || {}).forEach(([rawKey, rawValue]) => {
    const candidateName = rawValue?.breakfastName || rawKey;
    const simplifiedCandidateKey = simplifyBreakfastName(candidateName);
    const compactCandidateKey = compactBreakfastName(candidateName);
    if (simplifiedCandidateKey && !bySimplifiedKey.has(simplifiedCandidateKey)) {
      bySimplifiedKey.set(simplifiedCandidateKey, rawValue);
    }
    if (compactCandidateKey && !byCompactKey.has(compactCandidateKey)) {
      byCompactKey.set(compactCandidateKey, rawValue);
    }
    entries.push({ simplifiedCandidateKey, compactCandidateKey, value: rawValue });
  });

  index = { bySimplifiedKey, byCompactKey, entries };
  breakfastPresetIndexCache.set(map, index);
  return index;
};

const resolveBreakfastPresetForMeal = (meal, preset = {}) => {
  const defaultPreset = getDefaultBreakfastPreset(preset);
  const map = preset?.presetsByName || {};
  const mealBreakfastName = String(
    meal?.breakfastName
    || meal?.mealName
    || meal?.menuItemName
    || meal?.menuItemId?.mealName
    || ''
  ).trim();
  const exactKey = normalizeBreakfastName(mealBreakfastName);
  const simplifiedMealKey = simplifyBreakfastName(mealBreakfastName);
  const compactMealKey = compactBreakfastName(mealBreakfastName);

  let match = exactKey ? map[exactKey] : null;

  if (!match && simplifiedMealKey) {
    const index = getBreakfastPresetIndex(map);

    match = index.bySimplifiedKey.get(simplifiedMealKey) || null;

    if (!match && compactMealKey) {
      match = index.byCompactKey.get(compactMealKey) || null;
    }

    if (!match) {
      const partialEntry = index.entries.find(({ simplifiedCandidateKey, compactCandidateKey }) => {
        if (!simplifiedCandidateKey) return false;
        return (
          simplifiedMealKey.includes(simplifiedCandidateKey)
          || simplifiedCandidateKey.includes(simplifiedMealKey)
          || (compactMealKey && compactCandidateKey && (
            compactMealKey.includes(compactCandidateKey)
            || compactCandidateKey.includes(compactMealKey)
          ))
        );
      });
      if (partialEntry) {
        match = partialEntry.value;
      }
    }
  }

  if (!match) return defaultPreset;
  return {
    name: mealBreakfastName,
    C: Number(match.C) || 0,
    P: Number(match.P) || 0,
    F: Number(match.F) || 0,
    V: Number(match.V) || 80,
    isLargeBreakfast: !!match.isLargeBreakfast
  };
};

// Global snack macro table (see KitchenSnackPreset, kitchen-snack-presets
// endpoint): each entry is that snack's own fixed C/P/F, matched by name the
// same fuzzy way breakfast presets are — used directly, with NO division by
// snacksPerDay, unlike the per-date Snack Rotation list's C/P/F. A snack
// whose name doesn't match anything here falls back to whatever macros are
// already stored on the meal (meal.snackMacros — the per-date option's own
// value, divided by snacksPerDay at assignment time), so nothing regresses
// for snacks the kitchen hasn't added to this table yet.
// Same identity-cached-index approach as resolveBreakfastPresetForMeal above.
const snackPresetIndexCache = new WeakMap();
const getSnackPresetIndex = (map) => {
  let index = snackPresetIndexCache.get(map);
  if (index) return index;

  const bySimplifiedKey = new Map();
  const byCompactKey = new Map();
  Object.entries(map || {}).forEach(([rawKey, rawValue]) => {
    const candidateName = rawValue?.snackName || rawKey;
    const simplifiedCandidateKey = simplifyBreakfastName(candidateName);
    const compactCandidateKey = compactBreakfastName(candidateName);
    if (simplifiedCandidateKey && !bySimplifiedKey.has(simplifiedCandidateKey)) {
      bySimplifiedKey.set(simplifiedCandidateKey, rawValue);
    }
    if (compactCandidateKey && !byCompactKey.has(compactCandidateKey)) {
      byCompactKey.set(compactCandidateKey, rawValue);
    }
  });

  index = { bySimplifiedKey, byCompactKey };
  snackPresetIndexCache.set(map, index);
  return index;
};

const resolveSnackPresetForMeal = (meal, snackPresetsByName = {}) => {
  const mealSnackName = String(meal?.mealName || meal?.menuItemName || meal?.menuItemId?.mealName || '').trim();
  if (!mealSnackName) return null;

  const exactKey = normalizeBreakfastName(mealSnackName);
  const simplifiedMealKey = simplifyBreakfastName(mealSnackName);
  const compactMealKey = compactBreakfastName(mealSnackName);

  let match = exactKey ? snackPresetsByName[exactKey] : null;

  if (!match && simplifiedMealKey) {
    const index = getSnackPresetIndex(snackPresetsByName);

    match = index.bySimplifiedKey.get(simplifiedMealKey) || null;

    if (!match && compactMealKey) {
      match = index.byCompactKey.get(compactMealKey) || null;
    }
  }

  if (!match) return null;
  return {
    C: Number(match.C) || 0,
    P: Number(match.P) || 0,
    F: Number(match.F) || 0
  };
};

// Used by the Kitchen List to hold Auto-Assign back: does this breakfast /
// snack name resolve to a saved preset that actually carries macros? A name
// with no preset (or one saved as all zeros) would show 0/0/0 and take the
// wrong amount off the customer's day, so it must get values first. Uses the
// exact same matching as the calculation itself, so "has macros here" always
// agrees with what the kitchen list will show.
export const breakfastNameHasMacros = (name, breakfastPreset) => {
  // No default preset passed in on purpose: an unmatched name then comes back
  // with an empty name instead of silently borrowing the default's macros.
  const resolved = resolveBreakfastPresetForMeal(
    { breakfastName: name },
    { presetsByName: breakfastPreset?.presetsByName || {} }
  );
  return !!resolved.name && (resolved.C + resolved.P + resolved.F) > 0;
};

export const snackNameHasMacros = (name, snackPreset) => {
  const resolved = resolveSnackPresetForMeal({ mealName: name }, snackPreset?.presetsByName || {});
  return !!resolved && (resolved.C + resolved.P + resolved.F) > 0;
};

// Matter Core plan customers skip the proportional macro-split entirely.
// Their Matter API macros.carbohydrates/protein aren't a macro-nutrient
// budget — they're the customer's TOTAL DAILY WEIGHT (grams of food) for
// carbs and protein, divided evenly by however many main meals they have
// that day to get a per-meal weight, which is then looked up here to get
// that meal's actual C/P/F. Only these exact combinations are known; a
// combination outside this table is never guessed at — the meal is flagged
// (matterCoreLookupMissing) for a human to fill in instead.
const MATTER_CORE_WEIGHT_TO_MACROS = [
  { carbWeight: 100, proteinWeight: 100, C: 28, P: 25, F: 11 },
  { carbWeight: 150, proteinWeight: 150, C: 40, P: 40, F: 15 },
  { carbWeight: 150, proteinWeight: 200, C: 40, P: 50, F: 18 },
  { carbWeight: 200, proteinWeight: 200, C: 50, P: 50, F: 20 }
];

const lookupMatterCoreMacros = (carbWeight, proteinWeight) => {
  const roundedCarb = Math.round(carbWeight);
  const roundedProtein = Math.round(proteinWeight);
  return MATTER_CORE_WEIGHT_TO_MACROS.find(
    (row) => row.carbWeight === roundedCarb && row.proteinWeight === roundedProtein
  ) || null;
};

// Owner (2026-10-07): the delivery-number adjustment (+1% / -1% / +2% / -2%
// by position in the plan's cycle) is switched off — FileMaker's Thursday
// kitchen paper applies none. To bring it back, restore the pattern below.
const getMacroAdjustment = () => 0;
// const MACRO_ADJUSTMENT_PATTERN = [0.01, -0.01, 0.02, -0.02];

const resolveProteinType = (meal) => {
  // manualProteinType is a kitchen staffer's explicit override (highest
  // priority); menuItemId.portionType is the type set on the meal itself in
  // the meal editor (Supy-linked meals) — both are explicit tags, checked
  // before falling back to keyword-sniffing the meal name below.
  const manualProteinType = normalizeText(
    meal?.manualProteinType || meal?.proteinType || meal?.proteinSourceType || meal?.menuItemId?.portionType
  );
  if (manualProteinType === 'chicken' || manualProteinType === 'beef' || manualProteinType === 'fish') {
    return manualProteinType;
  }
  const mealName = normalizeText(meal?.proteinChoice || meal?.mealName || meal?.description);
  if (mealName.includes('chicken')) return 'chicken';
  if (mealName.includes('beef')) return 'beef';
  if (mealName.includes('fish') || mealName.includes('shrimp') || mealName.includes('salmon') || mealName.includes('seafood')) return 'fish';
  return 'other';
};

const applySequenceMultiplier = (value, positionIndex) => {
  const multiplier = Math.max(0, Number(positionIndex) || 0);
  return value - (value * 0.05 * multiplier);
};

const buildDayMealMeta = (dayMeals) => {
  const nonBreakfastMeals = dayMeals.filter((meal) => {
    const t = normalizeText(meal?.mealType);
    return t !== 'breakfast' && t !== 'snack';
  });
  const typed = nonBreakfastMeals.map((meal) => ({
    meal,
    type: resolveProteinType(meal)
  }));

  const chickenMeals = typed.filter((item) => item.type === 'chicken');
  const beefMeals = typed.filter((item) => item.type === 'beef');
  const fishMeals = typed.filter((item) => item.type === 'fish');
  const beefOrFishMeals = typed.filter((item) => item.type === 'beef' || item.type === 'fish');
  const hasChicken = chickenMeals.length > 0;
  const hasBeef = beefMeals.length > 0;
  const hasFish = fishMeals.length > 0;
  // Owner (2026-10-05): match FileMaker. Its output (verified against the Oct 5
  // comparison PDF — all-beef, beef+fish and chicken+beef days alike) never uses
  // the "only beef / only fish" variant (protein -5.234%): beef always takes
  // -7.98% carbs / +6% protein / +10.3% fat and fish -10.98% / -6% / +13.3%,
  // with the 5% repeat penalty counted within the same type.
  const allBeefOrFishSingleTypeDay = false;

  const positionMap = new Map();
  chickenMeals.forEach((item, index) => positionMap.set(item.meal, { group: 'chicken', index }));
  beefMeals.forEach((item, index) => positionMap.set(item.meal, { group: 'beef', index }));
  fishMeals.forEach((item, index) => positionMap.set(item.meal, { group: 'fish', index }));
  beefOrFishMeals.forEach((item, index) => {
    const existing = positionMap.get(item.meal) || {};
    positionMap.set(item.meal, { ...existing, beefFishIndex: index });
  });

  return {
    nonBreakfastCount: nonBreakfastMeals.length,
    hasBreakfast: dayMeals.some((meal) => normalizeText(meal?.mealType) === 'breakfast'),
    allBeefOrFishSingleTypeDay,
    hasChicken,
    hasBeef,
    hasFish,
    positionMap
  };
};

const calculateByProteinRule = ({
  type,
  carbsBase,
  proteinBase,
  fatsBase,
  meta,
  meal
}) => {
  const pos = meta.positionMap.get(meal) || {};

  // Carbs
  let carbsValue = carbsBase;
  if (type === 'chicken') {
    carbsValue = carbsBase + (carbsBase * 0.0713);
    carbsValue = applySequenceMultiplier(carbsValue, pos.index);
  } else if (type === 'beef') {
    if (meta.allBeefOrFishSingleTypeDay) {
      carbsValue = carbsBase - (carbsBase * 0.0798);
      carbsValue = applySequenceMultiplier(carbsValue, pos.beefFishIndex);
    } else {
      carbsValue = carbsBase - (carbsBase * 0.0798);
      carbsValue = applySequenceMultiplier(carbsValue, pos.index);
    }
  } else if (type === 'fish') {
    if (meta.allBeefOrFishSingleTypeDay) {
      carbsValue = carbsBase - (carbsBase * 0.0798);
      carbsValue = applySequenceMultiplier(carbsValue, pos.beefFishIndex);
    } else {
      carbsValue = carbsBase - (carbsBase * 0.1098);
      carbsValue = applySequenceMultiplier(carbsValue, pos.index);
    }
  }

  // Protein
  let proteinValue = proteinBase;
  if (type === 'chicken') {
    proteinValue = proteinBase + (proteinBase * 0.05234);
    proteinValue = applySequenceMultiplier(proteinValue, pos.index);
  } else if (type === 'beef') {
    if (meta.allBeefOrFishSingleTypeDay) {
      proteinValue = proteinBase - (proteinBase * 0.05234);
      proteinValue = applySequenceMultiplier(proteinValue, pos.beefFishIndex);
    } else {
      proteinValue = proteinBase + (proteinBase * 0.06);
      proteinValue = applySequenceMultiplier(proteinValue, pos.index);
    }
  } else if (type === 'fish') {
    if (meta.allBeefOrFishSingleTypeDay) {
      proteinValue = proteinBase - (proteinBase * 0.05234);
      proteinValue = applySequenceMultiplier(proteinValue, pos.beefFishIndex);
    } else {
      proteinValue = proteinBase - (proteinBase * 0.06);
      proteinValue = applySequenceMultiplier(proteinValue, pos.index);
    }
  }

  // Fats
  let fatsValue = fatsBase;
  if (type === 'chicken') {
    fatsValue = fatsBase - (fatsBase * 0.103);
    fatsValue = applySequenceMultiplier(fatsValue, pos.index);
  } else if (type === 'beef') {
    if (meta.allBeefOrFishSingleTypeDay) {
      fatsValue = fatsBase + (fatsBase * 0.103);
      fatsValue = applySequenceMultiplier(fatsValue, pos.beefFishIndex);
    } else {
      fatsValue = fatsBase + (fatsBase * 0.103);
      fatsValue = applySequenceMultiplier(fatsValue, pos.index);
    }
  } else if (type === 'fish') {
    if (meta.allBeefOrFishSingleTypeDay) {
      fatsValue = fatsBase + (fatsBase * 0.103);
      fatsValue = applySequenceMultiplier(fatsValue, pos.beefFishIndex);
    } else {
      fatsValue = fatsBase + (fatsBase * 0.133);
      fatsValue = applySequenceMultiplier(fatsValue, pos.index);
    }
  }

  return {
    C: carbsValue,
    P: proteinValue,
    F: fatsValue
  };
};

// A customer who picked the same dish twice is stored as ONE row with
// quantity: 2. Every calculation below (how many meals the day's macros are
// split across, per-meal weights, totals) works per row, so that second
// portion used to vanish. Expand every meal (main, breakfast, snack) into one row per portion —
// each copy carries quantity: 1 so consumers that multiply by quantity
// (Kitchen Counting) don't count it twice. Copies keep the original
// _overrideKey so a protein-type override on the dish applies to both.
const expandMealQuantities = (meals) => meals.flatMap((meal) => {
  const qty = Math.max(1, Math.floor(Number(meal?.quantity) || 1));
  if (qty === 1) return [meal];
  return Array.from({ length: qty }, (_, copy) => ({
    ...meal,
    quantity: 1,
    slotNumber: (Number(meal?.slotNumber) || 0) + copy
  }));
});

export const calculateKitchenListEntry = ({ customer, selectedMeals: rawSelectedMeals = [], breakfastPreset = {}, snackPreset = {} }) => {
  const selectedMeals = expandMealQuantities(rawSelectedMeals);
  const inputErrors = kitchenInputErrors(customer);
  if (inputErrors.length) {
    return {
      ...customer, calculationStatus: 'incomplete', inputErrors, formulaVersion: KITCHEN_FORMULA_VERSION,
      customerName: customer?.customerName || [customer?.firstName, customer?.lastName].filter(Boolean).join(' ') || customer?.email,
      selectedMeals: selectedMeals.map((meal) => ({ ...meal, category: meal.mealType === 'breakfast' ? 'breakfast' : meal.mealType === 'snack' ? 'snack' : 'meal', weight: null, proteinWeight: null, carbWeight: null, vegWeight: null, macros: {}, inputErrors, flags: { invalidInput: true } })),
      macros: {}, totalWeight: null, totalCalories: null, mealCount: selectedMeals.length,
    };
  }
  const snackPresetsByName = snackPreset?.presetsByName || {};
  const customerMacros = customer?.targetMacros
    || customer?.customerMacros
    || customer?.macros
    || customer?.mealMacros
    || {
      C: customer?.C,
      P: customer?.P,
      F: customer?.F
    };
  const normalizedMacros = customerMacros.total
    ? {
        C: Number(customerMacros.total.C) || 0,
        P: Number(customerMacros.total.P) || 0,
        F: Number(customerMacros.total.F) || 0
      }
    : {
        C: Number(customerMacros.C) || 0,
        P: Number(customerMacros.P) || 0,
        F: Number(customerMacros.F) || 0
      };
  const defaultBreakfast = getDefaultBreakfastPreset(breakfastPreset);
  const breakfastCarbs = Number(defaultBreakfast.C) || 0;
  const breakfastProteinRaw = Number(defaultBreakfast.P) || 0;
  const breakfastProtein = breakfastProteinRaw <= 30 ? 30 : breakfastProteinRaw;
  const breakfastFats = Number(defaultBreakfast.F) || 0;
  // Matter Core: main meals use the weight-lookup path (see
  // lookupMatterCoreMacros above) instead of the proportional split — the
  // cap/large-breakfast-escalation machinery below exists only to keep that
  // proportional split's per-meal protein/carbs under MEAL_PROTEIN_CAP/
  // MEAL_CARB_CAP, so it doesn't apply here and is skipped entirely.
  // Breakfast and snacks are unaffected either way — they're always
  // additive on top of the main meals, for every plan.
  const isMatterCorePlan = normalizeText(customer?.planName) === 'matter core';
  // Lean/Thrive/Perform plans: every main meal gets the plan's fixed C/P/F
  // (a preset, like breakfast) instead of the proportional split. Custom and
  // any other plan are untouched.
  // Owner (2026-09-29): partner members get the same fixed macros as Lean
  // Plan 1/2, whatever plan name (if any) their record carries.
  const fixedPlanMealMacros = customer?.partner ? { ...FIXED_PLAN_MEAL_MACROS.lean } : null;
  // Owner (2026-10-05): Lean/Thrive/Perform use the same daily-total budget formula as
  // Custom (matches FileMaker). The one difference: FileMaker's printed total for these
  // plans already includes the snacks, so snacks are NOT subtracted from the meals again.
  const planTotalIncludesSnacks = !!getFixedPlanMealMacros(customer?.planName);
  // FileMaker's printed daily total for these plans is the plan PLUS a
  // standard 15/10/6 allowance per snack (checked on ~15 customers, Oct 5);
  // it then subtracts the snack actually picked. Net effect on the meals'
  // budget: allowance - actual (a muffin with F8 leaves 2 less fat than a
  // truffle with F6). Other plans subtract the actual snack as before.
  const FIXED_PLAN_SNACK_ALLOWANCE = { C: 15, P: 10, F: 6 };
  const netSnackTotals = (totals, count) => (planTotalIncludesSnacks
    ? {
        C: totals.C - count * FIXED_PLAN_SNACK_ALLOWANCE.C,
        P: totals.P - count * FIXED_PLAN_SNACK_ALLOWANCE.P,
        F: totals.F - count * FIXED_PLAN_SNACK_ALLOWANCE.F
      }
    : totals);

  const sortedDayKeys = Array.from(new Set(selectedMeals.map((m) => getDateKey(m?.date)))).sort();
  // Owner (2026-10-05): FileMaker's "delivery number" (the +1% / -1% / +2% /
  // -2% macro adjustment) is the delivery's position within the customer's
  // CURRENT plan (a 20-delivery plan restarts on Renew), counted from the
  // start. Matter's schedule ends where that plan ends, so counting back from
  // the end gives the same cycle position: N = planLength - remaining, and
  // plan lengths are multiples of 4, so N mod 4 = (-remaining) mod 4.
  // Checked against FileMaker for 11 of 12 customers on Oct 5. Falls back to
  // the day's position in the selected week when Matter dates aren't loaded.
  const matterDeliveryDates = Array.isArray(customer?.deliveryDates) ? customer.deliveryDates : null;
  const getDeliveryNumber = (dayKey, fallbackIndex) => {
    if (matterDeliveryDates && matterDeliveryDates.length > 0 && dayKey) {
      const remaining = matterDeliveryDates.filter((d) => d > dayKey).length;
      return ((4 - (remaining % 4)) % 4) || 4;
    }
    return fallbackIndex + 1;
  };
  const deliveryNumberByDay = new Map(sortedDayKeys.map((key, idx) => [key, getDeliveryNumber(key, idx)]));

  const mealsByDay = selectedMeals.reduce((acc, meal) => {
    const key = getDateKey(meal?.date);
    if (!acc[key]) acc[key] = [];
    acc[key].push(meal);
    return acc;
  }, {});

  // A single meal's protein/carbs must never exceed these — kitchen portion
  // control, not a nutrition target. When honoring that cap would otherwise
  // leave a meal short of what the proportional split calls for, the day's
  // breakfast automatically escalates to a "large" profile: the portion
  // WEIGHT jumps to a fixed 150g protein / 200g carb (same as before), and
  // separately the SAME breakfast item's own C/P/F macros scale by 1.5x
  // (never a fixed macro value — only the weight is fixed).
  const MEAL_PROTEIN_CAP = 65;
  const MEAL_CARB_CAP = 75;
  const LARGE_BREAKFAST_MULTIPLIER = 1.5;
  const scaleToLargeBreakfast = (macros) => ({
    C: (Number(macros?.C) || 0) * LARGE_BREAKFAST_MULTIPLIER,
    P: (Number(macros?.P) || 0) * LARGE_BREAKFAST_MULTIPLIER,
    F: (Number(macros?.F) || 0) * LARGE_BREAKFAST_MULTIPLIER
  });

  // Trial-runs a day's non-breakfast/non-snack meals against a given
  // breakfast macro deduction and reports whether any meal's raw (pre-cap)
  // protein or carbs would exceed the per-meal cap.
  // Owner (2026-10-13): a main meal should never be squeezed below 10 g carbs or
  // 15 g protein by the Large-breakfast upgrade (its macros x1.5 take that much
  // more off the day's budget). When they would be, the breakfast stays Large —
  // weight (150 g protein / 200 g carb) and LARGE tag — but its macros are NOT
  // scaled x1.5, neither on the card nor in the day's deduction.
  const MEAL_MIN_CARB = 10;
  const MEAL_MIN_PROTEIN = 15;
  // The day's main meals (pre-cap, unrounded) for a given breakfast deduction.
  const computeDayMainMeals = (dayKey, dayMeta, breakfastMacros) => {
    const dayMeals = mealsByDay[dayKey] || [];
    const dayMealCount = Math.max(1, dayMeta.nonBreakfastCount || Number(customer?.mealPerDay) || 1);
    const deliveryNumber = deliveryNumberByDay.get(dayKey) || 1;
    const macroAdjustment = getMacroAdjustment(deliveryNumber);

    const daySnackMeals = dayMeals.filter((m) => normalizeText(m?.mealType) === 'snack');
    const daySnackTotalsRaw = daySnackMeals.reduce((acc, m) => {
      const preset = resolveSnackPresetForMeal(m, snackPresetsByName);
      const snackMacros = preset || {
        C: Number(m?.snackMacros?.C) || 0,
        P: Number(m?.snackMacros?.P) || 0,
        F: Number(m?.snackMacros?.F) || 0
      };
      return {
        C: acc.C + snackMacros.C,
        P: acc.P + snackMacros.P,
        F: acc.F + snackMacros.F
      };
    }, { C: 0, P: 0, F: 0 });
    const daySnackTotals = netSnackTotals(daySnackTotalsRaw, daySnackMeals.length);

    const carbsDefault = Math.max(0, normalizedMacros.C - breakfastMacros.C - daySnackTotals.C);
    const proteinDefault = Math.max(0, normalizedMacros.P - breakfastMacros.P - daySnackTotals.P);
    const fatsDefault = Math.max(0, normalizedMacros.F - breakfastMacros.F - daySnackTotals.F);

    const carbsBase = (carbsDefault / dayMealCount) + (carbsDefault * macroAdjustment);
    const proteinBase = (proteinDefault / dayMealCount) + (proteinDefault * macroAdjustment);
    const fatsBase = (fatsDefault / dayMealCount) + (fatsDefault * macroAdjustment);

    return dayMeals
      .filter((m) => {
        const t = normalizeText(m?.mealType);
        return t !== 'breakfast' && t !== 'snack';
      })
      .map((meal) => {
        const type = resolveProteinType(meal);
        return calculateByProteinRule({ type, carbsBase, proteinBase, fatsBase, meta: dayMeta, meal });
      });
  };
  const dayWouldExceedCap = (dayKey, dayMeta, breakfastMacros) => computeDayMainMeals(dayKey, dayMeta, breakfastMacros)
    .some((computed) => Math.round(computed.P) > MEAL_PROTEIN_CAP || Math.round(computed.C) > MEAL_CARB_CAP);
  const dayFallsBelowMinimum = (dayKey, dayMeta, breakfastMacros) => computeDayMainMeals(dayKey, dayMeta, breakfastMacros)
    .some((computed) => Math.round(computed.C) < MEAL_MIN_CARB || Math.round(computed.P) < MEAL_MIN_PROTEIN);

  // dateKey -> true once escalated to the fixed large-breakfast profile;
  // dateKey -> true if a meal would still exceed the cap even after that
  // (accepted — flagged for kitchen visibility, nothing further attempted).
  // Sum of every breakfast's macros on one day (each with the 30g protein
  // floor, same as a single breakfast's own card shows). A customer can pick
  // two breakfasts, and both must come off the day's budget.
  const sumDayBreakfastMacros = (dayMeals) => dayMeals
    .filter((m) => normalizeText(m?.mealType) === 'breakfast')
    .reduce((acc, m) => {
      const preset = resolveBreakfastPresetForMeal(m, breakfastPreset);
      const p = Number(preset.P) || 0;
      return {
        C: acc.C + (Number(preset.C) || 0),
        P: acc.P + (p <= 30 ? 30 : p),
        F: acc.F + (Number(preset.F) || 0)
      };
    }, { C: 0, P: 0, F: 0 });

  const dayUsesLargeBreakfast = new Set();
  // Days that are Large (weight + tag) but whose macros are left unscaled — see MEAL_MIN_CARB.
  const dayLargeUnscaled = new Set();
  const dayHasMacroShortfall = new Set();

  sortedDayKeys.forEach((dayKey) => {
    if (isMatterCorePlan || fixedPlanMealMacros) return;
    const dayMeals = mealsByDay[dayKey] || [];
    const dayMeta = buildDayMealMeta(dayMeals);
    if (!dayMeta.hasBreakfast || dayMeta.nonBreakfastCount === 0) return;

    const defaultBreakfastMacros = sumDayBreakfastMacros(dayMeals);

    const largeBreakfastMacros = scaleToLargeBreakfast(defaultBreakfastMacros);

    // The escalated profile scales this day's own breakfast item by 1.5x —
    // fine for a customer whose daily target comfortably exceeds that, but
    // for a customer whose entire day's budget is smaller than the escalated
    // allocation itself (e.g. a 1-meal-per-day plan with a small daily
    // total), "escalating" would consume more than their whole day, clamping
    // every other meal to 0 — worse than the over-cap problem it's meant to
    // solve. Only escalate when it can't backfire this way.
    const escalationWouldFitBudget = normalizedMacros.C > largeBreakfastMacros.C
      && normalizedMacros.P > largeBreakfastMacros.P;

    if (dayWouldExceedCap(dayKey, dayMeta, defaultBreakfastMacros)) {
      if (escalationWouldFitBudget) {
        dayUsesLargeBreakfast.add(dayKey);
        if (dayFallsBelowMinimum(dayKey, dayMeta, largeBreakfastMacros)) {
          dayLargeUnscaled.add(dayKey);
        }
        if (dayWouldExceedCap(dayKey, dayMeta, dayLargeUnscaled.has(dayKey) ? defaultBreakfastMacros : largeBreakfastMacros)) {
          dayHasMacroShortfall.add(dayKey);
        }
      } else {
        // Can't safely escalate — accept the over-cap meal(s) with the
        // default breakfast instead (still capped per-meal below), same
        // visibility flag as the "still over even after escalating" case.
        dayHasMacroShortfall.add(dayKey);
      }
    }
  });

  const normalizedMeals = selectedMeals.map((meal, index) => {
    const mealType = normalizeText(meal.mealType);
    const isBreakfast = mealType === 'breakfast';
    const isSnack = mealType === 'snack';
    const type = resolveProteinType(meal);

    if (isBreakfast) {
      const dayKey = getDateKey(meal?.date);
      const autoLarge = dayUsesLargeBreakfast.has(dayKey);
      const mealBreakfastPreset = resolveBreakfastPresetForMeal(meal, breakfastPreset);
      const isLarge = autoLarge || !!mealBreakfastPreset?.isLargeBreakfast;
      // Large breakfast portion weight is fixed (150g protein / 200g carb),
      // same as before — it's the MACROS that scale by 1.5x instead of being
      // fixed, not the physical portion size. See scaleToLargeBreakfast below.
      const proteinWeight = isLarge ? 150 : 100;
      const carbWeight = isLarge ? 200 : 100;
      // FileMaker prints 80g of veg on every breakfast (owner, 2026-10-05).
      const vegWeight = 80;
      const totalWeight = proteinWeight + carbWeight + vegWeight;
      const baseBreakfastMacros = {
        C: Number(mealBreakfastPreset.C) || 0,
        P: (Number(mealBreakfastPreset.P) || 0) <= 30 ? 30 : (Number(mealBreakfastPreset.P) || 0),
        F: Number(mealBreakfastPreset.F) || 0
      };
      // Auto-escalated days scale this SAME item's macros by 1.5x (never a
      // fixed value) — see scaleToLargeBreakfast above for why.
      // Owner (2026-10-05): FileMaker's kitchen list prints the breakfast's
      // OWN preset protein (e.g. 24g, kcal 420) — the 30g floor only applies
      // to what's deducted from the day's budget (sumDayBreakfastMacros), not
      // to what the card/paper show. Auto-large days keep the floored value
      // since that's what the scaled deduction is built from.
      const largeUnscaled = autoLarge && dayLargeUnscaled.has(dayKey);
      const breakfastMacros = autoLarge && !largeUnscaled
        ? scaleToLargeBreakfast(baseBreakfastMacros)
        : { ...baseBreakfastMacros, P: Number(mealBreakfastPreset.P) || 0 };
      return {
        ...meal,
        category: 'breakfast',
        macros: {
          ...breakfastMacros,
          calories: calculateCalories(breakfastMacros)
        },
        weight: totalWeight,
        proteinWeight,
        carbWeight,
        vegWeight,
        position: index + 1,
        flags: {
          autoUpgradedToLarge: autoLarge,
          // Large for ANY reason (auto-upgraded, or the breakfast's own preset
          // is a large one) — Kitchen Counting lists large breakfasts apart.
          isLargeBreakfast: isLarge,
          // Large (weight + tag) but macros left unscaled so the meals keep >=10 g carb / >=15 g protein.
          largeMacrosNotScaled: largeUnscaled,
          macroShortfall: dayHasMacroShortfall.has(dayKey)
        }
      };
    }

    if (isSnack) {
      const proteinWeight = 50;
      const carbWeight = 50;
      const vegWeight = 0;
      const totalWeight = proteinWeight + carbWeight + vegWeight;
      // Global snack preset (by name) takes priority — that's this snack's
      // own fixed macro value. Falls back to whatever's already stored on
      // the meal (the per-date option's C/P/F, divided by snacksPerDay at
      // assignment time) when no preset name matches.
      const presetMatch = resolveSnackPresetForMeal(meal, snackPresetsByName);
      const snackMacros = presetMatch || {
        C: Number(meal?.snackMacros?.C) || 0,
        P: Number(meal?.snackMacros?.P) || 0,
        F: Number(meal?.snackMacros?.F) || 0
      };
      return {
        ...meal,
        category: 'snack',
        macros: {
          ...snackMacros,
          calories: calculateCalories(snackMacros)
        },
        weight: totalWeight,
        proteinWeight,
        carbWeight,
        vegWeight,
        position: index + 1
      };
    }

    const dayKey = getDateKey(meal?.date);
    const dayMeals = mealsByDay[dayKey] || [];
    const dayMeta = buildDayMealMeta(dayMeals);
    const dayMealCount = Math.max(1, dayMeta.nonBreakfastCount || Number(customer?.mealPerDay) || 1);

    if (isMatterCorePlan) {
      // normalizedMacros.C/P are this customer's TOTAL DAILY carb/protein
      // WEIGHT (grams of food) here, not macro-nutrient grams — split evenly
      // across the day's main meals (breakfast/snacks are separate and
      // additive, never subtracted from this count or this weight).
      const perMealCarbWeight = normalizedMacros.C / dayMealCount;
      const perMealProteinWeight = normalizedMacros.P / dayMealCount;
      const tableMatch = lookupMatterCoreMacros(perMealCarbWeight, perMealProteinWeight);

      const proteinWeight = Math.round(perMealProteinWeight);
      const carbWeight = Math.round(perMealCarbWeight);
      // Matter Core meals don't include a veg portion at all, unlike every
      // other plan's fixed 80g.
      const vegWeight = 0;
      const weight = proteinWeight + carbWeight + vegWeight;
      const macros = tableMatch ? { C: tableMatch.C, P: tableMatch.P, F: tableMatch.F } : { C: 0, P: 0, F: 0 };

      return {
        ...meal,
        category: 'meal',
        macros: {
          ...macros,
          calories: calculateCalories(macros)
        },
        weight,
        proteinWeight,
        carbWeight,
        vegWeight,
        position: index + 1,
        flags: {
          matterCorePlan: true,
          matterCoreLookupMissing: !tableMatch,
          matterCorePerMealCarbWeight: Math.round(perMealCarbWeight * 100) / 100,
          matterCorePerMealProteinWeight: Math.round(perMealProteinWeight * 100) / 100
        }
      };
    }

    if (fixedPlanMealMacros) {
      // Owner (2026-10-02): same protein-type adjustment as Custom
      // (chicken/beef/fish percentages + the 5% same-type repeat reduction),
      // but starting from the plan's own per-meal macros instead of the
      // customer's daily total split across meals. Breakfast and snacks keep
      // their preset macros and take nothing off these meals. No
      // delivery-number adjustment (that one is based on the daily total).
      // The 65g protein / 75g carb per-meal cap still applies.
      const adjusted = calculateByProteinRule({
        type,
        carbsBase: fixedPlanMealMacros.C,
        proteinBase: fixedPlanMealMacros.P,
        fatsBase: fixedPlanMealMacros.F,
        meta: dayMeta,
        meal
      });
      const fixedCarbsRaw = Math.round(adjusted.C);
      const fixedProteinRaw = Math.round(adjusted.P);
      const fixedPlanMacros = {
        C: Math.min(fixedCarbsRaw, MEAL_CARB_CAP),
        P: Math.min(fixedProteinRaw, MEAL_PROTEIN_CAP),
        F: Math.round(adjusted.F)
      };
      const fixedProteinWeight = getProteinMealWeight(fixedPlanMacros.P);
      const fixedCarbWeight = getCarbMealWeight(fixedPlanMacros.C);
      const fixedVegWeight = 80;
      return {
        ...meal,
        category: 'meal',
        macros: {
          ...fixedPlanMacros,
          calories: calculateCalories(fixedPlanMacros)
        },
        weight: fixedProteinWeight + fixedCarbWeight + fixedVegWeight,
        proteinWeight: fixedProteinWeight,
        carbWeight: fixedCarbWeight,
        vegWeight: fixedVegWeight,
        position: index + 1,
        flags: {
          isChicken: type === 'chicken',
          isBeef: type === 'beef',
          isFish: type === 'fish',
          manualProteinType: normalizeText(meal.manualProteinType || '') || null,
          fixedPlanMacros: true,
          macroCapped: fixedProteinRaw > MEAL_PROTEIN_CAP || fixedCarbsRaw > MEAL_CARB_CAP
        }
      };
    }

    const deliveryNumber = deliveryNumberByDay.get(dayKey) || 1;
    const macroAdjustment = getMacroAdjustment(deliveryNumber);
    const dayAutoLargeBreakfast = dayUsesLargeBreakfast.has(dayKey);

    // Every breakfast that day comes off the budget (a customer can pick two),
    // not just the first. A day auto-escalated to large scales them all by 1.5x.
    const dayBreakfastTotals = sumDayBreakfastMacros(dayMeals);
    const dayBreakfastDeduction = dayAutoLargeBreakfast && !dayLargeUnscaled.has(dayKey)
      ? scaleToLargeBreakfast(dayBreakfastTotals)
      : dayBreakfastTotals;

    const breakfastCarbsForDefault = dayMeta.hasBreakfast
      ? dayBreakfastDeduction.C
      : 0;
    const breakfastProteinForDefault = dayMeta.hasBreakfast
      ? dayBreakfastDeduction.P
      : 0;
    const breakfastFatsForDefault = dayMeta.hasBreakfast
      ? dayBreakfastDeduction.F
      : 0;

    // Snack macros reduce the day's remaining budget for every plan except
    // Matter Core (which never reaches this point — see the early return
    // above): whatever a customer's snack actually contains comes out of
    // their day's total before the rest is split across main meals.
    const daySnackMeals = dayMeals.filter((m) => normalizeText(m?.mealType) === 'snack');
    const daySnackTotalsRaw = daySnackMeals.reduce((acc, m) => {
      const preset = resolveSnackPresetForMeal(m, snackPresetsByName);
      const snackMacros = preset || {
        C: Number(m?.snackMacros?.C) || 0,
        P: Number(m?.snackMacros?.P) || 0,
        F: Number(m?.snackMacros?.F) || 0
      };
      return {
        C: acc.C + snackMacros.C,
        P: acc.P + snackMacros.P,
        F: acc.F + snackMacros.F
      };
    }, { C: 0, P: 0, F: 0 });
    const daySnackTotals = netSnackTotals(daySnackTotalsRaw, daySnackMeals.length);

    const carbsDefault = Math.max(0, normalizedMacros.C - breakfastCarbsForDefault - daySnackTotals.C);
    const proteinDefault = Math.max(0, normalizedMacros.P - breakfastProteinForDefault - daySnackTotals.P);
    const fatsDefault = Math.max(0, normalizedMacros.F - breakfastFatsForDefault - daySnackTotals.F);

    const carbsBase = (carbsDefault / dayMealCount) + (carbsDefault * macroAdjustment);
    const proteinBase = (proteinDefault / dayMealCount) + (proteinDefault * macroAdjustment);
    const fatsBase = (fatsDefault / dayMealCount) + (fatsDefault * macroAdjustment);

    const computed = calculateByProteinRule({
      type,
      carbsBase,
      proteinBase,
      fatsBase,
      meta: dayMeta,
      meal
    });

    const carbsValue = computed.C;
    const proteinValue = computed.P;
    const fatValue = computed.F;

    const carbsRoundedRaw = Math.round(carbsValue);
    const proteinRoundedRaw = Math.round(proteinValue);
    const fatsRounded = Math.round(fatValue);

    // Kitchen portion cap — a single meal never exceeds this, even if that
    // means it comes in under its proportional share (the day's breakfast
    // was already sized, above, to make up for that where possible).
    const wasCapped = proteinRoundedRaw > MEAL_PROTEIN_CAP || carbsRoundedRaw > MEAL_CARB_CAP;
    const proteinRounded = Math.min(proteinRoundedRaw, MEAL_PROTEIN_CAP);
    const carbsRounded = Math.min(carbsRoundedRaw, MEAL_CARB_CAP);

    const carbsWeight = getCarbMealWeight(carbsRounded);
    const proteinWeight = getProteinMealWeight(proteinRounded);
    const vegWeight = 80;
    const weight = proteinWeight + carbsWeight + vegWeight;

    const roundedMacros = {
      C: carbsRounded,
      P: proteinRounded,
      F: fatsRounded
    };

    return {
      ...meal,
      category: 'meal',
      macros: {
        ...roundedMacros,
        calories: calculateCalories(roundedMacros)
      },
      weight,
      proteinWeight,
      carbWeight: carbsWeight,
      vegWeight,
      position: index + 1,
      flags: {
        isChicken: type === 'chicken',
        isBeef: type === 'beef',
        isFish: type === 'fish',
        manualProteinType: normalizeText(meal.manualProteinType || '') || null,
        deliveryNumber,
        macroAdjustment,
        macroCapped: wasCapped,
        macroShortfall: dayHasMacroShortfall.has(dayKey)
      }
    };
  });

  const totalWeight = normalizedMeals.reduce((sum, meal) => sum + (Number(meal.weight) || 0), 0);
  const totalCalories = normalizedMeals.reduce((sum, meal) => sum + (Number(meal?.macros?.calories) || 0), 0);

  return {
    customerId: customer?.customerId,
    calculationStatus: 'complete', inputErrors: [], formulaVersion: KITCHEN_FORMULA_VERSION,
    nutritionResolvedAt: customer?.nutritionResolvedAt || null,
    matterSourceUpdatedAt: customer?.matterSourceUpdatedAt ?? null,
    matterSourceSubscriptionId: customer?.matterSourceSubscriptionId ?? null,
    matterEffectiveState: customer?.matterEffectiveState ?? null,
    deliveryAddressStatus: customer?.deliveryAddressStatus ?? null,
    deliveryAddressReason: customer?.deliveryAddressReason ?? null,
    skippedDays: customer?.skippedDays || [],
    // The caller's resolved display name wins (Kitchen List passes the Matter
    // name first, then the saved first/last name) — this used to be rebuilt
    // here from first/last only, so a customer saved with no name (or a
    // different spelling than Matter's) showed their email / old name.
    customerName: String(customer?.customerName || '').trim()
      || [customer?.firstName, customer?.lastName].filter(Boolean).join(' ').trim(),
    email: customer?.email,
    // Carried through so callers can match this customer to Matter's delivery
    // list (kitchen paper / counting leave out customers with no delivery).
    matterSubscriptionId: customer?.matterSubscriptionId ?? null,
    // The customer's own Matter delivery dates (for a per-customer paper over a date range).
    deliveryDates: Array.isArray(customer?.deliveryDates) ? customer.deliveryDates : null,
    matterCustomerId: customer?.matterCustomerId ?? null,
    cpf: customer?.cpf ?? null,
    macros: normalizedMacros,
    snacksPerDay: customer?.snacksPerDay ?? null,
    planName: customer?.planName ?? null,
    // The plan's per-day entitlement (from the Matter subscription, falling
    // back to the internal Customer profile) — shown on the kitchen paper,
    // independent of what the customer actually picked for any one date.
    mealsPerDay: customer?.mealsPerDay ?? customer?.mealPerDay ?? null,
    breakfastIncluded: customer?.breakfastIncluded ?? customer?.breakfastInclude ?? null,
    // Set when this customer is a B2B Partner's member ordering through Menu
    // Selection (Partner.menuSelectionEnabled) — the kitchen paper groups
    // these under a "Partners" section instead of by delivery emirate/window.
    partner: customer?.partner ?? null,
    unlimitedMeals: !!customer?.unlimitedMeals,
    deliveryAddress: customer?.deliveryAddress ?? null,
    deliveryWindow: customer?.deliveryWindow ?? null,
    // Dietary restrictions from the Matter website subscription (resolved via
    // matterSubscriptionId for an internally-matched customer, same as the
    // rest of this nutrition data) — display only here, not used for filtering.
    dietaryRestrictions: Array.isArray(customer?.dietaryRestrictions) ? customer.dietaryRestrictions : [],
    missingSelection: !!customer?.missingSelection,
    missingSelectionDate: customer?.missingSelectionDate ?? null,
    breakfastPreset: {
      C: breakfastCarbs,
      P: breakfastProtein,
      F: breakfastFats,
      V: 0
    },
    selectedMeals: normalizedMeals,
    totalWeight,
    totalCalories,
    // True if any day's meals still needed more protein/carbs than the
    // per-meal cap allows even after that day's breakfast auto-upgraded to
    // the large fixed profile — surfaced so kitchen staff can see at a
    // glance which customers are coming in under their daily macro target
    // this way, without digging into every meal.
    hasMacroShortfall: dayHasMacroShortfall.size > 0,
    // Matter Core only: true if any meal's per-meal carb/protein weight
    // (total weight ÷ meals that day) didn't land on one of the known
    // weight->macro combinations — that meal was left at 0 macros and needs
    // a human to fill in, rather than a guessed value.
    hasMatterCoreLookupIssue: normalizedMeals.some((meal) => meal?.flags?.matterCoreLookupMissing),
    mealCount: selectedMeals.filter((meal) => normalizeText(meal.mealType) !== 'breakfast').length
  };
};
