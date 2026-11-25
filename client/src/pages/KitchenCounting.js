import { prepareKitchenSelections, createKitchenRequestGuard, assertKitchenExportReady } from '../utils/kitchenIntegrity';
import { recordActivityChange } from '../utils/activityCapture';
import useKitchenSelectionWindow from '../lib/useKitchenSelectionWindow';
import { assertKitchenRosterCovered, verifiedKitchenRoster, hasKitchenDeliveryOnDate, verifyKitchenSnapshot } from '../lib/kitchenSnapshot';
import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { Download, Loader, RefreshCw } from 'lucide-react';
import { KitchenWorkspaceHeader, KitchenEmptyState, KitchenAutoScopeControl } from '../components/KitchenWorkspace';
import useKitchenCurrentScope from '../lib/useKitchenCurrentScope';
import { formatKitchenDay, kitchenCustomerDay } from '../lib/kitchenDayScope';
import KitchenCountingGroups from '../components/KitchenCountingGroups';
// xlsx is only needed once a staff member clicks an export button — loaded
// on first use and memoized instead of shipping it in the app's shared
// bundle for every page/route (see KitchenList.js for the same pattern).
let xlsxModulePromise = null;
const loadXLSX = () => {
  if (!xlsxModulePromise) xlsxModulePromise = import('xlsx');
  return xlsxModulePromise;
};
import api from '../utils/api';
import { PartnerKitchenCounts } from '../components/PartnerKitchenOrders';
import usePartnerKitchenOrders from '../lib/usePartnerKitchenOrders';
import { loadPartnerKitchenOrders, partnerCountingRows } from '../lib/partnerKitchenData';
import { calculateKitchenListEntry } from '../utils/kitchenListCalculations';
import { buildKitchenCountRows, kitchenCountMeals, kitchenComponentNames, componentWeightText } from '../utils/kitchenCountingComponents';
import { buildCookingLog, cookingLogWorkbook } from '../utils/kitchenCookingLog';
import { useSocket } from '../contexts/SocketContext';
import { toSentenceCase } from '../utils/textFormat';
import {
  formatDateLabel,
  fetchBreakfastPresets,
  fetchSnackPresets,
  toBreakfastPresetState,
  toSnackPresetState,
  getCustomerName,
  enrichSelectionsWithNutrition,
  deriveDateKeys
} from '../lib/kitchenData';

const CATEGORY_LABEL = { breakfast: 'Breakfast', meal: 'Meal', snack: 'Snack' };

const KitchenCounting = () => {
  const { socket } = useSocket();
  const [menus, setMenus] = useState([]);
  const [loadingMenus, setLoadingMenus] = useState(false);
  const [selectedMenuId, setSelectedMenuId] = useState('');
  const [selectedDate, setSelectedDate] = useState('');
  const [partnerOnlyDate, setPartnerOnlyDate] = useState('');
  const productionDate = partnerOnlyDate || selectedDate;
  const partnerOrders = usePartnerKitchenOrders(productionDate);
  const [exportError, setExportError] = useState('');
  const [exporting, setExporting] = useState(false);
  const exportInFlight = useRef(false);
  const preparedForCounting = useRef(null);
  const [loading, setLoading] = useState(false);
  const [loadProgress, setLoadProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState('');
  const [customerEntries, setCustomerEntries] = useState([]);
  const [componentCatalog, setComponentCatalog] = useState([]);
  const [componentWarning, setComponentWarning] = useState('');
  const [componentsReady, setComponentsReady] = useState(false);
  const componentRequest = useRef(0);
  const refreshComponentSettings = useRef(null);
  const nutritionCacheRef = useRef(new Map());
  const requestGuard = useRef(createKitchenRequestGuard());
  const activeScope = useRef('');
  activeScope.current = partnerOnlyDate ? `partner:${productionDate}` : `${selectedMenuId}:${productionDate}`;
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

  const changeKitchenDate = date => {
    setPartnerOnlyDate('');
    if (date === selectedDate) return;
    requestGuard.current.cancel();
    setLoadedScope('');
    setSelectedDate(date);
    setExportError('');
  };

  const automaticScope = useKitchenCurrentScope({ menus, menuId: selectedMenuId, date: selectedDate,
    onMenu: id => { requestGuard.current.cancel(); setLoadedScope(''); setSelectedDate(''); setSelectedMenuId(id); },
    onDate: date => { if (!partnerOnlyDate) changeKitchenDate(date); },
  });

  const selectedMenu = useMemo(
    () => menus.find((m) => m._id === selectedMenuId) || null,
    [menus, selectedMenuId]
  );
  const selectionWindow = useKitchenSelectionWindow(selectedMenu, selectedDate);

  // Date dropdown sources, fetched as soon as a menu is picked (cheap — just
  // the option maps and a raw, unenriched selections list, not the full
  // per-customer nutrition lookups loadCounts does below once a date is
  // actually chosen). Previously this dropdown only ever fell back to the
  // menu's own startDate/endDate, so a menu the kitchen had already uploaded
  // rotation options for — but with no explicit date range set — showed no
  // dates at all here even though Kitchen List showed them correctly.
  const [knownDateKeys, setKnownDateKeys] = useState([]);
  useEffect(() => {
    setKnownDateKeys([]);
    if (!selectedMenuId) return;
    let cancelled = false;
    api.get(`/menus/${selectedMenuId}/kitchen-dates`, { timeout: 30000 }).then(response => {
      if (!cancelled && response.data?.success && Array.isArray(response.data.data)) setKnownDateKeys(response.data.data);
    }).catch(() => { /* The explicit menu range remains available. */ });
    return () => { cancelled = true; };
  }, [selectedMenuId]);
  const menuDateKeys = useMemo(() => knownDateKeys.length ? knownDateKeys : deriveDateKeys({ selectedMenu }), [knownDateKeys, selectedMenu]);

  const loadCounts = useCallback(async () => {
    const request = requestGuard.current.begin();
    const scope = `${selectedMenuId}:${selectedDate}`;
    const current = () => requestGuard.current.isCurrent(request) && activeScope.current === scope;
    setCustomerEntries([]);
    setLoadedScope('');
    preparedForCounting.current = null;
    if (!selectedMenuId || !selectedDate) { setLoading(false); return; }
    nutritionCacheRef.current.clear();
    setLoading(true);
    setError('');
    try {
      // Explicit preparation must finish before the selections snapshot is read.
      const preparation = await prepareKitchenSelections(api, selectedMenuId, selectedDate, current);
      if (!current()) return;
      if (preparation.data?.kitchenAllergyReview) throw new Error(preparation.data.kitchenAllergyReview);
      const response = preparation.data?.kitchenSelections ? { data: { success: true, data: preparation.data.kitchenSelections } } : await api.get(`/menus/${selectedMenuId}/selections`, { timeout: 30000 });
      if (!response.data?.success) throw new Error(response.data?.message || 'Selections could not be verified.');
      const rawSelections = response.data?.success ? (response.data.data || []) : [];

      const [rawBreakfastState, rawSnackState] = await Promise.all([
        preparation.data?.kitchenBreakfastPreset || fetchBreakfastPresets(api, selectedMenuId),
        preparation.data?.kitchenSnackPreset || fetchSnackPresets(api),
      ]);

      const breakfastState = toBreakfastPresetState(rawBreakfastState);
      const snackState = toSnackPresetState(rawSnackState);
      // Use the same fresh, email-first nutrition resolution as Kitchen List.
      // A menu with hundreds of customers means hundreds of individual Matter
      // API calls (8 at a time) — that can legitimately take a while on a
      // first (uncached) load, with nothing on screen to show it's actually
      // progressing rather than stuck. loadProgress renders as "N / total"
      // under the spinner so a slow load reads as slow, not frozen.
      if (!current()) return;
      setLoadProgress({ done: 0, total: rawSelections.length });
      let completed = 0, progressAt = Date.now();
      const enrichedSelections = await enrichSelectionsWithNutrition(api, rawSelections, nutritionCacheRef, {
        matterInputs: preparation.cached ? [] : preparation.data?.kitchenInputs,
        productionScope: !preparation.cached && preparation.data?.rosterComplete === true
          ? { complete: true, date: selectedDate, roster: preparation.data.kitchenRoster } : null,
        onEach: () => { completed++; if (current() && (completed === rawSelections.length || Date.now() - progressAt >= 100)) { progressAt = Date.now(); setLoadProgress({ done: completed, total: rawSelections.length }); } }
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

      const computed = enrichedSelections.filter(hasDelivery).map((entry) => {
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

      if (!current()) return;
      // Calculate the full record first, then validate only this cooking day,
      // exactly as Kitchen List does. Another day's lookup cannot block it.
      const deliverable = computed.map(entry => kitchenCustomerDay(entry, selectedDate));
      assertKitchenExportReady(deliverable);
      preparedForCounting.current = { scope, snapshotId: preparation.snapshotId, selectionOpen: preparation.preparation === 'selection-open' };
      setCustomerEntries(deliverable);
      setLoadedScope(scope);
    } catch (err) {
      if (current()) { setCustomerEntries([]); setError(err.response?.data?.message || err.message || 'Failed to load kitchen counting data'); }
    } finally {
      if (current()) setLoading(false);
    }
  }, [selectedMenuId, selectedDate]);

  useEffect(() => { loadCounts(); return () => requestGuard.current.cancel(); }, [loadCounts]);

  // A return from Meal Details refreshes the quantity rules without rerunning
  // preparation or downloading the customer roster again.
  useEffect(() => {
    const scope = `${selectedMenuId}:${selectedDate}`;
    setComponentCatalog([]);
    setComponentWarning('');
    setComponentsReady(false);
    if (partnerOnlyDate || !selectedMenuId || !selectedDate) return;
    let controller;
    const refreshComponents = async () => {
      const version = ++componentRequest.current;
      setComponentsReady(false);
      setComponentWarning('');
      controller?.abort();
      const request = new AbortController();
      controller = request;
      try {
        const response = await api.get(`/menus/${selectedMenuId}/kitchen-components`, {
          params: { date: selectedDate }, signal: request.signal, timeout: 30000,
        });
        if (request.signal.aborted || activeScope.current !== scope) return;
        if (!response.data?.success || !Array.isArray(response.data?.data)) throw new Error('Invalid component response.');
        setComponentCatalog(response.data.data);
        setComponentWarning('');
        setComponentsReady(true);
        return { catalog: response.data.data, version };
      } catch {
        if (!request.signal.aborted && activeScope.current === scope) setComponentWarning('Component settings could not be loaded. Refresh to retry.');
      }
    };
    refreshComponentSettings.current = refreshComponents;
    refreshComponents();
    window.addEventListener('focus', refreshComponents);
    socket?.on('kitchen:mealLibraryChanged', refreshComponents);
    socket?.on('connect', refreshComponents);
    return () => {
      refreshComponentSettings.current = null;
      window.removeEventListener('focus', refreshComponents);
      socket?.off('kitchen:mealLibraryChanged', refreshComponents);
      socket?.off('connect', refreshComponents);
      controller?.abort();
    };
  }, [partnerOnlyDate, selectedDate, selectedMenuId, socket]);

  // The whole point of this page: cook-counts must exactly match what
  // Kitchen List shows for the same menu+date — guaranteed here because both
  // pages run the identical selection data through the identical
  // calculateKitchenListEntry function; this step is pure aggregation, no
  // recalculation of macros/weights.
  const countRows = useMemo(() => buildKitchenCountRows(
    loadedScope === `${selectedMenuId}:${selectedDate}` ? customerEntries : [], selectedDate, componentCatalog, Boolean(componentWarning)
  ), [customerEntries, selectedDate, selectedMenuId, loadedScope, componentCatalog, componentWarning]);

  const totalMealCount = countRows
    .filter((r) => r.category === 'meal')
    .reduce((sum, r) => sum + r.count, 0);
  const customerDownloadsReady = componentsReady || Boolean(componentWarning);
  const hasCustomerCountRows = !partnerOnlyDate && countRows.length > 0;
  const countingExportReady = partnerOnlyDate
    || (!loading && !error && loadedScope === `${selectedMenuId}:${selectedDate}` && (!hasCustomerCountRows || componentsReady));

  const verifyCountingExport = async scope => {
    const prepared = preparedForCounting.current;
    if (prepared?.scope !== scope) throw new Error('Reload the selected date before exporting.');
    if (prepared.snapshotId) await verifyKitchenSnapshot(api, selectedMenuId, selectedDate, prepared.snapshotId);
    else if (prepared.selectionOpen) {
      const state = await prepareKitchenSelections(api, selectedMenuId, selectedDate,
        () => activeScope.current === scope, { verifyAllergies: true });
      if (state.data?.kitchenAllergyReview) throw new Error(state.data.kitchenAllergyReview);
      if (state.preparation !== 'selection-open') throw new Error('Selections closed. Reload kitchen counts before exporting.');
    }
  };

  // Per-meal drill-down: every customer who has THIS specific meal (same
  // category + name) on the selected date, with their own portion weight —
  // a customer who picked the same dish twice (quantity: 2) gets two rows
  // here, one per portion, not one row with a quantity column, so the
  // kitchen can tick off physical portions one by one.
  const downloadMealCustomerList = async ({ key, mealName }) => {
    const scope = `${selectedMenuId}:${selectedDate}`;
    if (!customerDownloadsReady || loading || error || loadedScope !== scope) return;
    const componentVersion = componentRequest.current;
    try { await verifyCountingExport(scope); }
    catch (err) {
      if (activeScope.current === scope) setExportError(err.response?.data?.message || err.message);
      return;
    }
    if (activeScope.current !== scope || preparedForCounting.current?.scope !== scope) return;
    assertKitchenExportReady(customerEntries);
    const rows = [];
    kitchenCountMeals(customerEntries, selectedDate, componentCatalog, Boolean(componentWarning))
      .filter(portion => portion.key === key)
      .forEach(({ entry, meal, item }) => {
        const names = kitchenComponentNames(meal, componentCatalog, item);
        const qty = Number(meal.quantity) || 1;
        for (let i = 0; i < qty; i += 1) {
          rows.push({
            'Customer ID': entry.customerId || '',
            Name: getCustomerName(entry),
            Email: entry.email || '',
            'Protein Component': names.protein,
            'Protein Weight (g)': Math.round(Number(meal.proteinWeight) || 0),
            'Carb Component': names.carb,
            'Carb Weight (g)': Math.round(Number(meal.carbWeight) || 0),
            'Veg Component': names.veg,
            'Veg Weight (g)': Math.round(Number(meal.vegWeight) || 0),
            'Total Weight (g)': Math.round(Number(meal.weight) || 0),
            C: Math.round(Number(meal.macros?.C) || 0),
            P: Math.round(Number(meal.macros?.P) || 0),
            F: Math.round(Number(meal.macros?.F) || 0)
          });
        }
      });

    if (rows.length === 0) return;

    const XLSX = await loadXLSX();
    if (activeScope.current !== scope || componentRequest.current !== componentVersion) return;
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Customers');
    const safeName = mealName.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '');
    XLSX.writeFile(workbook, `kitchen-counting-${safeName}-${selectedDate}.xlsx`);
  };

  const exportToExcel = async () => {
    if (exportInFlight.current || !productionDate || !countingExportReady) return;
    const scope = partnerOnlyDate ? `partner:${productionDate}` : `${selectedMenuId}:${productionDate}`;
    exportInFlight.current = true; setExporting(true); setExportError('');
    try {
      if (!partnerOnlyDate) assertKitchenExportReady(customerEntries);
      const [settings, partnerData, XLSX] = await Promise.all([
        hasCustomerCountRows ? refreshComponentSettings.current?.() : null,
        loadPartnerKitchenOrders(api, productionDate, () => activeScope.current === scope),
        loadXLSX(),
        partnerOnlyDate ? null : verifyCountingExport(scope),
      ]);
      if (activeScope.current !== scope) return;
      if (hasCustomerCountRows && (!settings || componentRequest.current !== settings.version)) {
        throw new Error('Component settings could not be verified for this download. Please try again.');
      }
      const rows = (hasCustomerCountRows ? buildKitchenCountRows(customerEntries, selectedDate, settings.catalog) : []).map(r => ({Category: CATEGORY_LABEL[r.category] || r.category, 'Meal Name': r.mealName, Count: r.count,
        'Total Protein Weight (g)': Math.round(r.totalProteinWeight), 'Protein Components': componentWeightText(r.components.protein),
        'Total Carb Weight (g)': Math.round(r.totalCarbWeight), 'Carb Components': componentWeightText(r.components.carb),
        'Total Veg Weight (g)': Math.round(r.totalVegWeight), 'Veg Components': componentWeightText(r.components.veg)}));
      rows.push(...partnerCountingRows(partnerData));
      if (!rows.length) return;
      const worksheet = XLSX.utils.json_to_sheet(rows);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Kitchen Counting');
      XLSX.writeFile(workbook, `kitchen-counting-${productionDate}.xlsx`);
    } catch (err) { if (activeScope.current === scope) setExportError(err.response?.data?.message || err.message || 'Download failed. Please retry.'); }
    finally { exportInFlight.current = false; setExporting(false); }
  };

  const exportCookingLog = async () => {
    const scope = `${selectedMenuId}:${selectedDate}`;
    if (exportInFlight.current || partnerOnlyDate || !componentsReady || loading || error || !selectedDate || loadedScope !== scope) return;
    exportInFlight.current = true; setExporting(true); setExportError('');
    try {
      assertKitchenExportReady(customerEntries);
      const [settings, module] = await Promise.all([refreshComponentSettings.current?.(), import('xlsx-js-style'), verifyCountingExport(scope)]);
      if (activeScope.current !== scope) return;
      if (!settings || componentRequest.current !== settings.version) {
        throw new Error('Component settings could not be verified for this download. Please try again.');
      }
      const blocks = buildCookingLog(customerEntries, selectedDate, settings.catalog);
      if (!blocks.length) return;
      const XLSX = module.default || module;
      XLSX.writeFile(cookingLogWorkbook(XLSX, blocks, selectedDate), `cooking-and-eod-${selectedDate}.xlsx`);
    } catch (err) {
      if (activeScope.current === scope) setExportError(err.message || 'Cooking & EOD download failed.');
    } finally { exportInFlight.current = false; setExporting(false); }
  };

  return (
    <div className="kitchen-workspace">
      <div className="kitchen-workspace-inner">
        <KitchenWorkspaceHeader counting dateLabel={formatKitchenDay(productionDate)}>
          <div className="kitchen-count-controls">
          <div className="kitchen-step">
            <label htmlFor="kitchen-count-menu" className="mb-2 block text-sm font-semibold text-slate-700">Menu</label>
            <select
              id="kitchen-count-menu"
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

          <div className="kitchen-step">
            <label htmlFor="kitchen-count-date" className="mb-2 block text-sm font-semibold text-slate-700">Date</label>
            <div className="flex gap-3">
              <select
                id="kitchen-count-date"
                value={selectedDate}
                onChange={e => changeKitchenDate(e.target.value)}
                disabled={!selectedMenuId || menuDateKeys.length === 0}
                className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm focus:border-slate-900 focus:outline-none disabled:opacity-50"
              >
                <option value="">Select a date...</option>
                {menuDateKeys.map((key) => (
                  <option key={key} value={key}>{formatKitchenDay(key)}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => { nutritionCacheRef.current.clear(); refreshComponentSettings.current?.(); loadCounts(); partnerOrders.refresh(); }}
                disabled={!selectedMenuId || !selectedDate}
                title="Reload counts"
                className="rounded-xl border border-slate-300 px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
              </button>
            </div>
          </div>
          <div className="kitchen-step">
            <label htmlFor="partner-count-date" className="mb-2 block text-sm font-semibold text-slate-700">Partner-only delivery date</label>
            <input id="partner-count-date" aria-label="Partner-only delivery date" type="date" value={partnerOnlyDate}
              onChange={e => {requestGuard.current.cancel(); setPartnerOnlyDate(e.target.value); setSelectedDate(''); setLoadedScope(''); setCustomerEntries([]); setError(''); setExportError('');}}
              className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm" />
          </div>
        </div>
        </KitchenWorkspaceHeader>
        <KitchenAutoScopeControl enabled={automaticScope.enabled} onChange={automaticScope.setEnabled} message={automaticScope.message} />


        {!productionDate && <KitchenEmptyState counting hasMenu={!!selectedMenuId} />}
        {selectedMenu && selectedDate && !selectionWindow.canAutoAssign && <p role="status" className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">{selectionWindow.message} Counts can only be confirmed once every active customer has meals.</p>}
        <div className="kitchen-date-chips" aria-label="Delivery dates">{menuDateKeys.map(date => <button type="button" key={date} aria-pressed={selectedDate === date} onClick={() => { recordActivityChange({ field: 'Delivery date', form: 'Kitchen counting', before: selectedDate, after: date }); recordActivityChange({ field: 'Partner-only delivery date', form: 'Kitchen counting', before: partnerOnlyDate, after: '' }); changeKitchenDate(date); }}>{formatDateLabel(date)}</button>)}</div>

        {error && <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}
        {componentWarning && <div role="status" className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">{componentWarning}</div>}

        {loading && (
          <div className="flex items-center gap-3 rounded-2xl bg-white p-6 text-slate-600 shadow-sm ring-1 ring-slate-200">
            <Loader className="animate-spin" size={18} />
            <span>
              Loading kitchen counts...
              {loadProgress.total > 0 && ` (${loadProgress.done}/${loadProgress.total} customers)`}
            </span>
          </div>
        )}

        {(!loading || partnerOnlyDate) && productionDate && (
          <div className="kitchen-count-body">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div>
                <h2 className="kitchen-section-heading">
                  {partnerOnlyDate ? 'Partner orders' : 'Cook counts'} — {formatDateLabel(productionDate)}
                </h2>
                {!partnerOnlyDate && <p className="text-xs text-slate-400 mt-1">{totalMealCount} main meal(s) total, matching Kitchen List.</p>}
              </div>
              <div className="flex flex-wrap gap-2">
              {!partnerOnlyDate && <button type="button" onClick={exportCookingLog}
                disabled={exporting || !componentsReady || loading || !!error || loadedScope !== `${selectedMenuId}:${selectedDate}` || !countRows.length}
                className="kitchen-button-primary inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold disabled:opacity-50">
                <Download size={16} /> Cooking & EOD Excel
              </button>}
              <button
                type="button"
                onClick={exportToExcel}
                disabled={exporting || !countingExportReady || (!hasCustomerCountRows && !partnerOrders.data?.counts.length)}
                className="kitchen-button-primary inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold disabled:opacity-50"
              >
                <Download size={16} /> Export Excel
              </button>
              </div>
            </div>

            {!partnerOnlyDate && (countRows.length === 0 ? (
              <p className="text-sm text-slate-400">{loading ? 'Preparing kitchen counts...' : error ? 'Counts are unavailable until preparation succeeds.' : 'No meals assigned for this date yet.'}</p>
            ) : (
              <>
                {!componentsReady && !componentWarning && <p role="status">Loading component quantities…</p>}
                <KitchenCountingGroups rows={countRows} onDownload={downloadMealCustomerList} componentsReady={componentsReady} customerDownloadsReady={customerDownloadsReady} />
              </>
            ))}
            <PartnerKitchenCounts state={partnerOrders} />
            {exportError && <p role="alert" className="text-sm text-red-700">{exportError}</p>}
            <p className="kitchen-table-note">Kitchen Counting and Standard Excel show assigned weights and buffered main PCS quantities. Cooking &amp; EOD adds 5% to main protein, carb and vegetable weights. Sauces, garnish and salad bases are counted in pieces without a buffer. Breakfasts and snacks also have no buffer, and use pieces by default. Cooking &amp; EOD combines normal and Large breakfasts and labels the Large count.</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default KitchenCounting;
