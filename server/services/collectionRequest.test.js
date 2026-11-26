import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCollectionRequest as build } from './collectionRequest.js';
const buildCollectionRequest = (input, customer, actor, now = new Date('2026-11-22T08:00:00Z')) => build(input, customer, actor, now);

const valid = { customerSource: 'manual', customerName: 'Jane Smith', address: 'Al Quoz, Dubai', collectionDate: '2026-11-27', refundRequestedAfterCollection: false };
test('weekly collection schedule accepts only Tuesday Friday and Saturday in Dubai', () => {
  for (const day of ['24', '27', '28']) assert.doesNotThrow(() => buildCollectionRequest({ ...valid, collectionDate: `2026-11-${day}` }, null, 'staff'));
  for (const day of ['23', '25', '26', '29']) assert.throws(() => buildCollectionRequest({ ...valid, collectionDate: `2026-11-${day}` }, null, 'staff'), /Tuesday, Friday and Saturday/);
});
test('manual requests get unique identities and never claim customer matching', () => {
  const first = buildCollectionRequest(valid, null, 'staff');
  const second = buildCollectionRequest(valid, null, 'staff');
  assert.notEqual(first.customerId, second.customerId);
  assert.match(first.customerId, /^MANUAL-COLLECTION-/);
  assert.equal(first.type, 'Collection');
  assert.equal(first.status, 'pending');
  assert.equal(first.scheduledTime.toISOString(), '2026-11-26T20:00:00.000Z');
  assert.equal(first.collectionRequest.refundRequestedAfterCollection, false);
  assert.equal(first.driver, undefined);
});
test('internal identity comes from database, and declaration uses the authenticated actor', () => {
  const now = new Date();
  const result = buildCollectionRequest({ ...valid, customerSource: 'internal', customerName: 'spoofed', refundRequestedAfterCollection: true, recordedBy: 'spoofed', latitude: '25.126898', longitude: '55.225061' }, { customerId: 'C001', firstName: 'Actual', lastName: 'Customer' }, 'staff', now);
  assert.equal(result.customerName, 'Actual Customer');
  assert.equal(result.customerId, 'C001');
  assert.deepEqual(result.collectionRequest, { customerSource: 'internal', phone: '', refundRequestedAfterCollection: true, recordedBy: 'staff', recordedAt: now });
  assert.equal(result.gpsLocation.lat, 25.126898);
});
test('invalid requests cannot silently become manual customers or invalid map pins', () => {
  for (const change of [{ customerSource: 'internal' }, { customerSource: 'other' }, { customerName: '' }, { address: '' }, { collectionDate: '2026-11-27T14:30' }, { collectionDate: 'garbage' }, { collectionDate: '2026-02-30' }, { collectionDate: '' }, { refundRequestedAfterCollection: 'true' }, { latitude: '91', longitude: 55 }, { latitude: 25 }, { latitude: 'abc', longitude: 55 }]) {
    assert.throws(() => buildCollectionRequest({ ...valid, ...change }, null, 'staff'), error => error.statusCode === 400);
  }
});
test('requesting a refund records intent without marking any deposit paid', () => {
  const request = buildCollectionRequest({ ...valid, refundRequestedAfterCollection: true, depositAlreadyRefunded: true }, null, 'staff');
  assert.equal(request.collectionRequest.refundRequestedAfterCollection, true);
  assert.equal(request.collectionRequest.depositAlreadyRefunded, undefined);
  assert.throws(() => buildCollectionRequest({ ...valid, refundRequestedAfterCollection: undefined, depositAlreadyRefunded: true }, null, 'staff'), error => error.statusCode === 400);
});

test('new requests cannot be backdated across the Dubai midnight boundary', () => {
  assert.doesNotThrow(() => buildCollectionRequest(valid, null, 'staff', new Date('2026-11-27T19:59:59Z')));
  assert.throws(() => buildCollectionRequest(valid, null, 'staff', new Date('2026-11-27T20:00:00Z')), /today or later/);
});
