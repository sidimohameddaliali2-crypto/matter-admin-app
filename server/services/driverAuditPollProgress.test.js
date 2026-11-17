import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createDriverAuditMongoRpc } from './driverAuditMongoRpc.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const time = '2026-11-17T08:00:00.000Z';
const delivery = () => ({ version: 1, kind: 'native-delivery-poll-progress',
  schedule: { pending: [{ day: '2026-11-17', runId: 'stream-123', final: false, attempts: 1, nextAttempt: 1794902400000 }],
    sourceAttempts: {}, lastAttempts: {}, observations: {}, gaps: [] },
  photoCursor: 0, photoSourceHalt: null, lastPoll: null, lastSuccessfulPollAt: null, lastDataChangeAt: null });
const gps = () => ({ version: 1, kind: 'native-gps-poll-progress', namespace: 'saved-gps', turn: 1,
  windows: { ['a'.repeat(24) + '/2026-11-17']: { driverId: 'a'.repeat(24), day: '2026-11-17',
    scopeKind: 'driver', lastAttemptAt: time, retryAt: null, failures: 0, error: null } },
  lastPoll: { driverId: 'a'.repeat(24), day: '2026-11-17', startedAt: time, status: 'started' },
  lastSuccessfulPollAt: null, lastDataChangeAt: null });
const args = (value = delivery(), key = 'native-progress:delivery') => {
  const body = JSON.stringify(value), bodySha256 = hash(body), expectedRevision = 0;
  return { p_key: key, p_owner: randomUUID(), p_token: '1', p_expected: expectedRevision,
    p_event_id: 'progress-' + hash(JSON.stringify([key, expectedRevision, bodySha256])), p_body_text: body,
    p_event_text: JSON.stringify({ kind: 'native-poll-progress', key, phase: 'started', bodySha256 }),
    p_request_text: JSON.stringify({ key, expectedRevision, bodySha256 }) };
};
const module = () => import('./driverAuditPollProgress.js');

test('generic state CAS cannot create polling progress without its collector lease', async () => {
  const rpc = createDriverAuditMongoRpc({ db: { collection: () => ({}) },
    client: { startSession() { throw Error('Unfenced transaction reached'); } }, objects: { putBytes() {}, readBytes() {} } });
  const value = args();
  delete value.p_owner; delete value.p_token;
  for (const key of ['native-progress:delivery', 'native-progress:gps:saved-gps', 'native-progress:unrecognized']) {
    await assert.rejects(rpc('matter_hosted_state_cas', { ...value, p_key: key }), { status: 403, code: '42501' });
  }
});

test('poll progress accepts typed scheduling metadata and binds its exact request identity', async () => {
  const { validateDriverAuditPollProgressWrite: validate } = await module();
  assert.doesNotThrow(() => validate(args()));
  assert.doesNotThrow(() => validate(args(gps(), 'native-progress:gps:saved-gps')));
  const value = delivery();
  Object.assign(value.schedule.pending[0], { nativeCaptureRunId: 'stream-100', nativeCaptureSha256: 'b'.repeat(64) });
  value.schedule.migrationCheckpointSha256 = 'c'.repeat(64);
  value.schedule.migrationPendingHistory = [{ day: '2026-11-16', runId: 'stream-100', reason: 'retained migration history',
    lastFailure: { runId: 'stream-100', day: '2026-11-16', message: 'Original bounded migration failure' } }];
  assert.doesNotThrow(() => validate(args(value)));
  for (const field of ['p_event_id', 'p_event_text', 'p_request_text']) {
    const changed = args(); changed[field] += ' ';
    assert.throws(() => validate(changed), { status: 400 });
  }
});

test('duplicate JSON properties cannot smuggle evidence into typed progress storage', async () => {
  const { validateDriverAuditPollProgressWrite: validate } = await module();
  const value = args();
  value.p_body_text = value.p_body_text.replace('"lastPoll":null', '"lastPoll":{"rawProviderPayload":{"points":[1,2,3]}},"lastPoll":null');
  const bodySha256 = hash(value.p_body_text);
  value.p_event_id = 'progress-' + hash(JSON.stringify([value.p_key, value.p_expected, bodySha256]));
  value.p_event_text = JSON.stringify({ kind: 'native-poll-progress', key: value.p_key, phase: 'started', bodySha256 });
  value.p_request_text = JSON.stringify({ key: value.p_key, expectedRevision: value.p_expected, bodySha256 });
  assert.throws(() => validate(value), { status: 400 });
});

test('poll progress rejects evidence, arbitrary payloads and foreign namespaces', async () => {
  const { validateDriverAuditPollProgressWrite: validate } = await module();
  for (const mutate of [value => { value.points = []; }, value => { value.schedule.pending[0].latitude = 25; },
    value => { value.schedule.gaps = [{ reason: 'gap', payload: {} }]; },
    value => { value.lastPoll = { runId: 'stream-1', day: '2026-11-17', startedAt: time, status: 'started', raw: [] }; }]) {
    const value = delivery(); mutate(value); assert.throws(() => validate(args(value)), { status: 400 });
  }
  for (const key of ['collector-state', 'native-progress:gps:../other', 'native-progress:gps:' + 'a'.repeat(61)]) {
    assert.throws(() => validate(args(gps(), key)), { status: 400 });
  }
  const value = gps(); value.namespace = 'different';
  assert.throws(() => validate(args(value, 'native-progress:gps:saved-gps')), { status: 400 });
});

test('poll metadata rejects invalid dates, nonfinite counters and incomplete original capture bindings', async () => {
  const { validateDriverAuditPollProgressWrite: validate } = await module();
  for (const mutate of [value => { value.schedule.pending[0].day = '2026-02-30'; },
    value => { value.schedule.pending[0].nativeCaptureRunId = 'stream-2'; },
    value => { value.photoCursor = -1; }, value => { value.lastSuccessfulPollAt = 'yesterday'; },
    value => { value.schedule.sourceAttempts['2026-11-17'] = null; },
    value => { value.schedule.pending[0].lastFailure = { runId: 'stream-1', day: '2026-11-17', message: 'x'.repeat(201) }; },
    value => { value.schedule.pending[0].runId = 'arbitrary-data'; }]) {
    const value = delivery(); mutate(value); assert.throws(() => validate(args(value)), { status: 400 });
  }
});

test('GPS retry metadata has bounded windows and never accepts raw points or provider error bodies', async () => {
  const { validateDriverAuditPollProgressWrite: validate } = await module();
  for (const mutate of [window => { window.points = []; }, window => { window.error = { at: time, category: 'http',
    httpStatus: 503, message: 'raw provider body' }; }, window => { window.driverId = 'b'.repeat(24); },
    window => { window.retryAt = -1; }, window => { window.vehicleNo = 'bad\nvalue'; }]) {
    const value = gps(); mutate(Object.values(value.windows)[0]);
    assert.throws(() => validate(args(value, 'native-progress:gps:saved-gps')), { status: 400 });
  }
  const value = gps(); value.windows = Object.fromEntries(Array.from({ length: 701 }, (_, index) => {
    const driverId = index.toString(16).padStart(24, '0');
    return [driverId + '/2026-11-17', { driverId, day: '2026-11-17', failures: 0, retryAt: null, error: null }];
  }));
  assert.throws(() => validate(args(value, 'native-progress:gps:saved-gps')), { status: 400 });
});

test('progress API rejects oversized bodies and invalid leases before accessing state', async () => {
  const { validateDriverAuditPollProgressWrite: validate, createDriverAuditPollProgress: create } = await module();
  const oversized = args(); oversized.p_body_text = JSON.stringify({ padding: 'x'.repeat(1024 * 1024) });
  assert.throws(() => validate(oversized), { status: 400 });
  const api = create({ rpc() { throw Error('State must remain untouched'); } });
  const value = args();
  await assert.rejects(api.compareAndSwap({ key: value.p_key, lease: { ownerId: randomUUID(), token: '0' },
    expectedRevision: 0, eventId: value.p_event_id, body: value.p_body_text, event: value.p_event_text,
    request: value.p_request_text }), { status: 400 });
  await assert.rejects(api.read({ key: 'collector-state' }), { status: 400 });
});
