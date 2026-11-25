import express from 'express';
import multer from 'multer';
import { authorize } from '../middleware/auth.js';
import Workflow from '../models/YellowblockOrderWorkflow.js';
import { compressOrderPhoto, displayName, kitchenOrder } from '../services/yellowblockKitchen.js';

const receivePhoto = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fields: 0, fileSize: 8 * 1024 * 1024 },
}).single('deliveryPhoto');
const driverStages = ['prepared', 'collected', 'delivered'];
const fail = (status, message) => Object.assign(new Error(message), { status });
const handle = action => (req, res, next) => action(req, res, next).catch(next);

export default function createYellowblockDriverRouter({ getShopifyConfig, shopifyRequest }) {
  const router = express.Router();
  router.use(authorize(['driver']), (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.param('orderId', (req, res, next, id) => {
    if (!/^\d{1,24}$/.test(id)) return next(fail(404, 'Order not found.'));
    next();
  });

  const ownedOrder = req => ({ _id: req.params.orderId, driverId: req.user._id });
  const checkOwner = handle(async (req, res, next) => {
    req.workflow = await Workflow.findOne({ ...ownedOrder(req), status: { $in: driverStages } }).lean();
    if (!req.workflow) throw fail(404, 'Order not found.');
    next();
  });

  async function getActiveOrder(id) {
    const cfg = getShopifyConfig();
    if (!cfg.configured) throw fail(503, 'Shopify is not configured.');
    const { status, body } = await shopifyRequest(`/admin/api/${cfg.version}/orders/${id}.json`, cfg);
    if (status === 404) throw fail(404, 'Order not found in Shopify.');
    if (status !== 200 || !body?.order) throw fail(502, 'Could not load this order from Shopify.');
    if (body.order.cancelled_at || body.order.test) throw fail(409, 'This order is no longer available for delivery.');
    return body.order;
  }

  router.get('/orders', handle(async (req, res) => {
    const statuses = req.query.includeDelivered === 'true' ? driverStages : ['prepared', 'collected'];
    const orders = await Workflow.find({ driverId: req.user._id, status: { $in: statuses } })
      .select('orderName customerName emirate status delivered.at').sort({ 'prepared.at': 1, _id: 1 }).lean();
    res.json({ success: true, data: orders.map(order => ({
      id: order._id, name: order.orderName, customerName: order.customerName, emirate: order.emirate, status: order.status,
      ...(order.status === 'delivered' && { deliveredAt: order.delivered?.at }),
    })) });
  }));

  router.get('/orders/:orderId', checkOwner, handle(async (req, res) => {
    const workflow = req.workflow;
    if (workflow.status === 'delivered') {
      return res.json({ success: true, data: {
        id: workflow._id, name: workflow.orderName, customerName: workflow.customerName, emirate: workflow.emirate,
        status: workflow.status, deliveredAt: workflow.delivered?.at,
        hasDeliveryPhoto: Boolean(workflow.delivered?.photoTaken),
      } });
    }
    const order = await getActiveOrder(req.params.orderId);
    const shipping = order.shipping_address;
    const details = kitchenOrder(order);
    res.json({ success: true, data: {
      ...details, customerName: shipping?.name || details.customerName, status: req.workflow.status,
      shippingAddress: shipping ? {
        address1: shipping.address1, address2: shipping.address2, city: shipping.city,
        province: shipping.province, latitude: shipping.latitude, longitude: shipping.longitude,
      } : null,
      hasPackedPhoto: Boolean(req.workflow.prepared),
    } });
  }));

  router.get('/orders/:orderId/packed-photo', handle(async (req, res) => {
    const workflow = await Workflow.findOne({ ...ownedOrder(req), status: { $in: driverStages } }).select('+boxedPhoto');
    if (!workflow?.boxedPhoto) throw fail(404, 'Packed-box photo not found.');
    res.set('X-Content-Type-Options', 'nosniff').type('image/jpeg').send(workflow.boxedPhoto);
  }));

  router.get('/orders/:orderId/delivery-photo', handle(async (req, res) => {
    const workflow = await Workflow.findOne({ ...ownedOrder(req), status: 'delivered' }).select('+deliveryPhoto');
    if (!workflow?.deliveryPhoto) throw fail(404, 'Delivery photo not found.');
    res.set('X-Content-Type-Options', 'nosniff').type('image/jpeg').send(workflow.deliveryPhoto);
  }));

  const transition = (previous, status) => handle(async (req, res) => {
    if (req.workflow.status === status) {
      return res.json({ success: true, data: { status, ...(status === 'delivered' && { deliveredAt: req.workflow.delivered?.at }) } });
    }
    if (req.workflow.status !== previous) throw fail(409, 'This order has already changed. Refresh and try again.');
    await getActiveOrder(req.params.orderId);

    const actor = displayName(req.user) || req.workflow.driverName || 'Driver';
    const update = { status, [status]: { at: new Date(), actor, courier: actor } };
    if (status === 'delivered') {
      if (!req.file) throw fail(400, 'Take a delivery photo to complete this order.');
      try {
        update.deliveryPhoto = await compressOrderPhoto(req.file.buffer);
      } catch {
        throw fail(400, 'Could not read the delivery photo. Take another photo and try again.');
      }
      update.delivered.photoTaken = true;
    }

    const result = await Workflow.updateOne({ ...ownedOrder(req), status: previous }, { $set: update }, { runValidators: true });
    if (!result.matchedCount) throw fail(409, 'This order has already changed. Refresh and try again.');
    res.json({ success: true, data: { status, ...(status === 'delivered' && { deliveredAt: update.delivered.at }) } });
  });

  router.post('/orders/:orderId/collect', checkOwner, transition('prepared', 'collected'));
  router.post('/orders/:orderId/deliver', checkOwner, (req, res, next) => {
    if (req.workflow.status !== 'collected') return next();
    receivePhoto(req, res, error => {
      if (error?.code === 'LIMIT_FILE_SIZE') return next(fail(413, 'The delivery photo must be 8 MB or smaller.'));
      if (error) return next(fail(400, 'Take one photo of the completed delivery.'));
      next();
    });
  }, transition('collected', 'delivered'));

  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (!error.status) console.error('[Yellow Block Driver]', error.message);
    res.status(error.status || 500).json({ success: false, message: error.status ? error.message : 'Could not complete the driver request.' });
  });

  return router;
}
