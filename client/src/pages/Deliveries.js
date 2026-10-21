import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useSelector } from 'react-redux';
import * as XLSX from 'xlsx';
import api from '../utils/api';
import PrintConfigModal from '../components/deliveries/PrintConfigModal';
import DeliveryDetailModal from '../components/deliveries/DeliveryDetailModal';
import { toBusinessComponents, businessComponentsToUtcDate, formatBusinessDateInput } from '../utils/businessTime';
import { useSocket } from '../contexts/SocketContext';

const COMPLETED_STATUSES = ['delivered', 'completed', 'collected'];
const PENDING_STATUSES = ['pending', 'assigned', 'on_route', 'picked_up'];

const STATUS_STYLES = {
  pending: { label: 'Pending', dot: 'bg-gray-400', cls: 'bg-gray-100 text-gray-700' },
  assigned: { label: 'Assigned', dot: 'bg-blue-500', cls: 'bg-blue-50 text-blue-700' },
  on_route: { label: 'On Route', dot: 'bg-blue-500', cls: 'bg-blue-50 text-blue-700' },
  picked_up: { label: 'Picked Up', dot: 'bg-blue-500', cls: 'bg-blue-50 text-blue-700' },
  delivered: { label: 'Delivered', dot: 'bg-emerald-500', cls: 'bg-emerald-50 text-emerald-700' },
  completed: { label: 'Completed', dot: 'bg-emerald-500', cls: 'bg-emerald-50 text-emerald-700' },
  collected: { label: 'Collected', dot: 'bg-emerald-500', cls: 'bg-emerald-50 text-emerald-700' },
  failed: { label: 'Failed', dot: 'bg-red-500', cls: 'bg-red-50 text-red-700' },
  cancelled: { label: 'Cancelled', dot: 'bg-gray-400', cls: 'bg-gray-100 text-gray-600' },
};

const TYPE_STYLES = {
  Delivery: 'bg-blue-50 text-blue-700',
  Task: 'bg-gray-100 text-gray-700',
  Collection: 'bg-amber-50 text-amber-700',
};

const EARLY_THRESHOLD_MINUTES = 180;

// Matter's own `emirate` field (addressDetails.city, populated by the
// Matter delivery import) sometimes carries a sub-area suffix ("Abu Dhabi -
// Al Dana", "Abu Dhabi - Khalifa City") and inconsistent casing ("DUBAI" vs
// "Dubai") — collapse to the real emirate name so the filter has one clean
// entry per emirate instead of a dozen near-duplicates.
const normalizeEmirateLabel = (city) => {
  if (!city) return '';
  const base = city.split(' - ')[0].trim();
  return base.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
};

const formatDuration = (minutes = 0) => {
  const value = Math.abs(Math.round(minutes));
  if (value < 60) return `${value}min`;
  const hours = Math.floor(value / 60);
  const mins = value % 60;
  return `${hours}h:${mins.toString().padStart(2, '0')}m`;
};

const getTimingInfo = (delivery) => {
  if (delivery.lateMinutes && delivery.lateMinutes > 0) {
    return { text: `+${formatDuration(delivery.lateMinutes)}`, cls: 'text-red-600 font-semibold' };
  }
  if (delivery.earlyMinutes && delivery.earlyMinutes > 0) {
    return { text: `-${formatDuration(delivery.earlyMinutes)}`, cls: 'text-yellow-600 font-semibold' };
  }
  if (delivery.status === 'delivered' || delivery.status === 'completed' || delivery.status === 'collected') {
    return { text: 'check', cls: 'text-emerald-500', isIcon: true };
  }
  return { text: '—', cls: 'text-gray-300' };
};

const getTimingBandColor = (delivery) => {
  if (delivery.lateMinutes && delivery.lateMinutes > 0) return 'bg-red-500';
  if (delivery.earlyMinutes && delivery.earlyMinutes > 0) return 'bg-yellow-500';
  if (delivery.status === 'delivered' || delivery.status === 'completed' || delivery.status === 'collected') return 'bg-emerald-500';
  return 'bg-gray-300';
};

// scheduledTime is a business-local (Dubai) instant — render it via the
// fixed business offset rather than the viewer's own device timezone, which
// otherwise makes the displayed time drift depending on where the viewer's
// machine is set.
const formatDate = (dateString) => {
  if (!dateString) return 'Date not set';
  const c = toBusinessComponents(dateString);
  if (!c) return { date: 'Invalid date', time: '' };
  const month = String(c.month + 1).padStart(2, '0');
  const day = String(c.day).padStart(2, '0');
  let hours = c.hours;
  const minutes = String(c.minutes).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return { date: `${month}/${day}/${c.year}`, time: `${String(hours).padStart(2, '0')}:${minutes} ${ampm}` };
};

// The actual moment a driver completed the stop — distinct from
// scheduledTime (when it was due). Collections set collectionDetails.collectedAt
// rather than completedAt/deliveredTime, so all three are checked.
const getActualDeliveryTime = (delivery) => (
  delivery.completedAt || delivery.deliveredTime || delivery.collectionDetails?.collectedAt || null
);

const getDriverDisplayName = (driver) => {
  if (!driver) return 'Unnamed driver';
  const firstName = driver.profile?.firstName || driver.firstName;
  const lastName = driver.profile?.lastName || driver.lastName;
  const fallback = driver.name || driver.email || driver.username || driver._id;
  return [firstName, lastName].filter(Boolean).join(' ').trim() || fallback || 'Unnamed driver';
};

const Deliveries = () => {
  const role = useSelector((state) => state.auth.user?.role);
  const [searchParams] = useSearchParams();
  const [deliveries, setDeliveries] = useState([]);
  const [filteredDeliveries, setFilteredDeliveries] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [areaFilter, setAreaFilter] = useState('all');
  const [emirateFilter, setEmirateFilter] = useState('all');
  const [timingFilter, setTimingFilter] = useState('all');
  const [driverFilter, setDriverFilter] = useState(() => searchParams.get('driver') || 'all');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedDate, setSelectedDate] = useState(() => formatBusinessDateInput(new Date()));
  const selectedDateRef = React.useRef(selectedDate);
  selectedDateRef.current = selectedDate;
  const [matterSyncError, setMatterSyncError] = useState('');
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [selectedDeliveries, setSelectedDeliveries] = useState(() => new Set());
  const [allDrivers, setAllDrivers] = useState([]);
  const [isPrintConfigOpen, setIsPrintConfigOpen] = useState(false);
  const [isImportingFromMatter, setIsImportingFromMatter] = useState(false);
  const [isDeletingSelected, setIsDeletingSelected] = useState(false);
  // Owner (2026-10-10): clicking a delivery opens its details in a modal,
  // in place, instead of navigating to a separate page — closing it must
  // NOT refetch the whole table (no fetchDeliveries() call on close).
  const [activeDeliveryId, setActiveDeliveryId] = useState(null);
  const MAX_FETCH_LIMIT = 2000;

  // Fetch every delivery for the selected date (all statuses) — status/type/area/timing/
  // driver/search are all applied client-side below, so the 5 stat cards always reflect
  // the whole day regardless of which table filters are active.
  const fetchDeliveries = useCallback(async (quiet = false) => {
    quiet = quiet === true;
    try {
      if (!quiet) setIsLoading(true);
      setError(null);

      const params = { page: 1, limit: MAX_FETCH_LIMIT };
      if (selectedDate) {
        const start = businessComponentsToUtcDate(selectedDate, '00:00');
        if (start) {
          const end = new Date(start.getTime() + 86400000 - 1);
          params.dateFrom = start.toISOString();
          params.dateTo = end.toISOString();
        }
      }

      const response = await api.get('/deliveries', { params });
      if (selectedDateRef.current !== selectedDate) return;
      if (!response.data?.success) {
        throw new Error(response.data?.message || 'Failed to load deliveries');
      }

      const data = response.data?.data || {};
      const pageDeliveries = Array.isArray(data.deliveries) ? data.deliveries : [];
      setDeliveries(pageDeliveries);
      setSelectedDeliveries((prev) => {
        if (prev.size === 0) return prev;
        const validIds = new Set(pageDeliveries.map((d) => d._id));
        const next = new Set();
        prev.forEach((id) => { if (validIds.has(id)) next.add(id); });
        return next;
      });
    } catch (err) {
      if (selectedDateRef.current !== selectedDate) return;
      console.error('Error fetching deliveries:', err);
      setDeliveries([]);
      setError(err.response?.data?.message || 'Failed to load deliveries');
    } finally {
      if (selectedDateRef.current === selectedDate && !quiet) setIsLoading(false);
    }
  }, [selectedDate]);

  useEffect(() => {
    let cancelled = false;
    setMatterSyncError('');
    const loaded = fetchDeliveries();
    if (selectedDate && ['admin', 'super_admin', 'dispatcher', 'manager'].includes(role)) {
      const synchronized = api.post('/matter/standardize-deliveries', { date: selectedDate });
      Promise.all([loaded, synchronized]).then(([, response]) => {
        if (cancelled) return;
        if (response.data?.data?.updated) fetchDeliveries(true);
        if (response.data?.data?.unresolved?.length) setMatterSyncError('Some deliveries could not be matched uniquely to a Matter account. Their saved details were retained.');
      }).catch((err) => {
        if (!cancelled) setMatterSyncError(err.response?.data?.message || 'Matter names and delivery windows could not be synchronized. Refresh to retry.');
      });
    }
    return () => { cancelled = true; };
  }, [fetchDeliveries, selectedDate, role, refreshVersion]);

  // Owner (2026-10-10): "auto refresh whenever someone completes the
  // delivery, and a popup that goes away after 2s" — later refined to "top
  // of the page, driver name, customer name, delivered." Completion fires
  // over Socket.IO as either 'delivery:statusUpdate' (the driver app's own
  // complete/collect-delivery flow) or 'delivery:updated' (bulk/other
  // update paths) — both are broadcast server-wide, not scoped to a room,
  // so this page gets them regardless of who triggered the completion.
  const { socket } = useSocket();
  const [completionToast, setCompletionToast] = useState(null);
  // The emitted delivery's `driver` field is just an id (the server doesn't
  // populate it before emitting), so the driver's name is looked up here
  // against the already-loaded driver list. Kept in a ref so the socket
  // listener below doesn't need to re-subscribe every time allDrivers loads.
  const allDriversRef = React.useRef([]);
  useEffect(() => { allDriversRef.current = allDrivers; }, [allDrivers]);

  useEffect(() => {
    if (!socket) return undefined;
    const handleDeliveryEvent = (delivery) => {
      if (!delivery || !COMPLETED_STATUSES.includes(delivery.status)) return;
      const driverId = typeof delivery.driver === 'object' ? delivery.driver?._id : delivery.driver;
      const driver = allDriversRef.current.find((d) => d._id === driverId);
      const driverName = driver ? getDriverDisplayName(driver) : 'Driver';
      const customerName = delivery.customerName || 'Customer';
      const statusLabel = (STATUS_STYLES[delivery.status]?.label || 'completed').toLowerCase();
      setCompletionToast(`${driverName} → ${customerName}: ${statusLabel}`);
      fetchDeliveries();
    };
    socket.on('delivery:statusUpdate', handleDeliveryEvent);
    socket.on('delivery:updated', handleDeliveryEvent);
    return () => {
      socket.off('delivery:statusUpdate', handleDeliveryEvent);
      socket.off('delivery:updated', handleDeliveryEvent);
    };
  }, [socket, fetchDeliveries]);

  useEffect(() => {
    if (!completionToast) return undefined;
    const timer = setTimeout(() => setCompletionToast(null), 2000);
    return () => clearTimeout(timer);
  }, [completionToast]);

  useEffect(() => {
    api.get('/users/drivers')
      .then((res) => {
        const payload = res?.data;
        const list = payload?.data?.users || payload?.data?.drivers || payload?.data || payload?.users || payload?.drivers || payload || [];
        setAllDrivers(Array.isArray(list) ? list : []);
      })
      .catch(() => setAllDrivers([]));
  }, []);

  const areaOptions = useMemo(() => {
    const zones = new Set();
    deliveries.forEach((d) => { const z = d.zone?.trim(); if (z) zones.add(z); });
    return Array.from(zones).sort((a, b) => a.localeCompare(b));
  }, [deliveries]);

  useEffect(() => {
    if (areaFilter !== 'all' && !areaOptions.includes(areaFilter)) setAreaFilter('all');
  }, [areaOptions, areaFilter]);

  // Only Matter-imported deliveries have addressDetails.city populated
  // today, so this list is empty (and the filter hidden) until at least one
  // such delivery is on the selected date.
  const emirateOptions = useMemo(() => {
    const emirates = new Set();
    deliveries.forEach((d) => {
      const emirate = normalizeEmirateLabel(d.addressDetails?.city);
      if (emirate) emirates.add(emirate);
    });
    return Array.from(emirates).sort((a, b) => a.localeCompare(b));
  }, [deliveries]);

  useEffect(() => {
    if (emirateFilter !== 'all' && !emirateOptions.includes(emirateFilter)) setEmirateFilter('all');
  }, [emirateOptions, emirateFilter]);

  const driverOptions = useMemo(() => {
    const map = new Map();
    deliveries.forEach((d) => { if (d.driver?._id) map.set(d.driver._id, getDriverDisplayName(d.driver)); });
    allDrivers.forEach((d) => { if (d._id && !map.has(d._id)) map.set(d._id, getDriverDisplayName(d)); });
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [deliveries, allDrivers]);

  useEffect(() => {
    let filtered = deliveries;

    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      filtered = filtered.filter((d) =>
        d.customerName?.toLowerCase().includes(term) ||
        d.customerId?.toLowerCase().includes(term) ||
        d.driver?.profile?.firstName?.toLowerCase().includes(term) ||
        d.driver?.profile?.lastName?.toLowerCase().includes(term) ||
        d.zone?.toLowerCase().includes(term)
      );
    }
    if (statusFilter !== 'all') filtered = filtered.filter((d) => d.status === statusFilter);
    if (typeFilter !== 'all') filtered = filtered.filter((d) => d.type === typeFilter);
    if (areaFilter !== 'all') filtered = filtered.filter((d) => d.zone?.trim() === areaFilter);
    if (emirateFilter !== 'all') filtered = filtered.filter((d) => normalizeEmirateLabel(d.addressDetails?.city) === emirateFilter);
    if (driverFilter !== 'all') filtered = filtered.filter((d) => d.driver?._id === driverFilter);
    if (timingFilter === 'late') filtered = filtered.filter((d) => d.lateMinutes > 0);
    else if (timingFilter === 'early') filtered = filtered.filter((d) => d.earlyMinutes > 0);

    // Owner (2026-10-10): always arrange by the driver's ACTUAL delivery
    // time (earliest to latest) — with or without a driver filter applied —
    // not by scheduled time. Deliveries with no actual time yet (still
    // pending) have nothing to sort by, so they're pushed to the end,
    // ordered among themselves by scheduled time.
    filtered = [...filtered].sort((a, b) => {
      const at = getActualDeliveryTime(a);
      const bt = getActualDeliveryTime(b);
      if (at && bt) return new Date(at) - new Date(bt);
      if (at) return -1;
      if (bt) return 1;
      return new Date(a.scheduledTime || 0) - new Date(b.scheduledTime || 0);
    });

    setFilteredDeliveries(filtered);
  }, [deliveries, searchTerm, statusFilter, typeFilter, areaFilter, emirateFilter, driverFilter, timingFilter]);

  const stats = useMemo(() => ({
    total: deliveries.length,
    completed: deliveries.filter((d) => COMPLETED_STATUSES.includes(d.status)).length,
    pending: deliveries.filter((d) => PENDING_STATUSES.includes(d.status)).length,
    late: deliveries.filter((d) => d.lateMinutes > 0).length,
    early: deliveries.filter((d) => d.earlyMinutes > 0).length,
  }), [deliveries]);

  const activeDelivery = useMemo(
    () => (activeDeliveryId ? deliveries.find((d) => d._id === activeDeliveryId) || null : null),
    [deliveries, activeDeliveryId]
  );

  const filteredDeliveryIds = useMemo(() => filteredDeliveries.map((d) => d._id), [filteredDeliveries]);
  const allFilteredSelected = filteredDeliveryIds.length > 0 && filteredDeliveryIds.every((id) => selectedDeliveries.has(id));
  const selectedCount = selectedDeliveries.size;
  const hasSelections = selectedCount > 0;

  const handleToggleDeliverySelection = (id) => {
    setSelectedDeliveries((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleToggleSelectAllOnPage = () => {
    setSelectedDeliveries((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) filteredDeliveryIds.forEach((id) => next.delete(id));
      else filteredDeliveryIds.forEach((id) => next.add(id));
      return next;
    });
  };

  const handleClearFilters = () => {
    setSearchTerm('');
    setStatusFilter('all');
    setTypeFilter('all');
    setAreaFilter('all');
    setEmirateFilter('all');
    setDriverFilter('all');
    setTimingFilter('all');
  };

  // Pulls deliveries for the currently-selected date straight from Matter
  // (owner, 2026-10-11) — the on-demand counterpart to the nightly import
  // job, which stays off unless MATTER_IMPORT_ENABLED=1. Safe to click more
  // than once: already-imported/already-scheduled customers are skipped
  // server-side, and a customer with no address flagged "current" in Matter
  // is skipped too rather than guessed at.
  const handleImportFromMatter = async () => {
    if (!selectedDate) return;
    const confirmed = window.confirm(`Fetch deliveries scheduled for ${formattedSelectedDate} from the Matter API?`);
    if (!confirmed) return;
    try {
      setIsImportingFromMatter(true);
      const response = await api.post('/matter/import-deliveries', { date: selectedDate });
      if (!response.data?.success) throw new Error(response.data?.message || 'Failed to import deliveries from Matter');
      const s = response.data.data || {};
      alert(
        `Matter import for ${selectedDate}: ${s.created || 0} created, ${s.alreadyExisted || 0} already imported, ` +
        `${s.alreadyHadOtherDelivery || 0} already had a delivery, ${s.noCurrentAddress || 0} skipped (no current address), ` +
        `${s.failed || 0} failed.`
      );
      await fetchDeliveries();
    } catch (err) {
      console.error('Import from Matter error:', err);
      alert(err.response?.data?.message || err.message || 'Failed to import deliveries from Matter');
    } finally {
      setIsImportingFromMatter(false);
    }
  };

  const handleDeleteSelectedDeliveries = async () => {
    if (!hasSelections) return;
    const deliveryIds = Array.from(selectedDeliveries);
    const confirmed = window.confirm(`Delete ${deliveryIds.length} selected deliveries? This cannot be undone.`);
    if (!confirmed) return;
    try {
      setIsDeletingSelected(true);
      const response = await api.delete('/deliveries/by-ids', { data: { deliveryIds } });
      if (!response.data?.success) throw new Error(response.data?.message || 'Failed to delete selected deliveries');
      setSelectedDeliveries(new Set());
      await fetchDeliveries();
    } catch (err) {
      console.error('Delete selected deliveries error:', err);
      alert(err.response?.data?.message || err.message || 'Failed to delete selected deliveries');
    } finally {
      setIsDeletingSelected(false);
    }
  };

  const getPrintTargets = () => (hasSelections
    ? filteredDeliveries.filter((d) => selectedDeliveries.has(d._id))
    : filteredDeliveries);

  // Excel delivery sheet: the selected rows, or everything currently shown.
  // Times are rendered in Dubai time (same helper as the table), not the device's.
  const handleDownloadExcel = () => {
    const rows = getPrintTargets().map((d) => {
      const scheduled = d.scheduledTime ? formatDate(d.scheduledTime) : null;
      const actualAt = getActualDeliveryTime(d);
      const actual = actualAt ? formatDate(actualAt) : null;
      const lat = d.gpsLocation?.lat;
      const lng = d.gpsLocation?.lng;
      const hasPin = Number.isFinite(lat) && Number.isFinite(lng);
      return {
        'Customer ID': d.customerId || '',
        'Customer Name': d.customerName || '',
        Address: d.address || '',
        Zone: d.zone || '',
        'Scheduled Date': scheduled?.date || '',
        'Scheduled Time': scheduled?.time || '',
        'Delivered Time': actual ? `${actual.date} ${actual.time}` : '',
        Latitude: hasPin ? lat : '',
        Longitude: hasPin ? lng : '',
        'GPS Location': hasPin ? `${lat}, ${lng}` : '',
        'Map Link': d.gpsLocation?.link || (hasPin ? `https://www.google.com/maps?q=${lat},${lng}` : ''),
      };
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [14, 26, 50, 16, 14, 14, 22, 11, 11, 22, 40].map((wch) => ({ wch }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Deliveries');
    XLSX.writeFile(wb, `Delivery_Sheet_${selectedDate || 'all'}.xlsx`);
  };

  const formattedSelectedDate = selectedDate ? new Date(`${selectedDate}T00:00:00`).toLocaleDateString() : 'All Dates';

  if (isLoading) {
    return (
      <div className="matter-analytics p-6 flex items-center justify-center h-64 text-gray-500">
        <span className="material-symbols-outlined animate-spin mr-2">progress_activity</span>
        Loading deliveries...
      </div>
    );
  }

  if (error) {
    return (
      <div className="matter-analytics p-6">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <div className="flex items-center">
            <div className="text-red-600 font-medium">Error loading deliveries</div>
            <button onClick={() => setRefreshVersion((value) => value + 1)} className="ml-auto flex items-center px-3 py-1 text-sm bg-red-100 text-red-700 rounded">
              <span className="material-symbols-outlined text-[16px] mr-1">refresh</span>
              Retry
            </button>
          </div>
          <div className="text-red-600 text-sm mt-1">{error}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="matter-analytics p-6 bg-gray-50 min-h-screen">
      {matterSyncError && <p role="status" className="mb-4 text-sm text-amber-800">{matterSyncError}</p>}
      {completionToast && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-lg bg-emerald-600 text-white font-medium shadow-lg">
          {completionToast}
        </div>
      )}
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Deliveries</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Showing {filteredDeliveries.length} of {deliveries.length} deliveries for {formattedSelectedDate}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setRefreshVersion((value) => value + 1)} className="p-2 text-gray-500 hover:text-blue-600 hover:bg-gray-100 rounded-lg transition-colors" title="Refresh">
            <span className={`material-symbols-outlined ${isLoading ? 'animate-spin' : ''}`}>refresh</span>
          </button>
          <button
            onClick={handleImportFromMatter}
            disabled={isImportingFromMatter || !selectedDate}
            title="Fetch deliveries for the selected date from the Matter API"
            className="flex items-center gap-2 px-4 py-2 border border-gray-200 rounded text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <span className={`material-symbols-outlined text-[18px] ${isImportingFromMatter ? 'animate-spin' : ''}`}>
              {isImportingFromMatter ? 'progress_activity' : 'cloud_download'}
            </span>
            {isImportingFromMatter ? 'Importing…' : 'Import from Matter'}
          </button>
          <button
            onClick={() => setIsPrintConfigOpen(true)}
            disabled={filteredDeliveries.length === 0}
            className="flex items-center gap-2 px-4 py-2 border border-gray-200 rounded text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <span className="material-symbols-outlined text-[18px]">print</span>
            {hasSelections ? `Print (${selectedCount})` : `Print (${filteredDeliveries.length})`}
          </button>
          <button
            onClick={handleDownloadExcel}
            disabled={filteredDeliveries.length === 0}
            title="Download the delivery sheet as Excel"
            className="flex items-center gap-2 px-4 py-2 border border-gray-200 rounded text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <span className="material-symbols-outlined text-[18px]">download</span>
            {hasSelections ? `Excel (${selectedCount})` : `Excel (${filteredDeliveries.length})`}
          </button>
          <button
            onClick={handleDeleteSelectedDeliveries}
            disabled={!hasSelections || isDeletingSelected}
            className="flex items-center gap-2 px-4 py-2 border border-red-200 rounded text-sm font-medium text-red-600 bg-white hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <span className={`material-symbols-outlined text-[18px] ${isDeletingSelected ? 'animate-spin' : ''}`}>delete</span>
            {isDeletingSelected ? 'Deleting…' : `Delete${hasSelections ? ` (${selectedCount})` : ''}`}
          </button>
          <Link
            to="/add-delivery"
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded text-sm font-medium hover:opacity-90 transition-opacity shadow-sm"
          >
            <span className="material-symbols-outlined text-[18px]">add</span>
            Add Delivery
          </Link>
        </div>
      </div>

      {/* Stat cards */}
      <div className="flex overflow-x-auto snap-x snap-mandatory no-scrollbar gap-3 pb-1 -mx-1 px-1 mb-6 md:grid md:grid-cols-5 md:gap-4 md:overflow-visible md:pb-0 md:mx-0 md:px-0">
        <div className="min-w-[140px] md:min-w-0 flex-shrink-0 snap-center bg-white rounded-lg border border-gray-200 p-4 flex flex-col gap-1">
          <span className="text-gray-500 text-xs font-semibold uppercase tracking-wider">Total Deliveries</span>
          <span className="text-2xl font-bold text-gray-900">{stats.total}</span>
        </div>
        <div className="min-w-[140px] md:min-w-0 flex-shrink-0 snap-center bg-white rounded-lg border border-gray-200 p-4 flex flex-col gap-1">
          <span className="text-gray-500 text-xs font-semibold uppercase tracking-wider">Completed</span>
          <span className="text-2xl font-bold text-emerald-600">{stats.completed}</span>
        </div>
        <div className="min-w-[140px] md:min-w-0 flex-shrink-0 snap-center bg-white rounded-lg border border-gray-200 p-4 flex flex-col gap-1">
          <span className="text-gray-500 text-xs font-semibold uppercase tracking-wider">Pending</span>
          <span className="text-2xl font-bold text-gray-900">{stats.pending}</span>
        </div>
        <div className="min-w-[140px] md:min-w-0 flex-shrink-0 snap-center bg-white rounded-lg border border-gray-200 p-4 flex flex-col gap-1">
          <span className="text-gray-500 text-xs font-semibold uppercase tracking-wider">Late Delivery</span>
          <span className="text-2xl font-bold text-red-500">{stats.late}</span>
        </div>
        <div className="min-w-[140px] md:min-w-0 flex-shrink-0 snap-center bg-white rounded-lg border border-gray-200 p-4 flex flex-col gap-1">
          <span className="text-gray-500 text-xs font-semibold uppercase tracking-wider">Early Delivery</span>
          <span className="text-2xl font-bold text-yellow-500">{stats.early}</span>
        </div>
      </div>

      {/* Search */}
      <div className="relative mb-4 md:max-w-md">
        <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-[20px]">search</span>
        <input
          type="text"
          placeholder="Search customer, driver, zone…"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="w-full pl-10 pr-4 py-2 bg-white border border-gray-200 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          autoComplete="off"
        />
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg border border-gray-200 p-3 sm:p-4 mb-6 flex sm:flex-wrap gap-3 items-center overflow-x-auto no-scrollbar">
        <div className="hidden sm:flex items-center gap-2 text-gray-500 text-xs font-semibold uppercase tracking-wider mr-1 flex-shrink-0">
          <span className="material-symbols-outlined text-[18px]">filter_list</span>
          Filters
        </div>
        <input
          type="date"
          value={selectedDate || ''}
          onChange={(e) => setSelectedDate(e.target.value)}
          className="flex-shrink-0 px-3 py-1.5 border border-gray-200 rounded text-sm bg-white focus:ring-1 focus:ring-blue-500 focus:border-blue-500 focus:outline-none"
        />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="flex-shrink-0 px-3 py-1.5 border border-gray-200 rounded text-sm bg-white focus:ring-1 focus:ring-blue-500 focus:border-blue-500 focus:outline-none">
          <option value="all">Status: All</option>
          <option value="pending">Pending</option>
          <option value="assigned">Assigned</option>
          <option value="delivered">Delivered</option>
          <option value="collected">Collected</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="flex-shrink-0 px-3 py-1.5 border border-gray-200 rounded text-sm bg-white focus:ring-1 focus:ring-blue-500 focus:border-blue-500 focus:outline-none">
          <option value="all">Type: All</option>
          <option value="Delivery">Delivery</option>
          <option value="Task">Task</option>
          <option value="Collection">Collection</option>
        </select>
        {areaOptions.length > 0 && (
          <select value={areaFilter} onChange={(e) => setAreaFilter(e.target.value)} className="flex-shrink-0 px-3 py-1.5 border border-gray-200 rounded text-sm bg-white focus:ring-1 focus:ring-blue-500 focus:border-blue-500 focus:outline-none">
            <option value="all">Area: All</option>
            {areaOptions.map((area) => <option key={area} value={area}>{area}</option>)}
          </select>
        )}
        {emirateOptions.length > 0 && (
          <select value={emirateFilter} onChange={(e) => setEmirateFilter(e.target.value)} className="flex-shrink-0 px-3 py-1.5 border border-gray-200 rounded text-sm bg-white focus:ring-1 focus:ring-blue-500 focus:border-blue-500 focus:outline-none">
            <option value="all">Emirate: All</option>
            {emirateOptions.map((emirate) => <option key={emirate} value={emirate}>{emirate}</option>)}
          </select>
        )}
        <select value={timingFilter} onChange={(e) => setTimingFilter(e.target.value)} className="flex-shrink-0 px-3 py-1.5 border border-gray-200 rounded text-sm bg-white focus:ring-1 focus:ring-blue-500 focus:border-blue-500 focus:outline-none">
          <option value="all">Timing: All</option>
          <option value="late">Late Only</option>
          <option value="early">Early Only</option>
        </select>
        {driverOptions.length > 0 && (
          <select value={driverFilter} onChange={(e) => setDriverFilter(e.target.value)} className="flex-shrink-0 px-3 py-1.5 border border-gray-200 rounded text-sm bg-white focus:ring-1 focus:ring-blue-500 focus:border-blue-500 focus:outline-none">
            <option value="all">Driver: All</option>
            {driverOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        )}
        <button onClick={handleClearFilters} className="flex-shrink-0 sm:ml-auto text-blue-600 hover:underline text-sm font-medium whitespace-nowrap">Clear All</button>
      </div>

      {hasSelections && (
        <div className="text-sm text-blue-600 font-medium mb-3">
          {selectedCount} delivery{selectedCount === 1 ? '' : 'ies'} selected
        </div>
      )}

      {/* Mobile card list */}
      <div className="flex flex-col gap-3 lg:hidden">
        {filteredDeliveries.map((delivery) => {
          const timing = getTimingInfo(delivery);
          const scheduled = formatDate(delivery.scheduledTime);
          const statusStyle = STATUS_STYLES[delivery.status] || { label: delivery.status || 'Unknown', dot: 'bg-gray-400', cls: 'bg-gray-100 text-gray-700' };
          const driverName = delivery.driver ? getDriverDisplayName(delivery.driver) : null;
          return (
            <button
              type="button"
              key={delivery._id}
              onClick={() => setActiveDeliveryId(delivery._id)}
              className={`relative overflow-hidden bg-white border border-gray-200 rounded-xl p-4 pl-5 flex flex-col gap-3 text-left w-full ${delivery.status === 'delivered' || delivery.status === 'completed' || delivery.status === 'collected' ? 'opacity-75' : ''}`}
            >
              <div className={`absolute top-0 left-0 w-1 h-full ${getTimingBandColor(delivery)}`} />
              <div className="flex justify-between items-start">
                <div className="min-w-0">
                  <h3 className="font-semibold text-gray-900 leading-tight truncate">
                    {delivery.customerName}
                    {delivery.combinedSunday && (
                      <span
                        title="Sunday's delivery is included — no separate Sunday trip needed for this customer."
                        className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-indigo-100 text-indigo-700 align-middle"
                      >
                        +Sun
                      </span>
                    )}
                    {delivery.sundayOnlyCarriedOver && (
                      <span
                        title="This customer only has a Sunday meal — delivered together with Saturday's route since there's no separate Sunday route."
                        className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700 align-middle"
                      >
                        Sun only
                      </span>
                    )}
                  </h3>
                  <p className="text-xs text-gray-400 font-mono mt-0.5">ID: {delivery.customerId}</p>
                </div>
                <span className={`flex-shrink-0 ml-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${statusStyle.cls}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${statusStyle.dot}`} />
                  {statusStyle.label}
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                {delivery.company && (
                  <div className="flex items-center gap-2 text-gray-500 text-sm">
                    <span className="material-symbols-outlined text-[18px]">domain</span>
                    <span className="truncate">{delivery.company}</span>
                  </div>
                )}
                <div className="flex items-center gap-2 text-gray-500 text-sm">
                  <span className="material-symbols-outlined text-[18px]">schedule</span>
                  <span>{scheduled.date} · {scheduled.time}</span>
                </div>
                {getActualDeliveryTime(delivery) && (
                  <div className="flex items-center gap-2 text-emerald-600 text-sm">
                    <span className="material-symbols-outlined text-[18px]">local_shipping</span>
                    <span>Delivered {formatDate(getActualDeliveryTime(delivery)).time}</span>
                  </div>
                )}
                {!timing.isIcon && timing.text !== '—' && (
                  <div className={`flex items-center gap-2 text-sm font-medium ${timing.cls}`}>
                    <span className="material-symbols-outlined text-[18px]">warning</span>
                    <span>{timing.text.startsWith('+') ? `Late by ${timing.text.slice(1)}` : `Early by ${timing.text.slice(1)}`}</span>
                  </div>
                )}
              </div>
              <div className="flex items-center justify-between border-t border-gray-100 pt-3">
                <div className="flex items-center gap-2 min-w-0">
                  {driverName ? (
                    <>
                      <span className="w-6 h-6 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-[10px] font-semibold flex-shrink-0">
                        {driverName.charAt(0).toUpperCase()}
                      </span>
                      <span className="text-sm text-gray-900 truncate">{driverName}</span>
                    </>
                  ) : (
                    <>
                      <span className="w-6 h-6 rounded-full bg-gray-100 border border-gray-200 flex items-center justify-center flex-shrink-0">
                        <span className="material-symbols-outlined text-[14px] text-gray-400">person</span>
                      </span>
                      <span className="text-sm text-gray-400 italic">Unassigned</span>
                    </>
                  )}
                </div>
                <span className="flex-shrink-0 border border-gray-200 bg-white text-gray-700 px-3 py-1.5 rounded-lg text-xs font-semibold">
                  View Details
                </span>
              </div>
            </button>
          );
        })}

        {filteredDeliveries.length === 0 && (
          <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
            {deliveries.length === 0 ? (
              <>
                <div className="text-gray-400 text-lg">No deliveries found</div>
                <div className="text-gray-500 mt-2">Create your first delivery to get started</div>
                <Link to="/add-delivery" className="inline-block mt-4 px-6 py-2 bg-blue-600 text-white rounded-lg hover:opacity-90">
                  Add Delivery
                </Link>
              </>
            ) : (
              <>
                <div className="text-gray-400 text-lg">No deliveries match your filters</div>
                <div className="text-gray-500 mt-2">Try adjusting your search or filters</div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Table */}
      <div className="hidden lg:block bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="p-3 w-8">
                  <input
                    type="checkbox"
                    className="w-4 h-4 text-blue-600 border-gray-300 rounded"
                    onChange={handleToggleSelectAllOnPage}
                    checked={filteredDeliveryIds.length > 0 && allFilteredSelected}
                    disabled={filteredDeliveryIds.length === 0}
                  />
                </th>
                <th className="p-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Customer</th>
                <th className="p-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Type</th>
                <th className="p-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Company</th>
                <th className="p-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Area</th>
                <th className="p-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Time</th>
                <th className="p-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                <th className="p-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Driver</th>
                <th className="p-3 text-xs font-semibold text-gray-500 uppercase tracking-wider text-center">Late/Early</th>
                <th className="p-3 text-xs font-semibold text-gray-500 uppercase tracking-wider text-center">Proof</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filteredDeliveries.map((delivery) => {
                const timing = getTimingInfo(delivery);
                const scheduled = formatDate(delivery.scheduledTime);
                const actualTimeRaw = getActualDeliveryTime(delivery);
                const actualTime = actualTimeRaw ? formatDate(actualTimeRaw) : null;
                const statusStyle = STATUS_STYLES[delivery.status] || { label: delivery.status || 'Unknown', dot: 'bg-gray-400', cls: 'bg-gray-100 text-gray-700' };
                return (
                  <tr
                    key={delivery._id}
                    onClick={() => setActiveDeliveryId(delivery._id)}
                    className="hover:bg-gray-50 transition-colors cursor-pointer"
                  >
                    <td className="p-3" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        className="w-4 h-4 text-blue-600 border-gray-300 rounded"
                        checked={selectedDeliveries.has(delivery._id)}
                        onChange={() => handleToggleDeliverySelection(delivery._id)}
                      />
                    </td>
                    <td className="p-3">
                      <div className="font-medium text-gray-900">
                        {delivery.customerName}
                        {delivery.combinedSunday && (
                          <span
                            title="Sunday's delivery is included — no separate Sunday trip needed for this customer."
                            className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-indigo-100 text-indigo-700 align-middle"
                          >
                            +Sun
                          </span>
                        )}
                        {delivery.sundayOnlyCarriedOver && (
                          <span
                            title="This customer only has a Sunday meal — delivered together with Saturday's route since there's no separate Sunday route."
                            className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700 align-middle"
                          >
                            Sun only
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-gray-400 mt-0.5">ID: {delivery.customerId}</div>
                    </td>
                    <td className="p-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${TYPE_STYLES[delivery.type] || TYPE_STYLES.Delivery}`}>
                        {delivery.type || 'Delivery'}
                      </span>
                    </td>
                    <td className="p-3 text-sm text-gray-700">{delivery.company || '—'}</td>
                    <td className="p-3 text-sm text-gray-700">{delivery.zone || '—'}</td>
                    <td className="p-3 text-sm text-gray-700 font-mono">
                      <div>{scheduled.date}</div>
                      <div className="text-gray-400">{scheduled.time}</div>
                      {actualTime ? (
                        <div className="text-emerald-600 text-xs mt-1">Delivered {actualTime.time}</div>
                      ) : (
                        <div className="text-gray-300 text-xs mt-1">Not delivered yet</div>
                      )}
                    </td>
                    <td className="p-3">
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${statusStyle.cls}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${statusStyle.dot}`} />
                        {statusStyle.label}
                      </span>
                    </td>
                    <td className="p-3 text-sm text-gray-700">
                      {delivery.driver ? getDriverDisplayName(delivery.driver) : <span className="italic text-gray-400">Unassigned</span>}
                    </td>
                    <td className="p-3 text-center font-mono text-sm">
                      {timing.isIcon
                        ? <span className={`material-symbols-outlined text-[18px] ${timing.cls}`}>check_circle</span>
                        : <span className={timing.cls}>{timing.text}</span>}
                    </td>
                    <td className="p-3 text-center">
                      {delivery.proof?.images?.length > 0
                        ? <span className="material-symbols-outlined text-emerald-500 text-[18px]">check_circle</span>
                        : <span className="text-gray-300">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {filteredDeliveries.length === 0 ? (
          <div className="text-center py-12">
            {deliveries.length === 0 ? (
              <>
                <div className="text-gray-400 text-lg">No deliveries found</div>
                <div className="text-gray-500 mt-2">Create your first delivery to get started</div>
                <Link to="/add-delivery" className="inline-block mt-4 px-6 py-2 bg-blue-600 text-white rounded-lg hover:opacity-90">
                  Add Delivery
                </Link>
              </>
            ) : (
              <>
                <div className="text-gray-400 text-lg">No deliveries match your filters</div>
                <div className="text-gray-500 mt-2">Try adjusting your search or filters</div>
              </>
            )}
          </div>
        ) : (
          <div className="px-6 py-4 border-t border-gray-100 text-sm text-gray-500">
            Showing <span className="font-medium text-gray-900">{filteredDeliveries.length}</span> of{' '}
            <span className="font-medium text-gray-900">{deliveries.length}</span> results
          </div>
        )}
      </div>

      {isPrintConfigOpen && (
        <PrintConfigModal
          deliveries={getPrintTargets()}
          onClose={() => setIsPrintConfigOpen(false)}
          selectedDate={selectedDate}
        />
      )}

      {activeDelivery && (
        <DeliveryDetailModal
          delivery={activeDelivery}
          onClose={() => setActiveDeliveryId(null)}
        />
      )}
    </div>
  );
};

export default Deliveries;
