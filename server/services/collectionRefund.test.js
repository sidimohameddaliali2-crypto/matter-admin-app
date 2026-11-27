import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCollectionRefundUpdate, collectionRefundFilter, collectionRefundQueueFilter } from './collectionRefund.js';
import { removeClientCollectionRefund } from '../middleware/collectionRefundInput.js';
import Delivery from '../models/Delivery.js';
const record = { _id: '507f1f77bcf86cd799439011', customerId: 'C001', type: 'Collection', status: 'collected', collectionRequest: { refundRequestedAfterCollection: true }, collectionDetails: {} };
const user = { _id: '507f1f77bcf86cd799439012', role: 'manager', profile: { firstName: 'Refund', lastName: 'Owner' } };
const input = { eventId: 'refund-test-001', version: 0, status: 'refunded', note: 'Transfer confirmed', method: 'bank_account', reference: 'BANK-123' };

test('Pending includes previously not refunded requests and Done includes paid customers only', () => {
  const pending = collectionRefundQueueFilter('pending', ['C002']);
  assert.deepEqual(pending.customerId, { $nin: ['C002'] });
  assert.deepEqual(pending['collectionRefund.status'], { $ne: 'refunded' });
  const done = collectionRefundQueueFilter('refunded', ['C002']);
  assert.deepEqual(done.customerId, { $in: ['C002'] });
  assert.equal(done['collectionRefund.status'], undefined);
  assert.deepEqual(collectionRefundQueueFilter('not_refunded', []).customerId, { $nin: [] });
  assert.equal(collectionRefundQueueFilter('not_refunded', [])['collectionRefund.status'], 'not_refunded');
});
test('database enforces a single recorded customer deposit refund across collection requests', () => {
  assert.ok(Delivery.schema.indexes().some(([keys, options]) => keys['collectionRefund.depositKey'] === 1 && options.unique && options.sparse));
});
test('ordinary delivery edits cannot forge or erase the refund ledger', () => {
  const payload = { collectionRefund: { status: 'refunded' }, address: 'Dubai', deliveries: [{ 'collectionRefund.status': 'refunded', notes: 'keep' }], $set: { 'collectionRefund.version': 9 }, $rename: { notes: 'collectionRefund.note' } };
  removeClientCollectionRefund(payload);
  assert.deepEqual(payload, { address: 'Dubai', deliveries: [{ notes: 'keep' }], $set: {}, $rename: {} });
});
test('only completed requested bag collections enter the pending refund queue', () => {
  const filter = collectionRefundFilter();
  assert.deepEqual(filter.status.$in, ['collected', 'completed', 'delivered']);
  assert.equal(filter['collectionRequest.refundRequestedAfterCollection'], true);
  assert.deepEqual(filter['collectionDetails.noBagsAvailable'], { $ne: true });
  for (const change of [{ type: 'Delivery' }, { status: 'assigned' }, { collectionRequest: {} }, { collectionDetails: { noBagsAvailable: true } }]) assert.throws(() => buildCollectionRefundUpdate({ ...record, ...change }, input, user), /completed bag collection/);
  assert.doesNotThrow(() => buildCollectionRefundUpdate({ ...record, status: 'delivered' }, input, user));
});
test('recording payment requires management and a reference, and preserves actor and audit evidence', () => {
  for (const role of ['driver', 'dispatcher', 'store_keeper', 'viewer']) assert.throws(() => buildCollectionRefundUpdate(record, input, { ...user, role }), error => error.statusCode === 403);
  assert.throws(() => buildCollectionRefundUpdate(record, { ...input, reference: '' }, user), /payment reference/);
  for (const method of [undefined, '', 'cash', {}, ['card']]) assert.throws(() => buildCollectionRefundUpdate(record, { ...input, method }, user), /credit\/debit card or bank account/);
  assert.equal(buildCollectionRefundUpdate(record, { ...input, method: 'card' }, user).$set['collectionRefund.method'], 'card');
  const update = buildCollectionRefundUpdate(record, input, user);
  assert.equal(update.$set['collectionRefund.depositKey'], record.customerId);
  assert.equal(update.$set['collectionRefund.updatedBy'], user._id);
  assert.equal(update.$push['collectionRefund.history'].actorName, 'Refund Owner');
  assert.equal(update.$inc['collectionRefund.version'], 1);
  assert.equal(update.$push['collectionRefund.history'].method, 'bank_account');
});
test('unpaid remains outstanding, stale updates and changes after refund completion are rejected', () => {
  const update = buildCollectionRefundUpdate(record, { ...input, status: 'not_refunded', reference: '', note: 'Waiting for accounts' }, user);
  assert.equal(update.$set['collectionRefund.status'], 'not_refunded');
  assert.equal(update.$set['collectionRefund.depositKey'], undefined);
  assert.throws(() => buildCollectionRefundUpdate(record, { ...input, version: 1 }, user), /changed/);
  assert.throws(() => buildCollectionRefundUpdate({ ...record, collectionRefund: { status: 'refunded', version: 0 } }, input, user), /already recorded/);
  assert.throws(() => buildCollectionRefundUpdate(record, { ...input, status: 'pending' }, user), /Choose/);
});
