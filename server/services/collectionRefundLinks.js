import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import Delivery from '../models/Delivery.js';
import BagRefundCase from '../models/BagRefundCase.js';
import CollectionRefundLink from '../models/CollectionRefundLink.js';
import { collectionRefundFilter, buildCollectionRefundUpdate, refundError } from './collectionRefund.js';

export const ACCOUNTS_EMAIL = 'accounts@matternutrition.xyz';
export const LINK_LIFETIME_MS = 7 * 86400000;
export const refundEmailEnabled = () => !!process.env.BREVO_API_KEY?.trim() && (process.env.JWT_SECRET?.length || 0) >= 16 && process.env.COLLECTION_REFUND_EMAILS_ENABLED !== 'false';
export const hashRefundToken = token => createHash('sha256').update(token).digest('hex');
export function deriveRefundToken(nonce, secret = process.env.JWT_SECRET) {
  if (!secret || secret.length < 16) throw refundError('Refund email links are not configured.', 503);
  return createHmac('sha256', secret).update(`matter:collection-refund:v1:${nonce}`).digest('base64url');
}
export function refundLinkOrigin() {
  let url;
  try { url = new URL(process.env.PUBLIC_APP_URL || 'https://matterapp.online'); }
  catch { throw refundError('Configure a valid HTTPS PUBLIC_APP_URL.', 503); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw refundError('Configure a valid HTTPS PUBLIC_APP_URL.', 503);
  return url.origin;
}
export function newRefundLink(delivery, now = new Date()) {
  const nonce = randomBytes(32).toString('hex');
  return { delivery, tokenNonce: nonce, tokenHash: hashRefundToken(deriveRefundToken(nonce)), expiresAt: new Date(now.getTime() + LINK_LIFETIME_MS), recipient: ACCOUNTS_EMAIL, messageKey: randomUUID(), state: 'queued', attempts: 0, nextAttemptAt: now };
}
export async function refundAlreadyPaid(customerId) {
  const [collection, bags] = await Promise.all([Delivery.exists({ customerId, 'collectionRefund.status': 'refunded' }), BagRefundCase.exists({ customerId, status: 'completed' })]);
  return !!(collection || bags);
}
export async function enqueueRefundLink(record, { resend = false, actorName = 'Automatic refund notification' } = {}) {
  if (!refundEmailEnabled()) throw refundError('Refund emails are not configured or are paused. Contact an administrator.', 503);
  refundLinkOrigin();
  if (await refundAlreadyPaid(record.customerId)) throw refundError('A refund is already recorded for this customer.', 409);
  const values = newRefundLink(record._id);
  await CollectionRefundLink.init();
  if (resend) {
    const now = new Date();
    const previous = await CollectionRefundLink.findOne({ delivery: record._id });
    if (!previous) return enqueueRefundLink(record);
    if (previous && ((previous.leaseUntil && previous.leaseUntil > now) || (previous.updatedAt && now - previous.updatedAt < 60000))) throw refundError('An email was recently queued or is sending. Wait a minute before retrying.', 409);
    const data = await CollectionRefundLink.findOneAndUpdate({ delivery: record._id, updatedAt: previous.updatedAt }, { $set: { ...values, usedAt: null, firstAttemptAt: null, leaseUntil: null, sentAt: null, messageId: null, errorCode: null }, $push: { events: { at: now, state: 'queued', actorName } } }, { new: true, runValidators: true });
    if (!data) throw refundError('Email status changed. Refresh before resending.', 409);
    return data;
  }
  try { return await CollectionRefundLink.findOneAndUpdate({ delivery: record._id }, { $setOnInsert: values }, { upsert: true, new: true, runValidators: true }); }
  catch (error) { if (error.code !== 11000) throw error; return CollectionRefundLink.findOne({ delivery: record._id }); }
}
export async function resolveRefundLink(token, now = new Date()) {
  if (typeof token !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(token)) throw refundError('This refund link is invalid.', 404);
  const link = await CollectionRefundLink.findOne({ tokenHash: hashRefundToken(token) }).lean();
  if (!link || link.state === 'cancelled') throw refundError('This refund link is invalid or was replaced. Ask the team to resend it.', 404);
  if (new Date(link.expiresAt) <= now) throw refundError('This refund link has expired. Ask the team to send a new link.', 410);
  const record = await Delivery.findOne({ ...collectionRefundFilter(), _id: link.delivery }).lean();
  if (!record) throw refundError('This collection is no longer eligible for a refund update.', 409);
  return { link, record };
}
export function accountsRefundUpdate(record, input) {
  if (input.confirmed !== true) throw refundError('Confirm that the AED 155 deposit has been refunded.');
  const update = buildCollectionRefundUpdate(record, { ...input, status: 'refunded', note: typeof input.note === 'string' && input.note.trim() ? input.note : 'Refund recorded through the Accounts email link.' }, { role: 'admin', email: ACCOUNTS_EMAIL, profile: { firstName: 'Accounts via email link' } });
  delete update.$set['collectionRefund.updatedBy'];
  update.$unset = { 'collectionRefund.updatedBy': 1 };
  update.$push['collectionRefund.history'].actorType = 'accounts_email_link';
  update.$push['collectionRefund.history'].actorEmail = ACCOUNTS_EMAIL;
  return update;
}
export function refundEmailStatus(link) {
  if (!link) return { state: 'not_queued', recipient: ACCOUNTS_EMAIL };
  return { state: link.state, recipient: ACCOUNTS_EMAIL, sentAt: link.sentAt, expiresAt: link.expiresAt, usedAt: link.usedAt, errorCode: link.errorCode };
}
