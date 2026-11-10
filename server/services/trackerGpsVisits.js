import { CUSTOMER_RADIUS_METRES } from './truckoomVisitRules.js';

export const GPS_VISIT_METHOD = 'gps-observations-v2';
// Screening limits, not guarantees of GPS accuracy or continuous presence.
export const GPS_VISIT_POLICY = Object.freeze({ maxGapMs: 300000, jumpMetres: 500, jumpKph: 180 });

export function gpsFixTime(value) {
  if (!(value instanceof Date) && (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))) return null;
  const at = new Date(value);
  if (!Number.isFinite(+at)) return null;
  if (typeof value === 'string') {
    const [year, month, day] = value.slice(0, 10).split('-').map(Number);
    const [hour, minute, second] = value.slice(11, 19).split(':').map(Number);
    if (hour > 23 || minute > 59 || second > 59) return null;
    if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  }
  return at;
}

const coordinate = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng)
  && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
const distance = (a, b) => {
  const r = Math.PI / 180;
  const h = Math.sin((a.latitude - b.latitude) * r / 2) ** 2
    + Math.cos(a.latitude * r) * Math.cos(b.latitude * r)
      * Math.sin((a.longitude - b.longitude) * r / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
};

function observations(points, pin, radiusMetres, asOf) {
  const groups = new Map(), reasons = new Set();
  let untimed = false;
  for (const p of points) {
    const at = gpsFixTime(p.gpsTime);
    if (!at) { reasons.add('missing_or_invalid_fix_time'); untimed = true; continue; }
    const key = +at, rows = groups.get(key) || [];
    rows.push({ ...p, at }); groups.set(key, rows);
  }
  const cutoff = gpsFixTime(asOf);
  const rows = [...groups].sort(([a], [b]) => a - b).map(([, duplicates]) => {
    const row = { ...duplicates[0], reasons: new Set() };
    if (duplicates.some(p => !coordinate(p.latitude, p.longitude))) row.reasons.add('invalid_coordinates');
    if (new Set(duplicates.map(p => JSON.stringify([p.latitude, p.longitude]))).size > 1) row.reasons.add('conflicting_coordinates');
    if ((cutoff && row.at > cutoff) || duplicates.some(p => {
      const receipt = gpsFixTime(p.sourceReceipt?.responseReceivedAt) || gpsFixTime(p.recordedAt);
      return receipt && p.at > receipt;
    })) row.reasons.add('future_fix_time');
    if (duplicates.some(p => p.qualityFlags?.includes('future_fix_clock'))) row.reasons.add('future_fix_time');
    if (duplicates.some(p => p.qualityFlags?.includes('missing_observation_receipt'))) row.reasons.add('missing_observation_receipt');
    if (duplicates.some(p => p.qualityFlags?.includes('unmatched_driver_mapping'))) row.reasons.add('unmatched_driver_mapping');
    if (duplicates.some(p => p.driverMappingState === 'ambiguous_current_mapping'
      || p.qualityFlags?.includes('ambiguous_driver_mapping'))) row.reasons.add('ambiguous_driver_mapping');
    row.inside = coordinate(row.latitude, row.longitude)
      && distance(row, { latitude: pin.lat, longitude: pin.lng }) <= radiusMetres;
    return row;
  });
  let previous = null, jumpDestination = null;
  for (const row of rows) {
    // An unusable row breaks speed continuity, but cannot establish movement
    // away from a tainted jump destination. Only a usable changed position can.
    if (row.reasons.size) { previous = null; continue; }
    if (jumpDestination && row.latitude === jumpDestination.latitude && row.longitude === jumpDestination.longitude) {
      row.reasons.add('jump_plateau');
    } else jumpDestination = null;
    if (previous) {
      const metres = distance(previous, row), elapsed = +row.at - +previous.at;
      if (metres > GPS_VISIT_POLICY.jumpMetres && metres / elapsed * 3600 > GPS_VISIT_POLICY.jumpKph) {
        previous.reasons.add('impossible_jump'); row.reasons.add('impossible_jump'); jumpDestination = row;
      }
    }
    previous = row;
  }
  const segments = []; let segment = [];
  for (const row of rows) {
    for (const reason of row.reasons) reasons.add(reason);
    if (row.reasons.size || segment.length && +row.at - +segment.at(-1).at > GPS_VISIT_POLICY.maxGapMs) {
      if (!row.reasons.size) reasons.add('observation_gap');
      if (segment.length) segments.push(segment); segment = [];
    }
    if (!row.reasons.size) segment.push(row);
  }
  if (segment.length) segments.push(segment);
  return { rows, segments, reasons: [...reasons].sort(), untimed };
}

// Exposes observed transitions only. A segment after a gap starts independently;
// its first outside observation cannot close an entry from an earlier segment.
// Use evaluateGpsVisit for photo comparisons; GPS transitions are not geofence alerts.
export function gpsVisitEvents(points, pin, radiusMetres = CUSTOMER_RADIUS_METRES) {
  if (!coordinate(pin?.lat, pin?.lng) || !Number.isFinite(radiusMetres) || radiusMetres <= 0) return [];
  const { segments } = observations(points, pin, radiusMetres);
  return segments.flatMap(segment => {
    const events = []; let inside = false;
    for (const p of segment) {
      if (p.inside !== inside) events.push({ flag: p.inside ? 'entry' : 'exit', at: p.at });
      inside = p.inside;
    }
    return events;
  });
}

export function evaluateGpsVisit({ points, pin, radiusMetres = CUSTOMER_RADIUS_METRES,
  photoCapturedAt, photoSource, start, end, asOf }) {
  const photo = gpsFixTime(photoCapturedAt);
  const result = { arrivedAt: null, departedAt: null, photoCapturedAt: photo,
    visitCount: 0, needsReview: false, gpsMethod: GPS_VISIT_METHOD, gpsQualityReasons: [] };
  if (!coordinate(pin?.lat, pin?.lng)) return { ...result, status: 'missing_pin' };
  if (!Number.isFinite(radiusMetres) || radiusMetres <= 0) {
    return { ...result, status: 'incomplete_events', gpsQualityReasons: ['invalid_radius'] };
  }
  const data = observations(points, pin, radiusMetres, asOf);
  result.gpsQualityReasons = data.reasons;
  if (photoSource === 'upload') return { ...result, status: 'uploaded_photo', needsReview: true };
  if (!photo || photoSource !== 'camera') return { ...result, status: 'missing_photo_time' };
  if (+photo < +start || +photo >= +end) return { ...result, status: 'awaiting_events' };
  // An unplaceable observation cannot be silently ignored to choose a convenient
  // surrounding fix. Its original receipt is retained, but is not a GPS clock.
  if (data.untimed) return { ...result, status: 'incomplete_events' };
  const sameTime = data.rows.find(p => +p.at === +photo);
  if (sameTime?.reasons.size) return { ...result, status: 'incomplete_events' };
  let supported = null;
  for (const segment of data.segments) {
    const exact = segment.findIndex(p => +p.at === +photo);
    const before = segment.findLastIndex(p => p.at < photo);
    const after = segment.findIndex(p => p.at > photo);
    if (exact >= 0 && segment[exact].inside) supported = { segment, index: exact };
    else if (exact < 0 && before >= 0 && after >= 0 && segment[before].inside && segment[after].inside) {
      supported = { segment, index: before };
    }
    if (supported) break;
  }
  if (supported) {
    const { segment, index } = supported;
    let first = index, last = index;
    while (first > 0 && segment[first - 1].inside) first--;
    while (last + 1 < segment.length && segment[last + 1].inside) last++;
    return { ...result, arrivedAt: segment[first].at,
      departedAt: segment[last + 1]?.at || null, visitCount: 1, status: 'gps_visit_observed' };
  }
  // A directly observed outside position can warrant review. Absence between
  // samples, or before/after the sampled period, cannot establish an outside visit.
  if (sameTime && !sameTime.inside) return { ...result, status: 'gps_window_review', needsReview: true };
  return { ...result, status: points.length ? 'incomplete_events' : 'awaiting_events' };
}
