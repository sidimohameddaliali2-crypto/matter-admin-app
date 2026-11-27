import { createHash, randomUUID } from 'node:crypto';
import Delivery from '../models/Delivery.js';
import CustomerGeofence from '../models/CustomerGeofence.js';
import TrackerSyncLease from '../models/TrackerSyncLease.js';
import VehicleLocationHistory from '../models/VehicleLocationHistory.js';
import { evaluateGpsVisit, gpsFixTime, GPS_VISIT_METHOD } from './trackerGpsVisits.js';
import truckoomHistory from './truckoomHistoryService.js';
import truckoom from './truckoomApiService.js';
import { resolveDeliveryCoordinatesCached } from './geocoding.js';
import { getBusinessDayBounds, toBusinessDateKey } from '../utils/businessDate.js';
import { archiveTrackerEvents, archivedTrackerEvents, removeExpiredCustomerGeofences } from './truckoomGeofenceLifecycle.js';
import { CUSTOMER_RADIUS_METRES, alertDateKeys, parseTruckoomAlertTime, evaluateTrackerVisit } from './truckoomVisitRules.js';
import { normalizeAlertData } from './truckoomAlertData.js';
import { fleetRoster, isFleetSourceId } from './fleetDispatch.js';
import { firstFleetReceiptTime, readFleetTrackerBinding } from './fleetDispatchStore.js';
import { fleetProofForReporting } from './fleetProofReceipt.js';

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
    const roster = fleetRoster();
    const deliveryQuery = Delivery.find({ type: 'Delivery', $or: [
      { scheduledTime: { $gte: new Date(+startOfDay - 7 * DAY), $lt: new Date(+startOfDay + 2 * DAY) } },
      { 'proof.receivedAt': { $gte: new Date(+now - 7 * DAY) } },
    ], $and: [{ $or: [
      { scheduledTime: { $gte: startOfDay } },
      { 'trackerVisit.checkedAt': { $lt: new Date(+now - 60 * 60 * 1000) } },
      { 'trackerVisit.checkedAt': { $exists: false } },
    ] }] });
    if (roster) deliveryQuery.select('+fleetProofReceipt +trackerVisitGpsBaseline.beforeFleet');
    const deliveries = await deliveryQuery.populate('driver', 'profile.truckoomVehicleNo').lean();
    let remoteFences = null;
    let created = 0;
    let checked = 0;
    const alerts = new Map();
    const gpsPaths = new Map();
    const historicalPaths = new Map();
    const pilotStartByDriver = new Map();
    const getDateAlerts = date => {
      if (!alerts.has(date)) alerts.set(date, (async () => {
        // Retain UTC-day archive keys while requesting epoch-millisecond windows.
        // The new endpoint returns Dubai wall-clock timestamps, normalized to UTC.
        const start = parseTruckoomAlertTime(`${date} 00:00:00`);
        const end = new Date(Math.min(+start + DAY, +now));
        if (end <= start) return [];
        const rows = await truckoom.getAlertData(+start, +end - 1);
        const events = normalizeAlertData(rows, { companyName: truckoom.companyName, start, end });
        try { await archiveTrackerEvents(events); }
        catch { throw Object.assign(new Error('Tracker alert archive write failed'), { code: 'ARCHIVE_WRITE_FAILED' }); }
        return events;
      })());
      return alerts.get(date);
    };
    for (const delivery of deliveries) {
      await renew();
      const previous = delivery.trackerVisit || {};
      let visit = { ...previous, checkedAt: now, needsReview: false, errorStage: null, errorCode: null,
        gpsMethod: null, gpsQualityReasons: [] };
      const driverId = String(delivery.driver?._id || '');
      const proof = delivery.proof;
      const pilotDriver = delivery.fleetProofReceipt?.actorId || driverId || previous.driverId;
      const receivedAt = gpsFixTime(proof?.receivedAt);
      let managedProof = false;
      let stage = 'resolve_pin';
      try {
        let vehicleNo = proof?.receivedAt && previous.geofenceId ? previous.vehicleNo : delivery.driver?.profile?.truckoomVehicleNo;
        let binding;
        if (roster && isFleetSourceId(pilotDriver) && receivedAt) {
          stage = 'fleet_assignment';
          if (!pilotStartByDriver.has(pilotDriver)) {
            pilotStartByDriver.set(pilotDriver, await firstFleetReceiptTime(pilotDriver));
          }
          const pilotStart = pilotStartByDriver.get(pilotDriver);
          managedProof = pilotStart !== null && receivedAt >= pilotStart;
          if (managedProof && receivedAt > now) continue;
        }
        if (managedProof) {
          // An open visit may still name the vehicle from before a handover.
          // Keep the frozen destination but qualify the vehicle independently.
          visit = { ...visit, vehicleNo: null, driverId, status: 'assignment_unverified',
            arrivedAt: null, departedAt: null, photoCapturedAt: null, visitCount: 0, evidenceSource: null, gpsSampleCount: 0 };
          stage = 'fleet_assignment';
          const receipt = fleetProofForReporting(delivery.fleetProofReceipt, proof);
          const capturedAt = gpsFixTime(proof?.photoCapturedAt);
          if (receipt?.completionDriverId === driverId && capturedAt && capturedAt <= receivedAt) {
            binding = await readFleetTrackerBinding(driverId, capturedAt, receivedAt);
          }
          if (!binding || binding.trackerAlias === null) {
            if (binding) visit.status = 'no_tracker';
            await saveVisit(delivery, visit, io, true);
            checked++;
            continue;
          }
          vehicleNo = binding.trackerAlias;
          visit.vehicleNo = vehicleNo;
        }

        stage = 'resolve_pin';
        const pin = await resolveDeliveryCoordinatesCached(delivery);
        if (!pin && !(previous.geofenceId && delivery.proof?.receivedAt)) visit.status = 'missing_pin';
        else {
          // Freeze the pin once proof is received. Unmanaged visits retain
          // the existing vehicle snapshot as well.
          let fenceId = previous.geofenceId;
          stage = 'geofence_setup';
          if (fenceId && delivery.proof?.receivedAt) {
            const savedFence = await CustomerGeofence.findOne({ truckoomId: fenceId }).lean();
            if (!visit.businessDate && savedFence?.businessDate) visit.businessDate = savedFence.businessDate;
          }
          if (!fenceId || !delivery.proof?.receivedAt) {
            const identity = customerFenceIdentity(delivery, pin);
            let fence = await CustomerGeofence.findOne({ key: identity.key }).lean();
            if (!fence?.truckoomId) {
              // Do not manufacture retrospective visit windows for old jobs.
              if (identity.businessDate !== today) {
                visit.status = 'awaiting_events';
                await saveVisit(delivery, visit, io, managedProof);
                continue;
              }
              if (remoteFences === null) remoteFences = await truckoom.getGeofences();
              const remote = remoteFences.find(f => f['Geofence name'] === identity.name);
              let id = remote?.['Geofence Id'];
              if (!id) {
                if (created >= 100) continue; // bounded daily upload batches
                await renew();
                id = await truckoom.createCustomerGeofence(identity.name, pin, CUSTOMER_RADIUS_METRES);
                created++;
                remoteFences.push({ 'Geofence name': identity.name, 'Geofence Id': id });
              }
              fence = await CustomerGeofence.findOneAndUpdate({ key: identity.key }, { $set: {
                ...identity, customerId: delivery.customerId, ...pin,
                radiusMetres: CUSTOMER_RADIUS_METRES, truckoomId: String(id),
              } }, { upsert: true, new: true }).lean();
            }
            fenceId = fence.truckoomId;
            visit = { geofenceId: fenceId, geofenceName: fence.name, businessDate: fence.businessDate,
              vehicleNo, driverId,
              lat: fence.lat, lng: fence.lng, radiusMetres: fence.radiusMetres,
              checkedAt: now, needsReview: false };
          }
          const anchor = visit.businessDate || delivery.scheduledTime;
          const { startOfDay: dayStart, endOfDayExclusive: dayEnd } = getBusinessDayBounds(anchor);
          const start = binding?.startsAt > dayStart ? binding.startsAt : dayStart;
          const end = binding?.endsAt && binding.endsAt < dayEnd ? binding.endsAt : dayEnd;
          stage = 'event_archive';
          const events = await archivedTrackerEvents(visit.geofenceName, dayStart, dayEnd);
          // Fetch the two UTC dates covering the whole Dubai calendar day.
          let alertsUnavailable = false;
          let alertErrorCode = null;
          // Alert history remains useful after the remote circle is removed;
          // re-poll old visits to reconcile late alerts and offline proofs.
          for (const date of alertDateKeys(dayStart, dayEnd)) {
            try { events.push(...await getDateAlerts(date)); }
            catch (error) {
              alertsUnavailable = true;
              alertErrorCode = error.response?.status ? `HTTP_${error.response.status}` : (['ECONNABORTED','ETIMEDOUT','ECONNRESET','ENOTFOUND','TRUCKOOM_INVALID_RESPONSE','ARCHIVE_WRITE_FAILED'].includes(error.code) ? error.code : 'ALERT_READ_FAILED');
            }
          }
          const matched = events.filter(e => e.vehicleNo === String(visit.vehicleNo) && e.name === visit.geofenceName
            && (!binding || (+e.at >= +start && +e.at < +end)));
          visit.evidenceSource = 'truckoom_alerts';
          visit.gpsSampleCount = 0;
          let gpsEvaluation = null;
          if (!matched.length && visit.vehicleNo) {
            stage = 'gps_history';
            const pathKey = `${visit.vehicleNo}:${+dayStart}`;
            // Mongoose queries execute once. Cache their promise, not the query
            // itself, because many customer stops share a vehicle/day.
            if (!gpsPaths.has(pathKey)) gpsPaths.set(pathKey, Promise.resolve(VehicleLocationHistory.find({
              vehicleNo: visit.vehicleNo, recordedAt: { $gte: dayStart, $lt: dayEnd },
            }).select('latitude longitude gpsTime recordedAt sourceReceipt driver driverCandidates driverMappingState qualityFlags').lean()));
            const expectedDriver = String(visit.driverId || driverId);
            const path = (await gpsPaths.get(pathKey)).filter(p => {
              const at = gpsFixTime(p.gpsTime);
              // Retain missing-clock observations as uncertainty, never receipt-time fixes.
              return !at || +at >= +start && +at < +end;
            }).map(p => {
              const matches = expectedDriver && (String(p.driver || '') === expectedDriver
                || p.driverMappingState === 'ambiguous_current_mapping'
                  && p.driverCandidates?.some(id => String(id) === expectedDriver));
              // Same-vehicle evidence must not disappear between two matching
              // driver samples. Keep the assignment uncertainty as a barrier.
              return matches ? p : { ...p, qualityFlags: [...(p.qualityFlags || []), 'unmatched_driver_mapping'] };
            });
            // Share one historical API result across every stop on this vehicle/day.
            // Truckoom logs identify the vehicle, so use the delivery's frozen vehicle
            // snapshot; do not rewrite local points or invent a driver association.
            if (!historicalPaths.has(pathKey)) historicalPaths.set(pathKey,
              truckoomHistory.getPoints(visit.vehicleNo, dayStart, dayEnd, now).catch(() => []));
            const historical = await historicalPaths.get(pathKey);
            // Cached history may end before a recent stop. Keep fresh local
            // samples too, but evaluate observations separately from real geofence events.
            const samples = [...historical, ...path].filter(p => {
              const at = gpsFixTime(p.gpsTime);
              return !at || +at >= +start && +at < +end;
            });
            if (samples.length) {
              visit.evidenceSource = 'truckoom_gps_samples'; visit.gpsSampleCount = samples.length;
              gpsEvaluation = evaluateGpsVisit({ points: samples, pin: { lat: visit.lat, lng: visit.lng },
                radiusMetres: visit.radiusMetres ?? CUSTOMER_RADIUS_METRES,
                photoCapturedAt: delivery.proof?.photoCapturedAt, photoSource: delivery.proof?.photoSource,
                start, end, asOf: now });
            }
          }
          visit = { ...visit, ...(gpsEvaluation || evaluateTrackerVisit({
            events: matched,
            photoCapturedAt: delivery.proof?.photoCapturedAt, photoSource: delivery.proof?.photoSource,
            start, end,
          })) };
          if (visit.evidenceSource !== 'truckoom_gps_samples' && alertsUnavailable && !matched.length && vehicleNo && visit.status !== 'missing_photo_time') visit.status = alertErrorCode === 'ARCHIVE_WRITE_FAILED' ? 'verification_error' : 'tracker_error';
          if (alertsUnavailable) { visit.errorStage = alertErrorCode === 'ARCHIVE_WRITE_FAILED' ? 'event_archive' : 'alerts'; visit.errorCode = alertErrorCode; }
          if (!vehicleNo) visit.status = 'no_tracker';
        }
      } catch {
        // When pilot admission itself cannot be read, keep the original visit
        // and retry before treating a historical proof as a pilot row.
        if (stage === 'fleet_assignment' && !managedProof) continue;
        // Axios errors may contain credential-bearing query strings. Never log
        // their config/URL or turn an outage into a driver violation.
        visit.status = 'verification_error';
        visit.errorStage = stage;
        visit.errorCode = 'CHECK_FAILED';
        visit.needsReview = false;
        remoteFences = null; // reconcile an ambiguous remote create before retry
      }
      await saveVisit(delivery, visit, io, managedProof);
      checked++;
    }
    const deleted = await removeExpiredCustomerGeofences({ now, getDateAlerts, renew });
    return { checked, created, deleted };
  } finally {
    await TrackerSyncLease.deleteOne({ _id: 'customer-visits', owner });
  }
}

async function saveVisit(delivery, visit, io, managedProof) {
  // If proof, pin, or assignment changed during the external calls, retry next
  // cycle instead of attaching a verdict based on an obsolete snapshot.
  const previous = delivery.trackerVisit;
  const filter = { _id: delivery._id, updatedAt: delivery.updatedAt,
    'trackerVisit.checkedAt': previous?.checkedAt ?? null };
  // Keep the pre-migration GPS result once, rather than growing history every poll.
  // This is server-owned evidence and is saved atomically with the replacement.
  const updates = { trackerVisit: visit };
  const savedBaseline = delivery.trackerVisitGpsBaseline;
  const earlierFleetVisit = managedProof && previous?.vehicleNo && previous.vehicleNo !== visit.vehicleNo
    && !savedBaseline?.beforeFleet ? { recordedAt: visit.checkedAt, evidence: previous } : null;
  if (previous?.evidenceSource === 'truckoom_gps_samples' && previous.gpsMethod !== GPS_VISIT_METHOD
    && !savedBaseline?.evidence) {
    updates.trackerVisitGpsBaseline = { recordedAt: visit.checkedAt, evidence: previous };
    if (earlierFleetVisit || savedBaseline?.beforeFleet) {
      updates.trackerVisitGpsBaseline.beforeFleet = earlierFleetVisit || savedBaseline.beforeFleet;
    }
  } else if (earlierFleetVisit) {
    updates['trackerVisitGpsBaseline.beforeFleet'] = earlierFleetVisit;
  }
  // Tracker refreshes use their own clock. Keep the delivery clock for changes
  // to its business fields and proof, which the reporting source reads.
  const result = await Delivery.updateOne(filter, { $set: updates }, { timestamps: false });
  // A tracker refresh must not trigger the normal "delivery completed" toasts.
  if (result.modifiedCount && io) io.emit('delivery:trackerVisit', { _id: delivery._id, trackerVisit: visit });
}
