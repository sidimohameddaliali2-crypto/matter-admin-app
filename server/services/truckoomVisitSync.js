import { createHash, randomUUID } from 'node:crypto';
import Delivery from '../models/Delivery.js';
import CustomerGeofence from '../models/CustomerGeofence.js';
import TrackerSyncLease from '../models/TrackerSyncLease.js';
import VehicleLocationHistory from '../models/VehicleLocationHistory.js';
import { gpsVisitEvents } from './trackerGpsVisits.js';
import truckoom from './truckoomApiService.js';
import { resolveDeliveryCoordinatesCached } from './geocoding.js';
import { getBusinessDayBounds, toBusinessDateKey } from '../utils/businessDate.js';
import { archiveTrackerEvents, archivedTrackerEvents, removeExpiredCustomerGeofences } from './truckoomGeofenceLifecycle.js';
import { CUSTOMER_RADIUS_METRES, alertDateKeys, normalizeGeofenceAlerts, evaluateTrackerVisit } from './truckoomVisitRules.js';

const DAY = 86400000;
const LEASE_MS = 5 * 60 * 1000;

export function customerFenceIdentity(delivery, pin) {
  const businessDate = toBusinessDateKey(delivery.scheduledTime);
  const key = createHash('sha256').update(JSON.stringify([
    businessDate,
    delivery.customerId, delivery.addressId || String(delivery.address || '').trim(),
    pin.lat, pin.lng, CUSTOMER_RADIUS_METRES,
  ])).digest('hex');
  return { key, name: `MATTER-${businessDate.replaceAll('-', '')}-${key.slice(0, 24)}`, businessDate };
}

// Every cycle reads full UTC days again, allowing delayed/offline alerts and
// duplicate events to reconcile. We never infer an exit from elapsed time.
export async function syncCustomerTrackerVisits({ now = new Date(), io } = {}) {
  if (!truckoom.isConfigured()) return { disabled: true };
  const owner = randomUUID();
  try {
    const lease = await TrackerSyncLease.findOneAndUpdate({ _id: 'customer-visits',
      $or: [{ expiresAt: { $lte: now } }, { expiresAt: { $exists: false } }] },
    { $set: { owner, expiresAt: new Date(+now + LEASE_MS) } }, { upsert: true, new: true });
    if (lease.owner !== owner) return { busy: true };
  } catch (error) {
    if (error.code === 11000) return { busy: true };
    throw error;
  }
  const renew = async () => {
    const result = await TrackerSyncLease.updateOne({ _id: 'customer-visits', owner,
      expiresAt: { $gt: new Date() } }, { $set: { expiresAt: new Date(Date.now() + LEASE_MS) } });
    if (!result.matchedCount) throw new Error('Tracker visit sync lease expired');
  };
  try {
    const { startOfDay } = getBusinessDayBounds(now);
    const today = toBusinessDateKey(now);
    const deliveries = await Delivery.find({ type: 'Delivery', $or: [
      { scheduledTime: { $gte: new Date(+startOfDay - 7 * DAY), $lt: new Date(+startOfDay + 2 * DAY) } },
      { 'proof.receivedAt': { $gte: new Date(+now - 7 * DAY) } },
    ], $and: [{ $or: [
      { scheduledTime: { $gte: startOfDay } },
      { 'trackerVisit.checkedAt': { $lt: new Date(+now - 60 * 60 * 1000) } },
      { 'trackerVisit.checkedAt': { $exists: false } },
    ] }] }).populate('driver', 'profile.truckoomVehicleNo').lean();
    let remoteFences = null;
    let created = 0;
    let checked = 0;
    const alerts = new Map();
    const gpsPaths = new Map();
    const getDateAlerts = date => {
      if (!alerts.has(date)) alerts.set(date, (async () => {
        const events = normalizeGeofenceAlerts(await truckoom.getGeofenceAlerts(date));
        await archiveTrackerEvents(events);
        return events;
      })());
      return alerts.get(date);
    };
    for (const delivery of deliveries) {
      await renew();
      const previous = delivery.trackerVisit || {};
      let visit = { ...previous, checkedAt: now, needsReview: false };
      try {
        const pin = await resolveDeliveryCoordinatesCached(delivery);
        const driverId = String(delivery.driver?._id || '');
        const vehicleNo = delivery.proof?.receivedAt && previous.geofenceId
          ? previous.vehicleNo : delivery.driver?.profile?.truckoomVehicleNo;
        if (!pin && !(previous.geofenceId && delivery.proof?.receivedAt)) visit.status = 'missing_pin';
        else {
          // Freeze the pin and vehicle once proof is received. Before that,
          // reassignment/pin edits must follow the new destination and driver.
          let fenceId = previous.geofenceId;
          let deletedFence = false;
          if (fenceId && delivery.proof?.receivedAt) {
            const savedFence = await CustomerGeofence.findOne({ truckoomId: fenceId }).lean();
            deletedFence = Boolean(savedFence?.deletedAt);
            if (!visit.businessDate && savedFence?.businessDate) visit.businessDate = savedFence.businessDate;
          }
          if (!fenceId || !delivery.proof?.receivedAt) {
            const identity = customerFenceIdentity(delivery, pin);
            let fence = await CustomerGeofence.findOne({ key: identity.key }).lean();
            if (!fence?.truckoomId) {
              // Do not manufacture retrospective visit windows for old jobs.
              if (identity.businessDate !== today) {
                visit.status = 'awaiting_events';
                await saveVisit(delivery, visit, io);
                continue;
              }
              if (remoteFences === null) remoteFences = await truckoom.getGeofences();
              const remote = remoteFences.find(f => f['Geofence name'] === identity.name);
              let id = remote?.['Geofence Id'];
              if (!id) {
                if (created >= 100) continue; // bounded daily upload batches
                await renew();
                id = await truckoom.createCustomerGeofence(identity.name, pin);
                created++;
                remoteFences.push({ 'Geofence name': identity.name, 'Geofence Id': id });
              }
              fence = await CustomerGeofence.findOneAndUpdate({ key: identity.key }, { $set: {
                ...identity, customerId: delivery.customerId, ...pin,
                radiusMetres: CUSTOMER_RADIUS_METRES, truckoomId: String(id),
              } }, { upsert: true, new: true }).lean();
            }
            fenceId = fence.truckoomId;
            deletedFence = Boolean(fence.deletedAt);
            visit = { geofenceId: fenceId, geofenceName: fence.name, businessDate: fence.businessDate,
              vehicleNo: delivery.driver?.profile?.truckoomVehicleNo, driverId,
              lat: fence.lat, lng: fence.lng, radiusMetres: fence.radiusMetres,
              checkedAt: now, needsReview: false };
          }
          const anchor = visit.businessDate || delivery.scheduledTime;
          const { startOfDay: start, endOfDayExclusive: end } = getBusinessDayBounds(anchor);
          const events = await archivedTrackerEvents(visit.geofenceName, start, end);
          // Fetch the two UTC dates covering the whole Dubai calendar day.
          let alertsUnavailable = false;
          if (!deletedFence) for (const date of alertDateKeys(start, end)) {
            try { events.push(...await getDateAlerts(date)); }
            catch { alertsUnavailable = true; }
          }
          let matched = events.filter(e => e.vehicleNo === String(visit.vehicleNo) && e.name === visit.geofenceName);
          visit.evidenceSource = 'truckoom_alerts';
          visit.gpsSampleCount = 0;
          if (!matched.length && visit.vehicleNo) {
            const pathKey = `${visit.vehicleNo}:${+start}`;
            if (!gpsPaths.has(pathKey)) gpsPaths.set(pathKey, VehicleLocationHistory.find({
              vehicleNo: visit.vehicleNo, recordedAt: { $gte: start, $lt: end },
            }).select('latitude longitude gpsTime recordedAt driver').lean());
            const path = (await gpsPaths.get(pathKey)).filter(p => String(p.driver || '') === String(visit.driverId || driverId)
              && +(new Date(p.gpsTime || p.recordedAt)) >= +start && +(new Date(p.gpsTime || p.recordedAt)) < +end);
            matched = gpsVisitEvents(path, { lat: visit.lat, lng: visit.lng }, visit.radiusMetres || CUSTOMER_RADIUS_METRES);
            if (path.length) { visit.evidenceSource = 'truckoom_gps_samples'; visit.gpsSampleCount = path.length; }
          }
          visit = { ...visit, ...evaluateTrackerVisit({
            events: matched,
            photoCapturedAt: delivery.proof?.photoCapturedAt, photoSource: delivery.proof?.photoSource,
            start, end,
          }) };
          if (visit.evidenceSource === 'truckoom_gps_samples') {
            if (visit.status === 'inside_window') visit.status = 'gps_visit_observed';
            if (visit.status === 'outside_window') visit.status = 'gps_window_review';
          } else if (alertsUnavailable && !matched.length && vehicleNo) visit.status = 'tracker_error';
          if (!vehicleNo) visit.status = 'no_tracker';
        }
      } catch {
        // Axios errors may contain credential-bearing query strings. Never log
        // their config/URL or turn an outage into a driver violation.
        visit.status = 'tracker_error';
        visit.needsReview = false;
        remoteFences = null; // reconcile an ambiguous remote create before retry
      }
      await saveVisit(delivery, visit, io);
      checked++;
    }
    const deleted = await removeExpiredCustomerGeofences({ now, getDateAlerts, renew });
    return { checked, created, deleted };
  } finally {
    await TrackerSyncLease.deleteOne({ _id: 'customer-visits', owner });
  }
}

async function saveVisit(delivery, visit, io) {
  // If proof, pin, or assignment changed during the external calls, retry next
  // cycle instead of attaching a verdict based on an obsolete snapshot.
  const filter = { _id: delivery._id, updatedAt: delivery.updatedAt };
  const result = await Delivery.updateOne(filter, { $set: { trackerVisit: visit } });
  // A tracker refresh must not trigger the normal "delivery completed" toasts.
  if (result.modifiedCount && io) io.emit('delivery:trackerVisit', { _id: delivery._id, trackerVisit: visit });
}
