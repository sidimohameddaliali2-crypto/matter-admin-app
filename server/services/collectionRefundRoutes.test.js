import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import router from '../routes/collections.js';
import Delivery from '../models/Delivery.js';
import BagRefundCase from '../models/BagRefundCase.js';
const saved = { findById: Delivery.findById, exists: Delivery.exists, update: Delivery.findOneAndUpdate, bagExists: BagRefundCase.exists };
afterEach(() => { Delivery.findById = saved.findById; Delivery.exists = saved.exists; Delivery.findOneAndUpdate = saved.update; BagRefundCase.exists = saved.bagExists; });
const handler = router.stack.find(layer => layer.route?.path === '/:id/refund').route.stack[0].handle;
const record = { _id: '507f1f77bcf86cd799439011', customerId: 'C001', type: 'Collection', status: 'collected', collectionRequest: { refundRequestedAfterCollection: true } };
const req = () => ({ params: { id: record._id }, user: { _id: '507f1f77bcf86cd799439012', role: 'admin' }, body: { eventId: 'refund-test-001', version: 0, status: 'refunded', note: 'Payment checked', method: 'bank_account', reference: 'BANK-123' }, app: { get: () => null } });
const res = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
function stub(value = record) { Delivery.findById = () => ({ lean: async () => value }); Delivery.exists = async () => false; BagRefundCase.exists = async () => false; }
test('refund write atomically checks collection eligibility and the expected version', async () => {
  stub(); let captured;
  Delivery.findOneAndUpdate = async (filter, update) => { captured = { filter, update }; return record; };
  const result = res(); await handler(req(), result);
  assert.equal(result.statusCode, 200);
  assert.equal(captured.filter._id, record._id);
  assert.deepEqual(captured.filter['collectionRefund.version'], { $in: [null, 0] });
  assert.deepEqual(captured.filter['collectionDetails.noBagsAvailable'], { $ne: true });
});
test('a previously recorded refund in Bag Operations blocks a second completion', async () => {
  stub(); BagRefundCase.exists = async () => ({ _id: 'existing-case' });
  Delivery.findOneAndUpdate = () => assert.fail('must not write');
  const result = res(); await handler(req(), result);
  assert.equal(result.statusCode, 409);
});
test('retrying an already applied event is idempotent; conflicting concurrent changes fail', async () => {
  const input = req();
  stub({ ...record, collectionRefund: { history: [{ eventId: input.body.eventId, actor: input.user._id, status: 'refunded' }] } });
  const duplicate = res(); await handler(input, duplicate); assert.equal(duplicate.body.duplicate, true);
  stub(); Delivery.findOneAndUpdate = async () => null;
  const conflict = res(); await handler(req(), conflict); assert.equal(conflict.statusCode, 409);
});
