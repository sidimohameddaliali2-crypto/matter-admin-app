import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import TruckoomLiveSnapshot from '../models/TruckoomLiveSnapshot.js';
import { parseTruckoomAlertTime } from './truckoomVisitRules.js';

const INTERVAL = 60000;
const withReceipt = (storedVehicles, receipt, status) => {
  const vehicles = [...storedVehicles];
  if (status) Object.defineProperty(vehicles, 'captureEvidenceStatus', { value: status, configurable: true });
  if (receipt) Object.defineProperty(vehicles, 'sourceReceipt', { value: receipt, configurable: true });
  return vehicles;
};

export function parseTruckoomGpsTime(value) {
  // Same dd-MM-yyyy format as alerts, but GPS values are UAE wall-clock time.
  const wallClock = parseTruckoomAlertTime(value);
  return wallClock ? new Date(+wallClock - 4 * 60 * 60000).toISOString() : null;
}

function number(value) {
  if (value == null || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeTruckoomLiveData(payload, companyName) {
  const rows = payload?.root?.VehicleData;
  if (!Array.isArray(rows)) throw new Error('Truckoom live data unavailable or rate limited');
  return rows.filter(row => row?.Company === companyName).map((row, sourceRow) => {
    const latitude = number(row.Latitude);
    const longitude = number(row.Longitude);
    const fix = latitude != null && longitude != null && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
      && !(latitude === 0 && longitude === 0);
    return {
      vehicleNo: String(row.Vehicle_No || '').trim(), imei: row.Imeino || null,
      deviceName: row.Vehicle_Name || null, vehicleType: row.Vehicletype || null,
      latitude: fix ? latitude : null, longitude: fix ? longitude : null,
      rawCoordinates: { latitude, longitude }, sourceRow,
      gpsTime: parseTruckoomGpsTime(row.GPSActualTime),
      rawGpsTime: typeof row.GPSActualTime === 'string' ? row.GPSActualTime : null,
      rawTrackerServerTime: typeof row.Datetime === 'string' ? row.Datetime : null,
      trackerServerTime: parseTruckoomGpsTime(row.Datetime),
      speedKph: number(row.Speed), ignition: ['ON', 'OFF'].includes(row.IGN) ? row.IGN : null,
      trackerStatus: row.Status || null, address: row.Location && row.Location !== '--' ? row.Location : null,
      locationSource: 'truckoom_live_data',
    };
  }).filter(row => row.vehicleNo);
}

// Constructed once per Truckoom service. Single-flight and local throttling
// also protect standalone scripts without a Mongo connection.
export function createTruckoomLiveCache({ store = TruckoomLiveSnapshot,
  sharedAvailable = () => mongoose.connection.readyState === 1, clock = Date.now } = {}) {
  let cached = null;
  let fetchedAt = 0;
  let nextRequestAt = 0;
  let pending = null;
  const recent = snapshot => snapshot?.vehicles?.length >= 0 && snapshot?.fetchedAt
    && clock() - +new Date(snapshot.fetchedAt) < INTERVAL;
  return async fetchLive => {
    if (cached && clock() - fetchedAt < INTERVAL) return cached;
    if (pending) return pending;
    pending = (async () => {
      const now = clock();
      const shared = sharedAvailable();
      const requestId = randomUUID();
      if (shared) {
        const snapshot = await store.findById('fleet').lean();
        if (recent(snapshot)) {
          cached = withReceipt(snapshot.vehicles, snapshot.sourceReceipt, snapshot.captureEvidenceStatus); fetchedAt = +new Date(snapshot.fetchedAt);
          return cached;
        }
        try {
          await store.findOneAndUpdate({ _id: 'fleet', $or: [
            { nextRequestAt: { $lte: new Date(now) } }, { nextRequestAt: { $exists: false } },
          ] }, { $set: { requestId, nextRequestAt: new Date(now + 2 * INTERVAL) } }, { upsert: true, new: true });
        } catch (error) {
          if (error.code !== 11000) throw error;
          const latest = await store.findById('fleet').lean();
          if (!recent(latest)) throw new Error('Truckoom live refresh already in progress; retry shortly');
          cached = withReceipt(latest.vehicles, latest.sourceReceipt, latest.captureEvidenceStatus); fetchedAt = +new Date(latest.fetchedAt);
          return cached;
        }
      } else if (now < nextRequestAt) {
        throw new Error('Truckoom live refresh cooling down; retry shortly');
      }
      nextRequestAt = now + 2 * INTERVAL;
      try {
        const beforeDispatch = async () => {
          const checkedAt = clock();
          if (checkedAt >= nextRequestAt) throw new Error('Truckoom live reservation expired');
          const expiresAt = checkedAt + 2 * INTERVAL;
          if (shared) {
            const renewed = await store.updateOne({ _id: 'fleet', requestId,
              nextRequestAt: { $gt: new Date(checkedAt) } }, { $set: { nextRequestAt: new Date(expiresAt) } });
            if (!renewed?.matchedCount || expiresAt - clock() < INTERVAL) throw new Error('Truckoom live reservation expired');
          }
          nextRequestAt = expiresAt;
        };
        await beforeDispatch();
        const vehicles = await fetchLive(beforeDispatch);
        const completedAt = clock();
        // Count the cooldown after completion. Starting it before token/network
        // latency can put consecutive upstream calls less than 60 seconds apart.
        nextRequestAt = completedAt + INTERVAL;
        if (shared) {
          const published = await store.updateOne({ _id: 'fleet', requestId }, { $set: {
            vehicles, sourceReceipt: vehicles.sourceReceipt || null, captureEvidenceStatus: vehicles.captureEvidenceStatus || 'unverified_cache', fetchedAt: new Date(completedAt), nextRequestAt: new Date(nextRequestAt),
          } });
          if (!published?.matchedCount) throw new Error('Truckoom live ownership changed');
        }
        cached = vehicles; fetchedAt = completedAt;
        return vehicles;
      } catch (error) {
        nextRequestAt = clock() + INTERVAL;
        if (shared) {
          try { await store.updateOne({ _id: 'fleet', requestId }, { $set: { nextRequestAt: new Date(nextRequestAt) } }); }
          catch { /* The original claim still prevents an immediate retry storm. */ }
        }
        throw error;
      }
    })();
    try { return await pending; } finally { pending = null; }
  };
}
