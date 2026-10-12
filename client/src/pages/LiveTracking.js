import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { GoogleMap, OverlayView, useLoadScript } from '@react-google-maps/api';
import { RefreshCw, Truck, AlertTriangle } from 'lucide-react';
import api from '../utils/api';

// Live vehicle GPS tracking (owner, 2026-09-24) — real-time positions from
// the Truckoom "Trace" fleet API (server/services/truckoomApiService.js),
// separate from the driver app's own phone-GPS tracking. Polls every
// REFRESH_INTERVAL_MS while this page is open, matching Truckoom's own
// documented ~1-minute request interval for this kind of call.
//
// Uses Google Maps JS (owner request, 2026-09-30) rather than the 2GIS
// MapGL display everywhere else in the app (dispatcher route maps) — that's
// a deliberate one-page exception, not a project-wide switch. Loads through
// @react-google-maps/api (useLoadScript + REACT_APP_GOOGLE_MAPS_API_KEY).

const GOOGLE_MAPS_API_KEY = process.env.REACT_APP_GOOGLE_MAPS_API_KEY || '';
const DUBAI_CENTER = { lat: 25.2048, lng: 55.2708 };
const REFRESH_INTERVAL_MS = 60 * 1000;
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
  return `${minutes}m ago`;
}

// Same truck-emoji-plus-name-label look the 2GIS HtmlMarker used, rendered
// here as a plain OverlayView so it survives the switch pixel-for-pixel.
function VehicleMarker({ vehicle, isActive, onClick }) {
  const color = vehicle.driver?.colorCode || '#9CA3AF';
  const label = vehicle.driver ? vehicle.driver.name : `Vehicle ${vehicle.vehicleNo}`;
  return (
    <OverlayView
      position={{ lat: vehicle.latitude, lng: vehicle.longitude }}
      mapPaneName={OverlayView.OVERLAY_MOUSE_TARGET}
      getPixelPositionOffset={(width, height) => ({ x: -width / 2, y: -height / 2 })}
    >
      <div
        onClick={onClick}
        style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer', zIndex: isActive ? 20 : 10 }}
      >
        <div
          style={{
            background: color,
            border: '2px solid white',
            boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
            borderRadius: '9999px',
            width: 30,
            height: 30,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 15,
          }}
        >
          🚚
        </div>
        <div
          style={{
            marginTop: 2,
            background: 'white',
            borderRadius: 6,
            padding: '1px 6px',
            fontSize: 11,
            fontWeight: 600,
            color: '#111827',
            boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </div>
      </div>
    </OverlayView>
  );
}

const LiveTracking = () => {
  const [vehicles, setVehicles] = useState([]);
  const [fetchedAt, setFetchedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeVehicleNo, setActiveVehicleNo] = useState(null);
  // Every driver, for the "reassign tracker" dropdown — not just the ones
  // already mapped to a vehicle (those come back on `vehicles` already).
  const [allDrivers, setAllDrivers] = useState([]);
  const [reassigningVehicleNo, setReassigningVehicleNo] = useState(null);

  const mapInstanceRef = useRef(null);

  const { isLoaded, loadError } = useLoadScript({ googleMapsApiKey: GOOGLE_MAPS_API_KEY });

  const fetchVehicles = useCallback(async () => {
    try {
      setError('');
      const res = await api.get('/truckoom/vehicles');
      setVehicles(res.data?.data || []);
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
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Failed to reassign driver');
    } finally {
      setReassigningVehicleNo(null);
    }
  };

  const locatedVehicles = useMemo(
    () => vehicles.filter((v) => Number.isFinite(v.latitude) && Number.isFinite(v.longitude)),
    [vehicles]
  );

  const handleMapLoad = useCallback((map) => {
    mapInstanceRef.current = map;
  }, []);

  const panToVehicle = (v) => {
    setActiveVehicleNo(v.vehicleNo);
    if (mapInstanceRef.current && Number.isFinite(v.latitude) && Number.isFinite(v.longitude)) {
      mapInstanceRef.current.panTo({ lat: v.latitude, lng: v.longitude });
      mapInstanceRef.current.setZoom(14);
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
            Real GPS from Truckoom — {locatedVehicles.length} of {vehicles.length} vehicles reporting a location
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

      <div className="flex-1 flex min-h-0">
        {/* Vehicle list */}
        <div className="w-80 flex-shrink-0 border-r border-gray-200 bg-white overflow-y-auto">
          {vehicles.length === 0 && !loading ? (
            <p className="p-4 text-sm text-gray-400">No vehicles found.</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {vehicles.map((v) => (
                <li key={v.vehicleNo} className={activeVehicleNo === v.vehicleNo ? 'bg-blue-50' : ''}>
                  <button
                    type="button"
                    onClick={() => panToVehicle(v)}
                    disabled={!Number.isFinite(v.latitude)}
                    className="w-full text-left px-4 pt-3 flex items-center gap-3 hover:bg-gray-50 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
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
                      {!Number.isFinite(v.latitude) && (
                        <p className="text-xs text-amber-600 mt-0.5">No location reported</p>
                      )}
                    </span>
                  </button>
                  <div className="px-4 pb-3 pt-1.5 pl-[52px]">
                    <select
                      value={v.driver?.id || ''}
                      disabled={reassigningVehicleNo === v.vehicleNo}
                      onChange={(e) => handleReassign(v.vehicleNo, e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      className="w-full text-xs border border-gray-200 rounded px-2 py-1 bg-white text-gray-700 disabled:opacity-50"
                    >
                      <option value="">— Unassigned —</option>
                      {allDrivers.map((d) => (
                        <option key={d._id} value={d._id}>{driverDisplayName(d)}</option>
                      ))}
                    </select>
                  </div>
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
              {locatedVehicles.map((v) => (
                <VehicleMarker
                  key={v.vehicleNo}
                  vehicle={v}
                  isActive={activeVehicleNo === v.vehicleNo}
                  onClick={() => setActiveVehicleNo(v.vehicleNo)}
                />
              ))}
            </GoogleMap>
          )}
        </div>
      </div>
    </div>
  );
};

export default LiveTracking;
