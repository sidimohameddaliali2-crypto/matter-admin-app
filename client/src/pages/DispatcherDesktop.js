import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import {
  Search,
  MapPin,
  Clock,
  User,
  Phone,
  X,
  ChevronDown,
  ChevronLeft,
  Check,
  Plus,
  LogOut,
  Printer,
  CalendarDays,
  Briefcase,
  Route,
  Package,
  ListOrdered
} from 'lucide-react';
import { fetchEvents } from '../store/slices/eventSlice';
import { setSelectedEvent } from '../store/slices/eventSlice';
import EventCalendarView from '../components/events/EventCalendarView';
import EventDetailModal from '../components/events/EventDetailModal';
import api from '../utils/api';
import { recordActivityChange } from '../utils/activityCapture';
import DispatcherMapAssignModal from '../components/DispatcherMapAssignModal';
import RouteOptimizationModal from '../components/RouteOptimizationModal';
import ManualOrderModal from '../components/ManualOrderModal';
import { fetchDeliveries } from '../store/slices/deliverySlice';
import { fetchDrivers } from '../store/slices/driverSlice';
import { logout } from '../store/slices/authSlice';
import { formatClockFromSecondsSinceMidnight } from '../utils/businessTime';

const AREA_FILTER_OPTIONS = [
  'All',
  'Marina',
  'JVC',
  'Business Bay',
  'Abu Dhabi',
  'Sharjah',
  'Ajman'
];

// Matter's own `emirate` field sometimes carries a sub-area suffix (found
// live, 2026-09-22: "Abu Dhabi - Al Dana", "Abu Dhabi - Khalifa City", 8
// variants in total) and inconsistent casing ("DUBAI" vs "Dubai") — an
// emirate filter needs the real, clean emirate name, not a dozen near-
// duplicate entries that all mean the same emirate.
const normalizeEmirateLabel = (city) => {
  if (!city) return '';
  const base = city.split(' - ')[0].trim();
  return base.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
};

const statusPills = {
  pending: 'bg-amber-100 text-amber-800',
  assigned: 'bg-blue-100 text-blue-800',
  picked_up: 'bg-slate-100 text-slate-800',
  delivered: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-rose-100 text-rose-800'
};

const DispatcherDesktop = () => {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { deliveries = [], isLoading: deliveriesLoading } = useSelector(
    (state) => state.delivery
  );
  const { drivers = [] } = useSelector((state) => state.driver);
  const { user } = useSelector((state) => state.auth);

  const getTomorrowDate = () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow.toISOString().split('T')[0];
  };

  const [areaFilters, setAreaFilters] = useState([]);
  const [emirateFilters, setEmirateFilters] = useState([]);
  const [driverFilters, setDriverFilters] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [areaSearchTerm, setAreaSearchTerm] = useState('');
  const [timingFilters, setTimingFilters] = useState([]);
  const [selectedDeliveryIds, setSelectedDeliveryIds] = useState([]);
  const [assigningDriverId, setAssigningDriverId] = useState(null);
  const [activeAssignmentDeliveries, setActiveAssignmentDeliveries] = useState([]);
  const [unassigning, setUnassigning] = useState(false);
  // "Generate Route" preview in the Assign Driver modal (owner, 2026-09-14):
  // shows the route a driver would follow — their existing stops for the day
  // plus the delivery about to be assigned — and whether each one lands
  // early/on-time/late, all before actually assigning anything.
  const [routePreviewLoadingId, setRoutePreviewLoadingId] = useState(null);
  const [routePreview, setRoutePreview] = useState(null);
  const [routePreviewError, setRoutePreviewError] = useState('');
  const [feedback, setFeedback] = useState({ message: '', error: false });
  const [areaDropdownOpen, setAreaDropdownOpen] = useState(false);
  const [emirateDropdownOpen, setEmirateDropdownOpen] = useState(false);
  const [driverFilterDropdownOpen, setDriverFilterDropdownOpen] = useState(false);
  const [timingDropdownOpen, setTimingDropdownOpen] = useState(false);
  const [showUnassignedOnly, setShowUnassignedOnly] = useState(false);
  const [showCollectionsOnly, setShowCollectionsOnly] = useState(false);
  const [printMode, setPrintMode] = useState(false);
  const [mapModalOpen, setMapModalOpen] = useState(false);
  const [routeModalOpen, setRouteModalOpen] = useState(false);
  const [manualOrderModalOpen, setManualOrderModalOpen] = useState(false);
  const [printDriverFilter, setPrintDriverFilter] = useState(null);
  const [selectedDeliveryDetail, setSelectedDeliveryDetail] = useState(null);
  const [selectedDate, setSelectedDate] = useState(() => getTomorrowDate());
  const [editingDelivery, setEditingDelivery] = useState(null);
  const [showEventsModal, setShowEventsModal] = useState(false);
  const [eventsSelectedDay, setEventsSelectedDay] = useState(null);
  const [eventsDayEvents, setEventsDayEvents] = useState([]);
  const [showEventDetail, setShowEventDetail] = useState(false);
  const { events = [] } = useSelector((state) => state.events);
  const todayEventCount = events.filter((ev) => ev.eventDate && new Date(ev.eventDate).toDateString() === new Date().toDateString()).length;
  const [editForm, setEditForm] = useState({
    customerName: '',
    customerId: '',
    address: '',
    zone: '',
    notes: '',
    scheduledTime: ''
  });

  const areaButtonRef = useRef(null);
  const emirateButtonRef = useRef(null);
  const driverFilterButtonRef = useRef(null);
  const timingButtonRef = useRef(null);

  // Loads and assignment responses update state without becoming browser edits.
  const observedValues = useRef({});
  observedValues.current = {
    'Delivery areas': areaFilters, 'Delivery emirates': emirateFilters,
    'Delivery drivers': driverFilters, 'Delivery hours': timingFilters,
    'Unassigned deliveries only': showUnassignedOnly, 'Collection deliveries only': showCollectionsOnly,
    'Selected deliveries': selectedDeliveryIds, 'Delivery date': selectedDate
  };
  const deliveryRefs = ids => ids.map(id => deliveries.find(delivery => delivery._id === id)?.customerId || ('Delivery ' + id));
  const driverRefs = ids => ids.map(id => {
    if (id === 'unassigned') return 'Unassigned';
    const driver = drivers.find(item => item._id === id);
    return [driver?.profile?.firstName, driver?.profile?.lastName].filter(Boolean).join(' ') || ('Driver ' + id);
  });
  const changeObserved = (field, next, setter, format = value => value) => {
    const before = observedValues.current[field];
    const after = typeof next === 'function' ? next(before) : next;
    recordActivityChange({ field, before: format(before), after: format(after), form: 'Dispatcher filters and selection' });
    observedValues.current[field] = after;
    setter(after);
  };
  const toggleValue = (field, value, setter, format) => changeObserved(field,
    previous => previous.includes(value) ? previous.filter(item => item !== value) : [...previous, value], setter, format);

  const handleLogout = () => {
    dispatch(logout());
    navigate('/login', { replace: true });
  };

  useEffect(() => {
    const start = new Date(`${selectedDate}T00:00:00`);
    if (!Number.isNaN(start.getTime())) {
      const end = new Date(start);
      end.setDate(end.getDate() + 1);

      dispatch(fetchDeliveries({
        dateRange: 'custom',
        dateFrom: start.toISOString(),
        dateTo: end.toISOString(),
        limit: 1000
      }));
    }
    dispatch(fetchDrivers({ includeInactive: false }));
  }, [dispatch, selectedDate]);

  useEffect(() => {
    if (!feedback.message) return;
    const timer = setTimeout(() => setFeedback({ message: '', error: false }), 4200);
    return () => clearTimeout(timer);
  }, [feedback.message]);

  useEffect(() => {
    if (!areaDropdownOpen) return;
    const handleClickAway = (event) => {
      if (areaButtonRef.current && !areaButtonRef.current.contains(event.target)) {
        setAreaDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickAway);
    return () => document.removeEventListener('mousedown', handleClickAway);
  }, [areaDropdownOpen]);

  useEffect(() => {
    if (!emirateDropdownOpen) return;
    const handleClickAway = (event) => {
      if (emirateButtonRef.current && !emirateButtonRef.current.contains(event.target)) {
        setEmirateDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickAway);
    return () => document.removeEventListener('mousedown', handleClickAway);
  }, [emirateDropdownOpen]);

  useEffect(() => {
    if (!driverFilterDropdownOpen) return;
    const handleClickAway = (event) => {
      if (driverFilterButtonRef.current && !driverFilterButtonRef.current.contains(event.target)) {
        setDriverFilterDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickAway);
    return () => document.removeEventListener('mousedown', handleClickAway);
  }, [driverFilterDropdownOpen]);

  useEffect(() => {
    if (!timingDropdownOpen) return;
    const handleClickAway = (event) => {
      if (timingButtonRef.current && !timingButtonRef.current.contains(event.target)) {
        setTimingDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickAway);
    return () => document.removeEventListener('mousedown', handleClickAway);
  }, [timingDropdownOpen]);

  useEffect(() => {
    if (!deliveries.length) {
      setSelectedDeliveryIds([]);
      return;
    }
    setSelectedDeliveryIds((prev) => prev.filter((id) => deliveries.some((d) => d._id === id)));
  }, [deliveries]);

  const areaOptions = useMemo(() => {
    // When showing unassigned only, limit area options to areas that still have unassigned deliveries
    const areaSource = deliveries.filter((delivery) => !showUnassignedOnly || !delivery.driver);
    const zones = Array.from(
      new Set(
        areaSource
          .map((delivery) => delivery.zone)
          .filter(Boolean)
          .map((zone) => zone.trim())
      )
    ).filter((zone) => zone.length > 0);
    return zones.sort((a, b) => a.localeCompare(b));
  }, [deliveries, showUnassignedOnly]);

  // Emirate filter (owner, 2026-09-22) — reads addressDetails.city, the
  // field the Matter delivery import populates from each subscription's
  // address (see server/services/matterDeliveryImportService.js). Only
  // Matter-imported deliveries have this filled in today, so older/manual
  // deliveries just won't have an emirate to filter by yet.
  const emirateOptions = useMemo(() => {
    const emirateSource = deliveries.filter((delivery) => !showUnassignedOnly || !delivery.driver);
    const emirates = Array.from(
      new Set(
        emirateSource
          .map((delivery) => normalizeEmirateLabel(delivery.addressDetails?.city))
          .filter(Boolean)
      )
    );
    return emirates.sort((a, b) => a.localeCompare(b));
  }, [deliveries, showUnassignedOnly]);

  const filteredAreaOptions = useMemo(() => {
    if (!areaSearchTerm.trim()) {
      return areaOptions;
    }
    const normalizedSearch = areaSearchTerm.toLowerCase().trim();
    return areaOptions.filter(area => area.toLowerCase().includes(normalizedSearch));
  }, [areaOptions, areaSearchTerm]);

  const isWithinTimingFilter = (scheduledTime) => {
    if (timingFilters.length === 0) return true;
    const date = new Date(scheduledTime);
    const hour = date.getHours();
    return timingFilters.includes(hour);
  };

  const normalizedSearch = searchTerm.trim().toLowerCase();
  const normalizedAreaFilters = areaFilters.map((area) => area.toLowerCase().trim());
  const normalizedAreaFiltersKey = normalizedAreaFilters.join('|');
  const normalizedEmirateFilters = emirateFilters.map((emirate) => emirate.toLowerCase().trim());
  const normalizedEmirateFiltersKey = normalizedEmirateFilters.join('|');
  const driverFiltersKey = driverFilters.join('|');

  const filteredDeliveries = useMemo(() => {
    const processedDeliveries = deliveries || [];
    const filtered = processedDeliveries.filter((delivery) => {
      if (showUnassignedOnly && delivery.driver) {
        return false;
      }

      if (showCollectionsOnly && delivery.type !== 'Collection') {
        return false;
      }

      if (!isWithinTimingFilter(delivery.scheduledTime)) {
        return false;
      }

      const deliveryZone = (delivery.zone || '').toLowerCase().trim();
      const deliveryAddress = (delivery.address || '').toLowerCase();
      const areaMatch =
        normalizedAreaFilters.length === 0 ||
        normalizedAreaFilters.some((area) =>
          deliveryZone ? deliveryZone === area : deliveryAddress.includes(area)
        );

      if (!areaMatch) {
        return false;
      }

      const deliveryEmirate = normalizeEmirateLabel(delivery.addressDetails?.city).toLowerCase();
      const emirateMatch =
        normalizedEmirateFilters.length === 0 ||
        (deliveryEmirate && normalizedEmirateFilters.includes(deliveryEmirate));

      if (!emirateMatch) {
        return false;
      }

      const driverMatch =
        driverFilters.length === 0 ||
        driverFilters.includes(delivery.driver?._id) ||
        (driverFilters.includes('unassigned') && !delivery.driver);

      if (!driverMatch) {
        return false;
      }

      if (!normalizedSearch) {
        return true;
      }

      const matchesName = delivery.customerName?.toLowerCase().includes(normalizedSearch);
      const matchesCustomerId = delivery.customerId?.toLowerCase().includes(normalizedSearch);
      const matchesDeliveryId = (delivery._id || '').toLowerCase().includes(normalizedSearch);
      const matchesPhone = delivery.customerPhone?.toLowerCase().includes(normalizedSearch);

      return matchesName || matchesCustomerId || matchesDeliveryId || matchesPhone;
    });

    return filtered.sort(
      (a, b) => new Date(a.scheduledTime).getTime() - new Date(b.scheduledTime).getTime()
    );
  }, [deliveries, normalizedAreaFiltersKey, normalizedEmirateFiltersKey, driverFiltersKey, normalizedSearch, showUnassignedOnly, showCollectionsOnly, timingFilters]);

  const driverLoadCounts = useMemo(() => {
    const counts = {};
    deliveries.forEach((delivery) => {
      const driverId = delivery.driver?._id;
      if (!driverId) return;
      if (delivery.status === 'delivered') return;
      counts[driverId] = (counts[driverId] || 0) + 1;
    });
    return counts;
  }, [deliveries]);

  const sortedDrivers = useMemo(() => {
    return [...drivers].sort((a, b) => {
      const statusOrder = { available: 0, busy: 1, break: 2, offline: 3, not_working: 4 };
      const statusA = (a.profile?.status || 'available').toLowerCase();
      const statusB = (b.profile?.status || 'available').toLowerCase();
      const byStatus =
        (statusOrder[statusA] ?? 5) - (statusOrder[statusB] ?? 5) ||
        (driverLoadCounts[a._id] || 0) - (driverLoadCounts[b._id] || 0);
      if (byStatus !== 0) return byStatus;
      const nameA = `${a.profile?.firstName || ''} ${a.profile?.lastName || ''}`.trim();
      const nameB = `${b.profile?.firstName || ''} ${b.profile?.lastName || ''}`.trim();
      return nameA.localeCompare(nameB);
    });
  }, [drivers, driverLoadCounts]);

  const getDriverDisplayName = (driver) => {
    if (!driver) return 'Unassigned';
    const parts = [driver.profile?.firstName, driver.profile?.lastName].filter(Boolean);
    return parts.length > 0 ? parts.join(' ') : driver.email || 'Driver';
  };

  const driverNameMap = useMemo(() => {
    const map = {};
    sortedDrivers.forEach((d) => {
      map[d._id] = getDriverDisplayName(d);
    });
    return map;
  }, [sortedDrivers]);

  // 12-hour lowercase clock ("6:00am", "3:00am") — owner, 2026-09-22:
  // Matter's delivery_window label ("By 6 AM") should read this way once
  // converted to a scheduled time, not the previous 24-hour "06:00".
  // Minutes are always shown for consistency even on the hour.
  const formatTime = (value) => {
    if (!value) return '--:--';
    const date = new Date(value);
    let hours = date.getHours();
    const minutes = date.getMinutes();
    const ampm = hours >= 12 ? 'pm' : 'am';
    hours = hours % 12 || 12;
    const pad = (n) => String(n).padStart(2, '0');
    return `${hours}:${pad(minutes)}${ampm}`;
  };

  const formatDate = (value) => {
    if (!value) return '';
    const date = new Date(value);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
  };

  const getStatusLabel = (status) => {
    switch (status) {
      case 'pending':
        return 'Pending';
      case 'assigned':
        return 'Assigned';
      case 'picked_up':
        return 'Picked up';
      case 'delivered':
        return 'Delivered';
      case 'failed':
        return 'Failed';
      default:
        return 'Queued';
    }
  };

  const refreshDeliveriesForSelectedDate = () => {
    const start = new Date(`${selectedDate}T00:00:00`);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    dispatch(fetchDeliveries({
      dateRange: 'custom',
      dateFrom: start.toISOString(),
      dateTo: end.toISOString(),
      limit: 1000
    }));
  };

  const handleAssignDriver = async (driver) => {
    if (!activeAssignmentDeliveries.length || assigningDriverId) return;
    setAssigningDriverId(driver._id);
    const deliveryIds = activeAssignmentDeliveries.map((delivery) => delivery._id);
    try {
      await api.patch('/deliveries/assign-driver', {
        deliveryIds,
        driverId: driver._id
      });
      setFeedback({
        message: `Assigned to ${getDriverDisplayName(driver)}`,
        error: false
      });
      refreshDeliveriesForSelectedDate();
      setSelectedDeliveryIds([]);
      setActiveAssignmentDeliveries([]);
      setAreaFilters([]);
      setEmirateFilters([]);
      setTimingFilters([]);
      setDriverFilters([]);
      setRoutePreview(null);
      setRoutePreviewError('');
    } catch (error) {
      setFeedback({
        message:
          error.response?.data?.message ||
          error.message ||
          'Unable to assign this driver. Please retry.',
        error: true
      });
    } finally {
      setAssigningDriverId(null);
    }
  };

  // Preview-only: does not assign anything. Orders this driver's existing
  // stops for the selected date plus the delivery/deliveries about to be
  // assigned (by scheduled time, same fallback the driver app itself uses
  // for an unoptimized day), then asks the real /route-eta calculation for
  // each stop's predicted arrival and early/on-time/late status.
  const handleGenerateRoute = async (driver) => {
    setRoutePreviewError('');
    setRoutePreview(null);
    setRoutePreviewLoadingId(driver._id);
    try {
      const incomingIds = new Set(activeAssignmentDeliveries.map((d) => d._id));
      const existing = deliveries.filter(
        (d) => d.driver?._id === driver._id && d.status !== 'delivered' && !incomingIds.has(d._id)
      );
      const candidates = [...existing, ...activeAssignmentDeliveries].sort(
        (a, b) => new Date(a.scheduledTime).getTime() - new Date(b.scheduledTime).getTime()
      );
      const deliveryIds = candidates.map((d) => d._id);
      if (deliveryIds.length === 0) {
        setRoutePreview({ driverId: driver._id, stops: [], totals: null, departure: null, droppedCount: 0 });
        return;
      }
      const byId = new Map(candidates.map((d) => [d._id, d]));
      const { data } = await api.post('/deliveries/route-eta', {
        deliveryIds,
        vehicleType: driver.profile?.vehicleType,
        driverId: driver._id,
        date: selectedDate
      });
      const result = data?.data;
      const stops = (result?.stops || []).map((s) => ({
        ...s,
        customerName: byId.get(s.deliveryId)?.customerName || 'Customer',
        isNew: incomingIds.has(s.deliveryId)
      }));
      setRoutePreview({
        driverId: driver._id,
        departure: result?.departure || null,
        totals: result?.totals || null,
        stops,
        droppedCount: result?.droppedIds?.length || 0
      });
    } catch (error) {
      setRoutePreviewError(error.response?.data?.message || error.message || 'Could not generate the route.');
    } finally {
      setRoutePreviewLoadingId(null);
    }
  };

  const handleUnassignDriver = async (deliveriesToUnassign) => {
    const targets = (deliveriesToUnassign || []).filter((d) => d.driver);
    if (!targets.length || unassigning) return;
    if (!window.confirm(
      targets.length === 1
        ? 'Unassign the driver from this delivery?'
        : `Unassign the driver from ${targets.length} deliveries?`
    )) return;

    setUnassigning(true);
    try {
      const { data } = await api.patch('/deliveries/unassign-driver', {
        deliveryIds: targets.map((delivery) => delivery._id)
      });
      setFeedback({
        message: data?.message || 'Driver unassigned',
        error: false
      });
      refreshDeliveriesForSelectedDate();
      setSelectedDeliveryIds([]);
      setSelectedDeliveryDetail(null);
    } catch (error) {
      setFeedback({
        message:
          error.response?.data?.message ||
          error.message ||
          'Unable to unassign this delivery. Please retry.',
        error: true
      });
    } finally {
      setUnassigning(false);
    }
  };

  const toggleAreaSelection = area => toggleValue('Delivery areas', area, setAreaFilters);
  const toggleEmirateSelection = emirate => toggleValue('Delivery emirates', emirate, setEmirateFilters);
  const toggleDriverSelection = id => toggleValue('Delivery drivers', id, setDriverFilters, driverRefs);
  const toggleDeliverySelection = id => toggleValue('Selected deliveries', id, setSelectedDeliveryIds, deliveryRefs);
  const clearAreaFilters = () => changeObserved('Delivery areas', [], setAreaFilters);
  const clearEmirateFilters = () => changeObserved('Delivery emirates', [], setEmirateFilters);
  const clearDriverFilters = () => changeObserved('Delivery drivers', [], setDriverFilters, driverRefs);

  const areaLabel = areaFilters.length === 0 ? 'All Areas' : areaFilters.join(', ');
  const emirateLabel = emirateFilters.length === 0 ? 'All Emirates' : emirateFilters.join(', ');

  const driverLabel = useMemo(() => {
    if (driverFilters.length === 0) return 'All Drivers';
    const names = driverFilters.map((id) => (id === 'unassigned' ? 'Unassigned' : driverNameMap[id] || 'Driver'));
    if (names.length <= 2) return names.join(', ');
    return `${names.slice(0, 2).join(', ')}…`;
  }, [driverFilters, driverNameMap]);

  const selectedDeliveries = useMemo(
    () => deliveries.filter((delivery) => selectedDeliveryIds.includes(delivery._id)),
    [deliveries, selectedDeliveryIds]
  );

  return (
    <div className="min-h-screen bg-gray-100 p-6">
      {/* Header */}
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-4xl font-bold text-gray-900">Dispatcher Hub</h1>
          <p className="text-gray-600 mt-1">
            {user?.profile?.firstName ? `Welcome, ${user.profile.firstName}` : 'Delivery Management'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => { dispatch(fetchEvents()); navigate('/dispatcher/events'); }}
            className="relative flex items-center gap-2 px-4 py-2 bg-indigo-50 text-indigo-700 rounded-lg hover:bg-indigo-100 font-semibold"
          >
            <CalendarDays className="w-5 h-5" />
            Scheduled Events
            {todayEventCount > 0 && (
              <span className="absolute -top-2 -right-2 min-w-[20px] h-5 px-1 bg-red-500 text-white text-xs font-bold rounded-full flex items-center justify-center">
                {todayEventCount}
              </span>
            )}
          </button>
          <button
            onClick={handleLogout}
            className="flex items-center gap-2 px-4 py-2 bg-red-50 text-red-600 rounded-lg hover:bg-red-100 font-semibold"
          >
            <LogOut className="w-5 h-5" />
            Logout
          </button>
        </div>

        {/* Scheduled Events Modal */}
        {showEventsModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl mx-auto max-h-[90vh] flex flex-col">
              {/* Modal Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
                <div className="flex items-center gap-3">
                  {eventsSelectedDay ? (
                    <button
                      onClick={() => setEventsSelectedDay(null)}
                      className="flex items-center gap-1 text-indigo-600 font-semibold hover:text-indigo-800 mr-1"
                    >
                      <ChevronLeft className="w-5 h-5" /> Back
                    </button>
                  ) : (
                    <Briefcase className="w-6 h-6 text-indigo-600" />
                  )}
                  <h2 className="text-xl font-bold text-gray-900">
                    {eventsSelectedDay
                      ? eventsSelectedDay.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
                      : 'Scheduled Events'}
                  </h2>
                  {!eventsSelectedDay && todayEventCount > 0 && (
                    <span className="bg-red-500 text-white text-xs font-bold px-2 py-1 rounded-full">{todayEventCount} today</span>
                  )}
                  {eventsSelectedDay && (
                    <span className="bg-indigo-100 text-indigo-700 text-xs font-bold px-2 py-1 rounded-full">{eventsDayEvents.length} event{eventsDayEvents.length !== 1 ? 's' : ''}</span>
                  )}
                </div>
                <button onClick={() => { setShowEventsModal(false); setEventsSelectedDay(null); }} className="p-1 hover:bg-gray-100 rounded-lg">
                  <X className="w-5 h-5 text-gray-500" />
                </button>
              </div>
              {/* Modal Body */}
              <div className="overflow-y-auto flex-1 p-4">
                {events.length === 0 ? (
                  <p className="text-center text-gray-400 py-10">No events found.</p>
                ) : eventsSelectedDay ? (
                  /* Day Detail View */
                  <div className="space-y-4">
                    {eventsDayEvents.length === 0 ? (
                      <p className="text-center text-gray-400 py-10">No events on this day.</p>
                    ) : (
                      eventsDayEvents.map((ev) => (
                        <div key={ev._id} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden cursor-pointer hover:shadow-md transition" onClick={() => { dispatch(setSelectedEvent(ev)); setShowEventDetail(true); }}>
                          <div className={`px-4 py-3 flex items-center justify-between ${
                            ev.status === 'confirmed' ? 'bg-emerald-50 border-b border-emerald-200' :
                            ev.status === 'cancelled' ? 'bg-gray-100 border-b border-gray-200' :
                            'bg-indigo-50 border-b border-indigo-200'
                          }`}>
                            <div>
                              <p className={`font-bold text-base ${ev.status === 'cancelled' ? 'line-through text-gray-400' : 'text-gray-900'}`}>{ev.eventName}</p>
                              <p className="text-sm text-gray-500">{ev.companyName}</p>
                            </div>
                            <span className={`text-xs font-bold px-3 py-1 rounded-full ${
                              ev.status === 'confirmed' ? 'bg-emerald-100 text-emerald-700' :
                              ev.status === 'cancelled' ? 'bg-gray-200 text-gray-500' :
                              'bg-amber-100 text-amber-700'
                            }`}>{ev.status}</span>
                          </div>
                          <div className="px-4 py-3 grid grid-cols-2 gap-3 text-sm">
                            {ev.arrivalTime && (
                              <div className="flex items-center gap-2">
                                <Clock className="w-4 h-4 text-indigo-400 shrink-0" />
                                <div>
                                  <p className="text-xs text-gray-400">Arrival</p>
                                  <p className="font-semibold text-gray-800">{ev.arrivalTime}</p>
                                </div>
                              </div>
                            )}
                            {ev.logistics?.guestCount > 0 && (
                              <div className="flex items-center gap-2">
                                <User className="w-4 h-4 text-indigo-400 shrink-0" />
                                <div>
                                  <p className="text-xs text-gray-400">Guests</p>
                                  <p className="font-semibold text-gray-800">{ev.logistics.guestCount}</p>
                                </div>
                              </div>
                            )}
                            {ev.venue?.address && (
                              <div className="flex items-start gap-2 col-span-2">
                                <MapPin className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                                <div>
                                  <p className="text-xs text-gray-400">{ev.emirate}</p>
                                  <p className="font-semibold text-gray-800">{ev.venue.address}</p>
                                </div>
                              </div>
                            )}
                          </div>
                          {(ev.logistics?.food || []).length > 0 && (
                            <div className="px-4 pb-3">
                              <p className="text-xs font-semibold text-gray-400 mb-1">Food Items</p>
                              <div className="flex flex-wrap gap-1">
                                {ev.logistics.food.map((f, i) => (
                                  <span key={i} className="text-xs bg-green-50 text-green-700 border border-green-200 px-2 py-0.5 rounded-full">{f.name}</span>
                                ))}
                              </div>
                            </div>
                          )}
                          {ev.notes && (
                            <div className="px-4 pb-3">
                              <p className="text-xs text-gray-500 italic">{ev.notes}</p>
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                ) : (
                  /* Calendar View */
                  <EventCalendarView
                    events={events}
                    onEventClick={() => {}}
                    onDayClick={(day, dayEvts) => { setEventsSelectedDay(day); setEventsDayEvents(dayEvts); }}
                    hideDetailPanel
                  />
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="bg-white rounded-lg shadow-sm p-6 mb-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-4 mb-4">
          {/* Date Picker */}
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">Date</label>
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Search */}
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">Search</label>
            <div className="relative">
              <Search className="absolute left-3 top-3 w-4 h-4 text-gray-400" />
              <input
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Customer, ID..."
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          {/* Area Filter */}
          <div ref={areaButtonRef} className="relative">
            <label className="block text-sm font-semibold text-gray-700 mb-2">Area</label>
            <button
              onClick={() => setAreaDropdownOpen(!areaDropdownOpen)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg text-left bg-white hover:bg-gray-50 flex justify-between items-center"
            >
              <span className="truncate text-sm">{areaLabel}</span>
              <ChevronDown className={`w-4 h-4 transition ${areaDropdownOpen ? 'rotate-180' : ''}`} />
            </button>
            {areaDropdownOpen && (
              <div className="absolute top-full left-0 right-0 mt-2 bg-white border border-gray-300 rounded-lg shadow-lg z-30 max-h-96 overflow-y-auto">
                <div className="sticky top-0 bg-white p-3 border-b border-gray-200">
                  <input
                    type="text"
                    placeholder="Search areas..."
                    value={areaSearchTerm}
                    onChange={(e) => setAreaSearchTerm(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div className="p-2">
                  {filteredAreaOptions.map((area) => (
                    <button
                      key={area}
                      onClick={() => toggleAreaSelection(area)}
                      className={`w-full text-left px-4 py-2 rounded text-sm flex items-center justify-between hover:bg-gray-100 ${
                        areaFilters.includes(area) ? 'bg-blue-50 text-blue-600' : ''
                      }`}
                    >
                      <span>{area}</span>
                      {areaFilters.includes(area) && <Check className="w-4 h-4" />}
                    </button>
                  ))}
                </div>
                <div className="border-t border-gray-200 p-2">
                  <button
                    onClick={clearAreaFilters}
                    className="w-full text-sm text-blue-600 font-semibold hover:bg-blue-50 px-4 py-2 rounded"
                  >
                    Clear All
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Emirate Filter */}
          <div ref={emirateButtonRef} className="relative">
            <label className="block text-sm font-semibold text-gray-700 mb-2">Emirate</label>
            <button
              onClick={() => setEmirateDropdownOpen(!emirateDropdownOpen)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg text-left bg-white hover:bg-gray-50 flex justify-between items-center"
            >
              <span className="truncate text-sm">{emirateLabel}</span>
              <ChevronDown className={`w-4 h-4 transition ${emirateDropdownOpen ? 'rotate-180' : ''}`} />
            </button>
            {emirateDropdownOpen && (
              <div className="absolute top-full left-0 right-0 mt-2 bg-white border border-gray-300 rounded-lg shadow-lg z-30 max-h-96 overflow-y-auto">
                <div className="p-2">
                  {emirateOptions.length === 0 ? (
                    <p className="px-4 py-2 text-sm text-gray-400">No emirate data on today's deliveries yet.</p>
                  ) : (
                    emirateOptions.map((emirate) => (
                      <button
                        key={emirate}
                        onClick={() => toggleEmirateSelection(emirate)}
                        className={`w-full text-left px-4 py-2 rounded text-sm flex items-center justify-between hover:bg-gray-100 ${
                          emirateFilters.includes(emirate) ? 'bg-blue-50 text-blue-600' : ''
                        }`}
                      >
                        <span>{emirate}</span>
                        {emirateFilters.includes(emirate) && <Check className="w-4 h-4" />}
                      </button>
                    ))
                  )}
                </div>
                <div className="border-t border-gray-200 p-2">
                  <button
                    onClick={clearEmirateFilters}
                    className="w-full text-sm text-blue-600 font-semibold hover:bg-blue-50 px-4 py-2 rounded"
                  >
                    Clear All
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Driver Filter */}
          <div ref={driverFilterButtonRef} className="relative">
            <label className="block text-sm font-semibold text-gray-700 mb-2">Driver</label>
            <button
              onClick={() => setDriverFilterDropdownOpen(!driverFilterDropdownOpen)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg text-left bg-white hover:bg-gray-50 flex justify-between items-center"
            >
              <span className="truncate text-sm">{driverLabel}</span>
              <ChevronDown className={`w-4 h-4 shrink-0 transition ${driverFilterDropdownOpen ? 'rotate-180' : ''}`} />
            </button>
            {driverFilterDropdownOpen && (
              <div className="absolute top-full left-0 right-0 mt-2 bg-white border border-gray-300 rounded-lg shadow-lg z-30 max-h-96 overflow-y-auto">
                <div className="p-2">
                  <button
                    onClick={() => toggleDriverSelection('unassigned')}
                    className={`w-full text-left px-4 py-2 rounded text-sm flex items-center justify-between hover:bg-gray-100 ${
                      driverFilters.includes('unassigned') ? 'bg-blue-50 text-blue-600' : ''
                    }`}
                  >
                    <span>Unassigned</span>
                      {driverFilters.includes('unassigned') && <Check className="w-4 h-4 shrink-0" />}
                  </button>
                  {sortedDrivers.map((driver) => {
                    const checked = driverFilters.includes(driver._id);
                    return (
                      <button
                        key={driver._id}
                        onClick={() => toggleDriverSelection(driver._id)}
                        className={`w-full text-left px-4 py-2 rounded text-sm flex items-center justify-between hover:bg-gray-100 ${
                          checked ? 'bg-blue-50 text-blue-600' : ''
                        }`}
                      >
                        <span>{getDriverDisplayName(driver)}</span>
                        {checked && <Check className="w-4 h-4 shrink-0" />}
                      </button>
                    );
                  })}
                </div>
                <div className="border-t border-gray-200 p-2">
                  <button
                    onClick={clearDriverFilters}
                    className="w-full text-sm text-blue-600 font-semibold hover:bg-blue-50 px-4 py-2 rounded"
                  >
                    Clear All
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Timing Filter */}
          <div ref={timingButtonRef} className="relative">
            <label className="block text-sm font-semibold text-gray-700 mb-2">Timing</label>
            <button
              onClick={() => setTimingDropdownOpen(!timingDropdownOpen)}
              className={`w-full px-4 py-2 border rounded-lg text-left text-sm flex justify-between items-center ${
                timingFilters.length > 0
                  ? 'bg-blue-50 border-blue-300 text-blue-600 font-semibold'
                  : 'bg-white border-gray-300'
              }`}
            >
              <span>{timingFilters.length === 0 ? 'Select Hours' : `${timingFilters.length} hour(s)`}</span>
              <ChevronDown className={`w-4 h-4 transition ${timingDropdownOpen ? 'rotate-180' : ''}`} />
            </button>
            {timingDropdownOpen && (
              <div className="absolute top-full left-0 right-0 mt-2 bg-white border border-gray-300 rounded-lg shadow-lg z-30 max-h-64 overflow-y-auto">
                <div className="grid grid-cols-3 gap-2 p-3">
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((hour) => (
                    <button
                      key={hour}
                      onClick={() => toggleValue('Delivery hours', hour, setTimingFilters, hours => hours.map(value => value + 'am'))}
                      className={`px-3 py-2 rounded text-xs font-semibold ${
                        timingFilters.includes(hour)
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                      }`}
                    >
                      {hour}am
                    </button>
                  ))}
                </div>
                <div className="border-t border-gray-200 p-2">
                  <button
                    onClick={() => changeObserved('Delivery hours', [], setTimingFilters, hours => hours.map(hour => hour + 'am'))}
                    className="w-full text-sm text-blue-600 font-semibold hover:bg-blue-50 px-4 py-2 rounded"
                  >
                    Clear
                  </button>
                </div>
              </div>
            )}
          </div>

        </div>

        {/* Action Bar */}
        <div className="flex flex-wrap items-center justify-end gap-2 mb-2 sm:justify-end justify-center">
          <button
            onClick={() => changeObserved('Unassigned deliveries only', value => !value, setShowUnassignedOnly)}
            className={`px-4 py-2 rounded-lg font-semibold text-sm transition w-full sm:w-auto ${
              showUnassignedOnly
                ? 'bg-orange-500 text-white'
                : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50'
            }`}
          >
            📦 Unassigned
          </button>
          <button
            onClick={() => changeObserved('Collection deliveries only', value => !value, setShowCollectionsOnly)}
            className={`px-4 py-2 rounded-lg font-semibold text-sm transition w-full sm:w-auto ${
              showCollectionsOnly
                ? 'bg-teal-500 text-white'
                : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50'
            }`}
          >
            🗂️ Collections
          </button>
          <button
            onClick={() => setPrintMode(true)}
            className="w-full sm:w-auto px-4 py-2 rounded-lg font-semibold text-sm bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 flex items-center gap-2"
          >
            <Printer className="w-4 h-4" />
            Print
          </button>
          <button
            onClick={() => setMapModalOpen(true)}
            className="w-full sm:w-auto px-4 py-2 rounded-lg font-semibold text-sm bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 flex items-center gap-2"
          >
            <MapPin className="w-4 h-4" />
            Map
          </button>
          <button
            onClick={() => navigate(`/dispatcher/driver-routes?date=${selectedDate}`)}
            className="w-full sm:w-auto px-4 py-2 rounded-lg font-semibold text-sm bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 flex items-center gap-2"
            title="See each driver's assigned deliveries and route on a 2GIS map"
          >
            <Route className="w-4 h-4" />
            Driver Routes
          </button>
          <button
            onClick={() => setManualOrderModalOpen(true)}
            className="w-full sm:w-auto px-4 py-2 rounded-lg font-semibold text-sm bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 flex items-center gap-2"
            title="Manually choose which delivery is first/last for a driver"
          >
            <ListOrdered className="w-4 h-4" />
            Arrange Order
          </button>
        </div>

        {/* Selection Bar */}
        {selectedDeliveryIds.length > 0 && (
          <div className="flex items-center justify-between bg-blue-50 border border-blue-200 rounded-lg p-4">
            <span className="font-semibold text-blue-900">{selectedDeliveryIds.length} Selected</span>
            <div className="flex gap-2">
              <button
                onClick={() => setActiveAssignmentDeliveries(selectedDeliveries)}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700"
              >
                Assign to Driver
              </button>
              <button
                onClick={() => handleUnassignDriver(selectedDeliveries)}
                disabled={unassigning || !selectedDeliveries.some((d) => d.driver)}
                className="px-4 py-2 bg-white border border-red-300 text-red-600 rounded-lg font-semibold hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Unassign
              </button>
              <button
                onClick={() => setRouteModalOpen(true)}
                className="px-4 py-2 bg-white border border-blue-300 text-blue-700 rounded-lg font-semibold hover:bg-blue-50"
              >
                Optimize Routes
              </button>
              <button
                onClick={() => changeObserved('Selected deliveries', [], setSelectedDeliveryIds, deliveryRefs)}
                className="px-4 py-2 bg-white border border-blue-300 text-blue-600 rounded-lg font-semibold hover:bg-blue-50"
              >
                Clear
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Main Table */}
      <div className="bg-white rounded-lg shadow-sm overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-6 py-4 text-left">
                <input
                  type="checkbox"
                  checked={selectedDeliveryIds.length > 0 && filteredDeliveries.every(d => selectedDeliveryIds.includes(d._id))}
                  onChange={() => {
                    if (selectedDeliveryIds.length > 0 && filteredDeliveries.every(d => selectedDeliveryIds.includes(d._id))) {
                      changeObserved('Selected deliveries', [], setSelectedDeliveryIds, deliveryRefs);
                    } else {
                      changeObserved('Selected deliveries', filteredDeliveries.map(d => d._id), setSelectedDeliveryIds, deliveryRefs);
                    }
                  }}
                  className="w-4 h-4 text-blue-600 rounded border-gray-300"
                />
              </th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-700">Customer ID</th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-700">Customer Name</th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-700">Time</th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-700">Location</th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-700">Zone</th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-700">Driver</th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-700">Status</th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-700">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {deliveriesLoading ? (
              <tr>
                <td colSpan="9" className="px-6 py-12 text-center text-gray-500">
                  Loading deliveries...
                </td>
              </tr>
            ) : filteredDeliveries.length === 0 ? (
              <tr>
                <td colSpan="9" className="px-6 py-12 text-center text-gray-500">
                  No deliveries found
                </td>
              </tr>
            ) : (
              filteredDeliveries.map((delivery) => (
                <tr key={delivery._id} className="hover:bg-gray-50 transition">
                  <td className="px-6 py-4">
                    <input
                      type="checkbox"
                      checked={selectedDeliveryIds.includes(delivery._id)}
                      onChange={() => toggleDeliverySelection(delivery._id)}
                      className="w-4 h-4 text-blue-600 rounded border-gray-300"
                    />
                  </td>
                  <td className="px-6 py-4 text-sm font-medium text-gray-900">{delivery.customerId}</td>
                  <td className="px-6 py-4 text-sm text-gray-700">
                    {delivery.customerName}
                    {delivery.combinedSunday && (
                      <span
                        title="Sunday's delivery is included — no separate Sunday trip needed for this customer."
                        className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-indigo-100 text-indigo-700 align-middle"
                      >
                        <Package className="w-3 h-3" />
                        +Sun
                      </span>
                    )}
                    {delivery.sundayOnlyCarriedOver && (
                      <span
                        title="This customer only has a Sunday meal — delivered together with Saturday's route since there's no separate Sunday route."
                        className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700 align-middle"
                      >
                        <Package className="w-3 h-3" />
                        Sun only
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600">{formatTime(delivery.scheduledTime)}</td>
                  <td className="px-6 py-4 text-sm text-gray-600">{delivery.address || '-'}</td>
                  <td className="px-6 py-4 text-sm text-gray-600">{delivery.zone || '-'}</td>
                  <td className="px-6 py-4 text-sm">
                    <span className="font-medium text-gray-900">{getDriverDisplayName(delivery.driver)}</span>
                  </td>
                  <td className="px-6 py-4 text-sm">
                    <span className={`px-3 py-1 rounded-full text-xs font-semibold ${statusPills[delivery.status]}`}>
                      {getStatusLabel(delivery.status)}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-sm space-x-2 flex">
                    <button
                      onClick={() => setSelectedDeliveryDetail(delivery)}
                      className="text-gray-600 hover:text-gray-900 font-semibold text-xs px-2 py-1 rounded hover:bg-gray-100 transition"
                    >
                      View
                    </button>
                    <button
                      onClick={() => {
                        let scheduledValue = '';
                        if (delivery.scheduledTime) {
                          const date = new Date(delivery.scheduledTime);
                          const year = date.getFullYear();
                          const month = String(date.getMonth() + 1).padStart(2, '0');
                          const day = String(date.getDate()).padStart(2, '0');
                          const hours = String(date.getHours()).padStart(2, '0');
                          const minutes = String(date.getMinutes()).padStart(2, '0');
                          scheduledValue = `${year}-${month}-${day}T${hours}:${minutes}`;
                        }
                        setEditingDelivery(delivery);
                        setEditForm({
                          customerName: delivery.customerName || '',
                          customerId: delivery.customerId || '',
                          address: delivery.address || '',
                          zone: delivery.zone || '',
                          notes: delivery.notes || '',
                          scheduledTime: scheduledValue
                        });
                      }}
                      className="text-green-600 hover:text-green-800 font-semibold text-xs px-2 py-1 rounded hover:bg-green-50 transition"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => setActiveAssignmentDeliveries([delivery])}
                      className="text-blue-600 hover:text-blue-800 font-semibold text-xs px-2 py-1 rounded hover:bg-blue-50 transition"
                    >
                      Assign
                    </button>
                    {delivery.driver && (
                      <button
                        onClick={() => handleUnassignDriver([delivery])}
                        disabled={unassigning}
                        className="text-red-600 hover:text-red-800 font-semibold text-xs px-2 py-1 rounded hover:bg-red-50 transition disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Unassign
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Driver Assignment Modal */}
      {activeAssignmentDeliveries.length > 0 && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-40 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-lg max-w-3xl w-full max-h-[85vh] flex flex-col">
            <div className="flex justify-between items-center p-6 border-b border-gray-200">
              <h2 className="text-xl font-bold text-gray-900">Assign Driver</h2>
              <button
                onClick={() => {
                  setActiveAssignmentDeliveries([]);
                  setRoutePreview(null);
                  setRoutePreviewError('');
                }}
                className="p-1 hover:bg-gray-100 rounded"
              >
                <X className="w-6 h-6 text-gray-600" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              <div className="mb-6 bg-gray-50 p-4 rounded-lg">
                <p className="text-sm text-gray-600 mb-2">Assigning:</p>
                {activeAssignmentDeliveries.map((d) => (
                  <p key={d._id} className="font-semibold text-gray-900">{d.customerName}</p>
                ))}
              </div>

              <h3 className="font-semibold text-gray-900 mb-4">Select Driver:</h3>
              <div className="space-y-2">
                {sortedDrivers.map((driver) => (
                  <div key={driver._id} className="border border-gray-300 rounded-lg transition">
                    <div className="w-full p-4 flex items-center justify-between gap-3">
                      <div>
                        <p className="font-semibold text-gray-900">{getDriverDisplayName(driver)}</p>
                        <p className="text-xs text-gray-500">{driverLoadCounts[driver._id] || 0} deliveries</p>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <button
                          type="button"
                          onClick={() => handleGenerateRoute(driver)}
                          disabled={routePreviewLoadingId === driver._id}
                          className="px-3 py-1.5 text-xs font-semibold text-indigo-700 border border-indigo-300 rounded-lg hover:bg-indigo-50 disabled:opacity-50 flex items-center gap-1.5"
                          title="Preview the route this driver would follow with this delivery included, and whether each stop lands early or late"
                        >
                          <Route className="w-3.5 h-3.5" />
                          {routePreviewLoadingId === driver._id ? 'Generating…' : 'Generate Route'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleAssignDriver(driver)}
                          disabled={assigningDriverId === driver._id}
                          className="px-4 py-1.5 text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
                        >
                          {assigningDriverId === driver._id ? 'Assigning…' : 'Assign'}
                        </button>
                      </div>
                    </div>

                    {routePreview?.driverId === driver._id ? (
                      <div className="px-4 pb-4 -mt-1 border-t border-gray-100 pt-3">
                        {routePreview.stops.length === 0 ? (
                          <p className="text-xs text-gray-500">No other stops today — this would be the only delivery.</p>
                        ) : (
                          <>
                            {routePreview.departure ? (
                              <p className="text-xs text-gray-600 mb-2">
                                Leaving the kitchen at <strong>{formatClockFromSecondsSinceMidnight(routePreview.departure.seconds)}</strong>
                                {routePreview.departure.reason === 'capped' ? ' (earliest allowed)' : ''}
                                {routePreview.departure.reason === 'earlier' ? ' (earlier than usual, for this route)' : ''}
                              </p>
                            ) : null}
                            <ol className="space-y-1.5">
                              {routePreview.stops.map((s, idx) => {
                                const statusStyle = s.status === 'late'
                                  ? 'bg-rose-100 text-rose-800'
                                  : s.status === 'early'
                                    ? 'bg-amber-100 text-amber-800'
                                    : s.status === 'on_time'
                                      ? 'bg-emerald-100 text-emerald-800'
                                      : 'bg-gray-100 text-gray-600';
                                const statusLabel = s.status === 'late'
                                  ? `Late ${Math.round(s.lateSeconds / 60)}m`
                                  : s.status === 'early'
                                    ? `Early ${Math.round(s.earlySeconds / 60)}m`
                                    : s.status === 'on_time'
                                      ? 'On time'
                                      : '—';
                                return (
                                  <li key={s.deliveryId} className="flex items-center justify-between gap-2 text-xs bg-gray-50 rounded px-2 py-1.5">
                                    <span className="flex items-center gap-2 min-w-0">
                                      <span className="text-gray-400 flex-shrink-0">{idx + 1}.</span>
                                      <span className={`truncate ${s.isNew ? 'font-semibold text-blue-700' : 'text-gray-800'}`}>
                                        {s.customerName}{s.isNew ? ' (new)' : ''}
                                      </span>
                                    </span>
                                    <span className="flex items-center gap-2 flex-shrink-0">
                                      <span className="text-gray-500">{formatClockFromSecondsSinceMidnight(s.etaSeconds)}</span>
                                      <span className={`px-2 py-0.5 rounded-full font-semibold ${statusStyle}`}>{statusLabel}</span>
                                    </span>
                                  </li>
                                );
                              })}
                            </ol>
                            {routePreview.totals ? (
                              <p className="text-xs text-gray-600 mt-2">
                                Back at the kitchen ~<strong>{formatClockFromSecondsSinceMidnight(routePreview.totals.backAtKitchenSeconds)}</strong>
                                {' · '}{routePreview.totals.onTime} on time, {routePreview.totals.early} early, {routePreview.totals.late} late
                              </p>
                            ) : null}
                            {routePreview.droppedCount > 0 ? (
                              <p className="text-xs text-amber-700 mt-1">{routePreview.droppedCount} stop(s) skipped — no location on file.</p>
                            ) : null}
                          </>
                        )}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
              {routePreviewError ? (
                <p className="text-xs text-red-700 mt-3">{routePreviewError}</p>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {/* Print Modal */}
      {printMode && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-lg max-w-2xl w-full max-h-96 flex flex-col">
            <div className="flex justify-between items-center p-6 border-b border-gray-200">
              <h2 className="text-lg font-bold text-gray-900">Print Delivery List</h2>
              <button
                onClick={() => setPrintMode(false)}
                className="p-1 hover:bg-gray-100 rounded"
              >
                <X className="w-5 h-5 text-gray-600" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              <label className="block text-sm font-semibold text-gray-700 mb-3">
                Filter by Driver (Optional)
              </label>
              <select
                value={printDriverFilter || ''}
                onChange={(e) => setPrintDriverFilter(e.target.value || null)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none mb-6"
              >
                <option value="">All Drivers</option>
                <option value="unassigned">Unassigned Only</option>
                {sortedDrivers.map((driver) => (
                  <option key={driver._id} value={driver._id}>
                    {getDriverDisplayName(driver)}
                  </option>
                ))}
              </select>

              <div className="bg-gray-50 p-4 rounded-lg">
                <p className="font-semibold text-gray-900 mb-3">
                  Preview ({filteredDeliveries.filter(d => {
                    if (!printDriverFilter) return true;
                    if (printDriverFilter === 'unassigned') return !d.driver;
                    return d.driver?._id === printDriverFilter;
                  }).length} deliveries)
                </p>
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {filteredDeliveries
                    .filter(d => {
                      if (!printDriverFilter) return true;
                      if (printDriverFilter === 'unassigned') return !d.driver;
                      return d.driver?._id === printDriverFilter;
                    })
                    .map((delivery, idx) => (
                      <div key={delivery._id} className="text-xs text-gray-700 py-1">
                        {idx + 1}. {delivery.customerId} | {delivery.customerName} | {getDriverDisplayName(delivery.driver)} | {formatTime(delivery.scheduledTime)} | {delivery.zone || delivery.address}
                      </div>
                    ))}
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 p-6 border-t border-gray-200">
              <button
                onClick={() => setPrintMode(false)}
                className="px-4 py-2 text-sm font-semibold text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const printDeliveries = filteredDeliveries.filter(d => {
                    if (!printDriverFilter) return true;
                    if (printDriverFilter === 'unassigned') return !d.driver;
                    return d.driver?._id === printDriverFilter;
                  });

                  const printWindow = window.open('', '', 'height=600,width=800');
                  const html = `
                    <!DOCTYPE html>
                    <html>
                    <head>
                      <title>Delivery List - ${selectedDate}</title>
                      <style>
                        body {
                          font-family: Arial, sans-serif;
                          margin: 20px;
                          font-size: 12px;
                        }
                        h1 {
                          font-size: 16px;
                          margin-bottom: 10px;
                        }
                        table {
                          width: 100%;
                          border-collapse: collapse;
                          margin-top: 10px;
                        }
                        th, td {
                          border: 1px solid #ddd;
                          padding: 8px;
                          text-align: left;
                        }
                        th {
                          background-color: #f0f0f0;
                          font-weight: bold;
                        }
                        tr:nth-child(even) {
                          background-color: #f9f9f9;
                        }
                      </style>
                    </head>
                    <body>
                      <h1>Delivery List - ${selectedDate}</h1>
                      <table>
                        <thead>
                          <tr>
                            <th>#</th>
                            <th>Customer ID</th>
                            <th>Customer Name</th>
                            <th>Driver</th>
                            <th>Time</th>
                            <th>Zone</th>
                            <th>Location</th>
                          </tr>
                        </thead>
                        <tbody>
                          ${printDeliveries.map((d, idx) => `
                            <tr>
                              <td>${idx + 1}</td>
                              <td>${d.customerId}</td>
                              <td>${d.customerName}</td>
                              <td>${getDriverDisplayName(d.driver)}</td>
                              <td>${formatTime(d.scheduledTime)}</td>
                              <td>${d.zone || '-'}</td>
                              <td>${d.address || '-'}</td>
                            </tr>
                          `).join('')}
                        </tbody>
                      </table>
                    </body>
                    </html>
                  `;
                  printWindow.document.write(html);
                  printWindow.document.close();
                  setTimeout(() => {
                    printWindow.print();
                  }, 250);
                  setPrintMode(false);
                }}
                className="px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700"
              >
                Print
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delivery Detail Modal */}
      {selectedDeliveryDetail && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full my-8">
            <div className="flex justify-between items-center p-6 border-b border-gray-200 sticky top-0 bg-white rounded-t-xl">
              <div>
                <h2 className="text-xl font-semibold text-gray-900">Delivery Details</h2>
                <p className="text-sm text-gray-500">{selectedDeliveryDetail.customerId}</p>
              </div>
              <button
                onClick={() => setSelectedDeliveryDetail(null)}
                className="p-1 hover:bg-gray-100 rounded-lg transition"
              >
                <X className="w-5 h-5 text-gray-600" />
              </button>
            </div>

            <div className="overflow-y-auto max-h-[70vh] p-6 space-y-4">
              {/* Delivery Proof Images */}
              {selectedDeliveryDetail.proof?.images && selectedDeliveryDetail.proof.images.length > 0 && (
                <div className="border-b border-gray-200 pb-4">
                  <h3 className="text-sm font-semibold text-gray-600 mb-3">📸 Proof of Delivery</h3>
                  <div className="grid grid-cols-3 gap-3">
                    {selectedDeliveryDetail.proof.images.map((image, idx) => (
                      <div key={idx} className="relative">
                        <img 
                          src={image} 
                          alt={`Proof ${idx + 1}`}
                          className="w-full h-32 object-cover rounded-lg border border-gray-200"
                          onError={(e) => {
                            e.target.src = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22100%22 height=%2100%22%3E%3Crect width=%22100%22 height=%22100%22 fill=%22%23f3f4f6%22/%3E%3Ctext x=%2250%25%22 y=%2250%25%22 text-anchor=%22middle%22 dominant-baseline=%22middle%22 fill=%22%239ca3af%22 font-size=%2212%22%3ENo Image%3C/text%3E%3C/svg%3E';
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Delivery Timing */}
              <div className="bg-gradient-to-r from-blue-50 to-blue-100 border border-blue-200 rounded-lg p-4 mb-4">
                <h3 className="text-sm font-semibold text-blue-900 mb-3">⏰ Timing Details</h3>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <p className="text-blue-700">Scheduled Time:</p>
                    <p className="font-semibold text-blue-900">{formatTime(selectedDeliveryDetail.scheduledTime)}</p>
                  </div>
                  <div className="flex justify-between">
                    <p className="text-blue-700">Scheduled Date:</p>
                    <p className="font-semibold text-blue-900">{formatDate(selectedDeliveryDetail.scheduledTime)}</p>
                  </div>
                  {selectedDeliveryDetail.deliveredTime && (
                    <>
                      <div className="flex justify-between pt-2 border-t border-blue-200">
                        <p className="text-green-700 font-semibold">Delivered Time:</p>
                        <p className="font-semibold text-green-900">{formatTime(selectedDeliveryDetail.deliveredTime)}</p>
                      </div>
                      <div className="flex justify-between">
                        <p className="text-green-700 font-semibold">Delivered Date:</p>
                        <p className="font-semibold text-green-900">{formatDate(selectedDeliveryDetail.deliveredTime)}</p>
                      </div>
                    </>
                  )}
                  {selectedDeliveryDetail.lateMinutes > 0 && (
                    <div className="flex justify-between pt-2 border-t border-blue-200">
                      <p className="text-red-700 font-semibold">Late by:</p>
                      <p className="font-semibold text-red-900">{selectedDeliveryDetail.lateMinutes} minutes</p>
                    </div>
                  )}
                  {selectedDeliveryDetail.earlyMinutes > 0 && (
                    <div className="flex justify-between pt-2 border-t border-blue-200">
                      <p className="text-emerald-700 font-semibold">Early by:</p>
                      <p className="font-semibold text-emerald-900">{selectedDeliveryDetail.earlyMinutes} minutes</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Delivery Timeline */}
              <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-4">
                <h3 className="text-sm font-semibold text-gray-900 mb-3">📜 Delivery Timeline</h3>
                <div className="space-y-4">
                  {selectedDeliveryDetail.timeline && selectedDeliveryDetail.timeline.length > 0 ? (
                    selectedDeliveryDetail.timeline.map((event, index) => (
                      <div key={index} className="flex items-start space-x-4">
                        <div className={`w-3 h-3 rounded-full mt-2 ${
                          event.status === 'delivered' ? 'bg-green-500' :
                          event.status === 'failed' ? 'bg-red-500' :
                          event.status === 'picked_up' ? 'bg-blue-500' :
                          event.status === 'assigned' ? 'bg-yellow-500' :
                          event.status === 'moved_to_next_day' ? 'bg-purple-500' :
                          'bg-gray-500'
                        }`} />
                        <div className="flex-1">
                          <div className="flex justify-between items-start">
                            <div>
                              <h4 className="font-medium text-gray-900 capitalize">
                                {event.status.replace(/_/g, ' ')}
                              </h4>
                              <p className="text-sm text-gray-500">
                                {event.timestamp ? (new Date(event.timestamp)).toLocaleString() : ''}
                              </p>
                            </div>
                          </div>
                          {event.notes && (
                            <p className="text-sm text-gray-600 mt-1">{event.notes}</p>
                          )}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="text-center py-4 text-gray-500">
                      <span>No timeline events recorded</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Customer Info */}
              <div className="border-b border-gray-200 pb-4">
                <h3 className="text-sm font-semibold text-gray-600 mb-3">Customer Information</h3>
                <div className="space-y-2">
                  <div className="flex items-start gap-2">
                    <User className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-xs text-gray-500">Name</p>
                      <p className="font-semibold text-gray-900">{selectedDeliveryDetail.customerName}</p>
                    </div>
                  </div>
                  {selectedDeliveryDetail.customerPhone && (
                    <div className="flex items-start gap-2">
                      <Phone className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-xs text-gray-500">Phone</p>
                        <a href={`tel:${selectedDeliveryDetail.customerPhone}`} className="font-semibold text-blue-600 hover:underline">
                          {selectedDeliveryDetail.customerPhone}
                        </a>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Delivery Info */}
              <div className="border-b border-gray-200 pb-4">
                <h3 className="text-sm font-semibold text-gray-600 mb-3">Delivery Information</h3>
                <div className="space-y-2">
                  {(() => {
                    const ad = selectedDeliveryDetail.addressDetails || {};
                    // Owner (2026-09-22): "the delivery address ... need to
                    // be not one line as before but changed to field: label,
                    // emirate, area, building, unit, floor, status" — shown
                    // as separate labeled fields whenever that structured
                    // data exists (currently: Matter-imported deliveries).
                    // Older/manually-entered deliveries that only ever had
                    // the flat string still fall back to the single line.
                    const hasStructuredAddress = [ad.label, ad.city, ad.area, ad.building, ad.apartment, ad.floor, ad.addressStatus].some(Boolean);
                    if (!hasStructuredAddress) {
                      return (
                        <div className="flex items-start gap-2">
                          <MapPin className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" />
                          <div className="flex-1">
                            <p className="text-xs text-gray-500">Address</p>
                            <p className="font-semibold text-gray-900 text-sm">{selectedDeliveryDetail.address || 'Not provided'}</p>
                          </div>
                        </div>
                      );
                    }
                    const fields = [
                      ['Label', ad.label],
                      ['Emirate', ad.city],
                      ['Area', ad.area],
                      ['Building', ad.building],
                      ['Unit', ad.apartment],
                      ['Floor', ad.floor],
                      ['Status', ad.addressStatus]
                    ].filter(([, value]) => value);
                    return (
                      <div className="flex items-start gap-2">
                        <MapPin className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" />
                        <div className="flex-1">
                          <p className="text-xs text-gray-500 mb-1">Address</p>
                          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 bg-gray-50 rounded-lg p-2.5">
                            {fields.map(([label, value]) => (
                              <div key={label}>
                                <p className="text-[11px] text-gray-500">{label}</p>
                                <p className="font-semibold text-gray-900 text-sm">{value}</p>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                  {selectedDeliveryDetail.zone && (
                    <div className="flex items-start gap-2">
                      <MapPin className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-xs text-gray-500">Zone</p>
                        <p className="font-semibold text-gray-900">{selectedDeliveryDetail.zone}</p>
                      </div>
                    </div>
                  )}
                  <div className="flex items-start gap-2">
                    <Clock className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-xs text-gray-500">Scheduled Time</p>
                      <p className="font-semibold text-gray-900">{formatTime(selectedDeliveryDetail.scheduledTime)} on {formatDate(selectedDeliveryDetail.scheduledTime)}</p>
                    </div>
                  </div>
                  {selectedDeliveryDetail.combinedSunday && (
                    <div className="flex items-start gap-2 bg-indigo-50 border border-indigo-200 rounded-lg p-2.5">
                      <Package className="w-4 h-4 text-indigo-500 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-xs text-indigo-700 font-semibold">Weekend combined delivery</p>
                        <p className="text-sm text-indigo-900">
                          Sunday ({formatDate(selectedDeliveryDetail.combinedSunday.scheduledTime)}) is included in this delivery — no separate Sunday delivery needed.
                        </p>
                      </div>
                    </div>
                  )}
                  {selectedDeliveryDetail.combinedIntoSaturday && (
                    <div className="flex items-start gap-2 bg-indigo-50 border border-indigo-200 rounded-lg p-2.5">
                      <Package className="w-4 h-4 text-indigo-500 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-xs text-indigo-700 font-semibold">Combined into Saturday's delivery</p>
                        <p className="text-sm text-indigo-900">
                          This was already delivered as part of Saturday ({formatDate(selectedDeliveryDetail.combinedIntoSaturday.scheduledTime)}) — it won't appear in Sunday's lists separately.
                        </p>
                      </div>
                    </div>
                  )}
                  {selectedDeliveryDetail.sundayOnlyCarriedOver && (
                    <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg p-2.5">
                      <Package className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-xs text-amber-700 font-semibold">Sunday-only meal</p>
                        <p className="text-sm text-amber-900">
                          This customer only has a meal for Sunday ({formatDate(selectedDeliveryDetail.scheduledTime)}) — delivered together with Saturday's route since there's no separate Sunday route.
                        </p>
                      </div>
                    </div>
                  )}
                  {selectedDeliveryDetail.matterSubscriptionId && (
                    <div className="flex items-start gap-2">
                      <Route className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-xs text-gray-500">Matter Subscription ID</p>
                        <p className="font-semibold text-gray-900">#{selectedDeliveryDetail.matterSubscriptionId}</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Driver Assignment */}
              <div className="border-b border-gray-200 pb-4">
                <h3 className="text-sm font-semibold text-gray-600 mb-3">Driver Assignment</h3>
                <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div>
                    <p className="text-xs text-gray-500">Assigned Driver</p>
                    <p className="font-semibold text-gray-900">
                      {selectedDeliveryDetail.driver ? getDriverDisplayName(selectedDeliveryDetail.driver) : 'Unassigned'}
                    </p>
                  </div>
                  <span className={`text-xs font-semibold px-3 py-1 rounded-full ${statusPills[selectedDeliveryDetail.status]}`}>
                    {getStatusLabel(selectedDeliveryDetail.status)}
                  </span>
                </div>
              </div>

              {/* Order Details */}
              {(selectedDeliveryDetail.items || selectedDeliveryDetail.weight || selectedDeliveryDetail.dimensions) && (
                <div className="border-b border-gray-200 pb-4">
                  <h3 className="text-sm font-semibold text-gray-600 mb-3">Order Details</h3>
                  <div className="space-y-2 text-sm">
                    {selectedDeliveryDetail.items && (
                      <div>
                        <p className="text-xs text-gray-500">Items</p>
                        <p className="font-semibold text-gray-900">{selectedDeliveryDetail.items}</p>
                      </div>
                    )}
                    {selectedDeliveryDetail.weight && (
                      <div>
                        <p className="text-xs text-gray-500">Weight</p>
                        <p className="font-semibold text-gray-900">{selectedDeliveryDetail.weight} kg</p>
                      </div>
                    )}
                    {selectedDeliveryDetail.dimensions && (
                      <div>
                        <p className="text-xs text-gray-500">Dimensions</p>
                        <p className="font-semibold text-gray-900">{selectedDeliveryDetail.dimensions}</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Special Instructions */}
              {selectedDeliveryDetail.notes && (
                <div className="pb-4">
                  <h3 className="text-sm font-semibold text-gray-600 mb-3">Special Instructions</h3>
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                    <p className="text-sm text-amber-900">{selectedDeliveryDetail.notes}</p>
                  </div>
                </div>
              )}
            </div>

            <div className="flex justify-between gap-2 p-6 border-t border-gray-200 sticky bottom-0 bg-white rounded-b-xl">
              <button
                onClick={() => setSelectedDeliveryDetail(null)}
                className="flex-1 px-4 py-2 text-sm font-semibold text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition"
              >
                Close
              </button>
              {selectedDeliveryDetail.driver && (
                <button
                  onClick={() => handleUnassignDriver([selectedDeliveryDetail])}
                  disabled={unassigning}
                  className="flex-1 px-4 py-2 text-sm font-semibold text-red-600 border border-red-300 rounded-lg hover:bg-red-50 transition disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Unassign
                </button>
              )}
              <button
                onClick={() => {
                  setActiveAssignmentDeliveries([selectedDeliveryDetail]);
                  setSelectedDeliveryDetail(null);
                }}
                className="flex-1 px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition"
              >
                {selectedDeliveryDetail.driver ? 'Reassign Driver' : 'Assign Driver'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Delivery Modal */}
      {editingDelivery && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-6 border-b border-gray-200 sticky top-0 bg-white">
              <h2 className="text-xl font-bold text-gray-900">Edit Delivery</h2>
              <button
                onClick={() => setEditingDelivery(null)}
                className="p-1 hover:bg-gray-100 rounded-lg"
              >
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  const payload = {};
                  if (editForm.customerName !== editingDelivery.customerName) payload.customerName = editForm.customerName;
                  if (editForm.customerId !== editingDelivery.customerId) payload.customerId = editForm.customerId;
                  if (editForm.address !== editingDelivery.address) payload.address = editForm.address;
                  if (editForm.zone !== editingDelivery.zone) payload.zone = editForm.zone;
                  if (editForm.notes !== editingDelivery.notes) payload.notes = editForm.notes;
                  if (editForm.scheduledTime) {
                    const newScheduled = new Date(editForm.scheduledTime).toISOString();
                    const oldScheduled = editingDelivery.scheduledTime ? new Date(editingDelivery.scheduledTime).toISOString() : null;
                    if (newScheduled !== oldScheduled) payload.scheduledTime = newScheduled;
                  }
                  if (Object.keys(payload).length === 0) {
                    alert('No changes to save');
                    return;
                  }
                  await api.put(`/deliveries/${editingDelivery._id}`, payload);
                  setEditingDelivery(null);
                  const start = new Date(`${selectedDate}T00:00:00`);
                  const end = new Date(start);
                  end.setDate(end.getDate() + 1);
                  dispatch(fetchDeliveries({
                    dateRange: 'custom',
                    dateFrom: start.toISOString(),
                    dateTo: end.toISOString(),
                    limit: 1000
                  }));
                  setFeedback({ message: 'Delivery updated successfully', error: false });
                } catch (err) {
                  console.error('Update delivery error:', err);
                  alert(err?.response?.data?.message || 'Failed to update delivery');
                }
              }}
              className="p-6 space-y-4"
            >
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Customer Name</label>
                  <input
                    type="text"
                    value={editForm.customerName}
                    onChange={(e) => setEditForm(f => ({ ...f, customerName: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Customer ID</label>
                  <input
                    type="text"
                    value={editForm.customerId}
                    onChange={(e) => setEditForm(f => ({ ...f, customerId: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Address</label>
                  <input
                    type="text"
                    value={editForm.address}
                    onChange={(e) => setEditForm(f => ({ ...f, address: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Zone</label>
                  <input
                    type="text"
                    value={editForm.zone}
                    onChange={(e) => setEditForm(f => ({ ...f, zone: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Scheduled Time</label>
                  <input
                    type="datetime-local"
                    value={editForm.scheduledTime}
                    onChange={(e) => setEditForm(f => ({ ...f, scheduledTime: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                  <textarea
                    value={editForm.notes}
                    onChange={(e) => setEditForm(f => ({ ...f, notes: e.target.value }))}
                    rows={3}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
              <div className="flex gap-2 pt-4">
                <button
                  type="button"
                  onClick={() => setEditingDelivery(null)}
                  className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                >
                  Save Changes
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Map Assign Modal */}
      <DispatcherMapAssignModal
        open={mapModalOpen}
        onClose={() => setMapModalOpen(false)}
        deliveries={filteredDeliveries}
        drivers={drivers}
      />

      {/* Route Optimization Modal */}
      <RouteOptimizationModal
        open={routeModalOpen}
        onClose={() => setRouteModalOpen(false)}
        deliveries={selectedDeliveries}
        drivers={drivers}
        onApplied={() => {
          setFeedback({ message: 'Routes applied', error: false });
          refreshDeliveriesForSelectedDate();
          setSelectedDeliveryIds([]);
        }}
      />

      {/* Manual delivery order (owner, 2026-10-09) */}
      <ManualOrderModal
        open={manualOrderModalOpen}
        onClose={() => setManualOrderModalOpen(false)}
        deliveries={filteredDeliveries}
        drivers={drivers}
        defaultDriverId={
          selectedDeliveries.length > 0 && selectedDeliveries.every((d) => d.driver?._id === selectedDeliveries[0].driver?._id)
            ? selectedDeliveries[0].driver?._id
            : null
        }
        onSaved={() => {
          setFeedback({ message: 'Delivery order saved', error: false });
          refreshDeliveriesForSelectedDate();
        }}
      />


      {/* Feedback Toast */}
      {feedback.message && (
        <div className={`fixed bottom-6 right-6 px-6 py-4 rounded-lg text-white font-semibold shadow-lg ${
          feedback.error ? 'bg-red-600' : 'bg-green-600'
        }`}>
          {feedback.message}
        </div>
      )}

      <EventDetailModal isOpen={showEventDetail} onClose={() => setShowEventDetail(false)} />
    </div>
  );
};

export default DispatcherDesktop;
