import React from 'react';
import { Link } from 'react-router-dom';
import { toBusinessComponents } from '../../utils/businessTime';
import { haversineKm } from '../../utils/deliveryCoords';
import TrackerVisitCard from './TrackerVisitCard';

// Owner (2026-10-10): "remove the action button, clicking a delivery should
// open a modal inside the app without navigating to another page, and
// closing it should not refresh the entire delivery page." This replaces
// the old RowActionsMenu → /deliveries/:id navigation with an in-place
// view. Deliveries.js already fetches full delivery documents (no field
// projection on the server), so this needs no extra API call — and its
// onClose is a plain state reset, no fetchDeliveries() call, so closing
// never reloads the table.

const STATUS_LABELS = {
  pending: 'Pending',
  assigned: 'Assigned',
  on_route: 'On Route',
  picked_up: 'Picked Up',
  delivered: 'Delivered',
  completed: 'Completed',
  collected: 'Collected',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const formatDateTime = (value) => {
  if (!value) return null;
  const c = toBusinessComponents(value);
  if (!c) return null;
  const month = String(c.month + 1).padStart(2, '0');
  const day = String(c.day).padStart(2, '0');
  let hours = c.hours;
  const minutes = String(c.minutes).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${month}/${day}/${c.year} ${String(hours).padStart(2, '0')}:${minutes} ${ampm}`;
};

const getDriverDisplayName = (driver) => {
  if (!driver) return null;
  const firstName = driver.profile?.firstName || driver.firstName;
  const lastName = driver.profile?.lastName || driver.lastName;
  return [firstName, lastName].filter(Boolean).join(' ').trim() || driver.email || 'Driver';
};

const getActualDeliveryTime = (delivery) => (
  delivery.completedAt || delivery.deliveredTime || delivery.collectionDetails?.collectedAt || null
);

function Field({ label, children }) {
  if (children === null || children === undefined || children === '') return null;
  return (
    <div>
      <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide">{label}</div>
      <div className="text-sm text-gray-900 mt-0.5">{children}</div>
    </div>
  );
}

export default function DeliveryDetailModal({ delivery, onClose }) {
  if (!delivery) return null;

  const statusLabel = STATUS_LABELS[delivery.status] || delivery.status || 'Unknown';
  const driverName = getDriverDisplayName(delivery.driver);
  const actualTime = formatDateTime(getActualDeliveryTime(delivery));
  const scheduledTime = formatDateTime(delivery.scheduledTime);
  const timeline = Array.isArray(delivery.timeline) ? [...delivery.timeline].reverse() : [];
  const proofImages = delivery.proof?.images || [];

  // Where the driver's phone actually was when they confirmed delivery —
  // kept separate from the address pin (gpsLocation) since the server no
  // longer overwrites one with the other. Only worth showing when it's
  // meaningfully different from the address (owner, 2026-10-10: "add the
  // other location as the location that the driver delivered to").
  const proofLoc = delivery.proof?.location;
  const addressLoc = delivery.gpsLocation;
  let deliveredToDriftM = null;
  if (
    proofLoc && Number.isFinite(proofLoc.lat) && Number.isFinite(proofLoc.lng)
    && addressLoc && Number.isFinite(addressLoc.lat) && Number.isFinite(addressLoc.lng)
  ) {
    const driftKm = haversineKm(addressLoc.lat, addressLoc.lng, proofLoc.lat, proofLoc.lng);
    if (driftKm > 0.05) deliveredToDriftM = Math.round(driftKm * 1000);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-xl max-h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-5 py-4 border-b border-gray-200">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">{delivery.customerName || 'Customer'}</h2>
            <p className="text-xs text-gray-400 font-mono mt-0.5">ID: {delivery.customerId}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-gray-100 text-gray-500"
            aria-label="Close"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Status">{statusLabel}</Field>
            <Field label="Type">{delivery.type || 'Delivery'}</Field>
            <Field label="Company">{delivery.company}</Field>
            <Field label="Area">{delivery.zone}</Field>
            <Field label="Driver">{driverName || <span className="italic text-gray-400">Unassigned</span>}</Field>
            <Field label="Scheduled">{scheduledTime}</Field>
            <Field label="Delivered">
              {actualTime ? <span className="text-emerald-600 font-medium">{actualTime}</span> : <span className="text-gray-400">Not delivered yet</span>}
            </Field>
            {delivery.lateMinutes > 0 && <Field label="Late by"><span className="text-red-600 font-medium">{delivery.lateMinutes} min</span></Field>}
            {delivery.earlyMinutes > 0 && <Field label="Early by"><span className="text-yellow-600 font-medium">{delivery.earlyMinutes} min</span></Field>}
          </div>

          <Field label="Address">{delivery.address}</Field>
          {deliveredToDriftM !== null && (
            <Field label="Delivered to">
              <span className="text-red-700">
                A different spot, {deliveredToDriftM}m from the address —{' '}
                <a
                  href={`https://www.google.com/maps?q=${proofLoc.lat},${proofLoc.lng}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline font-medium"
                >
                  view location
                </a>
              </span>
            </Field>
          )}
          <Field label="Notes">{delivery.notes}</Field>
          <TrackerVisitCard delivery={delivery} />

          {proofImages.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5">Proof</div>
              <div className="flex gap-2 flex-wrap">
                {proofImages.map((img, i) => (
                  <a key={i} href={img.url || img} target="_blank" rel="noopener noreferrer">
                    <img src={img.url || img} alt="Proof" className="w-16 h-16 object-cover rounded-lg border border-gray-200" />
                  </a>
                ))}
              </div>
            </div>
          )}

          {timeline.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5">Timeline</div>
              <ul className="space-y-2">
                {timeline.map((entry, i) => (
                  <li key={entry._id || i} className="text-sm">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-gray-800 capitalize">{String(entry.status || '').replace(/_/g, ' ')}</span>
                      <span className="text-xs text-gray-400 font-mono">{formatDateTime(entry.timestamp)}</span>
                    </div>
                    {entry.notes && <p className="text-xs text-gray-500 mt-0.5">{entry.notes}</p>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-200 flex items-center justify-between">
          <Link
            to={`/deliveries/${delivery._id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-blue-600 hover:underline font-medium"
          >
            Open full page
          </Link>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-medium text-gray-700 border border-gray-300 hover:bg-gray-50"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
