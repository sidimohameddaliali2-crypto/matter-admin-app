import express from 'express';
import axios from 'axios';
import { protect } from '../middleware/auth.js';
import FlaggedAlert from '../models/FlaggedAlert.js';
import Delivery from '../models/Delivery.js';
import Bag from '../models/Bag.js';

const router = express.Router();

// Send flagged customer info to Slack via incoming webhook
router.post('/flagged-customer', protect, async (req, res) => {
  try {
    console.log('📩 Flagged customer Slack request received:', req.body);
    
    // Check if Slack notifications are enabled
    if (process.env.ENABLE_SLACK_NOTIFICATIONS === '0') {
      console.log('Slack notifications disabled; skipping flagged customer notification');
      return res.status(200).json({ success: true, message: 'Slack notifications are disabled' });
    }

    const { customerName, customerId, bagCount, bagIds } = req.body || {};

    const webhookUrl = process.env.SLACK_BAG_COLLECTION_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL;
    console.log('📍 Webhook URL configured:', !!webhookUrl);
    
    if (!webhookUrl) {
      console.error('❌ No Slack webhook URL configured');
      return res.status(500).json({ success: false, message: 'Slack webhook not configured' });
    }

    const textLines = [];
    textLines.push(`*Flagged Customer*`);
    if (customerName) textLines.push(`*Name:* ${customerName}`);
    if (customerId) textLines.push(`*Customer ID:* ${customerId}`);
    textLines.push(`*Bags:* ${bagCount || (Array.isArray(bagIds) ? bagIds.length : 0)}`);
    if (Array.isArray(bagIds) && bagIds.length > 0) {
      // Limit the bag id list length to avoid huge messages
      const list = bagIds.slice(0, 20).join(', ');
      textLines.push(`*Bag IDs:* ${list}${bagIds.length > 20 ? ' (and more...)' : ''}`);
    }

    const payload = {
      text: textLines.join('\n')
    };

    console.log('📤 Sending to Slack:', payload);
    const slackResponse = await axios.post(webhookUrl, payload, { timeout: 5000 });
    console.log('✅ Slack response:', slackResponse.status);

    return res.json({ success: true, message: 'Sent to Slack' });
  } catch (error) {
    console.error('❌ Error sending flagged customer to Slack:', error.message);
    console.error('Stack:', error.stack);
    if (error.response) {
      console.error('Slack API response:', error.response.status, error.response.data);
    }
    return res.status(500).json({ 
      success: false, 
      message: 'Failed to send to Slack', 
      error: error.message,
      details: error.response?.data || null
    });
  }
});


// Get flagged customer details: bags, last alert, and related Bag Collection deliveries
router.get('/flagged/:key', protect, async (req, res) => {
  try {
    const { key } = req.params;
    if (!key) return res.status(400).json({ success: false, message: 'Missing key' });

    const normalized = String(key).trim();

    // find flagged alert record (if any)
    const alert = await FlaggedAlert.findOne({ key: normalized }).lean().exec();

    // find bags assigned to this customer (match by customerId exact or customerName case-insensitive)
    const byId = { 'assignedTo.customer.customerId': normalized };
    const byName = { 'assignedTo.customer.customerName': { $regex: new RegExp(`^${normalized}$`, 'i') } };
    const bags = await Bag.find({ $or: [byId, byName] }).lean().exec();

    // find Bag Collection deliveries for this customer
    const deliveries = await Delivery.find({
      taskType: 'Bag Collection',
      $or: [ { customerId: normalized }, { customerName: { $regex: new RegExp(`^${normalized}$`, 'i') } } ]
    })
    .populate('driver', 'profile.firstName profile.lastName profile.phone profile.colorCode email name')
    .populate('bagAssignment.assignedBy', 'profile.firstName profile.lastName profile.phone profile.colorCode email name')
    .sort({ scheduledTime: -1 })
    .lean()
    .exec();

    return res.json({ success: true, alert, bags, deliveries });
  } catch (error) {
    console.error('Error fetching flagged details:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch flagged details', error: error.message });
  }
});

export default router;

