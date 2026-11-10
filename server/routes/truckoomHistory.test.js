import test from 'node:test';
import assert from 'node:assert/strict';
import router from './truckoomApi.js';
import History from '../models/VehicleLocationHistory.js';
const handler = router.stack.find(layer => layer.route?.path === '/history').route.stack.at(-1).handle;
async function request(query) { const result = {}; await handler({ query }, { status(code) { result.status = code; return this; }, json(body) { result.body = body; } }); return result; }
function stub(t, rows) { const calls = {}; t.mock.method(History, 'find', query => { calls.query = query; const q = { sort: v => (calls.sort = v, q), limit: v => (calls.limit = v, q), select: () => q, lean: async () => rows }; return q; }); return calls; }
test('staff history retains receipt time and adds real fix clock with explicit truncation', async t => {
  const rows = Array.from({ length: 10001 }, (_, i) => ({ _id: String(i), vehicleNo: 'V1', latitude: 25, longitude: 55, recordedAt: '2026-01-01T00:01:00Z', gpsTime: '2026-01-01T00:00:00Z' }));
  const calls = stub(t, rows); const result = await request({ vehicleNo: 'V1', from: '2026-01-01', to: '2026-01-02' });
  assert.equal(result.body.data.length, 10000); assert.equal(result.body.pagination.truncated, true);
  assert.deepEqual(calls.sort, { recordedAt: 1, _id: 1 }); assert.equal(calls.limit, 10001);
  assert.equal(result.body.data[0].recordedAt, rows[0].recordedAt); assert.equal(result.body.data[0].gpsTime, rows[0].gpsTime);
  assert.equal(calls.query.recordedAt.$gte.toISOString(), '2026-01-01T00:00:00.000Z');
});
test('invalid raw coordinates are never staff map positions and archive payload stays private', async t => {
  stub(t, [{ _id: 'fixture', vehicleNo: 'V1', latitude: 999, longitude: 0, captureBatchId: 'batch', sourceReceipt: { receiptId: 'receipt', sha256: 'a'.repeat(64), payload: 'must-not-leak' }, qualityFlags: ['invalid_coordinates'] }]);
  const { body } = await request({ vehicleNo: 'V1' }); assert.equal(body.data[0].latitude, null); assert.equal(body.data[0].longitude, null);
  assert.equal(body.data[0].capture.batchId, 'batch'); assert.ok(!JSON.stringify(body).includes('must-not-leak'));
});
test('staff query objects and invalid dates fail before reading history', async t => {
  stub(t, []); for (const query of [{ vehicleNo: { $ne: null } }, { vehicleNo: 'V1', from: 'invalid' }, { driverId: 'invalid' }]) assert.equal((await request(query)).status, 400);
  assert.equal(History.find.mock.callCount(), 0);
});
