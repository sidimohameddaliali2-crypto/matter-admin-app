// Shared fetch/calc pipeline for KitchenList.js and KitchenCounting.js.
// Both pages show the exact same assigned meals for a menu+date — one as a
// per-customer worklist, the other as cook-counts — so they must run the
// identical fetch + calculateKitchenListEntry pipeline or their numbers can
// silently drift apart. Previously each page carried its own copy of all of
// this; this module is the single copy both now import.

export const emptyBreakfast = { breakfastName: '', C: '', P: '', F: '', V: '', isLargeBreakfast: false, presetsByName: {} };
export const BREAKFAST_PRESET_STORAGE_KEY = 'kitchenBreakfastPresetsGlobal';

export const normalizeBreakfastKey = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

export const normalizeBreakfastPresetEntry = (raw = {}) => ({
  breakfastName: String(raw.breakfastName || '').trim(),
  C: Number(raw.C ?? raw.carbs ?? 0) || 0,
  P: Number(raw.P ?? raw.protein ?? 0) || 0,
  F: Number(raw.F ?? raw.fats ?? 0) || 0,
  V: Number(raw.V ?? raw.vegWeight ?? 80) || 80,
  isLargeBreakfast: !!raw.isLargeBreakfast
});

export const normalizeBreakfastMap = (rawMap) => {
  const entries = rawMap instanceof Map ? Array.from(rawMap.entries()) : Object.entries(rawMap || {});
  return entries.reduce((acc, [rawKey, rawValue]) => {
    const key = normalizeBreakfastKey(rawKey);
    if (!key) return acc;
    acc[key] = normalizeBreakfastPresetEntry(rawValue || {});
    return acc;
  }, {});
};

export const toBreakfastPresetState = (payload = {}) => {
  const preset = normalizeBreakfastPresetEntry(payload?.breakfastPreset || payload?.breakfastMacros || {});
  const presetsByName = normalizeBreakfastMap(payload?.presetsByName || payload?.breakfastPresetsByName);
  return {
    breakfastName: preset.breakfastName || '',
    C: preset.C ?? '',
    P: preset.P ?? '',
    F: preset.F ?? '',
    V: preset.V ?? 80,
    isLargeBreakfast: !!preset.isLargeBreakfast,
    presetsByName
  };
};

export const loadBreakfastPresetFromStorage = () => {
  if (typeof window === 'undefined') return emptyBreakfast;

  try {
    const raw = window.localStorage.getItem(BREAKFAST_PRESET_STORAGE_KEY);
    if (!raw) return emptyBreakfast;
    const parsed = JSON.parse(raw);
    return toBreakfastPresetState(parsed || {});
  } catch {
    return emptyBreakfast;
  }
};

export const saveBreakfastPresetToStorage = (state) => {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(BREAKFAST_PRESET_STORAGE_KEY, JSON.stringify({
      breakfastPreset: {
        breakfastName: state?.breakfastName || '',
        C: Number(state?.C) || 0,
        P: Number(state?.P) || 0,
        F: Number(state?.F) || 0,
        V: Number(state?.V) || 80,
        isLargeBreakfast: !!state?.isLargeBreakfast
      },
      presetsByName: state?.presetsByName || {}
    }));
  } catch {
    // Ignore storage failures; server persistence still remains the primary path.
  }
};

// Global, name-keyed snack macro table (kitchen-snack-presets endpoint) —
// each entry is that snack's own fixed C/P/F, used directly (no division by
// snacksPerDay) wherever its name matches an assigned snack. See
// resolveSnackPresetForMeal in kitchenListCalculations.js for the lookup.
export const normalizeSnackKey = normalizeBreakfastKey;

export const normalizeSnackPresetEntry = (raw = {}) => ({
  snackName: String(raw.snackName || raw.name || '').trim(),
  C: Number(raw.C ?? raw.carbs ?? 0) || 0,
  P: Number(raw.P ?? raw.protein ?? 0) || 0,
  F: Number(raw.F ?? raw.fats ?? 0) || 0
});

export const normalizeSnackPresetMap = (rawMap) => {
  const entries = rawMap instanceof Map ? Array.from(rawMap.entries()) : Object.entries(rawMap || {});
  return entries.reduce((acc, [rawKey, rawValue]) => {
    const key = normalizeSnackKey(rawKey);
    if (!key) return acc;
    acc[key] = normalizeSnackPresetEntry(rawValue || {});
    return acc;
  }, {});
};

export const fetchSnackPresets = async (api) => {
  const response = await api.get('/menus/kitchen-snack-presets');
  if (!response.data?.success) throw new Error('Snack presets could not be verified.');
  return { presetsByName: normalizeSnackPresetMap(response.data?.data?.presetsByName) };
};

export const isRouteNotFound = (err) => {
  const status = err?.response?.status;
  const message = String(err?.response?.data?.message || '').toLowerCase();
  return (
    (status === 404 && message.includes('route') && message.includes('not found'))
    || (message.includes('cast to objectid failed') && message.includes('kitchen-breakfast-presets'))
  );
};

/**
 * GET /menus/kitchen-breakfast-presets, falling back through two older
 * per-menu endpoints for menus saved before the global endpoint existed, and
 * finally to whatever's cached in localStorage from a previous load.
 */
export const fetchBreakfastPresets = async (api, menuId) => {
  let breakfastState = emptyBreakfast;

  try {
    const response = await api.get('/menus/kitchen-breakfast-presets');
    if (!response.data?.success) throw new Error('Breakfast presets could not be verified.');
    if (response.data?.success) {
      breakfastState = toBreakfastPresetState(response.data?.data || {});
    }
  } catch (err) {
    if (!isRouteNotFound(err)) throw err;

    try {
      const menuResponse = await api.get(`/menus/${menuId}/breakfast-presets`);
      if (menuResponse.data?.success) {
        breakfastState = toBreakfastPresetState(menuResponse.data?.data || {});
      }
    } catch (menuErr) {
      if (!isRouteNotFound(menuErr)) throw menuErr;

      const fallbackResponse = await api.get(`/menus/${menuId}`);
      if (fallbackResponse.data?.success) {
        breakfastState = toBreakfastPresetState(fallbackResponse.data?.data || {});
      }
    }
  }

  // Production presets must come from this server load, never a previous browser session.
  return breakfastState;
};

export const getCustomerName = (entry) => {
  const rawMatterName = String(entry?.matterName || '').replace(/\s+/g, ' ').trim();
  if (rawMatterName) {
    // Matter's names are sometimes typed all-lowercase or ALL CAPS — tidy only
    // those to Title Case; a name with mixed case is left exactly as Matter has it.
    const allOneCase = rawMatterName === rawMatterName.toLowerCase() || rawMatterName === rawMatterName.toUpperCase();
    return allOneCase
      ? rawMatterName.replace(/\s+/g, ' ').toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase())
      : rawMatterName;
  }
  const first = String(entry?.firstName || '').trim();
  const last = String(entry?.lastName || '').trim();
  const combined = [first, last].filter(Boolean).join(' ').trim();
  return combined || String(entry?.customerName || entry?.email || '').trim();
};

export const hasNonZeroMacros = (raw) => {
  const source = raw?.total ? raw.total : raw;
  const c = Number(source?.C) || 0;
  const p = Number(source?.P) || 0;
  const f = Number(source?.F) || 0;
  return c > 0 || p > 0 || f > 0;
};

// A meal date arrives as a "YYYY-MM-DD" string from the server, or a UTC-
// midnight Date built from one (or, from an Excel upload, a serial day
// number) — local Date getters would shift any of these a day in any
// non-UTC timezone, so every branch here reads back with UTC fields.
export const getDateKey = (value) => {
  if (!value) return 'unknown-date';

  if (typeof value === 'string') {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) {
      return `${match[1]}-${match[2]}-${match[3]}`;
    }
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // Excel/Sheets stores a date cell as a serial number of days since
  // 1899-12-30 — pure UTC arithmetic, no timezone involved.
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const excelEpochMs = Date.UTC(1899, 11, 30);
    const parsed = new Date(excelEpochMs + value * 86400000);
    if (!Number.isNaN(parsed.getTime())) {
      const y = parsed.getUTCFullYear();
      const m = String(parsed.getUTCMonth() + 1).padStart(2, '0');
      const d = String(parsed.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  const y = parsed.getUTCFullYear();
  const m = String(parsed.getUTCMonth() + 1).padStart(2, '0');
  const d = String(parsed.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

export const formatDateLabel = (value) => {
  if (!value) return 'Unknown Day';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC'
  });
};

// Runs `mapper` over `items` with at most `limit` in flight at once, instead
// of Promise.all firing every request simultaneously — which, with hundreds
// of customers each triggering a Matter API lookup, floods the browser's
// connection pool and is the main cause of a page freezing/hanging on load.
export const mapWithConcurrency = async (items, limit, mapper) => {
  const results = new Array(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await mapper(items[current], current);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

/**
 * Overwrites each selection's macros/snacks-per-day/plan-name with the
 * customer's live Matter website subscription data — never the internal
 * Customer page's values, even when those already have something. Resolves
 * by exact matterSubscriptionId first. Production inputs are fetched fresh
 * from Matter on each load/export; no browser or server nutrition cache is
 * accepted as proof of a current subscription/address.
 *
 * `extended: true` (KitchenList) also pulls deliveryAddress/deliveryWindow/
 * dietaryRestrictions for its customer-detail card; KitchenCounting only
 * needs the macro/snack fields it aggregates from, so leaves it false.
 */
export const enrichSelectionsWithNutrition = async (api, rawSelections, nutritionCacheRef, {
  concurrency = 8,
  extended = false,
  onEach
} = {}) => mapWithConcurrency(rawSelections, concurrency, async (entry) => {
  const email = String(entry?.email || '').trim();
  const subscriptionId = String(entry?.matterSubscriptionId || '').trim();
  // Matter's permanent customer id — survives renewals, unlike subscriptionId.
  const matterCustomerId = String(entry?.matterCustomerId || '').trim();
  if (entry?.partner) {
    onEach?.();
    return { ...entry, nutritionStatus: 'resolved', nutritionSource: 'partner-preset', nutritionResolvedAt: new Date().toISOString() };
  }
  if (!email && !subscriptionId && !matterCustomerId) {
    onEach?.();
    return { ...entry, nutritionStatus: 'missing' };
  }

  try {
    // Explicit timeout: the shared axios instance has none configured, and
    // mapWithConcurrency's Promise.all waits for every worker to finish — a
    // single slow/hung Matter API call for one customer would otherwise
    // block the entire page's load indefinitely.
    const nutritionResponse = await api.get('/matter/subscriptions/kitchen-inputs', {
      params: { subscriptionId, customerId: matterCustomerId, email }, timeout: 20000
    });
    if (nutritionResponse.data?.success === false) throw new Error('Matter inputs could not be verified.');
    const nutrition = nutritionResponse.data?.data;
    if (subscriptionId && String(nutrition?.subscription_id || '') !== subscriptionId) throw new Error('Matter subscription link does not match.');
    const websiteMacros = nutrition?.macros
      ? { C: nutrition.macros.carbohydrates, P: nutrition.macros.protein, F: nutrition.macros.fat }
      : null;

    const enrichedFields = {
      targetMacros: websiteMacros || {},
      customerMacros: websiteMacros || {},
      nutritionStatus: nutrition ? 'resolved' : 'missing',
      nutritionSource: 'matter',
      nutritionPlanKind: String(nutrition?.plan_name || '').trim().toLowerCase() === 'matter core' ? 'core' : 'ordinary',
      nutritionUnits: String(nutrition?.plan_name || '').trim().toLowerCase() === 'matter core' ? 'food-weight-grams' : 'nutrient-grams',
      nutritionResolvedAt: nutrition?.source_fetched_at || new Date().toISOString(),
      matterSourceUpdatedAt: nutrition?.source_updated_at ?? null,
      matterSourceSubscriptionId: nutrition?.subscription_id ?? null,
      matterEffectiveState: nutrition?.meal_contract?.effectiveState || 'current-snapshot-only',
      snacksPerDay: nutrition?.snacks_per_day ?? null,
      planName: nutrition?.plan_name ?? null,
      // Owner (2026-10-07): show the Matter name, not the internal record's
      // (which can be misspelled, differ, or be blank for auto-created ones).
      matterName: String(nutrition?.customer_name || '').trim() || null,
      mealsPerDay: nutrition?.meal_frequency ?? null,
      breakfastIncluded: typeof nutrition?.breakfast_included === 'boolean' ? nutrition.breakfast_included : null,
      deliveryDates: Array.isArray(nutrition?.active_delivery_dates) ? nutrition.active_delivery_dates : null,
      dietaryRestrictions: Array.isArray(nutrition?.exclusions) ? nutrition.exclusions : null,
      ...(extended ? {
        deliveryAddress: nutrition?.delivery_address_resolution?.address || null,
        deliveryAddressStatus: nutrition?.delivery_address_resolution?.status || 'unresolved',
        deliveryAddressReason: nutrition?.delivery_address_resolution?.reason || 'missing-address-resolution',
        deliveryWindow: nutrition?.delivery_window || null
      } : {})
    };
    onEach?.();
    return { ...entry, ...enrichedFields };
  } catch {
    onEach?.();
    return { ...entry, nutritionStatus: 'failed', nutritionSource: 'matter' };
  }
});

/**
 * Every date the kitchen might need to work on for this menu: dates that
 * already have a customer selection, dates the kitchen has already uploaded
 * rotation options for (main/sub/breakfast/snack), and — only when neither
 * of those exist yet — every day in the menu's own date range. That last
 * fallback matters: without it, a brand-new menu with zero selections and
 * zero uploads would show no dates at all, so the kitchen could never pick a
 * date to upload against in the first place.
 */
export const deriveDateKeys = ({ menuSelections, mainMealOptionsByDate, breakfastOptionsByDate, snackOptionsByDate, selectedMenu }) => {
  const keys = new Set();
  (menuSelections || []).forEach((entry) => (entry.selectedMeals || []).forEach((m) => {
    const key = getDateKey(m?.date);
    if (key && key !== 'unknown-date') keys.add(key);
  }));
  Object.keys(mainMealOptionsByDate || {}).forEach((key) => keys.add(key));
  Object.keys(breakfastOptionsByDate || {}).forEach((key) => keys.add(key));
  Object.keys(snackOptionsByDate || {}).forEach((key) => keys.add(key));

  if (keys.size === 0 && selectedMenu?.startDate && selectedMenu?.endDate) {
    const start = new Date(selectedMenu.startDate);
    const end = new Date(selectedMenu.endDate);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
      const cursor = new Date(start);
      let guard = 0;
      while (cursor <= end && guard < 31) {
        keys.add(getDateKey(cursor));
        cursor.setDate(cursor.getDate() + 1);
        guard += 1;
      }
    }
  }

  return Array.from(keys).sort();
};

// An exact subscription link must never fall through to another renewal that
// happens to share its permanent customer ID or email.
export const matchesMatterSubscription = (entry, sub) => {
  const subscriptionId = entry.matterSourceSubscriptionId ?? entry.matterSubscriptionId;
  if (subscriptionId) return String(subscriptionId) === String(sub.subscription_id);
  if (entry.matterCustomerId) return String(entry.matterCustomerId) === String(sub.customer_id);
  return !!entry.email && String(entry.email).trim().toLowerCase() === String(sub.email || '').trim().toLowerCase();
};
