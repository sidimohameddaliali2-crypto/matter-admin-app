import mongoose from 'mongoose';
import Delivery from '../models/Delivery.js';
import CollectionRefundLink from '../models/CollectionRefundLink.js';
import { collectionRefundFilter } from '../services/collectionRefund.js';
import { enqueueRefundLink, refundAlreadyPaid } from '../services/collectionRefundLinks.js';
import { sendPortalRefundEmail } from '../services/collectionRefundEmail.js';

export const EMAIL_RETRY_WINDOW_MS = 20 * 60000; // Less than Brevo's 30-minute deduplication window.
export async function runCollectionRefundEmailsOnce({ send = sendPortalRefundEmail, now } = {}) {
  if (!process.env.BREVO_API_KEY?.trim() || process.env.COLLECTION_REFUND_EMAILS_ENABLED === 'false') return;
  await CollectionRefundLink.init();
  const known = await CollectionRefundLink.distinct('delivery');
  const pending = await Delivery.find({ ...collectionRefundFilter(), 'collectionRefund.status': { $ne: 'refunded' }, _id: { $nin: known } }).select('_id customerId').sort({ _id: 1 }).limit(10).lean();
  for (const record of pending) {
    if (!await refundAlreadyPaid(record.customerId)) await enqueueRefundLink(record);
  }
  for (let count = 0; count < 10; count++) {
    const at = now || new Date();
    const link = await CollectionRefundLink.findOneAndUpdate({ state: { $in: ['queued', 'uncertain', 'sending'] }, expiresAt: { $gt: at }, $and: [{ $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: at } }] }, { $or: [{ leaseUntil: null }, { leaseUntil: { $lte: at } }] }] }, { $set: { state: 'sending', leaseUntil: new Date(at.getTime() + 120000) }, $inc: { attempts: 1 } }, { new: true }).select('+tokenNonce +tokenHash').lean();
    if (!link) break;
    const guard = { _id: link._id, messageKey: link.messageKey, leaseUntil: link.leaseUntil };
    if (link.firstAttemptAt && at - new Date(link.firstAttemptAt) >= EMAIL_RETRY_WINDOW_MS) {
      await CollectionRefundLink.updateOne(guard, { $set: { state: 'needs_review', errorCode: 'delivery_uncertain', leaseUntil: null } }); continue;
    }
    const record = await Delivery.findOne({ ...collectionRefundFilter(), _id: link.delivery, 'collectionRefund.status': { $ne: 'refunded' } }).select('_id customerId customerName collectionDetails.collectedAt completedAt').lean();
    if (!record || await refundAlreadyPaid(record.customerId)) {
      await CollectionRefundLink.updateOne(guard, { $set: { state: 'cancelled', leaseUntil: null } }); continue;
    }
    if (!link.firstAttemptAt) await CollectionRefundLink.updateOne(guard, { $set: { firstAttemptAt: at } });
    try {
      const result = await send(record, link);
      await CollectionRefundLink.updateOne(guard, { $set: { state: 'sent', sentAt: at, leaseUntil: null, messageId: result.messageId || null, errorCode: null }, $push: { events: { state: 'sent', at, messageId: result.messageId, actorName: 'Automatic refund notification' } } });
    } catch (error) {
      const retry = error.retryable === true || (!/^brevo_\d{3}$/.test(String(error.code || '')) && error.code !== 'key_changed');
      await CollectionRefundLink.updateOne(guard, { $set: { state: retry ? 'uncertain' : 'failed', errorCode: /^brevo_\d{3}$/.test(error.code || '') || error.code === 'key_changed' ? error.code : 'delivery_uncertain', leaseUntil: null, nextAttemptAt: new Date(at.getTime() + 120000) } });
    }
  }
}
export function startCollectionRefundEmailsJob() {
  let running = false;
  const run = async () => {
    if (running || mongoose.connection.readyState !== 1) return;
    running = true;
    try { await runCollectionRefundEmailsOnce(); }
    catch { console.error('[refund-email] Notification scan failed; it will retry.'); }
    finally { running = false; }
  };
  setTimeout(run, 15000).unref();
  setInterval(run, 60000).unref();
}
