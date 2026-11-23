import express from 'express';
import mongoose from 'mongoose';
import Bag from '../models/Bag.js';
import User, { effectivePermissions } from '../models/User.js';
import { protect, authorize } from '../middleware/auth.js';
import { moveBag } from '../services/bagMovementStore.js';
import { findRegisteredBag } from '../services/bagRecordLookup.js';
import { normalizeBagId } from '../services/bagInventoryAudit.js';
import { buildDispatcherHandovers, validateDispatcherHandover } from '../services/dispatcherHandoverService.js';
const router = express.Router();
router.use(protect, authorize(['super_admin', 'admin', 'manager', 'dispatcher']), (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!effectivePermissions(req.user).bags) return res.status(403).json({
    success: false,
    message: 'Bag permission is required.'
  });
  next();
});
router.get('/', async (req, res) => {
  try {
    // Limit complete receipts, never individual events: every included offer
    // needs all its preparation and settlement evidence for exact bag counts.
    const groups = await Bag.aggregate([{
      $match: { 'history.eventId': /^handover:/ }
    }, {
      $unwind: '$history'
    }, {
      $match: { $or: [{
        'history.eventType': 'pack', 'history.eventId': /^handover:/
      }, {
        'history.before.pendingHandover.eventId': /^handover:/
      }] }
    }, {
      $group: {
        _id: { $let: {
          vars: { parts: { $split: [{ $cond: [
            { $eq: ['$history.eventType', 'pack'] },
            '$history.eventId', '$history.before.pendingHandover.eventId'
          ] }, ':'] } },
          in: { $concat: [
            { $arrayElemAt: ['$$parts', 0] }, ':',
            { $arrayElemAt: ['$$parts', 1] }, ':',
            { $arrayElemAt: ['$$parts', 2] }, ':',
            { $arrayElemAt: ['$$parts', 3] }
          ] }
        } },
        latest: { $max: '$history.timestamp' },
        events: { $push: { bagId: '$bagId', event: '$history' } }
      }
    }, {
      $sort: { latest: -1, _id: 1 }
    }, {
      $limit: 101
    }]).allowDiskUse(true);
    const rows = groups.slice(0, 100).flatMap(group => group.events);
    const ids = [...new Set(rows.map(r => r.event.assignedTo?.driver).filter(id => mongoose.isValidObjectId(id)).map(String))];
    const users = await User.find({
      _id: {
        $in: ids
      }
    }).select('profile.firstName profile.lastName name').lean();
    res.json({
      success: true,
      data: {
        receipts: buildDispatcherHandovers(rows, users),
        truncated: groups.length > 100
      }
    });
  } catch (e) {
    res.status(500).json({
      success: false,
      message: 'Unable to load handover history. Please retry.'
    });
  }
});
router.post('/', async (req, res) => {
  const {
    requestId,
    driverId,
    bags,
    note
  } = req.body || {};
  const validation = validateDispatcherHandover(req.body);
  if (validation) return res.status(400).json({
    success: false,
    message: validation
  });
  try {
    const driver = await User.findById(driverId).select('role isActive');
    if (driver?.role !== 'driver' || !driver.isActive) return res.status(400).json({
      success: false,
      message: 'Select an active receiving driver.'
    });
    const successes = [],
      failures = [],
      seen = new Set();
    for (const item of bags) {
      const code = normalizeBagId(item.bagId);
      if (seen.has(code)) continue;
      seen.add(code);
      try {
        const bag = await findRegisteredBag(Bag.collection, code);
        if (!bag) throw Object.assign(new Error('This bag is not registered.'), {
          statusCode: 404
        });
        const eventId = `handover:${requestId.toLowerCase()}:${req.user._id}:${driverId}:${bag._id}`;
        const result = await moveBag(bag.bagId, {
          action: 'pack',
          eventId,
          driverId,
          note: note.trim() || 'Physical dispatcher handover prepared',
          expectedVersion: item.expectedVersion
        }, req.user);
        successes.push({
          bagId: result.bag.bagId,
          eventId,
          duplicate: result.duplicate
        });
        req.app.get('io')?.emit('bag:updated', {
          bagId: result.bag.bagId
        });
      } catch (e) {
        failures.push({
          bagId: code,
          message: e.message || 'Bag could not be prepared.'
        });
      }
    }
    res.json({
      success: true,
      data: {
        id: `handover:${requestId.toLowerCase()}:${req.user._id}:${driverId}`,
        successes,
        failures
      },
      message: 'Prepared bags remain in warehouse custody until the receiving driver accepts.'
    });
  } catch (e) {
    res.status(e.statusCode || 500).json({
      success: false,
      message: e.statusCode ? e.message : 'Unable to prepare handover. Retry the same request.'
    });
  }
});
export default router;
