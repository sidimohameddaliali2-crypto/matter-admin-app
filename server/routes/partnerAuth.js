import {partnerProfileData} from '../services/partnerDeliverySettings.js';
import express from 'express';
import jwt from 'jsonwebtoken';
import Partner from '../models/Partner.js';
import { protect, admin } from '../middleware/auth.js';
import { partnerProtect } from '../middleware/partnerAuth.js';

const router = express.Router();

const generatePartnerToken = (partnerId) =>
  jwt.sign({ partnerId }, process.env.JWT_SECRET || 'your-secret-key', { expiresIn: '7d' });

// POST /api/partner/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    const partner = await Partner.findOne({ email: email.toLowerCase().trim() }).select('+password');
    if (!partner || !(await partner.correctPassword(password))) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }
    if (!partner.isActive) {
      return res.status(401).json({ success: false, message: 'Account is deactivated. Contact your administrator.' });
    }

    partner.lastLogin = new Date();
    await partner.save();

    const token = generatePartnerToken(partner._id);
    res.json({
      success: true,
      data: {
        token,
        partner: {
          _id: partner._id,
          businessName: partner.businessName,
          businessType: partner.businessType,
          contactName: partner.contactName,
          email: partner.email,
          phone: partner.phone,
          address: partner.address,
          minimumOrder: partner.minimumOrder ?? 0,
          defaultDeliveryTime: partner.defaultDeliveryTime || null,
          profilePicture: partner.profilePicture || '',
          accountCategory: partner.accountCategory || 'partner',
          ...partnerProfileData(partner)
        }
      }
    });
  } catch (err) {
    console.error('Partner login error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/partner/auth/register — internal admin creates a partner account
router.post('/register', protect, admin, async (req, res) => {
  try {
    const { email, password, businessName, businessType, contactName, phone, address } = req.body;
    if (!email || !password || !businessName || !businessType || !contactName) {
      return res.status(400).json({ success: false, message: 'email, password, businessName, businessType and contactName are required' });
    }

    const exists = await Partner.findOne({ email: email.toLowerCase().trim() });
    if (exists) {
      return res.status(400).json({ success: false, message: 'A partner with this email already exists' });
    }

    const partner = await Partner.create({
      email: email.toLowerCase().trim(),
      password,
      businessName,
      businessType,
      contactName,
      phone: phone || '',
      address: address || '',
      createdBy: req.user._id
    });

    res.status(201).json({
      success: true,
      data: {
        partner: {
          _id: partner._id,
          businessName: partner.businessName,
          businessType: partner.businessType,
          contactName: partner.contactName,
          email: partner.email,
          phone: partner.phone,
          address: partner.address,
          isActive: partner.isActive
        }
      }
    });
  } catch (err) {
    console.error('Partner register error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/partner/auth/me
router.get('/me', partnerProtect, (req, res) => {
  res.json({ success: true, data: { partner: req.partner } });
});

export default router;
