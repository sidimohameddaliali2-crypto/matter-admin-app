import express from 'express';
import mongoose from 'mongoose';
import Delivery from '../models/Delivery.js';
import Customer from '../models/Customer.js';
import BagRefundCase from '../models/BagRefundCase.js';
import { collectionRefundFilter, collectionRefundQueueFilter, canRecordCollectionRefund, buildCollectionRefundUpdate, refundError } from '../services/collectionRefund.js';
import { protect, authorize } from '../middleware/auth.js';
import { effectivePermissions } from '../models/User.js';
import { detectAreaFromAddress } from '../config/areas.js';
import { buildCollectionRequest } from '../services/collectionRequest.js';
import { saveReportingDelivery } from '../services/reportingOutbox.js';

const router = express.Router();
router.use(protect, authorize(['super_admin', 'admin', 'manager', 'dispatcher']));
router.use((req, res, next) => {
  if (!effectivePermissions(req.user).deliveries) return res.status(403).json({ success: false, message: 'Collection access denied' });
  res.setHeader('Cache-Control', 'no-store');
  next();
});

router.get('/refunds', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const [localPaid, bagPaid] = await Promise.all([
      Delivery.distinct('customerId', { 'collectionRefund.status': 'refunded' }),
      BagRefundCase.distinct('customerId', { status: 'completed' })
    ]);
    const paid = [...new Set([...localPaid, ...bagPaid])];
    const filter = collectionRefundQueueFilter(req.query.status, paid);
    const [records, total] = await Promise.all([
      Delivery.find(filter).select('customerId customerName scheduledTime collectionDetails completedAt collectionRefund').sort({ 'collectionDetails.collectedAt': -1, updatedAt: -1, _id: -1 }).skip((page - 1) * 25).limit(25).lean(),
      Delivery.countDocuments(filter)
    ]);
    res.json({ success: true, data: records.map(record => ({ ...record, refundStatus: paid.includes(record.customerId) ? 'refunded' : record.collectionRefund?.status || 'pending', recordedForCustomer: paid.includes(record.customerId) && record.collectionRefund?.status !== 'refunded' })), total, page, pages: Math.ceil(total / 25), canUpdate: canRecordCollectionRefund(req.user) });
  } catch (error) { res.status(500).json({ success: false, message: 'Unable to load refund tracking.' }); }
});

router.post('/:id/refund', async (req, res) => {
  try {
    if (!canRecordCollectionRefund(req.user)) throw refundError('Management access is required to update refunds.', 403);
    if (!mongoose.isValidObjectId(req.params.id)) throw refundError('Invalid collection ID.');
    const record = await Delivery.findById(req.params.id).lean();
    if (!record) throw refundError('Collection not found.', 404);
    const prior = record.collectionRefund?.history?.find(event => event.eventId === req.body.eventId);
    if (prior) {
      if (String(prior.actor) !== String(req.user._id) || prior.status !== req.body.status) throw refundError('Update ID already used.', 409);
      return res.json({ success: true, duplicate: true });
    }
    const update = buildCollectionRefundUpdate(record, req.body, req.user);
    const [otherPaid, bagPaid] = await Promise.all([
      Delivery.exists({ customerId: record.customerId, 'collectionRefund.status': 'refunded' }),
      BagRefundCase.exists({ customerId: record.customerId, status: 'completed' })
    ]);
    if (otherPaid || bagPaid) throw refundError('A refund is already recorded for this customer. Refresh the tracker.', 409);
    const filter = { ...collectionRefundFilter(), _id: record._id };
    filter['collectionRefund.version'] = req.body.version === 0 ? { $in: [null, 0] } : req.body.version;
    const data = await Delivery.findOneAndUpdate(filter, update, { new: true, runValidators: true });
    if (!data) throw refundError('The collection or refund changed. Refresh before retrying.', 409);
    req.app.get('io')?.emit('delivery:updated', data);
    res.json({ success: true, message: 'Refund tracking updated. No payment was executed.' });
  } catch (error) { res.status(error.code === 11000 ? 409 : error.statusCode || 500).json({ success: false, message: error.code === 11000 ? 'A refund was already recorded for this customer. Refresh the tracker.' : error.statusCode ? error.message : 'Unable to update refund tracking.' }); }
});

router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, Math.min(10000, parseInt(req.query.page, 10) || 1));
    const filter = { type: 'Collection' };
    const [data, total] = await Promise.all([
      Delivery.find(filter).select('customerId customerName address gpsLocation scheduledTime status collectionRequest createdAt driver')
        .populate('driver', 'profile.firstName profile.lastName').sort({ createdAt: -1, _id: -1 }).skip((page - 1) * 25).limit(25).lean(),
      Delivery.countDocuments(filter)
    ]);
    res.json({ success: true, data, page, total, pages: Math.ceil(total / 25) });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Unable to load collection requests.' });
  }
});

router.post('/', async (req, res) => {
  try {
    const customer = req.body.customerSource === 'internal' && typeof req.body.customerId === 'string'
      ? await Customer.findOne({ customerId: req.body.customerId }).select('customerId firstName lastName').lean() : null;
    const data = buildCollectionRequest(req.body, customer, req.user._id);
    data.zone = detectAreaFromAddress(data.address, '', { company: data.company }) || undefined;
    const delivery = await saveReportingDelivery(new Delivery(data));
    req.app.get('io')?.emit('delivery:created', delivery);
    res.status(201).json({ success: true, data: delivery, message: 'Collection request created.' });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.statusCode ? error.message : 'Unable to create collection request.' });
  }
});

export default router;
