import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { Circle, GoogleMap, InfoWindow, OverlayView, Polyline, useLoadScript } from '@react-google-maps/api';
import { RefreshCw, Truck, AlertTriangle } from 'lucide-react';
import api from '../utils/api';
import TrackerVisitCard from '../components/deliveries/TrackerVisitCard';
import { businessComponentsToUtcDate, formatBusinessDateInput, formatBusinessTime } from '../utils/businessTime';

// Live vehicle GPS tracking (owner, 2026-09-24) — real-time positions from
// the Truckoom "Trace" fleet API (server/services/truckoomApiService.js).
// Polls every REFRESH_INTERVAL_MS while this page is open, matching
// Truckoom's own documented ~1-minute request interval for this kind of call.
//
// Two pins per driver (owner, 2026-10-13): the TRACKER pin (🚚, Truckoom) and
// the driver's PHONE pin (📱, the driver app's own reported position), each
// with a street address (the server looks both up — the app and the tracker
// send coordinates only). A driver with no tracker shows just the phone pin.
//
// Uses Google Maps JS (owner request, 2026-09-30) rather than the 2GIS
// MapGL display everywhere else in the app (dispatcher route maps) — that's
// a deliberate one-page exception, not a project-wide switch. Loads through
// @react-google-maps/api (useLoadScript + REACT_APP_GOOGLE_MAPS_API_KEY).

const GOOGLE_MAPS_API_KEY = process.env.REACT_APP_GOOGLE_MAPS_API_KEY || '';
const DUBAI_CENTER = { lat: 25.2048, lng: 55.2708 };
const REFRESH_INTERVAL_MS = 60 * 1000;
const MIN_LINE_METERS = 25; // closer than this, the two pins are effectively the same spot
const MAP_CONTAINER_STYLE = { width: '100%', height: '100%' };
const MAP_OPTIONS = {
  disableDefaultUI: false,
  zoomControl: true,
  mapTypeControl: false,
  streetViewControl: false,
  fullscreenControl: true,
};

function driverDisplayName(driver) {
  const firstName = driver?.profile?.firstName;
  const lastName = driver?.profile?.lastName;
  return [firstName, lastName].filter(Boolean).join(' ').trim() || driver?.email || 'Driver';
}

function timeAgo(iso) {
  if (!iso) return '';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function distanceMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function formatDistance(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

const hasFix = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng);

// Pins show only the first word of the name; lists and the route panel keep the full one.
const firstWord = (name) => String(name || '').trim().split(/\s+/)[0];

// Same truck-emoji-plus-name-label look the 2GIS HtmlMarker used, rendered
// here as a plain OverlayView so it survives the switch pixel-for-pixel.
// Stacking: the overlay containers are separate absolutely-positioned divs, so
// z-index only takes effect on a positioned element inside them. Order, back to
// front: phone pin (10) < delivery stops (14-18) < tracker pin (20) < selected
// driver's big pin (100).
function VehicleMarker({ vehicle, isActive, onClick }) {
  const color = vehicle.driver?.colorCode || '#9CA3AF';
  const label = firstWord(vehicle.driver ? vehicle.driver.name : `Vehicle ${vehicle.vehicleNo}`);
  return (
    <OverlayView
      position={{ lat: vehicle.latitude, lng: vehicle.longitude }}
      mapPaneName={OverlayView.OVERLAY_MOUSE_TARGET}
      getPixelPositionOffset={(width, height) => ({ x: -width / 2, y: -height / 2 })}
    >
      <div
        onClick={onClick}
        style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer', position: 'relative', zIndex: isActive ? 22 : 20 }}
      >
        <div
          style={{
            background: color,
            border: '2px solid white',
            boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
            borderRadius: '9999px',
            height: 30,
            padding: '0 9px 0 6px',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 15,
            whiteSpace: 'nowrap',
          }}
        >
          <span>🚚</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'white', textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>{label}</span>
        </div>
      </div>
    </OverlayView>
  );
}

// The driver's phone pin: same colour as their tracker pin, but a dashed ring
// and 📱 so the two are never confused. Dimmed when the last report is old.
function PhoneMarker({ name, colorCode, location, isActive, onClick }) {
  const color = colorCode || '#9CA3AF';
  return (
    <OverlayView
      position={{ lat: location.latitude, lng: location.longitude }}
      mapPaneName={OverlayView.OVERLAY_MOUSE_TARGET}
      getPixelPositionOffset={(width, height) => ({ x: -width / 2, y: -height / 2 })}
    >
      <div
        onClick={onClick}
        title={location.stale ? 'Phone location is old (last seen)' : 'Driver app location'}
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          cursor: 'pointer',
          opacity: location.stale ? 0.55 : 1,
          position: 'relative',
          zIndex: isActive ? 12 : 10,
        }}
      >
        <div
          style={{
            background: 'white',
            border: `3px dashed ${color}`,
            boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
            borderRadius: '9999px',
            height: 28,
            padding: '0 8px 0 5px',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 14,
            whiteSpace: 'nowrap',
          }}
        >
          <span>📱</span>
          <span style={{ fontSize: 10, fontWeight: 700, color: '#374151' }}>{firstWord(name)}</span>
        </div>
      </div>
    </OverlayView>
  );
}

const STOP_COLORS = {
  delivered: '#10B981',
  completed: '#10B981',
  collected: '#10B981',
  failed: '#EF4444',
  on_route: '#3B82F6',
  picked_up: '#3B82F6',
  assigned: '#6B7280',
  pending: '#9CA3AF',
};
const stopColor = (status) => STOP_COLORS[status] || '#9CA3AF';
const stopStatusLabel = (status) => String(status || 'pending').replace(/_/g, ' ');

// The big "this is where the selected driver is" pin: a teardrop in the
// driver's colour with a pulsing ring and his name, drawn above every other
// marker. Anchored at the tip of the pin so the tip sits on the exact spot.
function SelectedDriverPin({ name, colorCode, position, source, subtitle }) {
  const color = colorCode || '#2563EB';
  return (
    <OverlayView
      position={position}
      mapPaneName={OverlayView.OVERLAY_MOUSE_TARGET}
      getPixelPositionOffset={(width, height) => ({ x: -width / 2, y: -height })}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', position: 'relative', zIndex: 100, pointerEvents: 'none' }}>
        <style>{'@keyframes lt-pulse{0%{transform:scale(.5);opacity:.7}100%{transform:scale(2.4);opacity:0}}'}</style>
        <div
          style={{
            background: 'white',
            borderRadius: 8,
            padding: '2px 8px',
            marginBottom: 3,
            fontSize: 12,
            fontWeight: 700,
            color: '#111827',
            boxShadow: '0 1px 5px rgba(0,0,0,0.45)',
            whiteSpace: 'nowrap',
            textAlign: 'center',
          }}
        >
          {name}
          <div style={{ fontSize: 10, fontWeight: 500, color: '#6B7280' }}>{source}{subtitle ? ` · ${subtitle}` : ''}</div>
        </div>
        <svg width="40" height="52" viewBox="0 0 40 52" style={{ filter: 'drop-shadow(0 2px 3px rgba(0,0,0,0.5))' }}>
          <path d="M20 2C10.6 2 3 9.6 3 19c0 12.5 17 31 17 31s17-18.5 17-31C37 9.6 29.4 2 20 2z" fill={color} stroke="white" strokeWidth="3" />
          <circle cx="20" cy="19" r="7" fill="white" />
        </svg>
        <div
          style={{
            width: 18,
            height: 18,
            marginTop: -9,
            borderRadius: '9999px',
            border: `3px solid ${color}`,
            animation: 'lt-pulse 1.8s ease-out infinite',
          }}
        />
      </div>
    </OverlayView>
  );
}

// A numbered delivery stop on the selected driver's route.
function StopMarker({ stop, isActive, onClick }) {
  return (
    <OverlayView
      position={stop.pin}
      mapPaneName={OverlayView.OVERLAY_MOUSE_TARGET}
      getPixelPositionOffset={(width, height) => ({ x: -width / 2, y: -height / 2 })}
    >
      <div
        onClick={onClick}
        title={`${stop.stopNumber}. ${stop.customerName || ''} — ${stopStatusLabel(stop.status)}`}
        style={{
          background: stopColor(stop.status),
          color: 'white',
          border: `2px solid ${isActive ? '#111827' : 'white'}`,
          boxShadow: '0 1px 4px rgba(0,0,0,0.45)',
          borderRadius: '9999px',
          minWidth: isActive ? 30 : 24,
          height: isActive ? 30 : 24,
          padding: '0 4px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 12,
          fontWeight: 700,
          cursor: 'pointer',
          position: 'relative',
          zIndex: isActive ? 18 : 14,
        }}
      >
        {stop.stopNumber}
      </div>
    </OverlayView>
  );
}

// One line of "where" for the list and the map popup.
function PositionLine({ icon, label, address, lastUpdated, stale }) {
  return (
    <p className={`text-xs mt-0.5 ${stale ? 'text-gray-400' : 'text-gray-600'}`}>
      <span className="font-medium">{icon} {label}:</span>{' '}
      {address || 'Address not available'}
      {lastUpdated && <span className="text-gray-400"> · {timeAgo(lastUpdated)}{stale ? ' (last seen)' : ''}</span>}
    </p>
  );
}

const LiveTracking = () => {
  const [vehicles, setVehicles] = useState([]);
  const [appOnlyDrivers, setAppOnlyDrivers] = useState([]);
  const [fetchedAt, setFetchedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [trackerWarning, setTrackerWarning] = useState('');
  const [activeKey, setActiveKey] = useState(null); // `veh:<vehicleNo>` or `drv:<driverId>`
  const [infoOpen, setInfoOpen] = useState(false);
  // Route of the selected driver: every delivery assigned to them for the
  // chosen day, in visit order (owner, 2026-10-13).
  const [routeDate, setRouteDate] = useState(() => formatBusinessDateInput(new Date()));
  const [routeStops, setRouteStops] = useState([]);
  const [routeLoadedKey, setRouteLoadedKey] = useState('');
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState('');
  const [activeStopId, setActiveStopId] = useState(null);
  const fittedKeyRef = useRef('');
  // Every driver, for the "reassign tracker" dropdown — not just the ones
  // already mapped to a vehicle (those come back on `vehicles` already).
  const [allDrivers, setAllDrivers] = useState([]);
  const [reassigningVehicleNo, setReassigningVehicleNo] = useState(null);

  const mapInstanceRef = useRef(null);
  const selectedDriverIdRef = useRef(null);
  const [mapReady, setMapReady] = useState(false);

  const { isLoaded, loadError } = useLoadScript({ googleMapsApiKey: GOOGLE_MAPS_API_KEY });

  const fetchVehicles = useCallback(async () => {
    try {
      setError('');
      const res = await api.get('/truckoom/vehicles');
      const nextVehicles = res.data?.data || [];
      const nextAppDrivers = res.data?.appOnlyDrivers || [];
      setVehicles(nextVehicles);
      setAppOnlyDrivers(nextAppDrivers);
      // Keep the driver's route selected when an outage moves their entry
      // from a tracker to phone-only, and when their tracker recovers.
      setActiveKey((current) => {
        const driverId = selectedDriverIdRef.current;
        if (!current || !driverId) return current;
        const vehicle = nextVehicles.find((v) => v.driver?.id === driverId);
        if (vehicle) return `veh:${vehicle.vehicleNo}`;
        return nextAppDrivers.some((d) => d.id === driverId) ? `drv:${driverId}` : null;
      });
      setTrackerWarning(res.data?.trackerWarning || '');
      setFetchedAt(res.data?.fetchedAt || new Date().toISOString());
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Failed to load vehicle data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchVehicles();
    const interval = setInterval(fetchVehicles, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchVehicles]);

  useEffect(() => {
    api.get('/users/drivers')
      .then((res) => {
        const payload = res?.data;
        const list = payload?.data?.drivers || payload?.data || payload?.drivers || payload || [];
        setAllDrivers(Array.isArray(list) ? list : []);
      })
      .catch(() => setAllDrivers([]));
  }, []);

  // Owner (2026-10-09): "add an option to change the assigned driver to the
  // tracker" — reassign which driver a vehicle belongs to right from this
  // page, instead of going through the driver's own profile edit form. The
  // server clears the old driver's mapping (if any) so a vehicle never ends
  // up pointing at two drivers at once.
  const handleReassign = async (vehicleNo, driverId) => {
    setReassigningVehicleNo(vehicleNo);
    setError('');
    try {
      const res = await api.put(`/truckoom/vehicles/${vehicleNo}/driver`, { driverId: driverId || null });
      const newDriver = res.data?.data?.driver || null;
      setVehicles((prev) => prev.map((v) => {
        if (v.vehicleNo === vehicleNo) return { ...v, driver: newDriver };
        // Clear the vehicle this driver used to be on, if any — mirrors the
        // server's own "one vehicle, one driver" rule immediately, without
        // waiting for the next 60s poll.
        if (newDriver && v.driver?.id === newDriver.id) return { ...v, driver: null };
        return v;
      }));
      fetchVehicles(); // pick up the newly mapped driver's phone pin and addresses
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Failed to reassign driver');
    } finally {
      setReassigningVehicleNo(null);
    }
  };

  const locatedVehicles = useMemo(
    () => vehicles.filter((v) => hasFix(v.latitude, v.longitude)),
    [vehicles]
  );

  // Everything that gets a phone pin: mapped drivers' phones + drivers with no tracker.
  const phonePins = useMemo(() => {
    const pins = [];
    vehicles.forEach((v) => {
      const loc = v.driver?.appLocation;
      if (loc && hasFix(loc.latitude, loc.longitude)) {
        pins.push({ key: `veh:${v.vehicleNo}:phone`, activeKey: `veh:${v.vehicleNo}`, name: v.driver.name, colorCode: v.driver.colorCode, location: loc });
      }
    });
    appOnlyDrivers.forEach((d) => {
      if (d.appLocation && hasFix(d.appLocation.latitude, d.appLocation.longitude)) {
        pins.push({ key: `drv:${d.id}:phone`, activeKey: `drv:${d.id}`, name: d.name, colorCode: d.colorCode, location: d.appLocation });
      }
    });
    return pins;
  }, [vehicles, appOnlyDrivers]);

  // Thin line between a driver's two pins when they're meaningfully apart (recent phone reports only).
  const gapLines = useMemo(() => locatedVehicles
    .map((v) => {
      const loc = v.driver?.appLocation;
      // An old ("last seen") phone position says nothing about where the
      // driver is now, so no line to it — only recent phone reports are joined.
      if (!loc || loc.stale || !hasFix(loc.latitude, loc.longitude)) return null;
      const a = { lat: v.latitude, lng: v.longitude };
      const b = { lat: loc.latitude, lng: loc.longitude };
      const meters = distanceMeters(a, b);
      return meters >= MIN_LINE_METERS ? { key: v.vehicleNo, path: [a, b], color: v.driver.colorCode || '#6B7280', meters } : null;
    })
    .filter(Boolean), [locatedVehicles]);

  const handleMapLoad = useCallback((map) => {
    mapInstanceRef.current = map;
    setMapReady(true);
  }, []);

  const selectDriver = (key) => {
    setActiveKey(key);
    setInfoOpen(true);
  };

  const panTo = (position, key) => {
    selectDriver(key);
    if (mapInstanceRef.current && position) {
      mapInstanceRef.current.panTo(position);
      mapInstanceRef.current.setZoom(14);
    }
  };

  const panToVehicle = (v, prefer = 'tracker') => {
    const tracker = hasFix(v.latitude, v.longitude) ? { lat: v.latitude, lng: v.longitude } : null;
    const loc = v.driver?.appLocation;
    const phone = loc && hasFix(loc.latitude, loc.longitude) ? { lat: loc.latitude, lng: loc.longitude } : null;
    panTo(prefer === 'phone' ? phone || tracker : tracker || phone, `veh:${v.vehicleNo}`);
  };

  // The popup for whatever is selected: both addresses and how far apart the pins are.
  const activeInfo = useMemo(() => {
    if (!activeKey) return null;
    if (activeKey.startsWith('veh:')) {
      const v = vehicles.find((x) => `veh:${x.vehicleNo}` === activeKey);
      if (!v) return null;
      const tracker = hasFix(v.latitude, v.longitude) ? { lat: v.latitude, lng: v.longitude } : null;
      const loc = v.driver?.appLocation;
      const phone = loc && hasFix(loc.latitude, loc.longitude) ? { lat: loc.latitude, lng: loc.longitude } : null;
      const position = tracker || phone;
      if (!position) return null;
      return {
        position,
        title: v.driver ? v.driver.name : `Vehicle ${v.vehicleNo}`,
        subtitle: v.vehicleNo,
        tracker: tracker ? { address: v.address, gpsTime: v.gpsTime,
          speedKph: v.speedKph, ignition: v.ignition, status: v.trackerStatus } : null,
        phone: phone ? loc : null,
        apart: tracker && phone ? distanceMeters(tracker, phone) : null,
      };
    }
    const d = appOnlyDrivers.find((x) => `drv:${x.id}` === activeKey);
    if (!d || !d.appLocation) return null;
    return {
      position: { lat: d.appLocation.latitude, lng: d.appLocation.longitude },
      title: d.name,
      subtitle: 'No tracker assigned',
      tracker: null,
      phone: d.appLocation,
      apart: null,
    };
  }, [activeKey, vehicles, appOnlyDrivers]);

  const phoneCount = phonePins.length;

  // Whoever is selected (a tracker pin, a phone pin, or a list row).
  const selectedDriver = useMemo(() => {
    if (!activeKey) return null;
    if (activeKey.startsWith('veh:')) {
      const v = vehicles.find((x) => `veh:${x.vehicleNo}` === activeKey);
      return v?.driver ? { id: v.driver.id, name: v.driver.name, colorCode: v.driver.colorCode } : null;
    }
    const d = appOnlyDrivers.find((x) => `drv:${x.id}` === activeKey);
    return d ? { id: d.id, name: d.name, colorCode: d.colorCode } : null;
  }, [activeKey, vehicles, appOnlyDrivers]);
  const selectedDriverId = selectedDriver?.id || null;
  useEffect(() => { selectedDriverIdRef.current = selectedDriverId; }, [selectedDriverId]);

  // Where the selected driver is: the tracker (live) when he has one with a
  // fix, otherwise his phone's last report.
  const selectedDriverSpot = useMemo(() => {
    if (!selectedDriverId) return null;
    const v = vehicles.find((x) => x.driver?.id === selectedDriverId);
    if (v && hasFix(v.latitude, v.longitude)) {
      return { position: { lat: v.latitude, lng: v.longitude }, source: '🚚 Tracker', subtitle: 'live' };
    }
    const phone = v?.driver?.appLocation || appOnlyDrivers.find((x) => x.id === selectedDriverId)?.appLocation;
    if (phone && hasFix(phone.latitude, phone.longitude)) {
      return {
        position: { lat: phone.latitude, lng: phone.longitude },
        source: '📱 Phone',
        subtitle: `${phone.stale ? 'last seen ' : ''}${timeAgo(phone.lastUpdated)}`.trim(),
      };
    }
    return null;
  }, [selectedDriverId, vehicles, appOnlyDrivers]);

  // Load that driver's deliveries for the day. Re-fetched on every page poll
  // (fetchedAt) so statuses stay current while the driver is selected.
  useEffect(() => {
    if (!selectedDriverId) {
      setRouteStops([]);
      setRouteLoadedKey('');
      setRouteLoading(false);
      setRouteError('');
      setActiveStopId(null);
      return undefined;
    }
    let cancelled = false;
    const start = businessComponentsToUtcDate(routeDate, '00:00');
    if (!start) return undefined;
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
    setRouteLoading(true);
    setRouteLoadedKey('');
    setRouteError('');
    setActiveStopId(null);
    api.get('/deliveries', {
      params: { driver: selectedDriverId, dateFrom: start.toISOString(), dateTo: end.toISOString(), page: 1, limit: 500 },
    })
      .then((res) => {
        if (cancelled) return;
        setRouteStops(res.data?.data?.deliveries || []);
        setRouteLoadedKey(`${selectedDriverId}|${routeDate}`);
      })
      .catch((err) => {
        if (cancelled) return;
        setRouteStops([]);
        setRouteError(err.response?.data?.message || err.message || 'Failed to load deliveries');
      })
      .finally(() => { if (!cancelled) setRouteLoading(false); });
    return () => { cancelled = true; };
  }, [selectedDriverId, routeDate, fetchedAt]);

  // Visit order: the optimizer's routeOrder; stops it has not ordered yet go
  // last, by scheduled time. (Tasks are not delivery stops.)
  const route = useMemo(() => {
    const list = routeLoadedKey === `${selectedDriverId}|${routeDate}`
      ? routeStops.filter((d) => d.type !== 'Task').slice()
      : [];
    const optimized = list.some((d) => Number.isFinite(d.routeOrder));
    list.sort((a, b) => {
      const ra = Number.isFinite(a.routeOrder) ? a.routeOrder : Infinity;
      const rb = Number.isFinite(b.routeOrder) ? b.routeOrder : Infinity;
      if (ra !== rb) return ra - rb;
      return new Date(a.scheduledTime) - new Date(b.scheduledTime);
    });
    const stops = list.map((d, i) => ({
      ...d,
      stopNumber: i + 1,
      pin: hasFix(d.gpsLocation?.lat, d.gpsLocation?.lng) ? { lat: d.gpsLocation.lat, lng: d.gpsLocation.lng } : null,
    }));
    return { stops, optimized, pinned: stops.filter((s) => s.pin) };
  }, [routeStops, routeLoadedKey, selectedDriverId, routeDate]);

  // Frame the driver and their stops once per driver/day, not on every poll.
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!mapReady || !map || !selectedDriverId || routeLoading || !window.google?.maps) return;
    const key = `${selectedDriverId}|${routeDate}`;
    // Wait for this driver's day's response, not stops from the previous selection.
    if (routeLoadedKey !== key) return;
    if (fittedKeyRef.current === key) return;
    const points = route.pinned.map((s) => s.pin);
    const v = vehicles.find((x) => x.driver?.id === selectedDriverId);
    const phone = v?.driver?.appLocation || appOnlyDrivers.find((x) => x.id === selectedDriverId)?.appLocation;
    if (v && hasFix(v.latitude, v.longitude)) points.push({ lat: v.latitude, lng: v.longitude });
    if (phone && hasFix(phone.latitude, phone.longitude)) points.push({ lat: phone.latitude, lng: phone.longitude });
    if (points.length === 0) return;
    if (points.length === 1) {
      map.panTo(points[0]);
      map.setZoom(14);
      fittedKeyRef.current = key;
      return;
    }
    const bounds = new window.google.maps.LatLngBounds();
    points.forEach((pt) => bounds.extend(pt));
    map.fitBounds(bounds, 70);
    fittedKeyRef.current = key;
  }, [route, routeLoading, routeLoadedKey, mapReady, selectedDriverId, routeDate, vehicles, appOnlyDrivers]);

  const clearSelection = () => { setActiveKey(null); setInfoOpen(false); setActiveStopId(null); fittedKeyRef.current = ''; };

  const focusStop = (stop) => {
    setActiveStopId(stop._id);
    if (stop.pin && mapInstanceRef.current) {
      mapInstanceRef.current.panTo(stop.pin);
      mapInstanceRef.current.setZoom(15);
    }
  };

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      <div className="flex items-center justify-between px-6 py-4 bg-white border-b border-gray-200">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
            <Truck className="w-6 h-6 text-blue-600" />
            Live Tracking
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            🚚 Tracker (Truckoom): {locatedVehicles.length} of {vehicles.length} vehicles reporting · 📱 Driver app: {phoneCount} phone{phoneCount === 1 ? '' : 's'} on the map
            {fetchedAt && <span className="text-gray-400"> · updated {timeAgo(fetchedAt)}</span>}
          </p>
        </div>
        <button
          onClick={fetchVehicles}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="mx-6 mt-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {trackerWarning && (
        <div role="status" className="mx-6 mt-4 p-3 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg text-sm">
          {trackerWarning}
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        {/* Vehicle list */}
        <div className="w-96 flex-shrink-0 border-r border-gray-200 bg-white overflow-y-auto">
          {vehicles.length === 0 && appOnlyDrivers.length === 0 && !loading ? (
            <p className="p-4 text-sm text-gray-400">No vehicles found.</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {vehicles.map((v) => {
                const loc = v.driver?.appLocation;
                const trackerFix = hasFix(v.latitude, v.longitude);
                const phoneFix = !!loc && hasFix(loc.latitude, loc.longitude);
                const apart = trackerFix && phoneFix
                  ? distanceMeters({ lat: v.latitude, lng: v.longitude }, { lat: loc.latitude, lng: loc.longitude })
                  : null;
                return (
                  <li key={v.vehicleNo} className={activeKey === `veh:${v.vehicleNo}` ? 'bg-blue-50' : ''}>
                    <button
                      type="button"
                      onClick={() => panToVehicle(v)}
                      disabled={!trackerFix && !phoneFix}
                      className="w-full text-left px-4 pt-3 flex items-start gap-3 hover:bg-gray-50 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span
                        className="w-8 h-8 rounded-full flex items-center justify-center text-sm flex-shrink-0"
                        style={{ backgroundColor: v.driver?.colorCode || '#9CA3AF' }}
                      >
                        🚚
                      </span>
                      <span className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">
                          {v.driver ? v.driver.name : 'Unassigned vehicle'}
                        </p>
                        <p className="text-xs text-gray-500 truncate">
                          {v.vehicleNo}{v.deviceName ? ` · ${v.deviceName}` : ''}
                        </p>
                        {trackerFix ? (
                          <PositionLine icon="🚚" label="Tracker" address={v.address} />
                        ) : (
                          <p className="text-xs text-amber-600 mt-0.5">🚚 Tracker: no location reported</p>
                        )}
                        {phoneFix ? (
                          <PositionLine icon="📱" label="Phone" address={loc.address} lastUpdated={loc.lastUpdated} stale={loc.stale} />
                        ) : (
                          v.driver && <p className="text-xs text-gray-400 mt-0.5">📱 Phone: no location reported</p>
                        )}
                        {apart != null && (
                          <p className="text-[11px] text-gray-400 mt-0.5">Pins are {formatDistance(apart)} apart</p>
                        )}
                      </span>
                    </button>
                    <div className="px-4 pb-3 pt-1.5 pl-[52px] flex items-center gap-2">
                      <select
                        value={v.driver?.id || ''}
                        disabled={reassigningVehicleNo === v.vehicleNo}
                        onChange={(e) => handleReassign(v.vehicleNo, e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        className="flex-1 min-w-0 text-xs border border-gray-200 rounded px-2 py-1 bg-white text-gray-700 disabled:opacity-50"
                      >
                        <option value="">— Unassigned —</option>
                        {allDrivers.map((d) => (
                          <option key={d._id} value={d._id}>{driverDisplayName(d)}</option>
                        ))}
                      </select>
                      {trackerFix && phoneFix && (
                        <>
                          <button type="button" onClick={() => panToVehicle(v, 'tracker')} className="text-xs px-2 py-1 border border-gray-200 rounded hover:bg-gray-50" title="Go to the tracker pin">🚚</button>
                          <button type="button" onClick={() => panToVehicle(v, 'phone')} className="text-xs px-2 py-1 border border-gray-200 rounded hover:bg-gray-50" title="Go to the phone pin">📱</button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}

              {appOnlyDrivers.length > 0 && (
                <li className="bg-gray-50 px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                  {trackerWarning ? 'Driver phone locations' : 'Drivers without a tracker (phone only)'}
                </li>
              )}
              {appOnlyDrivers.map((d) => (
                <li key={d.id} className={activeKey === `drv:${d.id}` ? 'bg-blue-50' : ''}>
                  <button
                    type="button"
                    onClick={() => panTo({ lat: d.appLocation.latitude, lng: d.appLocation.longitude }, `drv:${d.id}`)}
                    className="w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-gray-50 transition-colors"
                  >
                    <span
                      className="w-8 h-8 rounded-full flex items-center justify-center text-sm flex-shrink-0 bg-white border-2 border-dashed"
                      style={{ borderColor: d.colorCode || '#9CA3AF' }}
                    >
                      📱
                    </span>
                    <span className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{d.name}</p>
                      <PositionLine icon="📱" label="Phone" address={d.appLocation.address} lastUpdated={d.appLocation.lastUpdated} stale={d.appLocation.stale} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Map */}
        <div className="flex-1 relative">
          {!GOOGLE_MAPS_API_KEY ? (
            <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-gray-500">
              Add <span className="font-mono">REACT_APP_GOOGLE_MAPS_API_KEY</span> to <span className="font-mono">client/.env</span> to show the map.
            </div>
          ) : loadError ? (
            <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-red-600">
              Failed to load the Google Maps script.
            </div>
          ) : !isLoaded ? (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-400">Loading map…</div>
          ) : (
            <GoogleMap
              mapContainerStyle={MAP_CONTAINER_STYLE}
              center={DUBAI_CENTER}
              zoom={11}
              options={MAP_OPTIONS}
              onLoad={handleMapLoad}
            >
              {gapLines.map((line) => (
                <Polyline
                  key={`gap-${line.key}`}
                  path={line.path}
                  options={{ strokeColor: line.color, strokeOpacity: 0.6, strokeWeight: 2, clickable: false }}
                />
              ))}
              {locatedVehicles.map((v) => (
                <VehicleMarker
                  key={v.vehicleNo}
                  vehicle={v}
                  isActive={activeKey === `veh:${v.vehicleNo}`}
                  onClick={() => selectDriver(`veh:${v.vehicleNo}`)}
                />
              ))}
              {phonePins.map((p) => (
                <PhoneMarker
                  key={p.key}
                  name={p.name}
                  colorCode={p.colorCode}
                  location={p.location}
                  isActive={activeKey === p.activeKey}
                  onClick={() => selectDriver(p.activeKey)}
                />
              ))}
              {selectedDriver && route.pinned.length > 1 && (
                <Polyline
                  path={route.pinned.map((s) => s.pin)}
                  options={{
                    strokeColor: selectedDriver.colorCode || '#2563EB',
                    strokeOpacity: 0.55,
                    strokeWeight: 3,
                    clickable: false,
                    icons: [{
                      icon: { path: window.google.maps.SymbolPath.FORWARD_CLOSED_ARROW, scale: 2.5, strokeColor: selectedDriver.colorCode || '#2563EB' },
                      offset: '50%',
                      repeat: '140px',
                    }],
                  }}
                />
              )}
              {selectedDriver && route.pinned.map((s) => (
                <StopMarker key={s._id} stop={s} isActive={activeStopId === s._id} onClick={() => focusStop(s)} />
              ))}
              {selectedDriver && route.pinned.filter(s => s._id === activeStopId && s.type === 'Delivery').map(s => (
                <Circle key={`fence-${s._id}`}
                  center={s.trackerVisit?.geofenceId ? { lat: s.trackerVisit.lat, lng: s.trackerVisit.lng } : s.pin}
                  radius={s.trackerVisit?.radiusMetres || 50}
                  options={{ fillColor: '#6366f1', fillOpacity: 0.12, strokeColor: '#6366f1', strokeWeight: 2, clickable: false }} />
              ))}
              {selectedDriver && selectedDriverSpot && (
                <SelectedDriverPin
                  name={selectedDriver.name}
                  colorCode={selectedDriver.colorCode}
                  position={selectedDriverSpot.position}
                  source={selectedDriverSpot.source}
                  subtitle={selectedDriverSpot.subtitle}
                />
              )}
              {activeInfo && infoOpen && (
                <InfoWindow position={activeInfo.position} onCloseClick={() => setInfoOpen(false)}>
                  <div style={{ maxWidth: 260 }}>
                    <p style={{ fontWeight: 600, fontSize: 13 }}>{activeInfo.title}</p>
                    <p style={{ fontSize: 11, color: '#6B7280' }}>{activeInfo.subtitle}</p>
                    {activeInfo.tracker && (
                      <p style={{ fontSize: 12, marginTop: 4 }}>🚚 <b>Tracker:</b> {activeInfo.tracker.address || 'Address not available'}</p>
                    )}
                    {activeInfo.tracker && (
                      <div className="mt-1 text-xs text-gray-600">
                        <p>GPS report: {activeInfo.tracker.gpsTime ? `${formatBusinessTime(activeInfo.tracker.gpsTime)} Dubai · ${timeAgo(activeInfo.tracker.gpsTime)}` : 'Time unavailable'}</p>
                        <p>{activeInfo.tracker.speedKph != null ? `${activeInfo.tracker.speedKph} km/h · ` : ''}
                          {activeInfo.tracker.status || 'Status unavailable'}
                          {activeInfo.tracker.ignition ? ` · Ignition ${activeInfo.tracker.ignition}` : ''}</p>
                      </div>
                    )}
                    {activeInfo.phone && (
                      <p style={{ fontSize: 12, marginTop: 4 }}>
                        📱 <b>Phone:</b> {activeInfo.phone.address || 'Address not available'}
                        {activeInfo.phone.lastUpdated && (
                          <span style={{ color: '#9CA3AF' }}> · {timeAgo(activeInfo.phone.lastUpdated)}{activeInfo.phone.stale ? ' (last seen)' : ''}</span>
                        )}
                      </p>
                    )}
                    {activeInfo.apart != null && (
                      <p style={{ fontSize: 11, color: '#6B7280', marginTop: 4 }}>The two pins are {formatDistance(activeInfo.apart)} apart</p>
                    )}
                  </div>
                </InfoWindow>
              )}
            </GoogleMap>
          )}

          {selectedDriver && (
            <div
              data-testid="driver-route-panel"
              className="absolute top-3 right-3 w-80 max-h-[calc(100%-1.5rem)] bg-white rounded-lg shadow-lg border border-gray-200 flex flex-col z-10"
            >
              <div className="px-3 py-2 border-b border-gray-100 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-900 truncate">{selectedDriver.name}</p>
                  <p className="text-xs text-gray-500">
                    {route.stops.length} stop{route.stops.length === 1 ? '' : 's'}
                    {route.stops.length > 0 && ` · ${route.stops.filter((s) => ['delivered', 'completed', 'collected'].includes(s.status)).length} done`}
                    {route.stops.length > route.pinned.length && ` · ${route.stops.length - route.pinned.length} without a map pin`}
                  </p>
                </div>
                <button type="button" onClick={clearSelection} className="text-gray-400 hover:text-gray-700 text-lg leading-none px-1" aria-label="Close route">×</button>
              </div>
              <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-2">
                <input
                  type="date"
                  value={routeDate}
                  onChange={(e) => { if (e.target.value) { fittedKeyRef.current = ''; setRouteDate(e.target.value); } }}
                  className="text-xs border border-gray-200 rounded px-2 py-1"
                />
                {routeLoading && <span className="text-xs text-gray-400">Loading…</span>}
              </div>
              {!selectedDriverSpot && (
                <p className="px-3 py-2 text-xs text-amber-700 bg-amber-50 border-b border-amber-100">
                  No location reported for this driver yet (no tracker fix and no phone position), so there is no location pin to show.
                </p>
              )}
              {routeError && <p className="px-3 py-2 text-xs text-red-600">{routeError}</p>}
              {!routeLoading && !routeError && route.stops.length === 0 && (
                <p className="px-3 py-3 text-xs text-gray-400">No deliveries assigned to this driver on this day.</p>
              )}
              {route.stops.length > 0 && !route.optimized && (
                <p className="px-3 py-2 text-[11px] text-amber-700 bg-amber-50 border-b border-amber-100">
                  No route order has been planned for this day yet — stops are shown by scheduled time.
                </p>
              )}
              <ol className="overflow-y-auto divide-y divide-gray-100">
                {route.stops.map((s) => (
                  <li key={s._id}>
                    <button
                      type="button"
                      onClick={() => focusStop(s)}
                      className={`w-full text-left px-3 py-2 flex items-start gap-2 hover:bg-gray-50 ${activeStopId === s._id ? 'bg-blue-50' : ''}`}
                    >
                      <span
                        className="mt-0.5 w-6 h-6 rounded-full text-white text-xs font-bold flex items-center justify-center flex-shrink-0"
                        style={{ backgroundColor: stopColor(s.status) }}
                      >
                        {s.stopNumber}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-gray-900 truncate">{s.customerName || 'Customer'}</span>
                        <span className="block text-xs text-gray-500 line-clamp-2">{s.address || 'No address'}</span>
                        <span className="block text-[11px] text-gray-400 mt-0.5">
                          {formatBusinessTime(s.scheduledTime)} · {stopStatusLabel(s.status)}
                          {s.type && s.type !== 'Delivery' ? ` · ${s.type}` : ''}
                          {!s.pin ? ' · no map pin' : ''}
                        </span>
                      </span>
                    </button>
                    {activeStopId === s._id && <div className="px-3 pb-2"><TrackerVisitCard delivery={s} /></div>}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default LiveTracking;
