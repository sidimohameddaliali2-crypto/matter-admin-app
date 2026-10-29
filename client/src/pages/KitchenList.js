import KitchenInputWarnings from '../components/KitchenInputWarnings';
import useKitchenSelectionWindow from '../lib/useKitchenSelectionWindow';
import { KitchenWorkspaceHeader, KitchenEmptyState, KitchenAutoScopeControl } from '../components/KitchenWorkspace';
import KitchenCustomerBrowser from '../components/KitchenCustomerBrowser';
import { snackPresetChanges } from '../lib/kitchenSnackPresetChanges';
import useKitchenCurrentScope from '../lib/useKitchenCurrentScope';
import { formatKitchenDay, visibleKitchenCustomer, kitchenCustomerDay } from '../lib/kitchenDayScope';
import { loadKitchenSnapshot, requiredKitchenMeals, verifiedKitchenRoster } from '../lib/kitchenSnapshot';
import PartnerKitchenOrders from '../components/PartnerKitchenOrders';
import { prepareKitchenSelections, createKitchenRequestGuard, assertKitchenExportReady, kitchenMealChanges } from '../utils/kitchenIntegrity';
import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { Upload, Download, RefreshCw, Search, Loader, UtensilsCrossed, ChefHat, Trash2, FileText, ChevronDown, ChevronUp, AlertTriangle, Pencil } from 'lucide-react';
import api from '../utils/api';
import { calculateKitchenListEntry, breakfastNameHasMacros, snackNameHasMacros, resolveSnackPresetForMeal } from '../utils/kitchenListCalculations';
import { toSentenceCase } from '../utils/textFormat';
import { downloadCustomerPaperPdf, downloadCustomerPaperWord } from '../utils/kitchenPaperCustomer';
import {
  emptyBreakfast,
  normalizeBreakfastKey,
  saveBreakfastPresetToStorage,
  fetchBreakfastPresets,
  fetchSnackPresets,
  toSnackPresetState,
  toBreakfastPresetState,
  isRouteNotFound,
  getCustomerName,
  getDateKey,
  formatDateLabel,
  enrichSelectionsWithNutrition,
  deriveDateKeys
} from '../lib/kitchenData';

// xlsx/jspdf/jspdf-autotable are sizable libraries only ever needed once a
// staff member clicks an export/upload button — loading them at module top
// level shipped them in the app's shared bundle for every page/route.
// Loaded on first use and memoized (module-level, not per-call) so repeated
// exports in the same session don't re-fetch the chunk.
let xlsxModulePromise = null;
const loadXLSX = () => {
  if (!xlsxModulePromise) xlsxModulePromise = import('xlsx');
  return xlsxModulePromise;
};

let jsPDFModulePromise = null;
const loadJsPDF = () => {
  if (!jsPDFModulePromise) jsPDFModulePromise = import('jspdf');
  return jsPDFModulePromise;
};

let autoTableModulePromise = null;
const loadAutoTable = () => {
  if (!autoTableModulePromise) autoTableModulePromise = import('jspdf-autotable');
  return autoTableModulePromise;
};

const getMealLabel = (meal) => {
  const mealType = String(meal?.mealType || meal?.menuItemMealType || meal?.menuItemId?.mealType || '').trim().toLowerCase();
  const mealName = String(meal?.mealName || meal?.menuItemName || meal?.menuItemId?.mealName || '').trim();
  const displayType = mealType === 'breakfast' ? 'Breakfast' : mealType === 'snack' ? 'Snack' : 'Meal';
  return {
    mealType: displayType,
    mealName: mealName || 'Unnamed meal'
  };
};

const detectProteinType = (meal) => {
  // menuItemId.portionType is an explicit tag set in the meal editor for
  // Supy-linked meals — trust it before falling back to keyword-sniffing.
  const tagged = String(meal?.menuItemId?.portionType || '').toLowerCase();
  if (tagged === 'chicken') return 'Chicken';
  if (tagged === 'beef') return 'Beef';
  if (tagged === 'fish') return 'Fish';

  const text = String(
    meal?.proteinChoice
    || meal?.mealName
    || meal?.menuItemName
    || meal?.menuItemId?.mealName
    || meal?.description
    || ''
  ).toLowerCase();

  if (text.includes('chicken')) return 'Chicken';
  if (text.includes('beef')) return 'Beef';
  if (text.includes('fish') || text.includes('shrimp') || text.includes('salmon') || text.includes('seafood')) return 'Fish';
  return 'Unknown';
};

const groupMealsByDay = (meals = []) => {
  const grouped = meals.reduce((acc, meal) => {
    const key = getDateKey(meal?.date);
    if (!acc[key]) {
      acc[key] = {
        dateKey: key,
        dateLabel: formatDateLabel(meal?.date),
        meals: []
      };
    }
    acc[key].meals.push(meal);
    return acc;
  }, {});

  return Object.values(grouped).sort((a, b) => a.dateKey.localeCompare(b.dateKey));
};

const buildMealOverrideKey = (entry, meal, index) => {
  const email = String(entry?.email || '').trim().toLowerCase();
  const date = getDateKey(meal?.date);
  const menuItemId = String(meal?.menuItemId?._id || meal?.menuItemId || meal?.mealName || index);
  const slotNumber = Number(meal?.slotNumber || 0);
  return `${email}::${date}::${menuItemId}::${slotNumber}::${index}`;
};

const attachStableMealKeys = (entry) => {
  const selectedMeals = Array.isArray(entry?.selectedMeals) ? entry.selectedMeals : [];
  const keyedMeals = selectedMeals.map((meal, index) => {
    const stableKey = meal?._overrideKey || buildMealOverrideKey(entry, meal, index);
    return {
      ...meal,
      _overrideKey: stableKey
    };
  });

  return {
    ...entry,
    selectedMeals: keyedMeals
  };
};

// A sheet's declared "used range" (sheet['!ref']) can massively overstate
// where the real data ends — e.g. background color or borders applied to
// whole columns in Excel makes it report data out to row 1,048,576. Left
// uncapped, sheet_to_json synchronously builds an array with hundreds of
// thousands of blank row objects, which is exactly the kind of unbroken
// main-thread work that trips Chrome's hang detector (RESULT_CODE_HUNG) and
// can crash the tab. Any upload on this page is realistically dozens of
// rows, so cap it generously and skip fully-blank rows outright.
const MAX_UPLOAD_ROWS = 5000;
const readSheetRowsSafely = (XLSX, sheet) => {
  const range = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : null;
  if (range && (range.e.r - range.s.r) > MAX_UPLOAD_ROWS) {
    range.e.r = range.s.r + MAX_UPLOAD_ROWS;
    console.warn(`Upload: sheet reported far more rows than expected; only the first ${MAX_UPLOAD_ROWS} were read.`);
  }
  return XLSX.utils.sheet_to_json(sheet, {
    defval: '',
    blankrows: false,
    ...(range ? { range } : {})
  });
};

const parseBreakfastRow = (row) => {
  const breakfastName = String(
    row.BreakfastName
    ?? row.Breakfast
    ?? row.MealName
    ?? row.Name
    ?? row.breakfastName
    ?? row.breakfast
    ?? row.mealName
    ?? row.name
    ?? ''
  ).trim();

  const C = Number(row.C ?? row.Carbs ?? row.carbs ?? 0) || 0;
  const P = Number(row.P ?? row.Protein ?? row.protein ?? 0) || 0;
  const F = Number(row.F ?? row.Fats ?? row.fats ?? 0) || 0;
  const rawV = row.V ?? row.Veg ?? row.VegWeight ?? row.veg;
  const hasExplicitV = rawV !== undefined && rawV !== null && String(rawV).trim() !== '';

  return {
    breakfastName,
    C,
    P,
    F,
    V: hasExplicitV ? (Number(rawV) || 80) : 80,
    isLargeBreakfast: String(row.LargeBreakfast ?? row.isLargeBreakfast ?? '').toLowerCase() === 'true'
  };
};

// Plain-language reasons a meal needs kitchen attention — drives both the
// "Needs attention only" filter and the explanation shown on each customer card.
const getAttentionReasons = (meal) => {
  const reasons = [...(meal?.inputErrors || [])];
  if (meal?.remark) {
    reasons.push(`Flagged via Upload Meal Remarks: "${meal.remark}" — swap this before it goes out.`);
  }
  if (meal?.exclusionConflict?.length > 0) {
    reasons.push(`Every dish that day clashes with the customer's exclusions, so auto-assign gave the closest one — contains ${meal.exclusionConflict.join(', ')}. Swap before it goes out.`);
  }
  if (meal?.needsSauceChange) {
    reasons.push(`Sauce conflicts with a customer exclusion (${(meal.sauceConflict || []).join(', ') || 'unspecified'}) — swap the sauce.`);
  }
  if (meal?.needsGarnishChange) {
    reasons.push(`Garnish conflicts with a customer exclusion (${(meal.garnishConflict || []).join(', ') || 'unspecified'}) — swap the garnish.`);
  }
  if (meal?.flags?.macroCapped) {
    reasons.push('Hit the 65g protein / 75g carb per-meal cap, so this meal is smaller than its full macro share.');
  }
  if (meal?.flags?.autoUpgradedToLarge) {
    reasons.push('Breakfast auto-upgraded to Large (macros x1.5, 150g protein / 200g carb) because other meals hit the per-meal cap.');
  }
  if (meal?.flags?.macroShortfall && String(meal?.mealType || '').toLowerCase() === 'breakfast') {
    reasons.push("Even with the large breakfast, this day's meals couldn't reach the customer's full daily macro target.");
  }
  if (meal?.flags?.matterCoreLookupMissing) {
    reasons.push("Per-meal weight doesn't match a known Matter Core weight-to-macro combination — macros left at 0, fix manually.");
  }
  return reasons;
};

// true/false = Matter does / doesn't show a delivery for this customer on
// the checked date. Matched by linked subscription id first, then email.
const hasDeliveryOnCheckedDate = (entry, deliveryCheck) => {
  if (entry?.matterCustomerId) return !!deliveryCheck.customerIds?.has(String(entry.matterCustomerId));
  const subId = String(entry?.matterSourceSubscriptionId || entry?.matterSubscriptionId || '').trim();
  if (subId) return deliveryCheck.subscriptionIds.has(subId);
  const email = String(entry?.matterEmail || entry?.email || '').trim().toLowerCase();
  return !!email && deliveryCheck.emails.has(email);
};

// Meal-card "Change ..." options. A meal's remark is one string ("carb" or
// "carb + sauce"); free text from Upload Meal Remarks that isn't one of
// these is kept untouched as an extra when the boxes are toggled.
const REMARK_CHANGE_OPTIONS = [
  { key: 'carb', label: 'Carb' },
  { key: 'veg', label: 'Veg' },
  { key: 'garnish', label: 'Garnish' },
  { key: 'sauce', label: 'Sauce' }
];
const parseRemarkParts = (remark) => {
  const parts = String(remark || '').split(/\s*(?:\+|,|&|\/|\band\b)\s*/i).map((p) => p.trim()).filter(Boolean);
  const known = new Set(REMARK_CHANGE_OPTIONS.map((o) => o.key));
  return {
    checked: parts.filter((p) => known.has(p.toLowerCase())).map((p) => p.toLowerCase()),
    extras: parts.filter((p) => !known.has(p.toLowerCase()))
  };
};
const buildRemarkFromParts = (checked, extras) => [
  ...REMARK_CHANGE_OPTIONS.filter((o) => checked.includes(o.key)).map((o) => o.key),
  ...extras
].join(' + ');

// Owner (2026-10-10): every customer's food exclusions (Matter's dietary
// restrictions) are printed on the kitchen paper, PDF and Word. "None" when the
// customer has none; "Not available" when no Matter subscription data loaded,
// so a missing lookup is never mistaken for "no exclusions".
const exclusionsText = (entry) => {
  const list = (Array.isArray(entry?.dietaryRestrictions) ? entry.dietaryRestrictions : [])
    .map((item) => String(item || '').trim()).filter(Boolean);
  if (list.length > 0) return list.join(', ');
  return entry?.planName ? 'None' : 'Not available';
};


const normalizeSelectionForSave = (meal) => ({
  date: meal?.date,
  mealType: meal?.mealType,
  menuItemId: meal?.menuItemId?._id || meal?.menuItemId,
  mealName: meal?.mealName,
  description: meal?.description,
  slotNumber: meal?.slotNumber,
  proteinChoice: meal?.proteinChoice,
  vegChoice: meal?.vegChoice,
  carbChoice: meal?.carbChoice,
  sauceChoice: meal?.sauceChoice,
  manualProteinType: String(meal?.manualProteinType || '').trim().toLowerCase(),
  quantity: Number(meal?.quantity) || 1,
  carbVegAction: meal?.carbVegAction,
  carbVegConflict: meal?.carbVegConflict,
  carbConflict: meal?.carbConflict,
  vegConflict: meal?.vegConflict,
  needsSauceChange: !!meal?.needsSauceChange,
  needsGarnishChange: !!meal?.needsGarnishChange,
  sauceConflict: meal?.sauceConflict,
  garnishConflict: meal?.garnishConflict,
  // Whitelisted here for the same reason isAutoAssigned is — this object is
  // what gets sent back on a protein-type override save (PUT .../selections/:email,
  // a wholesale selectedMeals replace on the server), so any field left out
  // here is silently wiped the next time kitchen staff change a protein type.
  remark: String(meal?.remark || '').trim(),
  exclusionConflict: Array.isArray(meal?.exclusionConflict) ? meal.exclusionConflict : [],
  isAutoAssigned: !!meal?.isAutoAssigned
});

const KitchenList = () => {
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(true);
  const [menus, setMenus] = useState([]);
  const [selectedMenuId, setSelectedMenuId] = useState('');
  const [menuSelections, setMenuSelections] = useState([]);
  const [loadingMenus, setLoadingMenus] = useState(false);
  const [loadingSelections, setLoadingSelections] = useState(false);
  // searchInput updates on every keystroke; `search` (used by the heavy
  // customerRows calculation below) only updates 250ms after typing stops,
  // so typing doesn't re-run macro math for every visible customer on every
  // keystroke — a major source of the page freezing up while typing.
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [visibleCustomers, setVisibleCustomers] = useState(50);
  useEffect(() => {
    const timeout = setTimeout(() => setSearch(searchInput), 250);
    return () => clearTimeout(timeout);
  }, [searchInput]);
  const [error, setError] = useState('');
  const [breakfastPreset, setBreakfastPreset] = useState(emptyBreakfast);
  const [snackPreset, setSnackPreset] = useState({ presetsByName: {} });
  const [snackPresetForm, setSnackPresetForm] = useState({ name: '', C: '', P: '', F: '' });
  // The global snack macro table is ~80 rows long, so it lives in a dropdown
  // that starts closed instead of pushing the rest of the panel down.
  const [snackMacrosOpen, setSnackMacrosOpen] = useState(false);
  const [savingSnackPreset, setSavingSnackPreset] = useState(false);
  const [importName, setImportName] = useState('');
  const [mealTypeOverrides, setMealTypeOverrides] = useState({});
  const [savingOverrideKey, setSavingOverrideKey] = useState('');
  // Day-note draft text (per customer, per date) now lives as local state
  // inside CustomerCard itself, not here — see the note on that component
  // for why. savingDayNoteKey is the one piece that still needs to live at
  // this level (it flags which save is in flight, compared against a key
  // built from the card's own email+date).
  const [savingDayNoteKey, setSavingDayNoteKey] = useState('');
  const [snackOptionsByDate, setSnackOptionsByDate] = useState({});
  const [pdfDate, setPdfDate] = useState('');
  // Per-customer kitchen paper over a custom date range (PDF / Word).
  const [customerPaperSearch, setCustomerPaperSearch] = useState('');
  const [customerPaperEmail, setCustomerPaperEmail] = useState('');
  const [customerPaperFrom, setCustomerPaperFrom] = useState('');
  const [customerPaperTo, setCustomerPaperTo] = useState('');
  const [customerPaperBusy, setCustomerPaperBusy] = useState(false);
  const [customerPaperMsg, setCustomerPaperMsg] = useState(null);
  const [paperPlan, setPaperPlan] = useState('');
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState('');
  const exportInFlight = useRef(false);
  const [missingSelectionEntries, setMissingSelectionEntries] = useState([]);
  const [showOnlyMissing, setShowOnlyMissing] = useState(false);
  const [planFilter, setPlanFilter] = useState('');
  // Who Matter says has a delivery on the last-checked date (filled by
  // "Check Missing Selections"): { dateKey, emails: Set, subscriptionIds: Set }.
  const [deliveryCheck, setDeliveryCheck] = useState(null);
  const [showOnlyAttention, setShowOnlyAttention] = useState(false);
  const [missingCheckDate, setMissingCheckDate] = useState('');
  const [checkingMissing, setCheckingMissing] = useState(false);
  const [mainMealOptionsByDate, setMainMealOptionsByDate] = useState({});
  const [savingMainMealOptions, setSavingMainMealOptions] = useState(false);
  const [breakfastOptionsByDate, setBreakfastOptionsByDate] = useState({});
  const [savingBreakfastOptions, setSavingBreakfastOptions] = useState(false);
  const [matterCoreMealOptionsByDate, setMatterCoreMealOptionsByDate] = useState({});
  const [savingMatterCoreMealOptions, setSavingMatterCoreMealOptions] = useState(false);
  const [matterCoreMealInput, setMatterCoreMealInput] = useState('');
  const [uploadingMealRemarks, setUploadingMealRemarks] = useState(false);
  const [mealRemarksUploadResult, setMealRemarksUploadResult] = useState(null);
  // Caches each customer's Matter website nutrition lookup for the life of
  // the page, so switching menus, re-running auto-assign, or reloading
  // selections doesn't re-fire a network call for every customer again —
  // only for ones not seen yet. Cleared by the menu refresh button.
  const nutritionCacheRef = useRef(new Map());
  const selectionRequests = useRef(createKitchenRequestGuard());
  const preparedSnapshot = useRef(null);
  const optionRequests = useRef({});
  const activeSelectionScope = useRef('');
  activeSelectionScope.current = `${selectedMenuId}:${missingCheckDate}`;
  const [loadedSelectionScope, setLoadedSelectionScope] = useState('');
  const [dayRoster, setDayRoster] = useState(null);
  const [savingSnackOptions, setSavingSnackOptions] = useState(false);
  const [assigningAll, setAssigningAll] = useState(false);
  const [autoAssignResult, setAutoAssignResult] = useState(null);

  useEffect(() => {
    const loadMenus = async () => {
      try {
        setLoadingMenus(true);
        const response = await api.get('/menus?isActive=all&limit=100');
        if (response.data?.success) {
          const menuRows = response.data.data || [];
          setMenus(menuRows);
          // No auto-select — nothing loads (nutrition lookups, selections,
          // menu-specific options) until the kitchen explicitly picks a menu.
        }
        if (!response.data?.data?.length) {
          setError('No menus were found. Create or activate a menu first.');
        }
      } catch (err) {
        setError(err.response?.data?.message || 'Failed to load menus');
      } finally {
        setLoadingMenus(false);
      }
    };

    loadMenus();
  }, []);

  // A date choice belongs to one menu — switching menus must not carry over
  // the previous menu's date and silently start loading data for it again
  // (defeating "don't load until a date is chosen"), and must not leave the
  // previous menu's customers/options on screen while a new date is picked.
  useEffect(() => {
    setMissingCheckDate('');
    setPdfDate('');
    setMenuSelections([]);
    setMissingSelectionEntries([]);
    setDeliveryCheck(null);
    setMainMealOptionsByDate({});
    setSnackOptionsByDate({});
    setBreakfastOptionsByDate({});
    setMatterCoreMealOptionsByDate({});
    setMatterCoreMealInput('');
  }, [selectedMenuId]);

  // Both controls choose one preparation date. Selecting the current day is
  // a no-op: clearing its loaded scope without changing state strands the UI.
  const changeKitchenDate = (date) => {
    setPdfDate(date);
    setExportError('');
    if (date === missingCheckDate) return;
    selectionRequests.current.cancel();
    setLoadedSelectionScope('');
    setMissingCheckDate(date);
  };

  const automaticScope = useKitchenCurrentScope({ menus, menuId: selectedMenuId, date: missingCheckDate,
    onMenu: id => { selectionRequests.current.cancel(); setLoadedSelectionScope(''); setMissingCheckDate(''); setPdfDate(''); setSelectedMenuId(id); },
    onDate: changeKitchenDate,
  });

  const loadSelections = useCallback(async () => {
    // Selecting a menu alone must not trigger the nutrition-lookup-per-customer
    // fetch below — that only happens once a date is picked too.
    preparedSnapshot.current = null;
    const request = selectionRequests.current.begin();
    const scope = `${selectedMenuId}:${missingCheckDate}`;
    const current = () => selectionRequests.current.isCurrent(request) && activeSelectionScope.current === scope;
    setMenuSelections([]);
    setLoadedSelectionScope('');
    setDayRoster(null);
    setExportError('');
    if (!selectedMenuId || !missingCheckDate) { setLoadingSelections(false); return []; }
    nutritionCacheRef.current.clear();
    setDeliveryCheck(null);

    try {
        setLoadingSelections(true);
        setError('');
        setMissingSelectionEntries([]);
        // autoPopulateDate (Stage 3): silently fills in placeholder selections
        // for any Matter subscriber with a delivery this date who never
        // submitted one themselves, before the server returns this list — so
        // Kitchen List/Counting never miss them without a manual "Check
        // Missing Selections" click.
        //
        // These three calls are independent of each other (presets don't
        // depend on selections, and vice versa), so they run concurrently
        // instead of stacked — cuts this portion of load time to roughly the
        // slowest single call instead of the sum of all three. Each keeps
        // its own failure handling: a snack-preset failure still falls back
        // silently (matches prior behavior), while a `/selections` failure
        // still throws to the outer catch below.
        const preparation = await prepareKitchenSelections(api, selectedMenuId, missingCheckDate, current);
        if (!current()) return [];
        const roster = preparation.data?.rosterComplete === true && Array.isArray(preparation.data.kitchenRoster)
          ? preparation.data.kitchenRoster
          : verifiedKitchenRoster((await api.get('/matter/subscriptions/delivery-on-date', { params: { date: missingCheckDate }, timeout: 180000 })).data);
        if (!current()) return [];
        const [response, rawBreakfastState, rawSnackState] = await Promise.all([
          preparation.data?.kitchenSelections ? Promise.resolve({ data: { success: true, data: preparation.data.kitchenSelections } }) : api.get(`/menus/${selectedMenuId}/selections`, { timeout: 30000 }),
          preparation.data?.kitchenBreakfastPreset || fetchBreakfastPresets(api, selectedMenuId),
          preparation.data?.kitchenSnackPreset || fetchSnackPresets(api)
        ]);

        if (!current()) return [];
        const breakfastState = toBreakfastPresetState(rawBreakfastState);
        const snackState = toSnackPresetState(rawSnackState);
        setBreakfastPreset(breakfastState);
        if (Object.keys(breakfastState.presetsByName || {}).length > 0) {
          saveBreakfastPresetToStorage(breakfastState);
        }
        setImportName(Object.keys(breakfastState.presetsByName || {}).length > 0 ? 'Loaded from server' : '');

        setSnackPreset(snackState);

        if (response.data?.success) {
          const rawSelections = response.data.data || [];

          // Read fresh website nutrition by email first. Saved Matter IDs are
          // used only when no email is available; customer identity conflicts
          // and ambiguous matches remain unresolved rather than guessed.
          const enrichedSelections = await enrichSelectionsWithNutrition(api, rawSelections, nutritionCacheRef, { extended: true, matterInputs: preparation.cached ? [] : preparation.data?.kitchenInputs,
            productionScope: { complete: true, date: missingCheckDate, roster } });

          const keyedSelections = enrichedSelections.map((entry) => attachStableMealKeys(entry));
          if (!current()) return [];
          preparedSnapshot.current = { menuId: selectedMenuId, date: missingCheckDate, receivedAt: Date.now(), checkedAt: preparation.preparedAt,
            snapshotId: preparation.snapshotId,
            complete: preparation.preparation !== 'selection-open' && !preparation.cached && preparation.data?.rosterComplete === true, roster: preparation.data?.kitchenRoster,
            selections: keyedSelections, breakfastPreset: breakfastState, snackPreset: snackState };
          setMenuSelections(keyedSelections);
          setDayRoster({ scope, rows: roster });
          setLoadedSelectionScope(scope);
          return keyedSelections;
        }
        throw new Error(response.data?.message || 'Selections could not be verified. Please retry.');
    } catch (err) {
      if (current()) { setMenuSelections([]); setError(err.response?.data?.message || err.message || 'Failed to load menu selections'); }
      return [];
    } finally {
      if (current()) setLoadingSelections(false);
    }
  }, [selectedMenuId, missingCheckDate]);

  useEffect(() => { loadSelections(); return () => selectionRequests.current.cancel(); }, [loadSelections]);

  // All four loaders below wait for BOTH a menu and a date to be picked —
  // selecting a menu alone (e.g. while still deciding which date to work on)
  // must not trigger any fetch. menuDateKeys populates the Date dropdown
  // itself from the menu's own start/end range without needing any of this
  // data first, so there's no chicken-and-egg problem in gating it this way.
  const loadKitchenOptions = useCallback(async (kind, setter) => {
    const scope = `${selectedMenuId}:${missingCheckDate}`;
    const request = (optionRequests.current[kind] || 0) + 1;
    optionRequests.current[kind] = request;
    const current = () => activeSelectionScope.current === scope && optionRequests.current[kind] === request;
    if (!selectedMenuId || !missingCheckDate) {
      setter({});
      return;
    }
    try {
      const res = await api.get(`/menus/${selectedMenuId}/${kind}`, { timeout: 30000 });
      if (res.data?.success === false) throw new Error(res.data.message || 'Menu options could not be loaded.');
      if (current()) setter(res.data?.data || {});
    } catch (err) {
      if (current()) setError(err.response?.data?.message || err.message || 'Menu options could not be loaded.');
    }
  }, [selectedMenuId, missingCheckDate]);

  const loadSnackOptions = useCallback(() => loadKitchenOptions('snack-options', setSnackOptionsByDate), [loadKitchenOptions]);

  useEffect(() => { loadSnackOptions(); }, [loadSnackOptions]);

  const loadMainMealOptions = useCallback(() => loadKitchenOptions('main-meal-options', setMainMealOptionsByDate), [loadKitchenOptions]);

  useEffect(() => { loadMainMealOptions(); }, [loadMainMealOptions]);

  const loadBreakfastOptions = useCallback(() => loadKitchenOptions('breakfast-options', setBreakfastOptionsByDate), [loadKitchenOptions]);

  useEffect(() => { loadBreakfastOptions(); }, [loadBreakfastOptions]);

  const loadMatterCoreMealOptions = useCallback(() => loadKitchenOptions('matter-core-meal-options', setMatterCoreMealOptionsByDate), [loadKitchenOptions]);

  useEffect(() => { loadMatterCoreMealOptions(); }, [loadMatterCoreMealOptions]);

  const selectedMenu = useMemo(
    () => menus.find((m) => m._id === selectedMenuId) || null,
    [menus, selectedMenuId]
  );
  const selectionWindow = useKitchenSelectionWindow(selectedMenu, missingCheckDate);

  // Includes dates from customer selections, from whatever the kitchen has
  // already uploaded (main/sub/breakfast/snack options), and — when neither
  // of those exist yet — every day in the menu's own date range. Without that
  // last fallback, a brand-new menu with zero customer selections and zero
  // uploads would hide the rotation setup. Menus are now uploaded in Menu
  // Management, while Kitchen List still needs a date before any preparation.
  const menuDateKeys = useMemo(
    () => deriveDateKeys({ menuSelections, mainMealOptionsByDate, breakfastOptionsByDate, snackOptionsByDate, selectedMenu }),
    [menuSelections, mainMealOptionsByDate, breakfastOptionsByDate, snackOptionsByDate, selectedMenu]
  );

  // On-demand only: checking delivery_schedule means a full-detail fetch per
  // active subscription (hundreds of Matter API calls), so this never runs
  // automatically — only when the user clicks "Check Missing Selections".
  const checkMissingSelections = async (dateKey, selectionsOverride) => {
    if (!dateKey) return;
    setCheckingMissing(true);
    setError('');
    try {
      const res = await api.get('/matter/subscriptions/delivery-on-date', {
        params: { date: dateKey }
      });
      const subs = res.data?.data || [];
      setDeliveryCheck({
        dateKey,
        emails: new Set(subs.map((sub) => String(sub.email || '').trim().toLowerCase()).filter(Boolean)),
        subscriptionIds: new Set(subs.map((sub) => String(sub.subscription_id || '').trim()).filter(Boolean)),
        customerIds: new Set(subs.map((sub) => String(sub.customer_id ?? '').trim()).filter(Boolean))
      });

      // Use freshly-fetched selections when passed in (e.g. right after an
      // assignment) instead of `menuSelections`, which won't reflect a
      // same-tick loadSelections() call until the next render.
      const activeSelections = selectionsOverride || menuSelections;

      // Some internal customers are linked to a Matter subscription whose
      // email differs from theirs (Customer.matterSubscriptionId, set via
      // Customer Management's "Internal Customer Match" panel). Resolve each
      // Matter row back to that internal identity by subscription id first —
      // otherwise a customer already covered for this date under their real
      // (internal) email gets wrongly flagged missing under their Matter
      // email, and assigning meals for them would create a stray duplicate
      // MenuSelectionRecord keyed by the wrong email instead of updating
      // their real one.
      const internalBySubscriptionId = new Map();
      activeSelections.forEach((entry) => {
        const subId = String(entry?.matterSourceSubscriptionId || entry?.matterSubscriptionId || '').trim();
        if (subId) internalBySubscriptionId.set(subId, entry);
      });

      const coveredEmails = new Set();
      activeSelections.forEach((entry) => {
        // A snack alone (snacks are topped up for everyone) isn't a selection.
        const hasSelectionThatDay = (entry.selectedMeals || []).some((m) => getDateKey(m?.date) === dateKey && String(m?.mealType || '').toLowerCase() !== 'snack');
        if (hasSelectionThatDay) coveredEmails.add(String(entry.email || '').trim().toLowerCase());
      });

      const missing = subs
        .map((sub) => {
        const matched = activeSelections.find(entry => String(entry.matterCustomerId || '') === String(sub.customer_id))
          || internalBySubscriptionId.get(String(sub.subscription_id || '').trim());
        const core = String(sub.plan_name || '').trim().toLowerCase() === 'matter core';
        const portions = (matched?.selectedMeals || []).filter(meal => getDateKey(meal.date) === dateKey && (core ? meal.mealType === 'main' : meal.mealType !== 'snack'))
          .reduce((sum, meal) => sum + Math.max(1, Number(meal.quantity) || 1), 0);
        const covered = portions >= requiredKitchenMeals(sub, matched, dateKey);
          return {
            sub, covered,
            resolvedEmail: matched?.email || sub.email || '',
            resolvedCustomerId: matched?.customerId || String(sub.customer_id ?? sub.subscription_id),
            resolvedName: getCustomerName({ matterName: sub.name })
          };
        })
        .filter(({ covered }) => !covered)
        .map(({ sub, resolvedEmail, resolvedCustomerId, resolvedName }) => ({
          customerId: resolvedCustomerId,
          customerName: resolvedName,
          firstName: resolvedName,
          lastName: '',
          email: resolvedEmail,
          selectedMeals: [],
          _missingSelection: true,
          _missingSelectionDate: dateKey,
          _mealFrequency: sub.meal_frequency,
          _planName: sub.plan_name || '',
          _subscriptionId: sub.subscription_id,
          _breakfastIncluded: typeof sub.breakfast_included === 'boolean' ? sub.breakfast_included : undefined,
          _exclusions: sub.exclusions || [],
          dietaryRestrictions: sub.exclusions || []
        }));

      setMissingSelectionEntries(missing);
      setAutoAssignResult(null);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to check missing selections');
    } finally {
      setCheckingMissing(false);
    }
  };

  const saveMainMealOptionsForDate = async (date, mainMeals, subMeals) => {
    if (!selectedMenuId || !date) return;
    setSavingMainMealOptions(true);
    try {
      const res = await api.put(`/menus/${selectedMenuId}/main-meal-options`, { date, mainMeals, subMeals });
      setMainMealOptionsByDate(res.data?.data || {});
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to save main meal options');
    } finally {
      setSavingMainMealOptions(false);
    }
  };

  // Shared by the standalone breakfast importer and the weekly menu upload's
  // "breakfast" rows. Breakfast presets are global (keyed by name), not
  // per-date, unlike main/sub meals and snacks. Tries the dedicated endpoint
  // first, then falls back to older per-menu routes for backward compatibility.
  const persistBreakfastPresets = async (incomingRows, incomingFirstRow, incomingPresetsByName) => {
    // The save endpoint REPLACES the whole shared table with whatever it is
    // sent, and a weekly menu file only lists that week's breakfasts — so
    // sending just those used to wipe every other saved breakfast (128 presets
    // collapsed to a few zero-macro rows after one upload). Merge into what is
    // already saved instead:
    //  - a row with macros adds or updates its dish;
    //  - a row with no macros never overwrites values already saved (menu files
    //    often list a dish without its macros), but a name not saved yet is
    //    still added so it shows up flagged "No macros";
    //  - the saved default preset is kept.
    let parsedRows = incomingRows;
    let firstRow = incomingFirstRow;
    let presetsByName = incomingPresetsByName;
    try {
      const current = await api.get('/menus/kitchen-breakfast-presets');
      const savedByName = current.data?.data?.presetsByName || {};
      const savedDefault = current.data?.data?.breakfastPreset;
      const mergedByName = { ...savedByName };
      incomingRows.forEach((row) => {
        const key = normalizeBreakfastKey(row.breakfastName);
        if (!key) return;
        const hasMacros = (Number(row.C) || 0) + (Number(row.P) || 0) + (Number(row.F) || 0) > 0;
        if (!mergedByName[key] || hasMacros) {
          mergedByName[key] = {
            breakfastName: row.breakfastName,
            C: Number(row.C) || 0,
            P: Number(row.P) || 0,
            F: Number(row.F) || 0,
            V: Number(row.V) || 80,
            isLargeBreakfast: !!row.isLargeBreakfast
          };
        }
      });
      parsedRows = Object.entries(mergedByName).map(([key, p]) => ({
        breakfastName: p.breakfastName || key,
        C: Number(p.C) || 0,
        P: Number(p.P) || 0,
        F: Number(p.F) || 0,
        V: Number(p.V) || 80,
        isLargeBreakfast: !!p.isLargeBreakfast
      }));
      presetsByName = mergedByName;
      if (savedDefault?.breakfastName) firstRow = savedDefault;
    } catch (mergeError) {
      // Older servers without the GET route keep the old behaviour; any other
      // failure stops here rather than risk overwriting the saved table blind.
      if (!isRouteNotFound(mergeError)) throw mergeError;
    }

    let savedPreset = firstRow;
    let savedPresetsByName = presetsByName;

    try {
      const saveResponse = await api.put('/menus/kitchen-breakfast-presets', {
        presets: parsedRows,
        defaultPreset: firstRow
      });
      savedPreset = saveResponse.data?.data?.breakfastPreset || firstRow;
      savedPresetsByName = saveResponse.data?.data?.presetsByName || presetsByName;
    } catch (saveError) {
      if (!isRouteNotFound(saveError)) throw saveError;

      try {
        await api.put(`/menus/${selectedMenuId}/breakfast-presets`, {
          presets: parsedRows,
          defaultPreset: firstRow
        });
      } catch (menuSaveError) {
        if (!isRouteNotFound(menuSaveError)) throw menuSaveError;

        await api.put(`/menus/${selectedMenuId}`, {
          breakfastPreset: firstRow,
          breakfastPresetsByName: presetsByName
        });
      }
    }

    const nextState = {
      breakfastName: savedPreset.breakfastName || '',
      C: savedPreset.C ?? '',
      P: savedPreset.P ?? '',
      F: savedPreset.F ?? '',
      V: savedPreset.V ?? 80,
      isLargeBreakfast: !!savedPreset.isLargeBreakfast,
      presetsByName: savedPresetsByName
    };
    setBreakfastPreset(nextState);
    saveBreakfastPresetToStorage(nextState);
    return nextState;
  };

  // Bulk-import the whole week's menu from one spreadsheet instead of adding
  // items one at a time. Expected columns (case-insensitive), every row scoped
  // to its Date (required for all slots — breakfast now rotates per-date too):
  // Date, Slot (main/sub/snack1/snack2/breakfast, defaults to main),
  // MealName, Type (chicken/beef/fish — main/sub only), Exclusions (comma-separated,
  // matched against each customer's exclusion list for every slot type),
  // C, P, F (snack/breakfast macros), V + LargeBreakfast (breakfast only —
  // also updates the shared global breakfast preset used for weight calc).
  // Reuses the existing single-date PUT endpoints, one date at a time
  // (sequential, so concurrent saves to the same menu document's Map fields never race).
  const removeMainMeal = (index) => {
    const current = mainMealOptionsByDate[missingCheckDate] || { mainMeals: [], subMeals: [] };
    const updatedMainMeals = (current.mainMeals || []).filter((_, i) => i !== index);
    saveMainMealOptionsForDate(missingCheckDate, updatedMainMeals, current.subMeals || []);
  };

  const removeSubMeal = (index) => {
    const current = mainMealOptionsByDate[missingCheckDate] || { mainMeals: [], subMeals: [] };
    const updatedSubMeals = (current.subMeals || []).filter((_, i) => i !== index);
    saveMainMealOptionsForDate(missingCheckDate, current.mainMeals || [], updatedSubMeals);
  };

  const saveBreakfastOptionsForDate = async (date, options) => {
    if (!selectedMenuId || !date) return;
    setSavingBreakfastOptions(true);
    try {
      const res = await api.put(`/menus/${selectedMenuId}/breakfast-options`, { date, options });
      setBreakfastOptionsByDate(res.data?.data || {});
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to save breakfast options');
    } finally {
      setSavingBreakfastOptions(false);
    }
  };

  const removeBreakfastOption = (index) => {
    const current = breakfastOptionsByDate[missingCheckDate] || [];
    const updated = current.filter((_, i) => i !== index);
    saveBreakfastOptionsForDate(missingCheckDate, updated);
  };

  // Matter Core customers (see auto-populate-missing on the server) get a
  // plain ordered list, no type/exclusions — a customer needing 2 meals just
  // gets list[0] and list[1]. Unlike the other rotation editors, this one has
  // no spreadsheet upload path, since it's a much simpler shape — meals are
  // just typed in one at a time.
  const saveMatterCoreMealOptionsForDate = async (date, meals) => {
    if (!selectedMenuId || !date) return;
    setSavingMatterCoreMealOptions(true);
    try {
      const res = await api.put(`/menus/${selectedMenuId}/matter-core-meal-options`, { date, meals });
      setMatterCoreMealOptionsByDate(res.data?.data || {});
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to save Matter Core meal options');
    } finally {
      setSavingMatterCoreMealOptions(false);
    }
  };

  const addMatterCoreMeal = () => {
    const name = matterCoreMealInput.trim();
    if (!name || !missingCheckDate) return;
    const current = matterCoreMealOptionsByDate[missingCheckDate] || [];
    saveMatterCoreMealOptionsForDate(missingCheckDate, [...current, { name }]);
    setMatterCoreMealInput('');
  };

  const removeMatterCoreMeal = (index) => {
    const current = matterCoreMealOptionsByDate[missingCheckDate] || [];
    const updated = current.filter((_, i) => i !== index);
    saveMatterCoreMealOptionsForDate(missingCheckDate, updated);
  };

  // Global snack macro table (not per-date, not per-menu) — a snack's own
  // fixed C/P/F, looked up by name at calc time whenever that name is
  // assigned to a customer, whether picked randomly by Auto-Assign Snacks or
  // (if ever) chosen by the customer. Used directly, never divided by
  // snacksPerDay, and falls back to the per-date Snack Rotation option's own
  // C/P/F when no name here matches (see resolveSnackPresetForMeal).
  const saveSnackPresets = async (presetsByName) => {
    setSavingSnackPreset(true);
    try {
      const changes = snackPresetChanges(snackPreset.presetsByName || {}, presetsByName);
      const res = await api.patch('/menus/kitchen-snack-presets', changes);
      if (!res.data?.success) throw new Error(res.data?.message || 'Snack macros were not saved.');
      setSnackPreset({ presetsByName: res.data.data?.presetsByName || {} });
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to save snack macros');
      throw err;
    } finally {
      setSavingSnackPreset(false);
    }
  };

  const addSnackPreset = async () => {
    const name = snackPresetForm.name.trim();
    if (!name) return;
    const key = normalizeBreakfastKey(name);
    const updated = {
      ...snackPreset.presetsByName,
      [key]: {
        snackName: name,
        C: Number(snackPresetForm.C) || 0,
        P: Number(snackPresetForm.P) || 0,
        F: Number(snackPresetForm.F) || 0
      }
    };
    try {
      await saveSnackPresets(updated);
      setSnackPresetForm({ name: '', C: '', P: '', F: '' });
    } catch { /* Keep the entered values so the user can retry. */ }
  };

  const removeSnackPreset = async (key) => {
    const updated = { ...snackPreset.presetsByName };
    delete updated[key];
    try { await saveSnackPresets(updated); } catch { /* Preserve the saved row on failure. */ }
  };

  // Breakfast / snack options for the checked date whose name has no macros in
  // the saved presets (missing, or saved as all zeros). Auto-Assign is blocked
  // until each one has values — otherwise customers are given a meal that
  // shows 0/0/0 and takes the wrong amount off their day.
  const [macroDrafts, setMacroDrafts] = useState({});
  const [savingMacroKey, setSavingMacroKey] = useState('');
  const breakfastsMissingMacros = useMemo(() => {
    const names = (breakfastOptionsByDate[missingCheckDate] || [])
      .map((option) => String(option?.name || '').trim())
      .filter(Boolean);
    return Array.from(new Set(names)).filter((name) => !breakfastNameHasMacros(name, breakfastPreset));
  }, [breakfastOptionsByDate, missingCheckDate, breakfastPreset]);
  const snacksMissingMacros = useMemo(() => {
    const pools = snackOptionsByDate[missingCheckDate] || {};
    const names = [...(pools.first || []), ...(pools.second || [])]
      .map((option) => String(option?.name || '').trim())
      .filter(Boolean);
    return Array.from(new Set(names)).filter((name) => !snackNameHasMacros(name, snackPreset));
  }, [snackOptionsByDate, missingCheckDate, snackPreset]);
  const autoAssignBlockedByMacros = breakfastsMissingMacros.length + snacksMissingMacros.length > 0;

  // Adds / replaces one breakfast preset. The save endpoint replaces the whole
  // table, so every existing entry is sent along with the changed one.
  const saveBreakfastPresetEntry = async (mapKey, entry) => {
    const next = { ...(breakfastPreset?.presetsByName || {}), [mapKey]: entry };
    const rows = Object.values(next).map((p) => ({
      breakfastName: p.breakfastName,
      C: p.C,
      P: p.P,
      F: p.F,
      V: p.V ?? 80,
      isLargeBreakfast: !!p.isLargeBreakfast
    }));
    const defaultRow = {
      breakfastName: breakfastPreset?.breakfastName || rows[0].breakfastName,
      C: Number(breakfastPreset?.C) || 0,
      P: Number(breakfastPreset?.P) || 0,
      F: Number(breakfastPreset?.F) || 0,
      V: Number(breakfastPreset?.V) || 80,
      isLargeBreakfast: !!breakfastPreset?.isLargeBreakfast
    };
    await persistBreakfastPresets(rows, defaultRow, next);
  };

  // Inline editor for the "Breakfast Macros" / "Snack Macros" lists.
  const [presetEdit, setPresetEdit] = useState(null); // { kind, key, name, C, P, F, V, isLargeBreakfast }
  const [breakfastMacrosOpen, setBreakfastMacrosOpen] = useState(false);
  const startPresetEdit = (kind, key, preset) => setPresetEdit({
    kind,
    key,
    name: kind === 'snack' ? preset.snackName : preset.breakfastName,
    C: String(preset.C ?? 0),
    P: String(preset.P ?? 0),
    F: String(preset.F ?? 0),
    V: String(preset.V ?? 80),
    isLargeBreakfast: !!preset.isLargeBreakfast
  });
  const savePresetEdit = async () => {
    if (!presetEdit) return;
    const { kind, key, name } = presetEdit;
    const C = Math.max(0, Number(presetEdit.C) || 0);
    const P = Math.max(0, Number(presetEdit.P) || 0);
    const F = Math.max(0, Number(presetEdit.F) || 0);
    setError('');
    setSavingMacroKey(`${kind}:${name}`);
    try {
      if (kind === 'snack') {
        await saveSnackPresets({ ...snackPreset.presetsByName, [key]: { snackName: name, C, P, F } });
      } else {
        await saveBreakfastPresetEntry(key, {
          breakfastName: name,
          C,
          P,
          F,
          V: Number(presetEdit.V) || 80,
          isLargeBreakfast: !!presetEdit.isLargeBreakfast
        });
      }
      setPresetEdit(null);
    } catch (err) {
      setError(err.response?.data?.message || `Failed to save macros for "${name}"`);
    } finally {
      setSavingMacroKey('');
    }
  };

  const setMacroDraft = (kind, name, field, value) => {
    const key = `${kind}:${name}`;
    setMacroDrafts((drafts) => ({ ...drafts, [key]: { ...(drafts[key] || {}), [field]: value } }));
  };

  const saveMissingMacros = async (kind, name) => {
    const key = `${kind}:${name}`;
    const draft = macroDrafts[key] || {};
    const C = Number(draft.C) || 0;
    const P = Number(draft.P) || 0;
    const F = Number(draft.F) || 0;
    if (C + P + F <= 0) {
      setError(`Enter at least one value (C / P / F) for "${name}".`);
      return;
    }
    setError('');
    setSavingMacroKey(key);
    try {
      const mapKey = normalizeBreakfastKey(name);
      if (kind === 'snack') {
        await saveSnackPresets({ ...snackPreset.presetsByName, [mapKey]: { snackName: name, C, P, F } });
      } else {
        await saveBreakfastPresetEntry(mapKey, { breakfastName: name, C, P, F, V: 80, isLargeBreakfast: false });
      }
      setMacroDrafts((drafts) => {
        const rest = { ...drafts };
        delete rest[key];
        return rest;
      });
    } catch (err) {
      setError(err.response?.data?.message || `Failed to save macros for "${name}"`);
    } finally {
      setSavingMacroKey('');
    }
  };

  // One row of the Breakfast / Snack Macros lists: shows C / P / F (and weight +
  // LARGE for breakfasts) with a pencil that swaps the row for inline inputs.
  const renderPresetRow = (kind, key, preset, onRemove) => {
    const isSnack = kind === 'snack';
    const name = isSnack ? preset.snackName : preset.breakfastName;
    const rowId = `${kind}:${key}`;
    if (presetEdit && presetEdit.kind === kind && presetEdit.key === key) {
      const saving = savingMacroKey === `${kind}:${presetEdit.name}`;
      const inputClass = 'w-16 rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs focus:border-slate-900 focus:outline-none';
      return (
        <div key={rowId} className="rounded-xl bg-amber-50 px-3 py-2 text-sm ring-1 ring-amber-200">
          <span className="font-medium text-slate-800">{name}</span>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {['C', 'P', 'F', ...(isSnack ? [] : ['V'])].map((field) => (
              <label key={field} className="flex items-center gap-1 text-xs text-slate-600">
                {field === 'V' ? 'Weight (g)' : field}
                <input
                  type="number"
                  min="0"
                  value={presetEdit[field]}
                  onChange={(e) => setPresetEdit((edit) => ({ ...edit, [field]: e.target.value }))}
                  disabled={saving}
                  className={inputClass}
                />
              </label>
            ))}
            {!isSnack && (
              <label className="flex items-center gap-1 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={presetEdit.isLargeBreakfast}
                  onChange={(e) => setPresetEdit((edit) => ({ ...edit, isLargeBreakfast: e.target.checked }))}
                  disabled={saving}
                />
                Large
              </label>
            )}
            <button
              type="button"
              onClick={savePresetEdit}
              disabled={saving}
              className="rounded-lg bg-slate-900 px-3 py-1 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => setPresetEdit(null)}
              disabled={saving}
              className="rounded-lg border border-slate-300 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-white"
            >
              Cancel
            </button>
          </div>
        </div>
      );
    }
    return (
      <div key={rowId} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-sm">
        <span className="font-medium text-slate-800">
          {name}
          {!isSnack && preset.isLargeBreakfast && (
            <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-slate-200 text-slate-600 font-semibold">LARGE</span>
          )}
        </span>
        <div className="flex items-center gap-3 text-xs text-slate-500 flex-shrink-0">
          <span>C {preset.C}</span>
          <span>P {preset.P}</span>
          <span>F {preset.F}</span>
          {!isSnack && <span>{preset.V ?? 80} g</span>}
          <button type="button" onClick={() => startPresetEdit(kind, key, preset)} title="Edit macros" className="text-slate-500 hover:text-slate-900">
            <Pencil size={14} />
          </button>
          {onRemove && (
            <button type="button" onClick={onRemove} className="text-red-500 hover:text-red-700">
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
    );
  };

  // Inline "no macros yet" box shown under a flagged breakfast / snack option.
  const renderMissingMacrosForm = (kind, name) => {
    const key = `${kind}:${name}`;
    const draft = macroDrafts[key] || {};
    const saving = savingMacroKey === key;
    return (
      <div className="mt-2 rounded-lg bg-amber-50 p-2 ring-1 ring-amber-300">
        <p className="flex items-center gap-1 text-[11px] font-semibold text-amber-800">
          <AlertTriangle size={12} /> No macros saved for this {kind} — Auto-Assign is blocked until you add them
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {['C', 'P', 'F'].map((field) => (
            <input
              key={field}
              type="number"
              min="0"
              value={draft[field] ?? ''}
              onChange={(e) => setMacroDraft(kind, name, field, e.target.value)}
              placeholder={field}
              disabled={saving}
              className="w-16 rounded-lg border border-amber-300 bg-white px-2 py-1 text-xs focus:border-slate-900 focus:outline-none"
            />
          ))}
          <button
            type="button"
            onClick={() => saveMissingMacros(kind, name)}
            disabled={saving}
            className="rounded-lg bg-slate-900 px-3 py-1 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    );
  };

  // One action instead of two: for every customer missing a selection on the
  // checked date, fills their main meals (plus breakfast, if their profile
  // has breakfastInclude on) via assign-main-meals, then fills their full
  // snack count for that same date via assign-snacks scoped to just this
  // date + these customers (not the old menu-wide, every-date behavior).
  // Order doesn't affect the resulting macro math — that's recalculated from
  // the final saved meals whenever the kitchen list weights are displayed —
  // it just means one click covers everything a missing customer needs.
  const runAutoAssign = async () => {
    if (!selectedMenuId || !missingCheckDate) return;
    if (!selectionWindow.canAutoAssign) { setError(selectionWindow.message); return; }
    if (deliveryCheck?.dateKey !== missingCheckDate) {
      setError('Run "Check Missing Selections" for this date first.');
      return;
    }
    if (autoAssignBlockedByMacros) {
      setError('Add macros for the flagged breakfast / snack options first — Auto-Assign is blocked until then.');
      return;
    }
    setAssigningAll(true);
    setError('');
    try {
      const toPayload = (entry) => ({
        email: entry.email,
        name: entry.customerName,
        customerId: entry.customerId,
        subscriptionId: entry._subscriptionId,
        mealFrequency: entry._mealFrequency,
        breakfastIncluded: entry._breakfastIncluded,
        exclusions: entry._exclusions
      });
      const isMatterCore = (entry) => String(entry._planName || '').trim().toLowerCase() === 'matter core';
      const customers = missingSelectionEntries.filter((e) => !isMatterCore(e)).map(toPayload);
      // Matter Core has its own assignment (full meal_frequency main meals,
      // breakfast on top, snacks included) — never the standard rotation,
      // which counts breakfast as one of the meal_frequency slots.
      const matterCoreCustomers = missingSelectionEntries.filter(isMatterCore).map(toPayload);

      let mainMealsRes = null;
      let snacksRes = null;
      let matterCoreRes = null;
      if (customers.length > 0) {
        mainMealsRes = await api.post(`/menus/${selectedMenuId}/assign-main-meals`, {
          date: missingCheckDate,
          customers
        });
        snacksRes = await api.post(`/menus/${selectedMenuId}/assign-snacks`, {
          date: missingCheckDate,
          customers
        });
      }
      if (matterCoreCustomers.length > 0) {
        matterCoreRes = await api.post(`/menus/${selectedMenuId}/assign-matter-core-meals`, {
          date: missingCheckDate,
          customers: matterCoreCustomers
        });
      }

      // Customers who picked their own meals never go through the "missing"
      // path above, so their snacks (never customer-selectable) used to
      // depend entirely on the background job. Top them up here too — only
      // those Matter shows a delivery for on this date.
      let selectedSnacksRes = null;
      if (deliveryCheck?.dateKey === missingCheckDate) {
        const withSelection = menuSelections.filter((entry) =>
          (entry.selectedMeals || []).some((m) => getDateKey(m?.date) === missingCheckDate)
          && hasDeliveryOnCheckedDate(entry, deliveryCheck));
        const isCore = (entry) => String(entry.planName || '').trim().toLowerCase() === 'matter core';
        const standard = withSelection.filter((e) => !isCore(e)).map((e) => ({ email: e.email }));
        const core = withSelection.filter(isCore)
          .map((e) => ({
            email: e.email,
            subscriptionId: e.matterSubscriptionId,
            // Matter's own breakfast_included, so the Matter Core extra breakfast is topped up.
            breakfastIncluded: typeof e.breakfastIncluded === 'boolean' ? e.breakfastIncluded : undefined
          }));
        if (standard.length > 0) {
          selectedSnacksRes = await api.post(`/menus/${selectedMenuId}/assign-snacks`, {
            date: missingCheckDate,
            customers: standard
          });
        }
        if (core.length > 0) {
          await api.post(`/menus/${selectedMenuId}/assign-matter-core-meals`, {
            date: missingCheckDate,
            customers: core,
            snackOnly: true,
            includeBreakfast: true
          });
        }
      }

      setAutoAssignResult({
        mainMeals: mainMealsRes?.data?.data || null,
        snacks: snacksRes?.data?.data || null,
        matterCore: matterCoreRes?.data?.data || null,
        selectedSnacks: selectedSnacksRes?.data?.data || null
      });

      const freshSelections = await loadSelections();
      await checkMissingSelections(missingCheckDate, freshSelections);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to auto-assign');
    } finally {
      setAssigningAll(false);
    }
  };

  // No auto-select for the date pickers: the kitchen chooses a date explicitly.

  const saveSnackOptionsForDate = async (date, first, second) => {
    if (!selectedMenuId || !date) return;
    setSavingSnackOptions(true);
    try {
      const res = await api.put(`/menus/${selectedMenuId}/snack-options`, { date, first, second });
      setSnackOptionsByDate(res.data?.data || {});
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to save snack options');
    } finally {
      setSavingSnackOptions(false);
    }
  };

  const removeSnackOption = (pool, index) => {
    const current = snackOptionsByDate[missingCheckDate] || { first: [], second: [] };
    const updatedFirst = pool === 'first' ? (current.first || []).filter((_, i) => i !== index) : (current.first || []);
    const updatedSecond = pool === 'second' ? (current.second || []).filter((_, i) => i !== index) : (current.second || []);
    saveSnackOptionsForDate(missingCheckDate, updatedFirst, updatedSecond);
  };

  // The expensive part — calculateKitchenListEntry's full weight/macro/
  // escalation math plus groupMealsByDay, run once per customer — depends
  // only on the underlying selection/preset data, never on search text or
  // the "show only missing" toggle. Keeping those two out of this memo's
  // dependencies means typing in the search box (or flipping that toggle)
  // no longer re-runs the heavy calculation for every customer on every
  // keystroke — it used to, and for a large customer base that repeated
  // multi-second recomputation was exactly what tripped the browser's
  // "page unresponsive" detector while the kitchen was just trying to search.
  const allComputedRows = useMemo(() => {
    if (loadedSelectionScope !== `${selectedMenuId}:${missingCheckDate}`) return [];
    // A customer can have selections for some dates but still be missing one
    // for the specific date "Check Missing Selections" was run for — that
    // customer then shows up in BOTH menuSelections (their real entry, with
    // real meals) and missingSelectionEntries (a synthetic placeholder just
    // flagging the missing date). Concatenating the two arrays used to give
    // that customer two rows with the same email — a React duplicate-key
    // warning, and the actual cause of "Show only missing" seeming broken
    // (React's reconciliation gets confused by the key collision when the
    // filtered list changes size). Merge by email instead: keep the real
    // entry's meals, just flag it as missing that date.
    const byKey = new Map();
    const keyFor = (entry) => {
      const email = String(entry?.email || '').trim().toLowerCase();
      return email || `id:${entry?.customerId || ''}`;
    };

    menuSelections.forEach((entry) => {
      byKey.set(keyFor(entry), entry);
    });

    missingSelectionEntries.forEach((entry) => {
      const key = keyFor(entry);
      const existing = byKey.get(key);
      byKey.set(key, existing
        ? { ...existing, _missingSelection: true, _missingSelectionDate: entry._missingSelectionDate }
        : entry);
    });

    const combinedEntries = Array.from(byKey.values());
    return combinedEntries.map((entry) => {
        const enrichedMeals = (entry.selectedMeals || []).map((meal, index) => {
          const key = meal?._overrideKey || buildMealOverrideKey(entry, meal, index);
          const override = mealTypeOverrides[key];
          return {
            ...meal,
            // Pinned here (raw index) because the calculation may expand a
            // quantity: 2 row into two portions, shifting later indexes.
            _overrideKey: key,
            manualProteinType: override || meal.manualProteinType || ''
          };
        });
        const mealCount = Array.isArray(entry.selectedMeals)
          ? entry.selectedMeals.filter((meal) => String(meal.mealType || '').toLowerCase() !== 'breakfast').length
          : 0;
        const calculated = calculateKitchenListEntry({
          customer: {
            ...entry,
            mealCount,
            customerName: getCustomerName(entry),
            missingSelection: !!entry._missingSelection,
            missingSelectionDate: entry._missingSelectionDate || null
          },
          selectedMeals: enrichedMeals,
          breakfastPreset,
          snackPreset
        });

        // Grouped here (once, when the memo recomputes) instead of inline in
        // JSX — the render body used to call groupMealsByDay for every
        // customer on every render, including renders triggered by state
        // changes that have nothing to do with this list (e.g. a date picker
        // elsewhere on the page), which added up fast with a large customer count.
        //
        // missingSelection alone isn't enough to decide "show the empty-state
        // card instead of their meals" — after the email-merge above, a
        // customer can be missingSelection: true (flagged for one date) while
        // still having real meals for other dates. Only show the placeholder
        // when they truly have nothing at all.
        const hasNoMealsAtAll = !calculated.selectedMeals || calculated.selectedMeals.length === 0;
        const noDeliveryDate = deliveryCheck
          && !entry.partner
          && hasDeliveryOnCheckedDate(entry, deliveryCheck) === false
          && (calculated.selectedMeals || []).some((meal) => getDateKey(meal?.date) === deliveryCheck.dateKey)
          ? deliveryCheck.dateKey
          : null;
        return {
          ...calculated,
          mealsByDay: groupMealsByDay(calculated.selectedMeals),
          showMissingPlaceholder: calculated.missingSelection && hasNoMealsAtAll,
          needsAttention: noDeliveryDate
            || (calculated.selectedMeals || []).some((meal) => getAttentionReasons(meal).length > 0),
          // Set when this customer has meals on the checked date but Matter
          // shows no delivery for them that day (paused / not scheduled /
          // subscription not started) — the kitchen shouldn't cook these
          // without confirming first.
          noDeliveryDate,
          // Kitchen-only per-day notes — not part of calculateKitchenListEntry's
          // return shape, carried through separately from the raw selection record.
          dayNotes: entry.dayNotes || []
        };
      });
  }, [loadedSelectionScope, selectedMenuId, menuSelections, missingSelectionEntries, breakfastPreset, snackPreset, mealTypeOverrides, deliveryCheck]);

  // Cheap: just filters the already-computed rows above. This is the only
  // part that re-runs while typing in the search box.
  const scheduledCustomerRows = useMemo(() => dayRoster?.scope === `${selectedMenuId}:${missingCheckDate}`
    ? allComputedRows.filter(entry => visibleKitchenCustomer(entry, dayRoster.rows, missingCheckDate)).map(entry => kitchenCustomerDay(entry, missingCheckDate)) : [],
  [allComputedRows, dayRoster, selectedMenuId, missingCheckDate]);
  const planOptions = useMemo(
    () => Array.from(new Set(scheduledCustomerRows.map((entry) => entry.planName).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [scheduledCustomerRows]
  );

  const customerRows = useMemo(() => scheduledCustomerRows
    .filter((entry) => `${entry.customerName || ''} ${entry.email || ''}`.toLowerCase().includes(search.toLowerCase()))
    .filter((entry) => !showOnlyMissing || entry.missingSelection)
    .filter((entry) => !planFilter || entry.planName === planFilter)
    .filter((entry) => !showOnlyAttention || entry.needsAttention),
  [scheduledCustomerRows, search, showOnlyMissing, planFilter, showOnlyAttention]);

  // useCallback here (and on saveDayNote below) isn't optional — CustomerCard
  // is React.memo'd specifically so typing in one customer's search match or
  // day-note field doesn't re-render every OTHER customer card too. A plain
  // function recreated every render would defeat that: React.memo compares
  // props by reference, and a fresh function identity every time would make
  // every card "changed" on every render regardless of the memo.
  const persistMealTypeOverride = useCallback(async ({ entry, meal, index, value }) => {
    const key = meal?._overrideKey || buildMealOverrideKey(entry, meal, index);
    const normalizedValue = String(value || '').trim().toLowerCase();

    setMealTypeOverrides((prev) => ({ ...prev, [key]: normalizedValue }));

    let updatedSelections = null;
    setMenuSelections((prev) => prev.map((row) => {
      const sameEmail = String(row?.email || '').trim().toLowerCase() === String(entry?.email || '').trim().toLowerCase();
      if (!sameEmail) return row;

      const nextMeals = (row.selectedMeals || []).map((rowMeal, rowIndex) => {
        const rowKey = rowMeal?._overrideKey || buildMealOverrideKey(row, rowMeal, rowIndex);
        if (rowKey !== key) return rowMeal;
        return { ...rowMeal, manualProteinType: normalizedValue };
      });

      updatedSelections = nextMeals;
      return { ...row, selectedMeals: nextMeals };
    }));

    if (!updatedSelections || !selectedMenuId) return;

    try {
      setSavingOverrideKey(key);
      await api.put(`/menus/${selectedMenuId}/selections/${encodeURIComponent(entry.email)}`, {
        matterCustomerId: entry.matterCustomerId,
        selections: updatedSelections.map(normalizeSelectionForSave)
      });
    } catch (saveError) {
      setError(saveError.response?.data?.message || 'Failed to save meal type override');
    } finally {
      setSavingOverrideKey('');
    }
  }, [selectedMenuId]);

  // Saves a kitchen-only note for one customer on one specific delivery day.
  // An empty note removes that date's entry server-side. Updates
  // menuSelections locally on success so the note persists in the UI
  // without needing a full reload.
  const saveDayNote = useCallback(async (entry, dateKey, note) => {
    const email = entry?.email;
    if (!email || !selectedMenuId || !dateKey) return;

    const draftKey = `${email}::${dateKey}`;
    const trimmed = String(note || '').trim();
    const existing = (entry.dayNotes || []).find((n) => n.date === dateKey)?.note || '';
    if (trimmed === existing) return;

    setSavingDayNoteKey(draftKey);
    try {
      const res = await api.patch(
        `/menus/${selectedMenuId}/selections/${encodeURIComponent(email)}/day-notes`,
        { date: dateKey, note: trimmed }
      );
      if (res.data?.success) {
        const nextDayNotes = res.data.data?.dayNotes || [];
        setMenuSelections((prev) => prev.map((row) => {
          const sameEmail = String(row?.email || '').trim().toLowerCase() === String(email).trim().toLowerCase();
          return sameEmail ? { ...row, dayNotes: nextDayNotes } : row;
        }));
      }
    } catch (saveError) {
      setError(saveError.response?.data?.message || 'Failed to save note');
    } finally {
      setSavingDayNoteKey('');
    }
  }, [selectedMenuId]);

  // Meal-card "Change" checkboxes (carb / veg / garnish / sauce). Saves the
  // combined remark string through the same endpoint as Upload Meal Remarks,
  // for the Kitchen List's meal flags.
  const saveMealRemark = useCallback(async ({ entry, meal, remark }) => {
    const email = entry?.email;
    if (!email || !selectedMenuId || !meal?.date || !meal?.mealName) return;
    const key = meal?._overrideKey || buildMealOverrideKey(entry, meal, 0);
    const nextRemark = String(remark || '').trim();
    setSavingOverrideKey(`remark:${key}`);
    try {
      await api.patch(
        `/menus/${selectedMenuId}/selections/${encodeURIComponent(email)}/meal-remarks`,
        { entries: [{ date: getDateKey(meal.date), mealName: meal.mealName, slotNumber: meal.slotNumber, remark: nextRemark }] }
      );
      const sameEmail = (row) => String(row?.email || '').trim().toLowerCase() === String(email).trim().toLowerCase();
      setMenuSelections((prev) => prev.map((row) => {
        if (!sameEmail(row)) return row;
        let applied = false;
        return {
          ...row,
          selectedMeals: (row.selectedMeals || []).map((m) => {
            const match = !applied
              && getDateKey(m.date) === getDateKey(meal.date)
              && String(m.mealName || '').trim().toLowerCase() === String(meal.mealName || '').trim().toLowerCase()
              && (meal.slotNumber === undefined || meal.slotNumber === null || m.slotNumber === meal.slotNumber);
            if (!match) return m;
            applied = true;
            return { ...m, remark: nextRemark };
          })
        };
      }));
    } catch (saveError) {
      setError(saveError.response?.data?.message || 'Failed to save meal remark');
    } finally {
      setSavingOverrideKey('');
    }
  }, [selectedMenuId]);

  const downloadMealRemarksTemplate = async () => {
    const XLSX = await loadXLSX();
    const sampleDate = menuDateKeys[0] || getDateKey(new Date());
    const rows = [
      { Name: 'Jane Doe', Email: '', Date: sampleDate, Meal: 'Grilled Chicken Breast', Remark: 'carb' },
      { Name: 'John Smith', Email: 'john@example.com', Date: sampleDate, Meal: 'Beef Stir Fry', Remark: 'veg' }
    ];
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Meal Remarks');
    XLSX.writeFile(workbook, 'meal-remarks-upload-template.xlsx');
  };

  // Bulk-sets a free-text remark on specific meals, from an uploaded Excel
  // file (Name, optional Email, Date, Meal, Remark) — any text in Remark is
  // accepted verbatim (not limited to a fixed keyword list), shown next to
  // that meal in Kitchen List and on the Day Kitchen Paper as "Change
  // {remark}". Matched against the customers already loaded in customerRows
  // for this menu — Email is used when given (the one collision-safe key
  // everywhere else in this app); Name-only matching is supported since
  // that's what the kitchen's source sheets tend to have, but is inherently
  // riskier (two customers can share a name) — an ambiguous or unmatched
  // name is skipped and counted, never guessed. Batched into one PATCH per
  // customer (covering every row the upload had for them), not one request
  // per meal.
  const handleMealRemarksUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!selectedMenuId) {
      setError('Select a menu first');
      event.target.value = '';
      return;
    }

    try {
      setUploadingMealRemarks(true);
      setError('');
      setMealRemarksUploadResult(null);

      const XLSX = await loadXLSX();
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = readSheetRowsSafely(XLSX, sheet);

      const byEmail = new Map(
        customerRows.map((entry) => [String(entry.email || '').trim().toLowerCase(), entry])
      );
      const byName = new Map();
      customerRows.forEach((entry) => {
        const nameKey = String(entry.customerName || '').trim().toLowerCase();
        if (!nameKey) return;
        if (!byName.has(nameKey)) byName.set(nameKey, []);
        byName.get(nameKey).push(entry);
      });

      const entriesByEmail = new Map(); // email -> [{date, mealName, remark}]
      let skippedNoCustomer = 0;
      let skippedAmbiguousName = 0;
      let skippedInvalidRow = 0;

      rows.forEach((row) => {
        const dateKey = getDateKey(row.Date ?? row.date);
        const mealName = String(row.Meal ?? row.MealName ?? row.meal ?? row.mealName ?? '').trim();
        const remarkRaw = String(row.Remark ?? row.remark ?? '').trim();
        const emailRaw = String(row.Email ?? row.email ?? '').trim();
        const nameRaw = String(row.Name ?? row.name ?? row['Customer Name'] ?? '').trim();

        if (!dateKey || dateKey === 'unknown-date' || !mealName || !remarkRaw || (!emailRaw && !nameRaw)) {
          skippedInvalidRow += 1;
          return;
        }

        let matchedEntry = null;
        if (emailRaw) {
          matchedEntry = byEmail.get(emailRaw.toLowerCase()) || null;
          if (!matchedEntry) {
            skippedNoCustomer += 1;
            return;
          }
        } else {
          const candidates = byName.get(nameRaw.toLowerCase()) || [];
          if (candidates.length === 0) {
            skippedNoCustomer += 1;
            return;
          }
          if (candidates.length > 1) {
            skippedAmbiguousName += 1;
            return;
          }
          matchedEntry = candidates[0];
        }

        const email = String(matchedEntry.email || '').trim().toLowerCase();
        if (!email) {
          skippedNoCustomer += 1;
          return;
        }
        if (!entriesByEmail.has(email)) entriesByEmail.set(email, []);
        entriesByEmail.get(email).push({ date: dateKey, mealName, remark: remarkRaw });
      });

      let updated = 0;
      let unmatchedMeals = 0;
      let failedCustomers = 0;

      for (const [email, entries] of entriesByEmail.entries()) {
        try {
          const res = await api.patch(
            `/menus/${selectedMenuId}/selections/${encodeURIComponent(email)}/meal-remarks`,
            { entries }
          );
          if (res.data?.success) {
            updated += res.data.data?.updated || 0;
            unmatchedMeals += (res.data.data?.unmatched || []).length;
          } else {
            failedCustomers += 1;
          }
        } catch {
          failedCustomers += 1;
        }
      }

      setMealRemarksUploadResult({
        customersUpdated: entriesByEmail.size - failedCustomers,
        mealsUpdated: updated,
        unmatchedMeals,
        failedCustomers,
        skippedNoCustomer,
        skippedAmbiguousName,
        skippedInvalidRow
      });

      await loadSelections();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to upload meal remarks');
    } finally {
      setUploadingMealRemarks(false);
      event.target.value = '';
    }
  };

  const formatAddress = (addr) => {
    if (!addr) return 'No address on file';
    const parts = [
      addr.building,
      addr.unit ? `Unit ${addr.unit}` : null,
      addr.floor,
      addr.street,
      addr.area,
      addr.emirate,
      addr.additional_details
    ].filter(Boolean);
    return parts.join(', ') || 'No address on file';
  };

  // Matter's own `emirate` field isn't consistently just the emirate name —
  // it sometimes carries the zone baked in too (e.g. "Abu Dhabi - Al
  // Rowdah" alongside a plain "Abu Dhabi" for other customers), and casing
  // varies ("DUBAI" vs "Dubai"). The Day Kitchen Paper groups by emirate
  // ONLY, never by zone, so this collapses any such variant down to one of
  // the 7 canonical UAE emirate names before grouping — otherwise "Abu
  // Dhabi" and "Abu Dhabi - Al Rowdah" become two separate papers instead
  // of one.
  const UAE_EMIRATES = ['Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah'];
  const canonicalizeEmirate = (raw) => {
    const cleaned = String(raw || '').trim();
    if (!cleaned) return 'No Emirate';
    const lower = cleaned.toLowerCase();
    const match = UAE_EMIRATES.find((e) => lower.includes(e.toLowerCase()));
    return match || cleaned;
  };

  // Owner (2026-10-10): customers whose zone (Matter's address `area`) is
  // Dubai South district ("Dubai South" or "Emaar South") are grouped under the Abu Dhabi category on the kitchen paper
  // (PDF, Word, Excel and the customer-list export). Their printed address
  // still shows Dubai South / Dubai.
  const paperEmirate = (addr) => (/dubai\s*south|emaar\s*south/i.test(String(addr?.area || ''))
    ? 'Abu Dhabi'
    : canonicalizeEmirate(addr?.emirate));

  // Extracts a sortable 24h hour from labels like "By 6 AM" / "By 12:30 PM".
  // Windows that can't be parsed sort to the end.
  const parseDeliveryHour = (label) => {
    if (!label) return 999;
    const match = String(label).match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i);
    if (!match) return 999;
    let hour = parseInt(match[1], 10);
    const meridiem = (match[3] || '').toUpperCase();
    if (meridiem === 'PM' && hour !== 12) hour += 12;
    if (meridiem === 'AM' && hour === 12) hour = 0;
    return hour + (parseInt(match[2], 10) || 0) / 60;
  };

  // Turns a parsed hour back into a clean "H:MM AM/PM" label — used as the
  // Day Kitchen Paper's group heading instead of the raw delivery window
  // string, since that raw string can carry zone/area text along with the
  // time (e.g. "By 6 AM (Downtown)"). Papers there are grouped by emirate and
  // time only, never by zone, so two windows that differ only in zone text
  // but share the same hour must collapse into one paper, not split into two.
  const formatDeliveryHourLabel = (hourDecimal) => {
    if (hourDecimal === 999) return 'No delivery window';
    const totalMinutes = Math.round(hourDecimal * 60);
    const hour24 = Math.floor(totalMinutes / 60);
    const minute = totalMinutes % 60;
    const meridiem = hour24 >= 12 ? 'PM' : 'AM';
    const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
    return `${hour12}:${String(minute).padStart(2, '0')} ${meridiem}`;
  };

  // One row per MEAL (not per customer) across everyone currently loaded for
  // this menu — a customer with several meals across several days gets one
  // row each. Columns: Customer ID, Name, CPF, Date, Meal Name, then that
  // specific meal's own C/P/F/calories (the per-meal breakdown shown on its
  // card — e.g. "C 60 / P 64 / F 19" — NOT the customer's overall daily
  // target macros, and NOT the physical prep weight Kitchen Counting exports).
  // A customer with no cpf on file exports blank, not "null" — cpf is
  // sparse/optional on Customer.
  // Reproduces the exact customer ordering downloadDayKitchenPaper uses for a
  // date, so the two never drift apart: regular (non-partner) customers
  // grouped by delivery emirate (A→Z), then by delivery-window hour
  // (earliest→latest) within each emirate, then by customer name (A→Z)
  // within each window — followed by Partner customers grouped by partner
  // name (A→Z), then by customer name (A→Z) within each partner. A
  // customer's own meals stay in their original selectedMeals order (just
  // filtered to this date), matching each row of their table on the PDF.
  const planFileSuffix = paperPlan ? `-${paperPlan.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}` : '';

  // Owner (2026-10-09): a customer who has a saved selection for a date but no
  // active Matter delivery that day (paused / skipped / not started / ended)
  // is left out of the kitchen paper (PDF, Word, Excel) and the customer-list
  // export. Partner members have no Matter subscription of their own, so they
  // are always kept. The Matter delivery list is fetched for the date here
  // (reusing the "Check Missing Selections" result when it is for the same
  // date); if Matter can't be reached nothing is generated, rather than
  // printing a paper that may include customers who aren't being delivered.
  const [paperExcluded, setPaperExcluded] = useState(null);
  const applyKitchenOverrides = (entry) => ({
    ...entry,
    selectedMeals: (entry.selectedMeals || []).map((meal, index) => {
      const key = meal?._overrideKey || buildMealOverrideKey(entry, meal, index);
      return { ...meal, _overrideKey: key, manualProteinType: mealTypeOverrides[key] || meal.manualProteinType || '' };
    }),
  });
  const runKitchenExport = async (action) => {
    if (exportInFlight.current) return;
    const scope = activeSelectionScope.current;
    exportInFlight.current = true;
    setExportBusy(true);
    setExportError('');
    try { await action(); }
    catch (err) { if (activeSelectionScope.current === scope) setExportError(err.response?.data?.message || err.message || 'Download failed. Please retry.'); }
    finally { exportInFlight.current = false; setExportBusy(false); }
  };

  const getDeliverableRows = async (dateKey) => {
    const scope = `${selectedMenuId}:${missingCheckDate}`;
    if (loadingSelections || loadedSelectionScope !== scope || dateKey !== missingCheckDate) {
      setExportError('Load and finish preparing the selected date before exporting.'); return null;
    }
    try {
      const snapshot = await loadKitchenSnapshot(api, selectedMenuId, [dateKey], () => activeSelectionScope.current === scope, applyKitchenOverrides, preparedSnapshot.current && { ...preparedSnapshot.current, selections: menuSelections, breakfastPreset, snackPreset });
      const selectedKeys = new Set(customerRows.map((entry) => String(entry.email || entry.customerId)));
      const filteredView = search || showOnlyMissing || planFilter || showOnlyAttention;
      const rows = snapshot.entries.filter((entry) => (!filteredView || selectedKeys.has(String(entry.email || entry.customerId))) && (!paperPlan || entry.planName === paperPlan));
      if (!rows.length) throw new Error('No confirmed meals match this date and the current filters. Clear the search and plan filters, or choose a different date.');
      assertKitchenExportReady(rows);
      if (activeSelectionScope.current !== scope) return null;
      setPaperExcluded({ dateKey, names: [] });
      return rows.map((entry) => ({ ...entry, mealsByDay: groupMealsByDay(entry.selectedMeals) }));
    } catch (err) {
      if (activeSelectionScope.current === scope) setExportError(err.response?.data?.message || err.message || 'Kitchen export could not be verified.');
      return null;
    }
  };

  const buildKitchenPaperOrder = (dateKey, rowsForDate = customerRows) => {
    const entriesWithMeals = rowsForDate
      .filter((entry) => !paperPlan || entry.planName === paperPlan)
      .map((entry) => ({
        entry,
        dayMeals: (entry.selectedMeals || []).filter((meal) => getDateKey(meal?.date) === dateKey)
      }))
      .filter((row) => row.dayMeals.length > 0);

    const partnerEntries = entriesWithMeals.filter((row) => !!row.entry.partner);
    const regularEntries = entriesWithMeals.filter((row) => !row.entry.partner);

    const emirateOf = (row) => paperEmirate(row.entry.deliveryAddress);
    const emirateGroups = new Map();
    regularEntries.forEach((row) => {
      const emirate = emirateOf(row);
      if (!emirateGroups.has(emirate)) emirateGroups.set(emirate, []);
      emirateGroups.get(emirate).push(row);
    });
    const sortedEmirates = Array.from(emirateGroups.keys()).sort((a, b) => a.localeCompare(b));

    const ordered = [];
    for (const emirate of sortedEmirates) {
      const windowGroups = new Map();
      emirateGroups.get(emirate).forEach((row) => {
        const hourKey = parseDeliveryHour(row.entry.deliveryWindow?.label);
        if (!windowGroups.has(hourKey)) windowGroups.set(hourKey, []);
        windowGroups.get(hourKey).push(row);
      });
      const sortedWindows = Array.from(windowGroups.entries()).sort((a, b) => a[0] - b[0]);
      sortedWindows.forEach(([, rows]) => {
        rows.sort((a, b) => (a.entry.customerName || a.entry.email || '')
          .localeCompare(b.entry.customerName || b.entry.email || ''));
        ordered.push(...rows);
      });
    }

    const partnerGroups = new Map();
    partnerEntries.forEach((row) => {
      const name = row.entry.partner?.businessName || 'Partner';
      if (!partnerGroups.has(name)) partnerGroups.set(name, []);
      partnerGroups.get(name).push(row);
    });
    const sortedPartners = Array.from(partnerGroups.keys()).sort((a, b) => a.localeCompare(b));
    for (const partnerName of sortedPartners) {
      const rows = partnerGroups.get(partnerName);
      rows.sort((a, b) => (a.entry.customerName || a.entry.email || '')
        .localeCompare(b.entry.customerName || b.entry.email || ''));
      ordered.push(...rows);
    }

    return ordered;
  };

  const exportCustomerMacrosToExcel = async (dateKey) => {
    if (!dateKey) return;
    const deliverableRows = await getDeliverableRows(dateKey);
    if (!deliverableRows) return;
    const orderedEntries = buildKitchenPaperOrder(dateKey, deliverableRows);
    if (orderedEntries.length === 0) return;
    const XLSX = await loadXLSX();
    const rows = orderedEntries.flatMap(({ entry, dayMeals }) =>
      dayMeals.map((meal) => ({
        'Customer ID': entry.customerId || '',
        Name: entry.customerName || entry.email || 'Unknown',
        CPF: entry.cpf || '',
        'Meal Plan': entry.planName || '',
        // The customer's daily plan total (what their meals are split from),
        // repeated on each of their rows. Matter Core's "macros" are daily food
        // weights rather than macro grams, so those rows show the weights.
        'Total C': Math.round(Number(entry.macros?.C) || 0),
        'Total P': Math.round(Number(entry.macros?.P) || 0),
        'Total F': Math.round(Number(entry.macros?.F) || 0),
        Date: formatDateLabel(meal?.date),
        'Meal Name': meal.mealName || meal.menuItemName || 'Unnamed meal',
        C: Math.round(Number(meal.macros?.C) || 0),
        P: Math.round(Number(meal.macros?.P) || 0),
        F: Math.round(Number(meal.macros?.F) || 0),
        Calories: Math.round(Number(meal.macros?.calories) || 0)
      }))
    );
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Customer Macros');
    XLSX.writeFile(workbook, `kitchen-list-customer-macros-${dateKey}${planFileSuffix}.xlsx`);
  };

  // Excel version of the Day Kitchen Paper: one row per meal, in exactly the
  // PDF's order (buildKitchenPaperOrder), carrying everything the printed
  // sheet shows per customer — delivery time, plan line, exclusions, day note,
  // the meal's P/C/V weights, and the customer's total macros — so
  // the sheet can be filtered/sorted in Excel. Same customers as the PDF (no
  // Matter delivery that day = left out).
  const exportDayKitchenPaperToExcel = async (dateKey) => {
    if (!dateKey) return;
    const deliverableRows = await getDeliverableRows(dateKey);
    if (!deliverableRows) return;
    const orderedEntries = buildKitchenPaperOrder(dateKey, deliverableRows);
    if (orderedEntries.length === 0) return;
    const XLSX = await loadXLSX();
    const yesNo = (v) => (v === null || v === undefined ? 'N/A' : (v ? 'Yes' : 'No'));
    const rows = orderedEntries.flatMap(({ entry, dayMeals }) => {
      const dayNote = (entry.dayNotes || []).find((n) => n.date === dateKey)?.note || '';
      const section = entry.partner
        ? `Partner: ${entry.partner?.businessName || 'Partner'}`
        : `${paperEmirate(entry.deliveryAddress)} — ${formatDeliveryHourLabel(parseDeliveryHour(entry.deliveryWindow?.label))}`;
      const windowHour = parseDeliveryHour(entry.deliveryWindow?.label);
      const deliveryTime = windowHour === 999
        ? 'No delivery window'
        : (/^\s*by\b/i.test(String(entry.deliveryWindow?.label || '')) ? `By ${formatDeliveryHourLabel(windowHour)}` : formatDeliveryHourLabel(windowHour));
      return dayMeals.map((meal, index) => {
        const label = getMealLabel(meal);
        return {
          Section: section,
          'Delivery time': entry.partner ? '' : deliveryTime,
          Customer: entry.customerName || entry.email || 'Unknown customer',
          Plan: entry.planName || '',
          'Meals/day': entry.mealsPerDay ?? '',
          'Snacks/day': entry.snacksPerDay ?? '',
          'Breakfast included': yesNo(entry.breakfastIncluded),
          Exclusions: exclusionsText(entry),
          Address: entry.partner ? '' : formatAddress(entry.deliveryAddress),
          Type: label.mealType,
          Meal: label.mealName,
          Changes: kitchenMealChanges(meal),
          'P (g)': Number(meal.proteinWeight) || 0,
          'C (g)': Number(meal.carbWeight) || 0,
          'V (g)': Number(meal.vegWeight) || 0,
          'Total C': Math.round(Number(entry.macros?.C) || 0),
          'Total P': Math.round(Number(entry.macros?.P) || 0),
          'Total F': Math.round(Number(entry.macros?.F) || 0),
          Note: index === 0 ? dayNote : ''
        };
      });
    });
    const worksheet = XLSX.utils.json_to_sheet(rows);
    // Readable out of the box: sensible column widths and a filter on the header row.
    const widths = { Section: 24, 'Delivery time': 14, Customer: 28, Plan: 16, 'Meals/day': 9, 'Snacks/day': 10, 'Breakfast included': 11, Exclusions: 34, Address: 48, Type: 10, Meal: 44, 'P (g)': 7, 'C (g)': 7, 'V (g)': 7, 'Total C': 8, 'Total P': 8, 'Total F': 8, Note: 30 };
    const headers = Object.keys(rows[0] || {});
    worksheet['!cols'] = headers.map((h) => ({ wch: widths[h] || 12 }));
    worksheet['!autofilter'] = { ref: worksheet['!ref'] };
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Kitchen Paper');
    XLSX.writeFile(workbook, `kitchen-paper-${dateKey}${planFileSuffix}.xlsx`);
  };

  // Owner (2026-10-12): kitchen paper for ONE customer over a custom date range
  // (dates are the loaded menu's days). One page per delivery date; dates the
  // customer has no active Matter delivery for are left out and listed instead.
  const customerPaperOptions = useMemo(() => {
    const needle = customerPaperSearch.trim().toLowerCase();
    return allComputedRows
      .filter((entry) => (entry.selectedMeals || []).length > 0)
      .filter((entry) => !needle || `${entry.customerName || ''} ${entry.email || ''}`.toLowerCase().includes(needle))
      .sort((a, b) => (a.customerName || a.email || '').localeCompare(b.customerName || b.email || ''))
      .slice(0, 300);
  }, [allComputedRows, customerPaperSearch]);

  const runCustomerPaper = async (format) => {
    let entry = allComputedRows.find((row) => String(row.email || '').toLowerCase() === customerPaperEmail.toLowerCase());
    if (!entry) { setCustomerPaperMsg({ type: 'error', text: 'Pick a customer first.' }); return; }
    let fromKey = customerPaperFrom || menuDateKeys[0];
    let toKey = customerPaperTo || menuDateKeys[menuDateKeys.length - 1];
    if (fromKey > toKey) [fromKey, toKey] = [toKey, fromKey];
    setCustomerPaperBusy(true);
    setCustomerPaperMsg(null);
    try {
      if (loadingSelections || loadedSelectionScope !== `${selectedMenuId}:${missingCheckDate}`) throw new Error('Finish preparing the selected date before exporting.');
      const scope = activeSelectionScope.current;
      const dates = menuDateKeys.filter((day) => day >= fromKey && day <= toKey);
      const snapshot = await loadKitchenSnapshot(api, selectedMenuId, dates, () => activeSelectionScope.current === scope, applyKitchenOverrides);
      entry = snapshot.entries.find((row) => String(row.email || '').toLowerCase() === customerPaperEmail.toLowerCase());
      if (!entry) throw new Error('No confirmed meals for this customer in the chosen date range.');
      assertKitchenExportReady([entry]);
      const helpers = { getDateKey, formatDateLabel, getMealLabel, exclusionsText, formatAddress, parseDeliveryHour, formatDeliveryHourLabel, loadJsPDF, loadAutoTable };
      const result = format === 'word'
        ? downloadCustomerPaperWord({ entry, fromKey, toKey, helpers })
        : await downloadCustomerPaperPdf({ entry, fromKey, toKey, helpers });
      if (!result.ok) {
        setCustomerPaperMsg({ type: 'error', text: `Nothing to print: no meals${result.skipped.length ? ' with an active Matter delivery' : ''} for ${entry.customerName || entry.email} between ${formatDateLabel(fromKey)} and ${formatDateLabel(toKey)}.${result.skipped.length ? ` (No Matter delivery on: ${result.skipped.map((k) => formatDateLabel(k)).join(', ')}.)` : ''}` });
      } else {
        setCustomerPaperMsg({ type: 'ok', text: `Downloaded ${result.days.length} day(s) for ${entry.customerName || entry.email}.${result.skipped.length ? ` Left out (no active Matter delivery): ${result.skipped.map((k) => formatDateLabel(k)).join(', ')}.` : ''}` });
      }
    } catch (err) {
      setCustomerPaperMsg({ type: 'error', text: err?.message || 'Failed to create the customer paper.' });
    } finally {
      setCustomerPaperBusy(false);
    }
  };

  // Builds one jsPDF table per customer synchronously — for a date with
  // hundreds of deliveries, that used to run as one unbroken block with zero
  // feedback (no loading state at all) and no chance for the browser to
  // paint or process input in between, which is exactly the kind of
  // main-thread block that trips Chrome's hang detector on a busy day. Now
  // async: yields to the browser between each delivery-window group so a
  // large PDF builds without freezing the tab, and the button reflects
  // "Generating..." the whole time instead of the page just looking stuck.
  // Word version of the Day PDF — same sections (emirate → delivery window,
  // then Partners), same per-customer block (name + time tag, address/partner,
  // plan line, day note, meal table, total macros). Built as Word-flavoured
  // HTML saved as .doc, which Word opens natively and keeps the page breaks
  // per section — no extra dependency needed.
  const downloadDayKitchenPaperWord = async (dateKey) => {
    if (!dateKey) return;
    const dayLabel = formatDateLabel(dateKey);
    const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const orDash = (v) => (v === null || v === undefined || v === '' ? 'N/A' : v);
    const nameOf = (row) => row.entry.customerName || row.entry.email || '';

    const deliverableRows = await getDeliverableRows(dateKey);
    if (!deliverableRows) return;
    const entriesWithMeals = deliverableRows
      .filter((entry) => !paperPlan || entry.planName === paperPlan)
      .map((entry) => ({
        entry,
        dayMeals: (entry.selectedMeals || []).filter((meal) => getDateKey(meal?.date) === dateKey)
      }))
      .filter((row) => row.dayMeals.length > 0);
    const partnerEntries = entriesWithMeals.filter((row) => !!row.entry.partner);
    const regularEntries = entriesWithMeals.filter((row) => !row.entry.partner);

    // Running customer number, 1..N down the whole paper in print order (the
    // sections are built one after another in that order).
    let serialNo = 0;
    const customerBlock = ({ entry, dayMeals }, subLine) => {
      serialNo += 1;
      const windowHour = parseDeliveryHour(entry.deliveryWindow?.label);
      const hasWindow = windowHour !== 999;
      const windowHourLabel = formatDeliveryHourLabel(windowHour);
      const tagText = !hasWindow
        ? 'No delivery window'
        : (/^\s*by\b/i.test(String(entry.deliveryWindow?.label || '')) ? `By ${windowHourLabel}` : windowHourLabel);
      const breakfastLabel = entry.breakfastIncluded === null || entry.breakfastIncluded === undefined
        ? 'N/A'
        : (entry.breakfastIncluded ? 'Yes' : 'No');
      const dayNote = (entry.dayNotes || []).find((n) => n.date === dateKey)?.note;
      const rows = dayMeals.map((meal) => {
        const label = getMealLabel(meal);
        const isLarge = String(meal?.mealType || '').toLowerCase() === 'breakfast' && !!meal?.flags?.isLargeBreakfast;
        const largeTag = isLarge
          ? ' <span style="background:#6d28d9;color:#ffffff;font-size:10.5pt;font-weight:bold">&nbsp;LARGE&nbsp;</span>'
          : '';
        return `<tr><td>${esc(label.mealType)}</td><td>${esc(label.mealName)}${largeTag}${kitchenMealChanges(meal) ? `<br/><b>${esc(kitchenMealChanges(meal))}</b>` : ''}</td>`
          + `<td>${esc(meal.proteinWeight || 0)}g</td><td>${esc(meal.carbWeight || 0)}g</td><td>${esc(meal.vegWeight || 0)}g</td></tr>`;
      }).join('');
      // The whole customer block sits in ONE table row that Word may not split
      // across a page edge (page-break-inside:avoid on the row is how Word itself
      // writes "Allow row to break across pages" off). Paragraph keep-with-next
      // is not honoured when Word imports HTML, so this is what keeps a name
      // and its meals and totals on the same page.
      return `
        <table width="100%" border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin-top:6pt"><tr style="page-break-inside:avoid"><td style="padding-top:8pt">
          <p style="margin:0;font-size:14pt;page-break-after:avoid"><b>${serialNo}. ${esc(nameOf({ entry }) || 'Unknown customer')}</b>
            &nbsp;&nbsp;<span style="background:${hasWindow ? '#1e293b' : '#94a3b8'};color:#ffffff;font-size:10pt;font-weight:bold">&nbsp;${esc(tagText)}&nbsp;</span></p>
          <p style="margin:0;font-size:10.5pt;page-break-after:avoid">${esc(subLine)}</p>
          ${entry.noDeliveryDate === dateKey ? '<p style="margin:0;font-size:10.5pt;color:#be123c;page-break-after:avoid"><b>NO MATTER DELIVERY ON THIS DATE - confirm before cooking</b></p>' : ''}
          <p style="margin:0;font-size:10.5pt;page-break-after:avoid"><b>Plan: ${esc(entry.planName || 'N/A')} | Meals/day: ${esc(orDash(entry.mealsPerDay))} | Snacks/day: ${esc(orDash(entry.snacksPerDay))} | Breakfast included: ${breakfastLabel}</b></p>
          <p style="margin:0;font-size:10.5pt;color:#be123c;page-break-after:avoid"><b>Exclusions: ${esc(exclusionsText(entry))}</b></p>
          ${dayNote ? `<p style="margin:0;font-size:10.5pt;color:#b45309;page-break-after:avoid"><b>Note: ${esc(dayNote)}</b></p>` : ''}
          <table border="1" cellspacing="0" cellpadding="4" style="border-collapse:collapse;width:100%;font-size:10.5pt;margin-top:4pt">
            <tr style="background:#1e293b;color:#ffffff"><th>Type</th><th>Meal</th><th>P</th><th>C</th><th>V</th></tr>
            ${rows}
          </table>
          <p style="margin:4pt 0 0 0;font-size:12pt"><b>Total Macros: C ${entry.macros?.C || 0} / P ${entry.macros?.P || 0} / F ${entry.macros?.F || 0}</b></p>
        </td></tr></table>`;
    };

    const sections = [];
    const addSection = (kicker, heading, rows, subLineFor) => {
      // The page break goes on the section's FIRST PARAGRAPH only. Put on the
      // wrapping <div> instead, Word applies it to every paragraph and table
      // inside — each customer line landed on its own page (1,300+ pages).
      sections.push(`
        <div>
          <p style="margin:0;font-size:11pt;color:#787878;${sections.length > 0 ? 'page-break-before:always' : ''}">${esc(kicker)}</p>
          <h2 style="margin:4pt 0 0 0;font-size:15pt;background:#f1f5f9;padding:3pt">${esc(heading)}</h2>
          ${rows.map((row) => customerBlock(row, subLineFor(row))).join('')}
        </div>`);
    };

    const emirateGroups = new Map();
    regularEntries.forEach((row) => {
      const emirate = paperEmirate(row.entry.deliveryAddress);
      if (!emirateGroups.has(emirate)) emirateGroups.set(emirate, []);
      emirateGroups.get(emirate).push(row);
    });
    Array.from(emirateGroups.keys()).sort((a, b) => a.localeCompare(b)).forEach((emirate) => {
      const windowGroups = new Map();
      emirateGroups.get(emirate).forEach((row) => {
        const hourKey = parseDeliveryHour(row.entry.deliveryWindow?.label);
        if (!windowGroups.has(hourKey)) windowGroups.set(hourKey, []);
        windowGroups.get(hourKey).push(row);
      });
      Array.from(windowGroups.entries()).sort((a, b) => a[0] - b[0]).forEach(([hourKey, rows]) => {
        rows.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
        addSection(`${dayLabel} — ${emirate}`, formatDeliveryHourLabel(hourKey), rows,
          (row) => `Address: ${formatAddress(row.entry.deliveryAddress)}`);
      });
    });

    const partnerGroups = new Map();
    partnerEntries.forEach((row) => {
      const name = row.entry.partner?.businessName || 'Partner';
      if (!partnerGroups.has(name)) partnerGroups.set(name, []);
      partnerGroups.get(name).push(row);
    });
    Array.from(partnerGroups.keys()).sort((a, b) => a.localeCompare(b)).forEach((partnerName) => {
      const rows = partnerGroups.get(partnerName);
      rows.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
      addSection(`${dayLabel} — Partners`, partnerName, rows, () => `Partner: ${partnerName}`);
    });

    const body = sections.length > 0
      ? sections.join('')
      : '<p>No customers have meals selected for this date.</p>';
    const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>Kitchen Prep Sheet</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View></w:WordDocument></xml><![endif]-->
<style>
body{font-family:Arial,sans-serif} th,td{text-align:left;page-break-after:avoid} tr{page-break-inside:avoid}
@page WordSection1 { size:595.3pt 841.9pt; margin:54pt 54pt 60pt 54pt; mso-footer:f1; }
div.WordSection1 { page:WordSection1; }
p.MsoFooter { margin:0; font-size:8pt; color:#787878; text-align:right; }
</style></head>
<body>
<div class="WordSection1">
<h1 style="font-size:18pt;margin:0">Kitchen Prep Sheet — ${esc(dayLabel)}</h1>
<p style="font-size:10pt;color:#787878;margin:0">Generated: ${esc(new Date().toLocaleString())}</p>
${body}
</div>
<!-- Word reads this div as the page footer: "Page N of M" are live Word fields. -->
<div style="mso-element:footer" id="f1"><p class="MsoFooter" style="text-align:right">Kitchen Prep Sheet — ${esc(dayLabel)} &nbsp;|&nbsp; Page <span style="mso-field-code:' PAGE '"></span> of <span style="mso-field-code:' NUMPAGES '"></span></p></div>
</body></html>`;

    const blob = new Blob(['\uFEFF', html], { type: 'application/msword' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `kitchen-paper-${dateKey}${planFileSuffix}.doc`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const downloadDayKitchenPaper = async (dateKey) => {
    if (!dateKey || generatingPdf) return;
    setGeneratingPdf(true);
    // Let React actually paint the "Generating..." button state before the
    // heavy work starts — calling straight into jsPDF from the same tick as
    // setGeneratingPdf(true) would block before that state ever reaches the screen.
    await new Promise((resolve) => setTimeout(resolve, 0));

    try {
      const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
        loadJsPDF(),
        loadAutoTable()
      ]);
      const dayLabel = formatDateLabel(dateKey);
      const doc = new jsPDF();
      const pageHeight = doc.internal.pageSize.getHeight();
      const pageWidth = doc.internal.pageSize.getWidth();

      doc.setFontSize(17.5);
      doc.text(`Kitchen Prep Sheet — ${dayLabel}`, 14, 18);
      doc.setFontSize(10);
      doc.setTextColor(120);
      doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 24);
      doc.setTextColor(0);

      let cursorY = 32;
      // Running customer number, 1..N down the whole paper in print order.
      let serialNo = 0;

      // Group by delivery emirate first, then by delivery window within each
      // emirate — every (emirate, window) combination is its own physical
      // "paper": it always starts on a fresh page, never sharing a page with
      // a different window or a different emirate, even if there'd be room
      // left on the current page. A window with many customers can still
      // legitimately span several pages (the per-customer overflow check
      // below) — that's fine, it's still all the same paper/section; what
      // must never happen is a DIFFERENT window or emirate starting partway
      // down an existing page.
      // Renders one customer's name/address line + meal table + macro total,
      // starting at `startY` (paginating first if there isn't room) and
      // returning the cursorY to continue from. Shared by the regular
      // emirate/window sections and the Partners section below so both stay
      // in lockstep with any future formatting change.
      const renderCustomerBlock = (entry, dayMeals, startY, subLine) => {
        let y = startY;
        if (y > pageHeight - 62) {
          doc.addPage();
          y = 20;
        }

        // Delivery-time tag, right-aligned on the name line, on EVERY customer
        // (the section headings group by time, but a printed page often gets
        // split up and handed around — the tag keeps each customer's time on
        // their own block). Same parsed hour as the section heading, with the
        // "By" kept when Matter's window says "By 6 AM".
        const windowHour = parseDeliveryHour(entry.deliveryWindow?.label);
        const windowHourLabel = formatDeliveryHourLabel(windowHour);
        const hasWindow = windowHour !== 999;
        const tagText = !hasWindow
          ? 'No delivery window'
          : (/^\s*by\b/i.test(String(entry.deliveryWindow?.label || '')) ? `By ${windowHourLabel}` : windowHourLabel);
        doc.setFontSize(10);
        doc.setFont(undefined, 'bold');
        const tagWidth = doc.getTextWidth(tagText) + 6;
        const tagX = pageWidth - 14 - tagWidth;

        doc.setFontSize(14);
        // Keep a long name from running underneath the tag.
        serialNo += 1;
        const nameLine = doc.splitTextToSize(
          `${serialNo}. ${entry.customerName || entry.email || 'Unknown customer'}`,
          tagX - 14 - 3
        )[0];
        doc.text(nameLine, 14, y);

        doc.setFontSize(10);
        if (hasWindow) doc.setFillColor(30, 41, 59);
        else doc.setFillColor(148, 163, 184);
        doc.roundedRect(tagX, y - 5.5, tagWidth, 8, 1.5, 1.5, 'F');
        doc.setTextColor(255);
        doc.text(tagText, tagX + 3, y - 0.2);
        doc.setTextColor(0);
        doc.setFont(undefined, 'normal');
        y += 7;

        doc.setFontSize(10.5);
        doc.text(subLine, 14, y, { maxWidth: pageWidth - 28 });
        y += 5.6;

        if (entry.noDeliveryDate === dateKey) {
          doc.setFont(undefined, 'bold');
          doc.setTextColor(190, 18, 60);
          doc.text('NO MATTER DELIVERY ON THIS DATE - confirm before cooking', 14, y, { maxWidth: pageWidth - 28 });
          doc.setTextColor(0);
          doc.setFont(undefined, 'normal');
          y += 5.6;
        }

        // The customer's plan entitlement per day (not what they picked).
        const orDash = (v) => (v === null || v === undefined || v === '' ? 'N/A' : v);
        const breakfastLabel = entry.breakfastIncluded === null || entry.breakfastIncluded === undefined
          ? 'N/A'
          : (entry.breakfastIncluded ? 'Yes' : 'No');
        doc.setFont(undefined, 'bold');
        doc.text(
          `Plan: ${entry.planName || 'N/A'}  |  Meals/day: ${orDash(entry.mealsPerDay)}  |  Snacks/day: ${orDash(entry.snacksPerDay)}  |  Breakfast included: ${breakfastLabel}`,
          14,
          y,
          { maxWidth: pageWidth - 28 }
        );
        doc.setFont(undefined, 'normal');
        y += 5.6;

        // Food exclusions, in red so the kitchen can't miss them.
        const exclusionLines = doc.splitTextToSize(`Exclusions: ${exclusionsText(entry)}`, pageWidth - 28);
        doc.setFont(undefined, 'bold');
        doc.setTextColor(190, 18, 60);
        doc.text(exclusionLines, 14, y);
        doc.setTextColor(0);
        doc.setFont(undefined, 'normal');
        y += exclusionLines.length * 5.2 + 0.6;

        // Kitchen-only note for this specific delivery day, if one was
        // added on Kitchen List — printed right under the address so it's
        // impossible to miss, never shown to the customer anywhere else.
        const dayNote = (entry.dayNotes || []).find((n) => n.date === dateKey)?.note;
        if (dayNote) {
          doc.setFont(undefined, 'bold');
          doc.setTextColor(180, 83, 9);
          doc.text(`Note: ${dayNote}`, 14, y, { maxWidth: pageWidth - 28 });
          doc.setTextColor(0);
          doc.setFont(undefined, 'normal');
          y += 5.6;
        }

        // A breakfast served at the Large portion gets a LARGE tag on its row.
        const isLargeRow = dayMeals.map((meal) => String(meal?.mealType || '').toLowerCase() === 'breakfast' && !!meal?.flags?.isLargeBreakfast);
        const tableRows = dayMeals.map((meal, mealIndex) => {
          const label = getMealLabel(meal);
          return [
            label.mealType,
            `${label.mealName}${isLargeRow[mealIndex] ? '   [LARGE]' : ''}${kitchenMealChanges(meal) ? `\n${kitchenMealChanges(meal)}` : ''}`,
            `${meal.proteinWeight || 0}g`,
            `${meal.carbWeight || 0}g`,
            `${meal.vegWeight || 0}g`
          ];
        });

        autoTable(doc, {
          startY: y,
          head: [['Type', 'Meal', 'P', 'C', 'V']],
          body: tableRows,
          theme: 'grid',
          styles: { fontSize: 10.5, cellPadding: 2.2 },
          headStyles: { fillColor: [30, 41, 59] },
          didParseCell: (data) => {
            // Large breakfast: whole row in purple bold so it stands out.
            if (data.section === 'body' && isLargeRow[data.row.index] && data.column.index <= 1) {
              data.cell.styles.textColor = [109, 40, 217];
              data.cell.styles.fontStyle = 'bold';
            }
          },
          margin: { left: 14, right: 14 }
        });

        y = doc.lastAutoTable.finalY + 7;
        if (y > pageHeight - 20) {
          doc.addPage();
          y = 20;
        }

        doc.setFontSize(12);
        doc.setFont(undefined, 'bold');
        doc.text(
          `Total Macros: C ${entry.macros?.C || 0} / P ${entry.macros?.P || 0} / F ${entry.macros?.F || 0}`,
          14,
          y
        );
        doc.setFont(undefined, 'normal');
        return y + 10;
      };

      const deliverableRows = await getDeliverableRows(dateKey);
      if (!deliverableRows) return;
      const entriesWithMeals = deliverableRows
        .filter((entry) => !paperPlan || entry.planName === paperPlan)
        .map((entry) => ({
          entry,
          dayMeals: (entry.selectedMeals || []).filter((meal) => getDateKey(meal?.date) === dateKey)
        }))
        .filter((row) => row.dayMeals.length > 0);

      // Members of a menu-selection Partner (Customer.partner set) get their
      // own "Partners" section below, grouped by partner instead of delivery
      // emirate/window — they don't have an individual home delivery address.
      const partnerEntries = entriesWithMeals.filter((row) => !!row.entry.partner);
      const regularEntries = entriesWithMeals.filter((row) => !row.entry.partner);

      const emirateOf = (row) => paperEmirate(row.entry.deliveryAddress);

      const emirateGroups = new Map();
      regularEntries.forEach((row) => {
        const emirate = emirateOf(row);
        if (!emirateGroups.has(emirate)) emirateGroups.set(emirate, []);
        emirateGroups.get(emirate).push(row);
      });
      const sortedEmirates = Array.from(emirateGroups.keys()).sort((a, b) => a.localeCompare(b));

      let isFirstSection = true;

      for (const emirate of sortedEmirates) {
        // Keyed by parsed hour, not the raw delivery window string — two
        // windows that differ only by zone/area text but share the same
        // time must collapse into one paper, never split into two.
        const windowGroups = new Map();
        emirateGroups.get(emirate).forEach((row) => {
          const hourKey = parseDeliveryHour(row.entry.deliveryWindow?.label);
          if (!windowGroups.has(hourKey)) windowGroups.set(hourKey, []);
          windowGroups.get(hourKey).push(row);
        });

        const sortedWindows = Array.from(windowGroups.entries()).sort((a, b) => a[0] - b[0]);
        sortedWindows.forEach(([, rows]) => {
          rows.sort((a, b) => (a.entry.customerName || a.entry.email || '')
            .localeCompare(b.entry.customerName || b.entry.email || ''));
        });

        for (const [hourKey, rows] of sortedWindows) {
          const windowLabel = formatDeliveryHourLabel(hourKey);
          if (!isFirstSection) {
            doc.addPage();
            cursorY = 20;
          }
          isFirstSection = false;

          doc.setFontSize(11);
          doc.setTextColor(120);
          doc.text(`${dayLabel} — ${emirate}`, 14, cursorY);
          doc.setTextColor(0);
          cursorY += 8;

          doc.setFontSize(14.5);
          doc.setFont(undefined, 'bold');
          doc.setFillColor(241, 245, 249);
          doc.rect(14, cursorY - 5, pageWidth - 28, 8, 'F');
          doc.text(windowLabel, 16, cursorY);
          doc.setFont(undefined, 'normal');
          cursorY += 10;

          for (const { entry, dayMeals } of rows) {
            cursorY = renderCustomerBlock(entry, dayMeals, cursorY, `Address: ${formatAddress(entry.deliveryAddress)}`);
          }

          // Yield between delivery-window/emirate sections so a busy day
          // (many customers) never blocks the main thread in one unbroken stretch.
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }

      // ── Partners section — one fresh page per partner, never sharing a
      // page with the regular emirate/window sections above or another
      // partner, same "each section is its own paper" rule as above.
      if (partnerEntries.length > 0) {
        const partnerGroups = new Map();
        partnerEntries.forEach((row) => {
          const name = row.entry.partner?.businessName || 'Partner';
          if (!partnerGroups.has(name)) partnerGroups.set(name, []);
          partnerGroups.get(name).push(row);
        });
        const sortedPartners = Array.from(partnerGroups.keys()).sort((a, b) => a.localeCompare(b));

        for (const partnerName of sortedPartners) {
          const rows = partnerGroups.get(partnerName);
          rows.sort((a, b) => (a.entry.customerName || a.entry.email || '')
            .localeCompare(b.entry.customerName || b.entry.email || ''));

          if (!isFirstSection) {
            doc.addPage();
            cursorY = 20;
          }
          isFirstSection = false;

          doc.setFontSize(11);
          doc.setTextColor(120);
          doc.text(`${dayLabel} — Partners`, 14, cursorY);
          doc.setTextColor(0);
          cursorY += 8;

          doc.setFontSize(14.5);
          doc.setFont(undefined, 'bold');
          doc.setFillColor(241, 245, 249);
          doc.rect(14, cursorY - 5, pageWidth - 28, 8, 'F');
          doc.text(partnerName, 16, cursorY);
          doc.setFont(undefined, 'normal');
          cursorY += 10;

          for (const { entry, dayMeals } of rows) {
            cursorY = renderCustomerBlock(entry, dayMeals, cursorY, `Partner: ${partnerName}`);
          }

          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }

      if (entriesWithMeals.length === 0) {
        doc.setFontSize(12);
        doc.text('No customers have meals selected for this date.', 14, cursorY);
      }

      // Page numbers ("Page 3 of 76") on every page, added last so the total
      // is known — autoTable adds pages of its own while it lays tables out.
      const totalPages = doc.getNumberOfPages();
      for (let pageNo = 1; pageNo <= totalPages; pageNo += 1) {
        doc.setPage(pageNo);
        doc.setFontSize(8);
        doc.setFont(undefined, 'normal');
        doc.setTextColor(110);
        doc.text(`Kitchen Prep Sheet — ${dayLabel}`, 14, pageHeight - 7);
        doc.text(`Page ${pageNo} of ${totalPages}`, pageWidth - 14, pageHeight - 7, { align: 'right' });
        doc.setTextColor(0);
      }

      doc.save(`kitchen-paper-${dateKey}${planFileSuffix}.pdf`);
    } finally {
      setGeneratingPdf(false);
    }
  };

  return (
    <div className="kitchen-workspace">
      <div className="kitchen-workspace-inner">
        <KitchenWorkspaceHeader dateLabel={formatKitchenDay(missingCheckDate)}>
          <div className="kitchen-stepbar">
            <div className="kitchen-step"><span className="kitchen-step-number">01</span><div>
              <label htmlFor="kitchen-list-menu">Menu</label>
              <select id="kitchen-list-menu" value={selectedMenuId} onChange={(e) => { selectionRequests.current.cancel(); setLoadedSelectionScope(''); setMissingCheckDate(''); setPdfDate(''); setSelectedMenuId(e.target.value); }} className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm focus:border-slate-900 focus:outline-none">
                <option value="">Select a menu...</option>
                {menus.map((menu) => (
                  <option key={menu._id} value={menu._id}>{toSentenceCase(menu.title || menu.name) || 'Untitled menu'}</option>
                ))}
              </select></div></div>
            <div className="kitchen-step"><span className="kitchen-step-number">02</span><div><label htmlFor="kitchen-header-date">Date</label>
              <select id="kitchen-header-date" aria-label="Delivery date" value={missingCheckDate} disabled={!selectedMenuId} onChange={e => changeKitchenDate(e.target.value)}><option value="">Choose a date</option>{menuDateKeys.map(date => <option key={date} value={date}>{formatKitchenDay(date)}</option>)}</select>
            </div></div>
          </div>
          <button type="button" title="Reload selections and re-fetch nutrition data from the website" className="kitchen-reload" disabled={!selectedMenuId || !missingCheckDate || loadingSelections} onClick={() => { nutritionCacheRef.current.clear(); setDeliveryCheck(null); loadSelections(); }}><RefreshCw size={16} className={loadingSelections ? 'animate-spin' : ''} /></button>
          <button type="button" className="kitchen-download-trigger" aria-expanded={downloadsOpen} aria-controls="kitchen-downloads" disabled={!menuDateKeys.length} onClick={() => setDownloadsOpen(open => !open)}><Download size={16} /> Kitchen Paper <ChevronDown size={14} /></button>
        </KitchenWorkspaceHeader>
        <KitchenAutoScopeControl enabled={automaticScope.enabled} onChange={automaticScope.setEnabled} message={automaticScope.message} />
        {menuDateKeys.length > 0 && <details id="kitchen-downloads" className="kitchen-export-panel kitchen-paper-section" open={downloadsOpen}>
          <summary onClick={event => { event.preventDefault(); setDownloadsOpen(open => !open); }}><FileText size={18} /> Kitchen Paper <span className="kitchen-export-formats">PDF · Word · Excel</span></summary>
          <button type="button" className="kitchen-download-close" onClick={() => setDownloadsOpen(false)}>Close downloads</button>

          {menuDateKeys.length > 0 && (
            <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-white/10 pt-4">
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-300">Day kitchen paper</label>
                <select
                  value={pdfDate}
                  onChange={(e) => changeKitchenDate(e.target.value)}
                  className="rounded-xl border border-white/20 bg-white/10 px-3 py-2 text-sm text-white [&>option]:text-slate-900"
                >
                  <option value="">Select a date...</option>
                  {menuDateKeys.map((key) => (
                  <option key={key} value={key}>{formatKitchenDay(key)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-300">Meal plan</label>
                <select
                  value={paperPlan}
                  onChange={(e) => setPaperPlan(e.target.value)}
                  title="Applies to the Day PDF, Day Excel and Customer List export"
                  className="rounded-xl border border-white/20 bg-white/10 px-3 py-2 text-sm text-white [&>option]:text-slate-900"
                >
                  <option value="">All plans</option>
                  {planOptions.map((plan) => (
                    <option key={plan} value={plan}>{plan}</option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={() => runKitchenExport(() => downloadDayKitchenPaper(pdfDate))}
                disabled={!pdfDate || exportBusy || generatingPdf || loadingSelections || loadedSelectionScope !== `${selectedMenuId}:${pdfDate}`}
                className="inline-flex items-center gap-2 rounded-2xl bg-white/10 border border-white/20 px-4 py-2.5 text-sm font-medium hover:bg-white/20 disabled:opacity-50"
              >
                <FileText size={16} className={generatingPdf ? 'animate-pulse' : ''} /> {generatingPdf ? 'Generating...' : 'Download Day PDF'}
              </button>
              <button
                type="button"
                onClick={() => runKitchenExport(() => downloadDayKitchenPaperWord(pdfDate))}
                disabled={!pdfDate || exportBusy || loadingSelections || loadedSelectionScope !== `${selectedMenuId}:${pdfDate}`}
                title="Word version of the Day PDF — same sections, order and per-customer tables"
                className="inline-flex items-center gap-2 rounded-2xl bg-white/10 border border-white/20 px-4 py-2.5 text-sm font-medium hover:bg-white/20 disabled:opacity-50"
              >
                <FileText size={16} /> Download Day Word
              </button>
              <button
                type="button"
                onClick={() => runKitchenExport(() => exportDayKitchenPaperToExcel(pdfDate))}
                disabled={!pdfDate || exportBusy || loadingSelections || loadedSelectionScope !== `${selectedMenuId}:${pdfDate}`}
                title="Excel version of the Day PDF — one row per meal (emirate, delivery window, customer, plan, P/C/V weights, remark, day note), in the same order as the PDF"
                className="inline-flex items-center gap-2 rounded-2xl bg-white/10 border border-white/20 px-4 py-2.5 text-sm font-medium hover:bg-white/20 disabled:opacity-50"
              >
                <Download size={16} /> Download Day Excel
              </button>
              <button
                type="button"
                onClick={() => runKitchenExport(() => exportCustomerMacrosToExcel(pdfDate))}
                disabled={!pdfDate || exportBusy || loadingSelections || loadedSelectionScope !== `${selectedMenuId}:${pdfDate}`}
                title="Export customer ID, name, CPF, meal plan, the customer's total daily C/P/F, meal name, and that meal's C/P/F/calories — one row per meal, in the same customer/meal order as the Day PDF above"
                className="inline-flex items-center gap-2 rounded-2xl bg-white/10 border border-white/20 px-4 py-2.5 text-sm font-medium hover:bg-white/20 disabled:opacity-50"
              >
                <Download size={16} /> Export Customer List (Excel)
              </button>
              {exportBusy && <p role="status" className="w-full text-sm text-amber-200">Verifying Matter data and generating your download?</p>}
              {exportError && <p role="alert" className="w-full rounded-lg bg-red-950/50 p-3 text-sm text-red-100">{exportError}</p>}
              {paperExcluded && paperExcluded.dateKey === pdfDate && (
                <p
                  className="w-full text-xs text-amber-200"
                  title={paperExcluded.names.join(', ')}
                >
                  {paperExcluded.names.length === 0
                    ? 'Every customer with meals on this date has an active Matter delivery.'
                    : `Left out ${paperExcluded.names.length} customer(s) with meals saved but no active Matter delivery on this date: ${paperExcluded.names.slice(0, 8).join(', ')}${paperExcluded.names.length > 8 ? ', ...' : ''}`}
                </p>
              )}
              <div className="mt-1 flex w-full flex-wrap items-end gap-3 border-t border-white/10 pt-3">
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-300">Customer kitchen paper</label>
                  <input
                    type="text"
                    value={customerPaperSearch}
                    onChange={(e) => setCustomerPaperSearch(e.target.value)}
                    placeholder="Search a customer..."
                    className="w-44 rounded-xl border border-white/20 bg-white/10 px-3 py-2 text-sm text-white placeholder:text-slate-400"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-300">Customer</label>
                  <select
                    value={customerPaperEmail}
                    onChange={(e) => { setCustomerPaperEmail(e.target.value); setCustomerPaperMsg(null); }}
                    className="w-64 rounded-xl border border-white/20 bg-white/10 px-3 py-2 text-sm text-white [&>option]:text-slate-900"
                  >
                    <option value="">Select a customer...</option>
                    {customerPaperOptions.map((entry) => (
                      <option key={entry.email || entry.customerId} value={entry.email}>{entry.customerName || entry.email}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-300">From</label>
                  <select
                    value={customerPaperFrom || menuDateKeys[0] || ''}
                    onChange={(e) => setCustomerPaperFrom(e.target.value)}
                    className="rounded-xl border border-white/20 bg-white/10 px-3 py-2 text-sm text-white [&>option]:text-slate-900"
                  >
                    {menuDateKeys.map((key) => (
                      <option key={key} value={key}>{formatDateLabel(key)}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-300">To</label>
                  <select
                    value={customerPaperTo || menuDateKeys[menuDateKeys.length - 1] || ''}
                    onChange={(e) => setCustomerPaperTo(e.target.value)}
                    className="rounded-xl border border-white/20 bg-white/10 px-3 py-2 text-sm text-white [&>option]:text-slate-900"
                  >
                    {menuDateKeys.map((key) => (
                      <option key={key} value={key}>{formatDateLabel(key)}</option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  onClick={() => runCustomerPaper('pdf')}
                  disabled={!customerPaperEmail || customerPaperBusy || loadingSelections || loadedSelectionScope !== `${selectedMenuId}:${missingCheckDate}`}
                  title="One page per delivery date for this customer, between the From and To dates"
                  className="inline-flex items-center gap-2 rounded-2xl bg-white/10 border border-white/20 px-4 py-2.5 text-sm font-medium hover:bg-white/20 disabled:opacity-50"
                >
                  <FileText size={16} className={customerPaperBusy ? 'animate-pulse' : ''} /> {customerPaperBusy ? 'Generating...' : 'Customer PDF'}
                </button>
                <button
                  type="button"
                  onClick={() => runCustomerPaper('word')}
                  disabled={!customerPaperEmail || customerPaperBusy || loadingSelections || loadedSelectionScope !== `${selectedMenuId}:${missingCheckDate}`}
                  title="Word version of the customer's paper for the same dates"
                  className="inline-flex items-center gap-2 rounded-2xl bg-white/10 border border-white/20 px-4 py-2.5 text-sm font-medium hover:bg-white/20 disabled:opacity-50"
                >
                  <FileText size={16} /> Customer Word
                </button>
                {customerPaperMsg && (
                  <p className={`w-full text-xs ${customerPaperMsg.type === 'error' ? 'text-rose-300' : 'text-emerald-300'}`}>{customerPaperMsg.text}</p>
                )}
              </div>
              <button
                type="button"
                onClick={downloadMealRemarksTemplate}
                className="inline-flex items-center gap-2 rounded-2xl border border-white/20 bg-white/10 px-4 py-2.5 text-sm font-medium hover:bg-white/20"
              >
                <Download size={16} /> Remarks Template
              </button>
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-2xl bg-white/10 border border-white/20 px-4 py-2.5 text-sm font-medium hover:bg-white/20">
                <Upload size={16} className={uploadingMealRemarks ? 'animate-pulse' : ''} />
                {uploadingMealRemarks ? 'Uploading...' : 'Upload Meal Remarks'}
                <input
                  type="file"
                  accept=".csv,.xlsx,.xls"
                  onChange={handleMealRemarksUpload}
                  disabled={uploadingMealRemarks || !selectedMenuId}
                  className="hidden"
                />
              </label>
            </div>
          )}

          {mealRemarksUploadResult && (
            <p className="mt-3 text-xs text-slate-300 border-t border-white/10 pt-3">
              Meal remarks: flagged {mealRemarksUploadResult.mealsUpdated} meal(s) across {mealRemarksUploadResult.customersUpdated} customer(s).
              {mealRemarksUploadResult.unmatchedMeals > 0 && ` ${mealRemarksUploadResult.unmatchedMeals} row(s) matched a customer but no meal on that date/name.`}
              {mealRemarksUploadResult.skippedNoCustomer > 0 && ` ${mealRemarksUploadResult.skippedNoCustomer} row(s) skipped — customer not found (by email or name).`}
              {mealRemarksUploadResult.skippedAmbiguousName > 0 && ` ${mealRemarksUploadResult.skippedAmbiguousName} row(s) skipped — multiple customers share that name; add an Email column to disambiguate.`}
              {mealRemarksUploadResult.skippedInvalidRow > 0 && ` ${mealRemarksUploadResult.skippedInvalidRow} row(s) skipped — missing Date, Meal, Remark, or a Name/Email.`}
              {mealRemarksUploadResult.failedCustomers > 0 && ` ${mealRemarksUploadResult.failedCustomers} customer(s) failed to save — try again.`}
            </p>
          )}
          {downloadsOpen && <PartnerKitchenOrders date={missingCheckDate} />}
        </details>}



        {!missingCheckDate && !loadingMenus && <KitchenEmptyState hasMenu={!!selectedMenuId} />}
        {selectedMenu && missingCheckDate && !selectionWindow.canAutoAssign && <p role="status" className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">{selectionWindow.message}</p>}


        {menuDateKeys.length > 0 && (
          <div className="kitchen-panel kitchen-setup-panel">
            <div className="kitchen-setup-heading"><span>Auto-assign menu {missingCheckDate ? '· ' + formatDateLabel(missingCheckDate) : ''}</span>
              <button type="button" aria-expanded={setupOpen} aria-controls="kitchen-setup-content" onClick={() => setSetupOpen(open => !open)}>{setupOpen ? 'Hide setup' : 'Show setup'} {setupOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button>
              <button type="button" className="kitchen-button-primary" onClick={runAutoAssign} disabled={!selectionWindow.canAutoAssign || assigningAll || deliveryCheck?.dateKey !== missingCheckDate || autoAssignBlockedByMacros}>{assigningAll ? 'Assigning...' : 'Auto-Assign'}</button>
            </div>
            <div id="kitchen-setup-content" hidden={!setupOpen}>
            <h3 className="sr-only"><ChefHat size={19} />Missing Meal Selections</h3>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Date</label>
                <select
                  value={missingCheckDate}
                  onChange={(e) => changeKitchenDate(e.target.value)}
                  className="rounded-xl border border-slate-300 px-3 py-2 text-sm"
                >
                  <option value="">Select a date...</option>
                  {menuDateKeys.map((key) => (
                    <option key={key} value={key}>{formatDateLabel(key)}</option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={() => checkMissingSelections(missingCheckDate)}
                disabled={checkingMissing || !missingCheckDate}
                className="kitchen-button-blue inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold disabled:opacity-50"
              >
                <Search size={14} className={checkingMissing ? 'animate-pulse' : ''} />
                {checkingMissing ? 'Checking...' : 'Check Missing Selections'}
              </button>

            </div>
            {missingSelectionEntries.length > 0 && (
              <p className="mt-2 text-xs text-amber-600">
                {missingSelectionEntries.length} customer(s) have a delivery scheduled on {formatDateLabel(missingCheckDate)} but no meal selection yet.
              </p>
            )}

            <div className="mt-4 pt-4 border-t border-slate-100">
              <div className="flex flex-wrap items-start justify-between gap-3 mb-1">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Main Meal Rotation — {formatDateLabel(missingCheckDate)}
                </h4>
              </div>

              <div className="kitchen-rotation-board">
                <div>
                  <p className="text-xs font-semibold text-slate-600 mb-2">
                    Main Meals ({(mainMealOptionsByDate[missingCheckDate]?.mainMeals || []).length}/3)
                  </p>
                  <div className="space-y-2 mb-2">
                    {(mainMealOptionsByDate[missingCheckDate]?.mainMeals || []).map((meal, index) => (
                      <div key={`main-${meal.name}-${index}`} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-sm">
                        <div className="min-w-0">
                          <span className="font-medium text-slate-800">{index + 1}. {meal.name}</span>
                          <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-slate-200 text-slate-600 capitalize">{meal.type}</span>
                          {meal.exclusions?.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {meal.exclusions.map((ex) => (
                                <span key={ex} className="text-[10px] px-1.5 py-0.5 rounded-full bg-rose-50 text-rose-600">{ex}</span>
                              ))}
                            </div>
                          )}
                        </div>
                        <button type="button" onClick={() => removeMainMeal(index)} className="text-red-500 hover:text-red-700 flex-shrink-0 ml-2">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="text-xs font-semibold text-slate-600 mb-2">Sub Meals (fallback)</p>
                  <div className="space-y-2 mb-2">
                    {(mainMealOptionsByDate[missingCheckDate]?.subMeals || []).map((meal, index) => (
                      <div key={`sub-${meal.name}-${index}`} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-sm">
                        <div className="min-w-0">
                          <span className="font-medium text-slate-800">{meal.name}</span>
                          <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-slate-200 text-slate-600 capitalize">{meal.type}</span>
                          {meal.exclusions?.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {meal.exclusions.map((ex) => (
                                <span key={ex} className="text-[10px] px-1.5 py-0.5 rounded-full bg-rose-50 text-rose-600">{ex}</span>
                              ))}
                            </div>
                          )}
                        </div>
                        <button type="button" onClick={() => removeSubMeal(index)} className="text-red-500 hover:text-red-700 flex-shrink-0 ml-2">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="text-xs font-semibold text-slate-600 mb-2">
                    Breakfast — {formatDateLabel(missingCheckDate)}
                  </p>
                  <p className="text-[10px] text-slate-400 mb-2">
                    Only assigned to customers whose profile has "Breakfast Include" on — it replaces one of their main meal slots.
                  </p>
                  <div className="space-y-2 mb-2">
                    {(breakfastOptionsByDate[missingCheckDate] || []).length === 0 && (
                      <p className="text-sm text-slate-400">No breakfast options uploaded for this date.</p>
                    )}
                    {(breakfastOptionsByDate[missingCheckDate] || []).map((item, index) => {
                      const pKey = normalizeBreakfastKey(item.name);
                      const saved = breakfastPreset?.presetsByName?.[pKey];
                      if (presetEdit && presetEdit.kind === 'breakfast' && presetEdit.key === pKey) {
                        return renderPresetRow('breakfast', pKey, { breakfastName: item.name, ...(saved || {}) });
                      }
                      return (
                      <div key={`breakfast-${item.name}-${index}`} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-sm">
                        <div className="min-w-0">
                          <span className="font-medium text-slate-800">{item.name}</span>
                          {breakfastsMissingMacros.includes(String(item.name || '').trim()) && (
                            <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 font-semibold">No macros</span>
                          )}
                          {item.exclusions?.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {item.exclusions.map((ex) => (
                                <span key={ex} className="text-[10px] px-1.5 py-0.5 rounded-full bg-rose-50 text-rose-600">{ex}</span>
                              ))}
                            </div>
                          )}
                          {breakfastsMissingMacros.includes(String(item.name || '').trim()) && renderMissingMacrosForm('breakfast', String(item.name || '').trim())}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-slate-500 flex-shrink-0 ml-2">
                          <span>C {saved?.C ?? 0}</span>
                          <span>P {saved?.P ?? 0}</span>
                          <span>F {saved?.F ?? 0}</span>
                          <button
                            type="button"
                            title="Edit macros"
                            onClick={() => startPresetEdit('breakfast', pKey, { breakfastName: item.name, C: 0, P: 0, F: 0, V: 80, ...(saved || {}) })}
                            className="text-slate-500 hover:text-slate-900"
                          >
                            <Pencil size={14} />
                          </button>
                          <button type="button" onClick={() => removeBreakfastOption(index)} className="text-red-500 hover:text-red-700">
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                      );
                    })}
                  </div>
                </div>


                {['first', 'second'].map((pool) => (
                  <div key={pool}>
                    <p className="text-xs font-semibold text-slate-600 mb-2">
                      {pool === 'first' ? 'First Snack' : 'Second Snack'}
                    </p>
                    <div className="space-y-2 mb-2">
                      {(snackOptionsByDate[missingCheckDate]?.[pool] || []).length === 0 ? (
                        <p className="text-sm text-slate-400">No {pool === 'first' ? 'first' : 'second'} snack options uploaded for this date.</p>
                      ) : (
                        (snackOptionsByDate[missingCheckDate]?.[pool] || []).map((opt, index) => {
                          const pKey = normalizeBreakfastKey(opt.name);
                          const saved = snackPreset.presetsByName?.[pKey];
                          const shown = saved || opt;
                          if (presetEdit && presetEdit.kind === 'snack' && presetEdit.key === pKey) {
                            return renderPresetRow('snack', pKey, { snackName: opt.name, C: opt.C, P: opt.P, F: opt.F, ...(saved || {}) });
                          }
                          return (
                          <div key={`${pool}-${opt.name}-${index}`} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-sm">
                            <div className="min-w-0">
                              <span className="font-medium text-slate-800">{opt.name}</span>
                              {snacksMissingMacros.includes(String(opt.name || '').trim()) && (
                                <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 font-semibold">No macros</span>
                              )}
                              {opt.exclusions?.length > 0 && (
                                <div className="mt-1 flex flex-wrap gap-1">
                                  {opt.exclusions.map((ex) => (
                                    <span key={ex} className="text-[10px] px-1.5 py-0.5 rounded-full bg-rose-50 text-rose-600">{ex}</span>
                                  ))}
                                </div>
                              )}
                              {snacksMissingMacros.includes(String(opt.name || '').trim()) && renderMissingMacrosForm('snack', String(opt.name || '').trim())}
                            </div>
                            <div className="flex items-center gap-3 text-xs text-slate-500 flex-shrink-0">
                              <span>C {shown.C ?? 0}</span>
                              <span>P {shown.P ?? 0}</span>
                              <span>F {shown.F ?? 0}</span>
                              <button
                                type="button"
                                title="Edit macros"
                                onClick={() => startPresetEdit('snack', pKey, { snackName: opt.name, C: opt.C, P: opt.P, F: opt.F, ...(saved || {}) })}
                                className="text-slate-500 hover:text-slate-900"
                              >
                                <Pencil size={14} />
                              </button>
                              <button type="button" onClick={() => removeSnackOption(pool, index)} className="text-red-500 hover:text-red-700">
                                <Trash2 size={14} />
                              </button>
                            </div>
                          </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                ))}
              </div>

            </div>

<details className="kitchen-advanced"><summary>Matter Core setup</summary>                <div>
                  <p className="text-xs font-semibold text-slate-600 mb-2">
                    Matter Core Meals — {formatDateLabel(missingCheckDate)}
                  </p>
                  <p className="text-[10px] text-slate-400 mb-2">
                    For customers on the "Matter Core" plan only. No type or exclusion filtering — a customer needing
                    2 meals gets the 1st and 2nd meal below, in order. Their breakfast/snacks still use the 1st
                    breakfast option and 1st snack in each pool (never random) instead of these.
                  </p>
                  <div className="flex gap-2 mb-2">
                    <input
                      type="text"
                      value={matterCoreMealInput}
                      onChange={(e) => setMatterCoreMealInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addMatterCoreMeal(); } }}
                      placeholder="Meal name"
                      disabled={!missingCheckDate || savingMatterCoreMealOptions}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none disabled:opacity-50"
                    />
                    <button
                      type="button"
                      onClick={addMatterCoreMeal}
                      disabled={!missingCheckDate || !matterCoreMealInput.trim() || savingMatterCoreMealOptions}
                      className="flex-shrink-0 rounded-xl bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
                    >
                      Add
                    </button>
                  </div>
                  <div className="space-y-2 mb-2">
                    {(matterCoreMealOptionsByDate[missingCheckDate] || []).length === 0 && (
                      <p className="text-sm text-slate-400">No Matter Core meals added for this date.</p>
                    )}
                    {(matterCoreMealOptionsByDate[missingCheckDate] || []).map((meal, index) => (
                      <div key={`matter-core-${meal.name}-${index}`} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-sm">
                        <span className="font-medium text-slate-800">{index + 1}. {meal.name}</span>
                        <button type="button" onClick={() => removeMatterCoreMeal(index)} className="text-red-500 hover:text-red-700 flex-shrink-0 ml-2">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div></details>

<details className="kitchen-advanced"><summary>Breakfast & snack macro presets</summary>
            <div className="mt-6 pt-4 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setBreakfastMacrosOpen((open) => !open)}
                aria-expanded={breakfastMacrosOpen}
                className="flex w-full items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-left hover:bg-slate-100"
              >
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Breakfast Macros (PCF)
                  <span className="ml-2 font-normal normal-case tracking-normal text-slate-400">
                    {Object.keys(breakfastPreset?.presetsByName || {}).length} breakfasts
                  </span>
                </span>
                {breakfastMacrosOpen ? <ChevronUp size={16} className="text-slate-500" /> : <ChevronDown size={16} className="text-slate-500" />}
              </button>
              {breakfastMacrosOpen && (
                <div className="mt-3">
                  <p className="text-[11px] text-slate-400 mb-3">
                    Global, shared across all menus. Click the pencil to edit a breakfast's C / P / F, its weight (V, grams) and
                    whether it is a Large breakfast. Changes apply to every customer who gets that breakfast.
                  </p>
                  <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
                    {Object.keys(breakfastPreset?.presetsByName || {}).length === 0 && (
                      <p className="text-sm text-slate-400">No breakfast macros uploaded yet.</p>
                    )}
                    {Object.entries(breakfastPreset?.presetsByName || {}).map(([key, preset]) => (
                      renderPresetRow('breakfast', key, preset)
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="mt-6 pt-4 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setSnackMacrosOpen((open) => !open)}
                aria-expanded={snackMacrosOpen}
                className="flex w-full items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-left hover:bg-slate-100"
              >
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Snack Macros (PCF)
                  <span className="ml-2 font-normal normal-case tracking-normal text-slate-400">
                    {Object.keys(snackPreset.presetsByName || {}).length} snacks
                  </span>
                </span>
                {snackMacrosOpen ? <ChevronUp size={16} className="text-slate-500" /> : <ChevronDown size={16} className="text-slate-500" />}
              </button>
              {snackMacrosOpen && (
              <div className="mt-3">
              <p className="text-[11px] text-slate-400 mb-3">
                Global, not tied to a date or menu — each snack's own fixed macros, used directly (never divided by
                snacksPerDay) whenever that name is assigned to a customer. Falls back to the per-date Snack Rotation
                option's own C/P/F above when a name here doesn't match.
              </p>
              <div className="flex flex-wrap gap-2 mb-3">
                <input
                  type="text"
                  value={snackPresetForm.name}
                  onChange={(e) => setSnackPresetForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Snack name"
                  className="flex-1 min-w-[140px] rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
                />
                <input
                  type="number"
                  value={snackPresetForm.C}
                  onChange={(e) => setSnackPresetForm((f) => ({ ...f, C: e.target.value }))}
                  placeholder="C"
                  className="w-20 rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
                />
                <input
                  type="number"
                  value={snackPresetForm.P}
                  onChange={(e) => setSnackPresetForm((f) => ({ ...f, P: e.target.value }))}
                  placeholder="P"
                  className="w-20 rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
                />
                <input
                  type="number"
                  value={snackPresetForm.F}
                  onChange={(e) => setSnackPresetForm((f) => ({ ...f, F: e.target.value }))}
                  placeholder="F"
                  className="w-20 rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={addSnackPreset}
                  disabled={!snackPresetForm.name.trim() || savingSnackPreset}
                  className="rounded-xl bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
                >
                  Add
                </button>
              </div>
              <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
                {Object.keys(snackPreset.presetsByName || {}).length === 0 && (
                  <p className="text-sm text-slate-400">No snack macros uploaded yet.</p>
                )}
                {Object.entries(snackPreset.presetsByName || {}).map(([key, preset]) => (
                  renderPresetRow('snack', key, preset, () => removeSnackPreset(key))
                ))}
              </div>
              </div>
              )}
            </div>


</details>
            <div className="mt-6 pt-4 border-t border-slate-100">

              {autoAssignBlockedByMacros && (
                <div className="mt-2 rounded-lg bg-amber-50 p-2 text-[11px] text-amber-900 ring-1 ring-amber-300">
                  <p className="flex items-center gap-1 font-semibold"><AlertTriangle size={12} /> Auto-Assign is blocked — these have no macros yet:</p>
                  <p className="mt-1">
                    {[...breakfastsMissingMacros.map((n) => `Breakfast: ${n}`), ...snacksMissingMacros.map((n) => `Snack: ${n}`)].join(' · ')}
                  </p>
                  <p className="mt-1">Add their C / P / F in the flagged rows above (Breakfast and Snack Rotation) and it unblocks by itself.</p>
                </div>
              )}
              <p className="mt-1 text-[11px] text-slate-400">
                Fills main meals, breakfast (if the customer's profile has Breakfast Include on), and their full snack count — for every customer flagged missing on {formatDateLabel(missingCheckDate)} above. Everything stays within each option's own exclusion list.
              </p>
              {deliveryCheck?.dateKey !== missingCheckDate && (
                <p className="mt-1 text-[11px] text-slate-400">Run "Check Missing Selections" above first to load the customer list to assign.</p>
              )}

              {autoAssignResult && (
                <div className="mt-2 text-xs space-y-1">
                  {autoAssignResult.mainMeals && (
                    <p className="text-emerald-700">
                      Meals: assigned {autoAssignResult.mainMeals.assigned} main meal slot(s) and {autoAssignResult.mainMeals.assignedBreakfast || 0} breakfast(s) across {autoAssignResult.mainMeals.customersProcessed} customer(s).
                      {autoAssignResult.mainMeals.repeatedDish > 0 && ` ${autoAssignResult.mainMeals.repeatedDish} slot(s) got a repeated dish — the customer needed more meals than there are different dishes they can eat that day.`}
                      {autoAssignResult.mainMeals.assignedWithExclusionConflict > 0 && ` ${autoAssignResult.mainMeals.assignedWithExclusionConflict} slot(s) got a dish that clashes with the customer's exclusions (every dish that day did) — flagged "Needs attention", swap before it goes out.`}
                      {autoAssignResult.mainMeals.skippedNoOption > 0 && ` ${autoAssignResult.mainMeals.skippedNoOption} slot(s) skipped — no dishes set up for this date${autoAssignResult.mainMeals.skippedCustomers?.length ? ` (${autoAssignResult.mainMeals.skippedCustomers.join(', ')})` : ''}.`}
                      {autoAssignResult.mainMeals.skippedBreakfastNoOption > 0 && ` ${autoAssignResult.mainMeals.skippedBreakfastNoOption} breakfast(s) skipped — no eligible breakfast option (check exclusions).`}
                      {autoAssignResult.mainMeals.skippedAlreadyAssigned > 0 && ` ${autoAssignResult.mainMeals.skippedAlreadyAssigned} customer(s) already had enough main meals.`}
                    </p>
                  )}
                  {autoAssignResult.snacks && (
                    <p className={autoAssignResult.snacks.assigned > 0 ? 'text-emerald-700' : 'text-amber-700'}>
                      Snacks: assigned {autoAssignResult.snacks.assigned} snack slot(s) across {autoAssignResult.snacks.customersProcessed} customer(s) checked.
                      {autoAssignResult.snacks.skippedNoSnacksNeeded > 0 && ` ${autoAssignResult.snacks.skippedNoSnacksNeeded} customer(s) skipped — no snacks in their website subscription.`}
                      {autoAssignResult.snacks.skippedNoOptions > 0 && ` ${autoAssignResult.snacks.skippedNoOptions} slot(s) skipped — no eligible snack options for this date.`}
                    </p>
                  )}
                  {autoAssignResult.selectedSnacks && (
                    <p className="text-emerald-700">
                      Customers with their own selection: added {autoAssignResult.selectedSnacks.assigned} missing snack(s) across {autoAssignResult.selectedSnacks.customersProcessed} customer(s) checked.
                    </p>
                  )}
                  {autoAssignResult.matterCore && (
                    <p className="text-emerald-700">
                      Matter Core: assigned {autoAssignResult.matterCore.assignedMainMeals} main meal(s), {autoAssignResult.matterCore.assignedBreakfast || 0} breakfast(s) and {autoAssignResult.matterCore.assignedSnacks || 0} snack(s) across {autoAssignResult.matterCore.customersProcessed} customer(s).
                      {autoAssignResult.matterCore.skippedNoOption > 0 && ` ${autoAssignResult.matterCore.skippedNoOption} meal slot(s) skipped — not enough Matter Core meals for this date.`}
                      {autoAssignResult.matterCore.skippedBreakfastNoOption > 0 && ` ${autoAssignResult.matterCore.skippedBreakfastNoOption} breakfast(s) skipped — no breakfast option for this date.`}
                    </p>
                  )}
                </div>
              )}
            </div>
            </div>
          </div>
        )}

        {error && <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}

        {(loadingMenus || loadingSelections) && (
          <div className="flex items-center gap-3 rounded-2xl bg-white p-6 text-slate-600 shadow-sm ring-1 ring-slate-200">
            <Loader className="animate-spin" size={18} /> Loading kitchen list...
          </div>
        )}


        <div className="space-y-4">
          {missingCheckDate && <div className="kitchen-section-heading"><UtensilsCrossed size={19} /> Customer preparation <small>{customerRows.length} matching records</small></div>}
          <KitchenInputWarnings entries={scheduledCustomerRows} selectedDate={missingCheckDate} onShowCustomer={(entry) => {
            setSearchInput(entry.email || entry.customerName || '');
            setSearch(entry.email || entry.customerName || '');
            setPlanFilter('');
            setShowOnlyMissing(false);
            setShowOnlyAttention(false);
          }} />
          <KitchenCustomerBrowser entries={customerRows} visibleCount={visibleCustomers} scope={selectedMenuId + ':' + missingCheckDate}
          controls={<div className="kitchen-search-controls">
            <label htmlFor="kitchen-customer-search" className="mb-2 block text-sm font-semibold text-slate-700">Search</label>
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input id="kitchen-customer-search" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Customer or email" className="w-full rounded-xl border border-slate-300 py-3 pl-9 pr-3 text-sm" />
            </div>
            <div className="kitchen-filter-tabs" role="group" aria-label="Customer status filter">
              <button type="button" aria-pressed={!showOnlyMissing && !showOnlyAttention} onClick={() => { setShowOnlyMissing(false); setShowOnlyAttention(false); }}>All</button>
              <button type="button" aria-pressed={showOnlyMissing && !showOnlyAttention} onClick={() => { setShowOnlyMissing(true); setShowOnlyAttention(false); }}>Missing</button>
              <button type="button" aria-pressed={showOnlyAttention} onClick={() => { setShowOnlyMissing(false); setShowOnlyAttention(true); }}>Needs attention</button>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <select
                value={planFilter}
                aria-label="Filter customers by meal plan"
                onChange={(e) => setPlanFilter(e.target.value)}
                className="rounded-xl border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="">All plans</option>
                {planOptions.map((plan) => (
                  <option key={plan} value={plan}>{plan}</option>
                ))}
              </select>
            </div>
          </div>}
          onShowMore={() => setVisibleCustomers(count => count + 50)}
          renderCustomer={entry => <CustomerCard key={entry.email || entry.customerId} entry={entry} persistMealTypeOverride={persistMealTypeOverride}
            saveMealRemark={saveMealRemark} savingOverrideKey={savingOverrideKey} saveDayNote={saveDayNote} savingDayNoteKey={savingDayNoteKey} snackPreset={snackPreset} />}
        />
        </div>

        {!error && !loadingMenus && !loadingSelections && missingCheckDate && loadedSelectionScope === `${selectedMenuId}:${missingCheckDate}` && customerRows.length === 0 && (
          <div className="rounded-3xl border border-dashed border-slate-300 bg-white p-10 text-center text-slate-500 shadow-sm">
            {scheduledCustomerRows.length ? 'No customers match the current filters.' : `No active customer deliveries or partner assignments for ${formatKitchenDay(missingCheckDate)}.`}
          </div>
        )}
      </div>
    </div>
  );
};

// Wrapped in React.memo, receiving stable (useCallback'd) function props from
// KitchenList, so typing in one customer's day-note field or changing their
// protein-type dropdown only re-renders that one card — not the full list of
// customer cards on every keystroke. Day-note draft text lives as LOCAL state
// here (keyed by date only, since email is fixed per card instance) instead
// of a shared object in the parent, which is what made every card re-render
// together before.
const CustomerCard = React.memo(({ entry, persistMealTypeOverride, saveMealRemark, savingOverrideKey, saveDayNote, savingDayNoteKey, snackPreset }) => {
  const [localDayNoteDrafts, setLocalDayNoteDrafts] = useState({});
  // Each day's full meal grid starts collapsed — with a realistic customer
  // count (hundreds), rendering every day's meal detail for every customer
  // at once put tens of thousands of DOM nodes (10,500+ <select> elements
  // alone, measured with 300 customers on a 7-day menu) on screen
  // simultaneously, which is what made search typing, toggling filters, and
  // editing a single field take 1-12 seconds — the browser wasn't crashing,
  // it was just reconciling a huge tree on every keystroke. Collapsing to a
  // one-line summary per day (expand on demand) cuts the always-rendered
  // DOM by roughly the number of days on the menu.
  const [expandedDays, setExpandedDays] = useState(() => Object.fromEntries((entry.mealsByDay || []).map(day => [day.dateKey, true])));

  return (
    <div
      className={`kitchen-customer overflow-hidden bg-white ${entry.missingSelection ? 'ring-1 ring-amber-300' : ''}`}
    >
      <div className="kitchen-customer-header flex flex-col gap-4 border-b border-slate-100 p-5">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-lg font-bold text-slate-900">{entry.customerName || entry.email || 'Unknown customer'}</h2>
            {entry.planName && (
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">
                {entry.planName}
              </span>
            )}
            {entry.kitchenProductionExcluded && <span className="text-xs text-slate-500">Not scheduled for {formatDateLabel(entry.kitchenExclusionDate)}</span>}
            {entry.missingSelection && (
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
                No Meal Selection — {formatDateLabel(entry.missingSelectionDate)}
              </span>
            )}
            {entry.noDeliveryDate && (
              <span
                title="This customer has meals on this date, but Matter shows no delivery for them that day (paused, not in their schedule, or subscription not started). Confirm before cooking."
                className="text-xs font-semibold px-2 py-0.5 rounded-full bg-rose-100 text-rose-700"
              >
                No Matter delivery — {formatDateLabel(entry.noDeliveryDate)}
              </span>
            )}
            {entry.hasMacroShortfall && (
              <span
                title="Even with a large breakfast, at least one day's meals hit the 65g protein / 75g carb per-meal cap and couldn't reach this customer's full daily macro target."
                className="text-xs font-semibold px-2 py-0.5 rounded-full bg-rose-100 text-rose-700"
              >
                Macro Shortfall
              </span>
            )}
            {entry.hasMatterCoreLookupIssue && (
              <span
                title="This customer's per-meal carb/protein weight (total weight ÷ meals that day) doesn't match a known Matter Core weight-to-macro combination — at least one meal was left at 0 macros and needs a manual fix."
                className="text-xs font-semibold px-2 py-0.5 rounded-full bg-rose-100 text-rose-700"
              >
                Matter Core Lookup Missing
              </span>
            )}
          </div>
          <p className="text-sm text-slate-500">
            {entry.matterEmail || 'Matter email unavailable'} • {entry.mealCount} meal(s) selected • Meal frequency: {entry.mealsPerDay ?? '—'}/day
          </p>
          {entry.dietaryRestrictions?.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Dietary:</span>
              {entry.dietaryRestrictions.map((tag) => (
                <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded-full bg-rose-50 text-rose-600">{tag}</span>
              ))}
            </div>
          )}
        </div>
        {!entry.showMissingPlaceholder && (
          <div className="kitchen-customer-metrics grid grid-cols-2 gap-2 text-sm md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Meals/Day" value={entry.mealsPerDay ?? '—'} />
            <Stat label="Total weight" value={entry.kitchenProductionExcluded ? 'Not scheduled' : entry.calculationStatus === 'incomplete' ? 'Unavailable' : `${entry.totalWeight || 0} g`} />
            <Stat label="Breakfast" value={`${entry.breakfastPreset?.V || 0} g`} />
            <Stat label="Macros" value={entry.calculationStatus === 'incomplete' ? 'Not calculated' : `C ${entry.macros?.C || 0} / P ${entry.macros?.P || 0} / F ${entry.macros?.F || 0}`} />
            <Stat label="Calories" value={entry.calculationStatus === 'incomplete' ? 'Not calculated' : `${entry.totalCalories || 0}`} />
            <Stat label="Snacks/Day" value={entry.snacksPerDay ?? '—'} />
          </div>
        )}
      </div>
      {entry.calculationStatus === 'incomplete' && <div className="kitchen-customer-unavailable" role="note">
        {entry.kitchenProductionExcluded ? <><strong>No active delivery for {formatDateLabel(entry.kitchenExclusionDate)}.</strong><p>Saved choices are shown for reference. This customer is excluded from the kitchen paper and counting for this date.</p></> : <><strong>Weights cannot be calculated until these inputs are resolved:</strong><ul>{(entry.inputErrors || []).map(reason => <li key={reason}>{reason}</li>)}</ul></>}
      </div>}
      {entry.showMissingPlaceholder ? (
        <div className="p-5">
          <p className="text-sm text-amber-700">
            This customer has a delivery scheduled on {formatDateLabel(entry.missingSelectionDate)} but hasn't selected any meals yet.
          </p>
        </div>
      ) : (
      <div className="space-y-5 p-5">
        {entry.missingSelection && (
          <p className="text-sm text-amber-700">
            Also has a delivery scheduled on {formatDateLabel(entry.missingSelectionDate)} with no meal selected yet.
          </p>
        )}
        {(entry.mealsByDay || []).map((dayGroup) => {
          const noteDraftKey = `${entry.email}::${dayGroup.dateKey}`;
          const savedNote = (entry.dayNotes || []).find((n) => n.date === dayGroup.dateKey)?.note || '';
          const noteValue = localDayNoteDrafts[dayGroup.dateKey] ?? savedNote;
          const isExpanded = !!expandedDays[dayGroup.dateKey];
          const dayAttentionNotes = dayGroup.meals.flatMap((meal) => {
            const label = getMealLabel(meal).mealName || getMealLabel(meal).mealType;
            return getAttentionReasons(meal).map((reason) => `${label}: ${reason}`);
          });
          const dayNeedsAttention = dayAttentionNotes.length > 0;
          return (
          <div key={`${entry.email || entry.customerId}-${dayGroup.dateKey}`} className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setExpandedDays((prev) => ({ ...prev, [dayGroup.dateKey]: !prev[dayGroup.dateKey] }))}
                className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-600 hover:bg-slate-200"
              >
                {dayGroup.dateLabel}
                {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>
              <span className="text-xs text-slate-400">{dayGroup.meals.length} meal(s)</span>
              {dayNeedsAttention && (
                <span
                  title="At least one meal this day needs kitchen attention (remark, sauce/garnish swap, cap, or large-breakfast upgrade)"
                  className="inline-flex items-center gap-1 rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-orange-700"
                >
                  <AlertTriangle size={12} /> Needs attention
                </span>
              )}
              <input
                type="text"
                value={noteValue}
                onChange={(e) => setLocalDayNoteDrafts((prev) => ({ ...prev, [dayGroup.dateKey]: e.target.value }))}
                onBlur={(e) => saveDayNote(entry, dayGroup.dateKey, e.target.value)}
                placeholder="Add a note for this day (kitchen only)..."
                disabled={savingDayNoteKey === noteDraftKey}
                title="Visible only in Kitchen List and printed on the Day Kitchen Paper — never shown to the customer"
                className="min-w-[220px] flex-1 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-600 focus:border-slate-400 focus:outline-none disabled:opacity-50"
              />
            </div>
            {dayNeedsAttention && (
              <ul className="space-y-1 rounded-xl border border-orange-200 bg-orange-50 px-3 py-2 text-xs text-orange-800">
                {dayAttentionNotes.map((note, i) => (
                  <li key={i}>• {note}</li>
                ))}
              </ul>
            )}
            {isExpanded && (
            <div className="kitchen-meal-list">
              {dayGroup.meals.map((meal, index) => {
                const savedSnackMacros = meal.flags?.invalidInput && String(meal.mealType).toLowerCase() === 'snack'
                  ? resolveSnackPresetForMeal(meal, snackPreset?.presetsByName || {}) : null;
                return (
                <div key={`${entry.email}-${dayGroup.dateKey}-${index}`} className="kitchen-meal p-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <UtensilsCrossed size={16} className="text-amber-600" />
                      <span className="text-sm font-semibold text-slate-900">{getMealLabel(meal).mealType}</span>
                    </div>
                    <span className="text-xs font-semibold text-slate-500">#{index + 1}</span>
                  </div>
                  <div className="mt-2 flex items-center gap-2 text-sm font-medium text-slate-700">
                    <span className="truncate">{getMealLabel(meal).mealName}</span>
                    {meal?.isAutoAssigned && (
                      <span
                        title="Filled in by kitchen auto-assign — not chosen by the customer, and never shown in their menu selection preview"
                        className="flex-shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700"
                      >
                        Auto
                      </span>
                    )}
                    {meal?.flags?.macroCapped && (
                      <span
                        title="This meal's protein/carbs hit the 65g protein / 75g carb per-meal cap and was held there instead of following its full proportional share"
                        className="flex-shrink-0 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-700"
                      >
                        Capped
                      </span>
                    )}
                    {meal?.flags?.autoUpgradedToLarge && (
                      <span
                        title="Auto-upgraded to a large breakfast (fixed at 150g protein / 200g carb / 0g fat) to make up for other meals hitting the per-meal cap"
                        className="flex-shrink-0 rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-purple-700"
                      >
                        Large
                      </span>
                    )}
                    {meal?.needsSauceChange && (
                      <span
                        title={`Sauce hits a customer exclusion (${(meal.sauceConflict || []).join(', ') || 'unspecified'}) — never shown to the customer, swap it before this goes out`}
                        className="flex-shrink-0 rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-orange-700"
                      >
                        Change sauce
                      </span>
                    )}
                    {meal?.needsGarnishChange && (
                      <span
                        title={`Garnish hits a customer exclusion (${(meal.garnishConflict || []).join(', ') || 'unspecified'}) — never shown to the customer, swap it before this goes out`}
                        className="flex-shrink-0 rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-orange-700"
                      >
                        Change garnish
                      </span>
                    )}
                    {meal?.exclusionConflict?.length > 0 && (
                      <span
                        title={`Every dish that day clashed with this customer's exclusions, so auto-assign gave the closest one — contains ${meal.exclusionConflict.join(', ')}. Swap before it goes out.`}
                        className="flex-shrink-0 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-700"
                      >
                        Excluded: {meal.exclusionConflict.join(', ')}
                      </span>
                    )}
                    {meal?.remark && (
                      <span
                        title="Manually flagged via Kitchen List's Upload Meal Remarks — swap this before it goes out"
                        className="flex-shrink-0 rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-orange-700"
                      >
                        Change {meal.remark}
                      </span>
                    )}
                  </div>
                  {String(meal?.mealType || '').toLowerCase() !== 'breakfast' && (
                    <div className="kitchen-meal-protein mt-2">
                      <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Protein Type</label>
                      <select
                        value={meal.manualProteinType || ''}
                        onChange={(e) => persistMealTypeOverride({ entry, meal, index, value: e.target.value })}
                        className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
                      >
                        <option value="">Auto detect (from meal name)</option>
                        <option value="chicken">Chicken</option>
                        <option value="beef">Beef</option>
                        <option value="fish">Fish</option>
                      </select>
                      <p className="mt-1 text-[11px] text-slate-500">
                        Auto detect looks for keywords in meal name/protein choice: chicken, beef, fish.
                      </p>
                      {(!meal.manualProteinType || meal.manualProteinType === '') && (
                        <p className="mt-1 text-[11px] font-semibold text-amber-700">
                          Detected type: {detectProteinType(meal)}
                        </p>
                      )}
                      {savingOverrideKey === (meal?._overrideKey || buildMealOverrideKey(entry, meal, index)) && (
                        <p className="mt-1 text-xs text-slate-500">Saving...</p>
                      )}
                    </div>
                  )}
                  {String(meal?.mealType || '').toLowerCase() !== 'snack' && (
                    <div className="kitchen-meal-changes mt-2">
                      <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Change (shows on kitchen paper)</label>
                      <div className="flex flex-wrap gap-x-4 gap-y-1">
                        {REMARK_CHANGE_OPTIONS.map((option) => {
                          const { checked, extras } = parseRemarkParts(meal?.remark);
                          return (
                            <label key={option.key} className="inline-flex items-center gap-1.5 text-sm text-slate-700">
                              <input
                                type="checkbox"
                                checked={checked.includes(option.key)}
                                onChange={(e) => {
                                  const next = e.target.checked
                                    ? [...checked, option.key]
                                    : checked.filter((k) => k !== option.key);
                                  saveMealRemark({ entry, meal, remark: buildRemarkFromParts(next, extras) });
                                }}
                              />
                              {option.label}
                            </label>
                          );
                        })}
                      </div>
                      {savingOverrideKey === `remark:${meal?._overrideKey || buildMealOverrideKey(entry, meal, index)}` && (
                        <p className="mt-1 text-xs text-slate-500">Saving...</p>
                      )}
                    </div>
                  )}
                  <div className="kitchen-meal-macros mt-3 grid grid-cols-3 gap-2 text-xs">
                    {savedSnackMacros && <p className="col-span-3 text-xs text-slate-500">Saved snack preset · not a delivery calculation</p>}
                    <Tiny label="C" value={savedSnackMacros?.C ?? (meal.flags?.invalidInput ? 'Unavailable' : (meal.macros?.C ?? 0))} />
                    <Tiny label="P" value={savedSnackMacros?.P ?? (meal.flags?.invalidInput ? 'Unavailable' : (meal.macros?.P ?? 0))} />
                    <Tiny label="F" value={savedSnackMacros?.F ?? (meal.flags?.invalidInput ? 'Unavailable' : (meal.macros?.F ?? 0))} />
                  </div>
                  <div className="kitchen-meal-total mt-3 flex items-center justify-between text-sm text-slate-600">
                    <span>Weight</span>
                    <span className="font-semibold text-slate-900">{meal.flags?.invalidInput ? 'Unavailable' : `${meal.weight || 0} g`}</span>
                  </div>
                  <div className="kitchen-meal-weights mt-2 grid grid-cols-3 gap-2 text-xs">
                    <Tiny label="P" value={meal.flags?.invalidInput ? 'Unavailable' : `${meal.proteinWeight || 0}g`} />
                    <Tiny label="C" value={meal.flags?.invalidInput ? 'Unavailable' : `${meal.carbWeight || 0}g`} />
                    <Tiny label="V" value={meal.flags?.invalidInput ? 'Unavailable' : `${meal.vegWeight || 0}g`} />
                  </div>
                  <div className="kitchen-meal-calories mt-1 flex items-center justify-between text-sm text-slate-600">
                    <span>Calories</span>
                    <span className="font-semibold text-slate-900">{meal.flags?.invalidInput ? 'Unavailable' : (meal.macros?.calories || 0)}</span>
                  </div>
                </div>
              ); })}
            </div>
            )}
          </div>
          );
        })}
      </div>
      )}
    </div>
  );
});

// Kitchen staff pick a Partner → one of its members (Customers linked via
// Customer.partner) → a date → that date's dishes with quantities. Partner
// members get fixed Lean macros (C35 P30 F15 per main meal) in the
// calculation, and print under the kitchen paper's "Partners" section.
const Stat = ({ label, value }) => (
  <div className="kitchen-stat px-3 py-2">
    <div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div>
    <div className="mt-1 text-sm font-semibold text-slate-800">{value}</div>
  </div>
);

const Tiny = ({ label, value }) => (
  <div className="rounded-xl bg-white px-2 py-2 text-center ring-1 ring-slate-200">
    <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
    <div className="text-sm font-semibold text-slate-800">{value}</div>
  </div>
);

export default KitchenList;
