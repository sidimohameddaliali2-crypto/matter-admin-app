import express from 'express';
import User from '../models/User.js';
import truckoomApiService from '../services/truckoomApiService.js';
import { apiKeyAuth } from '../middleware/apiKeyAuth.js';
import VehicleLocationHistory from '../models/VehicleLocationHistory.js';
import { getBusinessDayBounds, isDateKey, resolveBusinessDateRange } from '../utils/businessDate.js';

// Read-only driver-location API for the same external/third-party consumers
// as externalDeliveryApi.js — owner, 2026-10-08: "someone from my api can
// access the tracker api and have the location of the driver." Reuses the
// same static API-key auth (DELIVERY_API_KEYS) rather than a separate key,
// and the same fleet/driver join routes/truckoomApi.js already does for the
// in-app Live Tracking page (Truckoom "Trace" vehicle GPS, joined against
// User.profile.truckoomVehicleNo) — just exposed under /api/external instead
// of behind staff JWT + the live_map permission.

const router = express.Router();

router.use(apiKeyAuth);

function nameOf(driver) {
  const parts = [driver.profile?.firstName, driver.profile?.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : driver.email || 'Driver';
}

// Owner (2026-11-02): expose the GPS trail already collected by our server.
// No vendor calls, driver remapping or inferred points on this read-only API.
router.get('/locations/history', async (req, res) => {
  const fail = message => res.status(400).json({ success: false, message });
  const { vehicleNo, driverId, date, dateFrom, dateTo, page = '1', limit = '500' } = req.query;
  for (const value of [vehicleNo, driverId, date, dateFrom, dateTo, page, limit]) {
    if (value !== undefined && typeof value !== 'string') return fail('Query parameters must be single string values');
  }
  if (!vehicleNo?.trim() && !driverId) return fail('vehicleNo or driverId is required');
  if (vehicleNo !== undefined && (!vehicleNo.trim() || vehicleNo.trim().length > 80)) return fail('Invalid vehicleNo');
  if (driverId !== undefined && !/^[a-f\d]{24}$/i.test(driverId)) return fail('Invalid driverId');
  if (!/^[1-9]\d*$/.test(page) || Number(page) > 10000) return fail('page must be between 1 and 10000');
  if (!/^[1-9]\d*$/.test(limit) || Number(limit) > 1000) return fail('limit must be between 1 and 1000');
  let range;
  if (date !== undefined) {
    if (dateFrom !== undefined || dateTo !== undefined) return fail('Use date or dateFrom/dateTo, not both');
    if (!isDateKey(date)) return fail('date must be a valid YYYY-MM-DD');
    const bounds = getBusinessDayBounds(date);
    range = { start: bounds.startOfDay, endExclusive: bounds.endOfDayExclusive };
  } else {
    const validBoundary = value => typeof value === 'string' && (isDateKey(value)
      || (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
        && isDateKey(value.slice(0, 10)) && Number.isFinite(Date.parse(value))));
    if (!validBoundary(dateFrom) || !validBoundary(dateTo)) return fail('Provide date or both dateFrom/dateTo with valid dates or ISO timestamps with a timezone');
    range = resolveBusinessDateRange(dateFrom, dateTo);
  }
  if (!range || range.endExclusive <= range.start || range.endExclusive - range.start > 7 * 86400000) {
    return fail('The date range must be ordered and no longer than 7 days');
  }
  const filter = { recordedAt: { $gte: range.start, $lt: range.endExclusive } };
  if (vehicleNo) filter.vehicleNo = vehicleNo.trim();
  if (driverId) filter.driver = driverId;
  try {
    const [rows, total] = await Promise.all([
      VehicleLocationHistory.find(filter).sort({ recordedAt: 1, _id: 1 })
        .skip((Number(page) - 1) * Number(limit)).limit(Number(limit))
        .select('_id vehicleNo driver latitude longitude gpsTime recordedAt').lean(),
      VehicleLocationHistory.countDocuments(filter),
    ]);
    const data = rows.map(point => ({
      id: String(point._id), vehicleNo: point.vehicleNo,
      driverId: point.driver ? String(point.driver) : null,
      location: Number.isFinite(point.latitude) && Number.isFinite(point.longitude)
        && Math.abs(point.latitude) <= 90 && Math.abs(point.longitude) <= 180
        && !(point.latitude === 0 && point.longitude === 0)
        ? { lat: point.latitude, lng: point.longitude } : null,
      gpsTime: point.gpsTime || null, recordedAt: point.recordedAt,
      source: 'server_recorded_gps',
    }));
    res.json({ success: true, data,
      range: { from: range.start, toExclusive: range.endExclusive, filteredBy: 'recordedAt' },
      pagination: { page: Number(page), limit: Number(limit), total, pages: Math.ceil(total / Number(limit)) },
    });
  } catch {
    res.status(500).json({ success: false, message: 'Failed to fetch recorded GPS history' });
  }
});

// @desc    Every tracked vehicle's live GPS location, with the driver it's
//          mapped to (if any). Vehicles with no current fix have lat/lng null
//          rather than being dropped, so a consumer can tell "no driver
//          assigned" apart from "assigned but not reporting a location."
// @route   GET /api/external/drivers/locations
router.get('/locations', async (req, res) => {
  try {
    const [fleet, drivers] = await Promise.all([
      truckoomApiService.getFleetStatus(),
      User.find({ role: 'driver', 'profile.truckoomVehicleNo': { $ne: null } })
        .select('profile.firstName profile.lastName profile.truckoomVehicleNo profile.phone email')
        .lean(),
    ]);

    const driverByVehicleNo = new Map(
      drivers.filter((d) => d.profile?.truckoomVehicleNo).map((d) => [d.profile.truckoomVehicleNo, d])
    );

    const data = fleet.map((v) => {
      const driver = driverByVehicleNo.get(v.vehicleNo);
      return {
        vehicleNo: v.vehicleNo,
        vehicleType: v.vehicleType,
        location: Number.isFinite(v.latitude) && Number.isFinite(v.longitude)
          ? { lat: v.latitude, lng: v.longitude }
          : null,
        driver: driver
          ? {
              id: String(driver._id),
              name: nameOf(driver),
              phone: driver.profile?.phone || null,
              email: driver.email || null,
            }
          : null,
      };
    });

    res.json({ success: true, data, fetchedAt: new Date().toISOString() });
  } catch (error) {
    console.error('External driver-location API error:', error.message);
    res.status(502).json({ success: false, message: error.message || 'Failed to fetch driver location data' });
  }
});

export default router;
