import { prepareKitchenSelections, createKitchenRequestGuard, assertKitchenExportReady } from '../utils/kitchenIntegrity';
import { assertKitchenRosterCovered, verifiedKitchenRoster, hasKitchenDeliveryOnDate } from '../lib/kitchenSnapshot';
import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { ChefHat, Download, Loader, RefreshCw } from 'lucide-react';
// xlsx is only needed once a staff member clicks an export button — loaded
// on first use and memoized instead of shipping it in the app's shared
// bundle for every page/route (see KitchenList.js for the same pattern).
let xlsxModulePromise = null;
const loadXLSX = () => {
  if (!xlsxModulePromise) xlsxModulePromise = import('xlsx');
  return xlsxModulePromise;
};
import api from '../utils/api';
import PartnerKitchenOrders from '../components/PartnerKitchenOrders';
import { calculateKitchenListEntry } from '../utils/kitchenListCalculations';
import { toSentenceCase } from '../utils/textFormat';
import {
  getDateKey,
  formatDateLabel,
  fetchBreakfastPresets,
  fetchSnackPresets,
  getCustomerName,
  enrichSelectionsWithNutrition,
  deriveDateKeys
} from '../lib/kitchenData';

const CATEGORY_LABEL = { breakfast: 'Breakfast', meal: 'Meal', snack: 'Snack' };
const CATEGORY_ORDER = { breakfast: 0, meal: 1, snack: 2 };

// Owner (2026-10-09): a breakfast tagged Large (auto-upgraded, or a large preset)
// is counted on its own row, apart from the normal breakfast of the same name
// — it is cooked at a bigger portion, so the two must not be summed together.
const countingMealName = (meal) => {
  const base = meal.mealName || meal.menuItemName || 'Unnamed meal';
  return meal.category === 'breakfast' && meal.flags?.isLargeBreakfast ? `${base} (LARGE)` : base;
};

const KitchenCounting = () => {
  const [menus, setMenus] = useState([]);
  const [loadingMenus, setLoadingMenus] = useState(false);
  const [selectedMenuId, setSelectedMenuId] = useState('');
  const [selectedDate, setSelectedDate] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadProgress, setLoadProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState('');
  const [customerEntries, setCustomerEntries] = useState([]);
  const nutritionCacheRef = useRef(new Map());
  const requestGuard = useRef(createKitchenRequestGuard());
  const activeScope = useRef('');
  activeScope.current = `${selectedMenuId}:${selectedDate}`;
  const [loadedScope, setLoadedScope] = useState('');

  useEffect(() => {
    const loadMenus = async () => {
      try {
        setLoadingMenus(true);
        const response = await api.get('/menus?isActive=all&limit=100');
        if (response.data?.success) {
          setMenus(response.data.data || []);
        }
      } catch (err) {
        setError(err.response?.data?.message || 'Failed to load menus');
      } finally {
        setLoadingMenus(false);
      }
    };
    loadMenus();
  }, []);

  // Selecting a menu only reveals the date picker (built from the menu's own
  // date range, no fetch needed) — nothing loads until a date is picked too,
  // same as Kitchen List.
  useEffect(() => {
    setSelectedDate('');
    setCustomerEntries([]);
  }, [selectedMenuId]);

  const selectedMenu = useMemo(
    () => menus.find((m) => m._id === selectedMenuId) || null,
    [menus, selectedMenuId]
  );

  // Date dropdown sources, fetched as soon as a menu is picked (cheap — just
  // the option maps and a raw, unenriched selections list, not the full
  // per-customer nutrition lookups loadCounts does below once a date is
  // actually chosen). Previously this dropdown only ever fell back to the
  // menu's own startDate/endDate, so a menu the kitchen had already uploaded
  // rotation options for — but with no explicit date range set — showed no
  // dates at all here even though Kitchen List showed them correctly.
  const [mainMealOptionsByDate, setMainMealOptionsByDate] = useState({});
  const [breakfastOptionsByDate, setBreakfastOptionsByDate] = useState({});
  const [snackOptionsByDate, setSnackOptionsByDate] = useState({});
  const [menuSelectionsForDates, setMenuSelectionsForDates] = useState([]);

  useEffect(() => {
    if (!selectedMenuId) {
      setMainMealOptionsByDate({});
      setBreakfastOptionsByDate({});
      setSnackOptionsByDate({});
      setMenuSelectionsForDates([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const [mainRes, breakfastRes, snackRes, selectionsRes] = await Promise.all([
        api.get(`/menus/${selectedMenuId}/main-meal-options`).catch(() => null),
        api.get(`/menus/${selectedMenuId}/breakfast-options`).catch(() => null),
        api.get(`/menus/${selectedMenuId}/snack-options`).catch(() => null),
        api.get(`/menus/${selectedMenuId}/selections`).catch(() => null)
      ]);
      if (cancelled) return;
      setMainMealOptionsByDate(mainRes?.data?.data || {});
      setBreakfastOptionsByDate(breakfastRes?.data?.data || {});
      setSnackOptionsByDate(snackRes?.data?.data || {});
      setMenuSelectionsForDates(selectionsRes?.data?.success ? (selectionsRes.data.data || []) : []);
    })();
    return () => { cancelled = true; };
  }, [selectedMenuId]);

  const menuDateKeys = useMemo(
    () => deriveDateKeys({
      menuSelections: menuSelectionsForDates,
      mainMealOptionsByDate,
      breakfastOptionsByDate,
      snackOptionsByDate,
      selectedMenu
    }),
    [menuSelectionsForDates, mainMealOptionsByDate, breakfastOptionsByDate, snackOptionsByDate, selectedMenu]
  );

  const loadCounts = useCallback(async () => {
    const request = requestGuard.current.begin();
    const scope = `${selectedMenuId}:${selectedDate}`;
    const current = () => requestGuard.current.isCurrent(request) && activeScope.current === scope;
    setCustomerEntries([]);
    setLoadedScope('');
    if (!selectedMenuId || !selectedDate) { setLoading(false); return; }
    nutritionCacheRef.current.clear();
    setLoading(true);
    setError('');
    try {
      // Explicit preparation must finish before the selections snapshot is read.
      const preparation = await prepareKitchenSelections(api, selectedMenuId, selectedDate, current);
      if (!current()) return;
      const response = await api.get(`/menus/${selectedMenuId}/selections`);
      const rawSelections = response.data?.success ? (response.data.data || []) : [];

      const breakfastState = await fetchBreakfastPresets(api, selectedMenuId);
      const snackState = await fetchSnackPresets(api);

      // Use the same fresh, email-first nutrition resolution as Kitchen List.
      // A menu with hundreds of customers means hundreds of individual Matter
      // API calls (8 at a time) — that can legitimately take a while on a
      // first (uncached) load, with nothing on screen to show it's actually
      // progressing rather than stuck. loadProgress renders as "N / total"
      // under the spinner so a slow load reads as slow, not frozen.
      if (!current()) return;
      setLoadProgress({ done: 0, total: rawSelections.length });
      const enrichedSelections = await enrichSelectionsWithNutrition(api, rawSelections, nutritionCacheRef, {
        matterInputs: preparation.cached ? [] : preparation.data?.kitchenInputs,
        productionScope: !preparation.cached && preparation.data?.rosterComplete === true
          ? { complete: true, date: selectedDate, roster: preparation.data.kitchenRoster } : null,
        onEach: () => { if (current()) setLoadProgress((prev) => ({ ...prev, done: prev.done + 1 })); }
      });

      const computed = enrichedSelections.map((entry) => {
        const mealCount = Array.isArray(entry.selectedMeals)
          ? entry.selectedMeals.filter((m) => String(m.mealType || '').toLowerCase() !== 'breakfast').length
          : 0;
        return calculateKitchenListEntry({
          customer: { ...entry, mealCount, customerName: getCustomerName(entry) },
          selectedMeals: entry.selectedMeals || [],
          breakfastPreset: breakfastState,
          snackPreset: snackState
        });
      });

      // Owner (2026-10-09): a customer with a saved selection but no active
      // Matter delivery on this date (paused / skipped / not started / ended)
      // isn't cooked for, so isn't counted. Partner members have no Matter
      // subscription of their own and are always kept. If Matter can't be
      // reached the counts are not shown, rather than counting customers who
      // may not be delivered.
      const source = preparation.data;
      const deliveryRes = !preparation.cached && source?.rosterComplete === true && Array.isArray(source.kitchenRoster)
        ? { data: { success: true, data: source.kitchenRoster } }
        : await api.get('/matter/subscriptions/delivery-on-date', { params: { date: selectedDate }, timeout: 180000 });
      const deliverySubs = verifiedKitchenRoster(deliveryRes.data);
      assertKitchenRosterCovered(enrichedSelections, deliverySubs, selectedDate);
      const hasDelivery = (entry) => hasKitchenDeliveryOnDate(entry, deliverySubs, selectedDate);

      if (!current()) return;
      const deliverable = computed.filter(hasDelivery);
      assertKitchenExportReady(deliverable);
      setCustomerEntries(deliverable);
      setLoadedScope(scope);
    } catch (err) {
      if (current()) { setCustomerEntries([]); setError(err.response?.data?.message || err.message || 'Failed to load kitchen counting data'); }
    } finally {
      if (current()) setLoading(false);
    }
  }, [selectedMenuId, selectedDate]);

  useEffect(() => { loadCounts(); return () => requestGuard.current.cancel(); }, [loadCounts]);

  // The whole point of this page: cook-counts must exactly match what
  // Kitchen List shows for the same menu+date — guaranteed here because both
  // pages run the identical selection data through the identical
  // calculateKitchenListEntry function; this step is pure aggregation, no
  // recalculation of macros/weights.
  const countRows = useMemo(() => {
    const grouped = new Map();

    (loadedScope === `${selectedMenuId}:${selectedDate}` ? customerEntries : []).forEach((entry) => {
      (entry.selectedMeals || [])
        .filter((meal) => getDateKey(meal?.date) === selectedDate)
        .forEach((meal) => {
          const category = meal.category || 'meal';
          const mealName = countingMealName(meal);
          const proteinWeight = Number(meal.proteinWeight) || 0;
          const carbWeight = Number(meal.carbWeight) || 0;
          const vegWeight = Number(meal.vegWeight) || 0;
          // A customer who picked the same dish twice (quantity: 2) needs
          // two portions cooked, each counted and weighed separately — not
          // folded into one.
          const qty = Number(meal.quantity) || 1;

          // Grouped by dish name only (per category) — portions are
          // macro-personalized per customer, so two customers eating
          // "Chicken Shawarma" can have slightly different portion weights.
          // The kitchen needs one number for "how many Chicken Shawarma" and
          // one running total for "how much protein/carb/veg across all of
          // them" — customer 1's weight + customer 2's + customer 3's ... —
          // not a separate row per slightly-different portion size.
          const key = `${category}||${mealName}`;
          const existing = grouped.get(key);
          if (existing) {
            existing.count += qty;
            existing.totalProteinWeight += proteinWeight * qty;
            existing.totalCarbWeight += carbWeight * qty;
            existing.totalVegWeight += vegWeight * qty;
          } else {
            grouped.set(key, {
              category,
              mealName,
              count: qty,
              totalProteinWeight: proteinWeight * qty,
              totalCarbWeight: carbWeight * qty,
              totalVegWeight: vegWeight * qty
            });
          }
        });
    });

    return Array.from(grouped.values()).sort((a, b) => {
      const catDiff = (CATEGORY_ORDER[a.category] ?? 9) - (CATEGORY_ORDER[b.category] ?? 9);
      if (catDiff !== 0) return catDiff;
      if (a.mealName !== b.mealName) return a.mealName.localeCompare(b.mealName);
      return b.count - a.count;
    });
  }, [customerEntries, selectedDate, selectedMenuId, loadedScope]);

  const totalMealCount = countRows
    .filter((r) => r.category === 'meal')
    .reduce((sum, r) => sum + r.count, 0);

  // Per-meal drill-down: every customer who has THIS specific meal (same
  // category + name) on the selected date, with their own portion weight —
  // a customer who picked the same dish twice (quantity: 2) gets two rows
  // here, one per portion, not one row with a quantity column, so the
  // kitchen can tick off physical portions one by one.
  const downloadMealCustomerList = async (category, mealName) => {
    if (loading || error || loadedScope !== `${selectedMenuId}:${selectedDate}`) return;
    assertKitchenExportReady(customerEntries);
    const rows = [];
    (loadedScope === `${selectedMenuId}:${selectedDate}` ? customerEntries : []).forEach((entry) => {
      (entry.selectedMeals || [])
        .filter((meal) => getDateKey(meal?.date) === selectedDate)
        .filter((meal) => (meal.category || 'meal') === category && countingMealName(meal) === mealName)
        .forEach((meal) => {
          const qty = Number(meal.quantity) || 1;
          for (let i = 0; i < qty; i += 1) {
            rows.push({
              'Customer ID': entry.customerId || '',
              Name: getCustomerName(entry),
              Email: entry.email || '',
              'Protein Weight (g)': Math.round(Number(meal.proteinWeight) || 0),
              'Carb Weight (g)': Math.round(Number(meal.carbWeight) || 0),
              'Veg Weight (g)': Math.round(Number(meal.vegWeight) || 0),
              'Total Weight (g)': Math.round(Number(meal.weight) || 0),
              C: Math.round(Number(meal.macros?.C) || 0),
              P: Math.round(Number(meal.macros?.P) || 0),
              F: Math.round(Number(meal.macros?.F) || 0)
            });
          }
        });
    });

    if (rows.length === 0) return;

    const XLSX = await loadXLSX();
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Customers');
    const safeName = mealName.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '');
    XLSX.writeFile(workbook, `kitchen-counting-${safeName}-${selectedDate}.xlsx`);
  };

  const exportToExcel = async () => {
    if (loading || error || loadedScope !== `${selectedMenuId}:${selectedDate}`) return;
    assertKitchenExportReady(customerEntries);
    if (countRows.length === 0) return;
    const rows = countRows.map((r) => ({
      Category: CATEGORY_LABEL[r.category] || r.category,
      'Meal Name': r.mealName,
      Count: r.count,
      'Total Protein Weight (g)': Math.round(r.totalProteinWeight),
      'Total Carb Weight (g)': Math.round(r.totalCarbWeight),
      'Total Veg Weight (g)': Math.round(r.totalVegWeight)
    }));
    const XLSX = await loadXLSX();
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Kitchen Counting');
    XLSX.writeFile(workbook, `kitchen-counting-${selectedDate || 'export'}.xlsx`);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-amber-50 p-4 md:p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <PartnerKitchenOrders date={selectedDate} counting />
        <div className="rounded-3xl bg-slate-900 p-6 text-white shadow-xl">
          <div className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-sm text-amber-200">
            <ChefHat size={16} /> Kitchen & Menus
          </div>
          <h1 className="mt-3 text-3xl font-bold tracking-tight">Kitchen Counting</h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-300">
            How many of each meal to cook for a date (a customer who picked the same dish twice counts twice), and
            the running total protein/carb/veg weight needed across every one of them — customer 1's portion +
            customer 2's + customer 3's, and so on — counted from the exact same assigned meals shown on Kitchen
            List for that menu and date.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
            <label className="mb-2 block text-sm font-semibold text-slate-700">Menu</label>
            <select
              value={selectedMenuId}
              onChange={(e) => { requestGuard.current.cancel(); setLoadedScope(''); setSelectedDate(''); setSelectedMenuId(e.target.value); }}
              disabled={loadingMenus}
              className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm focus:border-slate-900 focus:outline-none"
            >
              <option value="">Select a menu...</option>
              {menus.map((menu) => (
                <option key={menu._id} value={menu._id}>{toSentenceCase(menu.title || menu.name) || 'Untitled menu'}</option>
              ))}
            </select>
          </div>

          <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
            <label className="mb-2 block text-sm font-semibold text-slate-700">Date</label>
            <div className="flex gap-3">
              <select
                value={selectedDate}
                onChange={(e) => { requestGuard.current.cancel(); setLoadedScope(''); setSelectedDate(e.target.value); }}
                disabled={!selectedMenuId || menuDateKeys.length === 0}
                className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm focus:border-slate-900 focus:outline-none disabled:opacity-50"
              >
                <option value="">Select a date...</option>
                {menuDateKeys.map((key) => (
                  <option key={key} value={key}>{formatDateLabel(key)}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => { nutritionCacheRef.current.clear(); loadCounts(); }}
                disabled={!selectedMenuId || !selectedDate}
                title="Reload counts"
                className="rounded-xl border border-slate-300 px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
              </button>
            </div>
          </div>
        </div>

        {error && <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}

        {loading && (
          <div className="flex items-center gap-3 rounded-2xl bg-white p-6 text-slate-600 shadow-sm ring-1 ring-slate-200">
            <Loader className="animate-spin" size={18} />
            <span>
              Loading kitchen counts...
              {loadProgress.total > 0 && ` (${loadProgress.done}/${loadProgress.total} customers)`}
            </span>
          </div>
        )}

        {!loading && selectedDate && (
          <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div>
                <h2 className="text-sm font-semibold text-slate-700">
                  Cook counts — {formatDateLabel(selectedDate)}
                </h2>
                <p className="text-xs text-slate-400 mt-1">{totalMealCount} main meal(s) total, matching Kitchen List.</p>
              </div>
              <button
                type="button"
                onClick={exportToExcel}
                disabled={loading || !!error || loadedScope !== `${selectedMenuId}:${selectedDate}` || countRows.length === 0}
                className="inline-flex items-center gap-2 rounded-2xl bg-amber-400 px-4 py-2.5 text-sm font-semibold text-slate-900 hover:bg-amber-300 disabled:opacity-50"
              >
                <Download size={16} /> Export Excel
              </button>
            </div>

            {countRows.length === 0 ? (
              <p className="text-sm text-slate-400">No meals assigned for this date yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      <th className="py-2 pr-3">Category</th>
                      <th className="py-2 pr-3">Meal Name</th>
                      <th className="py-2 pr-3 text-right">Count</th>
                      <th className="py-2 pr-3 text-right">Total Protein (g)</th>
                      <th className="py-2 pr-3 text-right">Total Carb (g)</th>
                      <th className="py-2 pr-3 text-right">Total Veg (g)</th>
                      <th className="py-2 text-right">Customers</th>
                    </tr>
                  </thead>
                  <tbody>
                    {countRows.map((row, index) => (
                      <tr key={`${row.category}-${row.mealName}-${index}`} className="border-b border-slate-100">
                        <td className="py-2 pr-3">
                          <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600">
                            {CATEGORY_LABEL[row.category] || row.category}
                          </span>
                        </td>
                        <td className="py-2 pr-3 font-medium text-slate-800">{row.mealName}</td>
                        <td className="py-2 pr-3 text-right font-semibold text-slate-900">{row.count}</td>
                        <td className="py-2 pr-3 text-right text-slate-600">{Math.round(row.totalProteinWeight)}</td>
                        <td className="py-2 pr-3 text-right text-slate-600">{Math.round(row.totalCarbWeight)}</td>
                        <td className="py-2 pr-3 text-right text-slate-600">{Math.round(row.totalVegWeight)}</td>
                        <td className="py-2 text-right">
                          <button
                            type="button"
                            onClick={() => downloadMealCustomerList(row.category, row.mealName)}
                            title={`Download every customer who has ${row.mealName}, with their portion weight`}
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                          >
                            <Download size={12} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default KitchenCounting;
