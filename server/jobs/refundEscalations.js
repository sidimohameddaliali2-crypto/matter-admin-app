import mongoose from 'mongoose';
import Delivery from '../models/Delivery.js';
import Notice from '../models/RefundEscalation.js';
import { collectionRefundFilter } from '../services/collectionRefund.js';
import { pendingAccountsFilter } from '../services/accountsRefundPortal.js';
import { refundAlreadyPaid } from '../services/collectionRefundLinks.js';
import { escalationValues, sendAdrianEscalation, sendJanaEscalation } from '../services/refundEscalations.js';
export async function runRefundEscalationsOnce({ now = new Date(), slack = sendAdrianEscalation, email = sendJanaEscalation } = {}) {
  if (process.env.COLLECTION_REFUND_ESCALATIONS_ENABLED === 'false') return;
  await Notice.init();
  const known = await Notice.distinct('delivery', { stage: 'jana_48h' });
  const filter = await pendingAccountsFilter();
  const candidates = await Delivery.find({ ...filter, _id: { $nin: known }, $or: [{ 'collectionDetails.collectedAt': { $type: 'date' } }, { completedAt: { $type: 'date' } }] }).select('_id collectionDetails.collectedAt completedAt').sort({ _id: 1 }).limit(100).lean();
  for (const record of candidates) for (const values of escalationValues(record)) {
    try { await Notice.updateOne({ delivery: record._id, stage: values.stage }, { $setOnInsert: values }, { upsert: true, runValidators: true }); }
    catch (error) { if (error.code !== 11000) throw error; }
  }
  for (let count = 0; count < 20; count++) {
    const notice = await Notice.findOneAndUpdate({ state: { $in: ['queued', 'sending', 'uncertain'] }, dueAt: { $lte: now }, $and: [{ $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] }, { $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] }] }, { $set: { state: 'sending', leaseUntil: new Date(now.getTime() + 120000) }, $inc: { attempts: 1 } }, { new: true }).lean();
    if (!notice) break;
    const guard = { _id: notice._id, messageKey: notice.messageKey, leaseUntil: notice.leaseUntil };
    const write = values => Notice.updateOne(guard, { $set: { ...values, leaseUntil: null } });
    const record = await Delivery.findOne({ ...collectionRefundFilter(), _id: notice.delivery, 'collectionRefund.status': { $ne: 'refunded' } }).select('_id customerId customerName').lean();
    if (!record || await refundAlreadyPaid(record.customerId)) { await write({ state: 'cancelled' }); continue; }
    // Slack has no assumed dedupe guarantee. A crash/timeout after attempting a send requires review.
    if (notice.firstAttemptAt && (notice.stage === 'adrian_24h' || now - new Date(notice.firstAttemptAt) >= 20 * 60000)) { await write({ state: 'needs_review', errorCode: 'delivery_uncertain' }); continue; }
    await Notice.updateOne(guard, { $set: { firstAttemptAt: notice.firstAttemptAt || now } });
    try {
      const result = await (notice.stage === 'adrian_24h' ? slack : email)(record, notice);
      await write({ state: 'sent', sentAt: now, messageId: result.messageId, errorCode: null });
    } catch (error) {
      const knownRejected = error.definitelyNotSent === true || /^brevo_4\d\d$/.test(error.code || '');
      const values = knownRejected ? { state: 'queued', firstAttemptAt: null, nextAttemptAt: new Date(now.getTime() + 15 * 60000) } : notice.stage === 'adrian_24h' ? { state: 'needs_review' } : { state: 'uncertain', nextAttemptAt: new Date(now.getTime() + 120000) };
      await write({ ...values, errorCode: /^(slack_[a-z_]+|brevo_\d{3}|brevo_missing_configuration)$/.test(error.code || '') ? error.code : 'delivery_uncertain' });
    }
  }
}
export function startRefundEscalationsJob() {
  let running = false;
  const run = async () => {
    if (running || mongoose.connection.readyState !== 1) return;
    running = true;
    try { await runRefundEscalationsOnce(); } catch { console.error('[refund-escalation] Scan failed; retrying later.'); } finally { running = false; }
  };
  setTimeout(run, 30000).unref(); setInterval(run, 60000).unref();
}
