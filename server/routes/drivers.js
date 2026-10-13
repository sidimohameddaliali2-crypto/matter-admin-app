import express from 'express';
import User from '../models/User.js';
import Delivery from '../models/Delivery.js';
import { protect, admin } from '../middleware/auth.js';
import { getDirections } from '../services/googleDirectionsService.js';
import { addressForDriver } from '../services/reverseGeocode.js';
import { mapWithLimit } from '../utils/concurrency.js';

const router = express.Router();

// Get all drivers
router.get('/', protect, async (req, res) => {
  try {
    const drivers = await User.find({ role: 'driver' })
      .select('-password')
      .populate('profile')
      .lean();

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const driverIds = drivers.map(d => d._id);

    // Per-driver stats computed with $group in MongoDB instead of pulling
    // every matching delivery document into Node and reducing them here —
    // the all-time query matches ~75k of this collection's 80k+ documents,
    // which made fetching the raw documents take 10+ seconds even once the
    // query itself had an index to use.
    const [todayStats, allTimeStats] = await Promise.all([
      Delivery.aggregate([
        { $match: { driver: { $in: driverIds }, scheduledTime: { $gte: today, $lt: tomorrow } } },
        {
          $group: {
            _id: '$driver',
            deliveriesCount: { $sum: { $cond: [{ $ne: ['$type', 'Task'] }, 1, 0] } },
            tasksCount: { $sum: { $cond: [{ $eq: ['$type', 'Task'] }, 1, 0] } },
            performedCount: { $sum: { $cond: [{ $in: ['$status', ['delivered', 'completed', 'collected']] }, 1, 0] } }
          }
        }
      ]),
      // $in on the two concrete types (not $ne: 'Task') so this can use the
      // driver+type index below — $ne isn't sargable. Only complaintsCount is
      // pulled from this any more (score/avgLateTime/accuracyRate now come
      // from the stored, month-to-date driver.kpi below) — it's an all-time
      // reputation count, not part of the monthly scorecard.
      Delivery.aggregate([
        { $match: { driver: { $in: driverIds }, type: { $in: ['Delivery', 'Collection'] } } },
        {
          $group: {
            _id: '$driver',
            complaintsCount: { $sum: { $cond: [{ $eq: ['$complaint.hasComplaint', true] }, 1, 0] } }
          }
        }
      ])
    ]);

    const todayByDriver = new Map(todayStats.map((s) => [s._id.toString(), s]));
    const allTimeByDriver = new Map(allTimeStats.map((s) => [s._id.toString(), s]));

    const driversWithStats = drivers.map((driver) => {
      const driverKey = driver._id.toString();
      const today = todayByDriver.get(driverKey) || { deliveriesCount: 0, tasksCount: 0, performedCount: 0 };
      const allTime = allTimeByDriver.get(driverKey) || { complaintsCount: 0 };

      return {
        ...driver,
        todayDeliveries: today.deliveriesCount,
        deliveriesCount: today.deliveriesCount,
        tasksCount: today.tasksCount,
        performedCount: today.performedCount,
        // score/avgLateTime/accuracyRate/updateRate are the month-to-date
        // scorecard maintained by services/driverKpiService.js — read as
        // stored instead of recomputing a separate all-time figure here, so
        // the driver list card matches the driver detail page exactly.
        kpi: {
          ...(driver.kpi || {}),
          complaintsCount: allTime.complaintsCount
        }
      };
    });

    res.json(driversWithStats);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get driver locations for live map (must be declared before :id route)
router.get('/locations', protect, async (req, res) => {
  try {
    const includeInactive = req.query.includeInactive === 'true';

    const drivers = await User.find({
      role: 'driver',
      ...(includeInactive ? {} : { isActive: true })
    })
      .select('-password')
      .select('email profile location isActive kpi lastLogin updatedAt createdAt')
      .lean();

    const driverLocations = await mapWithLimit(drivers, 5, async (driver) => {
      const rawLat = driver.location?.latitude;
      const rawLng = driver.location?.longitude;
      const latitude = rawLat !== undefined && rawLat !== null ? Number(rawLat) : null;
      const longitude = rawLng !== undefined && rawLng !== null ? Number(rawLng) : null;
      const hasCoordinates = Number.isFinite(latitude) && Number.isFinite(longitude);

      // The app sends coordinates only; look the street address up (cached and
      // throttled per driver — see services/reverseGeocode.js).
      const address = hasCoordinates
        ? driver.location?.address || (await addressForDriver(driver._id, latitude, longitude)) || null
        : null;

      return {
        _id: driver._id,
        email: driver.email,
        profile: driver.profile || {},
        isActive: driver.isActive,
        kpi: driver.kpi || {},
        lastLogin: driver.lastLogin,
        location: hasCoordinates
          ? {
              latitude,
              longitude,
              lastUpdated: driver.location?.lastUpdated || driver.updatedAt || driver.createdAt,
              address
            }
          : null
      };
    });

    res.json(driverLocations);
  } catch (error) {
    console.error('Error fetching driver locations:', error);
    res.status(500).json({ message: 'Failed to fetch driver locations', error: error.message });
  }
});

// One driver's last reported position and its street address (the app sends
// coordinates only; the address is looked up server-side).
router.get('/:id/location', protect, async (req, res) => {
  try {
    const isOwnLocation = String(req.user.id || req.user._id) === String(req.params.id);
    if (req.user.role === 'driver' && !isOwnLocation) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    const driver = await User.findOne({ _id: req.params.id, role: 'driver' })
      .select('email profile.firstName profile.lastName location')
      .lean();
    if (!driver) {
      return res.status(404).json({ success: false, message: 'Driver not found' });
    }
    const latitude = Number(driver.location?.latitude);
    const longitude = Number(driver.location?.longitude);
    const hasCoordinates = Number.isFinite(latitude) && Number.isFinite(longitude);
    const address = hasCoordinates
      ? driver.location?.address || (await addressForDriver(driver._id, latitude, longitude)) || null
      : null;
    res.json({
      success: true,
      data: {
        driverId: String(driver._id),
        location: hasCoordinates
          ? { latitude, longitude, lastUpdated: driver.location?.lastUpdated || null, address }
          : null
      }
    });
  } catch (error) {
    console.error('Error fetching driver location:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch driver location' });
  }
});

// Update driver location (drivers can update themselves, admins can update any driver)
router.put('/:id/location', protect, async (req, res) => {
  try {
    const driverId = req.params.id;

    const canUpdate =
      req.user.role === 'super_admin' ||
      req.user.role === 'admin' ||
      req.user.id === driverId;

    if (!canUpdate) {
      return res.status(403).json({ message: 'You do not have permission to update this driver location' });
    }

    const normalizedLocation = normalizeDriverLocationPayload(req.body);

    if (!normalizedLocation) {
      return res.status(400).json({ message: 'Valid latitude and longitude are required' });
    }

    // This endpoint is hit every ~10-30s per active driver (live location
    // tracking), so it's worth a targeted partial update instead of loading
    // the full User document (profile, kpi, dashboardLayout, etc.), mutating
    // one field, and re-validating/re-saving the whole thing.
    const driver = await User.findOneAndUpdate(
      { _id: driverId, role: 'driver' },
      {
        $set: {
          location: {
            ...normalizedLocation,
            lastUpdated: normalizedLocation.lastUpdated || new Date()
          }
        }
      },
      { new: true, select: '_id email profile isActive kpi location' }
    );

    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' });
    }

    res.json({
      success: true,
      driverId: driver._id,
      driver,
      location: driver.location
    });
  } catch (error) {
    console.error('Error updating driver location:', error);
    res.status(500).json({ message: 'Failed to update driver location', error: error.message });
  }
});

// Get driving directions through an ordered sequence of points, for the
// mobile Route Navigator screen (driver's live position + remaining stops,
// in the dispatch-assigned visit order). Proxies Google Directions so the
// API key stays server-side — the mobile app never holds it directly.
router.post('/:id/route-directions', protect, async (req, res) => {
  try {
    const driverId = req.params.id;

    const canView =
      req.user.role === 'super_admin' ||
      req.user.role === 'admin' ||
      req.user.id === driverId;

    if (!canView) {
      return res.status(403).json({ message: 'You do not have permission to request directions for this driver' });
    }

    const points = Array.isArray(req.body?.points) ? req.body.points : [];
    const validPoints = points.filter(
      (p) => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng))
    );

    if (validPoints.length < 2) {
      return res.status(400).json({ message: 'At least two valid {lat, lng} points are required' });
    }

    const directions = await getDirections(validPoints);
    res.json({ success: true, ...directions });
  } catch (error) {
    console.error('Error fetching route directions:', error);
    res.status(500).json({ message: 'Failed to fetch route directions', error: error.message });
  }
});

// Get driver by ID
router.get('/:id', protect, async (req, res) => {
  try {
    const driver = await User.findById(req.params.id)
      .select('-password')
      .populate('profile');

    if (!driver || driver.role !== 'driver') {
      return res.status(404).json({ message: 'Driver not found' });
    }

    // Get driver statistics
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const todayDeliveries = await Delivery.find({
      driver: driver._id,
      scheduledTime: {
        $gte: today,
        $lt: tomorrow
      }
    }).sort({ scheduledTime: 1 });

    const recentDeliveries = await Delivery.find({ driver: driver._id })
      .sort({ scheduledTime: -1 })
      .limit(30);

    const driverWithStats = {
      ...driver.toObject(),
      todayDeliveries: todayDeliveries.map(d => ({
        id: d._id,
        customer: d.customerName,
        scheduled: d.scheduledTime.toLocaleTimeString(),
        status: d.status,
        late: d.lateMinutes
      })),
      recentDeliveries: recentDeliveries.map(d => ({
        id: d._id,
        date: d.scheduledTime,
        customer: d.customerName,
        status: d.status,
        lateMinutes: d.lateMinutes || 0,
        proof: d.proof?.images || []
      })),
      // score/avgLateTime/accuracyRate/updateRate are the month-to-date
      // scorecard maintained by services/driverKpiService.js — read as
      // stored instead of recomputing a separate all-time figure here, so
      // this matches the driver list card exactly. complaintsCount stays an
      // all-time reputation count, computed fresh.
      kpi: {
        ...(driver.kpi?.toObject ? driver.kpi.toObject() : driver.kpi || {}),
        complaintsCount: await getComplaintsCount(driver._id)
      }
    };

    res.json(driverWithStats);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get weekly delivery statistics
router.get('/:id/stats/weekly', protect, async (req, res) => {
  try {
    const driver = await User.findById(req.params.id);
    if (!driver || driver.role !== 'driver') {
      return res.status(404).json({ message: 'Driver not found' });
    }

    const today = new Date();
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - today.getDay()); // Start of current week (Sunday)
    weekStart.setHours(0, 0, 0, 0);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 7);

    // Get deliveries for this week
    const weekDeliveries = await Delivery.find({
      driver: driver._id,
      scheduledTime: { $gte: weekStart, $lt: weekEnd }
    });

    // Get last week's deliveries
    const lastWeekStart = new Date(weekStart);
    lastWeekStart.setDate(weekStart.getDate() - 7);
    const lastWeekEnd = new Date(weekStart);

    const lastWeekDeliveries = await Delivery.find({
      driver: driver._id,
      scheduledTime: { $gte: lastWeekStart, $lt: lastWeekEnd }
    });

    const calculateWeeklyStats = (deliveries) => {
      const onTime = deliveries.filter(d => 
        d.status === 'delivered' && d.lateMinutes <= 0
      ).length;
      const late = deliveries.filter(d => 
        d.status === 'delivered' && d.lateMinutes > 0
      ).length;

      return {
        total: deliveries.length,
        completed: deliveries.filter(d => d.status === 'delivered').length,
        pending: deliveries.filter(d => d.status !== 'delivered').length,
        onTime,
        late,
        avgLateMinutes: deliveries.length > 0 
          ? Math.round(deliveries.reduce((sum, d) => sum + d.lateMinutes, 0) / deliveries.length)
          : 0
      };
    };

    res.json({
      period: 'weekly',
      currentWeek: {
        startDate: weekStart.toISOString().split('T')[0],
        endDate: new Date(weekEnd.getTime() - 1).toISOString().split('T')[0],
        stats: calculateWeeklyStats(weekDeliveries)
      },
      lastWeek: {
        startDate: lastWeekStart.toISOString().split('T')[0],
        endDate: new Date(lastWeekEnd.getTime() - 1).toISOString().split('T')[0],
        stats: calculateWeeklyStats(lastWeekDeliveries)
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get monthly delivery statistics
router.get('/:id/stats/monthly', protect, async (req, res) => {
  try {
    const driver = await User.findById(req.params.id);
    if (!driver || driver.role !== 'driver') {
      return res.status(404).json({ message: 'Driver not found' });
    }

    const today = new Date();
    
    // Current month
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 1);

    // Last month
    const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 1);

    const currentMonthDeliveries = await Delivery.find({
      driver: driver._id,
      scheduledTime: { $gte: monthStart, $lt: monthEnd }
    });

    const lastMonthDeliveries = await Delivery.find({
      driver: driver._id,
      scheduledTime: { $gte: lastMonthStart, $lt: lastMonthEnd }
    });

    const calculateMonthlyStats = (deliveries) => {
      const onTime = deliveries.filter(d => 
        d.status === 'delivered' && d.lateMinutes <= 0
      ).length;
      const late = deliveries.filter(d => 
        d.status === 'delivered' && d.lateMinutes > 0
      ).length;

      return {
        total: deliveries.length,
        completed: deliveries.filter(d => d.status === 'delivered').length,
        pending: deliveries.filter(d => d.status !== 'delivered').length,
        onTime,
        late,
        avgLateMinutes: deliveries.length > 0 
          ? Math.round(deliveries.reduce((sum, d) => sum + d.lateMinutes, 0) / deliveries.length)
          : 0
      };
    };

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    res.json({
      period: 'monthly',
      currentMonth: {
        month: monthNames[today.getMonth()],
        year: today.getFullYear(),
        startDate: monthStart.toISOString().split('T')[0],
        endDate: new Date(monthEnd.getTime() - 1).toISOString().split('T')[0],
        stats: calculateMonthlyStats(currentMonthDeliveries)
      },
      lastMonth: {
        month: monthNames[today.getMonth() - 1 < 0 ? 11 : today.getMonth() - 1],
        year: today.getMonth() - 1 < 0 ? today.getFullYear() - 1 : today.getFullYear(),
        startDate: lastMonthStart.toISOString().split('T')[0],
        endDate: new Date(lastMonthEnd.getTime() - 1).toISOString().split('T')[0],
        stats: calculateMonthlyStats(lastMonthDeliveries)
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get delivery statistics for custom date range
router.get('/:id/stats', protect, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const driver = await User.findById(req.params.id);
    if (!driver || driver.role !== 'driver') {
      return res.status(404).json({ message: 'Driver not found' });
    }

    if (!startDate || !endDate) {
      return res.status(400).json({ message: 'startDate and endDate query parameters are required (YYYY-MM-DD format)' });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setDate(end.getDate() + 1); // Include the entire end date

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({ message: 'Invalid date format. Use YYYY-MM-DD' });
    }

    const deliveries = await Delivery.find({
      driver: driver._id,
      scheduledTime: { $gte: start, $lt: end }
    });

    const onTime = deliveries.filter(d => 
      d.status === 'delivered' && d.lateMinutes <= 0
    ).length;
    const late = deliveries.filter(d => 
      d.status === 'delivered' && d.lateMinutes > 0
    ).length;

    const stats = {
      total: deliveries.length,
      completed: deliveries.filter(d => d.status === 'delivered').length,
      pending: deliveries.filter(d => d.status !== 'delivered').length,
      onTime,
      late,
      avgLateMinutes: deliveries.length > 0 
        ? Math.round(deliveries.reduce((sum, d) => sum + d.lateMinutes, 0) / deliveries.length)
        : 0
    };

    res.json({
      period: 'custom',
      startDate: startDate,
      endDate: endDate,
      stats
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Create new driver
router.post('/', protect, admin, async (req, res) => {
  try {
    const {
      email, password, firstName, lastName, phone, status, colorCode, picture,
      licenseNumber, licenseExpiry, nationalId,
      assignedZone, shiftTiming,
      vehicleId, vehicleType, vehiclePaper, stopCapacity,
      baseSalary, contractType, joiningDate
    } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'User already exists with this email' });
    }

    const driver = new User({
      email,
      password,
      role: 'driver',
      profile: {
        firstName,
        lastName,
        phone,
        status: status ?? 'offline',
        colorCode: colorCode ?? '#000000',
        picture,
        licenseNumber,
        licenseExpiry,
        nationalId,
        assignedZone,
        shiftTiming,
        vehicleId,
        vehicleType,
        vehiclePaper,
        stopCapacity,
        baseSalary,
        contractType,
        joiningDate
      }
    });

    await driver.save();

    // Return driver without password
    const driverResponse = await User.findById(driver._id).select('-password');
    res.status(201).json(driverResponse);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Update driver
router.put('/:id', protect, admin, async (req, res) => {
  try {
    const { firstName, lastName, phone, status, email, colorCode, profile } = req.body;

    const driver = await User.findById(req.params.id);
    if (!driver || driver.role !== 'driver') {
      return res.status(404).json({ message: 'Driver not found' });
    }

    if (email) {
      driver.email = email;
    }

    if (!driver.profile) {
      driver.profile = {};
    }

    const directProfileUpdates = { firstName, lastName, phone, status, colorCode };
    Object.entries(directProfileUpdates).forEach(([field, value]) => {
      if (value !== undefined) {
        driver.profile[field] = value;
      }
    });

    if (profile && typeof profile === 'object') {
      Object.entries(profile).forEach(([field, value]) => {
        if (value !== undefined) {
          driver.profile[field] = value;
        }
      });
    }

    await driver.save();

    const updatedDriver = await User.findById(driver._id).select('-password');
    res.json(updatedDriver);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Disable/enable driver
router.patch('/:id/status', protect, admin, async (req, res) => {
  try {
    const { isActive } = req.body;

    const driver = await User.findById(req.params.id);
    if (!driver || driver.role !== 'driver') {
      return res.status(404).json({ message: 'Driver not found' });
    }

    driver.isActive = isActive;
    await driver.save();

    res.json({ message: `Driver ${isActive ? 'enabled' : 'disabled'} successfully` });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});


// Add this route to your existing driver routes
router.post('/returns',  async (req, res) => {
  try {
    const { bagId, reason, notes, location, driverId, driverName } = req.body;

    console.log('Bag return request:', req.body);

    // For now, just return success to test
    // Later you'll add database logic here
    res.status(200).json({
      message: 'Bag returned successfully',
      bagId: bagId,
      status: 'returned',
      timestamp: new Date().toISOString(),
      returnId: 'temp-' + Date.now()
    });

  } catch (error) {
    console.error('Return bag error:', error);
    res.status(500).json({ message: 'Server error during bag return' });
  }
});
// Helper functions

// score/avgLateTime/accuracyRate/updateRate now come from the month-to-date
// scorecard in services/driverKpiService.js (stored on driver.kpi) — see
// that file for the formula. Only complaintsCount (an all-time reputation
// count, not part of the monthly scorecard) is still computed here.

async function getComplaintsCount(driverId) {
  return await Delivery.countDocuments({
    driver: driverId,
    'complaint.hasComplaint': true
  });
}

// DEBUG endpoint - check deliveries with drivers
router.get('/debug/deliveries', protect, admin, async (req, res) => {
  try {
    const deliveries = await Delivery.find({})
      .select('_id customerId customerName driver scheduledTime status')
      .populate('driver', 'email profile.firstName profile.lastName')
      .limit(50)
      .sort({ scheduledTime: -1 })
      .lean();

    const stats = {
      total: deliveries.length,
      withDriver: deliveries.filter(d => d.driver).length,
      withoutDriver: deliveries.filter(d => !d.driver).length,
      deliveries: deliveries.map(d => ({
        id: d._id.toString(),
        customer: d.customerName,
        driverId: d.driver?._id?.toString() || null,
        driverName: d.driver ? `${d.driver.profile?.firstName || ''} ${d.driver.profile?.lastName || ''}`.trim() : 'No driver',
        scheduledTime: d.scheduledTime,
        status: d.status
      }))
    };

    res.json(stats);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

function normalizeDriverLocationPayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return null;

  const source = payload.coords || payload.location || payload;

  const rawLat = source.latitude ?? source.lat;
  const rawLng = source.longitude ?? source.lng;

  const latitude = rawLat !== undefined && rawLat !== null ? Number(rawLat) : null;
  const longitude = rawLng !== undefined && rawLng !== null ? Number(rawLng) : null;

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  return {
    latitude,
    longitude,
    accuracy: source.accuracy ?? source.precision ?? null,
    heading: source.heading ?? null,
    speed: source.speed ?? null,
    altitude: source.altitude ?? null,
    address: payload.address ?? source.address ?? payload.formattedAddress ?? null,
    lastUpdated: payload.timestamp
      ? new Date(payload.timestamp)
      : source.timestamp
        ? new Date(source.timestamp)
        : new Date()
  };
}

export default router;
