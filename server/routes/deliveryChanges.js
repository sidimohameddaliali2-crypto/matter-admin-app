import express from 'express';
import multer from 'multer';
import csv from 'csv-parser';
import mongoose from 'mongoose';
import axios from 'axios';
import DeliveryChange from '../models/DeliveryChange.js';
import Delivery from '../models/Delivery.js';
import User from '../models/User.js';
import { detectAreaFromAddress } from '../config/areas.js';
import { protect, admin } from '../middleware/auth.js';
import { flagDeliveryChangeIfNeeded } from '../services/deliveryChangeFlag.js';
import { getBusinessDayBounds, setBusinessTimeOfDay, parseTimeOfDay } from '../utils/businessDate.js';

const router = express.Router();

// Slack notifier for delivery changes
async function sendDeliveryChangeToSlack(changesPayload, meta = {}) {
  try {
    // Check if Slack notifications are enabled
    if (process.env.ENABLE_SLACK_NOTIFICATIONS === '0') {
      console.log('Slack notifications disabled; skipping delivery change notification');
      return;
    }

    const webhookUrl = process.env.SLACK_LOCATION_CHANGE_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL;
    if (!webhookUrl) {
      console.warn('SLACK_LOCATION_CHANGE_WEBHOOK_URL not configured; skipping Slack notification');
      return;
    }

    const submitter = meta.submitter || 'Unknown user';
    const reason = meta.reason || 'No reason provided';

    const lines = [`:memo: *Delivery change submitted*`, `Submitted by: ${submitter}`, `Reason: ${reason}`, ''];

    for (const change of changesPayload) {
      const scheduledDate = change.scheduledDate ? new Date(change.scheduledDate).toISOString().slice(0, 10) : 'n/a';
      
      // Convert Map to plain object if needed
      let changesObj = change.changes;
      if (changesObj instanceof Map) {
        changesObj = Object.fromEntries(changesObj);
      } else if (changesObj && typeof changesObj.toObject === 'function') {
        changesObj = changesObj.toObject();
      }
      
      // Format the changes with nice labels
      const changeLines = [];
      if (changesObj) {
        if (changesObj.address) {
          changeLines.push(`• *New Address:* ${changesObj.address}`);
        }
        if (changesObj.scheduledTime) {
          changeLines.push(`• *New Time:* ${changesObj.scheduledTime}`);
        }
        if (changesObj.company) {
          changeLines.push(`• *Company:* ${changesObj.company}`);
        }
        if (changesObj.phone) {
          changeLines.push(`• *Phone:* ${changesObj.phone}`);
        }
        if (changesObj.notes) {
          changeLines.push(`• *Notes:* ${changesObj.notes}`);
        }
        // Add any other fields that aren't internal
        for (const [field, value] of Object.entries(changesObj)) {
          if (!['address', 'scheduledTime', 'company', 'phone', 'notes'].includes(field) && 
              !field.startsWith('$') && !field.startsWith('_')) {
            const fieldLabel = field.charAt(0).toUpperCase() + field.slice(1).replace(/([A-Z])/g, ' $1').trim();
            changeLines.push(`• *${fieldLabel}:* ${value}`);
          }
        }
      }

      if (changeLines.length === 0) {
        continue; // Skip if no valid changes
      }

      lines.push(`*Customer:* ${change.customerName || 'Unknown'} (${change.customerId || 'N/A'})`);
      
      // Check if this is a range (multiple dates)
      if (change.rangeCount && change.rangeCount > 1 && change.rangeStartDate && change.rangeEndDate) {
        const startDate = new Date(change.rangeStartDate);
        const endDate = new Date(change.rangeEndDate);
        const startStr = startDate.toISOString().slice(0, 10);
        const endStr = endDate.toISOString().slice(0, 10);
        
        // Calculate the pattern (daily or weekly)
        const daysDiff = Math.floor((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;
        const isWeekly = daysDiff === 7 || daysDiff % 7 === 0;
        const pattern = isWeekly ? 'Weekly' : 'Daily';
        
        // Get day of week
        const daysOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const dayName = daysOfWeek[startDate.getDay()];
        
        lines.push(`*Schedule:* ${pattern} - ${dayName}`);
        lines.push(`*Date Range:* ${startStr} to ${endStr} (${change.rangeCount} days)`);
      } else {
        lines.push(`*Scheduled date:* ${scheduledDate}`);
      }
      
      lines.push(...changeLines);
      lines.push('');
    }

    await axios.post(webhookUrl, { text: lines.join('\n') }, { timeout: 8000 });
  } catch (err) {
    console.error('Failed to send delivery change to Slack:', err.message);
  }
}

// Test route to verify delivery-changes router is working
router.get('/test', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Delivery Changes router is working!',
    timestamp: new Date().toISOString()
  });
});

// Test POST route without authentication
router.post('/test-post', (req, res) => {
  res.json({ 
    success: true, 
    message: 'POST route is working!',
    receivedBody: req.body,
    timestamp: new Date().toISOString()
  });
});

// DEBUG: Check status of specific delivery change
router.get('/debug/:changeId', async (req, res) => {
  try {
    const change = await DeliveryChange.findById(req.params.changeId)
      .populate('appliedToDelivery', 'customerName scheduledTime address');
    
    if (!change) {
      return res.status(404).json({ 
        success: false, 
        message: 'Change not found' 
      });
    }
    
    res.json({
      success: true,
      change: {
        id: change._id,
        customerId: change.customerId,
        status: change.status,
        appliedAt: change.appliedAt,
        appliedToDelivery: change.appliedToDelivery,
        changes: change.changes,
        createdAt: change.createdAt,
        updatedAt: change.updatedAt
      }
    });
  } catch (error) {
    res.status(500).json({ 
      success: false,
      message: 'Server error', 
      error: error.message 
    });
  }
});

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || 
        file.mimetype === 'application/vnd.ms-excel' ||
        file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
      cb(null, true);
    } else {
      cb(new Error('Only CSV and Excel files are allowed'), false);
    }
  }
});

// Helper function to apply changes to delivery
export async function applyChangesToDelivery(delivery, changes) {
  const updateFields = {};
  
  // Convert Mongoose Map to plain object if needed
  const changesObj = changes instanceof Map ? Object.fromEntries(changes) : changes;
  
  console.log('Changes to apply (converted):', changesObj);
  
  Object.keys(changesObj).forEach(field => {
    if (field === 'scheduledTime') {
      // Same shared conversion as routes/deliveries.js: "HH:mm" Dubai time on
      // the delivery's existing business day (issue #5). Throws on invalid.
      updateFields[field] = setBusinessTimeOfDay(delivery.scheduledTime, changesObj[field]);
    } else if (field === 'customerName') {
      updateFields[field] = changesObj[field];
    } else if (field === 'customerPhone') {
      updateFields[field] = changesObj[field];
    } else if (field === 'location' && !changesObj.address) {
      // Normalize 'location' to 'address' if provided
      updateFields['address'] = changesObj[field];
    } else {
      updateFields[field] = changesObj[field];
    }
  });

  // Keep zone in sync when address changes, unless zone is explicitly provided.
  if (updateFields.address && updateFields.zone === undefined) {
    updateFields.zone = detectAreaFromAddress(
      updateFields.address,
      delivery.zone,
      {
        company: updateFields.company || delivery.company || ''
      }
    );
  }

  console.log('Update fields for delivery:', delivery._id, updateFields);
  
  const updatedDelivery = await Delivery.findByIdAndUpdate(
    delivery._id, 
    { $set: updateFields },
    { new: true, runValidators: true }
  );
  
  if (!updatedDelivery) {
    throw new Error('Failed to update delivery - delivery not found');
  }
  
  console.log('Delivery updated successfully:', updatedDelivery._id);
  console.log('Updated values:', Object.keys(updateFields).reduce((acc, key) => {
    acc[key] = updatedDelivery[key];
    return acc;
  }, {}));
  
  return updatedDelivery;
}

  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  function normalizeToUTCStart(dateValue) {
    const date = new Date(dateValue);
    if (Number.isNaN(date.getTime())) {
      throw new Error('Invalid date provided');
    }
    return new Date(Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      0, 0, 0, 0
    ));
  }

  function normalizeToUTCEnd(dateValue) {
    const date = new Date(dateValue);
    if (Number.isNaN(date.getTime())) {
      throw new Error('Invalid date provided');
    }
    return new Date(Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      23, 59, 59, 999
    ));
  }

  async function calculateMatchMeta({ customerId, customerPhone, customerName }) {
    let matchConfidence = 0;
    const matchingFields = [];

    if (customerId) {
      const customerMatch = await User.findOne({
        $or: [
          { customerId: customerId },
          { 'profile.customerId': customerId }
        ]
      });
      if (customerMatch) {
        matchConfidence += 40;
        matchingFields.push('customerId');
      }
    }

    if (customerPhone) {
      const phoneMatch = await User.findOne({
        'profile.phone': customerPhone
      });
      if (phoneMatch) {
        matchConfidence += 30;
        matchingFields.push('phone');
      }
    }

    if (customerName) {
      const nameMatch = await User.findOne({
        $or: [
          { 'profile.firstName': new RegExp(customerName, 'i') },
          { 'profile.lastName': new RegExp(customerName, 'i') },
          { 'profile.firstName': customerName }
        ]
      });
      if (nameMatch) {
        matchConfidence += 30;
        matchingFields.push('name');
      }
    }

    return { matchConfidence, matchingFields };
  }

  async function createChangesForDateRange({
    customerId,
    customerName,
    customerPhone,
    startDate,
    endDate,
    changes,
    reason,
    uploadedBy,
    fileReference,
    matchConfidence = 0,
    matchingFields = [],
    daysOfWeek = [] // optional: filter by weekdays (0=Sun..6=Sat)
  }) {
    const normalizedStart = normalizeToUTCStart(startDate);
    const normalizedEnd = normalizeToUTCStart(endDate);

    if (normalizedEnd < normalizedStart) {
      throw new Error('End date cannot be earlier than start date');
    }

    const inclusiveEnd = normalizeToUTCEnd(endDate);
    const totalDays = Math.floor((inclusiveEnd.getTime() - normalizedStart.getTime()) / MS_PER_DAY) + 1;
    const isRange = totalDays > 1;
    const batchId = isRange ? new mongoose.Types.ObjectId().toString() : undefined;
    const rangeStartDate = isRange ? normalizedStart : undefined;
    const rangeEndDate = isRange ? inclusiveEnd : undefined;

    const createdChanges = [];

    for (let offset = 0; offset < totalDays; offset += 1) {
      const dayStart = new Date(normalizedStart.getTime() + offset * MS_PER_DAY);
      const dayEndExclusive = new Date(dayStart.getTime() + MS_PER_DAY);

      // If daysOfWeek provided, skip non-matching days
      if (Array.isArray(daysOfWeek) && daysOfWeek.length > 0) {
        const dow = dayStart.getUTCDay();
        if (!daysOfWeek.includes(dow)) {
          continue;
        }
      }

      const deliveries = await Delivery.find({
        customerId,
        scheduledTime: {
          $gte: dayStart,
          $lt: dayEndExclusive
        }
      });

      const deliveryChange = new DeliveryChange({
        customerId,
        customerName,
        customerPhone: customerPhone || '',
        scheduledDate: dayStart,
        changes,
        reason: reason || 'Manual entry',
        uploadedBy,
        fileReference,
        matchConfidence,
        matchingFields,
        status: deliveries.length > 0 ? 'applied' : 'pending',
        appliedAt: deliveries.length > 0 ? new Date() : null,
        appliedToDelivery: deliveries[0]?._id || null,
        rangeBatchId: batchId,
        rangeStartDate,
        rangeEndDate,
        rangeSequence: isRange ? offset + 1 : undefined,
        rangeCount: isRange ? totalDays : undefined
      });

      if (deliveries.length > 0) {
        for (const delivery of deliveries) {
          const updatedDelivery = await applyChangesToDelivery(delivery, changes);
          // `delivery` here is still the pre-update doc (findByIdAndUpdate
          // inside applyChangesToDelivery doesn't mutate it) — compare
          // against the real post-update values, since applyChangesToDelivery
          // transforms some fields (e.g. scheduledTime "HH:mm" -> Date).
          await flagDeliveryChangeIfNeeded(delivery, updatedDelivery.toObject());
        }
      }

      await deliveryChange.save();
      await deliveryChange.populate([
        { path: 'uploadedBy', select: 'profile firstName lastName email' },
        { path: 'appliedToDelivery', select: 'customerName scheduledTime status' }
      ]);

      createdChanges.push(deliveryChange);
    }

    return createdChanges;
  }

// CREATE MANUAL DELIVERY CHANGE
router.post('/manual', async (req, res) => {
  console.log('=== MANUAL ROUTE HIT ===');
  console.log('Method:', req.method);
  console.log('URL:', req.url);
  console.log('Headers:', req.headers);
  console.log('Body:', req.body);
  
  try {
    const { 
      customerId, 
      customerName, 
      customerPhone, 
      scheduledDate, 
      endDate,
      changes, 
      reason ,
      daysOfWeek
    } = req.body;

    console.log('Received manual delivery change request:', req.body);

    if (!customerId || !customerName || !scheduledDate) {
      return res.status(400).json({ 
        message: 'Customer ID, Customer Name, and Scheduled Date are required' 
      });
    }

    if (!changes || Object.keys(changes).length === 0) {
      return res.status(400).json({ 
        message: 'At least one change must be specified' 
      });
    }

    if (changes.scheduledTime !== undefined && !parseTimeOfDay(changes.scheduledTime)) {
      return res.status(400).json({
        message: 'Invalid time. Use HH:mm, 24-hour (00:00-23:59).'
      });
    }

    const startDate = new Date(scheduledDate);
    if (Number.isNaN(startDate.getTime())) {
      return res.status(400).json({ 
        message: 'Invalid scheduled date format' 
      });
    }

    const effectiveEndDate = endDate ? new Date(endDate) : startDate;
    if (Number.isNaN(effectiveEndDate.getTime())) {
      return res.status(400).json({ 
        message: 'Invalid end date format' 
      });
    }

    const { matchConfidence, matchingFields } = await calculateMatchMeta({
      customerId,
      customerPhone,
      customerName
    });

    const createdChanges = await createChangesForDateRange({
      customerId,
      customerName,
      customerPhone,
      startDate,
      endDate: effectiveEndDate,
      changes,
      reason,
      uploadedBy: req.user?.id || null,
      fileReference: 'manual',
      matchConfidence,
      matchingFields,
      daysOfWeek: Array.isArray(daysOfWeek) ? daysOfWeek : []
    });

    // Fire-and-forget Slack notification
    const submitterName = req.user?.profile?.firstName
      ? `${req.user.profile.firstName} ${req.user.profile.lastName || ''}`.trim()
      : req.user?.email || req.user?._id || 'Unknown user';

    sendDeliveryChangeToSlack(createdChanges, {
      submitter: submitterName,
      reason,
      matchConfidence,
      matchingFields
    }).catch(() => {});

    res.status(201).json({
      success: true,
      message: `Delivery change${createdChanges.length > 1 ? 's' : ''} created successfully`,
      count: createdChanges.length,
      change: createdChanges[0],
      changes: createdChanges
    });
  } catch (error) {
    console.error('Create manual delivery change error:', error);
    const statusCode = error.message === 'End date cannot be earlier than start date' || error.message === 'Invalid date provided' ? 400 : 500;
    res.status(statusCode).json({ 
      success: false,
      message: statusCode === 400 ? error.message : 'Server error', 
      error: error.message 
    });
  }
});

// GET PENDING CHANGES FOR A SPECIFIC CUSTOMER AND DATE
// Get pending changes for a specific customer and date
router.get('/pending', protect, async (req, res) => {
  try {
    const { customerId, scheduledDate } = req.query;
    
    console.log('Searching for pending changes:', { customerId, scheduledDate });

    if (!customerId || !scheduledDate) {
      return res.status(400).json({ 
        message: 'customerId and scheduledDate are required' 
      });
    }

    // Parse the date and create date range - ALWAYS use UTC
    const targetDate = new Date(scheduledDate);
    
    // Use UTC to avoid timezone issues
    const startOfDay = new Date(Date.UTC(
      targetDate.getUTCFullYear(),
      targetDate.getUTCMonth(),
      targetDate.getUTCDate(),
      0, 0, 0, 0
    ));
    
    const endOfDay = new Date(Date.UTC(
      targetDate.getUTCFullYear(),
      targetDate.getUTCMonth(),
      targetDate.getUTCDate(),
      23, 59, 59, 999
    ));

    console.log('Date range for search:', { startOfDay, endOfDay });

    // First, let's see ALL changes for this customer regardless of status
    const allChangesForCustomer = await DeliveryChange.find({
      customerId: customerId
    }).sort({ createdAt: -1 }).limit(5);
    
    console.log('Recent changes for customer:', allChangesForCustomer.map(c => ({
      id: c._id,
      customerId: c.customerId,
      scheduledDate: c.scheduledDate,
      status: c.status,
      appliedToDelivery: c.appliedToDelivery
    })));

    const pendingChanges = await DeliveryChange.find({
      customerId: customerId,
      scheduledDate: {
        $gte: startOfDay,
        $lte: endOfDay
      },
      $or: [
        { status: 'pending' },
        { status: 'applied', appliedToDelivery: { $exists: false } },
        { status: 'applied', appliedToDelivery: null }
      ]
    }).sort({ createdAt: 1 });

    console.log(`Found ${pendingChanges.length} pending changes`);

    res.json({
      success: true,
      changes: pendingChanges,
      total: pendingChanges.length,
      searchCriteria: {
        customerId,
        scheduledDate,
        startOfDay,
        endOfDay
      }
    });
  } catch (error) {
    console.error('Get pending changes error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error', 
      error: error.message 
    });
  }
});

// DEBUG ENDPOINT - Get all changes for a specific customer
router.get('/debug/customer/:customerId', protect, async (req, res) => {
  try {
    const changes = await DeliveryChange.find({ customerId: req.params.customerId })
      .sort({ createdAt: -1 })
      .populate('appliedToDelivery', 'customerName scheduledTime')
      .lean();
    
    // Also get deliveries for this customer
    const deliveries = await Delivery.find({ customerId: req.params.customerId })
      .select('customerId customerName scheduledTime status')
      .sort({ scheduledTime: -1 })
      .limit(10)
      .lean();
    
    res.json({
      success: true,
      customerId: req.params.customerId,
      totalChanges: changes.length,
      totalDeliveries: deliveries.length,
      changes: changes.map(c => ({
        _id: c._id,
        scheduledDate: c.scheduledDate,
        scheduledDateUTC: c.scheduledDate.toISOString(),
        status: c.status,
        appliedToDelivery: c.appliedToDelivery,
        appliedAt: c.appliedAt,
        changes: c.changes,
        createdAt: c.createdAt
      })),
      deliveries: deliveries.map(d => ({
        _id: d._id,
        scheduledTime: d.scheduledTime,
        scheduledTimeUTC: d.scheduledTime.toISOString(),
        status: d.status
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// APPLY A SPECIFIC CHANGE
router.post('/:id/apply', protect, async (req, res) => {
  console.log('=== MANUAL APPLY CHANGE REQUEST ===');
  console.log('Change ID:', req.params.id);
  
  try {
    const change = await DeliveryChange.findById(req.params.id);
    if (!change) {
      return res.status(404).json({ 
        success: false,
        message: 'Change not found' 
      });
    }

    if (change.status === 'applied') {
      return res.status(400).json({ 
        success: false,
        message: 'Changes already applied' 
      });
    }

    const { startOfDay, endOfDayExclusive } = getBusinessDayBounds(change.scheduledDate);

    console.log('Looking for delivery:', { 
      customerId: change.customerId, 
      startOfDay: startOfDay.toISOString(), 
      endOfDayExclusive: endOfDayExclusive.toISOString()
    });

    // Debug: Check ALL deliveries for this customer to see what's available
    const allCustomerDeliveries = await Delivery.find({ customerId: change.customerId });
    console.log('All deliveries for customer:', allCustomerDeliveries.map(d => ({
      id: d._id.toString(),
      customerId: d.customerId,
      scheduledTime: d.scheduledTime.toISOString(),
      address: d.address
    })));

    const delivery = await Delivery.findOne({
      customerId: change.customerId,
      scheduledTime: {
        $gte: startOfDay,
        $lt: endOfDayExclusive
      }
    }).sort({ scheduledTime: 1 });

    console.log('Found delivery:', delivery ? delivery._id.toString() : 'None');

    if (!delivery) {
      return res.status(404).json({ 
        success: false,
        message: 'No delivery found for this date' 
      });
    }

    console.log('Before applying changes:', {
      deliveryId: delivery._id,
      address: delivery.address,
      changes: change.changes
    });

    // Apply changes and get updated delivery
    const updatedDelivery = await applyChangesToDelivery(delivery, change.changes);

    // `delivery` is still the pre-update doc fetched above — surface the
    // "changed since assignment" banner to the driver if this touched
    // anything driver-relevant on an already-assigned delivery.
    await flagDeliveryChangeIfNeeded(delivery, updatedDelivery.toObject());

    // Log the change on the delivery timeline so it is visible in delivery details
    const changeReason = change.reason || 'delivery change';
    const changedFields = Object.keys(change.changes instanceof Map ? Object.fromEntries(change.changes) : change.changes || {});
    const changeNotes = `Delivery change applied (${changeReason}). Fields: ${changedFields.length ? changedFields.join(', ') : 'none'}`;
    updatedDelivery.timeline = updatedDelivery.timeline || [];
    updatedDelivery.timeline.push({ status: 'delivery_change_applied', notes: changeNotes, timestamp: new Date() });
    await updatedDelivery.save();

    console.log('After applying changes:', {
      deliveryId: updatedDelivery._id,
      address: updatedDelivery.address
    });

    // Update change record
    change.status = 'applied';
    change.appliedAt = new Date();
    change.appliedToDelivery = delivery._id;
    await change.save();

    // Populate the updated delivery for response
    const populatedDelivery = await Delivery.findById(updatedDelivery._id)
      .populate('driver', 'profile.firstName profile.lastName profile.colorCode email');

    res.json({ 
      success: true,
      message: 'Changes applied successfully',
      change,
      delivery: populatedDelivery 
    });
  } catch (error) {
    console.error('Apply change error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error', 
      error: error.message 
    });
  }
});

router.post('/apply/:changeId', protect, admin, async (req, res) => {
  try {
    const change = await DeliveryChange.findById(req.params.changeId);
    if (!change) {
      return res.status(404).json({ message: 'Change not found' });
    }

    if (change.status === 'applied') {
      return res.status(400).json({ message: 'Changes already applied' });
    }

    // Find delivery for this customer and exact business day
    const { startOfDay, endOfDayExclusive } = getBusinessDayBounds(change.scheduledDate);

    console.log('Looking for delivery:', {
      customerId: change.customerId,
      startOfDay,
      endOfDayExclusive
    });

    const delivery = await Delivery.findOne({
      customerId: change.customerId,
      scheduledTime: {
        $gte: startOfDay,
        $lt: endOfDayExclusive
      }
    }).sort({ scheduledTime: 1 });

    console.log('Found delivery:', delivery);

    if (!delivery) {
      return res.status(404).json({ 
        message: 'No delivery found for this customer and date',
        details: {
          customerId: change.customerId,
          date: change.scheduledDate
        }
      });
    }

    // Apply changes
    const updatedDelivery = await applyChangesToDelivery(delivery, change.changes);
    await flagDeliveryChangeIfNeeded(delivery, updatedDelivery.toObject());

    // Update change record
    change.status = 'applied';
    change.appliedAt = new Date();
    change.appliedToDelivery = delivery._id;
    await change.save();

    res.json({ 
      message: 'Changes applied successfully',
      change,
      delivery 
    });
  } catch (error) {
    console.error('Apply changes error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// GET ALL DELIVERY CHANGES
router.get('/', protect, admin, async (req, res) => {
  try {
    const { 
      status, 
      startDate, 
      endDate, 
      customerId, 
      page = 1, 
      limit = 50 
    } = req.query;

    const query = {};
    
    if (status) query.status = status;
    if (customerId) query.customerId = customerId;
    
    if (startDate || endDate) {
      query.scheduledDate = {};
      if (startDate) query.scheduledDate.$gte = new Date(startDate);
      if (endDate) query.scheduledDate.$lte = new Date(endDate);
    }

    const changes = await DeliveryChange.find(query)
      .populate('uploadedBy', 'profile firstName lastName email')
      .populate('appliedToDelivery', 'customerName scheduledTime status')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await DeliveryChange.countDocuments(query);

    res.json({
      success: true,
      changes,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (error) {
    console.error('Get delivery changes error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error', 
      error: error.message 
    });
  }
});

// UPLOAD DELIVERY CHANGES VIA FILE
router.post('/upload', protect, upload.single('file'), async (req, res) => {
  console.log('=== DELIVERY CHANGES UPLOAD STARTED ===');
  console.log('User:', req.user ? { id: req.user._id, role: req.user.role } : 'No user');
  console.log('File:', req.file ? req.file.originalname : 'No file');
  
  try {
    if (!req.file) {
      return res.status(400).json({ 
        success: false,
        message: 'No file uploaded' 
      });
    }

    const results = [];
    const errors = [];
    const fileBuffer = req.file.buffer;
    const fileName = req.file.originalname;

    // Parse CSV file
    const parseCSV = () => {
      return new Promise((resolve, reject) => {
        const stream = require('stream');
        const bufferStream = new stream.PassThrough();
        bufferStream.end(fileBuffer);

        bufferStream
          .pipe(csv())
          .on('data', (data) => {
            // Validate required fields
            if (!data.customerId && !data.customerName) {
              errors.push({
                row: results.length + 1,
                error: 'Missing customer identifier (customerId or customerName required)',
                data
              });
              return;
            }

            if (!data.scheduledDate) {
              errors.push({
                row: results.length + 1,
                error: 'Missing scheduledDate',
                data
              });
              return;
            }

            const rawEndDate = data.endDate || data.rangeEndDate || '';
            let parsedEndDate = null;
            if (rawEndDate) {
              const endDateValue = new Date(rawEndDate);
              if (Number.isNaN(endDateValue.getTime())) {
                errors.push({
                  row: results.length + 1,
                  error: 'Invalid endDate provided',
                  data
                });
                return;
              }
              parsedEndDate = endDateValue;
            }

            // Parse changes
            const changes = {};
            const changeableFields = [
              'address', 'scheduledTime', 'company', 'notes', 
              'customerName', 'customerPhone', 'type'
            ];

            changeableFields.forEach(field => {
              if (data[field] !== undefined && data[field] !== '') {
                changes[field] = data[field];
              }
            });

            if (Object.keys(changes).length === 0) {
              errors.push({
                row: results.length + 1,
                error: 'No valid changes provided',
                data
              });
              return;
            }

            if (changes.scheduledTime !== undefined && !parseTimeOfDay(changes.scheduledTime)) {
              errors.push({
                row: results.length + 1,
                error: `Invalid scheduledTime "${changes.scheduledTime}" — use HH:mm, 24-hour (00:00-23:59)`,
                data
              });
              return;
            }

            results.push({
              customerId: data.customerId,
              customerName: data.customerName,
              customerPhone: data.customerPhone,
              scheduledDate: new Date(data.scheduledDate),
              endDate: parsedEndDate,
              changes: changes,
              reason: data.reason || 'Bulk upload'
            });
          })
          .on('end', () => resolve())
          .on('error', (error) => reject(error));
      });
    };

    await parseCSV();

    console.log(`Parsed ${results.length} change records from CSV`);
    console.log(`Found ${errors.length} parsing errors`);
    
    if (results.length > 0) {
      console.log('First parsed record:', results[0]);
    }

    // Process each change
    const processedChanges = [];
    for (const changeData of results) {
      try {
        const { matchConfidence, matchingFields } = await calculateMatchMeta({
          customerId: changeData.customerId,
          customerPhone: changeData.customerPhone,
          customerName: changeData.customerName
        });

        const created = await createChangesForDateRange({
          customerId: changeData.customerId,
          customerName: changeData.customerName,
          customerPhone: changeData.customerPhone,
          startDate: changeData.scheduledDate,
          endDate: changeData.endDate || changeData.scheduledDate,
          changes: changeData.changes,
          reason: changeData.reason || 'Bulk upload',
          uploadedBy: req.user?.id || null,
          fileReference: fileName,
          matchConfidence,
          matchingFields
        });

        processedChanges.push(...created);
      } catch (error) {
        errors.push({
          row: processedChanges.length + 1,
          error: error.message,
          data: changeData
        });
      }
    }

    res.json({
      success: true,
      message: `Processed ${processedChanges.length} changes, ${errors.length} errors`,
      processed: processedChanges.length,
      errors: errors,
      changes: processedChanges
    });

  } catch (error) {
    console.error('Upload delivery changes error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error', 
      error: error.message 
    });
  }
});

export default router;