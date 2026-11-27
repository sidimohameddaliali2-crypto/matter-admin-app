import test, { afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import Portal from '../models/AccountsRefundPortal.js';
import Delivery from '../models/Delivery.js';
import BagRefundCase from '../models/BagRefundCase.js';
import router from '../routes/accountsRefundPortal.js';
import { portalToken, accountsPortalUrl, ensureAccountsPortal, accountsRefundDto } from './accountsRefundPortal.js';
import { deriveRefundToken, hashRefundToken } from './collectionRefundLinks.js';
import { portalRefundEmailPayload } from './collectionRefundEmail.js';
const oldSecret = process.env.JWT_SECRET;
beforeEach(() => { process.env.JWT_SECRET = 'portal-fixture-secret-is-not-production'; });
afterEach(() => { mock.restoreAll(); if (oldSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = oldSecret; });
const id = '507f1f77bcf86cd799439011';
const record = { _id: id, type: 'Collection', status: 'collected', customerId: 'C001', customerName: 'Sara', collectionRequest: { refundRequestedAfterCollection: true }, collectionRefund: { version: 2 }, collectionDetails: { collectedAt: new Date() } };
const chain = value => ({ select() { return this; }, sort() { return this; }, skip() { return this; }, limit() { return this; }, lean: async () => value });
function stubPortal(expiresAt = new Date(Date.now() + 86400000)) {
  const tokenNonce = 'fixture-portal-nonce', token = portalToken(tokenNonce), portal = { _id: id, mailbox: 'accounts@matternutrition.xyz', tokenNonce, tokenHash: hashRefundToken(token), expiresAt };
  mock.method(Portal, 'findOne', filter => chain(!filter.tokenHash || filter.tokenHash === portal.tokenHash ? portal : null));
  return { token, portal };
}
async function invoke(path, body) {
  const handler = router.stack.find(layer => layer.route?.path === path).route.stack[0].handle;
  const res = { code: 200, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
  await handler({ body, app: { get: () => null } }, res); return res;
}
test('portal capabilities use a distinct HMAC purpose and shared active link is reused', async () => {
  const { portal } = stubPortal(); mock.method(Portal, 'init', async () => {});
  mock.method(Portal, 'findOneAndUpdate', () => assert.fail('An active portal must not rotate'));
  assert.notEqual(portalToken(portal.tokenNonce), deriveRefundToken(portal.tokenNonce));
  assert.equal((await ensureAccountsPortal()).tokenHash, portal.tokenHash);
  assert.match(accountsPortalUrl(portal), /\/refund\/portal#[\w-]{43}$/);
  const payload = portalRefundEmailPayload(record, 'fixture-mail-id', portal);
  assert.equal(payload.to[0].email, 'accounts@matternutrition.xyz'); assert.match(payload.htmlContent, /all pending bag refunds/); assert.match(payload.htmlContent, /\/refund\/portal#/);
});
test('missing, expired and single-refund tokens cannot list the portal', async () => {
  const { portal } = stubPortal(new Date(0));
  assert.equal((await invoke('/list', {})).code, 404);
  assert.equal((await invoke('/list', { token: portalToken(portal.tokenNonce) })).code, 410);
  assert.equal((await invoke('/list', { token: deriveRefundToken(portal.tokenNonce) })).code, 404);
});
test('portal lists only unpaid eligible refunds, bounds pages and returns minimal DTOs', async () => {
  const { token } = stubPortal(); let filter;
  mock.method(Delivery, 'distinct', async () => ['C-PAID']); mock.method(BagRefundCase, 'distinct', async () => ['C-BAG-PAID']);
  mock.method(Delivery, 'find', value => { filter = value; return chain([record, { ...record, _id: 'other', customerId: 'C002' }]); });
  mock.method(Delivery, 'countDocuments', async () => 2);
  const res = await invoke('/list', { token, search: 'Sa.*', page: 1 });
  assert.equal(res.code, 200); assert.equal(res.body.data.length, 2);
  assert.deepEqual(filter.customerId, { $nin: ['C-PAID', 'C-BAG-PAID'] });
  assert.equal(filter['collectionRequest.refundRequestedAfterCollection'], true);
  assert.equal(filter.$or[0].customerName.$regex, 'Sa\\.\\*');
  assert.equal(res.body.data[0].collectionRefund, undefined); assert.equal(res.body.data[0].address, undefined);
  assert.deepEqual(Object.keys(accountsRefundDto(record)).sort(), ['amount', 'collectedAt', 'customerId', 'customerName', 'id', 'version'].sort());
  assert.equal((await invoke('/list', { token, page: 10001 })).code, 400);
});
test('portal completes the selected eligible record with version, method, Jenniza and source audit guards', async () => {
  const { token } = stubPortal(); let captured;
  mock.method(Delivery, 'findOne', () => chain(record)); mock.method(Delivery, 'exists', async () => false); mock.method(BagRefundCase, 'exists', async () => false);
  mock.method(Delivery, 'findOneAndUpdate', async (filter, update) => { captured = { filter, update }; return record; });
  const body = { token, deliveryId: id, confirmed: true, method: 'card', reference: 'CARD-001', version: 2, eventId: 'portal-fixture-01', confirmedByName: 'Forged' };
  assert.equal((await invoke('/complete', { ...body, method: '' })).code, 400);
  const res = await invoke('/complete', body);
  assert.equal(res.code, 200); assert.equal(res.body.receipt.confirmedByName, 'Jenniza'); assert.equal(res.body.receipt.method, 'card');
  assert.equal(captured.filter._id, id); assert.equal(captured.filter['collectionRefund.version'], 2);
  assert.equal(captured.update.$push['collectionRefund.history'].actorType, 'accounts_email_link');
  assert.equal(captured.update.$set['collectionRefund.depositKey'], 'C001');
});
test('paid customers and competing writes cannot be overwritten from the portal', async () => {
  const { token } = stubPortal();
  mock.method(Delivery, 'findOne', () => chain(record)); mock.method(Delivery, 'exists', async () => true); mock.method(BagRefundCase, 'exists', async () => false);
  const write = mock.method(Delivery, 'findOneAndUpdate', async () => null);
  const body = { token, deliveryId: id, confirmed: true, method: 'bank_account', reference: 'BANK-01', version: 2, eventId: 'portal-fixture-01' };
  assert.equal((await invoke('/complete', body)).code, 409); assert.equal(write.mock.callCount(), 0);
  mock.method(Delivery, 'exists', async () => false);
  assert.equal((await invoke('/complete', body)).code, 409);
});
