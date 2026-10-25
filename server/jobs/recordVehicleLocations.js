import truckoomApiService from '../services/truckoomApiService.js';
import User from '../models/User.js';
import VehicleLocationHistory from '../models/VehicleLocationHistory.js';

// Owner (2026-10-09): "I want to collect historical data... save the point
// the driver are doing" on Live Tracking. Truckoom's own API has no
// route-trail/playback endpoint (confirmed earlier this project), so this
// job builds one ourselves by sampling every tracked vehicle's current
// position once a minute and writing it to VehicleLocationHistory — runs
// always, in the background, independent of whether anyone has Live
// Tracking open (owner's choice). No automatic purge (owner chose "keep
// forever").
const RECORD_INTERVAL_MS = parseInt(process.env.VEHICLE_LOCATION_RECORD_INTERVAL_MS || '', 10) || 60 * 1000;

async function recordOnce() {
  if (!truckoomApiService.isConfigured()) return;

  try {
    const [fleet, drivers] = await Promise.all([
      truckoomApiService.getFleetStatus(),
      User.find({ role: 'driver', 'profile.truckoomVehicleNo': { $ne: null } })
        .select('profile.truckoomVehicleNo')
        .lean(),
    ]);

    const driverIdByVehicleNo = new Map(
      drivers.filter((d) => d.profile?.truckoomVehicleNo).map((d) => [d.profile.truckoomVehicleNo, d._id])
    );

    const recordedAt = new Date();
    const docs = fleet
      .filter((v) => Number.isFinite(v.latitude) && Number.isFinite(v.longitude))
      .map((v) => ({
        vehicleNo: v.vehicleNo,
        driver: driverIdByVehicleNo.get(v.vehicleNo) || null,
        latitude: v.latitude,
        longitude: v.longitude,
        recordedAt,
        gpsTime: v.gpsTime || null,
      }));

    if (docs.length > 0) {
      await VehicleLocationHistory.insertMany(docs);
    }
  } catch (error) {
    console.error('Vehicle location recording error:', error.message);
  }
}

export function startRecordVehicleLocationsJob(intervalMs = RECORD_INTERVAL_MS) {
  recordOnce();
  return setInterval(recordOnce, intervalMs);
}
