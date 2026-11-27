import express from 'express';
import mongoose from 'mongoose';
import Delivery from '../models/Delivery.js';
import { accountsRefundDto, pendingAccountsFilter, resolveAccountsPortal } from '../services/accountsRefundPortal.js';
import { accountsRefundUpdate, refundAlreadyPaid } from '../services/collectionRefundLinks.js';
import { collectionRefundFilter, refundError } from '../services/collectionRefund.js';
const router = express.Router(), buckets = new Map();
router.use((req, res, next) => {
  res.set({ 'Cache-Control': 'no-store, private', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
  const now = Date.now(), key = req.ip || req.socket?.remoteAddress || 'unknown';
  if (buckets.size >= 10000) for (const [id, item] of buckets) if (item.until <= now) buckets.delete(id);
  let bucket = buckets.get(key);
  if (!bucket || bucket.until <= now) { if (buckets.size >= 10000) return res.status(429).json({ success: false, message: 'Please retry shortly.' }); bucket = { count: 0, until: now + 60000 }; buckets.set(key, bucket); }
  if (++bucket.count > 120) return res.status(429).json({ success: false, message: 'Please wait a minute before retrying.' });
  next();
});
const failure = (res, error) => res.status(error.code === 11000 ? 409 : error.statusCode || 500).json({ success: false, message: error.code === 11000 ? 'A refund is already recorded for this customer. Refresh the portal.' : error.statusCode ? error.message : 'Could not update the portal. Please retry.' });
router.post('/list', async (req, res) => {
  try {
    const portal = await resolveAccountsPortal(req.body.token);
    const page = Number(req.body.page || 1);
    if (!Number.isInteger(page) || page < 1 || page > 10000) throw refundError('Choose a valid page.');
    const filter = await pendingAccountsFilter(req.body.search ?? '');
    const [records, total] = await Promise.all([Delivery.find(filter).select('_id customerId customerName collectionDetails.collectedAt completedAt collectionRefund.version').sort({ completedAt: 1, _id: 1 }).skip((page - 1) * 25).limit(25).lean(), Delivery.countDocuments(filter)]);
    res.json({ success: true, data: records.map(accountsRefundDto), total, page, pages: Math.ceil(total / 25), expiresAt: portal.expiresAt });
  } catch (error) { failure(res, error); }
});
router.post('/complete', async (req, res) => {
  try {
    await resolveAccountsPortal(req.body.token);
    if (typeof req.body.deliveryId !== 'string' || !mongoose.isValidObjectId(req.body.deliveryId)) throw refundError('Choose a valid pending refund.');
    const record = await Delivery.findOne({ ...collectionRefundFilter(), _id: req.body.deliveryId }).lean();
    if (!record) throw refundError('This collection is no longer eligible for a refund.', 409);
    if (record.collectionRefund?.status === 'refunded' || await refundAlreadyPaid(record.customerId)) throw refundError('A refund is already recorded for this customer. Refresh the portal.', 409);
    const update = accountsRefundUpdate(record, req.body);
    const filter = { ...collectionRefundFilter(), _id: record._id, 'collectionRefund.status': { $ne: 'refunded' }, 'collectionRefund.version': req.body.version === 0 ? { $in: [null, 0] } : req.body.version };
    const data = await Delivery.findOneAndUpdate(filter, update, { new: true, runValidators: true });
    if (!data) throw refundError('This refund changed. Refresh before confirming.', 409);
    req.app.get('io')?.emit('delivery:updated', data);
    res.json({ success: true, receipt: { customerName: record.customerName, customerId: record.customerId, amount: 155, reference: update.$set['collectionRefund.reference'], method: update.$set['collectionRefund.method'], confirmedByName: 'Jenniza', completedAt: update.$set['collectionRefund.updatedAt'] } });
  } catch (error) { failure(res, error); }
});
export default router;
