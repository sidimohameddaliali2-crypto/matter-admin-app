import assert from 'node:assert/strict';
import test from 'node:test';
import { fleetProofForReporting, primaryProofPhoto } from './fleetProofReceipt.js';
import { recordProofReceipt } from './truckoomVisitRules.js';

const driver = 'a'.repeat(24);
const nextDriver = 'b'.repeat(24);
const handset = { lat: 25.1, lng: 55.1 };
const original = { photoUrl: '/original.jpg', photoCapturedAt: '2026-11-28T04:00:00.000Z', photoSource: 'camera' };
const receiptAt = new Date('2026-11-28T04:01:00.000Z');

function complete(delivery, incoming, { actor = { _id: driver, role: 'driver' }, location, at = receiptAt } = {}) {
  const previousPhoto = primaryProofPhoto(delivery.proof);
  const previousReceipt = delivery.fleetProofReceipt;
  delivery.proof = { ...delivery.proof, ...incoming };
  recordProofReceipt(delivery, incoming, at, { actor, previousPhoto, previousReceipt, handsetLocation: location });
  return fleetProofForReporting(delivery.fleetProofReceipt, delivery.proof);
}

test('a replacement camera proof cannot inherit retained handset coordinates', () => {
  const delivery = { driver };
  assert.deepEqual(complete(delivery, { ...original, location: handset }, { location: handset }), {
    cameraReceiptBound: true, handsetLocationBound: true, completionDriverId: driver,
  });
  const earlierReceipt = delivery.fleetProofReceipt;
  const replacement = { ...original, photoUrl: '/replacement.jpg' };
  assert.deepEqual(complete(delivery, replacement), {
    cameraReceiptBound: true, handsetLocationBound: false, completionDriverId: driver,
  });
  assert.deepEqual(delivery.proof.location, handset);
  assert.equal(fleetProofForReporting(earlierReceipt, delivery.proof), null);
});

test('post-completion reassignment cannot change the server-bound proof actor or rebind an old photo', () => {
  const delivery = { driver };
  complete(delivery, original);
  delivery.driver = nextDriver;
  assert.equal(fleetProofForReporting(delivery.fleetProofReceipt, delivery.proof).completionDriverId, driver);
  assert.equal(complete(delivery, original, { actor: { _id: nextDriver, role: 'driver' } }), null);
  assert.equal(delivery.fleetProofReceipt, null);
});

test('a retry cannot add previously unbound handset coordinates to the same proof', () => {
  const delivery = { driver };
  complete(delivery, original);
  const retry = complete(delivery, { ...original, location: handset }, { location: handset });
  assert.deepEqual(retry, { cameraReceiptBound: true, handsetLocationBound: false, completionDriverId: driver });
});

test('proof edits, upload photos and an actor who is not the assigned driver remain unbound', () => {
  for (const [incoming, actor] of [[original, { _id: driver, role: 'dispatcher' }],
    [original, { _id: nextDriver, role: 'driver' }], [{ ...original, photoSource: 'upload' }, { _id: driver, role: 'driver' }]]) {
    assert.equal(complete({ driver }, incoming, { actor }), null);
  }
  const delivery = { driver };
  complete(delivery, original);
  recordProofReceipt(delivery, { notes: 'An ordinary edit' }, receiptAt);
  assert.equal(fleetProofForReporting(delivery.fleetProofReceipt, delivery.proof).completionDriverId, driver);
  delivery.proof.photoUrl = null;
  recordProofReceipt(delivery, { photoUrl: null }, receiptAt);
  assert.equal(delivery.fleetProofReceipt, null);
});
