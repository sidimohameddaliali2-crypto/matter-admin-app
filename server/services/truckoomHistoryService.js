import { randomUUID } from 'node:crypto';
import TrackerSyncLease from '../models/TrackerSyncLease.js';
import TruckoomTrackHistory from '../models/TruckoomTrackHistory.js';
import truckoom from './truckoomApiService.js';
import { parseTruckoomAlertTime } from './truckoomVisitRules.js';

const UAE_OFFSET = 4 * 60 * 60000;
const REQUEST_INTERVAL = 3 * 60000;

export function parseTrackLogTime(value) {
  // Verified live: dd-MM-yyyy hh:mm:ss AM/PM, in UAE time, unlike UTC alerts.
  const match = String(value || '').match(/^(\d{2}-\d{2}-\d{4}) (\d{2}):(\d{2}):(\d{2}) (AM|PM)$/);
  if (!match) return null;
  const [, date, h, m, s, period] = match;
  if (+h < 1 || +h > 12) return null;
  const hour = (+h % 12) + (period === 'PM' ? 12 : 0);
  const wall = parseTruckoomAlertTime(`${date} ${String(hour).padStart(2, '0')}:${m}:${s}`);
  return wall ? new Date(+wall - UAE_OFFSET) : null;
}

export function normalizeTrackLogs(rows, vehicleNo, start, end) {
  if (!Array.isArray(rows)) throw new Error('Invalid Truckoom track history');
  const points = new Map();
  for (const row of rows) {
    const at = parseTrackLogTime(row.timestamp);
    const latitude = row.latitude == null || row.latitude === '' ? NaN : Number(row.latitude);
    const longitude = row.longitude == null || row.longitude === '' ? NaN : Number(row.longitude);
    if (String(row.vehicleNumber).trim() !== String(vehicleNo) || !at || +at < +start || +at >= +end
      || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90
      || Math.abs(longitude) > 180 || (latitude === 0 && longitude === 0)) continue;
    points.set(`${+at}:${latitude}:${longitude}`, { latitude, longitude, gpsTime: at });
  }
  return [...points.values()].sort((a, b) => a.gpsTime - b.gpsTime);
}

const uaeDate = date => new Date(+date + UAE_OFFSET).toISOString().slice(0, 19).replace('T', ' ');

export async function getHistoryPoints(vehicleNo, start, end, now = new Date()) {
  if (+start >= +now) return [];
  const key = `${vehicleNo}:${new Date(start).toISOString().slice(0, 10)}`;
  const cached = await TruckoomTrackHistory.findById(key).lean();
  // A partial snapshot must keep its short lifetime across midnight. Only a
  // request made after the day closed can qualify for the longer lifetime.
  const ttl = cached?.fetchedAt && +cached.fetchedAt >= +end ? 24 * 60 * 60000 : 60 * 60000;
  if (cached?.fetchedAt && +now - +cached.fetchedAt < ttl) return cached.points;
  const owner = randomUUID();
  // Retain this reservation even after failure. All PM2 workers share the
  // documented one track-log request per three minutes; never sleep in the job.
  const reservedAt = new Date(Date.now());
  try {
    const lease = await TrackerSyncLease.findOneAndUpdate({ _id: 'truckoom-track-logs',
      $or: [{ expiresAt: { $lte: reservedAt } }, { expiresAt: { $exists: false } }] },
    { $set: { owner, expiresAt: new Date(+reservedAt + REQUEST_INTERVAL) } }, { upsert: true, new: true });
    if (lease.owner !== owner) return cached?.points || [];
  } catch (error) {
    if (error.code === 11000) return cached?.points || [];
    throw error;
  }
  try {
    const rows = await truckoom.getVehicleTrackLogs(vehicleNo, uaeDate(start), uaeDate(new Date(Math.min(+end - 1000, +reservedAt))));
    const points = normalizeTrackLogs(rows, vehicleNo, start, end);
    await TruckoomTrackHistory.updateOne({ _id: key }, { $set: { fetchedAt: reservedAt, points } }, { upsert: true });
    return points;
  } catch {
    // A vendor failure must not erase the last usable GPS or block a delivery.
    return cached?.points || [];
  }
}

export default { getPoints: getHistoryPoints };
