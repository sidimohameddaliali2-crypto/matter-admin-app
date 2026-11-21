import { createHash } from 'node:crypto';

export const MAX_CAPTURE_BATCH_EVENTS = 64;
export const MAX_CAPTURE_BATCH_BYTES = 64 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const validId = value => typeof value === 'string' && ID.test(value);
const ENVELOPE_KEYS = new Set(['schemaVersion', 'eventId', 'eventType', 'accountId', 'installationId', 'shiftId', 'bootSessionId', 'localQueuedAt', 'sequence', 'data']);
const LOCATION_KEYS = ['latitude', 'longitude', 'fixAt', 'fixElapsedRealtimeNs', 'observedElapsedRealtimeNs', 'ageAtCaptureMs', 'accuracy', 'accuracyM', 'qualityFlags', 'provider', 'mocked', 'speedMps', 'heading', 'reason'];
const ACTION_KEYS = ['eventId', 'eventType', 'accountId', 'resourceId', 'deliveryId', 'bagId', 'actionAt', 'payload'];
const ACTION_TYPES = new Set(['delivery.completion_requested', 'delivery.status_requested', 'bag.return_requested']);
const ACTION_PAYLOAD_KEYS = new Set(['status', 'photoId', 'photoIds', 'locationEventId', 'locationEventIds', 'bagId', 'verified', 'qrSkipped', 'proofType', 'deliveryMethod', 'reasonCode', 'scannedAt']);
const DATA_KEYS = {
  'shift.started': ['requestedAt', 'actionAt', 'state', 'reason'],
  'shift.stopped': ['requestedAt', 'actionAt', 'state', 'reason'],
  'tracking.health': ['state', 'reason', 'at', 'provider', 'providerEnabled', 'desiredActive', 'permissionState', 'pendingCount', 'oldestPendingAt', 'lastFixAt', 'lastAcknowledgedAt', 'policyVersion'],
  'tracking.gap': ['reason', 'at', 'startAt', 'endAt', 'state'],
  'location.observed': LOCATION_KEYS,
  'location.rejected': [...LOCATION_KEYS, 'rawLatitude', 'rawLongitude'],
  'photo.captured': ['schemaVersion', 'eventId', 'photoId', 'accountId', 'deliveryId', 'capturedAt', 'captureCompletedAt', 'shiftId', 'bootSessionId', 'contextObservedAt', 'contextObservedElapsedRealtimeNs', 'captureLocation', 'byteSize', 'contentMd5', 'contentSha256', 'localSavedAt', 'acceptedAt'],
  'delivery.completion_requested': ACTION_KEYS,
  'delivery.status_requested': ACTION_KEYS,
  'bag.return_requested': ACTION_KEYS,
};
const CAPTURE_LOCATION_KEYS = new Set(['status', 'reason', 'latitude', 'longitude', 'fixAt', 'accuracyM', 'ageMs', 'provider', 'fixElapsedRealtimeNs', 'mocked', 'qualityFlags', 'lastKnownFix']);
const LAST_KNOWN_KEYS = new Set(['latitude', 'longitude', 'fixAt', 'accuracyM']);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const date = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;

export function captureIngestionEnabled(env = process.env) {
  return env.ENABLE_DRIVER_CAPTURE_INGESTION === '1' && env.APP_ENV !== 'production'
    && (env.APP_ENV === 'staging' || ['staging', 'test'].includes(env.NODE_ENV));
}

function safeValue(value, depth = 0) {
  if (depth > 5) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= 2048 && !/(?:file|content):\/\//i.test(value) && !/^[A-Za-z]:[\\/]/.test(value) && !value.startsWith('/');
  if (Array.isArray(value)) return value.length <= 64 && value.every(item => safeValue(item, depth + 1));
  if (!plain(value) || Object.keys(value).length > 48) return false;
  return Object.entries(value).every(([key, child]) => !/^(?:__proto__|constructor|prototype)$/.test(key)
    && !/[.$]/.test(key) && !/(?:password|token|authorization|secret|customer|email|phone|address|uri|path)/i.test(key)
    && safeValue(child, depth + 1));
}

function checkKeys(value, allowed) { return plain(value) && Object.keys(value).every(key => allowed.has(key)); }
function coordinates(data) {
  return finite(data.latitude) && data.latitude >= -90 && data.latitude <= 90
    && finite(data.longitude) && data.longitude >= -180 && data.longitude <= 180;
}

export function validateCaptureEvent(event, accountId) {
  if (!plain(event) || !checkKeys(event, ENVELOPE_KEYS)) return 'invalid_envelope';
  if (!validId(event.eventId)) return 'invalid_event_id';
  if (event.schemaVersion !== 1 || !Object.hasOwn(DATA_KEYS, event.eventType)) return 'unsupported_schema_or_type';
  if (event.accountId !== accountId) return 'account_mismatch';
  if (!date(event.localQueuedAt) || !plain(event.data)) return 'invalid_event_data';
  for (const key of ['installationId', 'shiftId', 'bootSessionId']) {
    if (event[key] != null && (typeof event[key] !== 'string' || !ID.test(event[key]))) return 'invalid_identity';
  }
  if (event.sequence !== undefined && (typeof event.sequence !== 'string' || !/^\d{1,20}$/.test(event.sequence))) return 'invalid_sequence';
  if (!checkKeys(event.data, new Set(DATA_KEYS[event.eventType])) || !safeValue(event.data)) return 'unsafe_or_unknown_event_data';
  const data = event.data;
  if (data.eventId !== undefined && data.eventId !== event.eventId) return 'nested_event_identity_mismatch';
  if (data.accountId != null && data.accountId !== accountId) return 'nested_account_mismatch';
  if (data.eventType !== undefined && data.eventType !== event.eventType) return 'nested_event_type_mismatch';
  if (ACTION_TYPES.has(event.eventType)) {
    const resource = event.eventType === 'bag.return_requested' ? data.bagId : data.deliveryId;
    if (!validId(resource) || !date(data.actionAt) || !checkKeys(data.payload, ACTION_PAYLOAD_KEYS)) return 'invalid_action_metadata';
    if (data.resourceId !== undefined && data.resourceId !== resource) return 'action_resource_mismatch';
    for (const key of ['photoId', 'locationEventId', 'bagId']) {
      if (data.payload[key] != null && !validId(data.payload[key])) return 'invalid_action_reference';
    }
    for (const key of ['photoIds', 'locationEventIds']) {
      if (data.payload[key] !== undefined && (!Array.isArray(data.payload[key]) || data.payload[key].length > 16 || data.payload[key].some(id => !validId(id)))) return 'invalid_action_reference';
    }
    for (const key of ['status', 'proofType', 'deliveryMethod', 'reasonCode']) {
      if (data.payload[key] !== undefined && (typeof data.payload[key] !== 'string' || !/^[a-z][a-z_]{0,63}$/.test(data.payload[key]))) return 'invalid_action_code';
    }
    for (const key of ['verified', 'qrSkipped']) if (data.payload[key] !== undefined && typeof data.payload[key] !== 'boolean') return 'invalid_action_flag';
    if (data.payload.scannedAt !== undefined && !date(data.payload.scannedAt)) return 'invalid_scan_time';
  }
  if (event.eventType === 'location.observed') {
    const unavailableAccuracy = data.accuracy === null && Array.isArray(data.qualityFlags) && data.qualityFlags.includes('accuracy_unavailable');
    if (!coordinates(data) || !date(data.fixAt) || (!unavailableAccuracy && (!finite(data.accuracy) || data.accuracy < 0 || data.accuracy > 50000))) return 'invalid_location';
    if (typeof data.fixElapsedRealtimeNs !== 'string' || typeof data.observedElapsedRealtimeNs !== 'string' || !/^\d{1,20}$/.test(data.fixElapsedRealtimeNs) || !/^\d{1,20}$/.test(data.observedElapsedRealtimeNs)) return 'invalid_location_clock';
    if (data.ageAtCaptureMs != null && (!finite(data.ageAtCaptureMs) || data.ageAtCaptureMs < 0)) return 'invalid_location_age';
  }
  if (event.eventType === 'photo.captured') {
    if (!validId(data.photoId) || !validId(data.deliveryId) || !date(data.capturedAt) || !date(data.captureCompletedAt)) return 'invalid_photo_association';
    if (data.accountId != null && data.accountId !== accountId) return 'photo_account_mismatch';
    if (!Number.isSafeInteger(data.byteSize) || data.byteSize < 1 || data.byteSize > 8 * 1024 * 1024) return 'invalid_photo_size';
    if (!/^[a-f0-9]{32}$/i.test(data.contentMd5 || '')) return 'invalid_photo_checksum';
    if (!checkKeys(data.captureLocation, CAPTURE_LOCATION_KEYS) || !['available', 'unavailable'].includes(data.captureLocation.status)) return 'invalid_capture_location';
    if (data.captureLocation.status === 'available' && (!coordinates(data.captureLocation) || !date(data.captureLocation.fixAt) || !finite(data.captureLocation.accuracyM) || data.captureLocation.accuracyM < 0)) return 'invalid_capture_location';
    if (data.captureLocation.lastKnownFix && !checkKeys(data.captureLocation.lastKnownFix, LAST_KNOWN_KEYS)) return 'invalid_last_known_fix';
  }
  return null;
}

export class CaptureRequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Repository is injected so tests have no database, environment loading or network.
export async function ingestDriverCaptureBatch({ actor, body, repository, now = () => new Date() }) {
  if (!actor?.id || actor.role !== 'driver') throw new CaptureRequestError(403, 'Driver account required');
  if (!plain(body) || Object.keys(body).some(key => key !== 'events') || !Array.isArray(body.events) || body.events.length < 1 || body.events.length > MAX_CAPTURE_BATCH_EVENTS) {
    throw new CaptureRequestError(400, 'Expected 1–64 capture events');
  }
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(body), 'utf8'); } catch { throw new CaptureRequestError(400, 'Invalid capture JSON'); }
  if (bytes > MAX_CAPTURE_BATCH_BYTES) throw new CaptureRequestError(413, 'Capture batch exceeds 64 KiB');
  const identities = body.events.map(event => event?.eventId).filter(id => typeof id === 'string');
  if (new Set(identities).size !== identities.length) throw new CaptureRequestError(400, 'Duplicate event identities within one batch');
  const serverReceivedAt = now().toISOString();
  const accepted = [], rejected = [], retryable = [];
  for (const event of body.events) {
    const eventId = typeof event?.eventId === 'string' ? event.eventId.slice(0, 128) : null;
    const reason = validateCaptureEvent(event, actor.id);
    if (reason) { rejected.push({ eventId, reason }); continue; }
    const payloadHash = createHash('sha256').update(canonical(event)).digest('hex');
    try {
      const result = await repository.accept({ accountId: actor.id, eventId, payloadHash, event, serverReceivedAt });
      if (result.payloadHash !== payloadHash) { rejected.push({ eventId, reason: 'event_identity_conflict' }); continue; }
      accepted.push({ eventId, duplicate: result.duplicate === true });
    } catch {
      // A timeout can mean committed-but-response-lost: retain identity and retry.
      retryable.push({ eventId, reason: 'ledger_temporarily_unavailable' });
    }
  }
  return { success: true, data: { accepted, rejected, retryable, serverReceivedAt,
    serverCommittedAt: accepted.length ? now().toISOString() : null, ledgerOnly: true,
    deliveryStateApplied: false, associationVerified: false } };
}
