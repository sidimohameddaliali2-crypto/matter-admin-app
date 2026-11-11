// Saved-source metadata only. Missing legacy metadata is not new evidence.
export function savedGpsClock(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/);
  if (!match) return null;
  const [, y, m, d, h, minute, s] = match.map(Number);
  if (m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate()
    || h > 23 || minute > 59 || s > 59) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

const text = (value, limit = 256) => typeof value === 'string' && value.length <= limit;
const index = value => Number.isSafeInteger(value) && value >= 0;
const optional = (object, key, valid) => object[key] == null || valid(object[key]);

export function validSavedGpsCapture(capture) {
  if (capture == null) return true;
  if (typeof capture !== 'object' || Array.isArray(capture)) return false;
  for (const key of ['rawGpsTime', 'rawTrackerServerTime', 'ignition', 'trackerStatus', 'locationSource', 'driverMappingState', 'batchId']) {
    if (!optional(capture, key, text)) return false;
  }
  if (!optional(capture, 'trackerServerTime', value => savedGpsClock(value) !== null)
    || !optional(capture, 'speedKph', Number.isFinite)
    || !optional(capture, 'fixAgeMs', Number.isFinite)
    || !optional(capture, 'sourceRow', index) || !optional(capture, 'batchRow', index)) return false;
  if (!optional(capture, 'qualityFlags', flags => Array.isArray(flags) && flags.length <= 128
    && flags.every(flag => text(flag, 128) && flag.length > 0))) return false;
  if (!optional(capture, 'driverCandidates', ids => Array.isArray(ids) && ids.length <= 512
    && ids.every(id => typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id)))) return false;
  if (capture.physicalDriverIdentityConfirmed != null && capture.physicalDriverIdentityConfirmed !== false) return false;
  const receipt = capture.sourceReceipt;
  return receipt == null || typeof receipt === 'object' && !Array.isArray(receipt)
    && text(receipt.receiptId, 128) && receipt.receiptId.length > 0
    && typeof receipt.sha256 === 'string' && /^[a-f0-9]{64}$/.test(receipt.sha256)
    && ['live', 'history'].includes(receipt.kind)
    && savedGpsClock(receipt.responseReceivedAt) !== null;
}

export function savedGpsFutureFix(point) {
  const fix = savedGpsClock(point.gpsTime);
  const sourceReceipt = savedGpsClock(point.capture?.sourceReceipt?.responseReceivedAt);
  const collected = savedGpsClock(point.recordedAt);
  return point.capture?.qualityFlags?.includes('future_fix_clock') === true
    || fix !== null && (sourceReceipt !== null && fix > sourceReceipt || collected !== null && fix > collected);
}

export function savedGpsUncertainClock(point) {
  const receipt = point.capture?.sourceReceipt;
  const received = savedGpsClock(receipt?.responseReceivedAt), collected = savedGpsClock(point.recordedAt);
  return savedGpsFutureFix(point) || !!receipt && (received === null || collected === null || received > collected);
}

// New capture metadata can disqualify evidence, but absent legacy metadata must
// not silently change an existing assessment. Collection clocks locate barriers
// only; they never replace a missing GPS fix.
export function savedGpsCaptureUnusable(point) {
  const capture = point?.capture;
  if (capture == null) return false;
  if (!validSavedGpsCapture(capture) || savedGpsUncertainClock(point)) return true;
  if (capture.driverCandidates?.length > 1) return true;
  if (capture.driverMappingState != null && capture.driverMappingState !== 'current_mapping_snapshot') return true;
  const blocked = new Set(['future_fix_clock', 'missing_fix_clock', 'missing_or_nonfinite_position',
    'invalid_coordinates', 'conflicting_live_vehicle_rows', 'ambiguous_driver_mapping',
    'driver_mapping_unavailable', 'missing_driver_mapping', 'unmatched_driver_mapping', 'missing_observation_receipt']);
  if (capture.qualityFlags?.some(flag => blocked.has(flag))) return true;
  const p = point.location;
  return savedGpsClock(point.gpsTime) === null || savedGpsClock(point.recordedAt) === null
    || !p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)
    || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180 || p.lat === 0 && p.lng === 0;
}
