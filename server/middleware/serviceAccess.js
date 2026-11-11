import ServiceStaffProfile from '../models/ServiceStaffProfile.js';
import { getServiceCapabilities } from '../services/customerServicePolicy.js';

export const loadServiceAccess = async (req, res, next) => {
  try {
    req.serviceProfile = req.user?._id ? await ServiceStaffProfile.findOne({ userId: req.user._id }).lean() : null;
    req.serviceCapabilities = getServiceCapabilities(req.user, req.serviceProfile);
    res.set('Cache-Control', 'no-store');
    next();
  } catch {
    res.status(503).json({ success: false, message: 'Customer-service access could not be verified. Retry when the service is available.' });
  }
};
export const requireServiceAccess = async (req, res, next) => loadServiceAccess(req, res, () => {
  if (!req.serviceCapabilities.view) return res.status(403).json({ success: false, message: 'Active customer-service membership required.' });
  next();
});
