import axios from 'axios';
import Customer from '../models/Customer.js';

// Dedicated Geocoding API key; falls back to the general Maps key.
const GOOGLE_GEOCODING_API_KEY = process.env.GOOGLE_GEOCODING_API_KEY || process.env.GOOGLE_MAPS_API_KEY;

async function geocodeWithGoogle(address) {
  if (!GOOGLE_GEOCODING_API_KEY) return null;
  try {
    const resp = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: {
        address,
        key: GOOGLE_GEOCODING_API_KEY,
        region: 'AE'
      },
      timeout: 7000
    });

    if (resp.data?.status === 'OK' && resp.data.results?.length) {
      const loc = resp.data.results[0].geometry?.location;
      if (loc?.lat !== undefined && loc?.lng !== undefined) {
        return { lat: loc.lat, lng: loc.lng, provider: 'google' };
      }
    } else {
      console.warn('Google geocode status:', resp.data?.status, 'for', address);
    }
  } catch (err) {
    console.warn('Google geocode error for address:', address, err.message);
  }
  return null;
}

/**
 * Extract coordinates from Google Maps URL
 * Supports formats like:
 * https://www.google.com/maps/place/Villa+433...@25.1234,55.5678,15z
 * https://maps.google.com/?q=loc:25.1234,55.5678
 */
export function extractCoordsFromGoogleMapsUrl(url) {
  if (!url || typeof url !== 'string') return null;

  try {
    // Pattern 1: @lat,lng format
    const atMatch = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (atMatch) {
      return {
        lat: parseFloat(atMatch[1]),
        lng: parseFloat(atMatch[2])
      };
    }

    // Pattern 2: loc:lat,lng format
    const locMatch = url.match(/loc:(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (locMatch) {
      return {
        lat: parseFloat(locMatch[1]),
        lng: parseFloat(locMatch[2])
      };
    }

    return null;
  } catch (err) {
    console.error('Error extracting coords from Google Maps URL:', err);
    return null;
  }
}

/**
 * Geocode an address to get lat/lng.
 *
 * Google only — deliberately, since 2026-09-05. This used to fall back to
 * Nominatim (OSM) whenever Google failed or wasn't configured; the owner
 * asked to drop that after a Nominatim mismatch sent a real Dubai address
 * ("Meadows 5, Street 5") to Islamabad, Pakistan.
 *
 * Note this doesn't fully solve wrong-country mismatches by itself: Google's
 * `region: 'AE'` param is a soft bias, not a hard restriction, so a short or
 * ambiguous string can still confidently match a much stronger exact-name hit
 * abroad — verified directly against this address book, e.g. "The DEN" and
 * "Algeria St, Villa 46" both landed in the UK / South Africa via Google too,
 * the same way "Algeria St" once did via Nominatim. That's why every caller
 * layers a depot-proximity plausibility check on top of this (see
 * isPlausibleCoordinate) rather than trusting any single geocode result
 * blindly — the check, not the provider, is what actually prevents a wrong
 * pin from being stored or displayed.
 */
export async function geocodeAddress(address) {
  if (!address || typeof address !== 'string' || address.trim().length === 0) {
    return null;
  }
  return geocodeWithGoogle(address);
}

// Some historical records have garbage in gpsLocation — e.g. an address's
// own unit/floor number ("1702 Volante Tower...") ended up stored as the
// latitude somewhere upstream of this function. A plain typeof-number check
// doesn't catch that (1702 is a number), so anything trusting stored
// coordinates as-is needs an actual geographic sanity check first. (0,0) is
// excluded too — a common "never actually set" default, not a real UAE
// address.
//
// A world-bounds check alone isn't enough either: Google Geocoding can
// confidently return a perfectly valid Earth coordinate for the WRONG
// place when an address is short/generic — e.g. "Algeria St, Villa 46" (a
// real Dubai street) matched to Algeria St in *Johannesburg, South
// Africa*, and "Meadows 5, Street 5" (a real Dubai community) matched to
// somewhere in Islamabad. Both passed a plain lat/lng-range check and only
// showed up as a ~25-hour "drive time" once fed into route optimization.
// So anything claiming to be a delivery coordinate also has to be within a
// generous radius of the depot — real service area, not just "a place on
// Earth."
const DEPOT_LAT = Number(process.env.DELIVERY_DEPOT_LAT);
const DEPOT_LNG = Number(process.env.DELIVERY_DEPOT_LNG);
const MAX_PLAUSIBLE_DISTANCE_KM = 300; // generously covers all of the UAE plus nearby GCC border areas

export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function isPlausibleCoordinate(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return false;
  if (Number.isNaN(lat) || Number.isNaN(lng)) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  if (lat === 0 && lng === 0) return false;
  if (Number.isFinite(DEPOT_LAT) && Number.isFinite(DEPOT_LNG)) {
    if (haversineKm(lat, lng, DEPOT_LAT, DEPOT_LNG) > MAX_PLAUSIBLE_DISTANCE_KM) return false;
  }
  return true;
}

/**
 * Coordinates a delivery already carries — NEVER a guess from its address.
 * Priority: existing coords > a pin extracted from a Google Maps link.
 *
 * Owner (2026-10-12): automatic Google geocoding is off. An address-text guess
 * could land on the wrong street/community inside the service area (the 300 km
 * plausibility check only catches wildly wrong ones) and then get reused
 * silently, so a delivery with no pin stays unpinned until a dispatcher places
 * one (or deliberately runs the Google/2GIS geocode buttons on Driver Routes,
 * which go through POST /deliveries/geocode-google and geocodeAddress above).
 */
export async function resolveDeliveryCoordinates(delivery) {
  // If already has coordinates in gpsLocation, return them
  if (delivery.gpsLocation && typeof delivery.gpsLocation === 'object') {
    if (isPlausibleCoordinate(delivery.gpsLocation.lat, delivery.gpsLocation.lng)) {
      return {
        lat: delivery.gpsLocation.lat,
        lng: delivery.gpsLocation.lng
      };
    }
  }
  // If already has coordinates as top-level fields
  if (delivery.location && typeof delivery.location === 'object') {
    if (isPlausibleCoordinate(delivery.location.lat, delivery.location.lng)) {
      return {
        lat: delivery.location.lat,
        lng: delivery.location.lng
      };
    }
  }
  if (isPlausibleCoordinate(delivery.lat, delivery.lng)) {
    return {
      lat: delivery.lat,
      lng: delivery.lng
    };
  }

  // Try to extract from Google Maps URL if present
  if (delivery.mapsUrl && typeof delivery.mapsUrl === 'string') {
    const extracted = extractCoordsFromGoogleMapsUrl(delivery.mapsUrl);
    if (extracted && isPlausibleCoordinate(extracted.lat, extracted.lng)) {
      console.log(`✅ Extracted coords from Google Maps URL for ${delivery.customerName}:`, extracted);
      return extracted;
    }
  }

  return null;
}

/**
 * Same as resolveDeliveryCoordinates, plus the customer's saved pin
 * (Customer.gpsLocation) when it was saved for this exact address text —
 * so a pin a dispatcher placed once is reused for every later delivery to that
 * address. Read-only: it never calls Google and never writes a guess onto the
 * customer (see the note on resolveDeliveryCoordinates). Returns null when
 * there's no real pin to give.
 */
export async function resolveDeliveryCoordinatesCached(delivery) {
  if (isPlausibleCoordinate(delivery.gpsLocation?.lat, delivery.gpsLocation?.lng)) {
    return { lat: delivery.gpsLocation.lat, lng: delivery.gpsLocation.lng };
  }

  const customerId = delivery.customerId;
  const normalizedAddress = String(delivery.address || '').trim();

  if (customerId) {
    const customer = await Customer.findOne({ customerId }).select('gpsLocation').lean();
    const cached = customer?.gpsLocation;
    if (cached && cached.address === normalizedAddress && isPlausibleCoordinate(cached.lat, cached.lng)) {
      return { lat: cached.lat, lng: cached.lng };
    }
  }

  return resolveDeliveryCoordinates(delivery);
}
