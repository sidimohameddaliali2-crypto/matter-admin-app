import Delivery from '../models/Delivery.js';
import { reverseGeocode } from './reverseGeocode.js';

// The driver app reports WHERE a delivery was dropped off as coordinates only
// (proof.location = { lat, lng }). This labels that spot with a street address
// (owner, 2026-10-13) and saves it on the delivery, so the lookup happens once.
// Never throws, and never changes where the delivery is pinned.

const coordsOf = (location) => {
  if (!location) return null;
  const lat = Number(location.lat ?? location.latitude);
  const lng = Number(location.lng ?? location.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
};

// Returns the drop-off address ('' / null when there is none), looking it up
// and persisting it if the delivery has coordinates but no address yet.
export async function resolveProofAddress(delivery) {
  try {
    const plain = typeof delivery?.toObject === 'function' ? delivery.toObject() : delivery;
    const location = plain?.proof?.location;
    if (!location) return null;
    if (location.address) return location.address;

    const coords = coordsOf(location);
    if (!coords) return null;

    const address = await reverseGeocode(coords.lat, coords.lng);
    if (!address) return null;

    await Delivery.updateOne(
      {
        _id: plain._id,
        $or: [{ 'proof.location.address': { $exists: false } }, { 'proof.location.address': null }, { 'proof.location.address': '' }]
      },
      { $set: { 'proof.location.address': address } }
    );
    return address;
  } catch (err) {
    console.warn('[proof-address] failed (ignored):', err.message);
    return null;
  }
}

// For the driver's request path: kick the lookup off and return immediately.
export function fillProofAddressInBackground(delivery) {
  resolveProofAddress(delivery).catch(() => {});
}

// For the detail view: wait for the lookup, but never longer than `ms`.
export async function resolveProofAddressWithin(delivery, ms = 2500) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try {
    return await Promise.race([resolveProofAddress(delivery), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
