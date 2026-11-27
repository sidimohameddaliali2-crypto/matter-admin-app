import { randomUUID } from 'node:crypto';
import Digest from '../models/RefundDailyDigest.js';
import Delivery from '../models/Delivery.js';
import Link from '../models/CollectionRefundLink.js';
import Escalation from '../models/RefundEscalation.js';
import { pendingAccountsFilter, ensureAccountsPortal } from './accountsRefundPortal.js';
import { portalRefundEmailPayload, sendPayload } from './collectionRefundEmail.js';
import { ACCOUNTS_EMAIL, refundLinkOrigin } from './collectionRefundLinks.js';
import { JANA_REFUND_EMAIL } from './refundEscalations.js';
import { businessOffsetMs, toBusinessDateKey, getBusinessDayBounds } from '../utils/businessDate.js';
export function digestDay(now = new Date()) { return toBusinessDateKey(now); }
export function digestHourReady(now = new Date()) { return new Date(now.getTime() + businessOffsetMs()).getUTCHours() >= 9; }
export async function loadRefundDigest(kind, now = new Date()) {
  const filter = await pendingAccountsFilter();
  if (kind === 'jana') {
    const cutoff = new Date(now.getTime() - 48 * 3600000);
    filter.$or = [{ 'collectionDetails.collectedAt': { $lte: cutoff } }, { 'collectionDetails.collectedAt': null, completedAt: { $lte: cutoff } }];
  }
  const [total, rows] = await Promise.all([Delivery.countDocuments(filter), Delivery.find(filter).select('_id customerId customerName collectionDetails.collectedAt completedAt').sort({ completedAt: 1, _id: 1 }).limit(50).lean()]);
  return { total, rows };
}
export async function sendRefundDigestPayload(kind, facts, messageKey) {
  if (kind === 'accounts') {
    const payload = portalRefundEmailPayload(null, messageKey, await ensureAccountsPortal());
    payload.subject = `Daily bag refund summary — ${facts.total} pending — Accounts portal`;
    payload.htmlContent = payload.htmlContent.replace('<h1>Accounts refund portal</h1>', `<h1>Daily bag refund summary</h1><p><strong>${facts.total} pending refund requests</strong> in the Accounts portal. This is the daily summary; new requests appear in the portal throughout the day.</p>`);
    payload.textContent = `${facts.total} pending refund requests. Daily summary (one email per Dubai day).\n${payload.textContent}`;
    return sendPayload(payload);
  }
  const lines = facts.rows.map(record => `${record.customerName} (${record.customerId}) · AED 155 · Collected ${new Date(record.collectionDetails?.collectedAt || record.completedAt).toLocaleString('en-GB', { timeZone: 'Asia/Dubai' })} Dubai`);
  return sendPayload({
    sender: { email: process.env.BREVO_SENDER_EMAIL?.trim() || 'noreply@matternutrition.xyz', name: process.env.BREVO_SENDER_NAME?.trim() || 'MATTER Accounts' },
    to: [{ email: JANA_REFUND_EMAIL, name: 'Jana' }], subject: `Daily escalation — ${facts.total} bag refunds pending for 48+ hours`, headers: { idempotencyKey: messageKey }, tags: ['collection-refund-daily-48h'],
    textContent: `${facts.total} bag refund requests are still pending after 48 hours.\n\n${lines.join('\n')}${facts.total > facts.rows.length ? `\n\nShowing the first ${facts.rows.length}; view all ${facts.total} in the tracker.` : ''}\n\nPlease follow up with Accounts. Staff tracker: ${refundLinkOrigin()}/collections#collection-refunds\n\nOne daily summary per Dubai day. Refunds completed after this email was sent may no longer be pending.`
  });
}
export async function sendDailyRefundDigest({ kind, now = new Date(), manual = false, load = loadRefundDigest, send = sendRefundDigestPayload } = {}) {
  if (!['accounts', 'jana'].includes(kind)) throw new Error('Unknown refund digest kind');
  if (!process.env.BREVO_API_KEY?.trim() || (kind === 'accounts' ? process.env.COLLECTION_REFUND_EMAILS_ENABLED === 'false' : process.env.COLLECTION_REFUND_ESCALATIONS_ENABLED === 'false')) return { paused: true };
  if (!manual && !digestHourReady(now)) return { skipped: true };
  let facts = await load(kind, now);
  if (!facts.total && !manual) return { skipped: true };
  await Digest.init();
  const dateKey = digestDay(now), key = { kind, dateKey };
  const { startOfDay, endOfDayExclusive } = getBusinessDayBounds(now);
  // Respect any same-day acceptance from the superseded per-refund sender.
  const legacy = await (kind === 'accounts' ? Link : Escalation).exists({ ...(kind === 'jana' ? { stage: 'jana_48h' } : {}), state: 'sent', sentAt: { $gte: startOfDay, $lt: endOfDayExclusive } });
  try { await Digest.updateOne(key, { $setOnInsert: { ...key, recipient: kind === 'accounts' ? ACCOUNTS_EMAIL : JANA_REFUND_EMAIL, messageKey: randomUUID(), state: legacy ? 'sent' : 'queued', ...(legacy ? { sentAt: now, messageId: 'legacy-daily-quota' } : {}) } }, { upsert: true, runValidators: true }); }
  catch (error) { if (error.code !== 11000) throw error; }
  const previous = await Digest.findOne(key).lean();
  if (previous.state === 'sent') return { alreadySent: true };
  const entry = await Digest.findOneAndUpdate({ ...key, state: { $in: ['queued', 'sending', 'uncertain'] }, $and: [{ $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] }, { $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] }] }, { $set: { state: 'sending', leaseUntil: new Date(now.getTime() + 120000) }, $inc: { attempts: 1 } }, { new: true }).lean();
  if (!entry) return { queued: true };
  const guard = { _id: entry._id, messageKey: entry.messageKey, leaseUntil: entry.leaseUntil };
  const write = values => Digest.updateOne(guard, { $set: { ...values, leaseUntil: null } });
  if (entry.firstAttemptAt && now - new Date(entry.firstAttemptAt) >= 20 * 60000) { await write({ state: 'needs_review', errorCode: 'delivery_uncertain' }); return { needsReview: true }; }
  facts = await load(kind, now); // Recheck the unpaid queue immediately before provider submission.
  if (!facts.total && !manual) { await write({ state: 'queued', nextAttemptAt: new Date(now.getTime() + 60000) }); return { skipped: true }; }
  await Digest.updateOne(guard, { $set: { firstAttemptAt: entry.firstAttemptAt || now, count: facts.total } });
  try {
    const result = await send(kind, facts, entry.messageKey);
    await write({ state: 'sent', sentAt: now, messageId: result.messageId, errorCode: null }); return { accepted: true };
  } catch (error) {
    const rejected = /^brevo_4\d\d$/.test(error.code || '');
    await write({ state: rejected ? 'queued' : 'uncertain', ...(rejected ? { firstAttemptAt: null } : {}), nextAttemptAt: new Date(now.getTime() + (rejected ? 15 : 2) * 60000), errorCode: /^brevo_\d{3}$/.test(error.code || '') ? error.code : 'delivery_uncertain' });
    return { queued: true };
  }
}
export async function runRefundDailyDigestsOnce(options = {}) {
  for (const kind of ['accounts', 'jana']) {
    try { await sendDailyRefundDigest({ ...options, kind }); }
    catch { console.error('[refund-digest] Daily summary check failed; retrying later.'); }
  }
}
