import React, { Suspense, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import '../styles/driver-mobile-lite.css';
import {
  Package,
  MapPin,
  Clock,
  CheckCircle,
  XCircle,
  Camera,
  Navigation,
  User,
  BarChart3,
  LogOut,
  Bell,
  Menu,
  X,
  Check,
  Phone,
  MessageCircle,
  RefreshCw,
  QrCode,
  Scan,
  ArrowLeft,
  RotateCcw,
  Archive,
  Truck,
  Upload,
  AlertTriangle,
  Zap,
  Search
} from 'lucide-react';
import { logout } from '../store/slices/authSlice';
import { 
  fetchDriverDeliveries, 
  updateDeliveryStatus,
  setCurrentDelivery,
  clearCurrentDelivery,
  returnBag
} from '../store/slices/driverMobileSlice';
import { updateDriverLocation } from '../store/slices/driverSlice';
import { uploadPhoto } from '../utils/fileUpload';
import { storePhotoOffline, queueDeliveryUpdate, getPendingCount } from '../utils/offlineStorage';
import { syncOfflineData, setupAutoSync, setupAutoRetry, onSyncStatusChange, retryDeliverySync } from '../utils/offlineSync';
import { useSyncStatus, getSyncStatusIndicator } from '../hooks/useSyncStatus';
import api from '../utils/api';
import HandoffCard from '../components/driver/HandoffCard';
import BagHandoverPanel from '../components/driver/BagHandoverPanel';
import DriverSyncSummary from '../components/driver/DriverSyncSummary';
import { motion } from 'framer-motion';
import offlineStorage from '../utils/offlineStorage';

const QRScanner = React.lazy(() => import('../components/SimpleQrScanner'));

const MAX_PHOTO_DIMENSION = 800;
const PHOTO_QUALITY = 0.6;
const MIN_LOCATION_UPDATE_INTERVAL = 10000;
const SCAN_STABILIZE_COUNT = 1;
const SCAN_STABILIZE_WINDOW = 400; // ms - reduced for faster stabilization
const SCAN_COOLDOWN_MS = 150; // ms - reduced for instant capture

const ScannerFallback = () => (
  <div className="flex h-64 items-center justify-center rounded-lg bg-gray-50 text-gray-500">
    Initializing scanner...
  </div>
);

const buildDeliverySearchKey = (delivery) => {
  return delivery?.customerName?.toLowerCase().trim() || '';
};

const getDeliveryUniqueKey = (delivery) =>
  delivery?._id || delivery?.deliveryId || delivery?.bagId || null;

const useDebouncedValue = (value, delay = 200) => {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(handler);
  }, [value, delay]);

  return debouncedValue;
};

const GEO_STATUS_STYLES = {
  success: 'border border-emerald-200 bg-emerald-50 text-emerald-800',
  fallback: 'border border-amber-200 bg-amber-50 text-amber-800',
  error: 'border border-red-200 bg-red-50 text-red-700',
  idle: 'border border-blue-200 bg-blue-50 text-blue-700'
};

const getScaledDimensions = (width, height) => {
  if (!width || !height) {
    return { width: MAX_PHOTO_DIMENSION, height: MAX_PHOTO_DIMENSION };
  }
  const longestSide = Math.max(width, height);
  const scale = longestSide > MAX_PHOTO_DIMENSION ? MAX_PHOTO_DIMENSION / longestSide : 1;
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale)
  };
};

const DriverMobile = () => {
  const [activeTab, setActiveTab] = useState('deliveries');
  const [showMenu, setShowMenu] = useState(false);
  const [currentStep, setCurrentStep] = useState('delivery');
  const [showSimulation, setShowSimulation] = useState(false);
  const [simulatedTimes, setSimulatedTimes] = useState([]);
  const [simulationStartIndex, setSimulationStartIndex] = useState(null);
  const [simulationEndIndex, setSimulationEndIndex] = useState(null);
  const [showSimulationConfig, setShowSimulationConfig] = useState(false);
  const [simulationStartTime, setSimulationStartTime] = useState(null);
  const [simulationStartTimeInput, setSimulationStartTimeInput] = useState('');
  const [simulationStartDateInput, setSimulationStartDateInput] = useState('');
  
  // History state group
  const [historyState, setHistoryState] = useState({
    period: 'today',
    deliveries: [],
    loading: false
  });
  
  // Flow state group
  const [flowState, setFlowState] = useState({
    showReturnFlow: false,
    showBagReturnFlow: false,
    isBagCollectionFlow: false,
    showReturnBagsQuestion: false,
    isReturningBags: false
  });
  
  // Bag scanning state group
  const [bagState, setBagState] = useState({
    scannedBagId: '',
    scannedBags: [],
    returnedBags: [],
    collectionScans: [],
    toReturn: [],
    qrSkipped: false
  });
  
  // Return state group
  const [returnState, setReturnState] = useState({
    reason: '',
    notes: ''
  });
  
  // Camera state group
  const [cameraState, setCameraState] = useState({
    facingMode: 'environment',
    flashSupported: false,
    flashOn: false,
    support: { canUseCamera: true, reason: '' },
    capturedPhoto: null,
    bagReturnPhoto: null,
    noBagsPhoto: null
  });
  
  // UI feedback state group
  const [feedback, setFeedback] = useState({
    scanError: '',
    scanSuccess: '',
    isUploading: false
  });
  const [scannerKey, setScannerKey] = useState(0);
  const [showScannerRetry, setShowScannerRetry] = useState(false);
  
  // Filter state group
  const [filterState, setFilterState] = useState({
    searchTerm: '',
    selectedLetter: '',
    sortAlphabetical: false,
    showAlphabetFilter: false
  });
  
  // Offline state group
  const [offlineState, setOfflineState] = useState({
    isOnline: navigator.onLine,
    queue: [],
    syncStatus: { syncing: false, progress: 0 }
  });
  
  const [geolocationStatus, setGeolocationStatus] = useState({ state: 'idle', message: '' });
  const [completedDeliveries, setCompletedDeliveries] = useState(new Set());
  
  // Track sync status of pending deliveries
  const { syncStatus: deliverySyncStatus, isSyncing } = useSyncStatus();

  const normalizePosition = useCallback((pos) => {
    if (!pos) return null;
    if (pos.coords) {
      const c = pos.coords;
      const latitude = c.latitude ?? pos.lat;
      const longitude = c.longitude ?? pos.lng;
      return {
        lat: latitude,
        lng: longitude,
        accuracy: c.accuracy,
        coords: {
          latitude,
          longitude,
          accuracy: c.accuracy,
          heading: c.heading,
          speed: c.speed,
          altitude: c.altitude
        }
      };
    }
    if (typeof pos.lat === 'number' && typeof pos.lng === 'number') {
      return {
        lat: pos.lat,
        lng: pos.lng,
        accuracy: pos.accuracy,
        coords: {
          latitude: pos.lat,
          longitude: pos.lng,
          accuracy: pos.accuracy,
          heading: pos.heading,
          speed: pos.speed,
          altitude: pos.altitude
        }
      };
    }
    return null;
  }, []);
  
  // Debounce search to 300ms to reduce unnecessary filter recalculations
  const debouncedSearchTerm = useDebouncedValue(filterState.searchTerm, 300);
  
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const lastScannedValueRef = useRef('');
  const lastScanTimestampRef = useRef(0);
  const scanStateRef = useRef({ value: '', count: 0, timestamp: 0 });
  const lastKnownLocationRef = useRef(null);
  const geolocationWatchId = useRef(null);
  const locationUpdateTimerRef = useRef(null);
  const pendingLocationRef = useRef(null);
  const lastLocationSentRef = useRef(0);
  const fileInputRef = useRef(null);
  const { user } = useSelector(state => state.auth);
  const { deliveries, handoffs = [], currentDelivery, isLoading, error } = useSelector(state => state.driverMobile);
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const driverAccuracyRate = typeof user?.kpi?.accuracyRate === 'number'
    ? user.kpi.accuracyRate
    : 0;

  const highAccuracyOptions = useMemo(() => ({
    enableHighAccuracy: true,
    timeout: 15000,
    maximumAge: 5000
  }), []);

  const lowAccuracyOptions = useMemo(() => ({
    enableHighAccuracy: false,
    timeout: 7000,
    maximumAge: 20000
  }), []);

  const shouldFallbackToLowAccuracy = useCallback((code) => code === 2 || code === 3, []);

  const formatDelayLabel = useCallback((diffMinutes) => {
    const abs = Math.abs(diffMinutes);
    const hoursValue = Math.round((abs / 60) * 10) / 10;
    const unit = abs >= 60
      ? `${Number.isInteger(hoursValue) ? hoursValue : hoursValue.toFixed(1)}h`
      : `${abs}m`;

    if (diffMinutes > 0) return `+${unit} late`;
    if (diffMinutes < -5) return `-${unit} early`;
    return 'On time';
  }, []);

  // Consolidated initialization effect
  useEffect(() => {
    // Fetch deliveries
    dispatch(fetchDriverDeliveries());
    
    // Setup auto-sync for offline data
    setupAutoSync();
    setupAutoRetry();
    
    // Subscribe to sync status updates
    const unsubscribe = onSyncStatusChange((status) => {
      setOfflineState(prev => ({ ...prev, syncStatus: status }));
    });
    
    // Load pending queue count
    const loadPendingCount = async () => {
      const count = await getPendingCount();
      setOfflineState(prev => ({ ...prev, queue: Array(count.total).fill(null) }));
    };
    loadPendingCount();

    // Online/Offline detection handlers
    const handleOnline = async () => {
      setOfflineState(prev => ({ ...prev, isOnline: true }));
      setFeedback({ scanError: '', scanSuccess: '🟢 Back online! Syncing data...', isUploading: false });
      setTimeout(() => setFeedback(prev => ({ ...prev, scanSuccess: '' })), 3000);
      
      // Trigger sync when connection is restored
      setTimeout(async () => {
        const result = await syncOfflineData();
        const count = await getPendingCount();
        setOfflineState(prev => ({ ...prev, queue: Array(count.total).fill(null) }));
        
        if (result.success) {
          setFeedback({ scanError: '', scanSuccess: `✅ Synced ${result.processed} items successfully!`, isUploading: false });
          setTimeout(() => setFeedback(prev => ({ ...prev, scanSuccess: '' })), 3000);
        }
      }, 2000);
    };

    const handleOffline = () => {
      setOfflineState(prev => ({ ...prev, isOnline: false }));
      setFeedback({ scanError: '📴 Offline mode - Your work will be saved and synced when you\'re back online', scanSuccess: '', isUploading: false });
      setTimeout(() => setFeedback(prev => ({ ...prev, scanError: '' })), 5000);
    };

    // Initial connection check
    const checkConnection = async () => {
      try {
        await fetch('/api/health', { method: 'HEAD', cache: 'no-cache' });
        if (!navigator.onLine) setOfflineState(prev => ({ ...prev, isOnline: true }));
      } catch {
        if (navigator.onLine) setOfflineState(prev => ({ ...prev, isOnline: false }));
      }
    };
    checkConnection();

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    
    return () => {
      unsubscribe();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [dispatch]);

  const getCurrentLocation = useCallback(async () => {
    if (!navigator.geolocation) {
      setGeolocationStatus({ state: 'error', message: 'Geolocation not supported on this device.' });
      return null;
    }

    const requestPosition = (options) => new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, options);
    });

    try {
      const position = await requestPosition(highAccuracyOptions);
      setGeolocationStatus({ state: 'success', message: 'GPS lock acquired.' });
      return {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy
      };
    } catch (error) {
      if (shouldFallbackToLowAccuracy(error.code)) {
        setGeolocationStatus({ state: 'fallback', message: 'GPS weak, using approximate location.' });
        try {
          const fallbackPosition = await requestPosition(lowAccuracyOptions);
          return {
            lat: fallbackPosition.coords.latitude,
            lng: fallbackPosition.coords.longitude,
            accuracy: fallbackPosition.coords.accuracy
          };
        } catch (fallbackError) {
          setGeolocationStatus({ state: 'error', message: fallbackError.message || 'Unable to determine location.' });
        }
      } else {
        setGeolocationStatus({ state: 'error', message: error.message || 'Unable to determine location.' });
      }
    }

    return null;
  }, [highAccuracyOptions, lowAccuracyOptions, shouldFallbackToLowAccuracy]);

  const dispatchLocationUpdate = useCallback((position) => {
    const normalized = normalizePosition(position);
    if (!normalized || !(user?._id || user?.id)) return;

    const driverId = user._id || user.id;
    lastKnownLocationRef.current = normalized;

    const coords = normalized.coords;
    dispatch(updateDriverLocation({
      driverId,
      location: {
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy: coords.accuracy,
        heading: coords.heading,
        speed: coords.speed,
        altitude: coords.altitude
      }
    }));
    lastLocationSentRef.current = Date.now();
  }, [dispatch, user, normalizePosition]);

  const scheduleLocationUpdate = useCallback((position) => {
    const normalized = normalizePosition(position);
    if (!normalized || !(user?._id || user?.id)) return;

    lastKnownLocationRef.current = normalized;
    pendingLocationRef.current = normalized;
    const elapsed = Date.now() - lastLocationSentRef.current;
    const delay = lastLocationSentRef.current === 0
      ? 0
      : Math.max(MIN_LOCATION_UPDATE_INTERVAL - elapsed, 0);

    if (locationUpdateTimerRef.current) return;

    locationUpdateTimerRef.current = setTimeout(() => {
      if (pendingLocationRef.current) {
        dispatchLocationUpdate(pendingLocationRef.current);
        pendingLocationRef.current = null;
      }
      locationUpdateTimerRef.current = null;
    }, delay);
  }, [dispatchLocationUpdate, user, normalizePosition]);

  useEffect(() => {
    if (!navigator.geolocation || !(user?._id || user?.id)) return;

    const requestPosition = (options) => new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, options);
    });

    const runInitialPosition = async () => {
      try {
        const position = await requestPosition(highAccuracyOptions);
        dispatchLocationUpdate(position);
      } catch (error) {
        if (shouldFallbackToLowAccuracy(error.code)) {
          try {
            const fallbackPosition = await requestPosition(lowAccuracyOptions);
            setGeolocationStatus({ state: 'fallback', message: 'Live GPS using approximate signal.' });
            dispatchLocationUpdate(fallbackPosition);
          } catch (fallbackError) {
            setGeolocationStatus({ state: 'error', message: fallbackError.message || 'Unable to get GPS position.' });
          }
        } else {
          setGeolocationStatus({ state: 'error', message: error.message || 'Unable to get GPS position.' });
        }
      }
    };

    runInitialPosition();

    const startWatch = (options, isFallback = false) => {
      const watchId = navigator.geolocation.watchPosition(
        (position) => {
          setGeolocationStatus({
            state: isFallback ? 'fallback' : 'success',
            message: isFallback ? 'Using approximate GPS signal.' : ''
          });
          scheduleLocationUpdate(position);
        },
        (error) => {
          console.warn('Geolocation watch error:', error);
          if (!isFallback && shouldFallbackToLowAccuracy(error.code)) {
            if (navigator.geolocation?.clearWatch && geolocationWatchId.current !== null) {
              navigator.geolocation.clearWatch(geolocationWatchId.current);
            }
            geolocationWatchId.current = startWatch(lowAccuracyOptions, true);
          } else {
            setGeolocationStatus({
              state: 'error',
              message: error.message || 'Unable to update live location.'
            });
          }
        },
        options
      );

      geolocationWatchId.current = watchId;
      return watchId;
    };

    const watchId = startWatch(highAccuracyOptions);

    return () => {
      if (watchId !== null && navigator.geolocation?.clearWatch) {
        navigator.geolocation.clearWatch(watchId);
      }
    };
  }, [dispatchLocationUpdate, highAccuracyOptions, lowAccuracyOptions, scheduleLocationUpdate, shouldFallbackToLowAccuracy]);

  useEffect(() => () => {
    if (locationUpdateTimerRef.current) {
      clearTimeout(locationUpdateTimerRef.current);
      locationUpdateTimerRef.current = null;
    }
  }, []);

  // Check camera support on mount
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const isSecure = window.isSecureContext !== false;
    const hasMediaDevices =
      typeof navigator !== 'undefined' &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function';

    if (!isSecure || !hasMediaDevices) {
      setCameraState(prev => ({
        ...prev,
        support: {
          canUseCamera: false,
          reason: !isSecure
            ? 'Camera access requires HTTPS or localhost. Please use a secure connection to enable scanning.'
            : 'Camera access is not supported in this browser.'
        }
      }));
    }
  }, []);

  const LOCAL_TZ_OFFSET_MINUTES = parseInt(process.env.REACT_APP_LOCAL_TIMEZONE_OFFSET_MINUTES || '240', 10);
  const EARLY_NEXT_DAY_ENABLED = String(process.env.REACT_APP_ENABLE_EARLY_NEXT_DAY || '1') === '1';
  const NEXT_DAY_AVAILABLE_HOUR = parseInt(process.env.REACT_APP_NEXT_DAY_AVAILABLE_HOUR || '16', 10);

  const isDeliveryForToday = useCallback((delivery) => {
    if (!delivery) return false;
    
    const now = new Date();
    const offsetMs = LOCAL_TZ_OFFSET_MINUTES * 60 * 1000;
    const nowLocal = new Date(now.getTime() + offsetMs);
    const targetDayString = nowLocal.toISOString().split('T')[0];
    const localMidnight = new Date(targetDayString + 'T00:00:00.000Z');
    const todayStart = new Date(localMidnight.getTime() - offsetMs);
    let todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000 - 1);

    if (EARLY_NEXT_DAY_ENABLED && nowLocal.getHours() >= NEXT_DAY_AVAILABLE_HOUR) {
      todayEnd = new Date(todayStart.getTime() + 48 * 60 * 60 * 1000 - 1);
    }

    const isTodayOrFuture = (value) => {
      if (!value) return false;
      const parsedDate = new Date(value);
      if (Number.isNaN(parsedDate.getTime())) {
        return false;
      }
      // Show if scheduled for today (including early morning times like 3am)
      const isInRange = parsedDate >= todayStart && parsedDate <= todayEnd;
      return isInRange;
    };

    return [
      delivery.scheduledTime,
      delivery.scheduledDate,
      delivery.deliveryDate
    ].some(isTodayOrFuture);
  }, []);

  // Optimized delivery filtering with multiple memoization stages
  const normalizedSearch = useMemo(
    () => (debouncedSearchTerm || '').trim().toLowerCase(),
    [debouncedSearchTerm]
  );

  // Stage 1: Filter today's deliveries (base filter)
  const todayDeliveries = useMemo(() => {
    return deliveries.filter(delivery => {
      if (!delivery) return false;
      // Offline stops remain visible until the server acknowledges completion.
      if (deliverySyncStatus[delivery._id]) return isDeliveryForToday(delivery);
      if (completedDeliveries.has(delivery._id)) return false;
      const isTerminalStatus = delivery?.status && ['delivered', 'completed'].includes(delivery.status);
      return !isTerminalStatus && isDeliveryForToday(delivery);
    });
  }, [deliveries, completedDeliveries, isDeliveryForToday, deliverySyncStatus]);

  // Stage 2: Apply search filter (if active)
  const searchFilteredDeliveries = useMemo(() => {
    if (!normalizedSearch) return todayDeliveries;
    
    return todayDeliveries.filter(delivery => {
      const searchKey = (
        (delivery.customerName || '') +
        (delivery.address || '') +
        (delivery.customerId || '') +
        (delivery.phone || '')
      ).toLowerCase();
      return searchKey.includes(normalizedSearch);
    });
  }, [todayDeliveries, normalizedSearch]);

  // Stage 3: Apply alphabet filter (if active)
  const alphabetFilteredDeliveries = useMemo(() => {
    if (!filterState.selectedLetter) return searchFilteredDeliveries;
    
    return searchFilteredDeliveries.filter(delivery =>
      delivery.customerName?.toUpperCase().startsWith(filterState.selectedLetter)
    );
  }, [searchFilteredDeliveries, filterState.selectedLetter]);

  // Stage 4: Apply sorting (if active)
  const pendingDeliveries = useMemo(() => {
    if (!filterState.sortAlphabetical) return alphabetFilteredDeliveries;
    
    return [...alphabetFilteredDeliveries].sort((a, b) => 
      (a.customerName || '').localeCompare(b.customerName || '')
    );
  }, [alphabetFilteredDeliveries, filterState.sortAlphabetical]);

  // Start camera when photo step is active
  useEffect(() => {
    const wantsCamera =
      (!flowState.showReturnFlow && currentStep === 'photo') ||
      (flowState.showReturnFlow && currentStep === 'return_photo') ||
      (currentStep === 'bag_collection_no_bags_photo') ||
      (currentStep === 'collection_photo');

    if (wantsCamera) {
      if (cameraState.support.canUseCamera) {
        startCamera();
      } else if (!cameraState.capturedPhoto && cameraState.support.reason) {
        setFeedback((prev) => ({ ...prev, scanError: prev.scanError || cameraState.support.reason }));
      }
    } else {
      stopCamera();
    }

    return () => {
      stopCamera();
    };
  }, [currentStep, cameraState.facingMode, flowState.showReturnFlow, cameraState.support.canUseCamera, cameraState.support.reason]);

  const startCamera = async () => {
    if (!cameraState.support.canUseCamera) {
      setFeedback(prev => ({ ...prev, scanError: cameraState.support.reason || 'Camera access is not available on this device.' }));
      return;
    }

    try {
      stopCamera(); // Stop any existing stream

      const constraints = {
        video: { 
          facingMode: cameraState.facingMode,
          width: { ideal: 1280 },
          height: { ideal: 720 }
        }
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      console.log('📹 Camera stream obtained:', stream.getVideoTracks().length, 'video tracks');
      
      const [videoTrack] = stream.getVideoTracks();
      const capabilities = videoTrack?.getCapabilities?.() || {};
      const canUseTorch = Boolean(capabilities.torch);
      setCameraState(prev => ({ ...prev, flashSupported: canUseTorch }));
      if (!canUseTorch && cameraState.flashOn) {
        setCameraState(prev => ({ ...prev, flashOn: false }));
      }
      if (canUseTorch && cameraState.flashOn) {
        try {
          await videoTrack.applyConstraints({ advanced: [{ torch: true }] });
        } catch (torchError) {
          console.warn('Unable to keep flash enabled on start:', torchError);
          setCameraState(prev => ({ ...prev, flashOn: false }));
        }
      }
      
      if (videoRef.current) {
        console.log('📹 Attaching stream to video element');
        videoRef.current.srcObject = stream;
        // Ensure video plays after metadata is loaded
        videoRef.current.onloadedmetadata = () => {
          console.log('📹 Video metadata loaded, playing...');
          videoRef.current?.play().catch(err => console.warn('Video play error:', err));
        };
      } else {
        console.warn('⚠️ Video ref is null, cannot attach stream');
      }
    } catch (error) {
      console.error('Error starting camera:', error);
      if (error?.message?.toLowerCase().includes('secure context')) {
        setFeedback(prev => ({ ...prev, scanError: 'Camera access requires HTTPS or localhost. Please switch to a secure connection.' }));
      } else if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
        setFeedback(prev => ({ ...prev, scanError: 'Camera permission denied. Please grant access to continue.' }));
      } else {
        setFeedback(prev => ({ ...prev, scanError: 'Cannot access camera. Please check permissions or try another browser.' }));
      }
    }
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    setCameraState(prev => ({ ...prev, flashOn: false, flashSupported: false }));
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  };

  const switchCamera = () => {
    setCameraState(prev => ({ 
      ...prev, 
      flashOn: false, 
      flashSupported: false,
      facingMode: prev.facingMode === 'user' ? 'environment' : 'user'
    }));
  };

  const toggleFlash = async () => {
    if (!cameraState.flashSupported || !streamRef.current) {
      return;
    }
    const [videoTrack] = streamRef.current.getVideoTracks();
    if (!videoTrack) {
      return;
    }
    try {
      await videoTrack.applyConstraints({ advanced: [{ torch: !cameraState.flashOn }] });
      setCameraState(prev => ({ ...prev, flashOn: !prev.flashOn }));
    } catch (error) {
      console.error('Failed to toggle flash:', error);
      setCameraState(prev => ({ ...prev, flashSupported: false, flashOn: false }));
      setFeedback(prev => ({ ...prev, scanError: prev.scanError || 'Flash is not supported on this device.' }));
    }
  };

  const capturePhoto = () => {
    if (videoRef.current && canvasRef.current) {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const context = canvas.getContext('2d');

      const { width, height } = getScaledDimensions(video.videoWidth, video.videoHeight);
      canvas.width = width;
      canvas.height = height;

      context.drawImage(video, 0, 0, width, height);

      const imageData = canvas.toDataURL('image/jpeg', PHOTO_QUALITY);
      setCameraState(prev => ({ ...prev, capturedPhoto: imageData,
        photoCapturedAt: new Date().toISOString(), photoSource: 'camera' }));
      setFeedback(prev => ({ ...prev, scanSuccess: 'Photo captured successfully!' }));
      
      // Stop camera after capture
      stopCamera();
    }
  };

  const handlePhotoUpload = (event) => {
    const file = event.target?.files?.[0];
    if (!file) {
      return;
    }

    const imageUrl = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      const canvas = canvasRef.current || document.createElement('canvas');
      const { width, height } = getScaledDimensions(image.width, image.height);
      canvas.width = width;
      canvas.height = height;

      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, width, height);

      const compressedDataUrl = canvas.toDataURL('image/jpeg', PHOTO_QUALITY);
      setCameraState(prev => ({ ...prev, capturedPhoto: compressedDataUrl,
        photoCapturedAt: null, photoSource: 'upload' }));
      setFeedback({ scanError: '', scanSuccess: 'Photo uploaded successfully.', isUploading: false });
      stopCamera();
      setTimeout(() => setFeedback(prev => ({ ...prev, scanSuccess: '' })), 5000);
      URL.revokeObjectURL(imageUrl);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    };

    image.onerror = () => {
      setFeedback(prev => ({ ...prev, scanError: 'Could not read the selected photo.' }));
      URL.revokeObjectURL(imageUrl);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    };

    image.src = imageUrl;
  };

  // Calculate stats based on pending deliveries
  const stats = React.useMemo(() => {
    const totalCompletedToday = deliveries.filter(d => 
      d.status === 'delivered' && isDeliveryForToday(d)
    ).length;

    const lateDeliveries = deliveries.filter(d => 
      d.status === 'delivered' && d.lateMinutes > 0 && isDeliveryForToday(d)
    );
    const onTimeDeliveries = deliveries.filter(d => 
      d.status === 'delivered' && (d.lateMinutes === 0 || d.lateMinutes === undefined) && isDeliveryForToday(d)
    );
    
    const baseAccuracy = totalCompletedToday > 0 
      ? (onTimeDeliveries.length / totalCompletedToday) * 100
      : driverAccuracyRate;
    const accuracy = Number.isFinite(baseAccuracy)
      ? Math.max(0, Math.min(100, Math.round(baseAccuracy)))
      : 0;

    return {
      pending: pendingDeliveries.length,
      completed: totalCompletedToday,
      onTime: onTimeDeliveries.length,
      late: lateDeliveries.length,
      accuracy: accuracy
    };
  }, [pendingDeliveries, deliveries, isDeliveryForToday, driverAccuracyRate]);

  // Handle photo complete step - finalize delivery with or without returned bags
  useEffect(() => {
    if (currentStep === 'photo_complete' && currentDelivery && !feedback.isUploading) {
      handleFinalizeDelivery();
    }
  }, [currentStep, bagState.toReturn]);

  const handleRetrySync = async (deliveryId) => {
    try {
      console.log('🔄 Retrying sync for delivery:', deliveryId);
      const result = await retryDeliverySync(deliveryId);
      dispatch(fetchDriverDeliveries());
      setFeedback(prev => ({ ...prev, scanSuccess: result.failed ? '' : 'Sync retry finished',
        scanError: result.failed ? 'Some uploads still need attention. See their sync errors below.' : '' }));
    } catch (error) {
      console.error('Failed to retry sync:', error);
      setFeedback(prev => ({ ...prev, scanError: 'Retry failed: ' + error.message }));
    }
  };

  const handleStartDelivery = (delivery) => {
    dispatch(setCurrentDelivery(delivery));
    const isCollection = delivery?.type === 'Collection';
    const shouldStartBagCollection = delivery?.type === 'Task' && delivery?.taskType === 'Bag Collection';
    setCurrentStep(isCollection ? 'collection_action' : (shouldStartBagCollection ? 'bag_collection_qr' : 'delivery'));
    setBagState({ scannedBagId: '', scannedBags: [], returnedBags: [], collectionScans: [], toReturn: [], qrSkipped: false });
    setCameraState(prev => ({ ...prev, capturedPhoto: null }));
    setFeedback({ scanError: '', scanSuccess: '', isUploading: false });
    setFlowState(prev => ({ ...prev, showReturnFlow: false, isBagCollectionFlow: shouldStartBagCollection }));
    lastScannedValueRef.current = '';
  };

  const handleCompleteDeliveryFlow = (skipQr = false) => {
    setFeedback(prev => ({ ...prev, scanError: '' }));
    setFlowState(prev => ({ ...prev, showReturnFlow: false }));
    setBagState(prev => ({ ...prev, scannedBagId: '', scannedBags: [] }));
    if (!skipQr) {
      setCameraState(prev => ({ ...prev, capturedPhoto: null }));  // Only reset photo if NOT skipping QR
    }
    lastScannedValueRef.current = '';

    if (skipQr) {
      setBagState(prev => ({ ...prev, qrSkipped: true }));
      setCurrentStep('photo');
      setFeedback({ scanError: '', scanSuccess: 'Skipping QR scan. Please capture a delivery photo.', isUploading: false });
      setTimeout(() => setFeedback(prev => ({ ...prev, scanSuccess: '' })), 5000);
      // Let the useEffect handle camera start when currentStep changes to 'photo'
    } else {
      setBagState(prev => ({ ...prev, qrSkipped: false }));
      setFeedback(prev => ({ ...prev, scanSuccess: '' }));
      setCurrentStep('qr');
    }
  };

  const handleBagReturnFlow = () => {
    if (currentDelivery?.taskType === 'Bag Collection') {
      // For bag collection tasks, open QR scanner
      setCurrentStep('bag_collection_qr');
    } else {
      // For other tasks, open photo capture
      setFlowState(prev => ({...prev, showBagReturnFlow: true}));
      setCurrentStep('photo');
      startCamera();
    }
  };

  const handleCaptureBagReturnPhoto = async () => {
    if (!cameraSupport.canUseCamera || !videoRef.current || !canvasRef.current) {
      alert('Camera not available');
      return;
    }

    try {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const { width, height } = getScaledDimensions(video.videoWidth, video.videoHeight);
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      context.drawImage(video, 0, 0, width, height);
      const photoDataUrl = canvas.toDataURL('image/jpeg', PHOTO_QUALITY);
      setCameraState(prev => ({...prev, bagReturnPhoto: photoDataUrl}));
      stopCamera();
    } catch (error) {
      console.error('Error capturing bag return photo:', error);
      alert('Failed to capture photo');
    }
  };

  const handleCompleteBagReturn = async () => {
    if (!bagReturnPhoto) {
      alert('Please capture a photo of the returned bag');
      return;
    }

    setFeedback(prev => ({ ...prev, isUploading: true }));
    try {
      let photoUrl = null;
      if (bagReturnPhoto) {
        photoUrl = await uploadPhoto(bagReturnPhoto);
      }

      // Add bag to returned bags list
      const newBag = {
        photoUrl,
        timestamp: new Date().toISOString(),
        bagNumber: returnedBags.length + 1
      };
      
      setReturnedBags(prev => [...prev, newBag]);
      alert(`Bag ${returnedBags.length + 1} returned successfully!`);
      
      // Reset photo capture state
      setFlowState(prev => ({...prev, showBagReturnFlow: false}));
      setCameraState(prev => ({...prev, bagReturnPhoto: null}));
      setCurrentStep('delivery');
    } catch (error) {
      console.error('Error completing bag return:', error);
      alert(error.message || 'Failed to return bag');
    } finally {
      setFeedback(prev => ({ ...prev, isUploading: false }));
    }
  };

  const handleCompleteAllBagReturns = async () => {
    if (returnedBags.length === 0) {
      alert('Please return at least one bag before completing the task');
      return;
    }

    setFeedback(prev => ({ ...prev, isUploading: true }));
    try {
      // Submit all returned bags to the server
      await dispatch(
        returnBag({
          deliveryId: currentDelivery._id,
          bags: returnedBags,
          totalBags: returnedBags.length,
          timestamp: new Date().toISOString()
        })
      ).unwrap();

      alert(`Task completed! ${returnedBags.length} bag(s) returned successfully.`);
      setCompletedDeliveries(prev => new Set(prev).add(currentDelivery._id));
      
      // Delay fetch to ensure completed state is applied first
      setTimeout(() => {
        dispatch(fetchDriverDeliveries());
      }, 500);
      
      dispatch(clearCurrentDelivery());
      setReturnedBags([]);
      setCurrentStep('delivery');
    } catch (error) {
      console.error('Error completing bag returns:', error);
      alert(error.message || 'Failed to complete task');
    } finally {
      setFeedback(prev => ({ ...prev, isUploading: false }));
    }
  };

  const handleCancelBagReturn = () => {
    setFlowState(prev => ({...prev, showBagReturnFlow: false}));
    setCameraState(prev => ({...prev, bagReturnPhoto: null}));
    setCurrentStep('delivery');
    stopCamera();
  };

  const handleRemoveBag = (bagNumber) => {
    setReturnedBags(prev => prev.filter(bag => bag.bagNumber !== bagNumber));
  };

  const handleCompletePurchaseTask = async () => {
    if (!currentDelivery) return;

    setFeedback(prev => ({ ...prev, isUploading: true }));
    try {
      await dispatch(
        updateDeliveryStatus({
          deliveryId: currentDelivery._id,
          status: 'completed'
        })
      ).unwrap();

      alert('Purchase task completed successfully!');
      setCompletedDeliveries(prev => new Set(prev).add(currentDelivery._id));
      
      // Delay fetch to ensure completed state is applied first
      setTimeout(() => {
        dispatch(fetchDriverDeliveries());
      }, 500);
      
      dispatch(clearCurrentDelivery());
      setCurrentStep('delivery');
    } catch (error) {
      console.error('Error completing purchase task:', error);
      alert(error.message || 'Failed to complete task');
    } finally {
      setFeedback(prev => ({ ...prev, isUploading: false }));
    }
  };

  const handleCompleteBagCollectionTask = async () => {
    if (!currentDelivery) return;
    if (bagState.collectionScans.length === 0) {
      setFeedback(prev => ({ ...prev, scanError: 'Scan at least one bag before finishing the collection.' }));
      return;
    }

    setFeedback(prev => ({ ...prev, isUploading: true }));
    try {
      const proofData = {
        timestamp: new Date().toISOString(),
        type: 'bag_collection',
        scannedBags: bagState.collectionScans,
        deliveryMethod: 'bag_collection_qr',
        notes: `Collected ${bagState.collectionScans.length} bag(s)`
      };

      if (!navigator.onLine) {
        await queueDeliveryUpdate({
          deliveryId: currentDelivery._id,
          status: 'completed',
          proof: proofData,
          bagIds: bagState.collectionScans,
          customerId: currentDelivery.customerId,
          customerName: currentDelivery.customerName
        });

        const count = await getPendingCount();
        setOfflineState(prev => ({ ...prev, queue: Array(count.total).fill(null) }));
        setFeedback({ scanError: '', scanSuccess: 'Saved offline. Will sync once online.', isUploading: false });
        setCompletedDeliveries(prev => new Set(prev).add(currentDelivery._id));
        dispatch(clearCurrentDelivery());
        setFlowState(prev => ({ ...prev, isBagCollectionFlow: false }));
        setBagState(prev => ({ ...prev, collectionScans: [] }));
        setCurrentStep('delivery');
        return;
      }

      // The status endpoint commits typed collection movements; failed bags remain retryable.
      await dispatch(
        updateDeliveryStatus({
          deliveryId: currentDelivery._id,
          status: 'completed',
          proof: proofData
        })
      ).unwrap();

      setFeedback({ scanError: '', scanSuccess: 'Bag collection task completed successfully!', isUploading: false });
      setCompletedDeliveries(prev => new Set(prev).add(currentDelivery._id));
      
      // Delay fetch to ensure completed state is applied first
      setTimeout(() => {
        dispatch(fetchDriverDeliveries());
      }, 500);
      
      dispatch(clearCurrentDelivery());
      setFlowState(prev => ({ ...prev, isBagCollectionFlow: false }));
      setBagState(prev => ({ ...prev, collectionScans: [] }));
      setCurrentStep('delivery');
    } catch (error) {
      console.error('Error completing bag collection task:', error);
      setFeedback(prev => ({ ...prev, scanError: error.message || 'Failed to complete bag collection task. Please try again.' }));
    } finally {
      setFeedback(prev => ({ ...prev, isUploading: false }));
    }
  };

  const handleCancelBagCollectionFlow = () => {
    setFlowState(prev => ({ ...prev, isBagCollectionFlow: false }));
    setBagState(prev => ({...prev, collectionScans: []}));
    handleBackToDelivery();
  };

  const captureNoBagsPhoto = () => {
    console.log('📸 Attempting to capture photo...');
    console.log('Video ref:', videoRef.current);
    console.log('Canvas ref:', canvasRef.current);
    
    if (!videoRef.current) {
      console.error('❌ Video ref is null');
      setFeedback(prev => ({ ...prev, scanError: 'Video element not ready' }));
      return;
    }
    
    if (!canvasRef.current) {
      console.error('❌ Canvas ref is null');
      setFeedback(prev => ({ ...prev, scanError: 'Canvas element not ready' }));
      return;
    }
    
    const video = videoRef.current;
    const canvas = canvasRef.current;
    
    console.log('Video dimensions:', video.videoWidth, 'x', video.videoHeight);
    
    if (!video.videoWidth || !video.videoHeight) {
      console.error('❌ Video dimensions not loaded');
      setFeedback(prev => ({ ...prev, scanError: 'Camera not ready, please wait a moment and try again' }));
      return;
    }

    try {
      const context = canvas.getContext('2d');
      const { width, height } = getScaledDimensions(video.videoWidth, video.videoHeight);
      
      console.log('Scaled dimensions:', width, 'x', height);
      
      canvas.width = width;
      canvas.height = height;

      context.drawImage(video, 0, 0, width, height);

      const imageData = canvas.toDataURL('image/jpeg', PHOTO_QUALITY);
      console.log('✅ Photo captured, data URL length:', imageData.length);
      
      setCameraState(prev => ({ ...prev, noBagsPhoto: imageData }));
      setFeedback(prev => ({ ...prev, scanSuccess: 'Photo captured successfully!' }));
      
      // Stop camera after capture
      stopCamera();
    } catch (error) {
      console.error('❌ Error capturing photo:', error);
      setFeedback(prev => ({ ...prev, scanError: 'Failed to capture photo: ' + error.message }));
    }
  };

  const handleCompleteNoBagsTask = async () => {
    if (!cameraState.noBagsPhoto) {
      setFeedback(prev => ({ ...prev, scanError: 'Please capture a photo as proof.' }));
      return;
    }

    if (!currentDelivery) {
      setFeedback(prev => ({ ...prev, scanError: 'No active delivery found.' }));
      return;
    }

    setFeedback(prev => ({ ...prev, isUploading: true }));
    
    try {
      // Upload the photo
      const photoUrl = await uploadPhoto(cameraState.noBagsPhoto);

      // Check if offline
      if (!offlineState.isOnline) {
        await saveOfflineData({
          type: 'delivery',
          action: 'complete',
          deliveryId: currentDelivery._id,
          status: 'completed',
          photoUrl,
          proof: {
            bags: [],
            notes: 'No bags available - photo proof provided',
            photoUrl,
            timestamp: new Date().toISOString()
          },
          completedAt: new Date().toISOString(),
          customerName: currentDelivery.customerName
        });

        const count = await getPendingCount();
        setOfflineState(prev => ({ ...prev, queue: Array(count.total).fill(null) }));
        setFeedback({ scanError: '', scanSuccess: 'Saved offline. Will sync once online.', isUploading: false });
        setCompletedDeliveries(prev => new Set(prev).add(currentDelivery._id));
        dispatch(clearCurrentDelivery());
        setFlowState(prev => ({ ...prev, isBagCollectionFlow: false }));
        setCameraState(prev => ({ ...prev, noBagsPhoto: null }));
        setCurrentStep('delivery');
        return;
      }

      // Complete the task online
      await dispatch(
        updateDeliveryStatus({
          deliveryId: currentDelivery._id,
          status: 'completed',
          photoUrl,
          proof: {
            bags: [],
            notes: 'No bags available - photo proof provided',
            photoUrl,
            timestamp: new Date().toISOString()
          }
        })
      ).unwrap();

      setFeedback({ scanError: '', scanSuccess: 'Task completed successfully!', isUploading: false });
      setCompletedDeliveries(prev => new Set(prev).add(currentDelivery._id));
      dispatch(clearCurrentDelivery());
      setFlowState(prev => ({ ...prev, isBagCollectionFlow: false }));
      setCameraState(prev => ({ ...prev, noBagsPhoto: null }));
      setCurrentStep('delivery');
    } catch (error) {
      console.error('Error completing no bags task:', error);
      setFeedback(prev => ({ ...prev, scanError: error.message || 'Failed to complete task. Please try again.' }));
    } finally {
      setFeedback(prev => ({ ...prev, isUploading: false }));
    }
  };

  const handleCompleteCollection = async () => {
    if (!cameraState.noBagsPhoto) {
      setFeedback(prev => ({ ...prev, scanError: 'Please capture a photo as proof.' }));
      return;
    }

    if (!currentDelivery?._id) {
      setFeedback(prev => ({ ...prev, scanError: 'No active collection found.' }));
      return;
    }

    setFeedback(prev => ({ ...prev, isUploading: true }));

    try {
      const photoUrl = await uploadPhoto(cameraState.noBagsPhoto);

      await api.post(`/deliveries/${currentDelivery._id}/collect`, {
        photoUrl,
        notes: 'Collected with photo proof'
      });

      setFeedback({ scanError: '', scanSuccess: 'Collection marked as collected.', isUploading: false });
      setCompletedDeliveries(prev => new Set(prev).add(currentDelivery._id));
      setCameraState(prev => ({ ...prev, noBagsPhoto: null }));
      dispatch(clearCurrentDelivery());
      setCurrentStep('delivery');
      dispatch(fetchDriverDeliveries());
    } catch (error) {
      console.error('Error completing collection:', error);
      setFeedback(prev => ({ ...prev, scanError: error.response?.data?.message || error.message || 'Failed to complete collection. Please try again.' }));
    } finally {
      setFeedback(prev => ({ ...prev, isUploading: false }));
    }
  };

  const handleCollectionNoBags = async () => {
    if (!currentDelivery?._id) {
      setFeedback(prev => ({ ...prev, scanError: 'No active collection found.' }));
      return;
    }

    setFeedback(prev => ({ ...prev, isUploading: true }));

    try {
      await api.post(`/deliveries/${currentDelivery._id}/collect`, {
        noBagsAvailable: true,
        notes: 'No bags available at pickup location'
      });

      setFeedback({ scanError: '', scanSuccess: 'Collection updated: no bags available.', isUploading: false });
      setCompletedDeliveries(prev => new Set(prev).add(currentDelivery._id));
      setCameraState(prev => ({ ...prev, noBagsPhoto: null }));
      dispatch(clearCurrentDelivery());
      setCurrentStep('delivery');
      dispatch(fetchDriverDeliveries());
    } catch (error) {
      console.error('Error marking no bags for collection:', error);
      setFeedback(prev => ({ ...prev, scanError: error.response?.data?.message || 'Failed to update collection. Please try again.' }));
    } finally {
      setFeedback(prev => ({ ...prev, isUploading: false }));
    }
  };

  const handleCancelReturnBagsFlow = () => {
    setFlowState(prev => ({...prev, isReturningBags: false}));
    setBagState(prev => ({...prev, toReturn: []}));
    setFlowState(prev => ({...prev, showReturnBagsQuestion: false}));
    setCurrentStep('delivery');
    stopCamera();
  };

  const handlePhotoComplete = () => {
    // After photo is captured, ask about returning bags
    setFlowState(prev => ({...prev, showReturnBagsQuestion: true}));
  };

  const handleReturnBagsYes = () => {
    setFlowState(prev => ({...prev, showReturnBagsQuestion: false, isReturningBags: true}));
    setBagState(prev => ({...prev, toReturn: []}));
    setCurrentStep('return_bags_scan');
    startCamera();
  };

  const handleReturnBagsNo = () => {
    setFlowState(prev => ({...prev, showReturnBagsQuestion: false, isReturningBags: false}));
    setBagState(prev => ({...prev, toReturn: []}));
    setCurrentStep('photo_complete');
  };

  const handleBagScanned = (bagId) => {
    if (!bagState.toReturn.includes(bagId)) {
      setBagState(prev => {
        const updated = { ...prev, toReturn: [...prev.toReturn, bagId] };
        return updated;
      });
      setFeedback({ scanError: '', scanSuccess: `Bag ${bagId} added for return!`, isUploading: false });
      setTimeout(() => setFeedback(prev => ({ ...prev, scanSuccess: '' })), 3000);
    } else {
      setFeedback({ scanError: `Bag ${bagId} already scanned!`, scanSuccess: '', isUploading: false });
      setTimeout(() => setFeedback(prev => ({ ...prev, scanError: '' })), 3000);
    }
  };

  const handleRemoveReturnBag = (bagId) => {
    setBagState(prev => ({ ...prev, toReturn: prev.toReturn.filter(id => id !== bagId) }));
  };

  const handleCompleteBagsReturn = async () => {
    // Mark bags as returned and complete delivery
    if (bagState.toReturn.length === 0) {
      setFeedback(prev => ({ ...prev, scanError: 'Please scan at least one bag to return' }));
      return;
    }
    
    // Check if this is a standalone return (no active delivery)
    if (!currentDelivery) {
      setFeedback(prev => ({ ...prev, isUploading: true }));
      try {
        const eventId = 'collection-' + Date.now() + '-' + Math.random().toString(36).slice(2);
        await queueDeliveryUpdate({kind:'bag_collection',bagIds:bagState.toReturn,eventId});
        if(navigator.onLine) await syncOfflineData();
        const pending = await getPendingCount();
        setOfflineState(prev=>({...prev,queue:Array(pending.total).fill(null)}));
        setFeedback({scanError:'',scanSuccess:pending.total?'Collection saved. Check pending sync before warehouse handover.':'Bags recorded with you. Warehouse receipt is still required.',isUploading:false});
        setTimeout(() => {
          setFlowState(prev => ({ ...prev, isReturningBags: false }));
          setBagState(prev => ({ ...prev, toReturn: [] }));
          setCurrentStep('delivery');
          setFeedback({ scanError: '', scanSuccess: '', isUploading: false });
          stopCamera();
        }, 2000);
      } catch (error) {
        console.error('Error returning bags:', error);
        setFeedback(prev => ({ ...prev, scanError: error.message || 'Failed to return bags' }));
      } finally {
        setFeedback(prev => ({ ...prev, isUploading: false }));
      }
      return;
    }
    
    // If part of a delivery flow, proceed to complete the delivery
    setCurrentStep('photo_complete');
  };

  const handleQRScan = (detectedCodes) => {
    setShowScannerRetry(false);
    try {
      const codes = Array.isArray(detectedCodes)
        ? detectedCodes
        : detectedCodes
          ? [detectedCodes]
          : [];

      const matchingCode = codes.find((code) => {
        const rawValue = code?.rawValue;
        return typeof rawValue === 'string' && rawValue.trim().length > 0;
      });

      const value = matchingCode?.rawValue?.trim() || '';

      if (!value) {
        console.warn('QR scan returned unexpected payload', { detectedCodes });
        return;
      }

      console.log('[QR Scan] Detected value:', value, 'Flow:', { 
        isReturningBags: flowState.isReturningBags, 
        currentStep, 
        isBagCollection: flowState.isBagCollectionFlow 
      });

      // Handle return bags scanning with stabilization and validation
      if (flowState.isReturningBags && currentStep === 'return_bags_scan') {
        const now = Date.now();

        // Stabilize scan: require same value multiple times within a short window
        if (scanStateRef.current.value === value && (now - scanStateRef.current.timestamp) <= SCAN_STABILIZE_WINDOW) {
          scanStateRef.current = {
            value,
            count: scanStateRef.current.count + 1,
            timestamp: now
          };
          console.log('[QR Scan][Return] Stabilizing...', { value, count: scanStateRef.current.count, required: SCAN_STABILIZE_COUNT });
        } else {
          scanStateRef.current = { value, count: 1, timestamp: now };
          console.log('[QR Scan][Return] New scan detected, resetting stabilization:', value);
        }

        if (scanStateRef.current.count < SCAN_STABILIZE_COUNT) {
          console.log('[QR Scan][Return] Waiting for stabilization:', scanStateRef.current.count, '/', SCAN_STABILIZE_COUNT);
          return; // wait for stabilization
        }

        // Cooldown to avoid rapid duplicate captures from the same frame burst
        if (now - lastScanTimestampRef.current < SCAN_COOLDOWN_MS) {
          console.log('[QR Scan][Return] Cooldown active, skipping');
          return;
        }
        lastScanTimestampRef.current = now;

        // Basic validation similar to normal flow
        if (value.length < 3) {
          console.warn('[QR Scan][Return] Code too short, likely noise:', value);
          return;
        }
        if (/^\d+$/.test(value) && value.length < 8) {
          console.warn('[QR Scan][Return] Short numeric-only value ignored:', value);
          return;
        }
        if (!/[A-Za-z]/.test(value)) {
          console.warn('[QR Scan][Return] Value appears to be noise (no letters):', value);
          return;
        }

        // Prevent duplicates
        if (lastScannedValueRef.current === value) {
          console.log('[QR Scan][Return] Duplicate value ignored (lastScanned):', value);
          return;
        }
        if (bagState.toReturn?.includes(value)) {
          console.log('[QR Scan][Return] Bag already in return list:', value);
          setFeedback(prev => ({ ...prev, scanError: `Bag ${value} already added!` }));
          setTimeout(() => setFeedback(prev => ({ ...prev, scanError: '' })), 2000);
          return;
        }

        lastScannedValueRef.current = value;
        handleBagScanned(value);

        // Clear the ref after 2 seconds to allow scanning a different bag
        setTimeout(() => {
          lastScannedValueRef.current = '';
        }, 2000);
        return;
      }

      // Stabilize scan: require the same value multiple times within a short window
      const now = Date.now();
      if (scanStateRef.current.value === value && (now - scanStateRef.current.timestamp) <= SCAN_STABILIZE_WINDOW) {
        scanStateRef.current = {
          value,
          count: scanStateRef.current.count + 1,
          timestamp: now
        };
        console.log('[QR Scan] Stabilizing...', { value, count: scanStateRef.current.count, required: SCAN_STABILIZE_COUNT });
      } else {
        scanStateRef.current = { value, count: 1, timestamp: now };
        console.log('[QR Scan] New scan detected, resetting stabilization:', value);
      }

      if (scanStateRef.current.count < SCAN_STABILIZE_COUNT) {
        console.log('[QR Scan] Waiting for stabilization:', scanStateRef.current.count, '/', SCAN_STABILIZE_COUNT);
        return; // wait for stabilization
      }

      console.log('[QR Scan] Stabilized! Processing scan:', value);

      // Cooldown to avoid rapid duplicate captures from the same frame burst
      if (now - lastScanTimestampRef.current < SCAN_COOLDOWN_MS) {
        console.log('[QR Scan] Cooldown active, skipping');
        return;
      }
      lastScanTimestampRef.current = now;

      // Validate QR code format - must be at least 3 characters
      if (value.length < 3) {
        console.warn('QR code too short, likely noise:', value);
        return;
      }

      // Reject values that are purely numeric and very short (likely stray captures)
      if (/^\d+$/.test(value) && value.length < 8) {
        return;
      }

      // Validate that QR contains at least one alphanumeric character and is not just random noise
      // Bag IDs typically start with letters (like BAG, DELIVERY, etc.)
      if (!/[A-Za-z]/.test(value)) {
        console.warn('QR code appears to be random noise (no letters):', value);
        return;
      }

      if (lastScannedValueRef.current === value) {
        console.log('[QR Scan] Duplicate value, already processed:', value);
        return;
      }

      lastScannedValueRef.current = value;

      console.log('[QR Scan] Processing delivery scan for:', value);

      // Normal delivery scan path
      setBagState(prev => ({...prev, qrSkipped: false}));
      
      if (flowState.isBagCollectionFlow) {
        console.log('[QR Scan] Bag collection flow - adding to collectionScans');
        setBagState(prev => ({
          ...prev,
          collectionScans: prev.collectionScans.includes(value)
            ? prev.collectionScans
            : [...prev.collectionScans, value]
        }));
        setFeedback(prev => ({...prev, scanSuccess: `Bag ${value} recorded for collection.`, scanError: ''}));
        
        // Clear the ref after 1 second to allow scanning a different bag
        setTimeout(() => {
          lastScannedValueRef.current = '';
        }, 1000);
        return;
      }

      // Handle multiple bag scanning
      if (bagState.scannedBags.includes(value)) {
        console.log('[QR Scan] Duplicate bag for this delivery');
        setFeedback(prev => ({...prev, scanError: `Bag ${value} has already been scanned for this delivery`}));
        return;
      }

      // Add bag to scannedBags array
      const updatedBags = [...bagState.scannedBags, value];
      console.log('[QR Scan] Adding bag to delivery:', value, 'Total bags:', updatedBags.length);
      setBagState(prev => ({...prev, scannedBagId: value, scannedBags: updatedBags}));
      
      setFeedback(prev => ({...prev, scanSuccess: `Bag ${value} scanned! (${updatedBags.length} total)`, scanError: ''}));
      
      // Clear the ref after 1 second to allow scanning a different bag
      setTimeout(() => {
        lastScannedValueRef.current = '';
      }, 1000);
    } catch (scanError) {
      console.error('Failed to process QR scan result:', scanError);
      setFeedback(prev => ({...prev, scanError: 'Invalid QR code data. Please try again.'}));
    }
  };

  const handleQRScanError = (error) => {
    console.error('QR Scan error:', error);
    
    // Provide helpful error messages based on error type
    let errorMessage = 'Failed to scan QR code. Please try again.';
    
    if (error?.name === 'NotAllowedError') {
      errorMessage = 'Camera access denied. Please allow camera access in settings.';
    } else if (error?.name === 'NotFoundError') {
      errorMessage = 'No camera found. Please check your device settings.';
    } else if (error?.name === 'NotReadableError') {
      errorMessage = 'Camera is busy or in use. Please try again.';
    } else if (error?.message?.includes('NotFound')) {
      errorMessage = 'Camera not available. Try manual entry instead.';
    }
    
    setFeedback(prev => ({ ...prev, scanError: errorMessage }));

    if (
      ['NotAllowedError', 'NotReadableError', 'NotFoundError', 'SecurityError'].includes(error?.name) ||
      String(error?.message || '').toLowerCase().includes('permission')
    ) {
      setShowScannerRetry(true);
    }
    
    // Auto-clear error after 4 seconds to reduce user frustration
    setTimeout(() => {
      setFeedback(prev => ({ ...prev, scanError: '' }));
    }, 4000);
  };

  const retryScanner = () => {
    setShowScannerRetry(false);
    setScannerKey((prev) => prev + 1);
    setFeedback((prev) => ({ ...prev, scanError: '' }));
  };

  const handleManualBagEntry = () => {
    const bagId = prompt('Enter Bag ID manually:');
    if (bagId && bagId.trim()) {
      const enteredBagId = bagId.trim();
      
      // Validate bag ID format - must be at least 3 characters with at least one letter
      if (enteredBagId.length < 3) {
        setFeedback(prev => ({ ...prev, scanError: 'Bag ID must be at least 3 characters long' }));
        setTimeout(() => setFeedback(prev => ({ ...prev, scanError: '' })), 3000);
        return;
      }
      
      if (!/[A-Za-z]/.test(enteredBagId)) {
        setFeedback(prev => ({ ...prev, scanError: 'Bag ID must contain at least one letter' }));
        setTimeout(() => setFeedback(prev => ({ ...prev, scanError: '' })), 3000);
        return;
      }
      
      // Handle return bags flow
      if (flowState.isReturningBags && currentStep === 'return_bags_scan') {
        if (bagState.toReturn.includes(enteredBagId)) {
          setFeedback(prev => ({ ...prev, scanError: `Bag ${enteredBagId} already added!` }));
          setTimeout(() => setFeedback(prev => ({ ...prev, scanError: '' })), 3000);
        } else {
          handleBagScanned(enteredBagId);
        }
        return;
      }
      
      setBagState(prev => ({ ...prev, qrSkipped: false }));
      
      // Check for duplicate bags
      if (bagState.scannedBags.includes(enteredBagId)) {
        setFeedback(prev => ({ ...prev, scanError: `Bag ${enteredBagId} has already been scanned for this delivery` }));
        return;
      }
      
      // Add bag to scannedBags array
      setBagState(prev => ({
        ...prev,
        scannedBags: [...prev.scannedBags, enteredBagId],
        scannedBagId: enteredBagId
      }));
      
      if (flowState.isBagCollectionFlow) {
        setBagState(prev => ({
          ...prev,
          collectionScans: prev.collectionScans.includes(enteredBagId) ? prev.collectionScans : [...prev.collectionScans, enteredBagId]
        }));
        setFeedback({ scanError: '', scanSuccess: `Bag ${enteredBagId} recorded for collection.`, isUploading: false });
        lastScannedValueRef.current = enteredBagId;
        return;
      }

      setFeedback({ scanError: '', scanSuccess: `Bag ${enteredBagId} entered successfully! (${bagState.scannedBags.length + 1} total)`, isUploading: false });
      lastScannedValueRef.current = enteredBagId;
      
      // Auto-proceed to next step
      setTimeout(() => {
        if (flowState.showReturnFlow) {
          // Skip reason and photo steps, go directly to completion
          processReturnBag(enteredBagId);
        } else {
          setCurrentStep('photo');
        }
      }, 1000);
    }
  };

  const handleFinalizeDelivery = async () => {
    try {
      if (currentDelivery && currentDelivery._id) {
        if (!bagState.qrSkipped && bagState.scannedBags.length === 0) {
          setFeedback(prev => ({ ...prev, scanError: 'At least one bag ID is required to complete delivery' }));
          return;
        }

        if (!cameraState.capturedPhoto) {
          setFeedback(prev => ({ ...prev, scanError: 'Delivery photo is required to complete delivery' }));
          return;
        }

        setFeedback(prev => ({ ...prev, isUploading: true }));
        
        const bagIdsToUse = bagState.qrSkipped ? [] : bagState.scannedBags;

        const proofData = {
          timestamp: new Date().toISOString(),
          photoCapturedAt: cameraState.photoCapturedAt || undefined,
          photoSource: cameraState.photoSource || 'unknown',
          type: bagState.qrSkipped ? 'photo_only' : 'qr_and_photo',
          verified: !bagState.qrSkipped,
          bagIds: bagIdsToUse,
          images: [], // Will be populated with photo URL
          deliveryMethod: bagState.qrSkipped ? 'photo_only' : 'qr_verified',
          photoUrl: '', // Will be populated with photo URL
          qrSkipped: bagState.qrSkipped,
          returnedBags: bagState.toReturn.length > 0 ? bagState.toReturn : undefined
        };

        if (bagState.qrSkipped) {
          proofData.notes = 'Driver reported no QR code present for this delivery';
        }
        
        if (bagState.toReturn.length > 0) {
          proofData.notes = (proofData.notes || '') + ` | ${bagState.toReturn.length} bag(s) returned: ${bagState.toReturn.join(', ')}`;
        }

        // Check if online - handle differently for offline mode
        const isCurrentlyOnline = navigator.onLine;
        
        if (!isCurrentlyOnline) {
          setFeedback(prev => ({ ...prev, scanSuccess: 'Saving offline...' }));
          
          try {
            // Store photo in IndexedDB for each bag
            if (bagIdsToUse && bagIdsToUse.length > 0) {
              for (const bagId of bagIdsToUse) {
                await storePhotoOffline(currentDelivery._id, cameraState.capturedPhoto, bagId);
              }
            } else {
              // Store without specific bag ID
              await storePhotoOffline(currentDelivery._id, cameraState.capturedPhoto, null);
            }
            
            // Queue delivery update (this includes returnedBags in proofData)
            await queueDeliveryUpdate({
              deliveryId: currentDelivery._id,
              status: 'delivered',
              proof: proofData,
              bagIds: bagIdsToUse,
              customerId: currentDelivery.customerId,
              customerName: currentDelivery.customerName,
              bagsToReturn: bagState.toReturn
            });
            
            // Update offline queue count
            const count = await getPendingCount();
            setOfflineState(prev => ({ ...prev, queue: Array(count.total).fill(null) }));
            
            setFeedback(prev => ({ ...prev, scanSuccess: '✅ Delivery saved offline! Will sync when online.' }));
            
            // Add to completed deliveries locally
            setCompletedDeliveries(prev => new Set(prev).add(currentDelivery._id));
            
            // Reset after delay
            setTimeout(() => {
              setFeedback(prev => ({ ...prev, isUploading: false }));
              setCurrentStep('delivery');
              setBagState(prev => ({...prev, scannedBagId: '', scannedBags: [], qrSkipped: false}));
              setCameraState(prev => ({...prev, capturedPhoto: null}));
              setFeedback(prev => ({...prev, scanError: ''}));
              setBagState(prev => ({...prev, toReturn: []}));
              setFlowState(prev => ({...prev, isReturningBags: false, showReturnBagsQuestion: false}));
              dispatch(clearCurrentDelivery());
              lastScannedValueRef.current = '';
            }, 2000);
            
            setTimeout(() => setFeedback(prev => ({...prev, scanSuccess: ''})), 5000);
            return;
            
          } catch (offlineError) {
            console.error('❌ Failed to save offline:', offlineError);
            setFeedback(prev => ({...prev, scanError: `Failed to save offline: ${offlineError.message}. Please try again.`}));
            setFeedback(prev => ({...prev, isUploading: false}));
            return;
          }
        }
        
        let photoUrl;
        try {
          photoUrl = await uploadPhoto(cameraState.capturedPhoto);
          setFeedback(prev => ({...prev, scanSuccess: 'Photo uploaded successfully!'}));
          
          proofData.images = [photoUrl];
          proofData.photoUrl = photoUrl;
        } catch (uploadError) {
          console.error('Photo upload failed:', uploadError);
          setFeedback(prev => ({...prev, scanError: uploadError.message || 'Failed to upload photo. Please check your connection and try again.'}));
          setFeedback(prev => ({...prev, isUploading: false}));
          return;
        }

        setFeedback(prev => ({...prev, scanSuccess: 'Completing delivery...'}));
        
        // One server request handles all outgoing and collected bag movements.
        await dispatch(updateDeliveryStatus({
          deliveryId: currentDelivery._id,
          status: 'delivered',
          proof: proofData,
          bagIds: bagIdsToUse
        })).unwrap();
        
        setFeedback(prev => ({...prev, scanSuccess: 'Delivery completed successfully!'}));
        
        // Add to completed deliveries and fade out
        setCompletedDeliveries(prev => new Set(prev).add(currentDelivery._id));
        
        // Refresh deliveries list after a delay to ensure completed state is applied first
        setTimeout(() => {
          dispatch(fetchDriverDeliveries());
        }, 500);
        
        // Reset everything after a delay to show success message
        setTimeout(() => {
          setFeedback({ scanError: '', scanSuccess: '', isUploading: false });
          setCurrentStep('delivery');
          setBagState({ scannedBagId: '', scannedBags: [], returnedBags: [], collectionScans: [], toReturn: [], qrSkipped: false });
          setCameraState(prev => ({ ...prev, capturedPhoto: null }));
          setFlowState(prev => ({ ...prev, showReturnBagsQuestion: false, isReturningBags: false }));
          dispatch(clearCurrentDelivery());
          lastScannedValueRef.current = '';
        }, 1500);
        
        setTimeout(() => setFeedback(prev => ({ ...prev, scanSuccess: '' })), 5000);
      }
    } catch (error) {
      console.error('Failed to complete delivery:', error);
      setFeedback(prev => ({ ...prev, scanError: error.message || 'Failed to complete delivery. Please try again.' }));
      setFeedback(prev => ({ ...prev, isUploading: false }));
    }
  };

  const processReturnBag = useCallback(async (bagIdValue) => {
    const normalizedBagId =
      typeof bagIdValue === 'string' && bagIdValue.trim()
        ? bagIdValue.trim()
        : '';

    if (!normalizedBagId) {
      setFeedback(prev => ({ ...prev, scanError: 'Bag ID is required to return bag' }));
      return;
    }

    setBagState(prev => ({ ...prev, scannedBagId: normalizedBagId }));
    setFeedback(prev => ({ ...prev, scanSuccess: 'Processing bag return...' }));

    const returnData = {
      bagId: normalizedBagId,
      reason: 'Bag returned by driver',
      notes: 'Returned via mobile app',
      timestamp: new Date().toISOString(),
      driverId: user?.id,
      driverName: `${user?.profile?.firstName} ${user?.profile?.lastName}`
    };

    try {
      await dispatch(returnBag(returnData)).unwrap();

      // Reset return flow
      setFlowState(prev => ({ ...prev, showReturnFlow: false }));
      setCurrentStep('delivery');
      setBagState(prev => ({ ...prev, scannedBagId: '', scannedBags: [], qrSkipped: false }));
      setFeedback(prev => ({ ...prev, scanError: '', scanSuccess: 'Bag returned successfully!' }));
      lastScannedValueRef.current = '';

      setTimeout(() => setFeedback(prev => ({ ...prev, scanSuccess: '' })), 5000);
    } catch (error) {
      console.error('Failed to return bag:', error);
      setFeedback(prev => ({ ...prev, scanError: error.message || 'Failed to return bag. Please try again.' }));
    }
  }, [dispatch, user]);

  const handleReturnBag = () => {
  };
  const handleStartReturnFlow = () => {
    setFlowState(prev => ({ ...prev, showReturnFlow: true }));
    setCurrentStep('return_qr');
    setBagState(prev => ({ ...prev, scannedBagId: '', qrSkipped: false }));
    setFeedback({ scanError: '', scanSuccess: '', isUploading: false });
    setShowMenu(false);
  };

  const handleBackToDelivery = () => {
    if (flowState.showReturnFlow) {
      setFlowState(prev => ({ ...prev, showReturnFlow: false }));
    }
    setCurrentStep('delivery');
    setFeedback({ scanError: '', scanSuccess: '', isUploading: false });
    setBagState(prev => ({ ...prev, scannedBagId: '', scannedBags: [], qrSkipped: false }));
    setCameraState(prev => ({ ...prev, capturedPhoto: null }));
    stopCamera();
    lastScannedValueRef.current = '';
  };
  const handlePhotoStepBack = () => {
    if (bagState.qrSkipped) {
      handleBackToDelivery();
      return;
    }

    setCurrentStep('qr');
    setFeedback({ scanError: '', scanSuccess: '', isUploading: false });
    setBagState(prev => ({ ...prev, scannedBagId: '', scannedBags: [], qrSkipped: false }));
    setCameraState(prev => ({ ...prev, capturedPhoto: null }));
    stopCamera();
    lastScannedValueRef.current = '';
  };

  const handleCallCustomer = (phoneNumber) => {
    if (phoneNumber) {
      window.open(`tel:${phoneNumber}`, '_self');
    }
  };

  const handleMessageCustomer = (phoneNumber) => {
    if (phoneNumber) {
      window.open(`sms:${phoneNumber}`, '_self');
    }
  };

  const handleOpenMaps = (mapLink) => {
    if (mapLink) {
      window.open(mapLink, '_blank', 'noopener,noreferrer');
    }
  };

  const handleRefresh = () => {
    dispatch(fetchDriverDeliveries());
  };

  const handleLogout = () => {
    dispatch(logout());
    navigate('/login');
  };

  const getDeliveryStatus = (delivery) => {
    if (!delivery) return 'upcoming';
    if (deliverySyncStatus[delivery._id]) return 'sync_pending';
    if ((delivery.status && ['delivered', 'completed'].includes(delivery.status)) || completedDeliveries.has(delivery._id)) return 'completed';
    return 'current';
  };

  const formatTime = (dateString) => {
    if (!dateString) return 'Time not set';
    try {
      const date = new Date(dateString);
      const hours = date.getHours();
      const minutes = date.getMinutes();
      const hour12 = hours % 12 || 12;
      const ampm = hours >= 12 ? 'PM' : 'AM';
      return `${hour12}:${String(minutes).padStart(2, '0')} ${ampm}`;
    } catch (error) {
      return 'Invalid time';
    }
  };

  const formatDate = (dateString) => {
    if (!dateString) return 'Date not set';
    try {
      const date = new Date(dateString);
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const pad = (n) => String(n).padStart(2, '0');
      return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    } catch (error) {
      return 'Invalid date';
    }
  };

  const formatDateOnly = (dateString) => {
    if (!dateString) return 'Date not set';
    try {
      const date = new Date(dateString);
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
    } catch (error) {
      return 'Invalid date';
    }
  };

  const fetchDeliveryHistory = async (period) => {
    setHistoryState(prev => ({ ...prev, loading: true }));
    try {
      const now = new Date();
      let dateFrom;
      
      if (period === 'today') {
        dateFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      } else if (period === 'week') {
        dateFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      } else if (period === 'month') {
        dateFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      }
      
      const response = await api.get('/deliveries', {
        params: {
          dateFrom: dateFrom.toISOString(),
          dateTo: now.toISOString(),
          status: 'delivered',
          limit: 1000
        }
      });
      
      let deliveries = [];
      if (response.data && response.data.data && Array.isArray(response.data.data.deliveries)) {
        deliveries = response.data.data.deliveries;
      } else if (response.data && Array.isArray(response.data.deliveries)) {
        deliveries = response.data.deliveries;
      } else if (Array.isArray(response.data)) {
        deliveries = response.data;
      }
      
      setHistoryState(prev => ({ ...prev, deliveries }));
    } catch (error) {
      console.error('Error fetching delivery history:', error);
    } finally {
      setHistoryState(prev => ({ ...prev, loading: false }));
    }
  };

  useEffect(() => {
    if (activeTab === 'history') {
      fetchDeliveryHistory(historyState.period);
    }
  }, [activeTab, historyState.period]);

  const AlphabetFilter = () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    return (
      <div className="flex flex-wrap justify-center gap-2 px-4 py-2 bg-gray-100">
        {alphabet.map(letter => (
          <button
            key={letter}
            onClick={() => {
              setFilterState(prev => ({
                ...prev,
                selectedLetter: prev.selectedLetter === letter ? '' : letter,
                searchTerm: '' // Clear search when using alphabet filter
              }));
            }}
            className={`w-8 h-8 rounded-full text-xs font-semibold transition-colors ${
              filterState.selectedLetter === letter
                ? 'bg-blue-500 text-white shadow-md'
                : 'bg-white text-gray-600 hover:bg-blue-100'
            }`}
          >
            {letter}
          </button>
        ))}
      </div>
    );
  };

  const DeliveryList = () => {
    return (
      <div className="p-4">
        <div className="mb-4">
          <h2 className="text-xl font-bold text-gray-900">Pending Deliveries</h2>
          <p className="text-sm text-gray-500">Your assigned deliveries for today</p>
        </div>
        
        {/* Search and Filter */}
        <div className="sticky top-0 z-40 bg-white border-b">
          <div className="p-4 space-y-3">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  type="text"
                  placeholder="Search by name, address, ID..."
                  value={filterState.searchTerm}
                  onChange={(e) => {
                    setFilterState(prev => ({
                      ...prev,
                      searchTerm: e.target.value,
                      selectedLetter: '' // Clear alphabet filter when searching
                    }));
                  }}
                  className="w-full pl-10 pr-8 py-2 border border-gray-300 rounded-full bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                {filterState.searchTerm && (
                  <button
                    onClick={() => setFilterState(prev => ({ ...prev, searchTerm: '' }))}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  >
                    <X className="w-5 h-5" />
                  </button>
                )}
              </div>
              <button
                onClick={() => setFilterState(prev => ({...prev, sortAlphabetical: !prev.sortAlphabetical}))}
                className={`px-4 py-2 rounded-lg font-semibold text-sm ${
                  filterState.sortAlphabetical
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-200 text-gray-700'
                }`}
              >
                {filterState.sortAlphabetical ? '✓ A-Z' : 'A-Z'}
              </button>
            </div>
            {!filterState.searchTerm && <AlphabetFilter />}
          </div>
          
          {/* Search results dropdown - full width below search */}
          {filterState.searchTerm && pendingDeliveries.length > 0 && (
            <div className="bg-gray-50 border-t border-gray-300">
              <div className="bg-gray-100 px-4 py-2 border-b">
                <p className="text-xs font-semibold text-gray-600">
                  Found {pendingDeliveries.length} delivery{pendingDeliveries.length !== 1 ? 'ies' : ''}
                </p>
              </div>
              <div className="max-h-96 overflow-y-auto">
                {pendingDeliveries.map(delivery => (
                  <button
                    key={delivery._id}
                    onClick={() => {
                      handleStartDelivery(delivery);
                      setFilterState(prev => ({ ...prev, searchTerm: '' }));
                    }}
                    className="w-full text-left p-3 border-b border-gray-200 hover:bg-blue-50 last:border-b-0 flex justify-between items-start"
                  >
                    <div className="flex-1">
                      <div className="font-semibold text-gray-900">{delivery.customerName}</div>
                      <div className="text-xs font-bold text-gray-900 bg-yellow-100 px-2 py-1 rounded mt-1">{delivery.address}</div>
                      <div className="text-xs text-gray-500 mt-1">{formatTime(delivery.scheduledTime)}</div>
                    </div>
                    <div className="ml-3 text-blue-500 hover:text-blue-700 font-semibold text-sm">
                      Start →
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
          {filterState.searchTerm && pendingDeliveries.length === 0 && (
            <div className="bg-gray-50 border-t border-gray-300 p-6 text-center">
              <p className="text-gray-500">No deliveries found matching "{filterState.searchTerm}"</p>
            </div>
          )}
        </div>

        {isLoading && pendingDeliveries.length === 0 ? (
          <div className="flex justify-center items-center p-8">
            <p className="text-gray-500">Loading deliveries...</p>
          </div>
        ) : searchTerm ? (
          // When searching, show results only in the dropdown (sticky search handles it)
          <div className="p-8 text-center">
            <p className="text-gray-500">Results shown in search dropdown above ↑</p>
          </div>
        ) : pendingDeliveries.length > 0 ? (
          <div className="space-y-2 px-4 pb-24">
            {/* Van↔bike handoffs sit at the top of the route list. Only shown in
                the natural route order — with a search, letter filter or
                alphabetical sort active the order is meaningless, so the
                card is hidden rather than misplaced. */}
            {!filterState.searchTerm && !filterState.selectedLetter && !filterState.sortAlphabetical
              && handoffs.filter((h) => h.status !== 'cancelled').map((h) => {
                const isBike = String(h.bike?._id ?? h.bike) === String(user?._id);
                // Bike: due once every trip-1 stop (the ones WITHOUT a handoff
                // link) is done. Van: due once the stop it detours after is done.
                const due = isBike
                  ? !pendingDeliveries.some((d) => !d.handoff)
                  : !pendingDeliveries.some((d) => (d.routeOrder ?? 0) <= (h.vanAfterRouteOrder ?? 0));
                return (
                  <HandoffCard
                    key={h._id}
                    handoff={h}
                    currentUserId={user?._id}
                    due={due}
                    onChanged={() => dispatch(fetchDriverDeliveries())}
                  />
                );
              })}
            {pendingDeliveries.map(delivery => (
              <div
                key={delivery._id}
                className="bg-white rounded-lg border border-gray-200 p-3"
              >
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <h3 className="text-base font-semibold text-gray-900">
                      {delivery.customerName}
                    </h3>
                    <p className="text-sm font-bold text-gray-900 bg-yellow-100 px-2 py-1 rounded mt-1">
                      {delivery.address}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-gray-500">
                      {formatTime(delivery.scheduledTime)}
                    </p>
                    {delivery.lateMinutes > 0 && (
                      <p className="text-xs text-red-600">
                        Late: +{delivery.lateMinutes}m
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex space-x-2">
                  <button
                    onClick={() => handleStartDelivery(delivery)}
                    className="flex-1 bg-blue-500 text-white py-2 px-3 rounded-lg text-sm font-medium hover:bg-blue-600 active:bg-blue-700"
                  >
                    Start Delivery
                  </button>
                  <button
                    onClick={() => handleCallCustomer(delivery.phone)}
                    className="flex-1 bg-green-500 text-white py-2 px-3 rounded-lg text-sm font-medium hover:bg-green-600 active:bg-green-700"
                  >
                    Call
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center p-8">
            <Package className="mx-auto h-12 w-12 text-gray-400" />
            <h3 className="mt-2 text-sm font-medium text-gray-900">
              {searchTerm || selectedLetter ? 'No deliveries found' : 'No pending deliveries'}
            </h3>
            <p className="mt-1 text-sm text-gray-500">
              {searchTerm || selectedLetter
                ? 'No deliveries match your search criteria.'
                : 'You have completed all your deliveries for today.'}
            </p>
          </div>
        )}
      </div>
    );
  };

  // Bag Collection QR Scanner Step
  if (flowState.isBagCollectionFlow && currentStep === 'bag_collection_qr' && currentDelivery) {
    return (
      <div className="min-h-screen bg-black">
        {feedback.isUploading && (
          <div className="fixed inset-0 bg-black bg-opacity-70 z-50 flex items-center justify-center">
            <div className="bg-white rounded-lg p-6 text-center max-w-xs">
              <svg className="animate-spin h-10 w-10 text-blue-500 mx-auto mb-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <p className="text-gray-700 font-semibold">Completing task...</p>
              <p className="text-sm text-gray-500 mt-1">Please wait</p>
            </div>
          </div>
        )}

        <div className="bg-black text-white p-4 safe-area-top">
          <div className="flex items-center justify-between">
            <button
              onClick={handleCompleteBagCollectionTask}
              className="p-2 text-white"
            >
              <X className="w-6 h-6" />
            </button>
            <div className="text-center">
              <h1 className="text-lg font-semibold">Bag Collection</h1>
              <p className="text-xs text-gray-300">{currentDelivery.customerName}</p>
            </div>
            <div className="w-6"></div>
          </div>
        </div>

        <div className="bg-gray-900 text-white p-4">
          <p className="text-sm text-gray-300">Scan each bag you collect. When you close this scanner, the task will complete automatically.</p>
        </div>

        <div className="flex-1 p-4">
          <div className="bg-white rounded-lg overflow-hidden mb-4">
            {cameraState.support.canUseCamera ? (
              <Suspense fallback={<ScannerFallback />}>
                <QRScanner
                  key={`qr-${scannerKey}-bag-collection`}
                  onScan={handleQRScan}
                  onError={handleQRScanError}
                  audio={false}
                  allowMultiple={false}
                  constraints={{
                    facingMode: 'environment',
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                  }}
                  scanDelay={50}
                  videoStyle={{
                    width: '100%',
                    height: '300px',
                    objectFit: 'cover'
                  }}
                  styles={{
                    container: {
                      width: '100%',
                      height: '300px',
                      borderRadius: '8px',
                      backgroundColor: '#000'
                    },
                    video: {
                      borderRadius: '8px',
                      width: '100%',
                      height: '100%'
                    }
                  }}
                  components={{
                    video: (props) => <video {...props} muted playsInline />
                  }}
                />
              </Suspense>
            ) : (
              <div className="p-6 text-center text-gray-700">
                <AlertTriangle className="w-10 h-10 mx-auto mb-3 text-orange-500" />
                <p className="font-medium mb-2">Camera access unavailable</p>
                <p className="text-sm text-gray-500">
                  {cameraState.support.reason || 'Camera access is not available. Enter bag IDs manually instead.'}
                </p>
              </div>
            )}
          </div>

          {bagState.collectionScans.length > 0 && (
            <div className="bg-white/10 border border-white/10 rounded-lg p-4 text-white mb-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-semibold uppercase tracking-wide">Scanned Bags</p>
                <span className="text-xs text-gray-300">{bagState.collectionScans.length}</span>
              </div>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {bagState.collectionScans.map((code) => (
                  <div key={code} className="flex items-center justify-between text-sm bg-white/5 rounded px-3 py-2">
                    <span>{code}</span>
                    <CheckCircle className="w-4 h-4 text-emerald-400" />
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-3">
            <button
              onClick={handleManualBagEntry}
              className="w-full flex items-center justify-center px-4 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
            >
              <QrCode className="w-5 h-5 mr-2" />
              Enter Bag ID Manually
            </button>

            <button
              onClick={handleCompleteBagCollectionTask}
              disabled={feedback.isUploading || bagState.collectionScans.length === 0}
              className={`w-full flex items-center justify-center px-4 py-3 rounded-lg font-semibold transition-colors ${
                bagState.collectionScans.length === 0 || feedback.isUploading
                  ? 'bg-gray-500 text-gray-200 cursor-not-allowed'
                  : 'bg-green-600 text-white hover:bg-green-700'
              }`}
            >
              {bagState.collectionScans.length === 0 ? 'Scan a bag to finish' : 'Finish Collection'}
            </button>

            <button
              onClick={() => setCurrentStep('bag_collection_no_bags_photo')}
              disabled={feedback.isUploading}
              className="w-full flex items-center justify-center px-4 py-3 bg-orange-500 text-white rounded-lg hover:bg-orange-600 disabled:bg-gray-800"
            >
              <Camera className="w-5 h-5 mr-2" />
              No Bag Available - Take Photo
            </button>

            <button
              onClick={handleCancelBagCollectionFlow}
              disabled={feedback.isUploading}
              className="w-full flex items-center justify-center px-4 py-3 bg-gray-600 text-white rounded-lg hover:bg-gray-700 disabled:bg-gray-800"
            >
              Cancel
            </button>
          </div>

          {feedback.scanSuccess && (
            <div className="mt-4 p-3 bg-emerald-600 text-white rounded-lg text-sm">
              {feedback.scanSuccess}
            </div>
          )}

          {feedback.scanError && (
            <div className="mt-4 p-3 bg-red-500 text-white rounded-lg text-sm">
              {feedback.scanError}
            </div>
          )}
          {showScannerRetry && (
            <button
              onClick={retryScanner}
              className="mt-3 w-full flex items-center justify-center px-4 py-2 bg-white/10 text-white border border-white/20 rounded-lg hover:bg-white/20"
            >
              Retry Camera
            </button>
          )}
        </div>
      </div>
    );
  }

  // No Bags Available - Photo Capture Step
  if (currentStep === 'bag_collection_no_bags_photo' && currentDelivery) {
    return (
      <div className="min-h-screen bg-black">
        {feedback.isUploading && (
          <div className="fixed inset-0 bg-black bg-opacity-70 z-50 flex items-center justify-center">
            <div className="bg-white rounded-lg p-6 text-center max-w-xs">
              <svg className="animate-spin h-10 w-10 text-blue-500 mx-auto mb-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <p className="text-gray-700 font-semibold">Completing task...</p>
              <p className="text-sm text-gray-500 mt-1">Please wait</p>
            </div>
          </div>
        )}

        <div className="bg-black text-white p-4 safe-area-top">
          <div className="flex items-center justify-between">
            <button
              onClick={() => setCurrentStep('bag_collection_qr')}
              className="p-2 text-white"
            >
              <ArrowLeft className="w-6 h-6" />
            </button>
            <div className="text-center">
              <h1 className="text-lg font-semibold">No Bags Available</h1>
              <p className="text-xs text-gray-300">{currentDelivery.customerName}</p>
            </div>
            <div className="w-6"></div>
          </div>
        </div>

        <div className="bg-orange-900/30 border-l-4 border-orange-500 text-white p-4">
          <p className="text-sm">Take a photo as proof that no bags were available for collection.</p>
        </div>

        <div className="flex-1 p-4">
          {!cameraState.noBagsPhoto ? (
            <div className="space-y-4">
              <div className="bg-black rounded-lg overflow-hidden relative" style={{ minHeight: '300px' }}>
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  style={{ 
                    width: '100%', 
                    height: 'auto', 
                    minHeight: '300px', 
                    maxHeight: '500px',
                    display: 'block',
                    objectFit: 'cover'
                  }}
                />
                {!streamRef.current && (
                  <div className="absolute inset-0 flex items-center justify-center bg-gray-900 bg-opacity-90">
                    <div className="text-center text-white">
                      <AlertTriangle className="w-10 h-10 mx-auto mb-3 text-orange-500" />
                      <p className="font-medium mb-2">Starting camera...</p>
                      <p className="text-sm text-gray-400">Please wait</p>
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-3">
                {streamRef.current && (
                  <>
                    <button
                      onClick={captureNoBagsPhoto}
                      disabled={feedback.isUploading}
                      className="w-full flex items-center justify-center px-4 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:bg-gray-800"
                    >
                      <Camera className="w-5 h-5 mr-2" />
                      Capture Photo
                    </button>

                    {cameraState.flashSupported && (
                      <button
                        onClick={toggleFlash}
                        className={`w-full flex items-center justify-center px-4 py-3 rounded-lg ${
                          cameraState.flashOn ? 'bg-yellow-500 text-black' : 'bg-gray-700 text-white'
                        }`}
                      >
                        <Zap className="w-5 h-5 mr-2" />
                        Flash {cameraState.flashOn ? 'On' : 'Off'}
                      </button>
                    )}
                  </>
                )}

                <button
                  onClick={() => {
                    stopCamera();
                    setCurrentStep('bag_collection_qr');
                  }}
                  disabled={feedback.isUploading}
                  className="w-full flex items-center justify-center px-4 py-3 bg-gray-600 text-white rounded-lg hover:bg-gray-700 disabled:bg-gray-800"
                >
                  Cancel
                </button>
              </div>
              
              {/* Hidden canvas for photo capture */}
              <canvas ref={canvasRef} style={{ display: 'none' }} />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="bg-white rounded-lg overflow-hidden">
                <img src={cameraState.noBagsPhoto} alt="No bags proof" className="w-full h-auto" />
              </div>

              <div className="space-y-3">
                <button
                  onClick={handleCompleteNoBagsTask}
                  disabled={feedback.isUploading}
                  className="w-full flex items-center justify-center px-4 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:bg-gray-800 font-semibold"
                >
                  <CheckCircle className="w-5 h-5 mr-2" />
                  Complete Task
                </button>

                <button
                  onClick={() => {
                    setCameraState(prev => ({ ...prev, noBagsPhoto: null }));
                    startCamera();
                  }}
                  disabled={feedback.isUploading}
                  className="w-full flex items-center justify-center px-4 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:bg-gray-800"
                >
                  <Camera className="w-5 h-5 mr-2" />
                  Retake Photo
                </button>

                <button
                  onClick={() => {
                    setCameraState(prev => ({ ...prev, noBagsPhoto: null }));
                    setCurrentStep('bag_collection_qr');
                  }}
                  disabled={feedback.isUploading}
                  className="w-full flex items-center justify-center px-4 py-3 bg-gray-600 text-white rounded-lg hover:bg-gray-700 disabled:bg-gray-800"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {feedback.scanSuccess && (
            <div className="mt-4 p-3 bg-emerald-600 text-white rounded-lg text-sm">
              {feedback.scanSuccess}
            </div>
          )}

          {feedback.scanError && (
            <div className="mt-4 p-3 bg-red-500 text-white rounded-lg text-sm">
              {feedback.scanError}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Collection action step
  if (currentStep === 'collection_action' && currentDelivery) {
    return (
      <div className="min-h-screen bg-black text-white">
        <div className="bg-black p-4 safe-area-top border-b border-white/10">
          <div className="flex items-center justify-between">
            <button
              onClick={handleBackToDelivery}
              className="p-2 text-white"
            >
              <ArrowLeft className="w-6 h-6" />
            </button>
            <div className="text-center">
              <h1 className="text-lg font-semibold">Collection</h1>
              <p className="text-xs text-gray-300">{currentDelivery.customerName}</p>
            </div>
            <div className="w-6" />
          </div>
        </div>

        <div className="p-4 space-y-4">
          <div className="bg-teal-900/30 border border-teal-500/40 rounded-lg p-4">
            <p className="text-xs uppercase tracking-wide text-teal-200 mb-1">Address</p>
            <p className="text-sm text-white">{currentDelivery.address || 'No address provided'}</p>
          </div>

          <div className="bg-white/5 border border-white/10 rounded-lg p-4">
            <p className="text-xs uppercase tracking-wide text-gray-300 mb-2">Bags to collect</p>
            {currentDelivery.collectionDetails?.bagIds?.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {currentDelivery.collectionDetails.bagIds.map((bagId) => (
                  <span key={bagId} className="px-3 py-1 rounded-full bg-teal-100 text-teal-900 text-xs font-semibold">
                    {bagId}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-400">No bag IDs specified</p>
            )}
          </div>

          <button
            onClick={() => {
              setCameraState(prev => ({ ...prev, noBagsPhoto: null }));
              setCurrentStep('collection_photo');
            }}
            disabled={feedback.isUploading}
            className="w-full flex items-center justify-center px-4 py-3 bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:bg-gray-800"
          >
            <Camera className="w-5 h-5 mr-2" />
            Bags Collected - Take Photo
          </button>

          <button
            onClick={handleCollectionNoBags}
            disabled={feedback.isUploading}
            className="w-full flex items-center justify-center px-4 py-3 bg-orange-500 text-white rounded-lg hover:bg-orange-600 disabled:bg-gray-800"
          >
            <Archive className="w-5 h-5 mr-2" />
            No Bag Available
          </button>

          {feedback.scanSuccess && (
            <div className="p-3 bg-emerald-600 text-white rounded-lg text-sm">
              {feedback.scanSuccess}
            </div>
          )}

          {feedback.scanError && (
            <div className="p-3 bg-red-500 text-white rounded-lg text-sm">
              {feedback.scanError}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Collection photo proof step
  if (currentStep === 'collection_photo' && currentDelivery) {
    return (
      <div className="min-h-screen bg-black">
        {feedback.isUploading && (
          <div className="fixed inset-0 bg-black bg-opacity-70 z-50 flex items-center justify-center">
            <div className="bg-white rounded-lg p-6 text-center max-w-xs">
              <svg className="animate-spin h-10 w-10 text-teal-500 mx-auto mb-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <p className="text-gray-700 font-semibold">Completing collection...</p>
              <p className="text-sm text-gray-500 mt-1">Please wait</p>
            </div>
          </div>
        )}

        <div className="bg-black text-white p-4 safe-area-top">
          <div className="flex items-center justify-between">
            <button
              onClick={() => {
                stopCamera();
                setCurrentStep('collection_action');
              }}
              className="p-2 text-white"
            >
              <ArrowLeft className="w-6 h-6" />
            </button>
            <div className="text-center">
              <h1 className="text-lg font-semibold">Collection Photo Proof</h1>
              <p className="text-xs text-gray-300">{currentDelivery.customerName}</p>
            </div>
            <div className="w-6" />
          </div>
        </div>

        <div className="bg-teal-900/30 border-l-4 border-teal-500 text-white p-4">
          <p className="text-sm">Take a photo to confirm bag collection.</p>
        </div>

        <div className="flex-1 p-4">
          {!cameraState.noBagsPhoto ? (
            <div className="space-y-4">
              <div className="bg-black rounded-lg overflow-hidden relative" style={{ minHeight: '300px' }}>
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  style={{
                    width: '100%',
                    height: 'auto',
                    minHeight: '300px',
                    maxHeight: '500px',
                    display: 'block',
                    objectFit: 'cover'
                  }}
                />
                {!streamRef.current && (
                  <div className="absolute inset-0 flex items-center justify-center bg-gray-900 bg-opacity-90">
                    <div className="text-center text-white">
                      <AlertTriangle className="w-10 h-10 mx-auto mb-3 text-teal-500" />
                      <p className="font-medium mb-2">Starting camera...</p>
                      <p className="text-sm text-gray-400">Please wait</p>
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-3">
                {streamRef.current && (
                  <>
                    <button
                      onClick={captureNoBagsPhoto}
                      disabled={feedback.isUploading}
                      className="w-full flex items-center justify-center px-4 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:bg-gray-800"
                    >
                      <Camera className="w-5 h-5 mr-2" />
                      Capture Photo
                    </button>

                    {cameraState.flashSupported && (
                      <button
                        onClick={toggleFlash}
                        className={`w-full flex items-center justify-center px-4 py-3 rounded-lg ${
                          cameraState.flashOn ? 'bg-yellow-500 text-black' : 'bg-gray-700 text-white'
                        }`}
                      >
                        <Zap className="w-5 h-5 mr-2" />
                        Flash {cameraState.flashOn ? 'On' : 'Off'}
                      </button>
                    )}
                  </>
                )}

                <button
                  onClick={() => {
                    stopCamera();
                    setCurrentStep('collection_action');
                  }}
                  disabled={feedback.isUploading}
                  className="w-full flex items-center justify-center px-4 py-3 bg-gray-600 text-white rounded-lg hover:bg-gray-700 disabled:bg-gray-800"
                >
                  Cancel
                </button>
              </div>

              <canvas ref={canvasRef} style={{ display: 'none' }} />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="bg-white rounded-lg overflow-hidden">
                <img src={cameraState.noBagsPhoto} alt="Collection proof" className="w-full h-auto" />
              </div>

              <div className="space-y-3">
                <button
                  onClick={handleCompleteCollection}
                  disabled={feedback.isUploading}
                  className="w-full flex items-center justify-center px-4 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:bg-gray-800 font-semibold"
                >
                  <CheckCircle className="w-5 h-5 mr-2" />
                  Confirm Collection
                </button>

                <button
                  onClick={() => {
                    setCameraState(prev => ({ ...prev, noBagsPhoto: null }));
                    startCamera();
                  }}
                  disabled={feedback.isUploading}
                  className="w-full flex items-center justify-center px-4 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:bg-gray-800"
                >
                  <Camera className="w-5 h-5 mr-2" />
                  Retake Photo
                </button>

                <button
                  onClick={() => {
                    setCameraState(prev => ({ ...prev, noBagsPhoto: null }));
                    setCurrentStep('collection_action');
                  }}
                  disabled={feedback.isUploading}
                  className="w-full flex items-center justify-center px-4 py-3 bg-gray-600 text-white rounded-lg hover:bg-gray-700 disabled:bg-gray-800"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {feedback.scanSuccess && (
            <div className="mt-4 p-3 bg-emerald-600 text-white rounded-lg text-sm">
              {feedback.scanSuccess}
            </div>
          )}

          {feedback.scanError && (
            <div className="mt-4 p-3 bg-red-500 text-white rounded-lg text-sm">
              {feedback.scanError}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Return QR Scanner Step
  if (flowState.showReturnFlow && currentStep === 'return_qr') {
    return (
      <div className="min-h-screen bg-black">
        {/* Header */}
        <div className="bg-black text-white p-4 safe-area-top">
          <div className="flex items-center justify-between">
            <button
              onClick={handleBackToDelivery}
              className="p-2 text-white"
            >
              <ArrowLeft className="w-6 h-6" />
            </button>
            <h1 className="text-lg font-semibold">Return Bag: Scan QR Code</h1>
            <div className="w-6"></div>
          </div>
        </div>

        {/* Progress Steps */}
        <div className="bg-gray-900 p-4">
          <div className="flex items-center justify-center space-x-8">
  <div className="flex flex-col items-center">
    <div className="w-8 h-8 bg-blue-500 rounded-full flex items-center justify-center text-white text-sm font-bold">1</div>
    <span className="text-white text-xs mt-1">Scan QR</span>
  </div>
  <div className="w-12 h-1 bg-gray-600"></div>
  <div className="flex flex-col items-center">
    <div className="w-8 h-8 bg-gray-600 rounded-full flex items-center justify-center text-white text-sm font-bold">2</div>
    <span className="text-gray-400 text-xs mt-1">Complete</span>
  </div>
</div>
        </div>

        {/* Scanner Container */}
        <div className="flex-1 p-4">
          <div className="bg-white rounded-lg overflow-hidden mb-4">
            {cameraSupport.canUseCamera ? (
              <Suspense fallback={<ScannerFallback />}>
                <QRScanner
                  key={`qr-${scannerKey}-return`}
                  onScan={handleQRScan}
                  onError={handleQRScanError}
                  audio={false}
                  allowMultiple={false}
                  constraints={{ 
                    facingMode: 'environment',
                    aspectRatio: 1 
                  }}
                  scanDelay={50}
                  styles={{
                    container: {
                      width: '100%',
                      height: '300px',
                      borderRadius: '8px'
                    },
                    video: {
                      borderRadius: '8px'
                    }
                  }}
                  components={{
                    video: (props) => <video {...props} muted playsInline />
                  }}
                />
              </Suspense>
            ) : (
              <div className="p-6 text-center text-gray-700">
                <AlertTriangle className="w-10 h-10 mx-auto mb-3 text-orange-500" />
                <p className="font-medium mb-2">Camera access unavailable</p>
                <p className="text-sm text-gray-500">
                  {cameraState.support.reason || 'Camera access is not available in this environment. Please enter the bag ID manually.'}
                </p>
              </div>
            )}
          </div>

          {/* Scan Instructions */}
          <div className="text-center text-white mb-4">
            <Scan className="w-12 h-12 mx-auto mb-2" />
            {cameraState.support.canUseCamera ? (
              <>
                <p className="text-lg font-medium">Scan Bag QR Code to Return</p>
                <p className="text-gray-300">
                  Point camera at the QR code - bag will be returned immediately
                </p>
              </>
            ) : (
              <>
                <p className="text-lg font-medium">Camera access unavailable</p>
                <p className="text-gray-300">
                  Enter the bag ID manually to complete the return.
                </p>
              </>
            )}
          </div>

          {/* Scanned Bag Info */}
          {bagState.scannedBagId && (
            <div className="bg-green-500 text-white p-4 rounded-lg mb-4">
              <div className="flex items-center justify-center space-x-2">
                <CheckCircle className="w-5 h-5" />
                <span className="font-medium">Bag Scanned: {bagState.scannedBagId}</span>
              </div>
              <p className="text-center text-green-100 mt-1">Returning bag...</p>
            </div>
          )}

          {/* Action Buttons */}
          <div className="space-y-3">
            <button
              onClick={handleManualBagEntry}
              className="w-full flex items-center justify-center px-4 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
            >
              <QrCode className="w-5 h-5 mr-2" />
              Enter Bag ID Manually
            </button>

            <button
              onClick={handleBackToDelivery}
              className="w-full flex items-center justify-center px-4 py-3 bg-gray-500 text-white rounded-lg hover:bg-gray-600"
            >
              <ArrowLeft className="w-5 h-5 mr-2" />
              Cancel Return
            </button>
          </div>

          {/* Error Message */}
          {feedback.scanError && (
            <div className="mt-4 p-3 bg-red-500 text-white rounded-lg">
              {feedback.scanError}
            </div>
          )}
          {showScannerRetry && (
            <button
              onClick={retryScanner}
              className="mt-3 w-full flex items-center justify-center px-4 py-2 bg-white/10 text-white border border-white/20 rounded-lg hover:bg-white/20"
            >
              Retry Camera
            </button>
          )}
          {showScannerRetry && (
            <button
              onClick={retryScanner}
              className="mt-3 w-full flex items-center justify-center px-4 py-2 bg-white/10 text-white border border-white/20 rounded-lg hover:bg-white/20"
            >
              Retry Camera
            </button>
          )}
        </div>
      </div>
    );
  }

  // Return Reason Step
  if (flowState.showReturnFlow && currentStep === 'return_reason') {
    return (
      <div className="min-h-screen bg-gray-50">
        {/* Header */}
        <div className="bg-white shadow-sm border-b border-gray-200 p-4">
          <div className="flex items-center justify-between">
            <button
              onClick={() => setCurrentStep('return_qr')}
              className="p-2 text-gray-600"
            >
              <ArrowLeft className="w-6 h-6" />
            </button>
            <h1 className="text-lg font-semibold text-gray-900">Return Bag: Select Reason</h1>
            <div className="w-6"></div>
          </div>
        </div>

        {/* Progress Steps */}
        <div className="bg-gray-900 p-4">
          <div className="flex items-center justify-center space-x-6">
            <div className="flex flex-col items-center">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-bold ${
                  qrSkipped ? 'bg-orange-500' : 'bg-green-500'
                }`}
              >
                {qrSkipped ? <XCircle className="w-4 h-4" /> : <CheckCircle className="w-4 h-4" />}
              </div>
              <span className="text-white text-xs mt-1">{qrSkipped ? 'QR Skipped' : 'Scan QR'}</span>
            </div>
            <div className="w-12 h-1 bg-blue-500"></div>
            <div className="flex flex-col items-center">
              <div className="w-8 h-8 bg-blue-500 rounded-full flex items-center justify-center text-white text-sm font-bold">2</div>
              <span className="text-white text-xs mt-1">Reason</span>
            </div>
            <div className="w-12 h-1 bg-gray-600"></div>
            <div className="flex flex-col items-center">
              <div className="w-8 h-8 bg-gray-600 rounded-full flex items-center justify-center text-white text-sm font-bold">3</div>
              <span className="text-gray-400 text-xs mt-1">Photo</span>
            </div>
            <div className="w-12 h-1 bg-gray-600"></div>
            <div className="flex flex-col items-center">
              <div className="w-8 h-8 bg-gray-600 rounded-full flex items-center justify-center text-white text-sm font-bold">4</div>
              <span className="text-gray-400 text-xs mt-1">Complete</span>
            </div>
          </div>
        </div>

        {/* Scanned Bag Info */}
        {scannedBagId && (
          <div className="bg-blue-500 text-white p-3 mx-4 mt-4 rounded-lg">
            <div className="flex items-center justify-center space-x-2">
              <QrCode className="w-4 h-4" />
              <span className="font-medium">Bag: {bagState.scannedBagId}</span>
            </div>
          </div>
        )}

        

        <div className="p-4 space-y-4">
          {/* Reason Selection */}
          <div className="bg-white rounded-lg shadow-sm p-4">
            <h3 className="font-semibold text-gray-900 mb-4">Select Return Reason</h3>
            <div className="space-y-3">
              {['Damaged bag', 'Wrong bag assigned', 'Customer refused', 'Delivery failed', 'Other'].map((reason) => (
                <button
                  key={reason}
                  onClick={() => setReturnState(prev => ({ ...prev, reason }))}
                  className={`w-full text-left p-3 border rounded-lg transition-colors ${
                    returnState.reason === reason
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  {reason}
                </button>
              ))}
            </div>
          </div>

          {/* Additional Notes */}
          <div className="bg-white rounded-lg shadow-sm p-4">
            <h3 className="font-semibold text-gray-900 mb-3">Additional Notes (Optional)</h3>
            <textarea
              value={returnState.notes}
              onChange={(e) => setReturnState(prev => ({ ...prev, notes: e.target.value }))}
              placeholder="Add any additional information about the return..."
              className="w-full p-3 border border-gray-200 rounded-lg resize-none"
              rows={3}
            />
          </div>

          {/* Action Buttons */}
          <div className="space-y-3">
            <button
              onClick={() => setCurrentStep('return_photo')}
              disabled={!returnState.reason}
              className={`w-full flex items-center justify-center px-4 py-3 rounded-lg ${
                returnState.reason
                  ? 'bg-blue-500 text-white hover:bg-blue-600'
                  : 'bg-gray-300 text-gray-500 cursor-not-allowed'
              }`}
            >
              Continue to Photo
            </button>

            <button
              onClick={() => setCurrentStep('return_qr')}
              className="w-full flex items-center justify-center px-4 py-3 bg-gray-500 text-white rounded-lg hover:bg-gray-600"
            >
              <ArrowLeft className="w-5 h-5 mr-2" />
              Back to QR Scan
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Return Photo Step
  if (flowState.showReturnFlow && currentStep === 'return_photo') {
    return (
      <div className="min-h-screen bg-black">
        {/* Header */}
        <div className="bg-black text-white p-4 safe-area-top">
          <div className="flex items-center justify-between">
            <button
              onClick={() => setCurrentStep('return_reason')}
              className="p-2 text-white"
            >
              <ArrowLeft className="w-6 h-6" />
            </button>
            <h1 className="text-lg font-semibold">Return Bag: Take Photo</h1>
            <div className="w-6"></div>
          </div>
        </div>

        {/* Progress Steps */}
        <div className="bg-gray-900 p-4">
          <div className="flex items-center justify-center space-x-6">
            <div className="flex flex-col items-center">
              <div className="w-8 h-8 bg-green-500 rounded-full flex items-center justify-center text-white text-sm font-bold">
                <CheckCircle className="w-4 h-4" />
              </div>
              <span className="text-white text-xs mt-1">Scan QR</span>
            </div>
            <div className="w-12 h-1 bg-green-500"></div>
            <div className="flex flex-col items-center">
              <div className="w-8 h-8 bg-green-500 rounded-full flex items-center justify-center text-white text-sm font-bold">
                <CheckCircle className="w-4 h-4" />
              </div>
              <span className="text-white text-xs mt-1">Reason</span>
            </div>
            <div className="w-12 h-1 bg-blue-500"></div>
            <div className="flex flex-col items-center">
              <div className="w-8 h-8 bg-blue-500 rounded-full flex items-center justify-center text-white text-sm font-bold">3</div>
              <span className="text-white text-xs mt-1">Photo</span>
            </div>
            <div className="w-12 h-1 bg-gray-600"></div>
            <div className="flex flex-col items-center">
              <div className="w-8 h-8 bg-gray-600 rounded-full flex items-center justify-center text-white text-sm font-bold">4</div>
              <span className="text-gray-400 text-xs mt-1">Complete</span>
            </div>
          </div>
        </div>

        {/* Bag and Reason Info */}
        <div className="p-4 space-y-3">
          <div className="bg-blue-500 text-white p-3 rounded-lg">
            <div className="flex items-center justify-center space-x-2">
              <QrCode className="w-4 h-4" />
              <span className="font-medium">Bag: {bagState.scannedBagId}</span>
            </div>
          </div>
          <div className="bg-orange-500 text-white p-3 rounded-lg">
            <div className="flex items-center justify-center space-x-2">
              <Archive className="w-4 h-4" />
              <span className="font-medium">Reason: {returnState.reason}</span>
            </div>
          </div>
        </div>

        {/* Camera */}
        <div className="flex-1 w-full">
          <div
            className="bg-gray-800 rounded-none overflow-hidden mb-4 relative aspect-video"
            style={{
              width: '100vw',
              marginLeft: '50%',
              transform: 'translateX(-50%)'
            }}
          >
            {!cameraState.capturedPhoto ? (
              cameraState.support.canUseCamera ? (
                <>
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover'
                    }}
                  />
                  {/* Camera switch button */}
                  <button
                    onClick={switchCamera}
                    className="absolute bottom-4 right-4 bg-black bg-opacity-50 text-white p-2 rounded-full"
                  >
                    <RotateCcw className="w-5 h-5" />
                  </button>
                  {/* Hidden canvas for capturing photos */}
                  <canvas ref={canvasRef} style={{ display: 'none' }} />
                </>
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-white px-6 text-center space-y-3">
                  <AlertTriangle className="w-12 h-12 text-orange-400" />
                  <p className="text-lg font-semibold">Camera access unavailable</p>
                  <p className="text-sm text-gray-300">
                    Upload a photo from your device to document the return.
                  </p>
                </div>
              )
            ) : (
              <img
                src={cameraState.capturedPhoto}
                alt="Captured return proof"
                style={{
                  width: '100%',
                  height: '300px',
                  objectFit: 'cover'
                }}
              />
            )}
          </div>

          {/* Photo Instructions */}
          <div className="text-center text-white mb-4">
            <Camera className="w-12 h-12 mx-auto mb-2" />
            <p className="text-lg font-medium">Take Return Photo</p>
            <p className="text-gray-300">
              {cameraState.support.canUseCamera
                ? 'Capture photo of the returned bag for documentation'
                : 'Upload a clear photo of the returned bag for documentation'}
            </p>
            {!cameraState.capturedPhoto && cameraState.support.canUseCamera && (
              <p className="text-yellow-300 text-sm mt-1">
                Make sure the bag and any damage is clearly visible
              </p>
            )}
          </div>

          {/* Action Buttons */}
          <div className="space-y-3">
            {!cameraState.capturedPhoto ? (
              <>
                {cameraState.support.canUseCamera && (
                  <button
                    onClick={capturePhoto}
                    className="w-full flex items-center justify-center px-4 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700"
                  >
                    <Camera className="w-5 h-5 mr-2" />
                    Capture Photo
                  </button>
                )}

                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full flex items-center justify-center px-4 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
                >
                  <Upload className="w-5 h-5 mr-2" />
                  Upload Photo
                </button>
              </>
            ) : (
              <button
                onClick={() => {
                  setCameraState(prev => ({ ...prev, capturedPhoto: null }));
                  startCamera();
                }}
                className="w-full flex items-center justify-center px-4 py-3 bg-yellow-500 text-white rounded-lg hover:bg-yellow-600"
              >
                <Camera className="w-5 h-5 mr-2" />
                Retake Photo
              </button>
            )}

            <button
              onClick={() => setCurrentStep('return_reason')}
              className="w-full flex items-center justify-center px-4 py-3 bg-gray-500 text-white rounded-lg hover:bg-gray-600"
            >
              <ArrowLeft className="w-5 h-5 mr-2" />
              Back to Reason
            </button>

            {cameraState.capturedPhoto && bagState.scannedBagId && returnState.reason && (
              <button
                onClick={handleReturnBag}
                className="w-full flex items-center justify-center px-4 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700"
              >
                <CheckCircle className="w-5 h-5 mr-2" />
                Complete Return
              </button>
            )}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handlePhotoUpload}
          />

          {/* Error Message */}
          {feedback.scanError && (
            <div className="mt-4 p-3 bg-red-500 text-white rounded-lg">
              {feedback.scanError}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Bag Return Photo Capture Flow
  if (flowState.showBagReturnFlow) {
    return (
      <div className="min-h-screen bg-black">
        {/* Upload Progress Overlay */}
        {feedback.isUploading && (
          <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center">
            <div className="bg-white rounded-lg p-8 max-w-sm mx-4 text-center">
              <div className="mb-4">
                <svg className="animate-spin h-16 w-16 text-blue-500 mx-auto" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
              </div>
              <h3 className="text-xl font-bold text-gray-900 mb-2">Uploading Photo</h3>
              <p className="text-gray-600 mb-4">Please wait while we upload the bag return photo...</p>
              <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                <div className="bg-blue-500 h-full rounded-full animate-pulse" style={{ width: '100%' }}></div>
              </div>
              <p className="text-sm text-gray-500 mt-3">This may take a few moments</p>
            </div>
          </div>
        )}

        {/* Header */}
        <div className="bg-black text-white p-4 safe-area-top">
          <div className="flex items-center justify-between">
            <button
              onClick={handleCancelBagReturn}
              className="p-2 text-white"
            >
              <ArrowLeft className="w-6 h-6" />
            </button>
            <h1 className="text-lg font-semibold">Return Bag</h1>
            <div className="w-6"></div>
          </div>
        </div>

        {/* Camera View or Photo Preview */}
        <div className="relative" style={{ height: 'calc(100vh - 200px)' }}>
          {!bagReturnPhoto ? (
            <>
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="w-full h-full object-cover"
              />
              <canvas ref={canvasRef} className="hidden" />
              
              {/* Camera Guide Overlay */}
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="border-2 border-white border-dashed rounded-lg" 
                     style={{ width: '80%', height: '60%' }}>
                </div>
              </div>
            </>
          ) : (
            <img
              src={bagReturnPhoto}
              alt="Bag Return"
              className="w-full h-full object-contain bg-black"
            />
          )}
        </div>

        {/* Action Buttons */}
        <div className="bg-gray-900 p-4 safe-area-bottom">
          {!bagReturnPhoto ? (
            <>
              <button
                onClick={handleCaptureBagReturnPhoto}
                className="w-full bg-blue-500 text-white py-4 rounded-lg font-semibold mb-3 flex items-center justify-center"
              >
                <Camera className="w-5 h-5 mr-2" />
                Capture Bag Photo
              </button>
              <button
                onClick={handleCancelBagReturn}
                className="w-full bg-gray-700 text-white py-3 rounded-lg"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                onClick={handleCompleteBagReturn}
                disabled={feedback.isUploading}
                className="w-full bg-green-500 text-white py-4 rounded-lg font-semibold mb-3 flex items-center justify-center disabled:bg-gray-600"
              >
                {feedback.isUploading ? (
                  <>
                    <svg className="animate-spin h-5 w-5 mr-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Processing...
                  </>
                ) : (
                  <>
                    <CheckCircle className="w-5 h-5 mr-2" />
                    Confirm Return
                  </>
                )}
              </button>
              <button
                onClick={() => setCameraState(prev => ({...prev, bagReturnPhoto: null}))}
                disabled={feedback.isUploading}
                className="w-full bg-gray-700 text-white py-3 rounded-lg disabled:bg-gray-600"
              >
                Retake Photo
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  // Delivery QR Scanner Step
  if (currentStep === 'qr' && !flowState.showReturnFlow) {
    return (
      <div className="min-h-screen bg-black">
        {/* Header */}
        <div className="bg-black text-white p-4 safe-area-top">
          <div className="flex items-center justify-between">
            <button
              onClick={handleBackToDelivery}
              className="p-2 text-white"
            >
              <ArrowLeft className="w-6 h-6" />
            </button>
            <h1 className="text-lg font-semibold">Step 1: Scan Bag QR Code</h1>
            <div className="w-6"></div>
          </div>
        </div>

        {/* Progress Steps */}
        <div className="bg-gray-900 p-4">
          <div className="flex items-center justify-center space-x-8">
            <div className="flex flex-col items-center">
              <div className="w-8 h-8 bg-blue-500 rounded-full flex items-center justify-center text-white text-sm font-bold">1</div>
              <span className="text-white text-xs mt-1">Scan QR</span>
            </div>
            <div className="w-12 h-1 bg-gray-600"></div>
            <div className="flex flex-col items-center">
              <div className="w-8 h-8 bg-gray-600 rounded-full flex items-center justify-center text-white text-sm font-bold">2</div>
              <span className="text-gray-400 text-xs mt-1">Take Photo</span>
            </div>
            <div className="w-12 h-1 bg-gray-600"></div>
            <div className="flex flex-col items-center">
              <div className="w-8 h-8 bg-gray-600 rounded-full flex items-center justify-center text-white text-sm font-bold">3</div>
              <span className="text-gray-400 text-xs mt-1">Complete</span>
            </div>
          </div>
        </div>

        {/* Scanner Container */}
        <div className="flex-1 p-4">
          <div className="bg-white rounded-lg overflow-hidden mb-4 relative">
            {cameraState.support.canUseCamera ? (
              <>
                <Suspense fallback={<ScannerFallback />}>
                  <QRScanner
                    key={`qr-${scannerKey}-delivery`}
                    onScan={handleQRScan}
                    onError={handleQRScanError}
                    audio={false}
                    allowMultiple={false}
                    constraints={{ 
                      facingMode: 'environment',
                      aspectRatio: 1 
                    }}
                    scanDelay={50}
                    styles={{
                      container: {
                        width: '100%',
                        height: '300px',
                        borderRadius: '8px'
                      },
                      video: {
                        borderRadius: '8px'
                      }
                    }}
                    components={{
                      video: (props) => <video {...props} muted playsInline />
                    }}
                  />
                </Suspense>
                {/* Flash Control Button */}
                <button
                  onClick={toggleFlash}
                  className={`absolute top-4 right-4 p-2 rounded-full bg-black bg-opacity-50 border border-white/20 transition ${
                    cameraState.flashOn ? 'text-yellow-300' : 'text-white'
                  }`}
                  title="Toggle flashlight"
                >
                  <Zap className="w-5 h-5" />
                </button>
              </>
            ) : (
              <div className="p-6 text-center text-gray-700">
                <AlertTriangle className="w-10 h-10 mx-auto mb-3 text-orange-500" />
                <p className="font-medium mb-2">Camera access unavailable</p>
                <p className="text-sm text-gray-500">
                  {cameraState.support.reason || 'Camera access is not available in this environment. Use manual entry or skip the QR step to proceed.'}
                </p>
              </div>
            )}
          </div>

          {/* Scan Instructions */}
          <div className="text-center text-white mb-4">
            <Scan className="w-12 h-12 mx-auto mb-2" />
            {cameraState.support.canUseCamera ? (
              <>
                <p className="text-lg font-medium">Scan Bag QR Code</p>
                <p className="text-gray-300">Point camera at the QR code on the bag</p>
              </>
            ) : (
              <>
                <p className="text-lg font-medium">Camera access unavailable</p>
                <p className="text-gray-300">
                  Enter the bag ID manually or skip the QR step to continue.
                </p>
              </>
            )}
          </div>

          {/* Bags Counter - Always Visible */}
          <div className={`p-4 rounded-lg mb-4 text-center ${
            bagState.scannedBags.length > 0 
              ? 'bg-green-500 text-white' 
              : 'bg-gray-700 text-gray-300'
          }`}>
            <div className="flex items-center justify-center space-x-2">
              <Package className="w-6 h-6" />
              <span className="text-2xl font-bold">{bagState.scannedBags.length}</span>
              <span className="text-lg font-medium">
                {bagState.scannedBags.length === 1 ? 'Bag Assigned' : 'Bags Assigned'}
              </span>
            </div>
          </div>

          {/* Scanned Bags List */}
          {bagState.scannedBags.length > 0 && (
            <div className="bg-green-600 text-white p-3 rounded-lg mb-4">
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {bagState.scannedBags.map((bagId, index) => (
                  <div key={index} className="flex items-center justify-between bg-green-700 p-2 rounded">
                    <span className="font-medium">Bag {index + 1}: {bagId}</span>
                    <button
                      onClick={() => setBagState((prev) => ({...prev, scannedBags: prev.scannedBags.filter((_, i) => i !== index)}))}
                      className="p-1 hover:bg-green-800 rounded transition"
                      title="Remove this bag"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="space-y-3">
            {bagState.scannedBags.length > 0 && (
              <button
                onClick={() => setCurrentStep('photo')}
                className="w-full flex items-center justify-center px-4 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 font-semibold"
              >
                <CheckCircle className="w-5 h-5 mr-2" />
                Continue to Photo ({bagState.scannedBags.length} bags)
              </button>
            )}
            
            <button
              onClick={handleManualBagEntry}
              className="w-full flex items-center justify-center px-4 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
            >
              <QrCode className="w-5 h-5 mr-2" />
              Enter Bag ID Manually
            </button>

            <button
              onClick={handleBackToDelivery}
              className="w-full flex items-center justify-center px-4 py-3 bg-gray-500 text-white rounded-lg hover:bg-gray-600"
            >
              <ArrowLeft className="w-5 h-5 mr-2" />
              Back to Delivery
            </button>
          </div>

          {/* Success Message */}
          {feedback.scanSuccess && (
            <div className="mt-4 p-3 bg-green-500 text-white rounded-lg">
              {feedback.scanSuccess}
            </div>
          )}

          {/* Error Message */}
          {feedback.scanError && (
            <div className="mt-4 p-3 bg-red-500 text-white rounded-lg">
              {feedback.scanError}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Return bags question modal - check BEFORE photo step
  if (flowState.showReturnBagsQuestion) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-md w-full animate-in fade-in zoom-in">
          <div className="text-center">
            <div className="flex justify-center mb-4">
              <Package className="w-16 h-16 text-blue-500" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">Return Any Bags?</h2>
            <p className="text-gray-600 mb-6">
              Do you have any bags to return from this delivery?
            </p>

            {/* Show recently scanned bags as quick options */}
            {bagState.scannedBags.length > 0 && (
              <div className="mb-6 p-4 bg-blue-50 rounded-lg border border-blue-200">
                <p className="text-sm font-medium text-gray-700 mb-3">Bags from this delivery:</p>
                <div className="space-y-2">
                  {bagState.scannedBags.map((bagId, index) => (
                    <button
                      key={index}
                      onClick={() => {
                        // Set this bag as the one to return and go to return bags scan
                        setBagState(prev => ({ ...prev, toReturn: [bagId] }));
                        setFlowState(prev => ({ ...prev, showReturnBagsQuestion: false }));
                        setFlowState(prev => ({ ...prev, isReturningBags: true }));
                        setCurrentStep('return_bags_scan');
                        startCamera();
                      }}
                      className="w-full px-3 py-2 bg-white border border-blue-300 text-gray-900 text-sm rounded hover:bg-blue-100 transition text-left flex items-center justify-between"
                    >
                      <span className="font-medium">{bagId}</span>
                      <CheckCircle className="w-4 h-4 text-blue-500" />
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-3">
              <button
                onClick={handleReturnBagsYes}
                className="w-full px-6 py-4 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 active:scale-95 transition flex items-center justify-center"
              >
                <Check className="w-5 h-5 mr-2" />
                Scan Other Bags to Return
              </button>
              <button
                onClick={handleReturnBagsNo}
                className="w-full px-6 py-4 bg-gray-600 text-white font-semibold rounded-lg hover:bg-gray-700 active:scale-95 transition flex items-center justify-center"
              >
                <X className="w-5 h-5 mr-2" />
                No Bags to Return
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Delivery Photo Capture Step
  if (currentStep === 'photo' && !flowState.showReturnFlow) {
    const photoStepTitle = bagState.qrSkipped ? 'Step 1: Take Delivery Photo' : 'Step 2: Take Delivery Photo';
    const photoStepBackLabel = bagState.qrSkipped ? 'Back to Delivery' : 'Back to QR Scan';
    return (
      <div className="min-h-screen bg-black">
        {/* Upload Progress Overlay */}
        {feedback.isUploading && (
          <div className="fixed inset-0 bg-black bg-opacity-75 z-50 flex items-center justify-center">
            <div className="bg-white rounded-lg p-8 max-w-sm mx-4 text-center">
              <div className="mb-4">
                {feedback.scanSuccess?.includes('completed successfully') ? (
                  <div className="flex items-center justify-center">
                    <CheckCircle className="h-16 w-16 text-green-500" />
                  </div>
                ) : (
                  <svg className="animate-spin h-16 w-16 text-blue-500 mx-auto" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                )}
              </div>
              <h3 className="text-xl font-bold text-gray-900 mb-2">
                {feedback.scanSuccess?.includes('completed successfully') ? 'Success!' : 'Processing Delivery'}
              </h3>
              <p className="text-gray-600 mb-4">
                {feedback.scanSuccess || 'Please wait while we process your delivery...'}
              </p>
              {!feedback.scanSuccess?.includes('completed successfully') && (
                <>
                  <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                    <div className="bg-blue-500 h-full rounded-full animate-pulse" style={{ width: '100%' }}></div>
                  </div>
                  <p className="text-sm text-gray-500 mt-3">This may take a few moments</p>
                  <p className="text-xs text-gray-400 mt-2">Auto-retry enabled for reliability</p>
                </>
              )}
            </div>
          </div>
        )}

        {/* Header */}
        <div className="bg-black text-white p-4 safe-area-top">
          <div className="flex items-center justify-between">
            <button
              onClick={handlePhotoStepBack}
              className="p-2 text-white"
            >
              <ArrowLeft className="w-6 h-6" />
            </button>
            <h1 className="text-lg font-semibold">{photoStepTitle}</h1>
            <div className="w-6"></div>
          </div>
        </div>

        {/* Progress Steps */}
        <div className="bg-gray-900 p-4">
          {bagState.qrSkipped ? (
            <div className="flex items-center justify-center space-x-8">
              <div className="flex flex-col items-center">
                <div className="w-8 h-8 bg-blue-500 rounded-full flex items-center justify-center text-white text-sm font-bold">1</div>
                <span className="text-white text-xs mt-1">Take Photo</span>
              </div>
              <div className="w-12 h-1 bg-blue-500"></div>
              <div className="flex flex-col items-center">
                <div className="w-8 h-8 bg-gray-600 rounded-full flex items-center justify-center text-white text-sm font-bold">2</div>
                <span className="text-gray-400 text-xs mt-1">Complete</span>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center space-x-8">
              <div className="flex flex-col items-center">
                <div className="w-8 h-8 bg-green-500 rounded-full flex items-center justify-center text-white text-sm font-bold">
                  <CheckCircle className="w-4 h-4" />
                </div>
                <span className="text-white text-xs mt-1">Scan QR</span>
              </div>
              <div className="w-12 h-1 bg-blue-500"></div>
              <div className="flex flex-col items-center">
                <div className="w-8 h-8 bg-blue-500 rounded-full flex items-center justify-center text-white text-sm font-bold">2</div>
                <span className="text-white text-xs mt-1">Take Photo</span>
              </div>
              <div className="w-12 h-1 bg-gray-600"></div>
              <div className="flex flex-col items-center">
                <div className="w-8 h-8 bg-gray-600 rounded-full flex items-center justify-center text-white text-sm font-bold">3</div>
                <span className="text-gray-400 text-xs mt-1">Complete</span>
              </div>
            </div>
          )}
        </div>

        {/* Scanned Bag Info */}
        {bagState.scannedBagId && (
          <div className="bg-blue-500 text-white p-3 mx-4 mt-4 rounded-lg">
            <div className="flex items-center justify-center space-x-2">
              <QrCode className="w-4 h-4" />
              <span className="font-medium">Bag: {bagState.scannedBagId}</span>
            </div>
          </div>
        )}
        

        {/* Camera */}
        <div className="flex-1 w-full">
          <div
            className="bg-gray-900 overflow-hidden relative"
            style={{
              width: '100vw',
              height: 'calc(100vh - 260px)',
              marginLeft: '50%',
              transform: 'translateX(-50%)',
              maxHeight: '620px',
              minHeight: '360px'
            }}
          >
            {!cameraState.capturedPhoto ? (
              cameraState.support.canUseCamera ? (
                <>
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover'
                    }}
                  />
                  {/* Camera controls */}
                  <div className="absolute top-4 right-4 flex space-x-2">
                    <button
                      onClick={toggleFlash}
                      className={`p-2 rounded-full bg-black bg-opacity-50 border border-white/20 transition ${
                        cameraState.flashOn ? 'text-yellow-300' : 'text-white'
                      }`}
                      title="Toggle flashlight"
                    >
                      <Zap className="w-5 h-5" />
                    </button>
                    <button
                      onClick={switchCamera}
                      className="p-2 rounded-full bg-black bg-opacity-50 text-white border border-white/20 transition"
                      aria-label="Switch camera"
                    >
                      <RotateCcw className="w-5 h-5" />
                    </button>
                  </div>
                  {/* Hidden canvas for capturing photos */}
                  <canvas ref={canvasRef} style={{ display: 'none' }} />
                </>
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-white px-6 text-center space-y-3">
                  <AlertTriangle className="w-12 h-12 text-orange-400" />
                  <p className="text-lg font-semibold">Camera access unavailable</p>
                  <p className="text-sm text-gray-300">
                    Upload a photo from your device to provide delivery proof.
                  </p>
                </div>
              )
            ) : (
              <img
                src={cameraState.capturedPhoto}
                alt="Captured delivery proof"
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover'
                }}
              />
            )}
          </div>
        </div>

        <div className="px-4">
          {/* Photo Instructions */}
          

          {/* Action Buttons */}
          <div className="mt-6 space-y-4">
            {!cameraState.capturedPhoto ? (
              <div className="flex items-center justify-center gap-4">
                {cameraState.support.canUseCamera && (
                  <button
                    onClick={capturePhoto}
                    className="flex flex-col items-center justify-center w-24 h-20 rounded-2xl bg-green-600 text-white shadow-lg shadow-green-900/30 hover:bg-green-500 active:scale-95 transition"
                  >
                    <Camera className="w-6 h-6 mb-1" />
                    <span className="text-xs font-semibold">Capture</span>
                  </button>
                )}

                <button
                  onClick={handlePhotoStepBack}
                  className="flex flex-col items-center justify-center w-24 h-20 rounded-2xl bg-gray-600 text-white shadow-lg shadow-black/30 hover:bg-gray-500 active:scale-95 transition"
                >
                  <ArrowLeft className="w-6 h-6 mb-1" />
                  <span className="text-xs font-semibold">{photoStepBackLabel}</span>
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-center gap-4">
                <button
                  onClick={() => {
                    setCameraState(prev => ({ ...prev, capturedPhoto: null }));
                    startCamera();
                  }}
                  className="flex flex-col items-center justify-center w-24 h-20 rounded-2xl bg-yellow-500 text-white shadow-lg shadow-yellow-900/30 hover:bg-yellow-400 active:scale-95 transition"
                >
                  <Camera className="w-6 h-6 mb-1" />
                  <span className="text-xs font-semibold">Retake</span>
                </button>

                <button
                  onClick={handlePhotoStepBack}
                  className="flex flex-col items-center justify-center w-24 h-20 rounded-2xl bg-gray-600 text-white shadow-lg shadow-black/30 hover:bg-gray-500 active:scale-95 transition"
                >
                  <ArrowLeft className="w-6 h-6 mb-1" />
                  <span className="text-xs font-semibold">{photoStepBackLabel}</span>
                </button>
              </div>
            )}

            {cameraState.capturedPhoto && (bagState.scannedBagId || bagState.qrSkipped) && (
              <button
                onClick={handlePhotoComplete}
                disabled={feedback.isUploading}
                className={`w-full flex items-center justify-center px-4 py-4 rounded-2xl font-semibold shadow-lg transition ${
                  feedback.isUploading
                    ? 'bg-gray-600 cursor-not-allowed shadow-gray-900/40'
                    : 'bg-green-600 hover:bg-green-500 active:scale-[0.99] shadow-green-900/40'
                } text-white`}
              >
                {feedback.isUploading ? (
                  <>
                    <svg className="animate-spin h-5 w-5 mr-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Processing...
                  </>
                ) : (
                  <>
                    <CheckCircle className="w-5 h-5 mr-2" />
                    Continue to Next Step
                  </>
                )}
              </button>
            )}
          </div>

          {/* Error Message */}
          {feedback.scanError && (
            <div className="mt-4 p-3 bg-red-500 text-white rounded-lg">
              {feedback.scanError}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Return bags scanning step
  if (flowState.isReturningBags && currentStep === 'return_bags_scan') {
    return (
      <div className="min-h-screen bg-black flex flex-col">
        {/* Upload Progress Overlay */}
        {feedback.isUploading && (
          <div className="fixed inset-0 bg-black bg-opacity-75 z-50 flex items-center justify-center">
            <div className="bg-white rounded-lg p-8 max-w-sm mx-4 text-center">
              <div className="mb-4">
                <svg className="animate-spin h-16 w-16 text-blue-500 mx-auto" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
              </div>
              <h3 className="text-xl font-bold text-gray-900 mb-2">Returning Bags</h3>
              <p className="text-gray-600">
                Processing {bagState.toReturn.length} bag(s)...
              </p>
            </div>
          </div>
        )}
        
        {/* Header */}
        <div className="bg-black text-white p-4 safe-area-top border-b border-gray-700">
          <div className="flex items-center justify-between">
            <button
              onClick={handleCancelReturnBagsFlow}
              className="p-2 text-white"
              disabled={feedback.isUploading}
            >
              <ArrowLeft className="w-6 h-6" />
            </button>
            <h1 className="text-lg font-semibold">Scan Bags to Return</h1>
            <div className="w-6"></div>
          </div>
        </div>

        {/* Scanned Bags List */}
        <div className="flex-1 overflow-y-auto px-4 py-4 bg-black">
          {bagState.toReturn.length > 0 ? (
            <div className="space-y-2">
              <h2 className="text-white font-semibold mb-3 text-center">Bags to Return ({bagState.toReturn.length})</h2>
              {bagState.toReturn.map((bagId, index) => (
                <div key={index} className="flex items-center justify-between bg-gray-800 p-4 rounded-lg border border-green-500/30">
                  <div className="flex items-center space-x-3">
                    <CheckCircle className="w-6 h-6 text-green-500" />
                    <span className="text-white font-medium text-lg">{bagId}</span>
                  </div>
                  <button
                    onClick={() => handleRemoveReturnBag(bagId)}
                    className="p-2 text-red-500 hover:text-red-400 transition"
                  >
                    <X className="w-6 h-6" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="h-full flex items-center justify-center">
              <div className="text-center">
                <QrCode className="w-16 h-16 text-gray-500 mx-auto mb-4" />
                <p className="text-gray-300 text-lg font-medium">Scan Bags to Return</p>
                <p className="text-sm text-gray-500 mt-2">Point camera at bag QR code</p>
              </div>
            </div>
          )}
        </div>

        {/* Camera Scanner Section */}
        <div className="bg-black p-4 border-t border-gray-700">
          <div className="relative rounded-lg overflow-hidden mb-4" style={{ height: '250px' }}>
            {cameraState.support.canUseCamera ? (
              <>
                <Suspense fallback={<ScannerFallback />}>
                  <QRScanner
                    key={`qr-${scannerKey}-return-bags`}
                    onScan={handleQRScan}
                    onError={handleQRScanError}
                    audio={false}
                    allowMultiple={false}
                    constraints={{ facingMode: cameraState.facingMode }}
                    containerStyle={{ width: '100%', height: '100%' }}
                    scanDelay={50}
                    videoStyle={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    components={{
                      video: (props) => <video {...props} muted playsInline />
                    }}
                  />
                </Suspense>
                {/* Flash Control Button */}
                <button
                  onClick={toggleFlash}
                  className={`absolute top-4 right-4 p-2 rounded-full bg-black bg-opacity-50 border border-white/20 transition ${
                    cameraState.flashOn ? 'text-yellow-300' : 'text-white'
                  }`}
                  title="Toggle flashlight"
                >
                  <Zap className="w-5 h-5" />
                </button>
              </>
            ) : (
              <div className="flex items-center justify-center h-full bg-gray-800">
                <p className="text-gray-400">Camera not available</p>
              </div>
            )}
          </div>

          {/* Status Messages */}
          {feedback.scanSuccess && (
            <div className="mb-4 p-3 bg-green-600 text-white rounded-lg text-sm">
              {feedback.scanSuccess}
            </div>
          )}
          {feedback.scanError && (
            <div className="mb-4 p-3 bg-red-600 text-white rounded-lg text-sm">
              {feedback.scanError}
            </div>
          )}
          {showScannerRetry && (
            <button
              onClick={retryScanner}
              className="mb-4 w-full flex items-center justify-center px-4 py-2 bg-white/10 text-white border border-white/20 rounded-lg hover:bg-white/20"
            >
              Retry Camera
            </button>
          )}

          {/* Action Buttons */}
          <div className="flex gap-3">
            <button
              onClick={handleCancelReturnBagsFlow}
              className="flex-1 px-4 py-3 bg-gray-600 text-white font-medium rounded-lg hover:bg-gray-500 transition"
            >
              Cancel
            </button>
            <button
              onClick={handleCompleteBagsReturn}
              disabled={bagState.toReturn.length === 0}
              className={`flex-1 px-4 py-3 font-medium rounded-lg transition ${
                bagState.toReturn.length === 0
                  ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
                  : 'bg-green-600 text-white hover:bg-green-500'
              }`}
            >
              Done ({bagState.toReturn.length})
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Delivery in progress view
  if (currentDelivery && currentStep === 'delivery' && !flowState.showReturnFlow) {
    return (
      <div className="min-h-screen bg-gray-50">
        {/* Upload Progress Overlay */}
        {feedback.isUploading && (
          <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center">
            <div className="bg-white rounded-lg p-8 max-w-sm mx-4 text-center">
              <div className="mb-4">
                <svg className="animate-spin h-16 w-16 text-blue-500 mx-auto" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
              </div>
              <h3 className="text-xl font-bold text-gray-900 mb-2">Uploading Photo</h3>
              <p className="text-gray-600 mb-4">
                {feedback.scanSuccess || 'Please wait while we upload your delivery photo...'}
              </p>
              <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                <div className="bg-blue-500 h-full rounded-full animate-pulse" style={{ width: '100%' }}></div>
              </div>
              <p className="text-sm text-gray-500 mt-3">This may take a few moments</p>
            </div>
          </div>
        )}

        {/* Header */}
        <div className="bg-white shadow-sm border-b border-gray-200 p-4">
          <div className="flex items-center justify-between">
            <button
              onClick={() => {
                dispatch(clearCurrentDelivery());
                setCurrentStep('delivery');
                setBagState(prev => ({ ...prev, scannedBagId: '', scannedBags: [], qrSkipped: false }));
                setCameraState(prev => ({ ...prev, capturedPhoto: null }));
                setFeedback(prev => ({ ...prev, scanError: '', scanSuccess: '' }));
                lastScannedValueRef.current = '';
              }}
              className="p-2 text-gray-600"
            >
              <X className="w-6 h-6" />
            </button>
            <h1 className="text-lg font-semibold text-gray-900">Active Delivery</h1>
            <div className="w-6"></div>
          </div>
        </div>

        {/* Delivery Details */}
        <div className="p-4 space-y-4">
          {/* Customer Info */}
          <div className="bg-white rounded-lg shadow-sm p-4">
            <h2 className="text-xl font-bold text-gray-900 mb-2">
              Deliver to {currentDelivery.customerName}
            </h2>
            <div className="space-y-3">

              {/* Delivery Timeline */}
              {currentDelivery.timeline && currentDelivery.timeline.length > 0 && (
                <div className="mb-4">
                  <h3 className="text-sm font-semibold text-gray-900 mb-2">📜 Delivery Timeline</h3>
                  <div className="space-y-3">
                    {currentDelivery.timeline.map((event, idx) => (
                      <div key={idx} className="flex items-start space-x-3">
                        <div className={`w-3 h-3 rounded-full mt-2 ${
                          event.status === 'delivered' ? 'bg-green-500' :
                          event.status === 'failed' ? 'bg-red-500' :
                          event.status === 'picked_up' ? 'bg-blue-500' :
                          event.status === 'assigned' ? 'bg-yellow-500' :
                          event.status === 'moved_to_next_day' ? 'bg-purple-500' :
                          'bg-gray-400'
                        }`} />
                        <div className="flex-1">
                          <div className="flex justify-between items-start">
                            <div>
                              <h4 className="font-medium text-gray-900 capitalize">
                                {event.status.replace(/_/g, ' ')}
                              </h4>
                              <p className="text-xs text-gray-500">
                                {event.timestamp ? (new Date(event.timestamp)).toLocaleString() : ''}
                              </p>
                            </div>
                          </div>
                          {event.notes && (
                            <p className="text-xs text-gray-600 mt-1">{event.notes}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {/* Task Type Badge */}
              {currentDelivery.type === 'Task' && (
                <div className="flex items-center space-x-2">
                  <span className="px-3 py-1.5 bg-purple-100 text-purple-800 text-sm font-semibold rounded-lg">
                    Task: {currentDelivery.taskType || 'General'}
                  </span>
                </div>
              )}

              {/* Proof Info for Completed Tasks */}
              {currentDelivery.status === 'completed' && currentDelivery.proof && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                  <h3 className="text-sm font-semibold text-blue-900 mb-2">Task Completion Details</h3>
                  
                  {/* Show bags collected */}
                  {currentDelivery.proof.bags && currentDelivery.proof.bags.length > 0 ? (
                    <div className="space-y-2">
                      <p className="text-sm text-blue-800">
                        <span className="font-medium">Bags Collected:</span> {currentDelivery.proof.bags.length}
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {currentDelivery.proof.bags.map((bagId, idx) => (
                          <span
                            key={idx}
                            className="inline-flex items-center px-2 py-0.5 text-xs font-medium bg-white text-blue-700 rounded border border-blue-300"
                          >
                            {bagId}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : currentDelivery.proof.notes?.includes('No bags available') && currentDelivery.proof.photoUrl ? (
                    <div className="space-y-2">
                      <p className="text-sm text-orange-800 font-medium">
                        ⚠️ No bags were available for collection
                      </p>
                      <p className="text-xs text-orange-700">Photo proof provided:</p>
                      <img 
                        src={currentDelivery.proof.photoUrl} 
                        alt="No bags proof" 
                        className="w-full rounded-lg border-2 border-orange-300 cursor-pointer hover:opacity-90"
                        onClick={() => window.open(currentDelivery.proof.photoUrl, '_blank')}
                      />
                      <p className="text-xs text-gray-500 text-center">Click to view full size</p>
                    </div>
                  ) : null}
                  
                  {currentDelivery.proof.notes && (
                    <p className="text-xs text-blue-700 mt-2">
                      <span className="font-medium">Notes:</span> {currentDelivery.proof.notes}
                    </p>
                  )}
                  
                  {currentDelivery.proof.timestamp && (
                    <p className="text-xs text-gray-500 mt-1">
                      Completed: {new Date(currentDelivery.proof.timestamp).toLocaleString()}
                    </p>
                  )}
                </div>
              )}

              <div className="flex items-start space-x-3 bg-yellow-50 p-3 rounded-lg border-2 border-yellow-300">
                <MapPin className="w-5 h-5 text-yellow-600 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-gray-900 font-bold text-lg">Address</p>
                  <p className="text-gray-900 font-bold text-lg">{currentDelivery.address}</p>
                </div>
              </div>

              <div className="flex items-start space-x-3">
                <Clock className="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-gray-900 font-medium">Scheduled Time</p>
                  <p className="text-gray-600">{formatTime(currentDelivery.scheduledTime)}</p>
                </div>
              </div>

              {currentDelivery.combinedSunday && (
                <div className="bg-indigo-50 border-2 border-indigo-300 rounded-lg p-3">
                  <p className="text-sm text-indigo-900 font-bold">
                    📦 Sunday's delivery is included — bring 2 days' worth for this customer.
                  </p>
                </div>
              )}

              {currentDelivery.notes && (
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
                  <p className="text-sm text-yellow-800">
                    <span className="font-medium">Notes:</span> {currentDelivery.notes}
                  </p>
                </div>
              )}

              <div className="flex items-center space-x-2">
                <span className="px-2 py-1 bg-blue-100 text-blue-800 text-xs font-medium rounded-full">
                  {currentDelivery.company}
                </span>
                {currentDelivery.lateMinutes > 0 && (
                  <span className="px-2 py-1 bg-red-100 text-red-800 text-xs font-medium rounded-full">
                    Late: +{currentDelivery.lateMinutes}m
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="space-y-3">
            {(() => {
              const deliveryMapLink = currentDelivery.gpsLocation?.link?.trim();

              return (
            <button
              onClick={() => handleOpenMaps(deliveryMapLink)}
              disabled={!deliveryMapLink}
              className={`w-full flex items-center justify-center px-4 py-3 rounded-lg text-white ${deliveryMapLink ? 'bg-blue-500 hover:bg-blue-600 active:bg-blue-700' : 'bg-gray-400 cursor-not-allowed'}`}
            >
              <Navigation className="w-5 h-5 mr-2" />
              Open in Maps
            </button>
              );
            })()}

            {currentDelivery.phone && (
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => handleCallCustomer(currentDelivery.phone)}
                  className="flex items-center justify-center px-4 py-3 bg-green-500 text-white rounded-lg hover:bg-green-600 active:bg-green-700"
                >
                  <Phone className="w-5 h-5 mr-2" />
                  Call
                </button>
                <button
                  onClick={() => handleMessageCustomer(currentDelivery.phone)}
                  className="flex items-center justify-center px-4 py-3 bg-purple-500 text-white rounded-lg hover:bg-purple-600 active:bg-purple-700"
                >
                  <MessageCircle className="w-5 h-5 mr-2" />
                  Message
                </button>
              </div>
            )}

            {/* Task-specific action buttons */}
            {currentDelivery.type === 'Task' ? (
              // Task type: Bag Collection
              currentDelivery.taskType === 'Bag Collection' ? (
                <div className="space-y-3">
                  {/* Scanned Bags Counter */}
                  {bagState.collectionScans.length > 0 && (
                    <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                      <div className="text-center">
                        <h3 className="text-sm font-semibold text-green-800 mb-2">
                          Scanned Bags: {bagState.collectionScans.length}
                        </h3>
                        <div className="flex flex-wrap gap-2 justify-center">
                          {bagState.collectionScans.map((scanId, idx) => (
                            <span
                              key={idx}
                              className="inline-flex items-center px-2 py-1 text-xs font-medium bg-white text-green-700 rounded-full border border-green-200"
                            >
                              {scanId}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Submit Button */}
                  <button
                    onClick={() => setCurrentStep('bag_collection_scan')}
                    className="w-full flex items-center justify-center px-4 py-3 bg-purple-600 hover:bg-purple-700 active:bg-purple-800 text-white rounded-lg transition-colors font-semibold"
                  >
                    <QrCode className="w-5 h-5 mr-2" />
                    Scan Bags ({bagState.collectionScans.length})
                  </button>

                  {/* Info Text */}
                  <p className="text-xs text-gray-600 text-center">
                    Scan bags using the QR code scanner. Close the scanner window when done to complete the task.
                  </p>
                </div>
              ) : (
                // Other task types (Purchase, etc.)
                <button
                  onClick={handleCompletePurchaseTask}
                  disabled={feedback.isUploading}
                  className={`w-full flex items-center justify-center px-4 py-3 rounded-lg ${
                    feedback.isUploading 
                      ? 'bg-gray-400 cursor-not-allowed' 
                      : 'bg-green-600 hover:bg-green-700 active:bg-green-800'
                  } text-white transition-colors font-semibold`}
                >
                  {feedback.isUploading ? (
                    <>
                      <svg className="animate-spin h-5 w-5 mr-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      Processing...
                    </>
                  ) : (
                    <>
                      <CheckCircle className="w-5 h-5 mr-2" />
                      Complete Task
                    </>
                  )}
                </button>
              )
            ) : (
              // Regular delivery buttons
              <>
                <button
                  onClick={() => handleCompleteDeliveryFlow(false)}
                  disabled={feedback.isUploading}
                  className={`w-full flex items-center justify-center px-4 py-3 rounded-lg ${
                    feedback.isUploading 
                      ? 'bg-gray-400 cursor-not-allowed' 
                      : 'bg-green-600 hover:bg-green-700 active:bg-green-800'
                  } text-white transition-colors`}
                >
                  {feedback.isUploading ? (
                    <>
                      <svg className="animate-spin h-5 w-5 mr-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      Uploading...
                    </>
                  ) : (
                    <>
                      <CheckCircle className="w-5 h-5 mr-2" />
                      Complete Delivery
                    </>
                  )}
                </button>
              </>
            )}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handlePhotoUpload}
          />

          {/* Error Message */}
          {feedback.scanError && (
            <div className="mt-4 p-3 bg-red-500 text-white rounded-lg">
              {feedback.scanError}
            </div>
          )}
        </div>
      </div>
    );
  }

  const geolocationStatusClass = GEO_STATUS_STYLES[geolocationStatus.state] || GEO_STATUS_STYLES.idle;

  // Map View - Completely Separate Page
  if (activeTab === 'map') {
    return (
      <div className="fixed inset-0 z-50 bg-white">
        {/* Map Header */}
        <div className="absolute top-0 left-0 right-0 bg-white shadow-md p-4 z-50">
          <div className="flex items-center justify-between">
            <div className="flex items-center">
              <button
                onClick={() => setActiveTab('deliveries')}
                className="p-2 -ml-2 text-gray-600 hover:bg-gray-100 rounded-lg"
              >
                <ArrowLeft className="w-6 h-6" />
              </button>
              <h1 className="text-lg font-semibold text-gray-900 ml-2">Delivery Map</h1>
            </div>
            <button
              onClick={() => {
                if (showSimulation) {
                  // Close simulation
                  setShowSimulation(false);
                  setShowSimulationConfig(false);
                  setSimulatedTimes([]);
                  setSimulationStartIndex(null);
                  setSimulationEndIndex(null);
                  setSimulationStartTime(null);
                  setSimulationStartTimeInput('');
                  setSimulationStartDateInput('');
                } else {
                  // Open simulation config
                  setShowSimulationConfig(true);
                }
              }}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                showSimulation 
                  ? 'bg-blue-500 text-white' 
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              <Zap className="w-4 h-4" />
              {showSimulation ? 'Hide' : 'Simulate'}
            </button>
          </div>
        </div>

        {/* Simulation Configuration Panel */}
        {showSimulationConfig && (
          <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/30">
            <div className="mt-12 w-full max-w-2xl bg-white shadow-2xl rounded-xl border border-gray-200 max-h-[80vh] overflow-y-auto">
              <div className="p-4 border-b">
                <h3 className="text-sm font-bold text-gray-900">Configure Route Simulation</h3>
              </div>
              <div className="p-4 space-y-4">
              
              {/* Start Point Selection */}
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-2">Start From:</label>
                <select
                  value={simulationStartIndex ?? ''}
                  onChange={(e) => setSimulationStartIndex(e.target.value ? parseInt(e.target.value) : null)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  <option value="">Your Current Location</option>
                  {pendingDeliveries
                    .filter(d => d.gpsLocation?.lat && d.gpsLocation?.lng)
                    .sort((a, b) => new Date(a.scheduledTime) - new Date(b.scheduledTime))
                    .map((delivery, index) => (
                      <option key={delivery._id} value={index}>
                        {index + 1}. {delivery.customerName} - {delivery.address?.substring(0, 30)}...
                      </option>
                    ))}
                </select>
              </div>

              {/* End Point Selection */}
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-2">End At:</label>
                <select
                  value={simulationEndIndex ?? ''}
                  onChange={(e) => setSimulationEndIndex(e.target.value ? parseInt(e.target.value) : null)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  <option value="">Last Delivery</option>
                  {pendingDeliveries
                    .filter(d => d.gpsLocation?.lat && d.gpsLocation?.lng)
                    .sort((a, b) => new Date(a.scheduledTime) - new Date(b.scheduledTime))
                    .map((delivery, index) => {
                      // Only show deliveries after start point
                      if (simulationStartIndex !== null && index <= simulationStartIndex) return null;
                      return (
                        <option key={delivery._id} value={index}>
                          {index + 1}. {delivery.customerName} - {delivery.address?.substring(0, 30)}...
                        </option>
                      );
                    })}
                </select>
              </div>

              {/* Start Time Selection */}
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-2">Start Date:</label>
                <input
                  type="date"
                  value={simulationStartDateInput}
                  onChange={(e) => setSimulationStartDateInput(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p className="text-[11px] text-gray-500 mt-1">Leave blank to use today.</p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-2">Start Time:</label>
                <input
                  type="time"
                  value={simulationStartTimeInput}
                  onChange={(e) => setSimulationStartTimeInput(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p className="text-[11px] text-gray-500 mt-1">Leave blank to start at current time.</p>
              </div>

              {/* Action Buttons */}
              <div className="flex gap-2 pt-2 border-t">
                <button
                  onClick={() => {
                    // Calculate simulation times
                    const now = new Date();
                    let startClock = new Date(now);
                    if (simulationStartDateInput) {
                      const parsedDate = new Date(simulationStartDateInput + 'T00:00:00');
                      if (!Number.isNaN(parsedDate.getTime())) {
                        startClock.setFullYear(parsedDate.getFullYear(), parsedDate.getMonth(), parsedDate.getDate());
                      }
                    }
                    if (simulationStartTimeInput) {
                      const [hStr, mStr] = simulationStartTimeInput.split(':');
                      const h = parseInt(hStr || '0', 10);
                      const m = parseInt(mStr || '0', 10);
                      if (!Number.isNaN(h) && !Number.isNaN(m)) {
                        startClock.setHours(h, m, 0, 0);
                      }
                    }
                    const driverLoc = lastKnownLocationRef.current;
                    setSimulationStartTime(startClock);
                    
                    // Sort deliveries by scheduled time
                    const sortedDeliveries = [...pendingDeliveries]
                      .filter(d => d.gpsLocation?.lat && d.gpsLocation?.lng)
                      .sort((a, b) => new Date(a.scheduledTime) - new Date(b.scheduledTime));

                    // Determine start and end indices
                    const startIdx = simulationStartIndex ?? 0;
                    const endIdx = simulationEndIndex !== null ? simulationEndIndex + 1 : sortedDeliveries.length;
                    
                    // Get deliveries to simulate
                    const deliveriesToSimulate = sortedDeliveries.slice(startIdx, endIdx);
                    
                    if (deliveriesToSimulate.length === 0) {
                      alert('No deliveries selected for simulation');
                      return;
                    }

                    // Starting position
                    let currentLat, currentLng;
                    if (simulationStartIndex === null) {
                      // Start from driver's location
                      if (!driverLoc || !driverLoc.lat || !driverLoc.lng) {
                        alert('Cannot get your current location');
                        return;
                      }
                      currentLat = driverLoc.lat;
                      currentLng = driverLoc.lng;
                    } else {
                      // Start from selected delivery
                      const startDelivery = sortedDeliveries[simulationStartIndex];
                      currentLat = startDelivery.gpsLocation.lat;
                      currentLng = startDelivery.gpsLocation.lng;
                    }

                    let currentTime = new Date(startClock);
                    
                    const times = deliveriesToSimulate.map((delivery, index) => {
                      const destLat = delivery.gpsLocation.lat;
                      const destLng = delivery.gpsLocation.lng;
                      
                      // Calculate distance using Haversine formula (in km)
                      const R = 6371;
                      const dLat = (destLat - currentLat) * Math.PI / 180;
                      const dLng = (destLng - currentLng) * Math.PI / 180;
                      const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                              Math.cos(currentLat * Math.PI / 180) * Math.cos(destLat * Math.PI / 180) *
                              Math.sin(dLng/2) * Math.sin(dLng/2);
                      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
                      const distance = R * c;
                      
                      // Estimate travel time (avg speed 40 km/h in city) + 5 min stop time
                      const travelTimeMinutes = (distance / 40) * 60;
                      const stopTimeMinutes = 5;
                      const totalMinutes = travelTimeMinutes + stopTimeMinutes;
                      
                      currentTime = new Date(currentTime.getTime() + totalMinutes * 60000);
                      currentLat = destLat;
                      currentLng = destLng;
                      
                      const scheduledTime = new Date(delivery.scheduledTime);
                      const diffMinutes = Math.round((currentTime - scheduledTime) / 60000);
                      
                      return {
                        deliveryId: delivery._id,
                        estimatedArrival: new Date(currentTime),
                        scheduledTime: scheduledTime,
                        diffMinutes: diffMinutes,
                        distance: distance,
                        travelTime: travelTimeMinutes
                      };
                    });
                    
                    setSimulatedTimes(times);
                    setShowSimulation(true);
                    setShowSimulationConfig(false);
                  }}
                  className="flex-1 bg-blue-500 text-white py-2 px-4 rounded-lg text-sm font-medium hover:bg-blue-600"
                >
                  Start Simulation
                </button>
                <button
                  onClick={() => {
                    setShowSimulationConfig(false);
                    setSimulationStartIndex(null);
                    setSimulationEndIndex(null);
                    setSimulationStartTime(null);
                    setSimulationStartTimeInput('');
                    setSimulationStartDateInput('');
                  }}
                  className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-300"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
          </div>
        )}

        {/* Simulation Timeline */}
        {showSimulation && simulatedTimes.length > 0 && !showSimulationConfig && (
          <div className="absolute top-16 left-0 right-0 bg-white shadow-md z-50 max-h-64 overflow-y-auto">
            <div className="p-4">
              <h3 className="text-sm font-bold text-gray-900 mb-3 flex items-center">
                <Clock className="w-4 h-4 mr-2" />
                Estimated Arrival Times
              </h3>
              {simulationStartTime && (
                <p className="text-xs text-gray-500 mb-2">
                  Simulation start: {simulationStartTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}
                </p>
              )}
              <div className="space-y-2">
                {simulatedTimes.map((time, index) => {
                  const delivery = pendingDeliveries.find(d => d._id === time.deliveryId);
                  if (!delivery) return null;
                  
                  const isLate = time.diffMinutes > 0;
                  const isEarly = time.diffMinutes < -5;
                  
                  return (
                    <div
                      key={time.deliveryId}
                      className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
                    >
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-gray-500">#{index + 1}</span>
                          <p className="font-semibold text-gray-900 text-sm">{delivery.customerName}</p>
                        </div>
                        <p className="text-xs text-gray-500 mt-1">
                          {Math.round(time.distance * 10) / 10} km • {Math.round(time.travelTime)} min drive
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-semibold text-gray-900">
                          {time.estimatedArrival.toLocaleTimeString('en-US', { 
                            hour: '2-digit', 
                            minute: '2-digit',
                            hour12: true 
                          })}
                        </p>
                        <p className={`text-xs font-medium ${
                          isLate ? 'text-red-600' : isEarly ? 'text-green-600' : 'text-gray-600'
                        }`}>
                          {formatDelayLabel(time.diffMinutes)}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Main Dashboard View with Quick Actions
  return (
    <div className="min-h-screen bg-gray-50 safe-area-padding">
      {/* Header */}
      <div className="bg-blue-500 text-white p-4 safe-area-top">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <button
              onClick={() => setShowMenu(true)}
              className="p-1"
            >
              <Menu className="w-6 h-6" />
            </button>
            <div>
              <h1 className="text-xl font-bold">Driver Portal</h1>
              <p className="text-blue-100 text-sm">Welcome, {user?.profile?.firstName || 'Driver'}</p>
            </div>
          </div>
          <div className="flex items-center space-x-2">
            <button 
              onClick={handleRefresh}
              disabled={isLoading}
              className="p-2"
            >
              <RefreshCw className={`w-5 h-5 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
            <div className="w-8 h-8 bg-blue-400 rounded-full flex items-center justify-center">
              <User className="w-4 h-4" />
            </div>
          </div>
        </div>
      </div>

      {/* Offline Mode Banner */}
      {!offlineState.isOnline && (
        <div className="mx-4 mt-4 flex items-center gap-2 px-4 py-3 bg-yellow-50 border border-yellow-200 rounded-lg">
          <AlertTriangle className="w-5 h-5 text-yellow-600 flex-shrink-0" />
          <div className="flex-1">
            <p className="text-yellow-800 font-semibold text-sm">Offline Mode</p>
            <p className="text-yellow-700 text-xs">Changes will sync automatically when online</p>
          </div>
        </div>
      )}

      {/* Offline Queue Indicator */}
      {offlineState.isOnline && offlineState.queue.length > 0 && (
        <div className="mx-4 mt-4 flex items-center gap-2 px-4 py-3 bg-blue-50 border border-blue-200 rounded-lg">
          <RefreshCw className={`w-5 h-5 text-blue-600 flex-shrink-0 ${offlineState.syncStatus.syncing ? 'animate-spin' : ''}`} />
          <div className="flex-1">
            <p className="text-blue-800 font-semibold text-sm">
              {offlineState.syncStatus.syncing ? 'Syncing...' : 'Auto-sync pending'}
            </p>
            <p className="text-blue-700 text-xs">
              {offlineState.syncStatus.syncing 
                ? `Progress: ${offlineState.syncStatus.progress || 0}% (${offlineState.syncStatus.successCount || 0} synced)`
                : `${offlineState.queue.length} pending action(s)`
              }
            </p>
          </div>
        </div>
      )}

      {geolocationStatus.message && (
        <div className={`mx-4 mt-4 flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${geolocationStatusClass}`}>
          <Navigation className="w-4 h-4" />
          <span>{geolocationStatus.message}</span>
        </div>
      )}

      {/* Success Message */}
      {feedback.scanSuccess && (
        <div className="mx-4 mt-2 p-3 bg-green-500 text-white rounded-lg shadow-lg">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <CheckCircle className="w-5 h-5" />
              <span>{feedback.scanSuccess}</span>
            </div>
            <button onClick={() => setFeedback(prev => ({...prev, scanSuccess: ''}))}>
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Stats Overview */}
      <div className="p-4">
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="bg-white p-4 rounded-lg shadow-sm">
            <div className="text-2xl font-bold text-gray-900">{stats.pending}</div>
            <div className="text-sm text-gray-500">Pending</div>
          </div>
          <div className="bg-white p-4 rounded-lg shadow-sm">
            <div className="text-2xl font-bold text-green-600">{stats.completed}</div>
            <div className="text-sm text-gray-500">Completed Today</div>
          </div>
          <div className="bg-white p-4 rounded-lg shadow-sm">
            <div className="text-2xl font-bold text-blue-600">{stats.onTime}</div>
            <div className="text-sm text-gray-500">On Time</div>
          </div>
          <div className="bg-white p-4 rounded-lg shadow-sm">
            <div className="text-2xl font-bold text-red-600">{stats.late}</div>
            <div className="text-sm text-gray-500">Late</div>
          </div>
        </div>

        {/* Global Search */}
        <div className="bg-white p-4 rounded-lg shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-sm text-gray-500">Search Deliveries</p>
            </div>
            <div className="flex gap-2">
              {(filterState.searchTerm || filterState.selectedLetter) && (
                <button
                  onClick={() => {
                    setFilterState(prev => ({...prev, searchTerm: '', selectedLetter: ''}));
                  }}
                  className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                >
                  Clear
                </button>
              )}
              <button
                onClick={() => setFilterState(prev => ({...prev, showAlphabetFilter: !prev.showAlphabetFilter}))}
                className={`px-3 py-1 rounded text-xs font-bold ${
                  filterState.showAlphabetFilter
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-200 text-gray-700'
                }`}
              >
                {filterState.showAlphabetFilter ? '✕ Filter' : 'Filter'}
              </button>
            </div>
          </div>
          <div className="relative mb-4">
            <input
              type="text"
              placeholder="Search by customer name..."
              value={filterState.searchTerm}
              onChange={(e) => {
                setFilterState(prev => ({...prev, searchTerm: e.target.value, selectedLetter: ''}));
              }}
              className="w-full pl-12 pr-4 py-3 border border-gray-200 rounded-2xl bg-gray-50 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-base"
            />
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
          </div>

          {/* Alphabet Filter - Show/Hide */}
          {filterState.showAlphabetFilter && (
            <div className="flex flex-wrap gap-2 p-3 bg-gray-50 rounded">
              {Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ').map(letter => (
                <button
                  key={letter}
                  onClick={() => {
                    setFilterState(prev => ({...prev, selectedLetter: prev.selectedLetter === letter ? '' : letter, searchTerm: ''}));
                  }}
                  className={`w-8 h-8 rounded text-xs font-bold ${
                    filterState.selectedLetter === letter
                      ? 'bg-blue-500 text-white'
                      : 'bg-white text-gray-700 border border-gray-300'
                  }`}
                >
                  {letter}
                </button>
              ))}
            </div>
          )}
          
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="bg-white border-b safe-area-top">
        <div className="flex">
          <button
            onClick={() => setActiveTab('deliveries')}
            className={`flex-1 py-4 text-center border-b-2 transition-colors ${
              activeTab === 'deliveries'
                ? 'border-blue-500 text-blue-500'
                : 'border-transparent text-gray-500'
            }`}
          >
            <Truck className="w-5 h-5 mx-auto mb-1" />
            <span className="text-xs font-medium">Deliveries</span>
          </button>
          <button
            onClick={() => setActiveTab('tasks')}
            className={`flex-1 py-4 text-center border-b-2 transition-colors relative ${
              activeTab === 'tasks'
                ? 'border-purple-500 text-purple-500'
                : 'border-transparent text-gray-500'
            }`}
          >
            <Package className="w-5 h-5 mx-auto mb-1" />
            <span className="text-xs font-medium">Tasks</span>
            {pendingDeliveries.filter(d => d.type === 'Task').length > 0 && (
              <span className="absolute top-2 right-2 w-5 h-5 bg-purple-600 text-white text-xs rounded-full flex items-center justify-center font-bold">
                {pendingDeliveries.filter(d => d.type === 'Task').length}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('history')}
            className={`flex-1 py-4 text-center border-b-2 transition-colors ${
              activeTab === 'history'
                ? 'border-green-500 text-green-500'
                : 'border-transparent text-gray-500'
            }`}
          >
            <Clock className="w-5 h-5 mx-auto mb-1" />
            <span className="text-xs font-medium">History</span>
          </button>
        </div>
      </div>

      {/* Content */}
      {activeTab !== 'map' && (
        <div className="p-4 safe-area-bottom">
          {activeTab === 'deliveries' && (
            <div className="space-y-3">
              {/* Sync Status Summary */}
              <DriverSyncSummary syncStatus={deliverySyncStatus} isSyncing={isSyncing} onRetry={() => handleRetrySync()} />
              
              {isLoading && pendingDeliveries.filter(d => d.type !== 'Task').length === 0 ? (
              <div className="text-center py-8">
                <RefreshCw className="w-8 h-8 animate-spin mx-auto mb-2 text-gray-400" />
                <p className="text-gray-500">Loading deliveries...</p>
              </div>
            ) : pendingDeliveries.filter(d => d.type !== 'Task').length === 0 ? (
              <div className="text-center py-8">
                <Package className="w-12 h-12 mx-auto mb-2 text-gray-300" />
                <p className="text-gray-500">No pending deliveries</p>
                <p className="text-gray-400 text-sm mt-1">{Object.keys(deliverySyncStatus).length ? 'Some uploads are still awaiting server confirmation.' : 'All deliveries completed for today!'}</p>
              </div>
            ) : (
              <div className="space-y-3">
                {pendingDeliveries.filter(d => d.type !== 'Task').map((delivery, index) => {
                  const status = getDeliveryStatus(delivery);
                  const syncInfo = deliverySyncStatus[delivery._id];
                  const syncIndicator = syncInfo ? getSyncStatusIndicator(syncInfo) : null;
                  return (
                    <div
                      key={delivery._id}
                      className={`bg-white rounded-xl shadow-sm p-4 ${
                        status === 'current' ? 'ring-2 ring-blue-500 ring-opacity-50' : ''
                      }`}
                    >
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex-1">
                          <div className="flex items-center space-x-2 mb-1">
                            <h3 className="font-semibold text-gray-900 text-lg">
                              {delivery.customerName}
                            </h3>
                            <span className="px-2 py-1 bg-gray-100 text-gray-600 text-xs font-medium rounded-full">
                              {delivery.company}
                            </span>
                            {delivery.type === 'Collection' && (
                              <span className="px-2 py-1 bg-teal-100 text-teal-700 text-xs font-medium rounded-full">
                                Collection
                              </span>
                            )}
                          </div>
                          <p className="text-sm text-gray-500 flex items-center">
                            <Clock className="w-4 h-4 mr-1" />
                            {formatTime(delivery.scheduledTime)}
                          </p>
                        </div>
                        <div className="flex flex-col items-end space-y-1">
                          {status === 'current' && (
                            <div className="px-3 py-1 bg-blue-100 text-blue-700 text-sm font-medium rounded-full">
                              Current
                            </div>
                          )}
                          {syncIndicator && (
                            <div 
                              className="px-2 py-1 rounded text-xs font-medium whitespace-nowrap"
                              style={{ backgroundColor: syncIndicator.color + '20', color: syncIndicator.color }}
                            >
                              <span>{syncIndicator.icon} {syncIndicator.label}</span>
                            </div>
                          )}
                        </div>
                      </div>

                      <p className="text-base font-bold text-gray-900 bg-yellow-100 px-3 py-2 rounded flex items-start mb-3 address-style">
                        <MapPin className="w-4 h-4 mr-2 mt-0.5 flex-shrink-0 text-yellow-700" />
                        {delivery.address}
                      </p>

                      {delivery.combinedSunday && (
                        <div className="bg-indigo-50 border border-indigo-300 rounded-lg p-2 mb-3">
                          <p className="text-xs text-indigo-900 font-semibold">📦 Sunday's delivery included — bring 2 days' worth.</p>
                        </div>
                      )}

                      {delivery.notes && (
                        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-2 mb-3">
                          <p className="text-xs text-yellow-800">{delivery.notes}</p>
                        </div>
                      )}

                      <div className="flex space-x-2">
                        {status === 'current' && (
                          <>
                            {delivery.phone && (
                              <button
                                onClick={() => handleCallCustomer(delivery.phone)}
                                className="flex-1 bg-green-500 text-white py-2 px-3 rounded-lg text-sm font-medium hover:bg-green-600 active:bg-green-700"
                              >
                                Call
                              </button>
                            )}
                            <button
                              onClick={() => handleStartDelivery(delivery)}
                              className="flex-1 bg-blue-500 text-white py-2 px-3 rounded-lg text-sm font-medium hover:bg-blue-600 active:bg-blue-700"
                            >
                              {delivery.type === 'Collection' ? 'Start Collection' : 'Start Delivery'}
                            </button>
                          </>
                        )}

                        {status === 'upcoming' && (
                          <button
                            onClick={() => handleStartDelivery(delivery)}
                            className="flex-1 bg-blue-500 text-white py-2 px-3 rounded-lg text-sm font-medium hover:bg-blue-600 active:bg-blue-700"
                          >
                            {delivery.type === 'Collection' ? 'Start Collection' : 'Start Delivery'}
                          </button>
                        )}
                        
                        {syncInfo?.status === 'failed' && (
                          <button
                            onClick={() => handleRetrySync(delivery._id)}
                            className="flex-1 bg-red-500 text-white py-2 px-3 rounded-lg text-sm font-medium hover:bg-red-600 active:bg-red-700"
                          >
                            Retry Sync
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
        </div>
      )}

      {activeTab !== 'map' && (
        <div className="p-4 safe-area-bottom">
          {activeTab === 'tasks' && (
          <div className="space-y-3">
            {isLoading && pendingDeliveries.filter(d => d.type === 'Task').length === 0 ? (
              <div className="text-center py-8">
                <RefreshCw className="w-8 h-8 animate-spin mx-auto mb-2 text-gray-400" />
                <p className="text-gray-500">Loading tasks...</p>
              </div>
            ) : pendingDeliveries.filter(d => d.type === 'Task').length === 0 ? (
              <div className="text-center py-8">
                <Package className="w-12 h-12 mx-auto mb-2 text-gray-300" />
                <p className="text-gray-500">No pending tasks</p>
                <p className="text-gray-400 text-sm mt-1">All tasks completed for today!</p>
              </div>
            ) : (
              <div className="space-y-3">
                {pendingDeliveries.filter(d => d.type === 'Task').map((delivery, index) => {
                  const status = getDeliveryStatus(delivery);
                  return (
                    <div
                      key={delivery._id}
                      className={`bg-white rounded-xl shadow-sm p-4 ${
                        status === 'current' ? 'ring-2 ring-purple-500 ring-opacity-50' : ''
                      }`}
                    >
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex-1">
                          <div className="flex items-center space-x-2 mb-1">
                            <h3 className="font-semibold text-gray-900 text-lg">
                              {delivery.customerName || 'Task'}
                            </h3>
                            <span className="px-2 py-1 bg-purple-100 text-purple-700 text-xs font-medium rounded-full">
                              {delivery.taskType || 'Task'}
                            </span>
                          </div>
                          <p className="text-sm text-gray-500 flex items-center">
                            <Clock className="w-4 h-4 mr-1" />
                            {formatTime(delivery.scheduledTime)}
                          </p>
                        </div>
                        {status === 'current' && (
                          <div className="px-3 py-1 bg-purple-100 text-purple-700 text-sm font-medium rounded-full">
                            Current
                          </div>
                        )}
                      </div>

                      {delivery.address && (
                        <p className="text-base font-bold text-gray-900 bg-yellow-100 px-3 py-2 rounded flex items-start mb-3">
                          <MapPin className="w-4 h-4 mr-2 mt-0.5 flex-shrink-0 text-yellow-700" />
                          {delivery.address}
                        </p>
                      )}

                      {delivery.combinedSunday && (
                        <div className="bg-indigo-50 border border-indigo-300 rounded-lg p-2 mb-3">
                          <p className="text-xs text-indigo-900 font-semibold">📦 Sunday's delivery included — bring 2 days' worth.</p>
                        </div>
                      )}

                      {delivery.notes && (
                        <div className="bg-purple-50 border border-purple-200 rounded-lg p-2 mb-3">
                          <p className="text-xs text-purple-800">{delivery.notes}</p>
                        </div>
                      )}

                      <div className="flex space-x-2">
                        {status === 'current' && (
                          <>
                            {delivery.phone && (
                              <button
                                onClick={() => handleCallCustomer(delivery.phone)}
                                className="flex-1 bg-green-500 text-white py-2 px-3 rounded-lg text-sm font-medium hover:bg-green-600 active:bg-green-700"
                              >
                                Call
                              </button>
                            )}
                            <button
                              onClick={() => handleStartDelivery(delivery)}
                              className="flex-1 bg-purple-500 text-white py-2 px-3 rounded-lg text-sm font-medium hover:bg-purple-600 active:bg-purple-700"
                            >
                              Start Task
                            </button>
                          </>
                        )}

                        {status === 'upcoming' && (
                          <button
                            onClick={() => handleStartDelivery(delivery)}
                            className="flex-1 bg-purple-500 text-white py-2 px-3 rounded-lg text-sm font-medium hover:bg-purple-600 active:bg-purple-700"
                          >
                            Start Task
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {activeTab === 'history' && (
          <div className="space-y-4">
            {/* Period Filter */}
            <div className="bg-white rounded-xl shadow-sm p-4">
              <h3 className="font-semibold text-gray-900 mb-3">Delivery History</h3>
              <div className="flex space-x-2">
                <button
                  onClick={() => setHistoryState(prev => ({...prev, period: 'today'}))}
                  className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-colors ${
                    historyState.period === 'today'
                      ? 'bg-green-500 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  Today
                </button>
                <button
                  onClick={() => setHistoryState(prev => ({...prev, period: 'week'}))}
                  className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-colors ${
                    historyState.period === 'week'
                      ? 'bg-green-500 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  Last 7 Days
                </button>
                <button
                  onClick={() => setHistoryState(prev => ({...prev, period: 'month'}))}
                  className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-colors ${
                    historyState.period === 'month'
                      ? 'bg-green-500 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  Last 30 Days
                </button>
              </div>
            </div>

            {/* History List */}
            {historyState.loading ? (
              <div className="text-center py-8">
                <RefreshCw className="w-8 h-8 animate-spin mx-auto mb-2 text-gray-400" />
                <p className="text-gray-500">Loading history...</p>
              </div>
            ) : historyState.deliveries.length === 0 ? (
              <div className="bg-white rounded-xl shadow-sm p-8 text-center">
                <Package className="w-12 h-12 mx-auto mb-2 text-gray-300" />
                <p className="text-gray-500">No completed deliveries found</p>
              </div>
            ) : (
              <div className="space-y-3">
                {(() => {
                  // Group deliveries by date
                  const grouped = {};
                  historyState.deliveries.forEach(delivery => {
                    const dateKey = formatDateOnly(delivery.deliveredTime || delivery.scheduledTime);
                    if (!grouped[dateKey]) {
                      grouped[dateKey] = [];
                    }
                    grouped[dateKey].push(delivery);
                  });

                  return Object.entries(grouped).map(([date, deliveriesForDate]) => (
                    <div key={date}>
                      <div className="sticky top-0 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-700 z-10">
                        {date} ({deliveriesForDate.length})
                      </div>
                      <div className="space-y-2">
                        {deliveriesForDate.map(delivery => (
                          <div
                            key={delivery._id}
                            className="bg-white rounded-lg border border-gray-200 p-3"
                          >
                            <div className="flex items-start justify-between mb-2">
                              <div className="flex-1">
                                <h3 className="font-semibold text-gray-900">
                                  {delivery.customerName}
                                </h3>
                                <p className="text-xs text-gray-500 mt-1">
                                  {delivery.customerId}
                                </p>
                                {/* Show delivery date */}
                                <p className="text-xs text-blue-600 font-medium mt-1">
                                  {formatDateOnly(delivery.deliveredTime || delivery.scheduledTime)}
                                </p>
                              </div>
                              <div className="text-right">
                                <span className="inline-flex items-center px-2 py-1 bg-green-100 text-green-800 text-xs font-medium rounded-full">
                                  <CheckCircle className="w-3 h-3 mr-1" />
                                  Delivered
                                </span>
                              </div>
                            </div>

                            {/* Delivery Date & Time */}
                            <div className="flex items-center justify-between text-xs mb-2 pb-2 border-b border-gray-100">
                              <div className="flex items-center space-x-1 text-gray-600">
                                <Clock className="w-3 h-3" />
                                <span>Scheduled: {formatTime(delivery.scheduledTime)}</span>
                              </div>
                              {delivery.deliveredTime && (
                                <div className="flex items-center space-x-1 text-green-600 font-medium">
                                  <CheckCircle className="w-3 h-3" />
                                  <span>{formatTime(delivery.deliveredTime)}</span>
                                </div>
                              )}
                            </div>

                            <div className="flex items-start space-x-2 text-xs text-gray-600 mb-2">
                              <MapPin className="w-3 h-3 mt-0.5 flex-shrink-0" />
                              <span className="line-clamp-2">{delivery.address}</span>
                            </div>

                            {delivery.company && (
                              <span className="inline-block px-2 py-1 bg-blue-100 text-blue-800 text-xs font-medium rounded">
                                {delivery.company}
                              </span>
                            )}

                            {delivery.lateMinutes > 0 && (
                              <span className="inline-block ml-2 px-2 py-1 bg-red-100 text-red-800 text-xs font-medium rounded">
                                Late: +{delivery.lateMinutes}m
                              </span>
                            )}

                            {delivery.earlyMinutes > 0 && (
                              <span className="inline-block ml-2 px-2 py-1 bg-yellow-100 text-yellow-800 text-xs font-medium rounded">
                                Early: -{delivery.earlyMinutes}m
                              </span>
                            )}

                            {delivery.proof?.images?.length > 0 && (
                              <div className="mt-2 flex items-center text-xs text-green-600">
                                <Camera className="w-3 h-3 mr-1" />
                                {delivery.proof.images.length} photo{delivery.proof.images.length > 1 ? 's' : ''}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ));
                })()}
              </div>
            )}
          </div>
        )}
        </div>
      )}

      {/* Error Display */}
      {error && (
        <div className="fixed bottom-4 left-4 right-4 bg-red-50 border border-red-200 text-red-600 p-3 rounded-lg shadow-lg">
          <div className="flex items-center justify-between">
            <span>{error}</span>
            <button onClick={() => dispatch({ type: 'driverMobile/clearError' })}>
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {!currentDelivery && currentStep === 'delivery' && <BagHandoverPanel />}
      {/* Fixed Return Bag Button - Only show when not in a delivery flow */}
      {!currentDelivery && currentStep === 'delivery' && (
        <button
          onClick={() => {
            setFlowState(prev => ({...prev, isReturningBags: true}));
            setBagState(prev => ({...prev, toReturn: []}));
            setCurrentStep('return_bags_scan');
            startCamera();
          }}
          className="fixed bottom-20 right-4 w-16 h-16 bg-orange-500 hover:bg-orange-600 text-white rounded-full shadow-lg flex items-center justify-center z-40 active:scale-95 transition"
          aria-label="Return Bags"
        >
          <Archive className="w-7 h-7" />
        </button>
      )}

      {/* Side Menu */}
      
        {showMenu && (
          <>
            <div
              className="fixed inset-0 bg-black bg-opacity-50 z-50"
              onClick={() => setShowMenu(false)}
            />
            <div
              className="fixed left-0 top-0 bottom-0 w-80 bg-white z-50 shadow-xl safe-area-left"
            >
              <div className="p-4 border-b border-gray-200">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    <div className="w-12 h-12 bg-blue-500 rounded-full flex items-center justify-center text-white font-semibold">
                      {user?.profile?.firstName?.[0]}{user?.profile?.lastName?.[0]}
                    </div>
                    <div>
                      <h2 className="font-semibold text-gray-900">
                        {user?.profile?.firstName} {user?.profile?.lastName}
                      </h2>
                      <p className="text-sm text-gray-500">Driver</p>
                    </div>
                  </div>
                  <button
                    onClick={() => setShowMenu(false)}
                    className="p-2"
                  >
                    <X className="w-5 h-5 text-gray-500" />
                  </button>
                </div>
              </div>

              <nav className="p-4 space-y-2">
                <button className="w-full flex items-center space-x-3 p-3 text-gray-700 hover:bg-gray-100 rounded-lg text-left">
                  <User className="w-5 h-5" />
                  <span>Profile</span>
                </button>
                <button className="w-full flex items-center space-x-3 p-3 text-gray-700 hover:bg-gray-100 rounded-lg text-left">
                  <BarChart3 className="w-5 h-5" />
                  <span>Performance</span>
                </button>
                <button 
                  onClick={() => {
                    setActiveTab('map');
                    setShowMenu(false);
                  }}
                  className="w-full flex items-center space-x-3 p-3 text-gray-700 hover:bg-gray-100 rounded-lg text-left"
                >
                  <MapPin className="w-5 h-5" />
                  <span>Delivery Map</span>
                </button>
                <button className="w-full flex items-center space-x-3 p-3 text-gray-700 hover:bg-gray-100 rounded-lg text-left">
                  <Bell className="w-5 h-5" />
                  <span>Notifications</span>
                </button>
                
                <div className="border-t border-gray-200 pt-4 mt-4">
                  <button
                    onClick={handleLogout}
                    className="w-full flex items-center space-x-3 p-3 text-red-600 hover:bg-red-50 rounded-lg text-left"
                  >
                    <LogOut className="w-5 h-5" />
                    <span>Log Out</span>
                  </button>
                </div>
              </nav>
            </div>
          </>
        )}
      

      {/* Add CSS for safe areas */}
      <style jsx>{`
        .safe-area-padding {
          padding-left: env(safe-area-inset-left);
          padding-right: env(safe-area-inset-right);
        }
        .safe-area-top {
          padding-top: env(safe-area-inset-top);
        }
        .safe-area-bottom {
          padding-bottom: env(safe-area-inset-bottom);
        }
        .safe-area-left {
          padding-left: env(safe-area-inset-left);
        }
      `}</style>
    </div>
  );
};

export default DriverMobile;





