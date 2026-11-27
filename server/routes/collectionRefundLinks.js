import express from 'express';
import Delivery from '../models/Delivery.js';
import CollectionRefundLink from '../models/CollectionRefundLink.js';
import { collectionRefundFilter, refundError } from '../services/collectionRefund.js';
import { resolveRefundLink, accountsRefundUpdate, refundAlreadyPaid } from '../services/collectionRefundLinks.js';
const router = express.Router();
const buckets = new Map();
router.use((req, res, next) => {
  res.set({ 'Cache-Control': 'no-store, private', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
  const now = Date.now();
  if (buckets.size >= 10000) for (const [key, value] of buckets) if (value.until <= now) buckets.delete(key);
  const key = req.ip || req.socket?.remoteAddress || 'unknown';
  let bucket = buckets.get(key);
  if (!bucket || bucket.until <= now) { if (buckets.size >= 10000) return res.status(429).json({ success: false, message: 'Please retry shortly.' }); bucket = { count: 0, until: now + 60000 }; buckets.set(key, bucket); }
  if (++bucket.count > 40) return res.status(429).json({ success: false, message: 'Too many requests. Please wait a minute.' });
  next();
});
const failure = (res, error) => res.status(error.code === 11000 ? 409 : error.statusCode || 500).json({ success: false, message: error.code === 11000 ? 'A refund is already recorded for this customer.' : error.statusCode ? error.message : 'Could not update this refund. Please retry.' });
router.post('/view', async (req, res) => {
  try {
    const { link, record } = await resolveRefundLink(req.body.token);
    const ownPaid = record.collectionRefund?.status === 'refunded';
    const paid = ownPaid || await refundAlreadyPaid(record.customerId);
    res.json({ success: true, data: { customerName: record.customerName, customerId: record.customerId, amount: 155, collectedAt: record.collectionDetails?.collectedAt || record.completedAt || null, status: paid ? 'done' : 'pending', recordedElsewhere: paid && !ownPaid, reference: ownPaid ? record.collectionRefund.reference : undefined, method: ownPaid ? record.collectionRefund.method : undefined, confirmedByName: ownPaid ? record.collectionRefund.updatedByName : undefined, completedAt: ownPaid ? record.collectionRefund.updatedAt : undefined, version: record.collectionRefund?.version || 0, expiresAt: link.expiresAt } });
  } catch (error) { failure(res, error); }
});
router.post('/complete', async (req, res) => {
  try {
    const { link, record } = await resolveRefundLink(req.body.token);
    if (record.collectionRefund?.status === 'refunded') return res.json({ success: true, alreadyCompleted: true });
    if (await refundAlreadyPaid(record.customerId)) throw refundError('A refund is already recorded for this customer. Contact the team to check the record.', 409);
    const update = accountsRefundUpdate(record, req.body);
    const filter = { ...collectionRefundFilter(), _id: record._id, 'collectionRefund.status': { $ne: 'refunded' }, 'collectionRefund.version': req.body.version === 0 ? { $in: [null, 0] } : req.body.version };
    const data = await Delivery.findOneAndUpdate(filter, update, { new: true, runValidators: true });
    if (!data) throw refundError('This refund changed. Reload the page before updating it.', 409);
    // The financial record is the authority, including when this receipt update fails.
    await CollectionRefundLink.updateOne({ _id: link._id }, { $set: { usedAt: new Date() } }).catch(() => {});
    req.app.get('io')?.emit('delivery:updated', data);
    res.json({ success: true, message: 'Refund marked as Done. No payment was executed by this page.' });
  } catch (error) { failure(res, error); }
});
export default router;
