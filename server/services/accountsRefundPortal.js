import { randomBytes, createHmac } from 'node:crypto';
import Portal from '../models/AccountsRefundPortal.js';
import Delivery from '../models/Delivery.js';
import BagRefundCase from '../models/BagRefundCase.js';
import { ACCOUNTS_EMAIL, hashRefundToken, refundLinkOrigin, LINK_LIFETIME_MS } from './collectionRefundLinks.js';
import { collectionRefundQueueFilter, refundError } from './collectionRefund.js';
import { literalPattern } from './collectionOperations.js';

export function portalToken(nonce) {
  if ((process.env.JWT_SECRET?.length || 0) < 16) throw refundError('Accounts portal is not configured.', 503);
  return createHmac('sha256', process.env.JWT_SECRET).update(`matter:accounts-refund-portal:v1:${nonce}`).digest('base64url');
}
// Separate purpose/model: an old single-refund capability never grants portal access.
export async function ensureAccountsPortal(now = new Date()) {
  await Portal.init();
  const fields = '+tokenHash +tokenNonce';
  for (let attempt = 0; attempt < 3; attempt++) {
    const previous = await Portal.findOne({ mailbox: ACCOUNTS_EMAIL }).select(fields).lean();
    if (previous && new Date(previous.expiresAt) > now && hashRefundToken(portalToken(previous.tokenNonce)) === previous.tokenHash) return previous;
    const tokenNonce = randomBytes(32).toString('hex');
    const values = { tokenNonce, tokenHash: hashRefundToken(portalToken(tokenNonce)), expiresAt: new Date(now.getTime() + LINK_LIFETIME_MS) };
    try {
      const updated = await Portal.findOneAndUpdate(previous ? { _id: previous._id, updatedAt: previous.updatedAt } : { mailbox: ACCOUNTS_EMAIL }, previous ? { $set: values } : { $setOnInsert: { ...values, mailbox: ACCOUNTS_EMAIL } }, { new: true, upsert: !previous, runValidators: true }).select(fields).lean();
      if (updated) return updated;
    } catch (error) { if (error.code !== 11000) throw error; }
  }
  throw refundError('The Accounts portal changed. Please retry.', 409);
}
export const accountsPortalUrl = portal => `${refundLinkOrigin()}/refund/portal#${portalToken(portal.tokenNonce)}`;
export async function resolveAccountsPortal(token, now = new Date()) {
  if (typeof token !== 'string' || !/^[\w-]{43}$/.test(token)) throw refundError('Open the private Accounts portal link from the email.', 404);
  const portal = await Portal.findOne({ mailbox: ACCOUNTS_EMAIL, tokenHash: hashRefundToken(token) }).lean();
  if (!portal) throw refundError('This Accounts portal link is invalid or was replaced.', 404);
  if (new Date(portal.expiresAt) <= now) throw refundError('This Accounts portal link has expired. Ask the team to email a fresh portal link.', 410);
  return portal;
}
export async function pendingAccountsFilter(search = '') {
  if (typeof search !== 'string' || search.length > 120) throw refundError('Search must be at most 120 characters.');
  const [local, bags] = await Promise.all([Delivery.distinct('customerId', { 'collectionRefund.status': 'refunded' }), BagRefundCase.distinct('customerId', { status: 'completed' })]);
  const filter = collectionRefundQueueFilter('pending', [...new Set([...local, ...bags])]);
  if (search.trim()) filter.$or = ['customerName', 'customerId'].map(key => ({ [key]: { $regex: literalPattern(search.trim()), $options: 'i' } }));
  return filter;
}
export function accountsRefundDto(record) {
  return { id: String(record._id), customerName: record.customerName, customerId: record.customerId, amount: 155, collectedAt: record.collectionDetails?.collectedAt || record.completedAt || null, version: record.collectionRefund?.version || 0 };
}
