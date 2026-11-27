import express from 'express';
import mongoose from 'mongoose';
import Delivery from '../models/Delivery.js';
import Customer from '../models/Customer.js';
import User from '../models/User.js';
import BagRefundCase from '../models/BagRefundCase.js';
import CollectionRefundLink from '../models/CollectionRefundLink.js';
import { enqueueRefundLink, refundEmailStatus, refundEmailEnabled, refundLinkOrigin } from '../services/collectionRefundLinks.js';
import { refundEmailConfiguration, sendDemoRefundEmail } from '../services/collectionRefundEmail.js';
import { collectionRefundFilter, collectionRefundQueueFilter, canRecordCollectionRefund, buildCollectionRefundUpdate, refundError } from '../services/collectionRefund.js';
import { protect, authorize } from '../middleware/auth.js';
import { effectivePermissions } from '../models/User.js';
import { detectAreaFromAddress } from '../config/areas.js';
import { buildCollectionRequest } from '../services/collectionRequest.js';
import { saveReportingDelivery } from '../services/reportingOutbox.js';
import { collectionListFilter, collectionSearchFilter, collectionDuplicateFilter, buildRefundAssignment, openCollectionStatuses, collectionCsv } from '../services/collectionOperations.js';
import { businessDayStart, toBusinessDateKey } from '../utils/businessDate.js';

const router = express.Router();
router.use(protect, authorize(['super_admin', 'admin', 'manager', 'dispatcher']));
router.use((req, res, next) => {
  if (!effectivePermissions(req.user).deliveries) return res.status(403).json({ success: false, message: 'Collection access denied' });
  res.setHeader('Cache-Control', 'no-store');
  next();
});

async function paidCustomerIds() {
  const [local, bags] = await Promise.all([Delivery.distinct('customerId', { 'collectionRefund.status': 'refunded' }), BagRefundCase.distinct('customerId', { status: 'completed' })]);
  return [...new Set([...local, ...bags])];
}
router.post('/refund-email-demo', async (req, res) => {
  try {
    if (!canRecordCollectionRefund(req.user)) throw refundError('Management access is required to email Accounts.', 403);
    if (!refundEmailEnabled()) throw refundError('Refund email configuration is missing or sending is paused.', 503);
    if (typeof req.body.messageKey !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.body.messageKey)) throw refundError('A valid demo send ID is required.');
    // No collection lookup, link creation, ledger update or payment operation.
    const result = await sendDemoRefundEmail(req.body.messageKey);
    res.json({ success: true, message: 'Brevo accepted the demo email to accounts@matternutrition.xyz. No real refund was changed.', messageId: result.messageId, duplicate: result.duplicate === true });
  } catch (error) { res.status(error.statusCode || 502).json({ success: false, message: error.statusCode ? error.message : 'Brevo did not confirm the demo email. Retry with the same send ID to avoid duplicate emails.' }); }
});
router.get('/refund-email-config', async (req, res) => {
  try {
    if (!canRecordCollectionRefund(req.user)) throw refundError('Management access is required.', 403);
    if (!refundEmailEnabled()) return res.json({ success: true, ready: false, code: 'missing_or_paused_configuration' });
    refundLinkOrigin();
    res.json({ success: true, ...await refundEmailConfiguration() });
  } catch (error) { res.status(error.statusCode || 503).json({ success: false, message: error.statusCode ? error.message : 'Could not check Brevo. Please retry.' }); }
});
async function refundListFilter(query) {
  const paid = await paidCustomerIds();
  const filter = { ...collectionRefundQueueFilter(query.status, paid), ...collectionSearchFilter(query) };
  if (query.owner === 'unassigned') filter['collectionRefund.owner'] = null;
  else if (query.owner) {
    if (typeof query.owner !== 'string' || !mongoose.isValidObjectId(query.owner)) throw refundError('Choose a valid refund owner.');
    filter['collectionRefund.owner'] = query.owner;
  }
  return { filter, paid };
}
router.get('/export', async (req, res) => {
  try {
    const refunds = req.query.report === 'refunds';
    const { filter, paid } = refunds ? await refundListFilter(req.query) : { filter: collectionListFilter(req.query), paid: [] };
    const rows = await Delivery.find(filter).select('customerId customerName status scheduledTime collectionRefund driver').populate('driver', 'profile.firstName profile.lastName').sort({ scheduledTime: 1, _id: 1 }).limit(5001).lean();
    if (rows.length > 5000) throw refundError('Export is limited to 5,000 rows. Narrow the filters.');
    const headers = refunds ? ['Customer', 'Customer ID', 'Scheduled collection date (Dubai)', 'Refund status', 'Refund owner', 'Transaction reference'] : ['Customer', 'Customer ID', 'Collection date (Dubai)', 'Status', 'Driver', 'Next action'];
    const values = rows.map(row => refunds ? [row.customerName, row.customerId, toBusinessDateKey(row.scheduledTime), paid.includes(row.customerId) ? 'Done' : 'Pending', row.collectionRefund?.ownerName || 'Unassigned', row.collectionRefund?.reference || ''] : [row.customerName, row.customerId, toBusinessDateKey(row.scheduledTime), row.status, [row.driver?.profile?.firstName, row.driver?.profile?.lastName].filter(Boolean).join(' ') || 'Unassigned', openCollectionStatuses.includes(row.status) ? row.driver ? 'Collect / follow up' : 'Assign a driver' : 'History']);
    res.setHeader('Content-Disposition', `attachment; filename="${refunds ? 'refunds' : 'collections'}.csv"`);
    res.type('text/csv').send(collectionCsv(headers, values));
  } catch (error) { res.status(error.statusCode || 500).json({ success: false, message: error.statusCode ? error.message : 'Could not export records.' }); }
});
router.get('/people', async (req, res) => {
  try {
    const people = await User.find({ isActive: true, role: { $in: ['driver', 'super_admin', 'admin', 'manager'] } }).select('_id role profile.firstName profile.lastName email permissions').lean();
    const name = person => [person.profile?.firstName, person.profile?.lastName].filter(Boolean).join(' ') || person.email;
    res.json({ success: true, drivers: people.filter(p => p.role === 'driver').map(p => ({ _id: p._id, name: name(p) })), owners: people.filter(p => canRecordCollectionRefund(p) && effectivePermissions(p).deliveries).map(p => ({ _id: p._id, name: name(p) })) });
  } catch { res.status(500).json({ success: false, message: 'Could not load staff. Retry before assigning an owner.' }); }
});
router.get('/summary', async (req, res) => {
  try {
    const paid = await paidCustomerIds();
    const open = { type: 'Collection', status: { $in: openCollectionStatuses } };
    const [openCount, unassigned, pastDate, pendingRefunds] = await Promise.all([
      Delivery.countDocuments(open), Delivery.countDocuments({ ...open, driver: null }),
      Delivery.countDocuments({ ...open, scheduledTime: { $lt: businessDayStart(toBusinessDateKey(new Date())) } }),
      Delivery.countDocuments(collectionRefundQueueFilter('pending', paid))
    ]);
    res.json({ success: true, openCount, unassigned, pastDate, pendingRefunds, asOf: new Date() });
  } catch { res.status(500).json({ success: false, message: 'Could not load the work summary.' }); }
});
router.get('/refunds', async (req, res) => {
  try {
    const page = Math.max(1, Math.min(10000, parseInt(req.query.page, 10) || 1));
    const { filter, paid } = await refundListFilter(req.query);
    const sort = req.query.status === 'refunded' ? { 'collectionRefund.updatedAt': -1, _id: -1 } : { 'collectionDetails.collectedAt': 1, completedAt: 1, _id: 1 };
    const [records, total] = await Promise.all([
      Delivery.find(filter).select('customerId customerName scheduledTime collectionDetails completedAt collectionRefund').sort(sort).skip((page - 1) * 25).limit(25).lean(),
      Delivery.countDocuments(filter)
    ]);
    const links = await CollectionRefundLink.find({ delivery: { $in: records.map(record => record._id) } }).select('delivery state sentAt expiresAt usedAt errorCode').lean();
    const byDelivery = new Map(links.map(link => [String(link.delivery), link]));
    res.json({ success: true, data: records.map(record => ({ ...record, accountsEmail: refundEmailStatus(byDelivery.get(String(record._id))), refundStatus: paid.includes(record.customerId) ? 'refunded' : record.collectionRefund?.status || 'pending', recordedForCustomer: paid.includes(record.customerId) && record.collectionRefund?.status !== 'refunded' })), total, page, pages: Math.ceil(total / 25), canUpdate: canRecordCollectionRefund(req.user), emailEnabled: refundEmailEnabled() });
  } catch (error) { res.status(error.statusCode || 500).json({ success: false, message: error.statusCode ? error.message : 'Unable to load refund tracking.' }); }
});

router.post('/:id/refund-email', async (req, res) => {
  try {
    if (!canRecordCollectionRefund(req.user)) throw refundError('Management access is required to email Accounts.', 403);
    if (!mongoose.isValidObjectId(req.params.id)) throw refundError('Invalid collection ID.');
    const record = await Delivery.findOne({ ...collectionRefundFilter(), _id: req.params.id, 'collectionRefund.status': { $ne: 'refunded' } }).select('_id customerId').lean();
    if (!record) throw refundError('A pending refund after a completed collection is required.', 409);
    const actorName = [req.user.profile?.firstName, req.user.profile?.lastName].filter(Boolean).join(' ') || req.user.email;
    const link = await enqueueRefundLink(record, { resend: req.body.resend === true, actorName });
    res.json({ success: true, accountsEmail: refundEmailStatus(link), message: 'Accounts email queued. It will be sent shortly.' });
  } catch (error) { res.status(error.statusCode || 500).json({ success: false, message: error.statusCode ? error.message : 'Could not queue the Accounts email.' }); }
});

router.post('/:id/refund-assignment', async (req, res) => {
  try {
    if (!canRecordCollectionRefund(req.user)) throw refundError('Management access is required.', 403);
    if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(req.body.ownerId)) throw refundError('Choose a valid refund and owner.');
    const record = await Delivery.findOne({ ...collectionRefundFilter(), _id: req.params.id }).lean();
    if (!record) throw refundError('A completed bag collection with a refund request is required.', 409);
    const prior = record.collectionRefund?.assignmentHistory?.find(event => event.eventId === req.body.eventId);
    if (prior) {
      if (String(prior.actor) !== String(req.user._id) || String(prior.owner) !== req.body.ownerId || (prior.dueDate || '') !== (req.body.dueDate || '')) throw refundError('Update ID already used.', 409);
      return res.json({ success: true, duplicate: true });
    }
    if ((await paidCustomerIds()).includes(record.customerId)) throw refundError('This customer already has a recorded refund.', 409);
    const owner = await User.findOne({ _id: req.body.ownerId, isActive: true, role: { $in: ['super_admin', 'admin', 'manager'] } }).select('_id role profile email permissions').lean();
    if (!owner || !effectivePermissions(owner).deliveries) throw refundError('Choose an active manager with Collection access.');
    const update = buildRefundAssignment(record, req.body, owner, req.user);
    const filter = { ...collectionRefundFilter(), _id: record._id, 'collectionRefund.status': { $ne: 'refunded' }, 'collectionRefund.version': req.body.version === 0 ? { $in: [null, 0] } : req.body.version };
    const data = await Delivery.findOneAndUpdate(filter, update, { new: true, runValidators: true });
    if (!data) throw refundError('This refund changed. Refresh before updating it.', 409);
    req.app.get('io')?.emit('delivery:updated', data);
    res.json({ success: true, message: 'Refund owner and follow-up date saved.' });
  } catch (error) { res.status(error.statusCode || 500).json({ success: false, message: error.statusCode ? error.message : 'Could not assign this refund.' }); }
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
    const filter = collectionListFilter(req.query);
    const [data, total] = await Promise.all([
      Delivery.find(filter).select('customerId customerName address gpsLocation scheduledTime status collectionRequest createdAt driver')
        .populate('driver', 'profile.firstName profile.lastName').sort(req.query.view === 'history' ? { scheduledTime: -1, _id: -1 } : { scheduledTime: 1, _id: 1 }).skip((page - 1) * 25).limit(25).lean(),
      Delivery.countDocuments(filter)
    ]);
    const reviewed = await Promise.all(data.map(async record => {
      if (!openCollectionStatuses.includes(record.status) || !record.scheduledTime || !toBusinessDateKey(record.scheduledTime)) return record;
      const duplicate = await Delivery.exists({ ...collectionDuplicateFilter({ ...record, collectionRequest: record.collectionRequest || {} }), _id: { $ne: record._id } });
      return { ...record, possibleDuplicateId: duplicate?._id || null };
    }));
    res.json({ success: true, data: reviewed, page, total, pages: Math.ceil(total / 25) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.statusCode ? error.message : 'Unable to load collection requests.' });
  }
});

router.post('/', async (req, res) => {
  try {
    const customer = req.body.customerSource === 'internal' && typeof req.body.customerId === 'string'
      ? await Customer.findOne({ customerId: req.body.customerId }).select('customerId firstName lastName').lean() : null;
    const data = buildCollectionRequest(req.body, customer, req.user._id);
    const duplicates = await Delivery.find(collectionDuplicateFilter(data)).select('_id customerName scheduledTime status address').limit(5).lean();
    if (duplicates.length) {
      if (req.body.duplicateAcknowledged !== true || typeof req.body.duplicateReason !== 'string' || !req.body.duplicateReason.trim()) return res.status(409).json({ success: false, code: 'POSSIBLE_DUPLICATE', message: 'An open request may already exist for this customer and date. Review it before creating another.', duplicates });
      data.collectionRequest.duplicateReason = req.body.duplicateReason.trim().slice(0, 1000);
    }
    data.zone = detectAreaFromAddress(data.address, '', { company: data.company }) || undefined;
    const delivery = await saveReportingDelivery(new Delivery(data));
    req.app.get('io')?.emit('delivery:created', delivery);
    res.status(201).json({ success: true, data: delivery, message: 'Collection request created.' });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.statusCode ? error.message : 'Unable to create collection request.' });
  }
});

export default router;
