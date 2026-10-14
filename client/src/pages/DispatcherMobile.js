import DeliveryOrderModal from '../components/DeliveryOrderModal';
﻿import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search,
  MapPin,
  Clock,
  User,
  Phone,
  Target,
  X,
  ArrowRight,
  ChevronLeft,
  Loader2,
  ChevronDown,
  Check,
  LayoutGrid,
  List,
  Plus,
  LogOut,
  CalendarDays,
  Briefcase,
  Package
} from 'lucide-react';
import { fetchEvents } from '../store/slices/eventSlice';
import { setSelectedEvent } from '../store/slices/eventSlice';
import EventCalendarView from '../components/events/EventCalendarView';
import EventDetailModal from '../components/events/EventDetailModal';
import api from '../utils/api';
import { fetchDeliveries } from '../store/slices/deliverySlice';
import { fetchDrivers } from '../store/slices/driverSlice';
import { logout } from '../store/slices/authSlice';
import DispatcherMapAssignModal from '../components/DispatcherMapAssignModal';
import SimpleQrScanner from '../components/SimpleQrScanner';

const AREA_FILTER_OPTIONS = [
  'All',
  'Marina',
  'JVC',
  'Business Bay',
  'Abu Dhabi',
  'Sharjah',
  'Ajman'
];

const statusPills = {
  pending: 'bg-amber-50 text-amber-700',
  assigned: 'bg-blue-50 text-blue-700',
  picked_up: 'bg-slate-50 text-slate-700',
  delivered: 'bg-emerald-50 text-emerald-700',
  failed: 'bg-rose-50 text-rose-700'
};

const DispatcherMobile = () => {
  const [orderOpen, setOrderOpen] = useState(false);
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { deliveries = [], isLoading: deliveriesLoading, error: deliveriesError } = useSelector(
    (state) => state.delivery
  );
  const { drivers = [], isLoading: driversLoading } = useSelector((state) => state.driver);
  const { user } = useSelector((state) => state.auth);

  // Helper function to get tomorrow's date in YYYY-MM-DD format
  const getTomorrowDate = () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow.toISOString().split('T')[0];
  };

  const [areaFilters, setAreaFilters] = useState([]);
  const [driverFilters, setDriverFilters] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [areaSearchTerm, setAreaSearchTerm] = useState(''); // Search within area dropdown
  const [timingFilters, setTimingFilters] = useState([]); // 'morning', 'afternoon', 'evening'
  const [selectedDeliveryIds, setSelectedDeliveryIds] = useState([]);
  const [assigningDriverId, setAssigningDriverId] = useState(null);
  const [activeAssignmentDeliveries, setActiveAssignmentDeliveries] = useState([]);
  const [unassigning, setUnassigning] = useState(false);
  const [feedback, setFeedback] = useState({ message: '', error: false });
  const [areaDropdownOpen, setAreaDropdownOpen] = useState(false);
  const [driverFilterDropdownOpen, setDriverFilterDropdownOpen] = useState(false);
  const [timingDropdownOpen, setTimingDropdownOpen] = useState(false);
  const [driverListOpen, setDriverListOpen] = useState(false);
  const [driverSearchTerm, setDriverSearchTerm] = useState('');
  const [viewMode, setViewMode] = useState('list'); // 'list' or 'grid'
  const [showUnassignedOnly, setShowUnassignedOnly] = useState(false); // Filter for unassigned
  const [showCollectionsOnly, setShowCollectionsOnly] = useState(false); // Filter for collections
  const [singleDriverMode, setSingleDriverMode] = useState(null); // Filter to single driver or 'all'
  const [printMode, setPrintMode] = useState(false); // Print preview mode
  const [printDriverFilter, setPrintDriverFilter] = useState(null); // Filter driver for print
  const [showEventsModal, setShowEventsModal] = useState(false);
  const [eventsSelectedDay, setEventsSelectedDay] = useState(null);
  const [eventsDayEvents, setEventsDayEvents] = useState([]);
  const [showEventDetail, setShowEventDetail] = useState(false);
  const { events = [] } = useSelector((state) => state.events);
  const todayEventCount = events.filter((ev) => ev.eventDate && new Date(ev.eventDate).toDateString() === new Date().toDateString()).length;
  const [editingDelivery, setEditingDelivery] = useState(null);
  const [editForm, setEditForm] = useState({
    customerName: '',
    customerId: '',
    address: '',
    zone: '',
    notes: '',
    scheduledTime: ''
  });
  const [selectedDeliveryDetail, setSelectedDeliveryDetail] = useState(null); // For detail modal
  const [mapModalOpen, setMapModalOpen] = useState(false);
  const [bagAssignModalOpen, setBagAssignModalOpen] = useState(false);
  const [bagAssigningDriverId, setBagAssigningDriverId] = useState(null);
  const [showBagScanner, setShowBagScanner] = useState(false);
  const [scannedBagIds, setScannedBagIds] = useState([]);
  const [lastScannedBagId, setLastScannedBagId] = useState('');
  const [bagScanMessage, setBagScanMessage] = useState('');
  const [bagDriverSearchTerm, setBagDriverSearchTerm] = useState('');
  
  // Initialize with tomorrow's date
  const [selectedDate, setSelectedDate] = useState(() => getTomorrowDate());
  
  const areaButtonRef = useRef(null);
  const driverFilterButtonRef = useRef(null);
  const timingButtonRef = useRef(null);
  const bagLastScanTimestampRef = useRef(0);
  const bagLastScannedValueRef = useRef('');
  const handleLogout = () => {
    dispatch(logout());
    navigate('/login', { replace: true });
  };

  useEffect(() => {
    // Fetch deliveries for the selected date
    const start = new Date(`${selectedDate}T00:00:00`);
    if (!Number.isNaN(start.getTime())) {
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      
      console.log('Fetching deliveries for date:', selectedDate);
      console.log('Start:', start.toISOString());
      console.log('End:', end.toISOString());
      
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
    const extraZones = Array.from(
      new Set(
        deliveries
          .map((delivery) => delivery.zone)
          .filter(Boolean)
          .map((zone) => zone.trim())
      )
    ).filter((zone) => zone.length > 0);
    const uniqueExtras = extraZones.filter(
      (zone) => !AREA_FILTER_OPTIONS.some((base) => base.toLowerCase() === zone.toLowerCase())
    );
    // Sort areas alphabetically
    const allAreas = [...AREA_FILTER_OPTIONS.filter((item) => item !== 'All'), ...uniqueExtras];
    return allAreas.sort((a, b) => a.localeCompare(b));
  }, [deliveries]);

  // Calculate unassigned deliveries count per area
  const unassignedCountPerArea = useMemo(() => {
    const counts = {};
    (deliveries || []).forEach((delivery) => {
      if (!delivery.driver) {
        const zone = (delivery.zone || delivery.address || '').toLowerCase().trim();
        counts[zone] = (counts[zone] || 0) + 1;
      }
    });
    return counts;
  }, [deliveries, showUnassignedOnly]);

  // Filter areas based on search term
  const filteredAreaOptions = useMemo(() => {
    if (!areaSearchTerm.trim()) {
      return areaOptions;
    }
    const normalizedSearch = areaSearchTerm.toLowerCase().trim();
    return areaOptions.filter(area => area.toLowerCase().includes(normalizedSearch));
  }, [areaOptions, areaSearchTerm]);

  const normalizedSearch = searchTerm.trim().toLowerCase();
  const normalizedAreaFilters = areaFilters.map((area) => area.toLowerCase().trim());
  const normalizedAreaFiltersKey = normalizedAreaFilters.join('|');
  const driverFiltersKey = driverFilters.join('|');

  // Helper function to check if delivery is within timing filter
  const isWithinTimingFilter = (scheduledTime) => {
    if (timingFilters.length === 0) return true;
    const date = new Date(scheduledTime);
    const hour = date.getHours();
    
    return timingFilters.includes(hour);
  };

  const filteredDeliveries = useMemo(() => {
    const processedDeliveries = deliveries || [];
    const filtered = processedDeliveries.filter((delivery) => {
      // Filter for unassigned deliveries if toggled
      if (showUnassignedOnly && delivery.driver) {
        return false;
      }

      // Filter for collections only if toggled
      if (showCollectionsOnly && delivery.type !== 'Collection') {
        return false;
      }

      // Timing filter
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

      // Driver filter with single driver mode
      let driverMatch = true;
      if (singleDriverMode === 'all' || singleDriverMode === null) {
        // Show all drivers or filter by selected drivers
        driverMatch =
          driverFilters.length === 0 ||
          driverFilters.includes(delivery.driver?._id) ||
          (driverFilters.includes('unassigned') && !delivery.driver);
      } else if (singleDriverMode) {
        // Show only deliveries for specific driver
        driverMatch = delivery.driver?._id === singleDriverMode;
      }

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
  }, [deliveries, normalizedAreaFiltersKey, driverFiltersKey, normalizedSearch, showUnassignedOnly, showCollectionsOnly, timingFilters, singleDriverMode]);

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

  const filteredDriverList = useMemo(() => {
    const normalizedSearch = driverSearchTerm.trim().toLowerCase();
    if (!normalizedSearch) {
      return sortedDrivers;
    }

    return sortedDrivers.filter((driver) => {
      const name = `${driver.profile?.firstName || ''} ${driver.profile?.lastName || ''}`.toLowerCase();
      const email = (driver.email || '').toLowerCase();
      const status = (driver.profile?.status || '').toLowerCase();
      return (
        name.includes(normalizedSearch) ||
        email.includes(normalizedSearch) ||
        status.includes(normalizedSearch)
      );
    });
  }, [sortedDrivers, driverSearchTerm]);

  const areaLabel = areaFilters.length === 0 ? 'All Areas' : areaFilters.join(', ');
  const driverLabel = driverFilters.length === 0 ? 'All Drivers' : `${driverFilters.length} Driver(s)`;

  const toggleAreaSelection = (area) => {
    setAreaFilters((prev) => {
      if (prev.includes(area)) {
        return prev.filter((item) => item !== area);
      }
      return [...prev, area];
    });
  };

  const clearAreaFilters = () => {
    setAreaFilters([]);
  };

  const toggleDriverSelection = (driverId) => {
    setDriverFilters((prev) => {
      if (prev.includes(driverId)) {
        return prev.filter((item) => item !== driverId);
      }
      return [...prev, driverId];
    });
  };

  const clearDriverFilters = () => {
    setDriverFilters([]);
  };

  const selectedDeliveries = useMemo(
    () => deliveries.filter((delivery) => selectedDeliveryIds.includes(delivery._id)),
    [deliveries, selectedDeliveryIds]
  );
  const hasSelections = selectedDeliveryIds.length > 0;
  const assignmentCount = activeAssignmentDeliveries.length;
  const primaryDelivery = assignmentCount > 0 ? activeAssignmentDeliveries[0] : null;
  const assignmentTitle =
    assignmentCount === 1 ? primaryDelivery?.customerName : `${assignmentCount} deliveries`;

  const filteredBagDriverList = useMemo(() => {
    const normalized = bagDriverSearchTerm.trim().toLowerCase();
    if (!normalized) {
      return sortedDrivers;
    }

    return sortedDrivers.filter((driver) => {
      const name = `${driver.profile?.firstName || ''} ${driver.profile?.lastName || ''}`.toLowerCase();
      const email = (driver.email || '').toLowerCase();
      return name.includes(normalized) || email.includes(normalized);
    });
  }, [sortedDrivers, bagDriverSearchTerm]);

  const toggleDeliverySelection = (deliveryId) => {
    setSelectedDeliveryIds((prev) => {
      if (prev.includes(deliveryId)) {
        return prev.filter((id) => id !== deliveryId);
      }
      return [...prev, deliveryId];
    });
  };

  const clearDeliverySelection = () => {
    setSelectedDeliveryIds([]);
  };

  const normalizeScannedBagId = (raw) => {
    return String(raw || '').trim().toUpperCase();
  };

  const removeScannedBag = (bagId) => {
    setScannedBagIds((prev) => prev.filter((id) => id !== bagId));
  };

  const handleBagQrScan = useCallback((detectedCodes) => {
    if (!showBagScanner || !detectedCodes || detectedCodes.length === 0) {
      return;
    }

    const now = Date.now();
    if (now - bagLastScanTimestampRef.current < 180) {
      return;
    }

    const rawValue = detectedCodes[0]?.rawValue || detectedCodes[0]?.data || '';
    const bagId = normalizeScannedBagId(rawValue);

    if (!bagId || bagId.length < 3) {
      return;
    }

    if (bagLastScannedValueRef.current === bagId && now - bagLastScanTimestampRef.current < 1200) {
      return;
    }

    bagLastScanTimestampRef.current = now;
    bagLastScannedValueRef.current = bagId;

    setScannedBagIds((prev) => {
      if (prev.includes(bagId)) {
        setBagScanMessage(`${bagId} already scanned`);
        return prev;
      }
      setLastScannedBagId(bagId);
      setBagScanMessage(`Scanned ${bagId}`);
      return [...prev, bagId];
    });
  }, [showBagScanner]);

  const closeBagAssignModal = () => {
    setBagAssignModalOpen(false);
    setScannedBagIds([]);
    setLastScannedBagId('');
    setBagScanMessage('');
    setShowBagScanner(false);
    setBagDriverSearchTerm('');
    setBagAssigningDriverId(null);
    bagLastScannedValueRef.current = '';
    bagLastScanTimestampRef.current = 0;
  };

  const handleAssignBagsToDriver = async (driver) => {
    if (scannedBagIds.length === 0 || bagAssigningDriverId) {
      return;
    }

    setBagAssigningDriverId(driver._id);

    try {
      const response = await api.post('/bags/assign/bulk', {
        bagIds: scannedBagIds,
        driverId: driver._id,
      });

      const assignedCount = response?.data?.data?.assignedCount || 0;
      const failedCount = response?.data?.data?.failedCount || 0;

      setFeedback({
        message: `Assigned ${assignedCount} bag(s) to ${getDriverDisplayName(driver)}${failedCount ? `, ${failedCount} failed` : ''}`,
        error: assignedCount === 0,
      });
      closeBagAssignModal();
    } catch (error) {
      setFeedback({
        message: error?.response?.data?.message || 'Unable to assign selected bags. Please retry.',
        error: true,
      });
    } finally {
      setBagAssigningDriverId(null);
    }
  };

  const selectAllFilteredDeliveries = () => {
    const allFilteredIds = filteredDeliveries.map(d => d._id);
    setSelectedDeliveryIds(allFilteredIds);
  };

  const isAllFilteredSelected = useMemo(() => {
    if (filteredDeliveries.length === 0) return false;
    return filteredDeliveries.every(d => selectedDeliveryIds.includes(d._id));
  }, [filteredDeliveries, selectedDeliveryIds]);

  const openAssignmentSheet = (deliveriesToAssign) => {
    if (!deliveriesToAssign.length) return;
    setActiveAssignmentDeliveries(deliveriesToAssign);
    setDriverListOpen(false);
  };

  const closeAssignmentSheet = () => {
    setActiveAssignmentDeliveries([]);
    setDriverListOpen(false);
  };

  const formatTime = (value) => {
    if (!value) return '--:--';
    const date = new Date(value);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  const formatDate = (value) => {
    if (!value) return '';
    const date = new Date(value);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
  };

  const getDriverDisplayName = (driver) => {
    if (!driver) return 'Unassigned';
    const parts = [driver.profile?.firstName, driver.profile?.lastName].filter(Boolean);
    return parts.length > 0 ? parts.join(' ') : driver.email || 'Driver';
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
        message: `Assigned ${assignmentTitle} to ${getDriverDisplayName(driver)}`,
        error: false
      });
      // Keep the selected date instead of fetching 'today' which might show yesterday's deliveries
      const start = new Date(`${selectedDate}T00:00:00`);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      dispatch(fetchDeliveries({ 
        dateRange: 'custom',
        dateFrom: start.toISOString(),
        dateTo: end.toISOString(),
        limit: 1000 
      }));
      setDriverListOpen(false);
      clearDeliverySelection();
      closeAssignmentSheet();
      // Clear all filters after successful assignment
      setAreaFilters([]);
      setTimingFilters([]);
      setDriverFilters([]);
      setSingleDriverMode(null);
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
      const start = new Date(`${selectedDate}T00:00:00`);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      dispatch(fetchDeliveries({
        dateRange: 'custom',
        dateFrom: start.toISOString(),
        dateTo: end.toISOString(),
        limit: 1000
      }));
      clearDeliverySelection();
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

  const driverStatusLabel = (status) => {
    const normalized = (status || '').toLowerCase();
    if (normalized.includes('break')) return 'Break';
    if (normalized === 'busy' || normalized === 'on_route') return 'Busy';
    if (normalized === 'available') return 'Available';
    return 'Not Working';
  };

  const renderDeliveryCard = (delivery) => {
    const assignedDriver = delivery.driver;
    const driverName = getDriverDisplayName(assignedDriver);
    const statusClass = statusPills[delivery.status] || 'bg-gray-50 text-gray-700';
    const isSelected = selectedDeliveryIds.includes(delivery._id);
    return (
      <div key={delivery._id} className="relative">
        <div className="w-full text-left bg-white rounded-lg sm:rounded-xl border border-gray-200 p-3 sm:p-4">
          <div className="flex justify-between items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-xs sm:text-sm font-semibold text-gray-500 tracking-wide truncate">{delivery.customerId}</p>
              <h3 className="text-base sm:text-lg font-semibold text-gray-900 leading-snug line-clamp-2">
                {delivery.customerName}
              </h3>
            </div>
            <span className={`text-xs font-semibold px-2 sm:px-3 py-1 rounded-full flex-shrink-0 ${statusClass}`}>
              {getStatusLabel(delivery.status)}
            </span>
          </div>
          <div className="mt-2 sm:mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-3 text-xs sm:text-sm text-gray-600">
            <div className="flex items-center space-x-2">
              <Clock className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-blue-500 flex-shrink-0" />
              <span className="truncate">{formatTime(delivery.scheduledTime)}</span>
            </div>
            <div className="text-xs text-gray-500 font-medium sm:text-right">
              {formatDate(delivery.scheduledTime)}
            </div>
            <div className="flex items-center space-x-2 col-span-1 sm:col-span-2">
              <MapPin className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-slate-400 flex-shrink-0" />
              <span className="truncate text-xs sm:text-sm">{delivery.address || delivery.zone || 'Area not set'}</span>
            </div>
            <div className="flex items-center space-x-2 col-span-1 sm:col-span-2">
              <User className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-slate-400 flex-shrink-0" />
              <span className="font-medium text-gray-800">{driverName}</span>
            </div>
          </div>
          
          {/* Action Buttons */}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => setSelectedDeliveryDetail(delivery)}
              className="flex-1 px-3 py-2 text-xs sm:text-sm font-semibold text-gray-700 bg-gray-50 rounded-lg hover:bg-gray-100 transition border border-gray-200"
            >
              View Details
            </button>
            <button
              type="button"
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
              className="flex-1 px-3 py-2 text-xs sm:text-sm font-semibold text-white bg-green-600 rounded-lg hover:bg-green-700 transition"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => {
                setDriverListOpen(false);
                openAssignmentSheet([delivery]);
              }}
              className="flex-1 px-3 py-2 text-xs sm:text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition"
            >
              {delivery.status === 'assigned' ? 'Reassign' : 'Assign'}
            </button>
            {delivery.driver && (
              <button
                type="button"
                onClick={() => handleUnassignDriver([delivery])}
                disabled={unassigning}
                className="flex-1 px-3 py-2 text-xs sm:text-sm font-semibold text-red-600 bg-white border border-red-300 rounded-lg hover:bg-red-50 transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Unassign
              </button>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            toggleDeliverySelection(delivery._id);
          }}
          className={`absolute top-3 right-3 h-9 w-9 rounded-xl border flex justify-center items-center ${
            isSelected
              ? 'bg-blue-600 border-blue-700 text-white'
              : 'bg-white border-gray-200 text-gray-400'
          }`}
        >
          <Check className="h-5 w-5" />
        </button>
      </div>
    );
  };

  const renderDeliveryGridCard = (delivery) => {
    const assignedDriver = delivery.driver;
    const driverName = getDriverDisplayName(assignedDriver);
    const statusClass = statusPills[delivery.status] || 'bg-gray-50 text-gray-700';
    const isSelected = selectedDeliveryIds.includes(delivery._id);
    return (
      <div key={delivery._id} className="relative">
        <div className={`w-full text-left bg-white rounded-xl border-2 p-3 ${
          isSelected ? 'border-blue-500' : 'border-gray-200'
        }`}>
          {/* Checkbox and Status */}
          <div className="flex items-start justify-between mb-2">
            <input
              type="checkbox"
              className="w-4 h-4 text-blue-600 border-gray-300 rounded mt-1"
              checked={isSelected}
              onChange={(e) => {
                e.stopPropagation();
                toggleDeliverySelection(delivery._id);
              }}
              onClick={(e) => e.stopPropagation()}
            />
            <span className={`text-xs font-semibold px-2 py-1 rounded-full ${statusClass}`}>
              {getStatusLabel(delivery.status)}
            </span>
          </div>

          {/* Customer Info */}
          <div className="mb-2">
            <p className="text-xs text-gray-500 mb-0.5">{delivery.customerId}</p>
            <h3 className="text-sm font-semibold text-gray-900 leading-tight line-clamp-2">
              {delivery.customerName}
            </h3>
          </div>

          {/* Time and Date */}
          <div className="flex items-center space-x-1 text-xs text-gray-600 mb-2">
            <Clock className="w-3 h-3 text-blue-500 flex-shrink-0" />
            <span className="truncate">{formatTime(delivery.scheduledTime)}</span>
            <span className="text-gray-400">•</span>
            <span className="truncate text-gray-500">{formatDate(delivery.scheduledTime)}</span>
          </div>

          {/* Location */}
          <div className="flex items-start space-x-1 text-xs text-gray-600 mb-2">
            <MapPin className="w-3 h-3 text-slate-400 flex-shrink-0 mt-0.5" />
            <span className="line-clamp-2">{delivery.address || delivery.zone || 'Area not set'}</span>
          </div>

          {/* Driver */}
          <div className="flex items-center space-x-1 text-xs mb-3">
            <User className="w-3 h-3 text-slate-400 flex-shrink-0" />
            <span className="font-medium text-gray-800 truncate">{driverName}</span>
          </div>

          {/* Action Buttons */}
          <div className="flex gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => setSelectedDeliveryDetail(delivery)}
              className="flex-1 px-2 py-1.5 text-xs font-semibold text-gray-700 bg-gray-50 rounded-lg hover:bg-gray-100 transition border border-gray-200"
            >
              Details
            </button>
            <button
              type="button"
              onClick={() => {
                setDriverListOpen(false);
                openAssignmentSheet([delivery]);
              }}
              className="flex-1 px-2 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition"
            >
              Assign
            </button>
            {delivery.driver && (
              <button
                type="button"
                onClick={() => handleUnassignDriver([delivery])}
                disabled={unassigning}
                className="flex-1 px-2 py-1.5 text-xs font-semibold text-red-600 bg-white border border-red-300 rounded-lg hover:bg-red-50 transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Unassign
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  const renderDriverRow = (driver) => {
    const initials =
      (driver.profile?.firstName?.[0] || '') + (driver.profile?.lastName?.[0] || '');
    const status = driverStatusLabel(driver.profile?.status);
    const load = driverLoadCounts[driver._id] || 0;
    const activeDriverId = primaryDelivery?.driver?._id;
    const isCurrentlyAssigned = activeDriverId === driver._id;
    return (
      <button
        key={driver._id}
        type="button"
        onClick={() => handleAssignDriver(driver)}
        disabled={assigningDriverId && assigningDriverId !== driver._id}
        className={`w-full flex items-center gap-3 p-3 rounded-xl ${
          isCurrentlyAssigned ? 'bg-blue-50 border border-blue-100' : 'bg-slate-50'
        } ${assigningDriverId && assigningDriverId !== driver._id ? 'opacity-60 cursor-not-allowed' : ''}`}
      >
        <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-white border border-gray-200 flex items-center justify-center text-lg font-semibold text-slate-600">
          {driver.profile?.picture ? (
            <img
              src={driver.profile.picture}
              alt={getDriverDisplayName(driver)}
              className="w-full h-full object-cover rounded-xl"
            />
          ) : (
            initials || 'DR'
          )}
        </div>
        <div className="flex-1">
          <p className="text-sm font-semibold text-gray-900">
            {getDriverDisplayName(driver)}
          </p>
          <p className="text-xs text-gray-500">
            {status} | Loads {load}
          </p>
        </div>
        <div className="text-blue-500">
          {assigningDriverId === driver._id ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <ArrowRight className="w-5 h-5" />
          )}
        </div>
      </button>
    );
  };

  return (
    <div className="min-h-screen bg-slate-50 text-gray-900">
      <div className="safe-area-top px-4 pb-4 flex items-center justify-between">
        <div>
          <p className="text-sm text-gray-500">Dispatcher Hub</p>
          <h1 className="text-2xl font-semibold text-gray-900">
            {user?.profile?.firstName ? `Hello, ${user.profile.firstName}` : 'Dispatcher Mobile'}
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => { dispatch(fetchEvents()); navigate('/dispatcher/events'); }}
            className="relative p-2 rounded-2xl bg-indigo-50 border border-indigo-200 text-indigo-600 shadow-sm hover:bg-indigo-100 focus:outline-none focus:ring-2 focus:ring-indigo-400"
            title="Scheduled Events"
          >
            <CalendarDays className="w-5 h-5" />
            {todayEventCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center leading-none">
                {todayEventCount}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={handleLogout}
            className="p-2 rounded-2xl bg-white border border-gray-200 text-gray-500 shadow-sm hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            title="Logout"
          >
            <LogOut className="w-5 h-5" />
          </button>
          <div className="w-10 h-10 rounded-2xl bg-white shadow-sm flex items-center justify-center">
            <span className="text-sm font-semibold text-blue-600">Live</span>
          </div>
        </div>
      </div>

      {/* Date Picker */}
      <div className="px-3 pb-2 sm:px-4 sm:pb-3">
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 bg-white rounded-lg sm:rounded-xl p-2 sm:p-3 border border-gray-200">
          <label htmlFor="date-picker" className="text-xs sm:text-sm font-semibold text-gray-600 whitespace-nowrap">
            📅 Date:
          </label>
          <input
            id="date-picker"
            type="date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            className="flex-1 bg-transparent text-xs sm:text-sm font-medium text-gray-800 outline-none cursor-pointer"
          />
          <button
            type="button"
            onClick={() => setSelectedDate(getTomorrowDate())}
            className="w-full sm:w-auto text-xs font-semibold px-2 sm:px-3 py-1.5 rounded-lg bg-blue-50 text-blue-600 hover:bg-blue-100 transition"
          >
            Tomorrow
          </button>
        </div>
      </div>

      <div className="px-3 pb-2 sm:px-4 sm:pb-3">
        <div className="flex items-center space-x-2 sm:space-x-3 bg-white rounded-lg sm:rounded-xl p-2 sm:p-3 border border-gray-200">
          <Search className="w-4 h-4 sm:w-5 sm:h-5 text-gray-400 flex-shrink-0" />
          <input
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Search..."
            className="flex-1 bg-transparent text-xs sm:text-sm text-gray-800 placeholder:text-gray-400 outline-none"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck="false"
          />
        </div>

        <div className="mt-2 sm:mt-4 relative" ref={areaButtonRef}>
          <button
            type="button"
            onClick={() => setAreaDropdownOpen((prev) => !prev)}
            className="w-full flex items-center justify-between rounded-lg sm:rounded-xl px-3 sm:px-4 py-2 sm:py-3 bg-white border border-gray-200 text-xs sm:text-sm font-semibold text-gray-700"
          >
            <span className="truncate">{areaLabel}</span>
            <ChevronDown
              className={`w-4 h-4 sm:w-5 sm:h-5 text-gray-500 flex-shrink-0 ml-2 ${areaDropdownOpen ? 'rotate-180' : ''}`}
            />
          </button>
          {areaDropdownOpen && (
            <div className="absolute left-0 right-0 mt-2 rounded-lg sm:rounded-xl bg-white border border-gray-200 max-h-80 overflow-y-auto z-20">
              <div className="sticky top-0 bg-white border-b border-gray-200 p-2 sm:p-3">
                <input
                  type="text"
                  placeholder="Search areas..."
                  value={areaSearchTerm}
                  onChange={(e) => setAreaSearchTerm(e.target.value)}
                  className="w-full px-2 sm:px-3 py-1.5 text-xs sm:text-sm border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
                  autoComplete="off"
                />
              </div>
              <div className="flex justify-between px-3 sm:px-4 py-2 text-xs uppercase tracking-wide text-gray-400">
                <span>Areas</span>
                <button type="button" onClick={clearAreaFilters} className="text-blue-500 font-semibold">
                  Clear all
                </button>
              </div>
              {filteredAreaOptions.map((area) => {
                const isActive = areaFilters.includes(area);
                const unassignedCount = showUnassignedOnly ? unassignedCountPerArea[area.toLowerCase()] || 0 : 0;
                return (
                  <button
                    key={area}
                    type="button"
                    onClick={() => toggleAreaSelection(area)}
                    className={`w-full text-left px-3 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-semibold flex items-center justify-between ${
                      isActive ? 'bg-blue-50 text-blue-600' : 'text-gray-600'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span>{area}</span>
                      {showUnassignedOnly && unassignedCount > 0 && (
                        <span className="bg-red-100 text-red-600 px-2 py-0.5 rounded text-xs font-bold">
                          {unassignedCount}
                        </span>
                      )}
                    </div>
                    {isActive && <Check className="w-4 h-4" />}
                  </button>
                );
              })}
              <div className="px-3 sm:px-4 py-2 text-xs text-gray-500">
                {areaFilters.length === 0 ? 'Showing all deliveries' : `${areaFilters.length} area(s) selected`}
              </div>
            </div>
          )}
        </div>

        <div className="mt-2 sm:mt-4 relative" ref={driverFilterButtonRef}>
          <button
            type="button"
            onClick={() => setDriverFilterDropdownOpen((prev) => !prev)}
            className="w-full flex items-center justify-between rounded-lg sm:rounded-xl px-3 sm:px-4 py-2 sm:py-3 bg-white border border-gray-200 text-xs sm:text-sm font-semibold text-gray-700"
          >
            <span className="truncate">{driverLabel}</span>
            <ChevronDown
              className={`w-4 h-4 sm:w-5 sm:h-5 text-gray-500 flex-shrink-0 ml-2 ${driverFilterDropdownOpen ? 'rotate-180' : ''}`}
            />
          </button>
          {driverFilterDropdownOpen && (
            <div className="absolute left-0 right-0 mt-2 rounded-lg sm:rounded-xl bg-white border border-gray-200 max-h-60 overflow-y-auto z-20">
              <div className="flex justify-between px-3 sm:px-4 py-2 text-xs uppercase tracking-wide text-gray-400">
                <span>Drivers</span>
                <button type="button" onClick={clearDriverFilters} className="text-blue-500 font-semibold">
                  Clear all
                </button>
              </div>
              <button
                type="button"
                onClick={() => toggleDriverSelection('unassigned')}
                className={`w-full text-left px-3 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-semibold flex items-center justify-between ${
                  driverFilters.includes('unassigned') ? 'bg-blue-50 text-blue-600' : 'text-gray-600'
                }`}
              >
                <span>Unassigned</span>
                {driverFilters.includes('unassigned') && <Check className="w-4 h-4" />}
              </button>
              {drivers.map((driver) => {
                const isActive = driverFilters.includes(driver._id);
                const driverName = `${driver.profile?.firstName || ''} ${driver.profile?.lastName || ''}`.trim() || driver.email;
                const load = driverLoadCounts[driver._id] || 0;
                return (
                  <button
                    key={driver._id}
                    type="button"
                    onClick={() => toggleDriverSelection(driver._id)}
                    className={`w-full text-left px-4 py-3 text-sm font-semibold flex items-center justify-between ${
                      isActive ? 'bg-blue-50 text-blue-600' : 'text-gray-600'
                    }`}
                  >
                    <span className="flex-1">
                      {driverName}
                      <span className="text-xs text-gray-400 ml-2">({load} loads)</span>
                    </span>
                    {isActive && <Check className="w-4 h-4" />}
                  </button>
                );
              })}
              <div className="px-4 py-2 text-xs text-gray-500">
                {driverFilters.length === 0 ? 'Showing all deliveries' : `${driverFilters.length} driver(s) selected`}
              </div>
            </div>
          )}
        </div>

        {hasSelections && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-700">
            <span className="font-semibold">{`${selectedDeliveryIds.length} selected`}</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => openAssignmentSheet(selectedDeliveries)}
                className="rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white"
              >
                Assign selected
              </button>
              <button
                type="button"
                onClick={() => handleUnassignDriver(selectedDeliveries)}
                disabled={unassigning || !selectedDeliveries.some((d) => d.driver)}
                className="rounded-xl border border-red-200 bg-white px-3 py-2 text-xs font-semibold text-red-600 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Unassign
              </button>
              <button
                type="button"
                onClick={clearDeliverySelection}
                className="rounded-xl border border-blue-200 px-3 py-2 text-xs font-semibold text-blue-700"
              >
                Clear
              </button>
            </div>
          </div>
        )}

          <div className="mt-2 sm:mt-4 flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2 sm:gap-4">
            <div className="text-xs uppercase tracking-wide text-gray-500 truncate">
              {`${filteredDeliveries.length} deliveries`}
              <button type="button" onClick={() => setOrderOpen(true)} className="ml-3 p-2 rounded-lg bg-blue-600 text-white normal-case">Delivery order</button>
              {orderOpen && <DeliveryOrderModal date={selectedDate} drivers={drivers} onClose={() => setOrderOpen(false)} />}
            </div>
            <div className="flex flex-wrap items-center gap-1 sm:gap-2">
              <button
                type="button"
                onClick={() => {
                  if (isAllFilteredSelected) {
                    clearDeliverySelection();
                  } else {
                    selectAllFilteredDeliveries();
                  }
                }}
                className="text-xs font-semibold text-blue-600 px-2 py-1 rounded hover:bg-blue-50"
              >
                {isAllFilteredSelected ? 'Deselect' : 'Select All'}
              </button>

              {/* Timing Filter Dropdown */}
              <div className="relative" ref={timingButtonRef}>
                <button
                  type="button"
                  onClick={() => setTimingDropdownOpen((prev) => !prev)}
                  className={`px-2 sm:px-3 py-1 sm:py-2 rounded-lg text-xs sm:text-sm font-semibold transition whitespace-nowrap ${
                    timingFilters.length > 0
                      ? 'bg-blue-500 text-white'
                      : 'bg-white text-gray-700 border border-gray-300'
                  }`}
                  title="Filter by time"
                >
                  🕐 {timingFilters.length === 0 ? 'Timing' : `${timingFilters.length} hour(s)`}
                </button>
                {timingDropdownOpen && (
                  <div className="absolute left-0 mt-2 rounded-lg sm:rounded-xl bg-white border border-gray-200 min-w-max z-20 shadow-lg max-h-80 overflow-y-auto">
                    <div className="sticky top-0 flex justify-between px-3 sm:px-4 py-2 text-xs uppercase tracking-wide text-gray-400 border-b border-gray-200 bg-white">
                      <span>Select Hours</span>
                      <button 
                        type="button" 
                        onClick={() => setTimingFilters([])} 
                        className="text-blue-500 font-semibold"
                      >
                        Clear
                      </button>
                    </div>
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((hour) => {
                      const isActive = timingFilters.includes(hour);
                      return (
                        <button
                          key={hour}
                          type="button"
                          onClick={() => setTimingFilters(prev =>
                            prev.includes(hour)
                              ? prev.filter(h => h !== hour)
                              : [...prev, hour]
                          )}
                          className={`w-full text-left px-3 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-semibold flex items-center justify-between ${
                            isActive ? 'bg-blue-50 text-blue-600' : 'text-gray-600 hover:bg-gray-50'
                          }`}
                        >
                          <span>{hour}:00 AM</span>
                          {isActive && <Check className="w-4 h-4" />}
                        </button>
                      );
                    })}
                    <div className="sticky bottom-0 px-3 sm:px-4 py-2 text-xs text-gray-500 border-t border-gray-200 bg-white">
                      {timingFilters.length === 0 ? 'Showing all times' : `${timingFilters.length} hour(s) selected`}
                    </div>
                  </div>
                )}
              </div>

              {/* Driver Filter Mode Buttons - REMOVED */}
              
              {/* Unassigned Filter Button */}
              <button
                onClick={() => setShowUnassignedOnly(!showUnassignedOnly)}
                className={`px-2 sm:px-3 py-1 sm:py-2 rounded-lg text-xs sm:text-sm font-semibold transition whitespace-nowrap ${
                  showUnassignedOnly
                    ? 'bg-orange-500 text-white'
                    : 'bg-white text-gray-700 border border-gray-300'
                }`}
                title="Show only unassigned deliveries"
              >
                📦 Unassigned
              </button>

              {/* Collections Filter Button */}
              <button
                onClick={() => setShowCollectionsOnly(!showCollectionsOnly)}
                className={`px-2 sm:px-3 py-1 sm:py-2 rounded-lg text-xs sm:text-sm font-semibold transition whitespace-nowrap ${
                  showCollectionsOnly
                    ? 'bg-teal-500 text-white'
                    : 'bg-white text-gray-700 border border-gray-300'
                }`}
                title="Show only collection deliveries"
              >
                🗂️ Collections
              </button>

              {/* Print Button */}
              <button
                onClick={() => setPrintMode(true)}
                className="px-2 sm:px-3 py-1 sm:py-2 rounded-lg text-xs sm:text-sm font-semibold transition whitespace-nowrap bg-white text-gray-700 border border-gray-300 hover:bg-gray-50"
                title="Print delivery list"
              >
                🖨️ Print
              </button>
              {/* Map Button */}
              <button
                onClick={() => setMapModalOpen(true)}
                className="px-2 sm:px-3 py-1 sm:py-2 rounded-lg text-xs sm:text-sm font-semibold transition whitespace-nowrap bg-white text-gray-700 border border-gray-300 hover:bg-gray-50"
                title="Open map assign"
              >
                🗺️ Map
              </button>

              {/* Bag Assignment Button */}
              <button
                onClick={() => setBagAssignModalOpen(true)}
                className="px-2 sm:px-3 py-1 sm:py-2 rounded-lg text-xs sm:text-sm font-semibold transition whitespace-nowrap bg-white text-gray-700 border border-gray-300 hover:bg-gray-50"
                title="Assign bags to driver"
              >
                🎒 Assign Bags
              </button>
              
              {/* View Mode Toggle */}
              <div className="flex items-center border border-gray-300 rounded-lg overflow-hidden">
                <button
                  onClick={() => setViewMode('list')}
                  className={`px-1.5 sm:px-2 py-1 flex items-center ${
                    viewMode === 'list' 
                      ? 'bg-blue-500 text-white' 
                      : 'bg-white text-gray-600'
                  }`}
                  title="List view"
                >
                  <List className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                </button>
                <button
                  onClick={() => setViewMode('grid')}
                  className={`px-1.5 sm:px-2 py-1 flex items-center border-l border-gray-300 ${
                    viewMode === 'grid' 
                      ? 'bg-blue-500 text-white' 
                      : 'bg-white text-gray-600'
                  }`}
                  title="Grid view"
                >
                  <LayoutGrid className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>

        {deliveriesLoading ? (
          <div className="mt-4 sm:mt-6 rounded-lg sm:rounded-2xl bg-white p-4 sm:p-6 shadow-sm flex items-center justify-center gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-blue-500" />
            <span className="text-xs sm:text-sm text-gray-500">Loading today's deliveries...</span>
          </div>
        ) : filteredDeliveries.length === 0 ? (
          <div className="mt-4 sm:mt-6 rounded-lg sm:rounded-2xl bg-white p-4 sm:p-6 shadow-sm text-center text-xs sm:text-sm text-gray-500">
            No deliveries found for this filter - try another area or clear your search.
          </div>
        ) : viewMode === 'list' ? (
          <div className="mt-2 sm:mt-4 space-y-2 sm:space-y-4 pb-24">
            {filteredDeliveries.map((delivery) => renderDeliveryCard(delivery))}
          </div>
        ) : (
          <div className="mt-2 sm:mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-3 pb-24">
            {filteredDeliveries.map((delivery) => renderDeliveryGridCard(delivery))}
          </div>
        )}
      </div>

      <AnimatePresence>
        {assignmentCount > 0 && (
          <>
            <motion.div
              key="dispatcher-overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.35 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 bg-black z-40"
              onClick={closeAssignmentSheet}
            />
            <motion.div
              key={`assignment-${assignmentCount}-${primaryDelivery?._id || 'multi'}`}
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', stiffness: 160, damping: 25 }}
              className="fixed inset-x-0 bottom-0 z-50 px-4 safe-area-bottom"
            >
              <div className="bg-white rounded-t-[28px] shadow-2xl p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-gray-400">
                      {assignmentCount === 1 ? 'Assign driver' : 'Assign to selected'}
                    </p>
                    <h2 className="text-lg font-semibold text-gray-900">
                      {assignmentTitle}
                    </h2>
                  </div>
                  <button
                    type="button"
                    onClick={closeAssignmentSheet}
                    className="p-2 rounded-full bg-slate-100 shadow-sm"
                  >
                    <X className="h-4 w-4 text-gray-500" />
                  </button>
                </div>

                <div className="text-sm text-gray-500 flex items-center gap-3">
                  <MapPin className="w-4 h-4 text-slate-400" />
                  <span>{primaryDelivery?.address || primaryDelivery?.zone || `${assignmentCount} deliveries`}</span>
                </div>

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm text-gray-500">
                    <Clock className="w-4 h-4 text-slate-400" />
                    <span>{primaryDelivery ? formatTime(primaryDelivery.scheduledTime) : '--:--'}</span>
                  </div>
                  <span
                    className={`px-3 py-1 text-xs font-semibold rounded-full ${
                      statusPills[primaryDelivery?.status] || 'bg-gray-100 text-gray-600'
                    }`}
                  >
                    {primaryDelivery ? getStatusLabel(primaryDelivery.status) : 'Queued'}
                  </span>
                </div>

                <div className="text-xs text-gray-400">
                  {assignmentCount === 1
                    ? 'Tap to select the driver for this delivery.'
                    : `Tap to assign ${assignmentCount} deliveries together.`}
                </div>

                <div className="mt-3 space-y-3">
                  <button
                    type="button"
                    onClick={() => setDriverListOpen((prev) => !prev)}
                    className="w-full flex items-center justify-between rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm font-semibold text-blue-700"
                  >
                    <span>{primaryDelivery?.driver ? 'Change driver' : 'Choose driver'}</span>
                    <ChevronDown
                      className={`w-4 h-4 text-blue-700 ${driverListOpen ? 'rotate-180' : ''}`}
                    />
                  </button>

                  {driverListOpen && (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-slate-50 px-3 py-2 text-sm text-gray-500">
                        <Search className="w-4 h-4" />
                        <input
                          value={driverSearchTerm}
                          onChange={(event) => setDriverSearchTerm(event.target.value)}
                          placeholder="Search drivers"
                          className="flex-1 bg-transparent text-xs text-gray-700 placeholder:text-gray-400 outline-none"
                          autoComplete="off"
                          autoCorrect="off"
                          autoCapitalize="off"
                          spellCheck="false"
                        />
                        {driverSearchTerm && (
                          <button
                            type="button"
                            onClick={() => setDriverSearchTerm('')}
                            className="text-xs font-semibold text-blue-500"
                          >
                            Clear
                          </button>
                        )}
                      </div>

                      {driversLoading ? (
                        <div className="rounded-2xl bg-white p-4 text-center text-sm text-gray-500 shadow-sm">
                          Loading driversâ€¦
                        </div>
                      ) : filteredDriverList.length === 0 ? (
                        <div className="rounded-2xl bg-white p-4 text-center text-sm text-gray-500 shadow-sm">
                          No drivers matched your search.
                        </div>
                      ) : (
                        <div className="space-y-3 max-h-[300px] overflow-y-auto pr-1">
                          {filteredDriverList.map((driver) => renderDriverRow(driver))}
                        </div>
                      )}
                    </div>
                  )}

                  {!driverListOpen && (
                    <p className="text-xs text-gray-400">
                      Tap the button to view the driver list with search.
                    </p>
                  )}
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {(deliveriesError || feedback.message) && (
        <div
          className={`fixed bottom-6 left-4 right-4 z-[70] rounded-xl p-4 text-sm ${
            feedback.error ? 'bg-rose-500 text-white' : 'bg-white border border-slate-200 text-gray-900'
          }`}
        >
          <div className="flex items-center justify-between">
            <p>{feedback.message || deliveriesError}</p>
            <button type="button" onClick={() => setFeedback({ message: '', error: false })}>
              <X className={`h-4 w-4 ${feedback.error ? 'text-white' : 'text-gray-600'}`} />
            </button>
          </div>
        </div>
      )}

      {/* Floating Action Button - Create Task */}
      <button
        onClick={() => navigate('/add-delivery')}
        className="fixed bottom-6 right-6 z-50 w-14 h-14 bg-blue-600 text-white rounded-full flex items-center justify-center"
        title="Create new delivery"
      >
        <Plus className="w-6 h-6" />
      </button>

      {/* Print Modal */}
      {printMode && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-lg max-w-2xl w-full max-h-96 flex flex-col">
            <div className="flex justify-between items-center p-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">Print Delivery List</h2>
              <button
                onClick={() => setPrintMode(false)}
                className="p-1 hover:bg-gray-100 rounded"
              >
                <X className="w-5 h-5 text-gray-600" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              <label className="block text-sm font-medium text-gray-700 mb-3">
                Filter by Driver (Optional)
              </label>
              <select
                value={printDriverFilter || ''}
                onChange={(e) => setPrintDriverFilter(e.target.value || null)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none mb-4"
              >
                <option value="">All Drivers</option>
                <option value="unassigned">Unassigned Only</option>
                {sortedDrivers.map((driver) => (
                  <option key={driver._id} value={driver._id}>
                    {getDriverDisplayName(driver)}
                  </option>
                ))}
              </select>

              <div className="border-t border-gray-200 pt-4">
                <h3 className="font-semibold text-gray-900 mb-3">Preview ({
                  filteredDeliveries.filter(d => {
                    if (!printDriverFilter) return true;
                    if (printDriverFilter === 'unassigned') return !d.driver;
                    return d.driver?._id === printDriverFilter;
                  }).length
                } deliveries)</h3>
                <div className="space-y-2 text-sm bg-gray-50 p-3 rounded max-h-48 overflow-y-auto">
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

            <div className="flex justify-end gap-2 p-4 border-t border-gray-200">
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

      {/* Map Assign Modal */}
      <DispatcherMapAssignModal
        open={mapModalOpen}
        onClose={() => setMapModalOpen(false)}
        deliveries={filteredDeliveries}
        drivers={drivers}
      />

      {bagAssignModalOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-3 sm:p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Assign Bags To Driver</h2>
                <p className="text-xs text-gray-500">Scan multiple bags, then choose one driver</p>
              </div>
              <button onClick={closeBagAssignModal} className="p-2 hover:bg-gray-100 rounded-lg">
                <X className="w-5 h-5 text-gray-600" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="border border-gray-200 rounded-xl overflow-hidden">
                <div className="p-3 border-b border-gray-200 bg-gray-50">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-semibold text-gray-700">Bag Scanner</h3>
                    <span className="text-xs text-gray-500">{scannedBagIds.length} scanned</span>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setShowBagScanner((prev) => !prev)}
                      className={`px-3 py-2 rounded-lg text-xs font-semibold ${showBagScanner ? 'bg-red-100 text-red-700' : 'bg-blue-600 text-white'}`}
                    >
                      {showBagScanner ? 'Stop Scanner' : 'Start Scanner'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setScannedBagIds([]);
                        setLastScannedBagId('');
                        setBagScanMessage('Cleared scanned list');
                      }}
                      className="px-3 py-2 rounded-lg text-xs font-semibold bg-gray-200 text-gray-700"
                    >
                      Clear
                    </button>
                  </div>
                  {bagScanMessage && <p className="mt-2 text-xs text-gray-600">{bagScanMessage}</p>}
                  {lastScannedBagId && <p className="mt-1 text-xs text-blue-700">Last scan: {lastScannedBagId}</p>}
                </div>

                <div className="max-h-[52vh] overflow-y-auto p-2 space-y-2">
                  {showBagScanner && (
                    <div className="rounded-lg overflow-hidden border border-gray-200 bg-black h-56">
                      <SimpleQrScanner
                        key="dispatcher-bag-scanner"
                        onScan={handleBagQrScan}
                        constraints={{
                          facingMode: 'environment',
                          aspectRatio: 1,
                        }}
                        scanDelay={220}
                        styles={{
                          container: {
                            width: '100%',
                            height: '100%',
                          },
                          video: {
                            objectFit: 'cover',
                          },
                        }}
                      />
                    </div>
                  )}

                  {scannedBagIds.length === 0 ? (
                    <div className="rounded-lg bg-white p-4 text-center text-sm text-gray-500">No scanned bags yet.</div>
                  ) : (
                    scannedBagIds.map((bagId) => {
                      return (
                        <div
                          key={bagId}
                          className="w-full text-left rounded-lg border p-3 flex items-start gap-3 border-gray-200 bg-white"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <Package className="w-4 h-4 text-blue-600" />
                              <p className="text-sm font-semibold text-gray-900 truncate">{bagId}</p>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => removeScannedBag(bagId)}
                            className="text-red-500 hover:text-red-700"
                            title="Remove"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              <div className="border border-gray-200 rounded-xl overflow-hidden">
                <div className="p-3 border-b border-gray-200 bg-gray-50">
                  <h3 className="text-sm font-semibold text-gray-700 mb-2">Choose Driver</h3>
                  <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-500">
                    <Search className="w-4 h-4" />
                    <input
                      value={bagDriverSearchTerm}
                      onChange={(event) => setBagDriverSearchTerm(event.target.value)}
                      placeholder="Search drivers"
                      className="flex-1 bg-transparent text-xs text-gray-700 placeholder:text-gray-400 outline-none"
                    />
                  </div>
                </div>

                <div className="max-h-[52vh] overflow-y-auto p-2 space-y-2">
                  {filteredBagDriverList.map((driver) => {
                    const load = driverLoadCounts[driver._id] || 0;
                    const busy = bagAssigningDriverId === driver._id;
                    return (
                      <button
                        type="button"
                        key={driver._id}
                        onClick={() => handleAssignBagsToDriver(driver)}
                        disabled={scannedBagIds.length === 0 || (bagAssigningDriverId && bagAssigningDriverId !== driver._id)}
                        className={`w-full rounded-lg border p-3 text-left flex items-center justify-between ${
                          scannedBagIds.length === 0
                            ? 'opacity-50 cursor-not-allowed bg-gray-50 border-gray-200'
                            : 'bg-white border-gray-200 hover:border-blue-300'
                        }`}
                      >
                        <div>
                          <p className="text-sm font-semibold text-gray-900">{getDriverDisplayName(driver)}</p>
                          <p className="text-xs text-gray-500">Loads {load}</p>
                        </div>
                        {busy ? <Loader2 className="w-4 h-4 animate-spin text-blue-600" /> : <ArrowRight className="w-4 h-4 text-blue-600" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delivery Detail Modal */}
      {selectedDeliveryDetail && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full my-8">
            <div className="flex justify-between items-center p-4 sm:p-6 border-b border-gray-200 sticky top-0 bg-white rounded-t-xl">
              <div>
                <h2 className="text-lg sm:text-xl font-semibold text-gray-900">Delivery Details</h2>
                <p className="text-sm text-gray-500">{selectedDeliveryDetail.customerId}</p>
              </div>
              <button
                onClick={() => setSelectedDeliveryDetail(null)}
                className="p-1 hover:bg-gray-100 rounded-lg transition"
              >
                <X className="w-5 h-5 text-gray-600" />
              </button>
            </div>

            <div className="overflow-y-auto max-h-[70vh] p-4 sm:p-6 space-y-4">
              {/* Delivery Proof Images */}
              {selectedDeliveryDetail.proof?.images && selectedDeliveryDetail.proof.images.length > 0 && (
                <div className="border-b border-gray-200 pb-4">
                  <h3 className="text-sm font-semibold text-gray-600 mb-3">📸 Proof of Delivery</h3>
                  <div className="grid grid-cols-2 gap-2">
                    {selectedDeliveryDetail.proof.images.map((image, idx) => (
                      <div key={idx} className="relative">
                        <img 
                          src={image} 
                          alt={`Proof ${idx + 1}`}
                          className="w-full h-24 object-cover rounded-lg border border-gray-200"
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
              <div className="bg-gradient-to-r from-blue-50 to-blue-100 border border-blue-200 rounded-lg p-4">
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
                  <div className="flex items-start gap-2">
                    <MapPin className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <p className="text-xs text-gray-500">Address</p>
                      <p className="font-semibold text-gray-900 text-sm">{selectedDeliveryDetail.address || 'Not provided'}</p>
                    </div>
                  </div>
                  {selectedDeliveryDetail.zone && (
                    <div className="flex items-start gap-2">
                      <Target className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" />
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
                  <span className={`text-xs font-semibold px-3 py-1 rounded-full ${statusPills[selectedDeliveryDetail.status] || 'bg-gray-50 text-gray-700'}`}>
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

            <div className="flex justify-between gap-2 p-4 sm:p-6 border-t border-gray-200 sticky bottom-0 bg-white rounded-b-xl">
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
                  setSelectedDeliveryDetail(null);
                  openAssignmentSheet([selectedDeliveryDetail]);
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
            <div className="flex items-center justify-between p-4 sm:p-6 border-b border-gray-200 sticky top-0 bg-white">
              <h2 className="text-lg sm:text-xl font-bold text-gray-900">Edit Delivery</h2>
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
              className="p-4 sm:p-6 space-y-4"
            >
              <div className="grid grid-cols-1 gap-4">
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
                <div>
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
                <div>
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

      <style>{`
        .safe-area-top {
          padding-top: calc(env(safe-area-inset-top, 0px) + 1.25rem);
        }
        .safe-area-bottom {
          padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 1rem);
        }
      `}</style>

      {/* Scheduled Events Modal */}
      {showEventsModal && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black bg-opacity-40">
          <div className="bg-white rounded-t-2xl shadow-2xl w-full max-h-[92vh] flex flex-col">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                {eventsSelectedDay ? (
                  <button
                    onClick={() => setEventsSelectedDay(null)}
                    className="flex items-center gap-1 text-indigo-600 font-semibold shrink-0"
                  >
                    <ChevronLeft className="w-5 h-5" /> Back
                  </button>
                ) : (
                  <Briefcase className="w-5 h-5 text-indigo-600 shrink-0" />
                )}
                <h2 className="text-base font-bold text-gray-900 truncate">
                  {eventsSelectedDay
                    ? eventsSelectedDay.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
                    : 'Scheduled Events'}
                </h2>
                {!eventsSelectedDay && todayEventCount > 0 && (
                  <span className="bg-red-500 text-white text-xs font-bold px-2 py-0.5 rounded-full shrink-0">{todayEventCount} today</span>
                )}
                {eventsSelectedDay && (
                  <span className="bg-indigo-100 text-indigo-700 text-xs font-bold px-2 py-0.5 rounded-full shrink-0">{eventsDayEvents.length} event{eventsDayEvents.length !== 1 ? 's' : ''}</span>
                )}
              </div>
              <button onClick={() => { setShowEventsModal(false); setEventsSelectedDay(null); }} className="p-1 hover:bg-gray-100 rounded-lg shrink-0">
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            {/* Modal Body */}
            <div className="overflow-y-auto flex-1 p-3">
              {events.length === 0 ? (
                <p className="text-center text-gray-400 py-10">No events found.</p>
              ) : eventsSelectedDay ? (
                /* Day Detail View */
                <div className="space-y-3">
                  {eventsDayEvents.length === 0 ? (
                    <p className="text-center text-gray-400 py-10">No events on this day.</p>
                  ) : (
                    eventsDayEvents.map((ev) => (
                      <div key={ev._id} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden cursor-pointer active:opacity-80 transition" onClick={() => { dispatch(setSelectedEvent(ev)); setShowEventDetail(true); }}>
                        <div className={`px-4 py-3 flex items-center justify-between ${
                          ev.status === 'confirmed' ? 'bg-emerald-50 border-b border-emerald-200' :
                          ev.status === 'cancelled' ? 'bg-gray-100 border-b border-gray-200' :
                          'bg-indigo-50 border-b border-indigo-200'
                        }`}>
                          <div className="flex-1 min-w-0">
                            <p className={`font-bold text-sm truncate ${ev.status === 'cancelled' ? 'line-through text-gray-400' : 'text-gray-900'}`}>{ev.eventName}</p>
                            <p className="text-xs text-gray-500">{ev.companyName}</p>
                          </div>
                          <span className={`ml-2 shrink-0 text-xs font-bold px-2 py-0.5 rounded-full ${
                            ev.status === 'confirmed' ? 'bg-emerald-100 text-emerald-700' :
                            ev.status === 'cancelled' ? 'bg-gray-200 text-gray-500' :
                            'bg-amber-100 text-amber-700'
                          }`}>{ev.status}</span>
                        </div>
                        <div className="px-4 py-3 space-y-2 text-sm">
                          {ev.arrivalTime && (
                            <div className="flex items-center gap-2">
                              <Clock className="w-4 h-4 text-indigo-400 shrink-0" />
                              <span className="text-gray-500 text-xs">Arrival:</span>
                              <span className="font-semibold text-gray-800">{ev.arrivalTime}</span>
                            </div>
                          )}
                          {ev.venue?.address && (
                            <div className="flex items-start gap-2">
                              <MapPin className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                              <span className="text-gray-700">{ev.venue.address}{ev.emirate ? `, ${ev.emirate}` : ''}</span>
                            </div>
                          )}
                          {ev.logistics?.guestCount > 0 && (
                            <div className="flex items-center gap-2">
                              <User className="w-4 h-4 text-indigo-400 shrink-0" />
                              <span className="text-gray-700">{ev.logistics.guestCount} guests</span>
                            </div>
                          )}
                          {(ev.logistics?.food || []).length > 0 && (
                            <div className="flex flex-wrap gap-1 pt-1">
                              {ev.logistics.food.map((f, i) => (
                                <span key={i} className="text-xs bg-green-50 text-green-700 border border-green-200 px-2 py-0.5 rounded-full">{f.name}</span>
                              ))}
                            </div>
                          )}
                          {ev.notes && <p className="text-xs text-gray-400 italic pt-1">{ev.notes}</p>}
                        </div>
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

      <EventDetailModal isOpen={showEventDetail} onClose={() => setShowEventDetail(false)} />
    </div>
  );
};

export default DispatcherMobile;









