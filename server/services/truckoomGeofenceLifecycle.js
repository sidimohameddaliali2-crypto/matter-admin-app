import { createHash } from 'node:crypto';
import CustomerGeofence from '../models/CustomerGeofence.js';
import TrackerGeofenceEvent from '../models/TrackerGeofenceEvent.js';
import truckoom from './truckoomApiService.js';
import { getBusinessDayBounds, isDateKey, toBusinessDateKey } from '../utils/businessDate.js';
import { alertDateKeys } from './truckoomVisitRules.js';

export async function archiveTrackerEvents(events) {
  const managed = events.filter(e => /^MATTER-(?:\d{8}-)?[a-f0-9]{24}$/.test(e.name));
  if (!managed.length) return;
  await TrackerGeofenceEvent.bulkWrite(managed.map(event => {
    const _id = createHash('sha256').update(JSON.stringify([event.name, event.vehicleNo, event.flag, +event.at])).digest('hex');
    return { updateOne: { filter: { _id }, update: { $setOnInsert: event }, upsert: true } };
  }), { ordered: false });
}

export async function archivedTrackerEvents(name, start, end) {
  return TrackerGeofenceEvent.find({ name, at: { $gte: start, $lt: end } }).lean();
}

// Run under the same Mongo lease as creation. Archive BOTH UTC dates covering
// each closed Dubai day before removing a fence. Failed reads/writes/deletes
// leave it eligible for retry. No delivery, photo, or archive is ever deleted.
export async function removeExpiredCustomerGeofences({ now, getDateAlerts, renew }) {
  const today = toBusinessDateKey(now);
  const { startOfDay } = getBusinessDayBounds(now);
  // Allow late tracker packets at the day boundary. New-day creation starts
  // immediately; yesterday's removal starts 15 minutes after Dubai midnight.
  if (+now < +startOfDay + 15 * 60000) return 0;
  const fences = await CustomerGeofence.find({ businessDate: { $lt: today },
    deletedAt: { $exists: false }, truckoomId: { $exists: true } }).sort({ businessDate: 1 }).limit(100).lean();
  let deleted = 0;
  let remoteFences;
  for (const fence of fences) {
    // Only daily fences registered by this app; never touch kitchen/manual
    // geofences or infer ownership from a broad name-prefix search.
    if (!isDateKey(fence.businessDate) || fence.businessDate >= today || typeof fence.key !== 'string'
      || fence.name !== `MATTER-${fence.businessDate.replaceAll('-', '')}-${fence.key.slice(0, 24)}`) continue;
    await renew(); // stop the cycle immediately if another worker owns the lease
    try {
      const { startOfDay: start, endOfDayExclusive: end } = getBusinessDayBounds(fence.businessDate);
      for (const date of alertDateKeys(start, end)) await getDateAlerts(date);
      // The company-scoped list makes deletion idempotent after a crash between
      // remote deletion and updating our local record.
      if (!remoteFences) remoteFences = await truckoom.getGeofences();
      const remote = remoteFences.find(f => String(f['Geofence Id']) === String(fence.truckoomId));
      if (remote) {
        if (remote['Geofence name'] !== fence.name) continue;
        await truckoom.deleteCustomerGeofence(fence.truckoomId);
      }
      await CustomerGeofence.updateOne({ _id: fence._id, truckoomId: fence.truckoomId },
        { $set: { deletedAt: now } });
      deleted++;
    } catch {
      // Keep the fence until the evidence can be archived successfully.
      remoteFences = null;
    }
  }
  return deleted;
}
