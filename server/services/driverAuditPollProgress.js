import { createHash } from 'node:crypto';

// Only scheduling and retry metadata belongs here. Evidence and its source
// clocks remain in the immutable archive and protected collector publication.
const maxBytes = 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const epoch = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const digest = value => matches(/^[a-f0-9]{64}$/, value);
const runId = value => matches(/^stream-[0-9]{1,113}$/, value);
const driverId = value => matches(/^[a-f0-9]{24}$/, value);
const timestamp = value => matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/, value)
  && Number.isFinite(Date.parse(value));
const day = value => matches(/^\d{4}-\d{2}-\d{2}$/, value)
  && Number.isFinite(Date.parse(value + 'T00:00:00Z'))
  && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const text = (value, limit) => typeof value === 'string' && value.length <= limit
  && value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function need(condition) {
  if (!condition) throw Object.assign(Error('Invalid bounded native polling progress'), { status: 400 });
}
function shape(value, required, optional = []) {
  need(object(value) && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key)));
}
function optional(value, key, valid) { if (Object.hasOwn(value, key)) need(valid(value[key])); }
function json(value, limit = maxBytes) {
  need(typeof value === 'string' && Buffer.byteLength(value) <= limit);
  let parsed;
  try { parsed = JSON.parse(value); } catch { need(false); }
  need(object(parsed)); return parsed;
}
function halt(value, photo = false) {
  if (value === null) return;
  shape(value, [photo ? 'status' : 'code', 'at']);
  need(timestamp(value.at) && (photo ? [401, 403, 429].includes(value.status)
    : ['source_rate_limit', 'source_denied'].includes(value.code)));
}
function pending(value) {
  shape(value, ['day', 'runId'], ['final', 'fresh', 'sourceStarted', 'attempts', 'nextAttempt', 'lastFailure',
    'nativeCaptureRunId', 'nativeCaptureSha256', 'reason']);
  need(day(value.day) && runId(value.runId));
  for (const key of ['final', 'fresh', 'sourceStarted']) optional(value, key, item => typeof item === 'boolean');
  optional(value, 'attempts', integer); optional(value, 'nextAttempt', epoch);
  if (Object.hasOwn(value, 'lastFailure')) {
    const failure = value.lastFailure;
    if (Object.hasOwn(failure, 'code')) { shape(failure, ['code']); need(failure.code === 'capture-not-published'); }
    else { shape(failure, ['runId', 'day', 'message']); need(runId(failure.runId) && day(failure.day) && text(failure.message, 200)); }
  }
  need(Object.hasOwn(value, 'nativeCaptureRunId') === Object.hasOwn(value, 'nativeCaptureSha256'));
  optional(value, 'nativeCaptureRunId', runId); optional(value, 'nativeCaptureSha256', digest);
  optional(value, 'reason', item => text(item, 200));
}
function schedule(value) {
  shape(value, ['pending'], ['migrationPendingHistory', 'lastDay', 'sourceAttempts', 'lastAttempts', 'observations',
    'gaps', 'sourceHalt', 'photoSourceHalt', 'migrationCheckpointSha256']);
  optional(value, 'migrationCheckpointSha256', digest);
  for (const key of ['pending', 'migrationPendingHistory']) {
    if (!Object.hasOwn(value, key)) continue;
    need(Array.isArray(value[key]) && value[key].length <= 4096); value[key].forEach(pending);
  }
  optional(value, 'lastDay', day);
  for (const key of ['sourceAttempts', 'lastAttempts', 'observations']) {
    if (!Object.hasOwn(value, key)) continue;
    need(object(value[key]) && Object.keys(value[key]).length <= 4096);
    for (const [date, time] of Object.entries(value[key])) need(day(date) && epoch(time));
  }
  if (Object.hasOwn(value, 'gaps')) {
    need(Array.isArray(value.gaps) && value.gaps.length <= 4096);
    for (const gap of value.gaps) {
      shape(gap, ['reason'], ['from', 'to', 'count', 'limit']); need(text(gap.reason, 200));
      optional(gap, 'from', day); optional(gap, 'to', day);
      optional(gap, 'count', integer); optional(gap, 'limit', integer);
    }
  }
  if (Object.hasOwn(value, 'sourceHalt')) halt(value.sourceHalt);
  if (Object.hasOwn(value, 'photoSourceHalt')) halt(value.photoSourceHalt, true);
}
function lastPoll(value, gps) {
  if (value === null) return;
  shape(value, [gps ? 'driverId' : 'runId', 'day', 'startedAt', 'status'], gps
    ? ['completedAt', 'unchanged', 'dataSnapshotSha256']
    : ['completedAt', 'unchanged', 'captureRunId', 'captureSha256', 'lastDataChangeAt', 'errorCode']);
  need((gps ? driverId(value.driverId) : runId(value.runId)) && day(value.day) && timestamp(value.startedAt)
    && ['started', 'complete', 'failed'].includes(value.status));
  optional(value, 'completedAt', timestamp); optional(value, 'unchanged', item => typeof item === 'boolean');
  optional(value, 'dataSnapshotSha256', digest); optional(value, 'captureRunId', runId);
  optional(value, 'captureSha256', digest); optional(value, 'lastDataChangeAt', item => item === null || timestamp(item));
  optional(value, 'errorCode', item => item === 'capture-not-published');
  if (!gps) need(Object.hasOwn(value, 'captureRunId') === Object.hasOwn(value, 'captureSha256'));
}
function gpsWindows(windows) {
  need(object(windows) && Object.keys(windows).length <= 700);
  for (const [key, window] of Object.entries(windows)) {
    shape(window, ['driverId', 'day'], ['scopeKind', 'vehicleNo', 'rosterReferenceDriverId', 'lastAttemptAt',
      'retryAt', 'failures', 'error', 'lastSuccessfulPollAt', 'refreshToken']);
    need(driverId(window.driverId) && day(window.day) && key === window.driverId + '/' + window.day);
    optional(window, 'scopeKind', item => ['driver', 'vehicle'].includes(item));
    optional(window, 'vehicleNo', item => text(item, 128)); optional(window, 'rosterReferenceDriverId', driverId);
    optional(window, 'lastAttemptAt', timestamp); optional(window, 'lastSuccessfulPollAt', timestamp);
    optional(window, 'retryAt', item => item === null || epoch(item)); optional(window, 'failures', integer);
    optional(window, 'refreshToken', item => text(item, 128));
    if (Object.hasOwn(window, 'error') && window.error !== null) {
      const error = window.error; shape(error, ['at', 'category', 'httpStatus', 'message']);
      need(timestamp(error.at) && ['http', 'schema', 'pagination', 'response_limit', 'capacity', 'timeout', 'read_failed'].includes(error.category)
        && (error.httpStatus === null || Number.isInteger(error.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599)
        && error.message === 'Saved GPS refresh failed; previously verified history is retained');
    }
  }
}
export function isDriverAuditPollProgressKey(key) {
  return matches(/^(?:native-progress:delivery|native-progress:gps:[a-zA-Z0-9_-]{1,60})$/, key);
}
export function validateDriverAuditPollProgressBody(key, body) {
  need(isDriverAuditPollProgressKey(key));
  const value = json(body), gps = key !== 'native-progress:delivery';
  // Store only the typed JSON itself; duplicate properties must not hide raw
  // evidence in bytes that JSON.parse would silently discard.
  need(body === JSON.stringify(value));
  shape(value, ['version', 'kind', 'lastPoll', 'lastSuccessfulPollAt', 'lastDataChangeAt',
    ...(gps ? ['namespace', 'turn', 'windows'] : ['schedule', 'photoCursor', 'photoSourceHalt'])]);
  need(value.version === 1 && value.kind === (gps ? 'native-gps-poll-progress' : 'native-delivery-poll-progress'));
  need(value.lastSuccessfulPollAt === null || timestamp(value.lastSuccessfulPollAt));
  need(value.lastDataChangeAt === null || timestamp(value.lastDataChangeAt));
  lastPoll(value.lastPoll, gps);
  if (gps) { need(value.namespace === key.slice('native-progress:gps:'.length) && integer(value.turn)); gpsWindows(value.windows); }
  else { schedule(value.schedule); need(integer(value.photoCursor)); halt(value.photoSourceHalt, true); }
  return value;
}
export function validateDriverAuditPollProgressWrite(args) {
  shape(args, ['p_key', 'p_owner', 'p_token', 'p_expected', 'p_event_id', 'p_body_text', 'p_event_text', 'p_request_text']);
  need(matches(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i, args.p_owner)
    && matches(/^[1-9][0-9]*$/, args.p_token) && Number.isSafeInteger(Number(args.p_token))
    && integer(args.p_expected) && args.p_expected < Number.MAX_SAFE_INTEGER);
  validateDriverAuditPollProgressBody(args.p_key, args.p_body_text);
  const bodySha256 = hash(args.p_body_text), event = json(args.p_event_text, 1024);
  shape(event, ['kind', 'key', 'phase', 'bodySha256']);
  need(event.kind === 'native-poll-progress' && event.key === args.p_key && event.bodySha256 === bodySha256
    && ['started', 'settled', 'schedule', 'failure'].includes(event.phase)
    && args.p_event_text === JSON.stringify({ kind: 'native-poll-progress', key: args.p_key, phase: event.phase, bodySha256 })
    && args.p_request_text === JSON.stringify({ key: args.p_key, expectedRevision: args.p_expected, bodySha256 })
    && args.p_event_id === 'progress-' + hash(JSON.stringify([args.p_key, args.p_expected, bodySha256])));
}
export function createDriverAuditPollProgress({ rpc }) {
  need(typeof rpc === 'function');
  return Object.freeze({ version: 1,
    async read({ key }) {
      need(isDriverAuditPollProgressKey(key));
      const value = await rpc('matter_hosted_state_read', { p_key: key });
      need(integer(value?.revision) && (value.body_text === null || typeof value.body_text === 'string'));
      if (value.body_text !== null) validateDriverAuditPollProgressBody(key, value.body_text);
      return { revision: value.revision, body: value.body_text };
    },
    async compareAndSwap({ key, lease, expectedRevision, eventId, body, event, request }) {
      const args = { p_key: key, p_owner: lease?.ownerId, p_token: lease?.token, p_expected: expectedRevision,
        p_event_id: eventId, p_body_text: body, p_event_text: event, p_request_text: request };
      validateDriverAuditPollProgressWrite(args);
      return rpc('matter_hosted_native_progress_cas', args);
    },
  });
}
