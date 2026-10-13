import axios from 'axios';
import { cacheGet, cacheSet } from '../config/cache.js';
import { isPlausibleCoordinate } from './geocoding.js';

// Coordinates -> street address ("where is this driver" / "where was this
// delivery dropped off"). Owner, 2026-10-13: the driver app only sends
// latitude/longitude, so the server looks the address up. This is REVERSE
// geocoding and is separate from the (switched-off) automatic address -> pin
// guessing in geocoding.js: it never changes where a delivery is pinned, it
// only labels a location the phone already reported.
//
// Cost control (Google bills per lookup):
//  - results are cached by rounded coordinates (Redis when up, in-process
//    otherwise), positives for 30 days, "no address found" for 10 minutes;
//  - concurrent lookups of the same spot share one request;
//  - live driver positions use ~110 m rounding and are re-resolved at most
//    once per DRIVER_MIN_INTERVAL_MS per driver (see addressForDriver).
// Set REVERSE_GEOCODE_DISABLED=1 to turn it off entirely (returns null).

const API_KEY = process.env.GOOGLE_GEOCODING_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
const TIMEOUT_MS = Number.parseInt(process.env.REVERSE_GEOCODE_TIMEOUT_MS || '6000', 10);
const POSITIVE_TTL_S = 30 * 24 * 3600;
const NEGATIVE_TTL_S = 10 * 60;
const DRIVER_MIN_INTERVAL_MS = Number.parseInt(process.env.REVERSE_GEOCODE_DRIVER_INTERVAL_MS || String(5 * 60 * 1000), 10);
const MEM_MAX = 5000;

const memory = new Map(); // key -> { value, expires }
const inflight = new Map(); // key -> Promise
const driverMemo = new Map(); // driverId -> { key, address, at }

const isDisabled = () => process.env.REVERSE_GEOCODE_DISABLED === '1';
const keyFor = (lat, lng, precision) => `revgeo:${lat.toFixed(precision)},${lng.toFixed(precision)}`;

function memGet(key) {
  const hit = memory.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) { memory.delete(key); return undefined; }
  return hit.value;
}
function memSet(key, value, ttlSeconds) {
  if (memory.size >= MEM_MAX) memory.delete(memory.keys().next().value); // drop the oldest
  memory.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
}

// Google's first result can be a bare Plus Code in remote spots; prefer a real address.
function pickAddress(results) {
  const list = Array.isArray(results) ? results : [];
  const real = list.find((r) => r?.formatted_address && !(r.types || []).includes('plus_code'));
  return (real || list[0])?.formatted_address || null;
}

async function lookup(lat, lng) {
  if (!API_KEY) return { address: null, cacheSeconds: NEGATIVE_TTL_S };
  try {
    const resp = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: { latlng: `${lat},${lng}`, key: API_KEY, language: 'en', region: 'AE' },
      timeout: TIMEOUT_MS
    });
    const status = resp.data?.status;
    if (status === 'OK') {
      const address = pickAddress(resp.data.results);
      return { address, cacheSeconds: address ? POSITIVE_TTL_S : NEGATIVE_TTL_S };
    }
    if (status !== 'ZERO_RESULTS') console.warn('[reverse-geocode] Google status:', status, resp.data?.error_message || '');
    return { address: null, cacheSeconds: status === 'ZERO_RESULTS' ? NEGATIVE_TTL_S : 60 };
  } catch (err) {
    console.warn('[reverse-geocode] request failed:', err.message);
    return { address: null, cacheSeconds: 60 };
  }
}

// precision: decimal places the coordinates are rounded to for caching
// (5 ≈ 1 m, for a delivery drop-off; 3 ≈ 110 m, for a moving driver).
export async function reverseGeocode(latitude, longitude, { precision = 5 } = {}) {
  if (isDisabled()) return null;
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!isPlausibleCoordinate(lat, lng)) return null; // garbage / far outside the service area: don't pay for it

  const key = keyFor(lat, lng, precision);
  const cached = memGet(key);
  if (cached !== undefined) return cached;

  const shared = await cacheGet(key);
  if (shared !== null && shared !== undefined) {
    const value = shared === '' ? null : shared;
    memSet(key, value, value ? POSITIVE_TTL_S : NEGATIVE_TTL_S);
    return value;
  }

  if (inflight.has(key)) return inflight.get(key);
  const promise = (async () => {
    // Look up the rounded point so every request in the same cell gets the same answer.
    const { address, cacheSeconds } = await lookup(Number(lat.toFixed(precision)), Number(lng.toFixed(precision)));
    memSet(key, address, cacheSeconds);
    await cacheSet(key, address || '', cacheSeconds).catch(() => {});
    return address;
  })().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

// A driver's live position changes every 10-30 s: reuse the last answer while
// they are still in the same ~110 m cell, or when it is under
// DRIVER_MIN_INTERVAL_MS old, instead of paying for every movement.
export async function addressForDriver(driverId, latitude, longitude) {
  if (isDisabled()) return null;
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!isPlausibleCoordinate(lat, lng)) return null;
  const id = String(driverId);
  const key = keyFor(lat, lng, 3);
  const memo = driverMemo.get(id);
  if (memo && (memo.key === key || Date.now() - memo.at < DRIVER_MIN_INTERVAL_MS)) return memo.address;
  const address = await reverseGeocode(lat, lng, { precision: 3 });
  driverMemo.set(id, { key, address, at: Date.now() });
  return address;
}

export function _resetReverseGeocodeStateForTests() {
  memory.clear(); inflight.clear(); driverMemo.clear();
}
