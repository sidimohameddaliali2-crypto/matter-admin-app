import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { motion } from 'framer-motion';
import {
  Clock,
  User,
  Truck,
  CheckCircle,
  XCircle,
  ArrowDownCircle,
  ArrowUpCircle,
  Timer,
  Archive
} from 'lucide-react';
import { fetchDeliveryById } from '../store/slices/deliverySlice';
import api from '../utils/api';
import UserAvatar from '../components/users/UserAvatar';
import LocationPinPicker from '../components/LocationPinPicker';
import { parseGPSFromLink } from '../utils/gpsParsing';
import {
  formatBusinessDateInput,
  formatBusinessTimeInput,
  formatBusinessTime,
  formatBusinessDateTime,
  businessComponentsToUtcDate
} from '../utils/businessTime';

const API_BASE_URL = (api.defaults.baseURL || '').replace(/\/api\/?$/, '');
const FALLBACK_IMAGE =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MDAiIGhlaWdodD0iMzAwIj48cmVjdCB3aWR0aD0iNDAwIiBoZWlnaHQ9IjMwMCIgZmlsbD0iI2YzZjRmNiIvPjx0ZXh0IHg9IjUwJSIgeT0iNTAlIiBkb21pbmFudC1iYXNlbGluZT0ibWlkZGxlIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSIjOWNhM2FmIiBmb250LWZhbWlseT0iQXJpYWwiIGZvbnQtc2l6ZT0iMTgiPkltYWdlIHVuYXZhaWxhYmxlPC90ZXh0Pjwvc3ZnPg==';

const resolveImageUrl = (imageEntry) => {
  if (!imageEntry) return '';

  let url = imageEntry;
  if (typeof imageEntry === 'object') {
    url = imageEntry.url || imageEntry.path || imageEntry.secureUrl || imageEntry.location || '';
  }

  if (!url) return '';

  const trimmedUrl = url.toString().trim();
  if (!trimmedUrl) return '';

  if (trimmedUrl.startsWith('data:')) {
    return trimmedUrl;
  }

  const preferHttps = (value) => {
    if (!value) return '';
    if (/^https:\/\//i.test(value)) return value;
    if (/^http:\/\//i.test(value)) {
      return value.replace(/^http:\/\//i, 'https://');
    }
    return value;
  };

  if (trimmedUrl.startsWith('//')) {
    return `https:${trimmedUrl}`;
  }

  if (/^https?:\/\//i.test(trimmedUrl)) {
    return preferHttps(trimmedUrl);
  }

  if (trimmedUrl.startsWith('/')) {
    const baseOrigin =
      API_BASE_URL ||
      (typeof window !== 'undefined' && window.location ? window.location.origin : '');
    if (baseOrigin) {
      return preferHttps(`${baseOrigin}${trimmedUrl}`);
    }
    return preferHttps(`https://${trimmedUrl.replace(/^\/+/, '')}`);
  }

  if (API_BASE_URL) {
    try {
      const absoluteFromBase = new URL(trimmedUrl, API_BASE_URL);
      return preferHttps(absoluteFromBase.toString());
    } catch {
      // ignore errors and fall back to original url below
    }
  }

  if (/^[\w.-]+(?::\d+)?(\/.*)?$/i.test(trimmedUrl)) {
    return preferHttps(`https://${trimmedUrl}`);
  }

  return preferHttps(trimmedUrl);
};

const DeliveryDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const dispatch = useDispatch();
  const { currentDelivery, currentDeliveryBags, isLoading, error } = useSelector(state => state.delivery);
  const [actionLoading, setActionLoading] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editForm, setEditForm] = useState({
    customerName: '',
    customerPhone: '',
    address: '',
    company: 'Matter',
    notes: '',
    zone: '',
    date: '',
    time: '',
    gpsLink: '',
    gpsLat: null,
    gpsLng: null
  });
  const [customerLocation, setCustomerLocation] = useState(null);
  const auth = useSelector(state => state.auth);

  const handleBackNavigation = () => {
    const returnTo = location.state?.returnTo;
    if (returnTo) {
      navigate(returnTo);
      return;
    }

    const canGoBack = typeof window !== 'undefined' && window.history.length > 1;
    if (canGoBack) {
      navigate(-1);
    } else {
      navigate('/deliveries');
    }
  };
  
  useEffect(() => {
    if (id) {
      // Log the request attempt
      console.log('Fetching delivery:', id);
      console.log('Auth state:', {
        isAuthenticated: !!auth.token,
        user: auth.user
      });
      dispatch(fetchDeliveryById(id))
        .unwrap()
        .then(response => {
          console.log('Delivery fetch success:', response);
        })
        .catch(error => {
          console.error('Delivery fetch error details:', {
            message: error.message,
            status: error.status,
            data: error.data,
            stack: error.stack,
            originalError: error
          });
        });
    }
  }, [dispatch, id, auth]);

  useEffect(() => {
    if (currentDelivery) {
      // Populate with the fixed business timezone (Dubai), not the viewer's
      // own device timezone — scheduledTime is a business-local time, and
      // showing it in whatever zone the browser happens to be set to is what
      // caused edits to silently save the wrong hour.
      const businessDate = formatBusinessDateInput(currentDelivery.scheduledTime);
      const businessTime = formatBusinessTimeInput(currentDelivery.scheduledTime);
      setEditForm({
        customerName: currentDelivery.customerName || '',
        customerPhone: currentDelivery.customerPhone || '',
        address: currentDelivery.address || '',
        company: currentDelivery.company || 'Matter',
        notes: currentDelivery.notes || '',
        zone: currentDelivery.zone || '',
        date: businessDate,
        time: businessTime,
        gpsLink: currentDelivery.gpsLocation?.link || '',
        gpsLat: Number.isFinite(currentDelivery.gpsLocation?.lat) ? currentDelivery.gpsLocation.lat : null,
        gpsLng: Number.isFinite(currentDelivery.gpsLocation?.lng) ? currentDelivery.gpsLocation.lng : null
      });
    }
  }, [currentDelivery]);

  // For Collections with no address, fetch from customer's last delivery
  useEffect(() => {
    if (
      currentDelivery?.type === 'Collection' &&
      !currentDelivery.address &&
      currentDelivery.customerId
    ) {
      api.get(`/customers/${encodeURIComponent(currentDelivery.customerId)}/location`)
        .then(res => {
          const loc = res?.data?.data;
          if (loc) setCustomerLocation(loc);
        })
        .catch(() => {});
    } else {
      setCustomerLocation(null);
    }
  }, [currentDelivery]);

  // rendering logic moved down to the final return so helper functions can be declared above

  // Format date and time in the fixed business timezone (Dubai) — not the
  // viewer's own device timezone, which can differ from where deliveries
  // actually happen.
  const formatDateTime = formatBusinessDateTime;
  const formatTime = formatBusinessTime;

  const formatStatusLabel = (status) => {
    if (!status) return 'N/A';
    return status
      .toString()
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (char) => char.toUpperCase());
  };

  // Get status color and icon
  const getStatusInfo = (status) => {
    switch (status) {
      case 'delivered':
        return { color: 'text-green-600 bg-green-100', icon: CheckCircle, label: 'Delivered' };
      case 'collected':
        return { color: 'text-teal-600 bg-teal-100', icon: Archive, label: 'Collected' };
      case 'failed':
        return { color: 'text-red-600 bg-red-100', icon: XCircle, label: 'Failed' };
      case 'picked_up':
        return { color: 'text-blue-600 bg-blue-100', icon: Truck, label: 'Picked Up' };
      case 'assigned':
        return { color: 'text-yellow-600 bg-yellow-100', icon: User, label: 'Assigned' };
      case 'pending':
      default:
        return { color: 'text-gray-600 bg-gray-100', icon: Clock, label: 'Pending' };
    }
  };

  const EARLY_WINDOW_MINUTES = 180;

  const formatDuration = (minutes = 0) => {
    const value = Math.abs(Math.round(minutes));
    if (value < 60) {
      return `${value}m`;
    }

    const hours = Math.floor(value / 60);
    const mins = value % 60;
    return `${hours}h:${mins.toString().padStart(2, '0')}m`;
  };

  const pluralizeMinutes = (value = 0) => {
    return formatDuration(value);
  };

  const getTimingStatus = (delivery) => {
    if (!delivery) return null;

    const scheduled = delivery.scheduledTime ? new Date(delivery.scheduledTime) : null;
    const delivered = delivery.deliveredTime ? new Date(delivery.deliveredTime) : null;

    let deliveryType = delivery.deliveryType || delivery.status;
    let earlyMinutes = delivery.earlyMinutes ?? 0;
    let lateMinutes = delivery.lateMinutes ?? 0;

    if (scheduled && delivered && !Number.isNaN(scheduled.getTime()) && !Number.isNaN(delivered.getTime())) {
      const earlyCutoff = new Date(scheduled.getTime() - EARLY_WINDOW_MINUTES * 60 * 1000);
      const computedEarlyMinutes = delivered < earlyCutoff
        ? Math.max(0, Math.round((earlyCutoff - delivered) / (1000 * 60)))
        : 0;
      const diffMinutes = Math.round((delivered - scheduled) / (1000 * 60));
      const computedLateMinutes = diffMinutes > 0 ? diffMinutes : 0;

      earlyMinutes = computedEarlyMinutes;
      lateMinutes = computedLateMinutes;

      if (computedLateMinutes > 0) {
        deliveryType = 'late';
      } else if (computedEarlyMinutes > 0) {
        deliveryType = 'early';
      } else {
        deliveryType = 'on-time';
      }
    } else if (!deliveryType) {
      deliveryType = 'pending';
    }

    if (deliveryType === 'early') {
      return {
        icon: ArrowDownCircle,
        label: 'Early Delivery',
        description: `Arrived ${formatDuration(earlyMinutes)} before the window opened`,
        containerClass: 'border border-yellow-200 bg-yellow-50 text-yellow-900',
        iconClass: 'text-yellow-600',
        descriptionClass: 'text-yellow-800'
      };
    }

    if (deliveryType === 'late') {
      return {
        icon: ArrowUpCircle,
        label: 'Late Delivery',
        description: `Arrived ${formatDuration(lateMinutes)} after the scheduled time`,
        containerClass: 'border border-red-200 bg-red-50 text-red-900',
        iconClass: 'text-red-600',
        descriptionClass: 'text-red-800'
      };
    }

    if (deliveryType === 'on-time' || deliveryType === 'delivered') {
      return {
        icon: Timer,
        label: delivered ? 'On-Time Delivery' : 'On Schedule',
        description: delivered
          ? 'Delivery completed within the scheduled window'
          : 'No timing variance recorded yet',
        containerClass: 'border border-green-200 bg-green-50 text-green-900',
        iconClass: 'text-green-600',
        descriptionClass: 'text-green-800'
      };
    }

    return {
      icon: Clock,
      label: 'Timing Pending',
      description: 'Waiting for delivery completion to calculate timing',
      containerClass: 'border border-gray-200 bg-gray-50 text-gray-800',
      iconClass: 'text-gray-500',
      descriptionClass: 'text-gray-600'
    };
  };

  // Early UI guards
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-lg">Loading delivery details...</div>
      </div>
    );
  }

  if (!currentDelivery) {
    return (
      <div className="flex flex-col items-center justify-center h-64 space-y-4">
        <div className="text-lg text-red-600">{error || 'Delivery not found'}</div>
        <button
          onClick={() => dispatch(fetchDeliveryById(id))}
          className="px-4 py-2 text-sm bg-blue-500 text-white rounded hover:bg-blue-600"
        >
          Try Again
        </button>
      </div>
    );
  }

  const statusInfo = getStatusInfo(currentDelivery?.status);
  const timingStatus = getTimingStatus(currentDelivery);
  const TimingIcon = timingStatus?.icon;

  const shipmentIdLabel = `${currentDelivery.type === 'Collection' ? 'Collection' : 'Shipment'} ID: ${(currentDelivery._id || '').slice(-8).toUpperCase()}`;
  const gpsLat = currentDelivery.gpsLocation?.lat ?? customerLocation?.gpsLocation?.lat;
  const gpsLng = currentDelivery.gpsLocation?.lng ?? customerLocation?.gpsLocation?.lng;
  const gpsLink = currentDelivery.gpsLocation?.link || customerLocation?.gpsLocation?.link;
  const associatedBagIds = (currentDeliveryBags && currentDeliveryBags.length > 0)
    ? currentDeliveryBags.map((bag) => bag.bagId).filter(Boolean)
    : [
        ...(currentDelivery.bagAssignment?.bagId ? [currentDelivery.bagAssignment.bagId] : []),
        ...(currentDelivery.collectionDetails?.bagIds || []),
      ];

  const handleShare = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      alert('Link copied to clipboard');
    } catch {
      alert(window.location.href);
    }
  };

  return (
    <div className="matter-analytics p-4 sm:p-6 max-w-7xl mx-auto w-full">
      {/* Sub-header */}
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={handleBackNavigation}
          className="p-2 hover:bg-gray-100 rounded-lg text-gray-600 transition-colors flex items-center justify-center"
        >
          <span className="material-symbols-outlined">arrow_back</span>
        </button>
        <div className="flex items-center gap-2">
          <button onClick={() => window.print()} title="Print" className="p-2 text-gray-500 hover:bg-gray-100 rounded transition-colors flex items-center justify-center">
            <span className="material-symbols-outlined">print</span>
          </button>
          <button onClick={handleShare} title="Share" className="p-2 text-gray-500 hover:bg-gray-100 rounded transition-colors flex items-center justify-center">
            <span className="material-symbols-outlined">share</span>
          </button>
          <button
            onClick={() => {
              if (!['admin','super_admin','dispatcher','manager'].includes(auth.user?.role)) {
                alert('You do not have permission to edit deliveries.');
                return;
              }
              setShowEditModal(true);
            }}
            disabled={currentDelivery.status === 'delivered'}
            title={currentDelivery.status === 'delivered' ? 'Delivered deliveries cannot be edited' : undefined}
            className="px-4 py-2 border border-gray-200 rounded text-sm font-medium text-gray-900 hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-white"
          >
            Edit
          </button>
        </div>
      </div>

      {/* Page header (desktop only — covered by the mobile Header Status card below) */}
      <div className="hidden lg:flex mb-6 flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1 text-gray-500">
            <span className="text-xs font-semibold uppercase tracking-wider">{shipmentIdLabel}</span>
            <span className="w-1 h-1 rounded-full bg-gray-300" />
            <span className="text-xs">{formatDateTime(currentDelivery.scheduledTime)}</span>
          </div>
          <h1 className="text-2xl font-semibold text-gray-900">Delivery Details</h1>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {timingStatus && timingStatus.label !== 'Timing Pending' && (
            <div className={`px-3 py-1.5 rounded-full flex items-center gap-1.5 border ${timingStatus.containerClass}`}>
              {TimingIcon && <TimingIcon className={`w-4 h-4 ${timingStatus.iconClass}`} />}
              <span className="text-xs font-bold">{timingStatus.label}</span>
            </div>
          )}
          <span className={`px-3 py-1.5 rounded-full text-xs font-bold flex items-center gap-1.5 ${statusInfo.color}`}>
            {statusInfo.icon && <statusInfo.icon className="w-4 h-4" />}
            {statusInfo.label}
          </span>
        </div>
      </div>

      {/* Mobile-only single-column layout, matching the mobile Delivery Details design */}
      <div className="flex flex-col gap-3 lg:hidden">
        {/* Header Status Card */}
        <div className="bg-white border border-gray-200 rounded-xl p-4 flex flex-col gap-3">
          <div className="flex justify-end items-start">
            <span className={`px-2.5 py-1 rounded-full text-xs font-bold flex items-center gap-1.5 ${statusInfo.color}`}>
              {statusInfo.icon && <statusInfo.icon className="w-3.5 h-3.5" />}
              {statusInfo.label}
            </span>
          </div>
          <div className="h-px bg-gray-100 w-full" />
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[10px] text-gray-400 uppercase tracking-wider">Performance</p>
              <p className={`text-sm font-medium truncate ${timingStatus?.descriptionClass || 'text-gray-600'}`}>{timingStatus?.label || 'Timing Pending'}</p>
            </div>
            <div className="text-right min-w-0">
              <p className="text-[10px] text-gray-400 uppercase tracking-wider">Type</p>
              <p className="text-sm font-medium text-gray-900 capitalize truncate">{currentDelivery.type}</p>
            </div>
          </div>
        </div>

        {/* Recipient Details Card */}
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3 text-gray-400">
            <span className="material-symbols-outlined text-[20px]">person</span>
            <h2 className="text-[11px] font-semibold uppercase tracking-wider">Recipient Details</h2>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-gray-400">Customer</p>
              <p className="text-sm font-medium text-gray-900">{currentDelivery.customerName}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400">Company</p>
              <p className="text-sm font-medium text-gray-900">{currentDelivery.company || '—'}</p>
            </div>
            {currentDelivery.combinedSunday && (
              <div className="col-span-2 flex items-start gap-2 bg-indigo-50 border border-indigo-200 rounded-lg p-2.5">
                <Archive className="w-4 h-4 text-indigo-500 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-indigo-900">
                  Sunday's delivery is included with this one — no separate Sunday trip needed for this customer.
                </p>
              </div>
            )}
            {currentDelivery.combinedIntoSaturday && (
              <div className="col-span-2 flex items-start gap-2 bg-indigo-50 border border-indigo-200 rounded-lg p-2.5">
                <Archive className="w-4 h-4 text-indigo-500 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-indigo-900">
                  This was already delivered as part of Saturday's route — it won't appear in Sunday's lists separately.
                </p>
              </div>
            )}
            {currentDelivery.sundayOnlyCarriedOver && (
              <div className="col-span-2 flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg p-2.5">
                <Archive className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-amber-900">
                  This customer only has a Sunday meal — delivered together with Saturday's route since there's no separate Sunday route.
                </p>
              </div>
            )}
            {currentDelivery.notes && (
              <div className="col-span-2">
                <p className="text-xs text-gray-400">Notes</p>
                <p className="text-sm bg-gray-50 p-2 rounded-md mt-1 text-gray-700">{currentDelivery.notes}</p>
              </div>
            )}
            {associatedBagIds.length > 0 && (
              <div className="col-span-2">
                <p className="text-xs text-gray-400 mb-1.5">Associated Bags</p>
                <div className="flex flex-wrap gap-1.5">
                  {associatedBagIds.map((bagId, i) => (
                    <span key={`${bagId}-${i}`} className="px-2 py-0.5 bg-gray-50 border border-gray-200 rounded font-mono text-xs text-gray-700">{bagId}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Destination & Timing Card */}
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3 text-gray-400">
            <span className="material-symbols-outlined text-[20px]">location_on</span>
            <h2 className="text-[11px] font-semibold uppercase tracking-wider">Destination &amp; Timing</h2>
          </div>
          <div className="flex flex-col gap-4">
            <div>
              <p className="text-xs text-gray-400">{currentDelivery.type === 'Collection' ? 'Collection Address' : 'Address'}</p>
              <p className="text-sm font-medium text-gray-900 leading-snug mt-0.5">
                {currentDelivery.address || customerLocation?.address || <span className="text-gray-400 italic font-normal">Not specified</span>}
              </p>
              {currentDelivery.zone && <p className="text-xs text-gray-400 mt-1">Zone: {currentDelivery.zone}</p>}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="border-l-2 border-gray-200 pl-3">
                <p className="text-xs text-gray-400">Scheduled</p>
                <p className="text-sm text-gray-700">{formatTime(currentDelivery.scheduledTime)}</p>
              </div>
              {currentDelivery.deliveredTime && (
                <div className="border-l-2 border-blue-600 bg-blue-50/50 rounded-r-md pl-3 py-1">
                  <p className="text-xs text-blue-600 font-medium">Actual</p>
                  <p className="text-sm font-semibold text-blue-700">{formatTime(currentDelivery.deliveredTime)}</p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Driver Assigned Card */}
        {currentDelivery.driver && (
          <div className="bg-white border border-gray-200 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3 text-gray-400">
              <span className="material-symbols-outlined text-[20px]">badge</span>
              <h2 className="text-[11px] font-semibold uppercase tracking-wider">Driver Assigned</h2>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3 min-w-0">
                <UserAvatar
                  user={currentDelivery.driver}
                  sizePx={48}
                  showStatus
                  fallbackName={`${currentDelivery.driver.profile?.firstName || 'Driver'} ${currentDelivery.driver.profile?.lastName || ''}`.trim() || 'Assigned Driver'}
                  fallbackEmail={currentDelivery.driver.email || 'driver@matter.app'}
                />
                <div className="min-w-0">
                  <p className="font-semibold text-gray-900 truncate">
                    {currentDelivery.driver.profile?.firstName} {currentDelivery.driver.profile?.lastName}
                  </p>
                  <p className="text-xs text-gray-400 truncate">
                    {currentDelivery.driver.profile?.status || 'offline'}
                    {currentDelivery.driver.profile?.vehicleType && ` · ${currentDelivery.driver.profile.vehicleType}`}
                  </p>
                </div>
              </div>
              {currentDelivery.driver.profile?.phone && (
                <a
                  href={`tel:${currentDelivery.driver.profile.phone}`}
                  className="flex-shrink-0 bg-blue-50 text-blue-600 hover:bg-blue-100 p-2 rounded-full transition-colors flex items-center justify-center"
                >
                  <span className="material-symbols-outlined text-[20px]">call</span>
                </a>
              )}
            </div>
          </div>
        )}

        {/* Tracking Timeline Card */}
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-4 text-gray-400">
            <span className="material-symbols-outlined text-[20px]">timeline</span>
            <h2 className="text-[11px] font-semibold uppercase tracking-wider">Tracking Timeline</h2>
          </div>
          {currentDelivery.timeline && currentDelivery.timeline.length > 0 ? (
            <div className="relative pl-6 flex flex-col gap-5 before:content-[''] before:absolute before:left-[11px] before:top-2 before:bottom-2 before:w-[2px] before:bg-gray-100">
              {currentDelivery.timeline.map((event, index) => {
                const isLast = index === currentDelivery.timeline.length - 1;
                const isFinal = isLast && ['delivered', 'collected', 'failed'].includes(event.status);
                return (
                  <div key={index} className="relative">
                    <div className={`absolute -left-6 top-0 w-6 h-6 rounded-full flex items-center justify-center z-10 ${isFinal ? 'bg-white border-2 border-blue-600' : 'bg-white border-2 border-gray-200'}`}>
                      <div className={`w-2 h-2 rounded-full ${isFinal ? 'bg-blue-600' : 'bg-gray-300'}`} />
                    </div>
                    <p className={`text-sm text-gray-900 capitalize ${isFinal ? 'font-semibold' : 'font-medium'}`}>{event.status.replace('_', ' ')}</p>
                    {event.notes && <p className="text-sm text-gray-500 mt-0.5">{event.notes}</p>}
                    <p className="text-xs text-gray-400 mt-0.5">{formatDateTime(event.timestamp)}</p>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-6 text-gray-400">
              <span className="material-symbols-outlined text-[32px] mb-1 block">timeline</span>
              <div className="text-sm">No timeline events recorded</div>
            </div>
          )}
        </div>

        {/* Location Card */}
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden flex flex-col h-[280px]">
          <div className="p-3 border-b border-gray-100 flex justify-between items-center flex-shrink-0">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">Delivery Location</h2>
            {gpsLink && (
              <a href={gpsLink} target="_blank" rel="noopener noreferrer" className="text-blue-600 text-xs font-medium hover:underline flex items-center gap-1">
                <span className="material-symbols-outlined text-[14px]">open_in_new</span> Open
              </a>
            )}
          </div>
          <div className="relative flex-1 bg-gray-50">
            {gpsLat && gpsLng ? (
              <iframe
                title="Delivery location map (mobile)"
                className="absolute inset-0 w-full h-full border-0"
                src={`https://www.google.com/maps?q=${gpsLat},${gpsLng}&output=embed`}
                loading="lazy"
              />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-400 gap-1">
                <span className="material-symbols-outlined text-[32px]">location_off</span>
                <p className="text-xs">No GPS location recorded</p>
              </div>
            )}
          </div>
        </div>

        {/* Proof of Delivery Card */}
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 text-gray-400">
              <span className="material-symbols-outlined text-[20px]">photo_camera</span>
              <h2 className="text-[11px] font-semibold uppercase tracking-wider">Proof of Delivery</h2>
            </div>
            {(currentDelivery?.proof?.images?.length > 0) && (
              <span className="text-xs bg-gray-50 px-2 py-1 rounded-md text-gray-500">{currentDelivery.proof.images.length} Files</span>
            )}
          </div>
          {currentDelivery?.proof?.location?.lat != null && (
            <div className="mb-3 text-sm text-gray-700" data-testid="proof-dropoff-location">
              <span className="text-xs text-gray-400 block">Dropped off at (driver's phone)</span>
              {currentDelivery.proof.location.address || 'Address not available'}
              <a
                href={`https://www.google.com/maps?q=${currentDelivery.proof.location.lat},${currentDelivery.proof.location.lng}`}
                target="_blank"
                rel="noreferrer"
                className="ml-2 text-blue-600 hover:underline"
              >
                Map
              </a>
            </div>
          )}
          {currentDelivery?.proof?.images?.length > 0 || currentDelivery?.proof?.photoUrl ? (
            <div className="grid grid-cols-2 gap-3">
              {(currentDelivery?.proof?.images || (currentDelivery?.proof?.photoUrl ? [currentDelivery.proof.photoUrl] : [])).map((imageEntry, index) => {
                const resolvedUrl = resolveImageUrl(imageEntry);
                if (!resolvedUrl) {
                  return (
                    <div key={`proof-m-${index}`} className="aspect-square rounded-lg border border-dashed border-gray-200 flex items-center justify-center text-xs text-gray-400">
                      Unable to load image
                    </div>
                  );
                }
                return (
                  <a
                    key={`proof-m-${index}`}
                    href={resolvedUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="aspect-square bg-gray-50 rounded-lg border border-gray-200 overflow-hidden relative"
                  >
                    <img
                      src={resolvedUrl}
                      alt={`Delivery proof ${index + 1}`}
                      className="w-full h-full object-cover"
                      referrerPolicy="no-referrer"
                      onError={(event) => { event.currentTarget.src = FALLBACK_IMAGE; }}
                    />
                  </a>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-6 text-gray-400">
              <span className="material-symbols-outlined text-[32px] mb-1 block">image</span>
              <div className="text-sm">No proof of delivery uploaded</div>
            </div>
          )}
        </div>
      </div>

      {/* Desktop two-column layout */}
      <div className="hidden lg:grid lg:grid-cols-12 lg:gap-4">
        {/* Left Column */}
        <div className="col-span-12 lg:col-span-8 flex flex-col gap-4">
          {/* Core Information Card */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-white border border-gray-200 rounded-lg p-5"
          >
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <div>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4">Recipient Info</h3>
                <div className="space-y-4">
                  <div>
                    <p className="text-xs text-gray-500 mb-1">Customer</p>
                    <p className="text-base text-gray-900 font-medium">{currentDelivery.customerName}</p>
                    <p className="text-xs font-mono text-gray-500">{currentDelivery.customerId}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500 mb-1">Company</p>
                    <p className="text-sm text-gray-900">{currentDelivery.company}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500 mb-1">Delivery Type</p>
                    <p className="text-sm text-gray-900 capitalize">{currentDelivery.type}</p>
                  </div>
                  {currentDelivery.combinedSunday && (
                    <div className="flex items-start gap-2 bg-indigo-50 border border-indigo-200 rounded-lg p-2.5">
                      <Archive className="w-4 h-4 text-indigo-500 flex-shrink-0 mt-0.5" />
                      <p className="text-sm text-indigo-900">
                        Sunday's delivery is included with this one — no separate Sunday trip needed for this customer.
                      </p>
                    </div>
                  )}
                  {currentDelivery.combinedIntoSaturday && (
                    <div className="flex items-start gap-2 bg-indigo-50 border border-indigo-200 rounded-lg p-2.5">
                      <Archive className="w-4 h-4 text-indigo-500 flex-shrink-0 mt-0.5" />
                      <p className="text-sm text-indigo-900">
                        This was already delivered as part of Saturday's route — it won't appear in Sunday's lists separately.
                      </p>
                    </div>
                  )}
                  {currentDelivery.sundayOnlyCarriedOver && (
                    <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg p-2.5">
                      <Archive className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                      <p className="text-sm text-amber-900">
                        This customer only has a Sunday meal — delivered together with Saturday's route since there's no separate Sunday route.
                      </p>
                    </div>
                  )}
                </div>
              </div>
              <div>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4">Timing &amp; Location</h3>
                <div className="space-y-4">
                  <div className="flex gap-6">
                    <div>
                      <p className="text-xs text-gray-500 mb-1">Scheduled</p>
                      <p className="text-sm font-mono text-gray-900">{formatTime(currentDelivery.scheduledTime)}</p>
                    </div>
                    {currentDelivery.deliveredTime && (
                      <div>
                        <p className="text-xs text-gray-500 mb-1">Actual</p>
                        <p className="text-sm font-mono text-gray-900 font-bold">{formatTime(currentDelivery.deliveredTime)}</p>
                      </div>
                    )}
                  </div>
                  <div>
                    <p className="text-xs text-gray-500 mb-1">Zone</p>
                    <p className="text-sm text-gray-900">{currentDelivery.zone || customerLocation?.zone || 'Not specified'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500 mb-1">
                      {currentDelivery.type === 'Collection' ? 'Collection Address' : 'Delivery Address'}
                    </p>
                    <p className="text-sm text-gray-900 leading-tight">
                      {currentDelivery.address || customerLocation?.address || <span className="text-gray-400 italic">Not specified</span>}
                    </p>
                    {!currentDelivery.address && customerLocation?.address && (
                      <p className="text-xs text-gray-400 mt-1">From customer's last delivery</p>
                    )}
                    {currentDelivery.addressDetails && (
                      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                        {currentDelivery.addressDetails.locationType && (
                          <><dt className="text-gray-500">Type</dt><dd className="text-gray-800">{currentDelivery.addressDetails.locationType}</dd></>
                        )}
                        {currentDelivery.addressDetails.city && (
                          <><dt className="text-gray-500">City</dt><dd className="text-gray-800">{currentDelivery.addressDetails.city}</dd></>
                        )}
                        {currentDelivery.addressDetails.area && (
                          <><dt className="text-gray-500">Area</dt><dd className="text-gray-800">{currentDelivery.addressDetails.area}</dd></>
                        )}
                        {currentDelivery.addressDetails.street && (
                          <><dt className="text-gray-500">Street</dt><dd className="text-gray-800">{currentDelivery.addressDetails.street}</dd></>
                        )}
                        {currentDelivery.addressDetails.building && (
                          <><dt className="text-gray-500">Building</dt><dd className="text-gray-800">{currentDelivery.addressDetails.building}</dd></>
                        )}
                        {currentDelivery.addressDetails.floor && currentDelivery.addressDetails.floor !== '0' && (
                          <><dt className="text-gray-500">Floor</dt><dd className="text-gray-800">{currentDelivery.addressDetails.floor}</dd></>
                        )}
                        {currentDelivery.addressDetails.apartment && (
                          <><dt className="text-gray-500">Apartment</dt><dd className="text-gray-800">{currentDelivery.addressDetails.apartment}</dd></>
                        )}
                      </dl>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {currentDelivery.notes && (
              <div className="mt-4 pt-4 border-t border-gray-100">
                <p className="text-xs text-gray-500 mb-1">Notes</p>
                <p className="text-sm text-gray-900">{currentDelivery.notes}</p>
              </div>
            )}

            {associatedBagIds.length > 0 && (
              <div className="mt-6 pt-4 border-t border-gray-100">
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Associated Bags</h3>
                <div className="flex flex-wrap gap-2">
                  {associatedBagIds.map((bagId, i) => (
                    <span key={`${bagId}-${i}`} className="px-3 py-1 bg-gray-50 border border-gray-200 rounded font-mono text-xs text-gray-700 flex items-center gap-2">
                      <span className="material-symbols-outlined text-[14px]">work</span> {bagId}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </motion.div>

          {/* Map Card */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05 }}
            className="bg-white border border-gray-200 rounded-lg overflow-hidden flex flex-col h-[360px]"
          >
            <div className="p-4 border-b border-gray-100 flex justify-between items-center flex-shrink-0">
              <h3 className="text-lg font-semibold text-gray-900">Delivery Location</h3>
              {gpsLink && (
                <a href={gpsLink} target="_blank" rel="noopener noreferrer" className="text-blue-600 text-sm font-medium hover:underline flex items-center gap-1">
                  <span className="material-symbols-outlined text-[16px]">open_in_new</span> Open in Maps
                </a>
              )}
            </div>
            <div className="relative flex-1 bg-gray-50">
              {gpsLat && gpsLng ? (
                <iframe
                  title="Delivery location map"
                  className="absolute inset-0 w-full h-full border-0"
                  src={`https://www.google.com/maps?q=${gpsLat},${gpsLng}&output=embed`}
                  loading="lazy"
                />
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-400 gap-2">
                  <span className="material-symbols-outlined text-[40px]">location_off</span>
                  <p className="text-sm">No GPS location recorded</p>
                </div>
              )}
            </div>
          </motion.div>

          {/* Collection Details Card — shown only for Collection type */}
          {currentDelivery.type === 'Collection' && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.18 }}
              className="bg-white border border-teal-200 rounded-lg p-5"
            >
              <h2 className="text-lg font-semibold text-teal-800 mb-4 flex items-center gap-2">
                <Archive className="w-5 h-5 text-teal-600" />
                Collection Details
              </h2>

              {/* Bag IDs */}
              <div className="mb-4">
                <p className="text-sm font-medium text-gray-700 mb-2">Bags to Collect</p>
                {currentDelivery.collectionDetails?.bagIds?.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {currentDelivery.collectionDetails.bagIds.map((bagId, i) => (
                      <span key={i} className="px-3 py-1 bg-teal-50 border border-teal-200 text-teal-800 text-sm font-mono rounded-full">
                        {bagId}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-gray-400 text-sm">No bag IDs specified</p>
                )}
              </div>

              {/* Location */}
              {(currentDelivery.address || currentDelivery.zone || customerLocation) && (
                <div className="mb-4 border-t border-teal-100 pt-4">
                  <p className="text-sm font-medium text-gray-700 mb-2">
                    Collection Location
                    {!currentDelivery.address && customerLocation?.address && (
                      <span className="ml-2 text-xs font-normal text-gray-400">(from customer's last delivery)</span>
                    )}
                  </p>
                  {(currentDelivery.address || customerLocation?.address) && (
                    <p className="text-sm text-gray-700 mb-1">{currentDelivery.address || customerLocation?.address}</p>
                  )}
                  {currentDelivery.addressDetails && (
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs mt-1 mb-1">
                      {currentDelivery.addressDetails.locationType && (
                        <><dt className="text-gray-500">Type</dt><dd className="text-gray-700">{currentDelivery.addressDetails.locationType}</dd></>
                      )}
                      {currentDelivery.addressDetails.city && (
                        <><dt className="text-gray-500">City</dt><dd className="text-gray-700">{currentDelivery.addressDetails.city}</dd></>
                      )}
                      {currentDelivery.addressDetails.area && (
                        <><dt className="text-gray-500">Area</dt><dd className="text-gray-700">{currentDelivery.addressDetails.area}</dd></>
                      )}
                      {currentDelivery.addressDetails.street && (
                        <><dt className="text-gray-500">Street</dt><dd className="text-gray-700">{currentDelivery.addressDetails.street}</dd></>
                      )}
                      {currentDelivery.addressDetails.building && (
                        <><dt className="text-gray-500">Building</dt><dd className="text-gray-700">{currentDelivery.addressDetails.building}</dd></>
                      )}
                      {currentDelivery.addressDetails.floor && currentDelivery.addressDetails.floor !== '0' && (
                        <><dt className="text-gray-500">Floor</dt><dd className="text-gray-700">{currentDelivery.addressDetails.floor}</dd></>
                      )}
                      {currentDelivery.addressDetails.apartment && (
                        <><dt className="text-gray-500">Apt</dt><dd className="text-gray-700">{currentDelivery.addressDetails.apartment}</dd></>
                      )}
                    </dl>
                  )}
                  {(currentDelivery.zone || customerLocation?.zone) && (
                    <p className="text-xs text-gray-500 mb-1">Zone: {currentDelivery.zone || customerLocation?.zone}</p>
                  )}
                  {(currentDelivery.gpsLocation?.link || customerLocation?.gpsLocation?.link) && (
                    <a
                      href={currentDelivery.gpsLocation?.link || customerLocation?.gpsLocation?.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-teal-600 hover:underline"
                    >
                      📍 View on map
                    </a>
                  )}
                  {(currentDelivery.gpsLocation?.lat || customerLocation?.gpsLocation?.lat) && (
                    <p className="text-xs text-gray-400 mt-1">
                      {Number(currentDelivery.gpsLocation?.lat || customerLocation?.gpsLocation?.lat).toFixed(6)},{' '}
                      {Number(currentDelivery.gpsLocation?.lng || customerLocation?.gpsLocation?.lng).toFixed(6)}
                    </p>
                  )}
                </div>
              )}

              {currentDelivery.collectionDetails?.noBagsAvailable && (
                <div className="mb-4 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2">
                  <p className="text-sm text-orange-800 flex items-center gap-2">
                    <XCircle className="w-4 h-4" />
                    No bags were available at this location.
                  </p>
                </div>
              )}

              {/* Collection status and photo */}
              {currentDelivery.status === 'collected' && currentDelivery.collectionDetails?.collectedAt && (
                <div className="mt-4 space-y-3">
                  <div>
                    <p className="text-sm font-medium text-gray-700">Collected At</p>
                    <p className="text-gray-900 flex items-center gap-2 mt-1">
                      <CheckCircle className="w-4 h-4 text-teal-600" />
                      {formatDateTime(currentDelivery.collectionDetails.collectedAt)}
                    </p>
                  </div>
                  {currentDelivery.collectionDetails?.collectedPhotoUrl && (
                    <div>
                      <p className="text-sm font-medium text-gray-700 mb-2">Collection Photo</p>
                      <img
                        src={resolveImageUrl(currentDelivery.collectionDetails.collectedPhotoUrl)}
                        alt="Collection proof"
                        className="w-full max-w-xs h-48 object-cover rounded-lg border border-gray-200"
                        referrerPolicy="no-referrer"
                        onError={e => {
                          if (!e.currentTarget.dataset.fallbackAttempted) {
                            e.currentTarget.dataset.fallbackAttempted = 'true';
                            e.currentTarget.src = FALLBACK_IMAGE;
                          }
                        }}
                      />
                    </div>
                  )}
                </div>
              )}
            </motion.div>
          )}

          {/* Proof of Delivery Card */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="bg-white border border-gray-200 rounded-lg p-5"
          >
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Proof of Delivery</h3>

            {currentDelivery?.proof?.location?.lat != null && (
              <div className="mb-3 text-sm text-gray-700" data-testid="proof-dropoff-location">
                <span className="text-xs text-gray-400 block">Dropped off at (driver's phone)</span>
                {currentDelivery.proof.location.address || 'Address not available'}
                <a
                  href={`https://www.google.com/maps?q=${currentDelivery.proof.location.lat},${currentDelivery.proof.location.lng}`}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-2 text-blue-600 hover:underline"
                >
                  Map
                </a>
              </div>
            )}

            {currentDelivery?.proof?.images?.length > 0 || currentDelivery?.proof?.photoUrl ? (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {(currentDelivery?.proof?.images || (currentDelivery?.proof?.photoUrl ? [currentDelivery.proof.photoUrl] : [])).map((imageEntry, index) => {
                  const resolvedUrl = resolveImageUrl(imageEntry);
                  if (!resolvedUrl) {
                    return (
                      <div
                        key={`proof-${index}`}
                        className="aspect-square rounded border border-dashed border-gray-200 flex items-center justify-center text-xs text-gray-400"
                      >
                        Unable to load image
                      </div>
                    );
                  }

                  const originalUrl =
                    typeof imageEntry === 'string'
                      ? imageEntry
                      : imageEntry?.url || imageEntry?.path || imageEntry?.location || resolvedUrl;
                  const fallbackUrl = originalUrl ? resolveImageUrl(originalUrl) : '';
                  const fullSizeUrl = fallbackUrl || resolvedUrl;

                  return (
                    <a
                      key={`proof-${index}`}
                      href={fullSizeUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="aspect-square bg-gray-50 rounded border border-gray-200 overflow-hidden relative group"
                    >
                      <img
                        src={resolvedUrl}
                        alt={`Delivery proof ${index + 1}`}
                        className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                        referrerPolicy="no-referrer"
                        onError={event => {
                          const el = event.currentTarget;
                          if (!el.dataset.fallbackAttempted && fallbackUrl && fallbackUrl !== resolvedUrl) {
                            el.dataset.fallbackAttempted = 'true';
                            el.src = fallbackUrl;
                          } else {
                            el.src = FALLBACK_IMAGE;
                          }
                        }}
                      />
                      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center">
                        <span className="material-symbols-outlined text-white opacity-0 group-hover:opacity-100 drop-shadow-md">zoom_in</span>
                      </div>
                    </a>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-8 text-gray-400">
                <span className="material-symbols-outlined text-[40px] mb-2 block">image</span>
                <div className="text-sm">No proof of delivery uploaded</div>
              </div>
            )}
          </motion.div>
        </div>

        {/* Right Column */}
        <div className="col-span-12 lg:col-span-4 flex flex-col gap-4">
          {/* Driver Assigned Card */}
          {currentDelivery.driver && (
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              className="bg-white border border-gray-200 rounded-lg p-5"
            >
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4">Driver Assigned</h3>
              <div className="flex items-center gap-4 mb-4">
                <UserAvatar
                  user={currentDelivery.driver}
                  sizePx={48}
                  showStatus
                  fallbackName={`${currentDelivery.driver.profile?.firstName || 'Driver'} ${currentDelivery.driver.profile?.lastName || ''}`.trim() || 'Assigned Driver'}
                  fallbackEmail={currentDelivery.driver.email || 'driver@matter.app'}
                />
                <div>
                  <p className="text-lg font-semibold text-gray-900">
                    {currentDelivery.driver.profile?.firstName} {currentDelivery.driver.profile?.lastName}
                  </p>
                  <span className={`inline-block px-2 py-0.5 text-xs font-medium rounded-full mt-0.5 ${
                    currentDelivery.driver.profile?.status === 'available' ? 'bg-emerald-50 text-emerald-700' :
                    currentDelivery.driver.profile?.status === 'busy' ? 'bg-amber-50 text-amber-700' :
                    'bg-gray-100 text-gray-700'
                  }`}>
                    {currentDelivery.driver.profile?.status || 'offline'}
                  </span>
                </div>
              </div>

              <div className="space-y-2 mb-4 border-t border-gray-100 pt-3">
                {currentDelivery.driver.profile?.phone && (
                  <div className="flex justify-between items-center text-sm">
                    <span className="text-gray-500">Phone</span>
                    <span className="text-gray-900 font-mono font-medium">{currentDelivery.driver.profile.phone}</span>
                  </div>
                )}
                {currentDelivery.driver.email && (
                  <div className="flex justify-between items-center text-sm">
                    <span className="text-gray-500">Email</span>
                    <span className="text-gray-900 font-medium truncate ml-2">{currentDelivery.driver.email}</span>
                  </div>
                )}
              </div>

              {currentDelivery.driver.kpi && (
                <div className="grid grid-cols-2 gap-2 mb-4 border-t border-gray-100 pt-3">
                  <div className="text-center p-2 bg-blue-50 rounded">
                    <div className="text-sm font-semibold text-blue-600">{currentDelivery.driver.kpi.accuracyRate}%</div>
                    <div className="text-[11px] text-gray-500">Accuracy</div>
                  </div>
                  <div className="text-center p-2 bg-amber-50 rounded">
                    <div className="text-sm font-semibold text-amber-600">{currentDelivery.driver.kpi.avgLateTime}m</div>
                    <div className="text-[11px] text-gray-500">Avg Late</div>
                  </div>
                </div>
              )}

              {currentDelivery.driver.profile?.phone && (
                <a
                  href={`tel:${currentDelivery.driver.profile.phone}`}
                  className="w-full py-2 bg-white border border-gray-200 hover:bg-gray-50 text-gray-900 text-sm font-medium rounded transition-colors flex items-center justify-center gap-2"
                >
                  <span className="material-symbols-outlined text-[18px]">chat</span> Contact Driver
                </a>
              )}
            </motion.div>
          )}

          {/* Tracking Timeline Card */}
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.1 }}
            className="bg-white border border-gray-200 rounded-lg p-5 flex-1"
          >
            <h3 className="text-lg font-semibold text-gray-900 mb-6">Tracking Timeline</h3>

            {currentDelivery.timeline && currentDelivery.timeline.length > 0 ? (
              <div className="relative">
                <div className="absolute left-[11px] top-2 bottom-2 w-0.5 bg-gray-200" />
                <div className="space-y-6 relative">
                  {currentDelivery.timeline.map((event, index) => {
                    const isLast = index === currentDelivery.timeline.length - 1;
                    const isFinal = isLast && ['delivered', 'collected', 'failed'].includes(event.status);
                    return (
                      <div key={index} className="flex gap-4">
                        <div className={`relative z-10 w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 ${
                          isFinal
                            ? 'bg-blue-600 text-white ring-4 ring-blue-100'
                            : 'bg-white border-2 border-blue-600'
                        }`}>
                          {isFinal ? (
                            <span className="material-symbols-outlined text-[14px]">check</span>
                          ) : (
                            <div className="w-2 h-2 rounded-full bg-blue-600" />
                          )}
                        </div>
                        <div className="pt-0.5">
                          <p className={`text-sm text-gray-900 capitalize ${isFinal ? 'font-bold' : 'font-medium'}`}>
                            {event.status.replace('_', ' ')}
                          </p>
                          <p className={`font-mono text-[11px] mt-0.5 ${isFinal ? 'text-blue-600 font-medium' : 'text-gray-400'}`}>
                            {formatDateTime(event.timestamp)}
                          </p>
                          {event.notes && (
                            <p className="text-sm text-gray-500 mt-1">{event.notes}</p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="text-center py-8 text-gray-400">
                <span className="material-symbols-outlined text-[40px] mb-2 block">timeline</span>
                <div className="text-sm">No timeline events recorded</div>
              </div>
            )}
          </motion.div>

        </div>
      </div>

      {showEditModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-6 border-b border-gray-200 sticky top-0 bg-white z-10">
              <h2 className="text-xl font-bold text-gray-900">Edit Delivery</h2>
              <button
                onClick={() => setShowEditModal(false)}
                className="p-1 hover:bg-gray-100 rounded-lg"
              >
                <XCircle className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!['admin','super_admin','dispatcher','manager'].includes(auth.user?.role)) {
                  alert('You do not have permission to edit deliveries.');
                  return;
                }
                const updatePayload = {};
                // Basic fields
                if (editForm.customerName !== currentDelivery.customerName) updatePayload.customerName = editForm.customerName;
                if (editForm.customerPhone !== (currentDelivery.customerPhone || '')) updatePayload.customerPhone = editForm.customerPhone;
                if (editForm.address !== (currentDelivery.address || '')) updatePayload.address = editForm.address;
                if (editForm.company !== (currentDelivery.company || '')) updatePayload.company = editForm.company;
                if (editForm.notes !== (currentDelivery.notes || '')) updatePayload.notes = editForm.notes;
                if (editForm.zone !== (currentDelivery.zone || '')) updatePayload.zone = editForm.zone;

                // Scheduled time: combine business-local date + time if provided.
                // editForm.date/time are business-timezone (Dubai) values, so
                // convert them back through the same fixed offset rather than
                // treating them as UTC — that mismatch was silently saving
                // the wrong hour on every edit.
                if (editForm.date && editForm.time) {
                  const newDate = businessComponentsToUtcDate(editForm.date, editForm.time);
                  const currentIso = currentDelivery.scheduledTime ? new Date(currentDelivery.scheduledTime).toISOString() : '';
                  if (newDate && newDate.toISOString() !== currentIso) {
                    updatePayload.scheduledTime = newDate.toISOString();
                  }
                }

                // Pin location
                const prevLat = currentDelivery.gpsLocation?.lat ?? null;
                const prevLng = currentDelivery.gpsLocation?.lng ?? null;
                const prevLink = currentDelivery.gpsLocation?.link || '';
                if (editForm.gpsLat !== prevLat || editForm.gpsLng !== prevLng || editForm.gpsLink !== prevLink) {
                  updatePayload.gpsLocation = {
                    lat: editForm.gpsLat,
                    lng: editForm.gpsLng,
                    link: editForm.gpsLink
                  };
                }

                if (Object.keys(updatePayload).length === 0) {
                  alert('No changes to save');
                  return;
                }

                try {
                  setActionLoading(true);
                  await api.put(`/deliveries/${id}`, updatePayload);
                  await dispatch(fetchDeliveryById(id));
                  setShowEditModal(false);
                  alert('Delivery updated successfully');
                } catch (err) {
                  console.error('Update delivery error:', err);
                  alert(err?.response?.data?.message || 'Failed to update delivery');
                } finally {
                  setActionLoading(false);
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
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Customer Phone</label>
                  <input
                    type="text"
                    value={editForm.customerPhone}
                    onChange={(e) => setEditForm(f => ({ ...f, customerPhone: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>

                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Address</label>
                  <textarea
                    rows={2}
                    value={editForm.address}
                    onChange={(e) => setEditForm(f => ({ ...f, address: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Company</label>
                  <select
                    value={editForm.company}
                    onChange={(e) => setEditForm(f => ({ ...f, company: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="Matter">Matter</option>
                    <option value="Yellow Block">Yellow Block</option>
                    <option value="CookIt">CookIt</option>
                    <option value="Other">Other</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Zone (optional)</label>
                  <input
                    type="text"
                    value={editForm.zone}
                    onChange={(e) => setEditForm(f => ({ ...f, zone: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    placeholder="e.g., Zone A"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Scheduled Date</label>
                  <input
                    type="date"
                    value={editForm.date}
                    onChange={(e) => setEditForm(f => ({ ...f, date: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Scheduled Time</label>
                  <input
                    type="time"
                    value={editForm.time}
                    onChange={(e) => setEditForm(f => ({ ...f, time: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>

                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                  <textarea
                    rows={2}
                    value={editForm.notes}
                    onChange={(e) => setEditForm(f => ({ ...f, notes: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>

                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Pin Location</label>
                  <input
                    type="text"
                    value={editForm.gpsLink}
                    onChange={(e) => {
                      const link = e.target.value;
                      const parsed = parseGPSFromLink(link);
                      setEditForm(f => ({
                        ...f,
                        gpsLink: link,
                        ...(parsed ? { gpsLat: parsed.lat, gpsLng: parsed.lng } : {})
                      }));
                    }}
                    placeholder="Paste a Google Maps or Apple Maps link…"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 mb-2"
                  />
                  <p className="text-xs text-gray-400 mb-2">Or drag the pin, or click anywhere on the map, to set the exact location.</p>
                  <LocationPinPicker
                    lat={editForm.gpsLat}
                    lng={editForm.gpsLng}
                    onChange={(lat, lng) => setEditForm(f => ({ ...f, gpsLat: lat, gpsLng: lng }))}
                  />
                  {Number.isFinite(editForm.gpsLat) && Number.isFinite(editForm.gpsLng) && (
                    <p className="text-xs text-gray-500 mt-2 font-mono">
                      {editForm.gpsLat.toFixed(6)}, {editForm.gpsLng.toFixed(6)}
                    </p>
                  )}
                </div>
              </div>

              <div className="flex justify-end space-x-3 pt-2 border-t border-gray-200">
                <button
                  type="button"
                  onClick={() => setShowEditModal(false)}
                  className="px-4 py-2 text-gray-700 bg-gray-200 rounded-lg hover:bg-gray-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className={`flex items-center px-4 py-2 rounded-lg ${actionLoading ? 'bg-gray-300 text-gray-700' : 'bg-blue-500 text-white hover:bg-blue-600'}`}
                >
                  Save Changes
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default DeliveryDetail;

