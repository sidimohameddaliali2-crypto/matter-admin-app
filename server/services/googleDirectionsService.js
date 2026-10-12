import axios from 'axios';

// Google Directions API — used for the mobile Route Navigator screen's
// road-following polyline + turn-by-turn steps. Kept server-side (unlike the
// Android Maps SDK key, which has to ship in the mobile app) so this key is
// never exposed in the client bundle. Falls back to GOOGLE_MAPS_API_KEY
// (already used for geocoding — see GOOGLE_GEOCODING_API_KEY's same fallback
// in services/geocoding.js) if a dedicated key isn't set; that existing key
// needs the Directions API enabled in Google Cloud Console to work here.
const GOOGLE_DIRECTIONS_API_KEY = process.env.GOOGLE_DIRECTIONS_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
const DIRECTIONS_URL = 'https://maps.googleapis.com/maps/api/directions/json';

// Short-lived in-memory cache, keyed by the rounded point sequence. Not
// meant to serve stale routes for long (traffic-aware duration goes stale
// fast) — just absorbs near-duplicate requests that land within a few
// seconds of each other (a driver double-tapping retry, the mobile app's
// own dedupe guard having a gap, etc.) without re-billing Google for an
// identical route. One process's memory only — fine at this fleet's scale,
// not meant to survive a restart or be shared across server instances.
const DIRECTIONS_CACHE_TTL_MS = 20000;
const directionsCache = new Map();

// Rounded to 4 decimal places (~11m) — a driver's GPS jitters within that
// easily, and two requests "at the same spot" a few seconds apart should
// hit the same cache entry rather than missing over noise.
function cacheKey(points) {
  return points.map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join('|');
}

function pruneExpiredCacheEntries(now) {
  for (const [key, entry] of directionsCache) {
    if (now - entry.timestamp > DIRECTIONS_CACHE_TTL_MS) directionsCache.delete(key);
  }
}

// Strips Google's `html_instructions` (e.g. "Turn <b>left</b> onto <b>Palm
// Grove St</b>") down to plain text for display in the app's instruction
// banner. Google sometimes appends a secondary note directly after the
// closing tag with no whitespace, e.g.
// 'Head <b>northwest</b><div style="font-size:0.9em">Restricted usage road</div>'
// — stripping tags to nothing would collide the two into "northwestRestricted".
// Replacing each tag with a space (then collapsing runs of whitespace) keeps
// them separated.
export function stripHtml(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Decodes a Google-encoded polyline string into [{latitude,longitude}, ...].
// Google's canonical polyline algorithm
// (https://developers.google.com/maps/documentation/utilities/polylinealgorithm) —
// char code offset by 63, continuation flagged by bit 0x20, each 5-bit chunk
// masked with 0x1f before shifting into the running value.
export function decodePolyline(encoded) {
  const points = [];
  let index = 0, lat = 0, lng = 0;

  while (index < encoded.length) {
    let shift = 0, result = 0, b;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    shift = 0; result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);

    points.push({ latitude: lat * 1e-5, longitude: lng * 1e-5 });
  }

  return points;
}

/**
 * Fetch a driving route through an ORDERED sequence of {lat, lng} points
 * (e.g. [driverPosition, ...remainingStops]) from Google Directions. The
 * order is fixed by the caller (the dispatch-assigned stop sequence) —
 * `optimize:false` so Google never reorders waypoints, this is a directions
 * lookup, not a re-optimization.
 *
 * Returns:
 *   {
 *     polyline: [{latitude,longitude}, ...],   // full route geometry
 *     legs: [{ distanceMeters, durationSeconds, steps: [{ text, distanceMeters, startLocation }] }]
 *   }
 * legs are indexed the same as buildOrderedRouteLegs in distanceMatrixService.js —
 * one leg per consecutive pair of input points.
 */
export async function getDirections(points) {
  if (!GOOGLE_DIRECTIONS_API_KEY) {
    throw new Error('GOOGLE_DIRECTIONS_API_KEY is not configured');
  }
  if (!Array.isArray(points) || points.length < 2) {
    return { polyline: [], legs: [] };
  }

  const now = Date.now();
  const key = cacheKey(points);
  const cached = directionsCache.get(key);
  if (cached && now - cached.timestamp <= DIRECTIONS_CACHE_TTL_MS) {
    return cached.data;
  }
  pruneExpiredCacheEntries(now);

  const [origin, ...rest] = points;
  const destination = rest[rest.length - 1];
  const waypoints = rest.slice(0, -1);

  const params = {
    origin: `${origin.lat},${origin.lng}`,
    destination: `${destination.lat},${destination.lng}`,
    mode: 'driving',
    // Current traffic conditions, not just static road-network timing — a
    // jam shows up as a longer ETA even when the road itself isn't closed.
    // Google only returns duration_in_traffic when departure_time is set;
    // 'now' is the literal value its docs specify for "right now".
    departure_time: 'now',
    traffic_model: 'best_guess',
    // Biases Google's interpretation of ambiguous street/area names toward
    // the UAE — this fleet never routes outside it, so there's no case
    // where this bias would point Google at the wrong country.
    region: 'ae',
    key: GOOGLE_DIRECTIONS_API_KEY
  };
  if (waypoints.length > 0) {
    params.waypoints = waypoints.map((p) => `${p.lat},${p.lng}`).join('|');
  }

  let resp;
  try {
    resp = await axios.get(DIRECTIONS_URL, { params, timeout: 20000 });
  } catch (err) {
    const detail = err.response?.data?.error_message || err.message;
    throw new Error(`Google Directions request failed: ${detail}`);
  }

  if (resp.data?.status !== 'OK' || !resp.data.routes?.[0]) {
    const detail = resp.data?.error_message ? ` — ${resp.data.error_message}` : '';
    throw new Error(`Google Directions error: ${resp.data?.status}${detail}`);
  }

  const route = resp.data.routes[0];
  const polyline = decodePolyline(route.overview_polyline.points);

  const legs = (route.legs || []).map((leg) => ({
    distanceMeters: leg.distance?.value ?? 0,
    // duration_in_traffic is only present when Google actually has live
    // traffic data for this road right now — falls back to the static
    // duration when it doesn't (e.g. a road with no traffic reporting).
    durationSeconds: leg.duration_in_traffic?.value ?? leg.duration?.value ?? 0,
    steps: (leg.steps || []).map((step) => ({
      text: stripHtml(step.html_instructions),
      distanceMeters: step.distance?.value ?? 0,
      // Google's own maneuver code (e.g. "turn-left", "turn-slight-right",
      // "uturn-right", "roundabout-left") — not every step has one (the
      // first step of a leg usually doesn't), so the client falls back to
      // a generic "continue straight" icon when it's absent.
      maneuver: step.maneuver || null,
      startLocation: { latitude: step.start_location.lat, longitude: step.start_location.lng }
    }))
  }));

  const result = { polyline, legs };
  directionsCache.set(key, { timestamp: now, data: result });
  return result;
}
