import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import router from './collections.js';
import Delivery from '../models/Delivery.js';
import User from '../models/User.js';
import BagRefundCase from '../models/BagRefundCase.js';
import { addDaysToDateKey, toBusinessDateKey } from '../utils/businessDate.js';

const id = '507f1f77bcf86cd799439011', ownerId = '507f1f77bcf86cd799439012';
const manager = { _id: id, role: 'manager', email: 'manager@example.test', permissions: { deliveries: true } };
const record = { _id: id, type: 'Collection', status: 'collected', customerId: 'C001', collectionRequest: { refundRequestedAfterCollection: true }, collectionRefund: { version: 2 } };
const assignment = { ownerId, dueDate: '2026-12-01', version: 2, eventId: 'assign-route-001' };
afterEach(() => mock.restoreAll());
function response() { return { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } }; }
async function invoke(path, method, overrides) {
  const handler = router.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route.stack[0].handle;
  const res = response();
  await handler({ user: manager, params: { id }, body: assignment, query: {}, app: { get: () => undefined }, ...overrides }, res);
  return res;
}
function stubAssignment({ paid = [], activeOwner = true, updated = { _id: id } } = {}) {
  mock.method(Delivery, 'findOne', () => ({ lean: async () => structuredClone(record) }));
  mock.method(Delivery, 'distinct', async () => paid);
  mock.method(BagRefundCase, 'distinct', async () => []);
  mock.method(User, 'findOne', () => ({ select: () => ({ lean: async () => activeOwner ? { ...manager, _id: ownerId } : null }) }));
  return mock.method(Delivery, 'findOneAndUpdate', async () => updated);
}
test('assignment handler restricts writes to management', async () => {
  const res = await invoke('/:id/refund-assignment', 'post', { user: { ...manager, role: 'dispatcher' } });
  assert.equal(res.code, 403);
});
test('demo email denies dispatchers before provider access', async () => {
  const fetcher = mock.method(globalThis, 'fetch', () => assert.fail('Must not send a demo'));
  const denied = await invoke('/refund-email-demo', 'post', { user: { ...manager, role: 'dispatcher' }, body: {} });
  assert.equal(denied.code, 403); assert.equal(fetcher.mock.callCount(), 0);
});
test('portal email and reminder configuration remain management-only', async () => {
  const user = { ...manager, role: 'dispatcher' };
  assert.equal((await invoke('/refund-portal-email', 'post', { user, body: {} })).code, 403);
  assert.equal((await invoke('/refund-escalation-config', 'get', { user })).code, 403);
});
test('assignment handler validates owner and refuses customers already recorded as refunded', async () => {
  let write = stubAssignment({ paid: ['C001'] });
  let res = await invoke('/:id/refund-assignment', 'post');
  assert.equal(res.code, 409); assert.equal(write.mock.callCount(), 0);
  mock.restoreAll(); write = stubAssignment({ activeOwner: false });
  res = await invoke('/:id/refund-assignment', 'post');
  assert.equal(res.code, 400); assert.equal(write.mock.callCount(), 0);
});
test('assignment uses version and unpaid-status guards and never writes payment evidence', async () => {
  const write = stubAssignment();
  const res = await invoke('/:id/refund-assignment', 'post');
  assert.equal(res.code, 200);
  const [filter, update] = write.mock.calls[0].arguments;
  assert.equal(filter['collectionRefund.version'], 2);
  assert.deepEqual(filter['collectionRefund.status'], { $ne: 'refunded' });
  assert.equal(update.$set['collectionRefund.owner'], ownerId);
  assert.equal(update.$set['collectionRefund.reference'], undefined);
  assert.equal(update.$set['collectionRefund.status'], undefined);
});
test('a competing update prevents a stale follow-up from being saved', async () => {
  stubAssignment({ updated: null });
  const res = await invoke('/:id/refund-assignment', 'post');
  assert.equal(res.code, 409);
});
test('possible duplicate creation returns existing cases for review without saving another request', async () => {
  let date = toBusinessDateKey(new Date());
  while (![2, 5, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay())) date = addDaysToDateKey(date, 1);
  const existing = { _id: id, customerName: 'Sara', scheduledTime: date, status: 'pending' };
  mock.method(Delivery, 'find', () => ({ select: () => ({ limit: () => ({ lean: async () => [existing] }) }) }));
  const res = await invoke('/', 'post', { body: { customerSource: 'manual', customerName: 'Sara', address: 'Al Quoz', collectionDate: date, refundRequestedAfterCollection: true } });
  assert.equal(res.code, 409);
  assert.equal(res.body.code, 'POSSIBLE_DUPLICATE');
  assert.deepEqual(res.body.duplicates, [existing]);
});
test('existing open requests receive a possible-duplicate review link without changing records', async () => {
  const open = { _id: id, customerName: 'Sara', customerId: 'C001', scheduledTime: new Date('2026-11-26T20:00:00Z'), status: 'pending' };
  const chain = { select() { return this; }, populate() { return this; }, sort() { return this; }, skip() { return this; }, limit() { return this; }, lean: async () => [open] };
  mock.method(Delivery, 'find', () => chain);
  mock.method(Delivery, 'countDocuments', async () => 1);
  const check = mock.method(Delivery, 'exists', async () => ({ _id: ownerId }));
  const res = await invoke('/', 'get');
  assert.equal(res.code, 200);
  assert.equal(res.body.data[0].possibleDuplicateId, ownerId);
  assert.deepEqual(check.mock.calls[0].arguments[0]._id, { $ne: id });
  assert.equal(open.possibleDuplicateId, undefined);
});
