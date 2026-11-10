import truckoomApiService from '../services/truckoomApiService.js';
import User from '../models/User.js';
import { createVehicleLocationRecorder } from '../services/vehicleLocationCapture.js';
import { createVehicleLocationCaptureStore } from '../services/vehicleLocationCaptureStore.js';

// A tick records a last-known fleet observation, not every vendor GPS fix.
// Raw responses and immutable pending batches make capture/retry inspectable.
const configuredInterval = Number.parseInt(process.env.VEHICLE_LOCATION_RECORD_INTERVAL_MS || '', 10);
const RECORD_INTERVAL_MS = Number.isSafeInteger(configuredInterval) && configuredInterval >= 60000 ? configuredInterval : 60000;

export function startRecordVehicleLocationsJob(intervalMs = RECORD_INTERVAL_MS) {
  const recordOnce = createVehicleLocationRecorder({
    isConfigured: () => truckoomApiService.isConfigured(), intervalMs,
    getFleet: () => truckoomApiService.getFleetStatus(),
    getDrivers: () => User.find({ role: 'driver', 'profile.truckoomVehicleNo': { $ne: null } }).select('profile.truckoomVehicleNo').lean(),
    store: createVehicleLocationCaptureStore(),
    // Log bounded aggregate outcomes only; raw identities/positions remain private.
    onResult: result => console.info('Vehicle location capture', JSON.stringify({
      status: result.status, fleetRows: result.fleetRows, storedRows: result.storedRows,
      rejectedRows: result.rejectedRows, missingFixClock: result.missingFixClock,
      mappingAvailable: result.mappingAvailable,
    })),
    onError: error => console.error('Vehicle location recording error', /^[A-Z0-9_]{1,64}$/.test(error.code || '') ? error.code : 'CAPTURE_FAILED'),
  });
  recordOnce();
  return setInterval(recordOnce, intervalMs);
}
