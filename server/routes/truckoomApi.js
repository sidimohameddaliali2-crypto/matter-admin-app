import express from 'express';
import User from '../models/User.js';
import truckoomApiService from '../services/truckoomApiService.js';
import VehicleLocationHistory from '../models/VehicleLocationHistory.js';
import { protect, checkPermission } from '../middleware/auth.js';
import { addressForDriver } from '../services/reverseGeocode.js';
import { mapWithLimit } from '../utils/concurrency.js';
import { isPlausibleCoordinate } from '../services/geocoding.js';

// Live vehicle GPS (owner, 2026-09-24) — gated by the existing "live_map"
// permission (already on for admin/manager/dispatcher by default, see
// client/src/constants/permissions.js) rather than a new permission key.
const router = express.Router();
router.use(protect, checkPermission('live_map'));

function nameOf(driver) {
  const parts = [driver.profile?.firstName, driver.profile?.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : driver.email || 'Driver';
}

// A phone position older than this is still returned (as "last seen"), but
// flagged `stale` so the map can dim it instead of passing it off as live.
const APP_LOCATION_STALE_MS = 12 * 60 * 60 * 1000;

// The driver app's own reported position (User.location) with its street
// address (the app sends coordinates only — see services/reverseGeocode.js).
async function appLocationOf(driver) {
  if (driver.location?.latitude == null || driver.location?.longitude == null) return null;
  const latitude = Number(driver.location?.latitude);
  const longitude = Number(driver.location?.longitude);
  if (!isPlausibleCoordinate(latitude, longitude)) return null;
  const lastUpdated = driver.location?.lastUpdated || null;
  const address = driver.location?.address || (await addressForDriver(driver._id, latitude, longitude)) || null;
  return {
    latitude,
    longitude,
    lastUpdated,
    address,
    stale: !lastUpdated || Date.now() - new Date(lastUpdated).getTime() > APP_LOCATION_STALE_MS,
  };
}

// @desc    Every tracked vehicle, its live GPS location and street address, and
//          the driver it's mapped to (if any) with that driver's own phone
//          position + address — so Live Tracking can show two pins per driver
//          (tracker and app). `appOnlyDrivers` are active drivers with a phone
//          position but no tracker on the map: one pin (the app's).
//          Used by Live Tracking and the Driver Routes "vehicle GPS" overlay.
// @route   GET /api/truckoom/vehicles
router.get('/vehicles', async (req, res) => {
  try {
    const [trackerResult, drivers] = await Promise.all([
      truckoomApiService.getFleetStatus()
        .then((fleet) => ({ fleet, warning: null }))
        .catch((error) => {
          console.warn('Truckoom unavailable; returning phone locations:', error.message);
          return { fleet: [], warning: 'Tracker locations are unavailable. Showing driver phone locations.' };
        }),
      User.find({ role: 'driver', $or: [{ 'profile.truckoomVehicleNo': { $ne: null } }, { isActive: true }] })
        .select('profile.firstName profile.lastName profile.truckoomVehicleNo profile.colorCode email location')
        .lean(),
    ]);
    const { fleet, warning: trackerWarning } = trackerResult;

    const driverByVehicleNo = new Map(
      drivers.filter((d) => d.profile?.truckoomVehicleNo).map((d) => [d.profile.truckoomVehicleNo, d])
    );

    const appLocations = new Map();
    await mapWithLimit(drivers, 5, async (d) => { appLocations.set(String(d._id), await appLocationOf(d)); });

    const vehicles = await mapWithLimit(fleet, 5, async (v) => {
      const driver = driverByVehicleNo.get(v.vehicleNo);
      const hasFix = Number.isFinite(v.latitude) && Number.isFinite(v.longitude);
      return {
        ...v,
        address: hasFix ? (await addressForDriver(`vehicle:${v.vehicleNo}`, v.latitude, v.longitude)) || null : null,
        driver: driver
          ? {
              id: String(driver._id),
              name: nameOf(driver),
              colorCode: driver.profile?.colorCode || null,
              appLocation: appLocations.get(String(driver._id)) || null,
            }
          : null,
      };
    });

    const onMapWithTracker = new Set(vehicles.filter((v) => v.driver).map((v) => v.driver.id));
    const appOnlyDrivers = drivers
      .filter((d) => !onMapWithTracker.has(String(d._id)) && appLocations.get(String(d._id)))
      .map((d) => ({
        id: String(d._id),
        name: nameOf(d),
        colorCode: d.profile?.colorCode || null,
        appLocation: appLocations.get(String(d._id)),
      }));

    res.json({ success: true, data: vehicles, appOnlyDrivers, trackerWarning, fetchedAt: new Date().toISOString() });
  } catch (error) {
    console.error('Truckoom vehicles error:', error.message);
    res.status(502).json({ success: false, message: error.message || 'Failed to fetch vehicle data' });
  }
});

// @desc    Assign (or clear) which driver a tracked vehicle belongs to —
//          lets a dispatcher reassign a tracker directly from Live Tracking
//          instead of going through the driver's own profile edit form.
//          Clears the mapping from whichever driver currently holds this
//          vehicleNo first, so a vehicle never ends up pointing at two
//          drivers at once.
// @route   PUT /api/truckoom/vehicles/:vehicleNo/driver
// @body    { driverId: string | null }
router.put('/vehicles/:vehicleNo/driver', async (req, res) => {
  try {
    const { vehicleNo } = req.params;
    const { driverId } = req.body || {};

    if (driverId && !driverId.match(/^[a-f\d]{24}$/i)) {
      return res.status(400).json({ success: false, message: 'Invalid driverId' });
    }

    await User.updateMany(
      {
        role: 'driver',
        'profile.truckoomVehicleNo': vehicleNo,
        ...(driverId ? { _id: { $ne: driverId } } : {}),
      },
      { $set: { 'profile.truckoomVehicleNo': null } }
    );

    if (driverId) {
      const driver = await User.findOneAndUpdate(
        { _id: driverId, role: 'driver' },
        { $set: { 'profile.truckoomVehicleNo': vehicleNo } },
        { new: true }
      ).select('profile.firstName profile.lastName profile.colorCode email');
      if (!driver) {
        return res.status(404).json({ success: false, message: 'Driver not found' });
      }
      return res.json({ success: true, data: { driver: { id: String(driver._id), name: nameOf(driver), colorCode: driver.profile?.colorCode || null } } });
    }

    res.json({ success: true, data: { driver: null } });
  } catch (error) {
    console.error('Truckoom vehicle driver assignment error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to update vehicle driver assignment' });
  }
});

// @desc    Recorded GPS trail for a vehicle or driver over a time range —
//          the history jobs/recordVehicleLocations.js builds every minute,
//          since Truckoom's own API has no route-trail/playback endpoint.
// @route   GET /api/truckoom/history?vehicleNo=...&driverId=...&from=...&to=...
router.get('/history', async (req, res) => {
  try {
    const { vehicleNo, driverId, from, to } = req.query;
    if (!vehicleNo && !driverId) {
      return res.status(400).json({ success: false, message: 'vehicleNo or driverId is required' });
    }

    const query = {};
    if (vehicleNo) query.vehicleNo = vehicleNo;
    if (driverId) query.driver = driverId;
    if (from || to) {
      query.recordedAt = {};
      if (from) query.recordedAt.$gte = new Date(from);
      if (to) query.recordedAt.$lte = new Date(to);
    }

    const points = await VehicleLocationHistory.find(query)
      .sort({ recordedAt: 1 })
      .limit(10000)
      .select('vehicleNo driver latitude longitude recordedAt')
      .lean();

    res.json({ success: true, data: points });
  } catch (error) {
    console.error('Truckoom history error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch vehicle location history' });
  }
});

export default router;
