// Extracts { lat, lng } from a Google/Apple Maps link, a raw "lat,lng" string, or any
// text containing coordinates. Returns null if nothing parseable is found.
//
// On a map link, the first decimal pair is often the @ viewing centre. Place
// links also embed the destination as !3d/!4d (or q/query/ll/destination).
// That destination wins; @ is used only when the link has no destination pair
// (issue #2, SYNC-04). Keep this in step with extractCoordsFromGoogleMapsUrl.
const DECIMAL_PAIR = '(-?\\d{1,3}\\.\\d+)\\s*,\\s*(-?\\d{1,3}\\.\\d+)';

function coordinatePair(lat, lng) {
  const la = parseFloat(lat);
  const ln = parseFloat(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
  if (Math.abs(la) > 90 || Math.abs(ln) > 180) return null;
  return { lat: la, lng: ln };
}

function pairIn(text) {
  if (!text) return null;
  const match = String(text).match(new RegExp(DECIMAL_PAIR));
  if (!match) return null;
  return coordinatePair(match[1], match[2]);
}

function decodeMapText(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function destinationFromMapLink(text) {
  const place = text.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (place) {
    const coords = coordinatePair(place[1], place[2]);
    if (coords) return coords;
  }

  const query = text.match(new RegExp(`[?&](?:destination|daddr|q|query|ll)=(?:loc:)?${DECIMAL_PAIR}`, 'i'));
  if (query) {
    const coords = coordinatePair(query[1], query[2]);
    if (coords) return coords;
  }

  const loc = text.match(new RegExp(`loc:${DECIMAL_PAIR}`, 'i'));
  if (loc) {
    const coords = coordinatePair(loc[1], loc[2]);
    if (coords) return coords;
  }

  return null;
}

export function parseGPSFromLink(link) {
  if (!link || typeof link !== 'string') return null;

  const str = link.trim();
  if (!str) return null;
  const text = decodeMapText(str);
  const looksLikeUrl = /https?:\/\/|google\.|goo\.gl|maps\.app\.goo\.gl|maps\.apple\.com/i.test(text);

  if (!looksLikeUrl) return pairIn(text);

  const destination = destinationFromMapLink(text);
  if (destination) return destination;

  const at = text.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (at) {
    const coords = coordinatePair(at[1], at[2]);
    if (coords) return coords;
  }

  return pairIn(text);
}
