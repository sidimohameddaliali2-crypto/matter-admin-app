import React from 'react';
import { MapContainer, TileLayer, Marker, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { recordActivityChange } from '../utils/activityCapture';

const pinIcon = new L.Icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-blue.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

const DEFAULT_CENTER = [25.2048, 55.2708]; // Dubai — used only when no coordinates exist yet

function ClickHandler({ onPick }) {
  useMapEvents({
    click(e) {
      onPick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

// Draggable-pin location editor. lat/lng/onChange are controlled by the parent;
// dragging the marker or clicking anywhere on the map calls onChange(lat, lng).
function LocationPinPicker({ lat, lng, onChange, height = 240, activityLabel = 'Delivery location pin' }) {
  const hasPosition = Number.isFinite(lat) && Number.isFinite(lng);
  const position = hasPosition ? [lat, lng] : DEFAULT_CENTER;
  const pick = (newLat, newLng) => {
    if (!Number.isFinite(newLat) || !Number.isFinite(newLng) || (lat === newLat && lng === newLng)) return;
    recordActivityChange({ field: activityLabel, form: 'Edit delivery', before: hasPosition ? `${lat.toFixed(6)}, ${lng.toFixed(6)}` : 'Not set', after: `${newLat.toFixed(6)}, ${newLng.toFixed(6)}` });
    onChange(newLat, newLng);
  };

  return (
    <div style={{ height }} className="rounded-lg overflow-hidden border border-gray-200">
      <MapContainer center={position} zoom={hasPosition ? 15 : 11} style={{ height: '100%', width: '100%' }}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <Marker
          position={position}
          draggable
          icon={pinIcon}
          eventHandlers={{
            dragend: (e) => {
              const { lat: newLat, lng: newLng } = e.target.getLatLng();
              pick(newLat, newLng);
            },
          }}
        />
        <ClickHandler onPick={pick} />
      </MapContainer>
    </div>
  );
}

export default LocationPinPicker;
