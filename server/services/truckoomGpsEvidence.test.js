import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { createGpsEvidenceStore, decodeGpsReceipt, scopedLiveGpsPayload, scopedHistoryGpsPayload } from './truckoomGpsEvidence.js';
const input = { kind: 'live', scope: { company: 'Fixture' }, requestStartedAt: '2026-01-01T00:00:00Z', responseReceivedAt: '2026-01-01T00:00:01Z', payload: { rows: [{ GPSActualTime: null, Latitude: 'invalid' }] } };
test('retains rejected source fields before normalization and restores hash-bound bytes', async () => {
  let saved; const retain = createGpsEvidenceStore({ available: () => true, newId: () => 'receipt-fixture', store: { create: async doc => { saved = doc[0]; } } });
  const ref = await retain(input); assert.equal(ref.receiptId, saved._id);
  assert.deepEqual(decodeGpsReceipt(saved), input.payload);
  assert.throws(() => decodeGpsReceipt({ ...saved, payloadSha256: '0'.repeat(64) }), { code: 'GPS_ARCHIVE_HASH_MISMATCH' });
});
test('live scope excludes other companies but preserves invalid rows and original clocks', () => {
  const ours = { Company: 'Fixture', Vehicle_No: '', Latitude: 'invalid', GPSActualTime: 'malformed' };
  assert.deepEqual(scopedLiveGpsPayload({ root: { VehicleData: [ours, { Company: 'Other' }] } }, 'Fixture').rows, [ours]);
  assert.deepEqual(scopedHistoryGpsPayload({ result: 1, data: [{ vehicleNumber: 'V1', timestamp: null }, { vehicleNumber: 'V2' }] }, 'V1'), { shape: 'vehicle_scoped_history_rows', result: 1, rows: [{ vehicleNumber: 'V1', timestamp: null }], excludedIdentityRows: 1 });
});
test('archive outage or insert failure cannot acknowledge retained evidence', async () => {
  let calls = 0; const store = { create: async () => { calls++; throw Error('fixture storage failure'); } };
  await assert.rejects(createGpsEvidenceStore({ store, available: () => false })(input), { code: 'GPS_ARCHIVE_UNAVAILABLE' });
  assert.equal(calls, 0); await assert.rejects(createGpsEvidenceStore({ store, available: () => true })(input));
});
test('oversize payloads fail before writing a Mongo document', async () => {
  let calls = 0; const retain = createGpsEvidenceStore({ available: () => true, store: { create: async () => { calls++; } } });
  await assert.rejects(retain({ ...input, payload: 'x'.repeat(32 * 1024 * 1024) }), { code: 'GPS_ARCHIVE_RESPONSE_TOO_LARGE' });
  assert.equal(calls, 0);
});

test('decodes native and lean Mongo BSON binary after backup/readback', async () => {
  let saved;
  const retain = createGpsEvidenceStore({ available: () => true, store: { create: async docs => { saved = docs[0]; } } });
  await retain(input);
  const restored = mongoose.mongo.BSON.deserialize(mongoose.mongo.BSON.serialize(saved));
  assert.equal(restored.payload._bsontype, 'Binary');
  assert.deepEqual(decodeGpsReceipt(restored), input.payload);
  assert.throws(() => decodeGpsReceipt({ ...restored, payloadSha256: '0'.repeat(64) }), { code: 'GPS_ARCHIVE_HASH_MISMATCH' });
});
