import test from 'node:test';
import assert from 'node:assert/strict';
import { captureIngestionEnabled, ingestDriverCaptureBatch, validateCaptureEvent } from './driverCaptureEvents.js';

const account = '507f1f77bcf86cd799439011';
const actor = { id: account, role: 'driver' };
function event(id = 'event-a', overrides = {}) {
  return { schemaVersion: 1, eventId: id, eventType: 'location.observed', accountId: account,
    installationId: 'installation-a', shiftId: 'shift-a', bootSessionId: 'boot:12', sequence: '3',
    localQueuedAt: '2026-11-10T05:00:01.000Z', data: { latitude: 25, longitude: 55,
      fixAt: '2026-11-10T05:00:00.000Z', fixElapsedRealtimeNs: '1000000000',
      observedElapsedRealtimeNs: '1500000000', ageAtCaptureMs: 500,
      accuracy: 20, provider: 'gps', mocked: false, qualityFlags: [] }, ...overrides };
}
function ledger() {
  const records = new Map();
  return { records, async accept(record) {
    const key = `${record.accountId}/${record.eventId}`;
    const existing = records.get(key);
    if (existing) return { payloadHash: existing.payloadHash, duplicate: true };
    records.set(key, structuredClone(record));
    return { payloadHash: record.payloadHash, duplicate: false };
  } };
}
const ingest = (events, repository = ledger(), actorValue = actor) => ingestDriverCaptureBatch({ actor: actorValue, body: { events }, repository });

test('ingestion is explicitly staging/test gated and production defaults stay off', () => {
  for (const env of [{}, { ENABLE_DRIVER_CAPTURE_INGESTION: '1', NODE_ENV: 'production' },
    { APP_ENV: 'staging' }, { APP_ENV: 'production', NODE_ENV: 'test', ENABLE_DRIVER_CAPTURE_INGESTION: '1' }]) {
    assert.equal(captureIngestionEnabled(env), false);
  }
  assert.equal(captureIngestionEnabled({ APP_ENV: 'staging', ENABLE_DRIVER_CAPTURE_INGESTION: '1' }), true);
  assert.equal(captureIngestionEnabled({ NODE_ENV: 'test', ENABLE_DRIVER_CAPTURE_INGESTION: '1' }), true);
});
test('missing accuracy and rejected raw coordinates are preserved honestly without inventing a fix', async () => {
  const noAccuracy = event('missing-accuracy');
  noAccuracy.data.accuracy = null;
  noAccuracy.data.qualityFlags = ['accuracy_unavailable'];
  assert.equal(validateCaptureEvent(noAccuracy, account), null);
  noAccuracy.data.qualityFlags = [];
  assert.equal(validateCaptureEvent(noAccuracy, account), 'invalid_location');
  const rejected = event('rejected-fix', { eventType: 'location.rejected', data: {
    reason: 'invalid_coordinates', rawLatitude: 'NaN', rawLongitude: 'Infinity', fixElapsedRealtimeNs: '123' } });
  const store = ledger();
  assert.equal((await ingest([rejected], store)).data.accepted.length, 1);
  assert.equal([...store.records.values()][0].event.data.rawLatitude, 'NaN');
});
test('requires driver role, explicit actor and matching envelope account', async () => {
  await assert.rejects(ingest([event()], ledger(), { id: account, role: 'admin' }), { status: 403 });
  await assert.rejects(ingest([event()], ledger(), null), { status: 403 });
  const repository = ledger();
  const result = await ingest([event('foreign', { accountId: 'another-account' })], repository);
  assert.deepEqual(result.data.rejected, [{ eventId: 'foreign', reason: 'account_mismatch' }]);
  assert.equal(repository.records.size, 0);
});
test('stable retries deduplicate without changing original evidence', async () => {
  const repository = ledger(), original = event();
  const snapshot = JSON.stringify(original);
  assert.equal((await ingest([original], repository)).data.accepted[0].duplicate, false);
  assert.equal((await ingest([structuredClone(original)], repository)).data.accepted[0].duplicate, true);
  assert.equal(repository.records.size, 1);
  assert.equal(JSON.stringify(original), snapshot);
  assert.equal([...repository.records.values()][0].event.data.fixAt, original.data.fixAt);
});
test('same identity with changed payload conflicts, key order alone does not', async () => {
  const repository = ledger(), original = event();
  await ingest([original], repository);
  const reordered = Object.fromEntries(Object.entries(original).reverse());
  reordered.data = Object.fromEntries(Object.entries(original.data).reverse());
  assert.equal((await ingest([reordered], repository)).data.accepted[0].duplicate, true);
  const changed = event('event-a'); changed.data.latitude = 26;
  assert.deepEqual((await ingest([changed], repository)).data.rejected, [{ eventId: 'event-a', reason: 'event_identity_conflict' }]);
});
test('partial database failure acknowledges only committed IDs and exposes retryable work', async () => {
  const repository = ledger(), accept = repository.accept;
  repository.accept = record => record.eventId === 'temporary' ? Promise.reject(new Error('private database error')) : accept(record);
  const result = await ingest([event('accepted'), event('temporary'), event('rejected', { schemaVersion: 2 })], repository);
  assert.deepEqual(result.data.accepted, [{ eventId: 'accepted', duplicate: false }]);
  assert.deepEqual(result.data.retryable, [{ eventId: 'temporary', reason: 'ledger_temporarily_unavailable' }]);
  assert.deepEqual(result.data.rejected, [{ eventId: 'rejected', reason: 'unsupported_schema_or_type' }]);
  assert.equal(result.data.ledgerOnly, true);
  assert.equal(result.data.deliveryStateApplied, false);
  assert.equal(result.data.associationVerified, false);
  assert.ok(!JSON.stringify(result).includes('private database error'));
});
test('commit followed by response loss remains a stable duplicate on retry', async () => {
  const repository = ledger(), accept = repository.accept;
  let first = true;
  repository.accept = async record => {
    const result = await accept(record);
    if (first) { first = false; throw new Error('response lost'); }
    return result;
  };
  assert.equal((await ingest([event()], repository)).data.accepted.length, 0);
  assert.equal((await ingest([event()], repository)).data.accepted[0].duplicate, true);
  assert.equal(repository.records.size, 1);
});
test('oversized batch and invalid top-level shape fail before any write', async () => {
  await assert.rejects(ingest(Array.from({ length: 65 }, (_, index) => event(`id-${index}`))), { status: 400 });
  await assert.rejects(ingest([event('duplicate'), event('duplicate')]), { status: 400 });
  const large = Array.from({ length: 60 }, (_, index) => event(`id-${index}`, { data: { reason: 'x'.repeat(2000) } }));
  await assert.rejects(ingest(large), { status: 413 });
  await assert.rejects(ingestDriverCaptureBatch({ actor, body: { events: [event()], token: 'secret' }, repository: ledger() }), { status: 400 });
});
test('rejects local paths, credentials, unknown fields and invalid fixes', () => {
  for (const [data, reason] of [
    [{ ...event().data, uri: 'file:///proof.jpg' }, 'unsafe_or_unknown_event_data'],
    [{ ...event().data, reason: 'C:\\private\\proof.jpg' }, 'unsafe_or_unknown_event_data'],
    [{ ...event().data, reason: 'content://image/1' }, 'unsafe_or_unknown_event_data'],
    [{ ...event().data, token: 'credential' }, 'unsafe_or_unknown_event_data'],
    [{ ...event().data, latitude: 300 }, 'invalid_location'],
    [{ ...event().data, accuracy: -1 }, 'invalid_location'],
    [{ ...event().data, observedElapsedRealtimeNs: '-2' }, 'invalid_location_clock'],
  ]) assert.equal(validateCaptureEvent(event('invalid', { data }), account), reason);
});
test('photo capture preserves unavailable GPS and does not verify delivery association', async () => {
  const photo = event('photo:proof-a', { eventType: 'photo.captured', data: {
    schemaVersion: 1, eventId: 'photo:proof-a', photoId: 'proof-a', accountId: account, deliveryId: 'delivery-a',
    capturedAt: '2026-11-10T05:00:00.000Z', captureCompletedAt: '2026-11-10T05:00:01.000Z',
    byteSize: 100, contentMd5: 'a'.repeat(32),
    captureLocation: { status: 'unavailable', reason: 'stale', latitude: null, longitude: null,
      lastKnownFix: { latitude: 25, longitude: 55, fixAt: '2026-11-10T04:00:00.000Z', accuracyM: 30 } },
  } });
  const repository = ledger();
  assert.equal((await ingest([photo], repository)).data.accepted.length, 1);
  assert.equal([...repository.records.values()][0].event.data.captureLocation.status, 'unavailable');
  photo.data.uri = 'file:///private/photo.jpg';
  assert.equal(validateCaptureEvent(photo, account), 'unsafe_or_unknown_event_data');
});
test('native action envelopes accept only bounded references and never apply business state', async () => {
  for (const kind of ['delivery.completion_requested', 'delivery.status_requested', 'bag.return_requested']) {
    const id = `action:${kind}`;
    const data = { eventId: id, eventType: kind, accountId: account,
      ...(kind === 'bag.return_requested' ? { bagId: 'BAG_42' } : { deliveryId: 'delivery-a' }),
      actionAt: '2026-11-10T05:00:00.000Z', payload: { status: 'delivered', photoIds: ['proof-a'], verified: true } };
    const candidate = event(id, { eventType: kind, data });
    const repository = ledger();
    const accepted = await ingest([candidate], repository);
    assert.equal(accepted.data.accepted.length, 1);
    assert.equal(accepted.data.deliveryStateApplied, false);
    const stored = [...repository.records.values()][0].event;
    assert.equal(stored.data.actionAt, data.actionAt);
    candidate.data.payload.proof = { photoUrl: 'https://private.invalid/proof.jpg' };
    assert.equal(validateCaptureEvent(candidate, account), 'invalid_action_metadata');
  }
});
test('nested native photo/action identities cannot disagree with their immutable envelope', () => {
  const data = { eventId: 'different', photoId: 'proof-a' };
  assert.equal(validateCaptureEvent(event('photo:proof-a', { eventType: 'photo.captured', data }), account), 'nested_event_identity_mismatch');
  assert.equal(validateCaptureEvent(event('action:a', { eventType: 'delivery.completion_requested', data: { eventId: 'action:a', accountId: 'other' } }), account), 'nested_account_mismatch');
});
test('server receipt precedes repository completion and no ledger acceptance is fabricated', async () => {
  const times = ['2026-11-10T05:00:00.000Z', '2026-11-10T05:00:01.000Z'];
  const result = await ingestDriverCaptureBatch({ actor, body: { events: [event()] }, repository: ledger(), now: () => new Date(times.shift()) });
  assert.ok(result.data.serverReceivedAt < result.data.serverCommittedAt);
  const failure = await ingest([event()], { accept: async () => { throw new Error('offline'); } });
  assert.equal(failure.data.serverCommittedAt, null);
  assert.equal(failure.data.accepted.length, 0);
});
