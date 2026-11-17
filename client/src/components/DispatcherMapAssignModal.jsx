import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { GoogleMap, Marker, Circle, Polygon, DrawingManager, useLoadScript, StandaloneSearchBox, InfoWindow } from '@react-google-maps/api';
import api from '../utils/api';
import { recordActivityChange } from '../utils/activityCapture';

// Google Maps API Key - stored server-side to avoid exposure
// Component will request key from backend if needed
const GOOGLE_API_KEY = process.env.REACT_APP_GOOGLE_MAPS_API_KEY || '';
// Dedicated Geocoding API key; falls back to the Maps key.
const GEOCODING_API_KEY = process.env.REACT_APP_GOOGLE_GEOCODING_API_KEY || GOOGLE_API_KEY;
const libraries = ['drawing', 'geometry', 'places'];
const mapContainerStyle = { width: '100%', height: '100%' };

const cityConfigs = {
  Dubai: { center: { lat: 25.2048, lng: 55.2708 }, zoom: 11 },
  'Abu Dhabi': { center: { lat: 24.4539, lng: 54.3773 }, zoom: 11 }
};

async function geocodeAddress(address) {
  try {
    const resp = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GEOCODING_API_KEY}&region=AE`);
    const data = await resp.json();
    if (data.status === 'OK' && data.results && data.results.length > 0) {
      const { lat, lng } = data.results[0].geometry.location;
      return { lat, lng };
    }
  } catch (err) {
    console.error('Geocode error', err);
  }
  return null;
}

function getDeliveryLatLng(delivery) {
  const toNum = (val) => {
    if (typeof val === 'number') return Number.isFinite(val) ? val : null;
    if (typeof val === 'string' && val.trim() !== '') {
      const parsed = parseFloat(val);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  };

  if (delivery?.gpsLocation && (delivery.gpsLocation.lat !== undefined && delivery.gpsLocation.lng !== undefined)) {
    const lat = toNum(delivery.gpsLocation.lat);
    const lng = toNum(delivery.gpsLocation.lng);
    if (lat !== null && lng !== null) return [lat, lng];
  }

  if (delivery?.lat !== undefined && delivery?.lng !== undefined) {
    const lat = toNum(delivery.lat);
    const lng = toNum(delivery.lng);
    if (lat !== null && lng !== null) return [lat, lng];
  }

  if (Array.isArray(delivery?.gpsLocation) && delivery.gpsLocation.length === 2) {
    const lat = toNum(delivery.gpsLocation[0]);
    const lng = toNum(delivery.gpsLocation[1]);
    if (lat !== null && lng !== null) return [lat, lng];
  }

  if (delivery?.location && Array.isArray(delivery.location.coordinates) && delivery.location.coordinates.length >= 2) {
    const lng = toNum(delivery.location.coordinates[0]);
    const lat = toNum(delivery.location.coordinates[1]);
    if (lat !== null && lng !== null) return [lat, lng];
  }

  if (Array.isArray(delivery?.coordinates) && delivery.coordinates.length >= 2) {
    const lng = toNum(delivery.coordinates[0]);
    const lat = toNum(delivery.coordinates[1]);
    if (lat !== null && lng !== null) return [lat, lng];
  }

  if (delivery?.latitude !== undefined && delivery?.longitude !== undefined) {
    const lat = toNum(delivery.latitude);
    const lng = toNum(delivery.longitude);
    if (lat !== null && lng !== null) return [lat, lng];
  }

  return null;
}

function isPointInPolygon(point, polygon) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lat, yi = polygon[i].lng;
    const xj = polygon[j].lat, yj = polygon[j].lng;
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function distanceMeters(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(la1) * Math.cos(la2) * sinDLng * sinDLng;
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function getMarkerColorByHour(delivery) {
  try {
    const scheduled = delivery.scheduledTime ? new Date(delivery.scheduledTime) : null;
    const hour = scheduled && !Number.isNaN(scheduled.getTime()) ? scheduled.getHours() : null;
    if (hour === null) return { color: '#10b981', fill: '#bbf7d0' };
    if (hour >= 3 && hour < 4) return { color: '#8b5cf6', fill: '#e9d5ff' };
    if (hour >= 4 && hour < 5) return { color: '#06b6d4', fill: '#cffafe' };
    if (hour >= 5 && hour < 6) return { color: '#0ea5e9', fill: '#bfdbfe' };
    if (hour >= 6 && hour < 7) return { color: '#3b82f6', fill: '#dbeafe' };
    if (hour >= 7 && hour < 8) return { color: '#f59e0b', fill: '#fde68a' };
    if (hour >= 8 && hour < 9) return { color: '#f97316', fill: '#fed7aa' };
    if (hour >= 9 && hour < 10) return { color: '#ef4444', fill: '#fecaca' };
    if (hour >= 10) return { color: '#dc2626', fill: '#fca5a5' };
    return { color: '#10b981', fill: '#bbf7d0' };
  } catch (err) {
    return { color: '#10b981', fill: '#bbf7d0' };
  }
}

function DispatcherMapAssignModal({ open, onClose, deliveries = [], drivers = [] }) {
  if (!GOOGLE_API_KEY) {
    return (
      open && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-md w-full space-y-3 text-center">
            <div className="text-lg font-semibold text-gray-900">Google Maps key required</div>
            <p className="text-sm text-gray-600">
              Add <span className="font-mono">REACT_APP_GOOGLE_MAPS_API_KEY</span> to your <span className="font-mono">client/.env</span>
              (or environment) with a valid browser Maps API key that has Maps JavaScript API and Places API
              enabled. Then restart the client dev server.
            </p>
            <button
              onClick={onClose}
              className="mt-2 inline-flex items-center justify-center px-4 py-2 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700"
            >
              Close
            </button>
          </div>
        </div>
      )
    );
  }

  const [city, setCity] = useState('Dubai');
  const [center, setCenter] = useState(cityConfigs.Dubai.center);
  const [zoom, setZoom] = useState(cityConfigs.Dubai.zoom);
  const [drawnShape, setDrawnShape] = useState(null);
  const [selectedDeliveryIds, setSelectedDeliveryIds] = useState([]);
  const [selectedDriver, setSelectedDriver] = useState('');
  const [assigning, setAssigning] = useState(false);
  const [failedGeocodes, setFailedGeocodes] = useState([]);
  const [editingDeliveryId, setEditingDeliveryId] = useState(null);
  const [manualPins, setManualPins] = useState({});
  const [hoveredGroupKey, setHoveredGroupKey] = useState(null);
  const [geocodingIds, setGeocodingIds] = useState([]);
  const [deliverySearchTerm, setDeliverySearchTerm] = useState('');
  const [missingAddress, setMissingAddress] = useState([]);
  const [editingDelivery, setEditingDelivery] = useState(null);
  const [editForm, setEditForm] = useState({
    customerName: '',
    customerId: '',
    address: '',
    zone: '',
    notes: '',
    scheduledTime: '',
    lat: '',
    lng: ''
  });
  const [savingEdit, setSavingEdit] = useState(false);
  const mapRef = useRef(null);
  const searchBoxRef = useRef(null);
  const drawingGestureRef = useRef(0);
  const selectionRef = useRef(selectedDeliveryIds);
  selectionRef.current = selectedDeliveryIds;
  const deliveryRef = id => {
    const delivery = deliveries.find(item => (item._id || item.id) === id);
    const name = String(delivery?.customerName || 'Delivery').slice(0, 45);
    const customer = delivery?.customerId ? ` · ${String(delivery.customerId).slice(0, 20)}` : '';
    return `${name}${customer} (${id})`;
  };
  const selectionRefs = ids => ids.map(deliveryRef);
  const changeSelection = next => {
    recordActivityChange({ field: 'Selected deliveries', before: selectionRefs(selectionRef.current), after: selectionRefs(next), form: 'Map assignment' });
    selectionRef.current = next;
    setSelectedDeliveryIds(next);
  };
  const shapeValue = shape => !shape ? 'None' : shape.type === 'circle'
    ? `Circle: ${shape.center.lat.toFixed(6)}, ${shape.center.lng.toFixed(6)}; radius ${shape.radius} metres`
    : shape.path.map(point => `${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}`);
  const pointValue = point => point ? `${Number(point[0]).toFixed(6)}, ${Number(point[1]).toFixed(6)}` : 'Not set';
  const observePin = (id, coords) => {
    const existing = manualPins[id];
    const before = existing ? [existing.lat, existing.lng] : getDeliveryLatLng(deliveries.find(delivery => (delivery._id || delivery.id) === id));
    recordActivityChange({ field: `Location for ${deliveryRef(id)}`, before: pointValue(before), after: pointValue([coords.lat, coords.lng]), form: 'Map assignment' });
  };

  const { isLoaded, loadError } = useLoadScript(
    GOOGLE_API_KEY
      ? { googleMapsApiKey: GOOGLE_API_KEY, libraries }
      : { googleMapsApiKey: '', libraries }
  );

  useEffect(() => {
    if (!open) return;
    const cfg = cityConfigs[city] || cityConfigs.Dubai;
    setCenter(cfg.center);
    setZoom(cfg.zoom);
    setDrawnShape(null);
    setSelectedDeliveryIds([]);
  }, [open, city]);

  useEffect(() => {
    if (!open || !deliveries.length) return;
    const missingCoords = deliveries.filter((d) => getDeliveryLatLng(d) === null);
    setFailedGeocodes(missingCoords);
    const missingAddr = deliveries.filter((d) => !d.address || (typeof d.address === 'string' && d.address.trim() === ''));
    setMissingAddress(missingAddr);
  }, [open, deliveries]);

  const deliveriesWithCoords = useMemo(() => {
    return deliveries
      .map((d) => {
        let latlng = getDeliveryLatLng(d);
        if (manualPins[d._id]) {
          latlng = [manualPins[d._id].lat, manualPins[d._id].lng];
        }
        return { d, latlng };
      })
      .filter((x) => x.latlng && x.latlng.length === 2);
  }, [deliveries, manualPins]);

  const deliveryGroups = useMemo(() => {
    const groups = new Map();
    deliveriesWithCoords.forEach(({ d, latlng }) => {
      const key = `${latlng[0]}|${latlng[1]}`;
      if (!groups.has(key)) {
        groups.set(key, { key, position: { lat: latlng[0], lng: latlng[1] }, deliveries: [] });
      }
      groups.get(key).deliveries.push(d);
    });
    return Array.from(groups.values());
  }, [deliveriesWithCoords]);

  const computeSelected = useCallback((shape = drawnShape) => {
    if (!shape) return [];

    if (shape.type === 'circle' && shape.center && shape.radius) {
      const centerLatLng = shape.center;
      const radiusMeters = Number(shape.radius);
      return deliveriesWithCoords
        .filter(({ latlng }) => distanceMeters({ lat: latlng[0], lng: latlng[1] }, centerLatLng) <= radiusMeters)
        .map(({ d }) => d._id || d.id)
        .filter(Boolean);
    }

    if (shape.type === 'polygon' && Array.isArray(shape.path)) {
      return deliveriesWithCoords
        .filter(({ latlng }) => isPointInPolygon(latlng, shape.path))
        .map(({ d }) => d._id || d.id)
        .filter(Boolean);
    }

    return [];
  }, [deliveriesWithCoords, drawnShape]);

  useEffect(() => {
    setSelectedDeliveryIds(computeSelected());
  }, [drawnShape, deliveriesWithCoords, computeSelected]);

  // Observe geometry only at its manual boundary. Recalculation after a delivery
  // load is kept out of capture so hydration cannot impersonate a user edit.
  const changeShape = next => {
    recordActivityChange({ field: 'Map selection shape', before: shapeValue(drawnShape), after: shapeValue(next), form: 'Map assignment' });
    changeSelection(computeSelected(next));
    setDrawnShape(next);
  };

  const deliverySearchResults = useMemo(() => {
    const term = deliverySearchTerm.trim().toLowerCase();
    if (!term) return deliveries.slice(0, 20);
    return deliveries
      .filter((d) => {
        const name = (d.customerName || d.customerId || '').toLowerCase();
        const addr = (d.address || '').toLowerCase();
        const zone = (d.zone || '').toLowerCase();
        return name.includes(term) || addr.includes(term) || zone.includes(term);
      })
      .slice(0, 20);
  }, [deliverySearchTerm, deliveries]);

  const toggleDeliverySelection = id => {
    const previous = selectionRef.current;
    changeSelection(previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id]);
  };

  const focusDeliveryOnMap = useCallback((delivery) => {
    if (!delivery) return;
    const id = delivery._id || delivery.id;
    const manual = id && manualPins[id] ? [manualPins[id].lat, manualPins[id].lng] : null;
    const latlng = manual || getDeliveryLatLng(delivery);
    if (!latlng) {
      alert('No coordinates found for this delivery');
      return;
    }
    if (mapRef.current) {
      const nextCenter = { lat: latlng[0], lng: latlng[1] };
      mapRef.current.panTo(nextCenter);
      mapRef.current.setZoom(15);
      setCenter(nextCenter);
      setZoom(15);
    }
  }, [manualPins]);

  const startEditingDelivery = useCallback((delivery) => {
    if (!delivery) return;
    const id = delivery._id || delivery.id;
    const manual = id && manualPins[id] ? [manualPins[id].lat, manualPins[id].lng] : null;
    const latlng = manual || getDeliveryLatLng(delivery);
    const scheduled = delivery.scheduledTime ? new Date(delivery.scheduledTime) : null;
    const scheduledValue = scheduled && !Number.isNaN(scheduled.getTime()) ? scheduled.toISOString().slice(0, 16) : '';
    setEditingDelivery(delivery);
    setEditForm({
      customerName: delivery.customerName || '',
      customerId: delivery.customerId || '',
      address: delivery.address || '',
      zone: delivery.zone || '',
      notes: delivery.notes || '',
      scheduledTime: scheduledValue,
      lat: latlng ? String(latlng[0]) : '',
      lng: latlng ? String(latlng[1]) : ''
    });
    focusDeliveryOnMap(delivery);
  }, [focusDeliveryOnMap, manualPins]);

  const handleEditFieldChange = (field, value) => {
    setEditForm((prev) => ({ ...prev, [field]: value }));
  };

  const saveEditedDelivery = async () => {
    if (!editingDelivery) return;
    const id = editingDelivery._id || editingDelivery.id;
    if (!id) {
      alert('Delivery id missing');
      return;
    }

    const payload = {
      address: editForm.address?.trim(),
      zone: editForm.zone?.trim(),
      notes: editForm.notes?.trim()
    };

    if (editForm.customerName) payload.customerName = editForm.customerName.trim();
    if (editForm.customerId) payload.customerId = editForm.customerId.trim();
    if (editForm.scheduledTime) payload.scheduledTime = editForm.scheduledTime;

    const latNum = parseFloat(editForm.lat);
    const lngNum = parseFloat(editForm.lng);
    if (!Number.isNaN(latNum) && !Number.isNaN(lngNum)) {
      payload.gpsLocation = { lat: latNum, lng: lngNum };
    }

    setSavingEdit(true);
    try {
      const resp = await api.put(`/api/deliveries/${id}`, payload);
      const updated = resp?.data?.data?.delivery || resp?.data?.data || resp?.data;
      const nextGps = updated?.gpsLocation || payload.gpsLocation;
      if (nextGps && nextGps.lat !== undefined && nextGps.lng !== undefined) {
        setManualPins((prev) => ({ ...prev, [id]: { lat: nextGps.lat, lng: nextGps.lng } }));
        focusDeliveryOnMap({ ...editingDelivery, gpsLocation: nextGps });
      }
      alert('Delivery updated');
    } catch (err) {
      console.error('Failed to update delivery', err);
      alert('Failed to update delivery');
    } finally {
      setSavingEdit(false);
    }
  };

  const handleAssign = async () => {
    if (!selectedDriver) return alert('Please select a driver');
    if (!selectedDeliveryIds.length) return alert('No deliveries selected');
    try {
      setAssigning(true);
      await api.patch('/api/deliveries/assign-driver', {
        deliveryIds: selectedDeliveryIds,
        driverId: selectedDriver
      });
      alert('Assigned ' + selectedDeliveryIds.length + ' deliveries');
      if (onClose) onClose();
    } catch (err) {
      console.error(err);
      alert('Failed to assign deliveries');
    } finally {
      setAssigning(false);
    }
  };

  const retryGeocode = async (delivery) => {
    if (!delivery?.address) return alert('No address available');
    const id = delivery._id || delivery.id;
    const initiatingToken = window.localStorage.getItem('token');
    const initiatingPage = window.location.pathname;
    setGeocodingIds((prev) => [...prev, id]);
    try {
      const coords = await geocodeAddress(delivery.address);
      if (!coords) {
        alert('Geocode failed');
        return;
      }
      if (window.localStorage.getItem('token') === initiatingToken && window.location.pathname === initiatingPage) observePin(id, coords);
      await api.patch(`/deliveries/${id}`, { gpsLocation: { lat: coords.lat, lng: coords.lng }, lat: coords.lat, lng: coords.lng });
      setFailedGeocodes((prev) => prev.filter((d) => (d._id || d.id) !== id));
    } catch (err) {
      console.error('Retry geocode failed', err);
      alert('Retry geocode failed');
    } finally {
      setGeocodingIds((prev) => prev.filter((x) => x !== id));
    }
  };

  const retryAllGeocodes = async () => {
    if (!failedGeocodes.length) return;
    for (const d of failedGeocodes) {
      // eslint-disable-next-line no-await-in-loop
      await retryGeocode(d);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white">
      <div className="flex items-center justify-between p-3 border-b">
        <div className="flex items-center gap-3">
          <h3 className="font-semibold">Map Assign - {city}</h3>
          <select value={city} onChange={(e) => { changeShape(null); setCity(e.target.value); }} className="px-2 py-1 border rounded">
            <option>Dubai</option>
            <option>Abu Dhabi</option>
          </select>
          <button type="button" onClick={() => changeShape(null)} className="px-2 py-1 bg-gray-100 rounded">Reset</button>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onClose} className="px-3 py-1 rounded bg-white border">Close</button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 h-full relative"
          onPointerDownCapture={event => { if (event.target.closest('button,[role="button"]')) drawingGestureRef.current = Date.now(); }}
          onKeyDownCapture={event => { if (['Enter', ' '].includes(event.key) && event.target.closest('button,[role="button"]')) drawingGestureRef.current = Date.now(); }}>
          {isLoaded && !loadError && (
            <div className="absolute z-10 top-3 left-1/2 -translate-x-1/2 shadow-lg">
              <StandaloneSearchBox
                onLoad={(ref) => (searchBoxRef.current = ref)}
                onPlacesChanged={() => {
                  const places = searchBoxRef.current?.getPlaces();
                  if (!places || !places.length) return;
                  const loc = places[0].geometry?.location;
                  if (!loc) return;
                  const lat = loc.lat();
                  const lng = loc.lng();
                  const nextCenter = { lat, lng };
                  recordActivityChange({ field: 'Map centre', before: pointValue([center.lat, center.lng]), after: pointValue([lat, lng]), form: 'Map assignment' });
                  setCenter(nextCenter);
                  setZoom((z) => (z < 14 ? 14 : z));
                  if (mapRef.current) {
                    mapRef.current.panTo(nextCenter);
                    mapRef.current.setZoom(14);
                  }
                }}
              >
                <input
                  type="text"
                  placeholder="Search address or place"
                  className="w-64 px-3 py-2 text-sm border border-gray-300 rounded shadow bg-white focus:outline-none focus:ring focus:ring-blue-200"
                />
              </StandaloneSearchBox>
            </div>
          )}
          {!isLoaded ? (
            <div className="flex items-center justify-center h-full">Loading map...</div>
          ) : loadError ? (
            <div className="flex items-center justify-center h-full text-red-600">Failed to load Google Maps</div>
          ) : (
            <GoogleMap
              mapContainerStyle={mapContainerStyle}
              center={center}
              zoom={zoom}
              onLoad={(map) => (mapRef.current = map)}
              onClick={(e) => {
                if (editingDeliveryId && e.latLng) {
                  const lat = e.latLng.lat();
                  const lng = e.latLng.lng();
                  observePin(editingDeliveryId, { lat, lng });
                  setManualPins((prev) => ({ ...prev, [editingDeliveryId]: { lat, lng } }));
                  api.patch(`/deliveries/${editingDeliveryId}`, { gpsLocation: { lat, lng } })
                    .then(() => {
                      setEditingDeliveryId(null);
                      alert('Pin saved successfully');
                    })
                    .catch((err) => {
                      console.error('Failed to save pin:', err);
                      alert('Failed to save pin');
                    });
                }
              }}
              options={{
                mapTypeControl: false,
                streetViewControl: false,
                fullscreenControl: true,
                gestureHandling: 'greedy'
              }}
            >
              <DrawingManager
                options={{
                  drawingControl: true,
                  drawingControlOptions: {
                    drawingModes: ['polygon', 'circle']
                  },
                  polygonOptions: {
                    fillColor: '#3b82f6',
                    fillOpacity: 0.15,
                    strokeColor: '#2563eb',
                    strokeWeight: 2
                  },
                  circleOptions: {
                    fillColor: '#22c55e',
                    fillOpacity: 0.1,
                    strokeColor: '#16a34a',
                    strokeWeight: 2
                  }
                }}
                onOverlayComplete={(e) => {
                  drawingGestureRef.current = 0;
                  const overlay = e.overlay;
                  const type = e.type;
                  if (type === 'circle') {
                    const center = overlay.getCenter();
                    const radius = overlay.getRadius();
                    changeShape({ type: 'circle', center: { lat: center.lat(), lng: center.lng() }, radius });
                  } else if (type === 'polygon') {
                    const path = overlay.getPath().getArray().map((p) => ({ lat: p.lat(), lng: p.lng() }));
                    changeShape({ type: 'polygon', path });
                  }
                  overlay.setMap(null);
                }}
                onDrawingModeChanged={() => {
                  // Maps also invokes this while mounting/updating. Only an
                  // immediately preceding toolbar gesture is a browser edit.
                  const manual = drawingGestureRef.current && Date.now() - drawingGestureRef.current < 1000;
                  drawingGestureRef.current = 0;
                  if (manual) changeShape(null);
                  else { setDrawnShape(null); setSelectedDeliveryIds([]); }
                }}
              />

              {deliveryGroups.map(({ key, position, deliveries }) => {
                const topDelivery = deliveries[0];
                const colors = getMarkerColorByHour(topDelivery);
                const scheduledLabel = topDelivery.scheduledTime
                  ? new Date(topDelivery.scheduledTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                  : 'No time';
                const duplicateCount = deliveries.length;
                const isDuplicate = duplicateCount > 1;
                const label = isDuplicate ? {
                  text: String(duplicateCount),
                  color: '#ffffff',
                  fontSize: '12px',
                  fontWeight: '700'
                } : undefined;
                const deliveryIds = deliveries.map((item) => item._id || item.id).filter(Boolean);
                const allSelected = deliveryIds.length > 0 && deliveryIds.every((id) => selectedDeliveryIds.includes(id));

                const toggleGroupSelection = () => {
                  if (!deliveryIds.length) return;
                  const previous = selectionRef.current;
                  const areAllSelected = deliveryIds.every(id => previous.includes(id));
                  const next = areAllSelected ? previous.filter(id => !deliveryIds.includes(id)) : [...previous, ...deliveryIds.filter(id => !previous.includes(id))];
                  changeSelection(next);
                };

                return (
                  <React.Fragment key={key}>
                    <Marker
                      position={position}
                      icon={window.google && window.google.maps ? {
                        path: window.google.maps.SymbolPath.CIRCLE,
                        scale: isDuplicate ? 12 : 8,
                        fillColor: isDuplicate ? '#ff1493' : colors.color,
                        fillOpacity: 1,
                        strokeColor: '#fff',
                        strokeWeight: isDuplicate ? 3 : 2
                      } : undefined}
                      label={label}
                      title={`${topDelivery.customerName || topDelivery.customerId || 'Delivery'} • ${scheduledLabel}`}
                      onClick={toggleGroupSelection}
                      onMouseOver={() => setHoveredGroupKey(key)}
                      onMouseOut={() => setHoveredGroupKey((prev) => (prev === key ? null : prev))}
                    />
                    {hoveredGroupKey === key && (
                      <InfoWindow
                        position={position}
                        onCloseClick={() => setHoveredGroupKey(null)}
                      >
                        <div className="text-xs space-y-2 max-w-[260px]">
                          <div className="font-semibold">
                            {duplicateCount > 1 ? `${duplicateCount} deliveries at this address` : topDelivery.customerName || topDelivery.customerId || 'Delivery'}
                          </div>
                          <div className="text-gray-700">{topDelivery.address}</div>
                          <div className="divide-y divide-gray-200 border-y border-gray-200">
                            {deliveries.map((item, idx) => {
                              const id = item._id || item.id;
                              const timeLabel = item.scheduledTime
                                ? new Date(item.scheduledTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                                : 'No time';
                              const selected = id ? selectedDeliveryIds.includes(id) : false;
                              return (
                                <div key={id || `${key}-${idx}`} className="py-1 flex items-start justify-between gap-2">
                                  <div>
                                    <div className="font-semibold">{item.customerName || item.customerId || 'Delivery'}</div>
                                    <div className="text-gray-600">{timeLabel}</div>
                                  </div>
                                  {id && (
                                    <div className="flex flex-col items-end gap-1">
                                      <button
                                        onClick={() => startEditingDelivery(item)}
                                        className="text-[11px] px-2 py-1 border rounded bg-white hover:bg-gray-50"
                                      >
                                        Edit
                                      </button>
                                      <button
                                        onClick={() => toggleDeliverySelection(id)}
                                        className="text-[11px] px-2 py-1 border rounded bg-white hover:bg-gray-50"
                                      >
                                        {selected ? 'Unselect' : 'Select'}
                                      </button>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                          {duplicateCount > 1 && deliveryIds.length > 0 && (
                            <button
                              onClick={toggleGroupSelection}
                              className="w-full text-[11px] px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700"
                            >
                              {allSelected ? 'Unselect all here' : 'Select all here'}
                            </button>
                          )}
                        </div>
                      </InfoWindow>
                    )}
                  </React.Fragment>
                );
              })}

              {drawnShape && drawnShape.type === 'circle' && (
                <Circle
                  center={drawnShape.center}
                  radius={drawnShape.radius}
                  options={{ strokeColor: '#2563eb', fillColor: '#3b82f6', fillOpacity: 0.15 }}
                />
              )}

              {drawnShape && drawnShape.type === 'polygon' && (
                <Polygon
                  paths={drawnShape.path}
                  options={{ strokeColor: '#2563eb', fillColor: '#3b82f6', fillOpacity: 0.15 }}
                />
              )}

              {Object.entries(manualPins).map(([id, coords]) => (
                <Marker
                  key={`manual-${id}`}
                  position={{ lat: coords.lat, lng: coords.lng }}
                  icon={window.google && window.google.maps ? {
                    path: window.google.maps.SymbolPath.BACKWARD_CLOSED_ARROW,
                    scale: 6,
                    fillColor: '#f97316',
                    fillOpacity: 1,
                    strokeColor: '#fff',
                    strokeWeight: 2
                  } : undefined}
                  title="Manual pin"
                />
              ))}
            </GoogleMap>
          )}
        </div>

        <div className="w-72 border-l overflow-y-auto bg-white shadow-md">
          <div className="p-3 border-b">
            <div className="text-sm font-semibold">Search deliveries</div>
            <input
              value={deliverySearchTerm}
              onChange={(e) => setDeliverySearchTerm(e.target.value)}
              placeholder="Search by name, id, or address"
              className="mt-2 w-full px-2 py-1 border rounded text-sm"
            />
            <div className="mt-2 max-h-40 overflow-y-auto divide-y divide-gray-100">
              {deliverySearchResults.map((d) => {
                const id = d._id || d.id;
                return (
                  <div key={id} className="py-2 flex items-start justify-between gap-2">
                    <div className="text-xs">
                      <div className="font-semibold">{d.customerName || d.customerId || 'Delivery'}</div>
                      <div className="text-gray-600 truncate max-w-[140px]">{d.address || 'No address'}</div>
                    </div>
                    <div className="flex flex-col gap-1 items-end">
                      <button
                        onClick={() => focusDeliveryOnMap(d)}
                        className="px-2 py-1 text-[11px] border rounded bg-white hover:bg-gray-50"
                      >
                        Focus
                      </button>
                      <button
                        onClick={() => startEditingDelivery(d)}
                        className="px-2 py-1 text-[11px] border rounded bg-white hover:bg-gray-50"
                      >
                        Edit
                      </button>
                    </div>
                  </div>
                );
              })}
              {!deliverySearchResults.length && (
                <div className="text-xs text-gray-500 py-2">No matches</div>
              )}
            </div>
          </div>

          {missingAddress.length > 0 && (
            <div className="p-3 border-b bg-yellow-50 border-yellow-200">
              <div className="text-sm font-semibold text-yellow-800">Missing address ({missingAddress.length})</div>
              <div className="mt-2 max-h-32 overflow-y-auto text-xs divide-y divide-yellow-100">
                {missingAddress.slice(0, 50).map((d) => (
                  <div key={d._id || d.id || d.customerId} className="py-2">
                    <div className="font-medium">{d.customerName || d.customerId || 'Delivery'}</div>
                    <div className="text-yellow-700">Address not captured</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="p-3 border-b">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">Edit delivery</div>
              {editingDelivery && (
                <button
                  onClick={() => {
                    setEditingDelivery(null);
                    setEditForm({ customerName: '', customerId: '', address: '', zone: '', notes: '', scheduledTime: '', lat: '', lng: '' });
                  }}
                  className="text-xs text-blue-600"
                >
                  Clear
                </button>
              )}
            </div>
            {!editingDelivery ? (
              <div className="text-xs text-gray-500 mt-1">Select a delivery from the map or search results to edit details or coordinates.</div>
            ) : (
              <form className="mt-3 space-y-2" onSubmit={(e) => { e.preventDefault(); saveEditedDelivery(); }}>
                <div>
                  <label className="text-xs text-gray-600">Customer name</label>
                  <input
                    value={editForm.customerName}
                    onChange={(e) => handleEditFieldChange('customerName', e.target.value)}
                    className="mt-1 w-full px-2 py-1 border rounded text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-600">Customer ID</label>
                  <input
                    value={editForm.customerId}
                    onChange={(e) => handleEditFieldChange('customerId', e.target.value)}
                    className="mt-1 w-full px-2 py-1 border rounded text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-600">Address</label>
                  <input
                    value={editForm.address}
                    onChange={(e) => handleEditFieldChange('address', e.target.value)}
                    className="mt-1 w-full px-2 py-1 border rounded text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-600">Zone</label>
                  <input
                    value={editForm.zone}
                    onChange={(e) => handleEditFieldChange('zone', e.target.value)}
                    className="mt-1 w-full px-2 py-1 border rounded text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-600">Scheduled time</label>
                  <input
                    type="datetime-local"
                    value={editForm.scheduledTime}
                    onChange={(e) => handleEditFieldChange('scheduledTime', e.target.value)}
                    className="mt-1 w-full px-2 py-1 border rounded text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-600">Notes</label>
                  <textarea
                    value={editForm.notes}
                    onChange={(e) => handleEditFieldChange('notes', e.target.value)}
                    className="mt-1 w-full px-2 py-1 border rounded text-sm"
                    rows={2}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-gray-600">Latitude</label>
                    <input
                      value={editForm.lat}
                      onChange={(e) => handleEditFieldChange('lat', e.target.value)}
                      className="mt-1 w-full px-2 py-1 border rounded text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-gray-600">Longitude</label>
                    <input
                      value={editForm.lng}
                      onChange={(e) => handleEditFieldChange('lng', e.target.value)}
                      className="mt-1 w-full px-2 py-1 border rounded text-sm"
                    />
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={savingEdit}
                  className="w-full px-3 py-2 bg-blue-600 text-white rounded disabled:opacity-50"
                >
                  {savingEdit ? 'Saving...' : 'Save changes'}
                </button>
              </form>
            )}
          </div>

          {failedGeocodes.length > 0 && (
            <div className="mb-3 p-3 bg-red-50 border-b border-red-200">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-red-700">Failed Geocodes ({failedGeocodes.length})</div>
                <button
                  onClick={retryAllGeocodes}
                  className="px-2 py-1 text-xs bg-red-600 text-white rounded disabled:opacity-50"
                  disabled={!failedGeocodes.length || geocodingIds.length > 0}
                >
                  {geocodingIds.length ? 'Retrying...' : 'Retry all'}
                </button>
              </div>
              <div className="mt-2 max-h-32 overflow-y-auto">
                {failedGeocodes.map((d) => (
                  <div key={d._id || d.id} className="flex items-center justify-between p-2 border-b text-xs">
                    <div>
                      <div className="font-medium">{d.customerName || d.customerId}</div>
                      <div className="text-gray-600 truncate">{d.address}</div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => retryGeocode(d)}
                        disabled={geocodingIds.includes(d._id || d.id)}
                        className="px-2 py-1 bg-red-500 text-white rounded text-xs disabled:opacity-50"
                      >
                        {geocodingIds.includes(d._id || d.id) ? 'Retrying' : 'Re-geocode'}
                      </button>
                      <button
                        onClick={() => setEditingDeliveryId(d._id || d.id)}
                        disabled={editingDeliveryId === (d._id || d.id)}
                        className="px-2 py-1 bg-blue-500 text-white rounded text-xs disabled:opacity-50"
                      >
                        {editingDeliveryId === (d._id || d.id) ? 'Click map' : 'Pin'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mb-3 p-3 border-b">
            <div className="mb-2">
              <div className="text-sm font-semibold">Legend (by Scheduled Time)</div>
              <div className="mt-2 grid grid-cols-1 gap-2 text-xs">
                <div className="flex items-center gap-2"><span className="w-4 h-4 rounded-sm" style={{ background: '#8b5cf6' }} /><span>03:00 - 03:59 (3AM)</span></div>
                <div className="flex items-center gap-2"><span className="w-4 h-4 rounded-sm" style={{ background: '#06b6d4' }} /><span>04:00 - 04:59 (4AM)</span></div>
                <div className="flex items-center gap-2"><span className="w-4 h-4 rounded-sm" style={{ background: '#0ea5e9' }} /><span>05:00 - 05:59 (5AM)</span></div>
                <div className="flex items-center gap-2"><span className="w-4 h-4 rounded-sm" style={{ background: '#3b82f6' }} /><span>06:00 - 06:59 (6AM)</span></div>
                <div className="flex items-center gap-2"><span className="w-4 h-4 rounded-sm" style={{ background: '#f59e0b' }} /><span>07:00 - 07:59 (7AM)</span></div>
                <div className="flex items-center gap-2"><span className="w-4 h-4 rounded-sm" style={{ background: '#f97316' }} /><span>08:00 - 08:59 (8AM)</span></div>
                <div className="flex items-center gap-2"><span className="w-4 h-4 rounded-sm" style={{ background: '#ef4444' }} /><span>09:00 - 09:59 (9AM)</span></div>
                <div className="flex items-center gap-2"><span className="w-4 h-4 rounded-sm" style={{ background: '#dc2626' }} /><span>10:00+ (10AM+)</span></div>
                <div className="flex items-center gap-2"><span className="w-4 h-4 rounded-sm" style={{ background: '#10b981' }} /><span>Unknown / Default</span></div>
              </div>
            </div>
          </div>

          <div className="mb-3">
            <div className="text-sm text-gray-600 font-semibold"> Draw with the polygon or circle tool to select deliveries</div>
            <div className="text-xs text-gray-500 mt-1">Selections update automatically as you draw. Use the reset button to clear.</div>
          </div>

          <div className="mb-3">
            <div className="text-sm font-semibold">Deliveries in selection</div>
            <div className="text-xs text-gray-500">{selectedDeliveryIds.length} deliveries</div>
            <div className="mt-2 max-h-48 overflow-y-auto">
              {deliveriesWithCoords.filter(({ d }) => selectedDeliveryIds.includes(d._id || d.id)).map(({ d }) => (
                <div key={d._id || d.id} className="flex items-center justify-between p-2 border-b">
                  <div>
                    <div className="font-medium text-sm">{d.customerName || d.customerId || d._id}</div>
                    <div className="text-xs text-gray-500 truncate">{d.address}</div>
                  </div>
                  <div className="text-xs text-gray-500">{d._id ? d._id.substring(0, 6) : ''}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="mb-3 p-3 border-b">
            <label className="text-sm">Assign to driver</label>
            <select value={selectedDriver} onChange={(e) => setSelectedDriver(e.target.value)} className="w-full mt-1 px-2 py-1 border rounded">
              <option value="">Select driver</option>
              {drivers.map((drv) => {
                const name = drv?.profile ? `${drv.profile.firstName || ''} ${drv.profile.lastName || ''}`.trim() : drv.email || drv._id;
                return (
                  <option key={drv._id} value={drv._id}>{name}</option>
                );
              })}
            </select>
          </div>

          <div className="p-3 border-t">
            <button onClick={handleAssign} disabled={assigning || !selectedDriver || !selectedDeliveryIds.length} className="w-full px-3 py-2 bg-blue-600 text-white rounded disabled:opacity-50">
              {assigning ? 'Assigning...' : 'Assign (' + selectedDeliveryIds.length + ')'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default DispatcherMapAssignModal;
