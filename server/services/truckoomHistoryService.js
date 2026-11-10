import { randomUUID } from 'node:crypto';
import TrackerSyncLease from '../models/TrackerSyncLease.js';
import TruckoomTrackHistory from '../models/TruckoomTrackHistory.js';
import truckoom from './truckoomApiService.js';
import { parseTruckoomAlertTime } from './truckoomVisitRules.js';
import { gpsFixTime } from './trackerGpsVisits.js';

const UAE_OFFSET = 4 * 60 * 60000;
const REQUEST_INTERVAL = 3 * 60000;
const REQUEST_LOCK = 5 * 60000;

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
  const points = new Map(), qualityObservations = [];
  for (const row of rows) {
    if (String(row?.vehicleNumber).trim() !== String(vehicleNo)) continue;
    const at = parseTrackLogTime(row.timestamp);
    if (at && (+at < +start || +at >= +end)) continue;
    const latitude = row.latitude == null || String(row.latitude).trim() === '' ? NaN : Number(row.latitude);
    const longitude = row.longitude == null || String(row.longitude).trim() === '' ? NaN : Number(row.longitude);
    const validCoordinates = Number.isFinite(latitude) && Number.isFinite(longitude)
      && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 && !(latitude === 0 && longitude === 0);
    if (!at || !validCoordinates) {
      qualityObservations.push({ gpsTime: at, latitude: Number.isFinite(latitude) ? latitude : null,
        longitude: Number.isFinite(longitude) ? longitude : null,
        qualityFlags: [!at ? 'missing_fix_clock' : 'invalid_coordinates'] });
      continue;
    }
    points.set(`${+at}:${latitude}:${longitude}`, { latitude, longitude, gpsTime: at });
  }
  const valid = [...points.values()].sort((a, b) => a.gpsTime - b.gpsTime);
  Object.defineProperty(valid, 'qualityObservations', { value: qualityObservations });
  return valid;
}

const uaeDate = date => new Date(+date + UAE_OFFSET).toISOString().slice(0, 19).replace('T', ' ');

function withReceipt(points, receiptTime) {
  const receipt = gpsFixTime(receiptTime);
  return points.map(point => {
    const recordedAt = gpsFixTime(point.recordedAt) || receipt;
    if (recordedAt) return { ...point, recordedAt };
    // Legacy request start times are not response receipt times. Preserve the
    // original evidence, but do not promote it to a qualified timed comparison.
    if (!gpsFixTime(point.gpsTime)) return point;
    return { ...point, qualityFlags: [...new Set([...(point.qualityFlags || []), 'missing_observation_receipt'])] };
  });
}

export async function getHistoryPoints(vehicleNo, start, end, now = new Date()) {
  if (+start >= +now) return [];
  const key = `${vehicleNo}:${new Date(start).toISOString().slice(0, 10)}`;
  const cached = await TruckoomTrackHistory.findById(key).lean();
  // A partial snapshot must keep its short lifetime across midnight. Only a
  // request made after the day closed can qualify for the longer lifetime.
  const ttl = cached?.fetchedAt && +cached.fetchedAt >= +end ? 24 * 60 * 60000 : 60 * 60000;
  const cachedPoints = cached ? withReceipt([...(cached.points || []), ...(cached.qualityObservations || [])],
    cached.sourceReceipt?.responseReceivedAt || cached.responseReceivedAt) : [];
  const lastRefresh = cached?.lastRefreshAt || cached?.fetchedAt;
  if (lastRefresh && +now - +lastRefresh < ttl) return cachedPoints;
  const owner = randomUUID();
  // Hold a longer lock during authentication/transport, then retain a full
  // three-minute cooldown after completion, including failed attempts.
  const reservedAt = new Date(Date.now());
  try {
    const lease = await TrackerSyncLease.findOneAndUpdate({ _id: 'truckoom-track-logs',
      $or: [{ expiresAt: { $lte: reservedAt } }, { expiresAt: { $exists: false } }] },
    { $set: { owner, expiresAt: new Date(+reservedAt + REQUEST_LOCK) } }, { upsert: true, new: true });
    if (lease.owner !== owner) return cachedPoints;
  } catch (error) {
    if (error.code === 11000) return cachedPoints;
    throw error;
  }
  let dispatchedAt;
  try {
    const rows = await truckoom.getVehicleTrackLogs(vehicleNo, uaeDate(start), uaeDate(new Date(Math.min(+end - 1000, +reservedAt))), {
      // The API invokes this after authentication and immediately before POST.
      beforeDispatch: async body => {
        const renewedAt = Date.now();
        const expiresAt = new Date(renewedAt + REQUEST_LOCK);
        const result = await TrackerSyncLease.updateOne({ _id: 'truckoom-track-logs', owner,
          expiresAt: { $gt: new Date(renewedAt) } }, { $set: { expiresAt } });
        dispatchedAt = new Date(Date.now());
        // A slow DB operation or expired ownership must never permit a late
        // request with less than three minutes left on its reservation.
        if (!result.matchedCount || +expiresAt - +dispatchedAt < REQUEST_INTERVAL) {
          throw new Error('History request reservation expired');
        }
        // Match cache completeness to the actual requested window, including
        // authentication that crosses Dubai midnight.
        body.end_date = uaeDate(new Date(Math.min(+end - 1000, +dispatchedAt)));
      },
    });
    // Keep the original response clock across later cache reads. Measuring the
    // response here is safe for adapters without an archive receipt; request
    // dispatch time and the later evaluation clock are not substitutes.
    const responseReceivedAt = gpsFixTime(rows.sourceReceipt?.responseReceivedAt) || new Date(Date.now());
    const normalized = normalizeTrackLogs(rows, vehicleNo, start, end);
    const points = withReceipt(normalized, responseReceivedAt);
    if (!rows.length && cachedPoints.length) {
      // Keep prior observations while recording that the latest response was
      // empty. Refresh cadence uses this check time, not the old evidence clock.
      await TruckoomTrackHistory.updateOne({ _id: key }, { $set: {
        lastRefreshAt: dispatchedAt, lastRefreshOutcome: 'empty_preserved',
      } });
      return cachedPoints;
    }
    const qualityObservations = withReceipt(normalized.qualityObservations || [], responseReceivedAt);
    await TruckoomTrackHistory.updateOne({ _id: key }, { $set: { fetchedAt: dispatchedAt,
      lastRefreshAt: dispatchedAt, lastRefreshOutcome: qualityObservations.length ? 'quality_affected' : 'received',
      points, qualityObservations, responseReceivedAt, sourceReceipt: rows.sourceReceipt || null } }, { upsert: true });
    return [...points, ...qualityObservations];
  } catch {
    // A vendor failure must not erase the last usable GPS or block a delivery.
    return cachedPoints;
  } finally {
    try {
      await TrackerSyncLease.updateOne({ _id: 'truckoom-track-logs', owner },
        { $set: { expiresAt: new Date(Date.now() + REQUEST_INTERVAL) } });
    } catch {
      // Keep the longer dispatch reservation if the cooldown write fails.
    }
  }
}

export default { getPoints: getHistoryPoints };
