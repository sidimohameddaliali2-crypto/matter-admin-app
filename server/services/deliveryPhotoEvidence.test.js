import { test } from 'node:test';
import assert from 'node:assert/strict';
import Delivery from '../models/Delivery.js';

const deliveryId = '96c1b73072c7b1897087aa84';
const capturedAt = '2026-11-13T12:03:59.134Z';
const evidence = () => ({
  schemaVersion: 1, photoId: '1794571440297-gcyqm18zpc', deliveryId,
  shiftId: null, bootSessionId: 'original-boot', byteSize: 303874,
  contentMd5: 'a'.repeat(32), captureStartedAt: capturedAt,
  captureCompletedAt: '2026-11-13T12:03:59.635Z',
  location: { status: 'unavailable', reason: 'stopped', latitude: null, longitude: null },
});
const document = proof => new Delivery({ _id: deliveryId, customerId: 'STAGING-PROOF-TEST',
  customerName: 'Synthetic proof fixture', scheduledTime: new Date(), company: 'Matter', proof });

test('delivery model preserves the completion event and original photo evidence through a JSON round trip', () => {
  const incoming = { clientEventId: 'original-completion-event', photoCapturedAt: capturedAt,
    photoSource: 'camera', photoEvidence: evidence(), bagId: 'BAG-A0005', qrSkipped: false };
  const first = document(incoming);
  assert.equal(first.validateSync(), undefined);
  const saved = JSON.parse(JSON.stringify(first));
  const hydrated = JSON.parse(JSON.stringify(document(saved.proof)));
  assert.equal(hydrated.proof.clientEventId, incoming.clientEventId);
  assert.deepEqual(hydrated.proof.photoEvidence, incoming.photoEvidence);
  assert.equal(hydrated.proof.photoCapturedAt, capturedAt);
  assert.equal(hydrated.proof.bagId, 'BAG-A0005');
});

test('legacy photo proof remains valid without capture linkage', () => {
  const legacy = document({ photoUrl: 'https://staging.invalid/photo.jpg', bagId: 'BAG-00077' });
  assert.equal(legacy.validateSync(), undefined);
  const proof = legacy.toObject().proof;
  assert.equal(proof.photoEvidence, undefined);
  assert.equal(proof.clientEventId, undefined);
});

test('available and stale capture snapshots retain accuracy and original fix timing', () => {
  const available = { status: 'available', latitude: 25, longitude: 55, accuracyM: 12,
    fixAt: capturedAt, ageMs: 0, provider: 'fused', fixElapsedRealtimeNs: '123456789',
    mocked: false, qualityFlags: [] };
  const fresh = document({ photoEvidence: { ...evidence(), location: available } });
  assert.equal(fresh.validateSync(), undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(fresh)).proof.photoEvidence.location, available);
  const stale = document({ photoEvidence: { ...evidence(), location: {
    status: 'unavailable', reason: 'stale_fix', latitude: null, longitude: null,
    ageMs: 120000, lastKnownFix: { latitude: 25, longitude: 55, accuracyM: 12, fixAt: capturedAt },
  } } });
  assert.equal(stale.validateSync(), undefined);
  assert.equal(stale.toObject().proof.photoEvidence.location.latitude, null);
  assert.equal(stale.toObject().proof.photoEvidence.location.lastKnownFix.accuracyM, 12);
});

test('invalid capture claims cannot silently change delivery association or fabricate unavailable GPS', () => {
  for (const changes of [
    { deliveryId: 'a'.repeat(24) }, { byteSize: 750001 }, { contentMd5: 'invalid' },
    { location: { status: 'unavailable', reason: 'stopped', latitude: 25, longitude: 55 } },
    { location: { status: 'available', latitude: 25, longitude: 55 } },
  ]) assert.ok(document({ photoEvidence: { ...evidence(), ...changes } }).validateSync());
});

test('local paths and arbitrary metadata are not persisted in delivery proof', () => {
  const item = document({ photoEvidence: { ...evidence(), uri: 'file:///private/photo.jpg',
    location: { ...evidence().location, secret: 'not-evidence' } } });
  assert.equal(item.validateSync(), undefined);
  const stored = JSON.stringify(item.toObject().proof.photoEvidence);
  assert.equal(stored.includes('file:///'), false);
  assert.equal(stored.includes('not-evidence'), false);
});
