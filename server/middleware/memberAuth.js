import { activityActor } from '../observability/activityPolicy.js';
import jwt from 'jsonwebtoken';
import Member from '../models/Member.js';

export const memberProtect = async (req, res, next) => {
  try {
    let token;
    if (req.headers.authorization?.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }
    if (!token) {
      return res.status(401).json({ success: false, message: 'Not authorized, no token' });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    // Requires memberId claim — internal user ({ id }) and partner ({ partnerId }) tokens fail here
    if (!decoded.memberId) {
      return res.status(401).json({ success: false, message: 'Invalid token type' });
    }
    const member = await Member.findById(decoded.memberId).populate('partner');
    if (!member) {
      return res.status(401).json({ success: false, message: 'Member not found' });
    }
    if (!member.isActive) {
      return res.status(401).json({ success: false, message: 'Member account is deactivated' });
    }
    if (!member.partner || !member.partner.isActive) {
      return res.status(401).json({ success: false, message: 'Partner account is unavailable' });
    }
    req.member = member;
    // Deliberate: lets menu/price handlers be copied verbatim from partnerPortal.js
    req.partner = member.partner;
    req.activityActor ||= Object.freeze(activityActor(req));
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Not authorized, token failed' });
  }
};
