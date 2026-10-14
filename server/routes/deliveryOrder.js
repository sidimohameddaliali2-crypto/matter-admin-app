import express from 'express';
import mongoose from 'mongoose';
import Delivery from '../models/Delivery.js';
import Handoff from '../models/Handoff.js';
import { authorize } from '../middleware/auth.js';
import { isDateKey, getBusinessDayBounds } from '../utils/businessDate.js';
import { orderRevision, validateOrder } from '../services/deliveryOrder.js';

const router = express.Router();
router.use(authorize(['admin', 'super_admin', 'dispatcher', 'manager']));
router.use((req, res, next) => {
  const input = req.method === 'GET' ? req.query : req.body;
  if (!mongoose.isValidObjectId(input.driverId) || !isDateKey(input.date)) {
    return res.status(400).json({ success: false, message: 'A valid driver and date are required.' });
  }
  const { startOfDay, endOfDayExclusive } = getBusinessDayBounds(input.date);
  req.orderInput = input;
  req.orderFilter = { driver: input.driverId, scheduledTime: { $gte: startOfDay, $lt: endOfDayExclusive } };
  next();
});
const load = (filter, session = null) => Delivery.find(filter)
  .select('_id customerName address status routeOrder updatedAt scheduledTime')
  .sort({ routeOrder: 1, scheduledTime: 1, _id: 1 }).session(session).lean();

router.get('/', async (req, res, next) => {
  try {
    const deliveries = await load(req.orderFilter);
    res.json({ success: true, data: { deliveries, revision: orderRevision(deliveries) } });
  } catch (error) { next(error); }
});

router.put('/', async (req, res, next) => {
  let session;
  try {
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      const { driverId, date, deliveryIds, revision } = req.orderInput;
      const rows = await load(req.orderFilter, session);
      const message = validateOrder(rows, deliveryIds, revision);
      if (message) throw Object.assign(new Error(message), { status: 409 });
      // Handoff positions refer to stop numbers. Preserve those plans until
      // edited together in the route planner.
      const handoff = await Handoff.exists({ date, status: { $ne: 'cancelled' }, $or: [{ van: driverId }, { bike: driverId }] }).session(session);
      if (handoff) throw Object.assign(new Error('This route has a handoff or kitchen return. Edit its order in the route planner.'), { status: 409 });
      if (deliveryIds.length) await Delivery.bulkWrite(deliveryIds.map((_id, routeOrder) => ({
        updateOne: { filter: { ...req.orderFilter, _id }, update: { $set: { routeOrder } } }
      })), { session });
    });
    res.json({ success: true, message: 'Delivery order saved.' });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, message: error.message });
    next(error);
  } finally { if (session) await session.endSession(); }
});
export default router;
