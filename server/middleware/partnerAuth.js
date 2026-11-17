import { activityActor } from '../observability/activityPolicy.js';
import jwt from 'jsonwebtoken';
import Partner from '../models/Partner.js';

export const partnerProtect = async (req, res, next) => {
  try {
    let token;
    if (req.headers.authorization?.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }
    if (!token) {
      return res.status(401).json({ success: false, message: 'Not authorized, no token' });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    // Requires partnerId claim — internal user tokens (which sign { id }) will fail here
    if (!decoded.partnerId) {
      return res.status(401).json({ success: false, message: 'Invalid token type' });
    }
    const partner = await Partner.findById(decoded.partnerId);
    if (!partner) {
      return res.status(401).json({ success: false, message: 'Partner not found' });
    }
    if (!partner.isActive) {
      return res.status(401).json({ success: false, message: 'Partner account is deactivated' });
    }
    req.partner = partner;
    req.activityActor ||= Object.freeze(activityActor(req));
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Not authorized, token failed' });
  }
};
