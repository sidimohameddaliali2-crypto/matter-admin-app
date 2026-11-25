import express from 'express';
import multer from 'multer';
import { isValidObjectId } from 'mongoose';
import { authorize } from '../middleware/auth.js';
import ThirdPartyDeliveryAssignment from '../models/ThirdPartyDeliveryAssignment.js';
import ThirdPartyDeliveryCompany from '../models/ThirdPartyDeliveryCompany.js';
import Workflow from '../models/YellowblockOrderWorkflow.js';
import User from '../models/User.js';
import { compressOrderPhoto, courierPresets, displayName, driverCourierId, kitchenOrder, kitchenTransitions, kitchenWorkflow } from '../services/yellowblockKitchen.js';

const staffRoles = ['super_admin', 'admin', 'yellowblock_user'];
const validOrderId = id => typeof id === 'string' && /^\d{1,24}$/.test(id);
const photoFields = [
  { name: 'displayPhoto', label: 'order outside the box' },
  { name: 'boxedPhoto', label: 'order inside the box' },
];
const uploadPhotos = multer({
  storage: multer.memoryStorage(),
  limits: { files: 2, fields: 0, fileSize: 8 * 1024 * 1024 },
}).fields(photoFields.map(({ name }) => ({ name, maxCount: 1 })));

function fileError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function receivePhotos(req, res, next) {
  if (req.params.status !== 'prepared') return next();
  uploadPhotos(req, res, (error) => {
    if (error?.code === 'LIMIT_FILE_SIZE') return next(fileError('Each photo must be 8 MB or smaller.', 413));
    if (error) return next(fileError('Upload one outside-the-box photo and one inside-the-box photo.'));
    next();
  });
}

async function compressPhotos(files) {
  const photos = {};
  for (const { name, label } of photoFields) {
    const file = files?.[name]?.[0];
    if (!file) throw fileError(`A photo of the ${label} is required.`);
    try {
      photos[name] = await compressOrderPhoto(file.buffer);
    } catch {
      throw fileError(`The photo of the ${label} could not be read. Use a JPEG or PNG image.`);
    }
  }
  return photos;
}

function findAssignments(ids) {
  return ThirdPartyDeliveryAssignment.find({ shopifyOrderId: { $in: ids } })
    .select('shopifyOrderId company courierName').populate('company', 'name').lean();
}

async function courierOptions() {
  const [companies, drivers] = await Promise.all([
    ThirdPartyDeliveryCompany.find({}).select('name').sort('name').lean(),
    User.find({ role: 'driver', isActive: true }).select('profile.firstName profile.lastName').sort('profile.firstName profile.lastName').lean(),
  ]);
  const normalizedName = name => name.toLowerCase().replace(/\s+/g, '');
  const companyNames = new Set(companies.map(company => normalizedName(company.name)));
  return [
    ...companies.map(company => ({ id: String(company._id), name: company.name })),
    ...courierPresets.filter(name => !companyNames.has(normalizedName(name))).map(name => ({ id: name, name })),
    ...drivers.map(driver => ({ id: driverCourierId(driver._id), name: displayName(driver) || 'Driver', driverId: driver._id })),
  ];
}

const publicCourier = ({ id, name, driverId }) => ({ id, name, driver: Boolean(driverId) });

function pageCursor(link, relation) {
  const page = link?.split(',').find(entry => entry.includes(`rel="${relation}"`));
  const url = page?.match(/<([^>]+)>/)?.[1];
  return url ? new URL(url).searchParams.get('page_info') : null;
}

export default function createYellowblockKitchenRouter({ getShopifyConfig, shopifyRequest }) {
  const router = express.Router();
  router.use(authorize([...staffRoles, 'kitchen']));
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.param('orderId', (req, res, next, id) => {
    if (!validOrderId(id)) return res.status(400).json({ success: false, message: 'Invalid Shopify order ID.' });
    next();
  });

  async function shopifyOrders(path) {
    const cfg = getShopifyConfig();
    if (!cfg.configured) throw fileError('Shopify is not configured.', 503);
    const result = await shopifyRequest(`/admin/api/${cfg.version}/orders${path}`, cfg);
    if (result.status === 404) throw fileError('Order not found.', 404);
    if (result.status === 429) throw fileError('Shopify is busy. Try again shortly.', 429);
    if (result.status !== 200) throw fileError('Could not load orders from Shopify.', 502);
    return result;
  }

  async function getOrder(id) {
    const { body } = await shopifyOrders(`/${id}.json`);
    if (!body?.order) throw fileError('Order not found.', 404);
    return body.order;
  }

  async function getActiveOrder(id) {
    const order = await getOrder(id);
    if (order.cancelled_at || order.test) throw fileError('This order cannot be updated.', 409);
    return order;
  }

  const handle = action => (req, res, next) => Promise.resolve(action(req, res)).catch(next);

  router.get('/couriers', authorize(staffRoles), handle(async (req, res) => {
    res.json({ success: true, data: (await courierOptions()).map(publicCourier) });
  }));

  router.get('/orders', handle(async (req, res) => {
    const params = new URLSearchParams({ limit: '50', fields: 'id,name,customer,shipping_address,cancelled_at,test,fulfillment_status,line_items' });
    if (typeof req.query.cursor === 'string' && req.query.cursor) params.set('page_info', req.query.cursor);
    else params.set('status', 'any');
    const { body, headers } = await shopifyOrders(`.json?${params}`);
    const orders = body.orders.map(kitchenOrder);
    const ids = orders.map(order => order.id);
    const [workflows, assignments] = await Promise.all([
      Workflow.find({ _id: { $in: ids } }).lean(), findAssignments(ids),
    ]);
    const workflowById = new Map(workflows.map(workflow => [workflow._id, workflow]));
    const assignmentById = new Map(assignments.map(assignment => [assignment.shopifyOrderId, assignment]));
    res.json({ success: true, data: {
      orders: orders.map(order => ({ ...order, ...kitchenWorkflow(workflowById.get(order.id), assignmentById.get(order.id)) })),
      nextCursor: pageCursor(headers.link, 'next'),
      previousCursor: pageCursor(headers.link, 'previous'),
    } });
  }));

  router.get('/orders/:orderId', handle(async (req, res) => {
    const { orderId } = req.params;
    const [order, workflow, [assignment]] = await Promise.all([
      getOrder(orderId), Workflow.findById(orderId).lean(), findAssignments([orderId]),
    ]);
    const canDispatch = staffRoles.includes(req.user.role);
    const couriers = canDispatch ? await courierOptions() : [];
    res.json({ success: true, data: {
      ...kitchenOrder(order), ...kitchenWorkflow(workflow, assignment, { includeTimeline: canDispatch }), canDispatch,
      couriers: couriers.map(publicCourier),
    } });
  }));

  async function findCourier(courierId) {
    const courier = (await courierOptions()).find(option => option.id === courierId);
    if (!courier) throw fileError('Choose a delivery courier.');
    return courier;
  }

  async function assignCourier(orderId, courier, assignedBy) {
    const [shopifyOrder, workflow] = await Promise.all([getActiveOrder(orderId), Workflow.findById(orderId).lean()]);
    if (['collected', 'delivered'].includes(workflow?.status)) throw fileError('The order has already been collected.', 409);
    const order = kitchenOrder(shopifyOrder);
    const assignable = { $in: ['pending', 'in_preparation', 'prepared'] };

    if (courier.driverId) {
      const updated = await Workflow.findOneAndUpdate(
        { _id: orderId, status: assignable },
        {
          $set: {
            driverId: courier.driverId, driverName: courier.name, orderName: order.name,
            customerName: shopifyOrder.shipping_address?.name || order.customerName, emirate: order.emirate,
          },
          $setOnInsert: { status: 'pending' },
        },
        { upsert: !workflow, new: true, runValidators: true },
      ).lean();
      if (!updated) throw fileError('The order was collected while you were assigning it.', 409);
      return { courier: courier.name, courierId: courier.id, driverAssigned: true };
    }
    const assignment = {
      orderNumber: shopifyOrder.order_number || shopifyOrder.name,
      customerName: order.customerName,
      customerPhone: shopifyOrder.phone || shopifyOrder.customer?.phone || shopifyOrder.shipping_address?.phone || '',
      city: shopifyOrder.shipping_address?.city || '',
      addressLine1: shopifyOrder.shipping_address?.address1 || '',
      items: order.items.map(({ title, quantity }) => ({ title, quantity })),
      assignedBy,
      assignedAt: new Date(),
    };
    const courierFields = isValidObjectId(courier.id)
      ? { $set: { ...assignment, company: courier.id }, $unset: { courierName: 1 } }
      : { $set: { ...assignment, courierName: courier.name }, $unset: { company: 1 } };
    await ThirdPartyDeliveryAssignment.updateOne({ shopifyOrderId: orderId }, courierFields, { upsert: true });
    if (workflow?.driverId) {
      const cleared = await Workflow.findOneAndUpdate(
        { _id: orderId, driverId: workflow.driverId, status: assignable },
        { $unset: { driverId: 1, driverName: 1 } },
      ).lean();
      if (!cleared) throw fileError('The driver assignment changed. Refresh the order.', 409);
    }
    return { courier: courier.name, courierId: courier.id, driverAssigned: false };
  }

  router.patch('/orders/:orderId/courier', authorize(staffRoles), handle(async (req, res) => {
    const courier = await findCourier(req.body?.courierId);
    const data = await assignCourier(req.params.orderId, courier, req.user._id);
    res.json({ success: true, data });
  }));

  router.patch('/courier-assignments', authorize(staffRoles), handle(async (req, res) => {
    const { orderIds, courierId } = req.body || {};
    if (!Array.isArray(orderIds) || !orderIds.length || orderIds.length > 50 || !orderIds.every(validOrderId)) {
      throw fileError('Select between 1 and 50 valid orders.');
    }
    const courier = await findCourier(courierId);
    const assigned = [];
    const failed = [];
    for (const orderId of new Set(orderIds)) {
      try {
        await assignCourier(orderId, courier, req.user._id);
        assigned.push(orderId);
      } catch (error) {
        if (!error.status && error.code !== 11000) console.error('[YellowBlock Bulk Assignment]', error.message);
        const message = error.code === 11000 ? 'This order has already changed. Refresh and try again.'
          : error.status ? error.message : 'Could not assign this order. Try again.';
        failed.push({ orderId, message });
      }
    }
    res.json({ success: true, data: { courier: courier.name, assigned, failed } });
  }));

  router.post('/orders/:orderId/status/:status', (req, res, next) => {
    const transition = Object.hasOwn(kitchenTransitions, req.params.status) && kitchenTransitions[req.params.status];
    if (!transition) return next(fileError('Unknown order status.'));
    if (!transition.kitchen && !staffRoles.includes(req.user.role)) {
      return next(fileError('Only delivery staff can record this status.', 403));
    }
    next();
  }, receivePhotos, handle(async (req, res) => {
    const { orderId, status } = req.params;
    const { previous } = kitchenTransitions[status];
    const [workflow, [assignment], shopifyOrder] = await Promise.all([
      Workflow.findById(orderId).lean(), findAssignments([orderId]), getActiveOrder(orderId),
    ]);
    if (status === 'in_preparation' && shopifyOrder.fulfillment_status === 'fulfilled') {
      throw fileError('This order has already been fulfilled in Shopify.', 409);
    }
    const current = kitchenWorkflow(workflow, assignment);
    if (current.status !== previous) throw fileError('This order has already changed. Refresh and try again.', 409);
    if (!kitchenTransitions[status].kitchen && current.driverAssigned) throw fileError('The assigned driver records this step in the driver app.', 409);
    if (status === 'collected' && !current.courier) throw fileError('Assign a courier before recording collection.', 409);

    const actor = displayName(req.user) || 'Staff';
    const milestone = { at: new Date(), actor };
    if (status === 'collected') milestone.courier = current.courier;
    if (status === 'delivered' && workflow?.collected?.courier) milestone.courier = workflow.collected.courier;
    const photos = status === 'prepared' ? await compressPhotos(req.files) : {};

    const updated = await Workflow.findOneAndUpdate(
      { _id: orderId, status: previous, ...(!kitchenTransitions[status].kitchen && { driverId: { $exists: false } }) },
      { $set: { status, [status]: milestone, ...photos } },
      { upsert: previous === 'pending' && !workflow, new: true, runValidators: true },
    ).lean();
    if (!updated) throw fileError('This order has already changed. Refresh and try again.', 409);
    res.json({ success: true, data: kitchenWorkflow(updated, assignment, { includeTimeline: staffRoles.includes(req.user.role) }) });
  }));

  router.get('/orders/:orderId/photos/:photo', handle(async (req, res) => {
    const name = req.params.photo === 'deliveryPhoto' && staffRoles.includes(req.user.role)
      ? 'deliveryPhoto' : photoFields.find(field => field.name === req.params.photo)?.name;
    if (!name) throw fileError('Photo not found.', 404);
    const workflow = await Workflow.findById(req.params.orderId).select(`+${name}`);
    const buffer = workflow?.[name];
    if (!buffer) throw fileError('Photo not found.', 404);
    res.set('X-Content-Type-Options', 'nosniff').type('image/jpeg').send(buffer);
  }));

  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.code === 11000) return res.status(409).json({ success: false, message: 'This order has already changed. Refresh and try again.' });
    if (!error.status) console.error('[YellowBlock Kitchen]', error.message);
    res.status(error.status || 500).json({ success: false, message: error.status ? error.message : 'Could not complete the kitchen request.' });
  });

  return router;
}
