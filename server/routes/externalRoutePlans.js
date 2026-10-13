import express from 'express';
import mongoose from 'mongoose';
import ExternalRoutePlan from '../models/ExternalRoutePlan.js';
import { protect, authorize } from '../middleware/auth.js';
import { importExternalPlan, recordPlanEvent, driverPlans, cancelExternalPlan } from '../services/externalRoutePlanService.js';

const router = express.Router();
const dispatchers = authorize(['admin', 'super_admin', 'manager', 'dispatcher']);
const run = fn => async (req, res) => {
  try { res.json({ success: true, data: await fn(req) }); }
  catch (error) {
    const code = error.code === 11000 || error.name === 'VersionError' ? 409 : error.statusCode || 500;
    res.status(code).json({ success: false, message: code === 500 ? 'Plan operation failed; no changes committed. Contact dispatcher.' : error.message });
  }
};
router.use(protect);
router.get('/mine', authorize(['driver']), run(req => driverPlans(String(req.user._id))));
router.post('/import', dispatchers, run(req => importExternalPlan(req.body, req.user._id).then(p => ({ id: String(p._id), serviceDate: p.serviceDate, revision: p.revision }))));
router.param('id', (req, res, next, id) => mongoose.isValidObjectId(id) ? next() : res.status(400).json({ success: false, message: 'Invalid plan ID' }));
router.get('/:id', dispatchers, run(async req => {
  const plan = await ExternalRoutePlan.findById(req.params.id).lean();
  if (!plan) throw Object.assign(new Error('Plan not found'), { statusCode: 404 });
  return plan;
}));
router.post('/:id/events', authorize(['driver']), run(req => recordPlanEvent(req.params.id, String(req.user._id), req.body)));
router.post('/:id/cancel', dispatchers, run(req => cancelExternalPlan(req.params.id, req.body.expectedRevision, req.body.requestId, req.user._id).then(p => ({ id: String(p._id), revision: p.revision, cancelled: p.cancelled }))));
export default router;
