import deliveryOrderRouter from './deliveryOrder.js';
import express from 'express';
import mongoose from 'mongoose';
import axios from 'axios';
import { body, validationResult } from 'express-validator';
import Delivery from '../models/Delivery.js';
import DeliveryChange from '../models/DeliveryChange.js';
import Bag from '../models/Bag.js';
import User from '../models/User.js';
import Customer from '../models/Customer.js';
import { protect, authorize, admin } from '../middleware/auth.js'; // Fixed import
import { upload, handleUploadError } from '../middleware/upload.js';
import { getUploadToSpaces } from '../config/spaces.js';
import { detectAreaFromAddress } from '../config/areas.js';
import { resolveDeliveryCoordinatesCached, isPlausibleCoordinate, geocodeAddress } from '../services/geocoding.js';
import { sendDeliveryPushToDriver } from '../services/pushNotificationService.js';
import { flagDeliveryChangeIfNeeded } from '../services/deliveryChangeFlag.js';
import { recalculateDriverKPI } from '../services/driverKpiService.js';
import { businessRangeBounds, getTimingOverview, getTimingRecords } from '../services/deliveryTimingHistory.js';
import { businessOffsetMs, getBusinessDayBounds, isDateKey, setBusinessTimeOfDay } from '../utils/businessDate.js';
import { fillProofAddressInBackground, resolveProofAddressWithin } from '../services/proofLocationAddress.js';
import {
  optimizeRoutes,
  applyRoutePlan,
  TZ_OFFSET_MS,
  serviceSecondsForVehicleType,
  KITCHEN_DEPARTURE_DEFAULT_SECONDS,
  KITCHEN_DEPARTURE_EARLIEST_SECONDS,
  DELIVERY_WINDOW_SECONDS
} from '../services/routeOptimizationService.js';
import { buildOrderedRouteLegs } from '../services/distanceMatrixService.js';
import Handoff from '../models/Handoff.js';
import { HANDOFF_DWELL_SECONDS, KITCHEN_RELOAD_DWELL_SECONDS } from '../services/handoffPlanner.js';

// Helper to persist coordinates onto a customer's record via their deliveries
async function saveCustomerCoords(delivery, lat, lng, link) {
  if (!delivery) return;
  delivery.gpsLocation = {
    lat,
    lng,
    link: link || delivery.gpsLocation?.link
  };
  delivery.lat = lat;
  delivery.lng = lng;
  await delivery.save();

  // A dispatcher manually placing a pin is the most trustworthy source there
  // is — cache it on the customer so it's reused everywhere (Optimize Routes,
  // new deliveries, map views) without ever being re-geocoded, and so it
  // can't later be overwritten by a re-geocode of the same address.
  if (delivery.customerId) {
    await Customer.updateOne(
      { customerId: delivery.customerId },
      { $set: { gpsLocation: { lat, lng, source: 'manual', addressId: delivery.addressId || null, address: String(delivery.address || '').trim(), geocodedAt: new Date() } } }
    ).catch((err) => console.warn('Failed to cache customer coordinates:', err.message));
  }
}

// Timezone handling: treat client-supplied local times as LOCAL_TZ when they lack an explicit offset
const LOCAL_TZ_OFFSET_MS = businessOffsetMs();

function hasExplicitOffset(value) {
  return typeof value === 'string' && /([zZ]|[+-]\d{2}:?\d{2})$/.test(value.trim());
}

function normalizeScheduledTimeInput(raw) {
  if (!raw) return null;

  // If already a Date or number, trust it
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? null : raw;
  }

  // Strings without timezone should be interpreted in LOCAL_TZ
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    if (hasExplicitOffset(trimmed)) {
      const parsed = new Date(trimmed);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    const [datePart, timePartRaw] = trimmed.split('T');
    if (datePart && timePartRaw) {
      const [y, mo, d] = datePart.split('-').map(Number);
      const [h = '0', m = '0'] = timePartRaw.split(':');
      const hours = Number.parseInt(h, 10) || 0;
      const minutes = Number.parseInt(m, 10) || 0;
      const utcMillis = Date.UTC(y, (mo || 1) - 1, d || 1, hours, minutes) - LOCAL_TZ_OFFSET_MS;
      const normalized = new Date(utcMillis);
      if (!Number.isNaN(normalized.getTime())) {
        return normalized;
      }
    }

    // Fallback to native parsing
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  // Other inputs (numbers, etc.)
  try {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  } catch {
    return null;
  }
}

function formatLocalDateTime(date) {
  if (!date) return 'N/A';
  const dt = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(dt.getTime())) return 'N/A';
  const local = new Date(dt.getTime() + LOCAL_TZ_OFFSET_MS);
  const pad = (n) => String(n).padStart(2, '0');
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}

async function notifyManualDeliverySlack(delivery, actorLabel) {
  try {
    // Check if Slack notifications are enabled
    if (process.env.ENABLE_SLACK_NOTIFICATIONS === '0') {
      console.log('Slack notifications disabled; skipping manual delivery notification');
      return false;
    }

    const webhookUrl =
      process.env.SLACK_MANUAL_ENTRY_WEBHOOK_URL ||
      process.env.SLACK_WEBHOOK_URL ||
      process.env.SLACK_LOCATION_CHANGE_WEBHOOK_URL ||
      process.env.SLACK_REMOVAL_WEBHOOK ||
      process.env.SLACK_BAG_COLLECTION_WEBHOOK_URL ||
      process.env.SLACK_BAG_COLLECTION_WEBHOOK;

    if (!webhookUrl) {
      console.warn('Manual delivery Slack webhook not configured; skipping Slack notify');
      return false;
    }

    const lines = [
      ':incoming_envelope: *Manual Delivery Created*',
      `Customer: ${delivery.customerName || 'Unknown'} (${delivery.customerId || 'N/A'})`,
      `When: ${formatLocalDateTime(delivery.scheduledTime)} (local)`,
      delivery.address ? `Address: ${delivery.address}` : null,
      delivery.company ? `Company: ${delivery.company}` : null,
      actorLabel ? `Created by: ${actorLabel}` : null,
      delivery.driver ? `Driver: ${delivery.driver?.profile?.firstName || delivery.driver}` : null
    ].filter(Boolean);

    await axios.post(webhookUrl, { text: lines.join('\n') }, { timeout: 8000 });
    console.log('Sent manual delivery Slack notification');
    return true;
  } catch (err) {
    console.warn('Failed to send manual delivery Slack notification:', err.message);
    return false;
  }
}

const router = express.Router();

// Slack notifier for delivery removals
async function sendDeliveryRemovalToSlack(deliveries, meta = {}) {
  try {
    // Check if Slack notifications are enabled
    if (process.env.ENABLE_SLACK_NOTIFICATIONS === '0') {
      console.log('Slack notifications disabled; skipping delivery removal notification');
      return;
    }

    const webhookUrl = process.env.SLACK_REMOVAL_WEBHOOK;
    if (!webhookUrl) {
      console.warn('SLACK_REMOVAL_WEBHOOK not configured; skipping Slack notification');
      return;
    }

    const deletedBy = meta.deletedBy || 'Unknown user';
    const count = Array.isArray(deliveries) ? deliveries.length : 1;
    
    const lines = [`:wastebasket: *${count} Delivery(ies) Removed*`, `Deleted by: ${deletedBy}`, ''];

    // Show details for each delivery
    for (const delivery of deliveries.slice(0, 10)) { // Limit to first 10
      const scheduledDate = delivery.scheduledTime 
        ? new Date(delivery.scheduledTime).toISOString().slice(0, 16).replace('T', ' ')
        : 'N/A';
      
      lines.push(`*Customer:* ${delivery.customerName || 'Unknown'} (${delivery.customerId || 'N/A'})`);
      lines.push(`*Address:* ${delivery.address || 'N/A'}`);
      lines.push(`*Scheduled:* ${scheduledDate}`);
      lines.push(`*Status:* ${delivery.status || 'N/A'}`);
      if (delivery.company) lines.push(`*Company:* ${delivery.company}`);
      lines.push('');
    }

    if (deliveries.length > 10) {
      lines.push(`_...and ${deliveries.length - 10} more deliveries_`);
    }

    await axios.post(webhookUrl, { text: lines.join('\n') }, { timeout: 8000 });
  } catch (err) {
    console.error('Failed to send delivery removal to Slack:', err.message);
  }
}

// Helper function to apply changes to delivery
export async function applyChangesToDelivery(delivery, changes) {
  const updateFields = {};
  
  // Convert Mongoose Map to plain object if needed
  const changesObj = changes instanceof Map ? Object.fromEntries(changes) : changes;
  
  console.log('Changes to apply (converted):', changesObj);
  
  Object.keys(changesObj).forEach(field => {
    if (field === 'scheduledTime') {
      // "HH:mm" Dubai time on the delivery's existing BUSINESS day (issue #5:
      // taking the UTC date first moved a 00:00-03:59 Dubai delivery to the
      // previous day). Throws on an invalid time before anything is written.
      updateFields[field] = setBusinessTimeOfDay(delivery.scheduledTime, changesObj[field]);
    } else if (field === 'customerName') {
      updateFields[field] = changesObj[field];
    } else if (field === 'customerPhone') {
      updateFields[field] = changesObj[field];
    } else if (field === 'location' && !changesObj.address) {
      // Normalize 'location' to 'address' if provided
      updateFields['address'] = changesObj[field];
    } else {
      updateFields[field] = changesObj[field];
    }
  });

  console.log('Update fields for delivery:', delivery._id, updateFields);
  
  // Auto-detect area/zone if address is being changed
  if (updateFields.address) {
    const detectedArea = detectAreaFromAddress(updateFields.address, delivery.zone, {
      company: updateFields.company || delivery.company || ''
    });
    updateFields.zone = detectedArea;
    console.log(`🗺️ Area auto-detection in change apply: "${updateFields.zone}" for address: "${updateFields.address}"`);
  }
  
  const updatedDelivery = await Delivery.findByIdAndUpdate(
    delivery._id, 
    { $set: updateFields },
    { new: true, runValidators: true }
  );
  
  console.log('Delivery updated successfully:', updatedDelivery._id);
  console.log('Updated values:', updateFields);
  
  return updatedDelivery;
}

// Helper function to check and apply pending changes for a new delivery
async function checkAndApplyPendingChanges(delivery) {
  const { startOfDay, endOfDayExclusive } = getBusinessDayBounds(delivery.scheduledTime);

  console.log('========== AUTO-APPLY PENDING CHANGES ==========');
  console.log('Delivery:', {
    id: delivery._id.toString(),
    customerId: delivery.customerId,
    customerIdType: typeof delivery.customerId,
    customerIdTrimmed: delivery.customerId.trim(),
    scheduledTime: delivery.scheduledTime,
    scheduledTimeISO: delivery.scheduledTime.toISOString()
  });
  console.log('Search range:', {
    startOfDay: startOfDay.toISOString(),
    endOfDayExclusive: endOfDayExclusive.toISOString()
  });

  // Find pending or mis-marked applied changes for this customer and date
  // Normalize customerId by trimming whitespace and normalizing case
  const normalizedCustomerId = delivery.customerId.toString().trim();
  
  const pendingChanges = await DeliveryChange.find({
    customerId: normalizedCustomerId,
    scheduledDate: {
      $gte: startOfDay,
      $lt: endOfDayExclusive
    },
    $or: [
      { status: 'pending' },
      { status: 'applied', appliedToDelivery: { $exists: false } },
      { status: 'applied', appliedToDelivery: null }
    ]
  });

  console.log('Query result: Found', pendingChanges.length, 'changes for customerId:', normalizedCustomerId);
  
  if (pendingChanges.length === 0) {
    // Debug: check if there are ANY changes for this customer with different customerIds
    const allChanges = await DeliveryChange.find({ 
      customerId: { $regex: new RegExp('^\\s*' + delivery.customerId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'i') }
    }).limit(10);
    console.log('DEBUG: All changes for similar customerIds:');
    allChanges.forEach(c => {
      const inRange = c.scheduledDate >= startOfDay && c.scheduledDate < endOfDayExclusive;
      console.log('  -', {
        id: c._id.toString(),
        customerId: c.customerId,
        customerIdType: typeof c.customerId,
        scheduledDate: c.scheduledDate.toISOString(),
        scheduledDateMs: c.scheduledDate.getTime(),
        status: c.status,
        appliedTo: c.appliedToDelivery?.toString() || 'null',
        inDateRange: inRange,
        startOfDayMs: startOfDay.getTime(),
        endOfDayExclusiveMs: endOfDayExclusive.getTime()
      });
    });
  }
  console.log('================================================');

  // Apply each pending change
  for (const change of pendingChanges) {
    try {
      console.log('Applying pending change:', change._id.toString(), 'with changes:', change.changes);
      console.log('Change status BEFORE update:', change.status);
      
      const updatedDelivery = await applyChangesToDelivery(delivery, change.changes);
      
      // Mark change as applied
      change.status = 'applied';
      change.appliedAt = new Date();
      change.appliedToDelivery = delivery._id;
      
      console.log('Change status AFTER update (before save):', change.status);
      console.log('AppliedToDelivery:', change.appliedToDelivery.toString());
      
      await change.save();
      
      console.log('✅ Pending change applied successfully and SAVED:', change._id.toString());
      
      // Verify the save worked by re-querying
      const verifyChange = await DeliveryChange.findById(change._id);
      console.log('Verification - change status in DB:', verifyChange.status, 'appliedTo:', verifyChange.appliedToDelivery?.toString());
      
    } catch (error) {
      console.error('❌ Error applying pending change:', change._id.toString(), error.message);
      // Continue with other changes even if one fails
    }
  }

  console.log(`Applied ${pendingChanges.length} pending changes to delivery ${delivery._id.toString()}`);
  console.log('================================================');

  return pendingChanges.length;
}

// All routes are protected
router.use(protect);
router.use('/delivery-order', deliveryOrderRouter);

// @desc    Depot (kitchen) location used by map views — same env the route optimizer uses.
//          Registered before '/:id' so "depot" is never parsed as a delivery id.
// @route   GET /api/deliveries/depot
router.get('/depot', authorize(['admin', 'super_admin', 'dispatcher', 'manager']), (req, res) => {
  const lat = Number(process.env.DELIVERY_DEPOT_LAT);
  const lng = Number(process.env.DELIVERY_DEPOT_LNG);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.json({ success: true, data: null });
  }
  res.json({
    success: true,
    data: { lat, lng, label: process.env.DELIVERY_DEPOT_LABEL || 'Depot' }
  });
});

// @desc    Resolve coordinates for deliveries that have none stored (map views).
//          Same customer-cached resolver Optimize Routes uses: it only returns a
//          pin that already exists (a Maps-link pin, or the customer's saved pin
//          for this exact address) — it never guesses from the address text.
//          Fully read-only. Deliveries it can't resolve come back in
//          `unresolved` for a dispatcher to place.
// @route   POST /api/deliveries/resolve-coords   { deliveryIds: [] }
const RESOLVE_COORDS_MAX_IDS = 500;
const RESOLVE_COORDS_CONCURRENCY = 5;
router.post('/resolve-coords', authorize(['admin', 'super_admin', 'dispatcher', 'manager']), async (req, res) => {
  const { deliveryIds } = req.body || {};
  const validIds = Array.isArray(deliveryIds)
    && deliveryIds.length > 0
    && deliveryIds.length <= RESOLVE_COORDS_MAX_IDS
    && deliveryIds.every((id) => typeof id === 'string' && /^[a-f\d]{24}$/i.test(id));
  if (!validIds) {
    return res.status(400).json({ success: false, message: `deliveryIds must be 1-${RESOLVE_COORDS_MAX_IDS} delivery ids` });
  }

  try {
    const deliveries = await Delivery.find({ _id: { $in: deliveryIds } })
      .select('customerId customerName address gpsLocation location lat lng')
      .lean();

    const resolved = {};
    const unresolved = [];

    const resolveOne = async (delivery) => {
      const id = String(delivery._id);
      if (isPlausibleCoordinate(delivery.gpsLocation?.lat, delivery.gpsLocation?.lng)) {
        resolved[id] = { lat: delivery.gpsLocation.lat, lng: delivery.gpsLocation.lng, source: 'stored' };
        return;
      }
      const coords = await resolveDeliveryCoordinatesCached({ ...delivery, mapsUrl: delivery.gpsLocation?.link || undefined });
      if (coords) resolved[id] = { lat: coords.lat, lng: coords.lng, source: 'geocoded' };
      else unresolved.push(id);
    };

    for (let i = 0; i < deliveries.length; i += RESOLVE_COORDS_CONCURRENCY) {
      await Promise.all(
        deliveries.slice(i, i + RESOLVE_COORDS_CONCURRENCY).map((d) => resolveOne(d).catch((err) => {
          console.error('resolve-coords failed for delivery', String(d._id), err.message);
          unresolved.push(String(d._id));
        }))
      );
    }

    res.json({ success: true, data: { resolved, unresolved } });
  } catch (error) {
    console.error('Error resolving delivery coordinates:', error);
    res.status(500).json({ success: false, message: 'Failed to resolve coordinates' });
  }
});

// @desc    One-off Google geocode of a single address, for the "Google
//          Geocoding" button — mirrors the client's own direct 2GIS geocoder
//          call (same shape: given an address, return a point or null), but
//          Google's key is server-only so this has to be a real round trip.
//          Read-only itself — the CLIENT persists a hit via the existing
//          manual-coords endpoint, same as it already does for a 2GIS hit,
//          so both providers save through one code path.
// @route   POST /api/deliveries/geocode-google   { address }
router.post('/geocode-google', authorize(['admin', 'super_admin', 'dispatcher', 'manager']), async (req, res) => {
  const { address } = req.body || {};
  if (!address || typeof address !== 'string' || !address.trim()) {
    return res.status(400).json({ success: false, message: 'address is required' });
  }
  try {
    const coords = await geocodeAddress(address);
    if (!coords || !isPlausibleCoordinate(coords.lat, coords.lng)) {
      return res.json({ success: true, data: null });
    }
    res.json({ success: true, data: { lat: coords.lat, lng: coords.lng } });
  } catch (error) {
    console.error('Google geocode error:', error.message);
    res.status(500).json({ success: false, message: 'Google geocoding failed' });
  }
});

// @desc    Estimate a real (road-time) arrival at each stop of an already-ordered
//          route, and whether that lands early / on time / late against each
//          stop's delivery window. Read-only — used by map views, not the optimizer.
//
//          Departure follows the kitchen's rule (see KITCHEN_DEPARTURE_* in
//          routeOptimizationService.js): leave at the usual time; pull it
//          earlier only if the route's scheduled times need it; never before
//          the earliest allowed — past that, plan at the earliest and report
//          the departure that would have been needed. From there the day
//          cascades forward on real OSRM driving legs + the optimizer's
//          per-stop service-time estimate (villa/apartment), and finishes
//          with the drive back to the kitchen so totals cover the whole day.
//
//          A stop's scheduledTime is the END of its window (07:00 = 04:00–07:00,
//          see DELIVERY_WINDOW_SECONDS): after it is late, before it opens is
//          early, anywhere inside is on time.
//
//          Once a stop is actually delivered (Delivery.completedAt set), its
//          real timestamp replaces the projection for that stop — an actual
//          early/late instead of a guess — and re-anchors the cascade for the
//          stops still pending, so the rest of the day's estimate tracks
//          reality as it happens instead of drifting from a stale morning
//          assumption.
// @route   POST /api/deliveries/route-eta
//          { deliveryIds: [], vehicleType?, driverId?, date? }  (visit order)
//          vehicleType ('bike' | 'van') picks the flat time-at-the-door figure
//          for every stop on this route (see serviceSecondsForVehicleType) —
//          defaults to the slower (bike) figure when omitted.
//          driverId + date (YYYY-MM-DD) let this look up the driver's planned
//          second-trip pickup for that day (a van handoff, or a return to the
//          kitchen) and fold its detour into the ETAs at the right point, so
//          the times after it are honest about the trip back.
const ROUTE_ETA_MAX_STOPS = 150;
router.post('/route-eta', authorize(['admin', 'super_admin', 'dispatcher', 'manager']), async (req, res) => {
  const { deliveryIds, vehicleType, driverId, date, fixedDepartureSeconds } = req.body || {};
  // Simulation-only: a dispatcher-set departure that deliberately overrides
  // the normal 1:00 AM earliest-departure rule for a what-if preview. Any
  // other caller leaves this out and the usual rule applies.
  const forcedDepartureSeconds = Number.isFinite(fixedDepartureSeconds)
    && fixedDepartureSeconds >= 0 && fixedDepartureSeconds < 24 * 3600
    ? Math.round(fixedDepartureSeconds)
    : null;
  const validIds = Array.isArray(deliveryIds)
    && deliveryIds.length > 0
    && deliveryIds.length <= ROUTE_ETA_MAX_STOPS
    && deliveryIds.every((id) => typeof id === 'string' && /^[a-f\d]{24}$/i.test(id));
  if (!validIds) {
    return res.status(400).json({ success: false, message: `deliveryIds must be 1-${ROUTE_ETA_MAX_STOPS} delivery ids, in visit order` });
  }

  const depotLat = Number(process.env.DELIVERY_DEPOT_LAT);
  const depotLng = Number(process.env.DELIVERY_DEPOT_LNG);
  if (!Number.isFinite(depotLat) || !Number.isFinite(depotLng)) {
    return res.status(400).json({ success: false, message: 'DELIVERY_DEPOT_LAT/DELIVERY_DEPOT_LNG are not configured' });
  }

  try {
    const found = await Delivery.find({ _id: { $in: deliveryIds } })
      .select('customerId customerName address addressDetails gpsLocation location lat lng scheduledTime completedAt')
      .lean();
    const byId = new Map(found.map((d) => [String(d._id), d]));
    // Preserve the caller's visit order, not Mongo's — that order is the whole point.
    const ordered = deliveryIds.map((id) => byId.get(id)).filter(Boolean);

    const withCoords = [];
    const droppedIds = [];
    for (const delivery of ordered) {
      let coords = isPlausibleCoordinate(delivery.gpsLocation?.lat, delivery.gpsLocation?.lng)
        ? { lat: delivery.gpsLocation.lat, lng: delivery.gpsLocation.lng }
        : null;
      if (!coords) coords = await resolveDeliveryCoordinatesCached(delivery).catch(() => null);
      if (coords) withCoords.push({ delivery, coords });
      else droppedIds.push(String(delivery._id));
    }

    if (withCoords.length === 0) {
      return res.json({ success: true, data: { departure: null, totals: null, stops: [], droppedIds } });
    }

    // Kitchen → every stop in order → back to the kitchen. The last leg is the
    // return, so there are withCoords.length + 1 legs and totals cover the
    // whole day the driver actually drives.
    const depot = { lat: depotLat, lng: depotLng };
    const points = [depot, ...withCoords.map((w) => w.coords), depot];
    const { legDurations, legDistances } = await buildOrderedRouteLegs(points);

    // The driver's planned second-trip pickup for this day, if any. A bike has
    // at most one (a van handoff OR a kitchen return); a van can be the
    // counterpart for several bikes.
    const validDate = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date);
    const validDriverId = typeof driverId === 'string' && /^[a-f\d]{24}$/i.test(driverId);
    let pickup = null;         // this driver's OWN detour (bike side)
    let meetingBikes = [];     // bikes meeting this driver (van side)
    if (validDate && validDriverId) {
      const records = await Handoff.find({ date, status: { $ne: 'cancelled' }, $or: [{ bike: driverId }, { van: driverId }] })
        .populate('bike', 'profile.firstName profile.lastName')
        .populate('van', 'profile.firstName profile.lastName')
        .lean();
      pickup = records.find((r) => String(r.bike?._id ?? r.bike) === String(driverId)) || null;
      meetingBikes = records.filter((r) => r.van && String(r.van?._id ?? r.van) === String(driverId));
    }

    // Where the detour goes: immediately before the first second-trip stop.
    // Matched by delivery id rather than the stored routeOrder, so a stop
    // dropped above for having no location can't shift it onto the wrong leg.
    const nameOf = (u) => [u?.profile?.firstName, u?.profile?.lastName].filter(Boolean).join(' ') || 'Driver';
    let detour = null;
    if (pickup) {
      const secondTripIds = new Set((pickup.deliveryIds || []).map((id) => String(id?._id ?? id)));
      const insertAt = withCoords.findIndex((w) => secondTripIds.has(String(w.delivery._id)));
      // Needs a stop before it to leave from; index 0 would mean the whole
      // route is trip 2, which the planner never produces.
      const mp = pickup.meetingPoint || {};
      if (insertAt > 0 && Number.isFinite(mp.lat) && Number.isFinite(mp.lng)) {
        // Price the real side trip: last trip-1 stop → kitchen/meeting point →
        // first trip-2 stop, against the direct leg it replaces. Measured
        // fresh (the planner's per-leg figures aren't stored) so the arrival
        // AT the pickup can be reported as a clock time, not just a total.
        const via = await buildOrderedRouteLegs([
          withCoords[insertAt - 1].coords,
          { lat: mp.lat, lng: mp.lng },
          withCoords[insertAt].coords
        ]).catch(() => null);
        if (via) {
          const toPickup = Math.round(via.legDurations[0] || 0);
          const fromPickup = Math.round(via.legDurations[1] || 0);
          // A kitchen return is a solo reload; a van handoff also carries the
          // wait for whichever driver gets there first. expectedWaitSeconds is
          // the gap between the two planned arrivals, so it's an upper bound.
          const dwell = pickup.type === 'kitchen_return'
            ? KITCHEN_RELOAD_DWELL_SECONDS
            : HANDOFF_DWELL_SECONDS + Math.round(pickup.expectedWaitSeconds || 0);
          const direct = Math.round(legDurations[insertAt] ?? 0);
          detour = {
            type: pickup.type,
            beforeIndex: insertAt,
            beforeDeliveryId: String(withCoords[insertAt].delivery._id),
            toPickupSeconds: toPickup,
            dwellSeconds: dwell,
            extraSeconds: Math.max(0, toPickup + dwell + fromPickup - direct),
            meetingPoint: { lat: mp.lat, lng: mp.lng, name: mp.name, poiType: mp.poiType },
            counterpartName: pickup.type === 'van_handoff' ? nameOf(pickup.van) : null,
            // kitchen_return: why no van took it (a van meeting is tried first).
            vanReason: pickup.vanReason || null,
            bagCount: (pickup.deliveryIds || []).length,
            status: pickup.status
          };
        }
      }
    }
    // Flat per-vehicle figure, same at every stop on this route (see
    // serviceSecondsForVehicleType) — villa and apartment no longer differ.
    const routeServiceSeconds = serviceSecondsForVehicleType(vehicleType);
    const serviceSeconds = withCoords.map(() => routeServiceSeconds);

    const secondsFromMidnight = (dateLike) => {
      const local = new Date(new Date(dateLike).getTime() + TZ_OFFSET_MS);
      return local.getUTCHours() * 3600 + local.getUTCMinutes() * 60 + local.getUTCSeconds();
    };
    const scheduledSeconds = withCoords.map((w) => (w.delivery.scheduledTime ? secondsFromMidnight(w.delivery.scheduledTime) : null));

    // Latest departure that still has EVERY scheduled stop arriving by its
    // scheduled time, given real travel + dwell up to each one.
    let requiredDepartureSeconds = null;
    {
      let elapsed = 0;
      for (let i = 0; i < withCoords.length; i += 1) {
        if (detour && i === detour.beforeIndex) elapsed += detour.extraSeconds;
        elapsed += legDurations[i] ?? 0;
        if (scheduledSeconds[i] !== null) {
          const latest = scheduledSeconds[i] - elapsed;
          if (requiredDepartureSeconds === null || latest < requiredDepartureSeconds) requiredDepartureSeconds = latest;
        }
        elapsed += serviceSeconds[i];
      }
    }

    // The kitchen's departure rule: usual time; earlier only if this route
    // needs it; never before the earliest allowed.
    const earliestDeparture = Math.min(KITCHEN_DEPARTURE_EARLIEST_SECONDS, KITCHEN_DEPARTURE_DEFAULT_SECONDS);
    const usualDeparture = Math.max(KITCHEN_DEPARTURE_EARLIEST_SECONDS, KITCHEN_DEPARTURE_DEFAULT_SECONDS);
    let departureSeconds = usualDeparture;
    let departureReason = 'usual';
    if (forcedDepartureSeconds !== null) {
      // Dispatcher pinned this exact time in a simulation — no earliest cap.
      departureSeconds = forcedDepartureSeconds;
      departureReason = 'fixed';
    } else if (requiredDepartureSeconds !== null && requiredDepartureSeconds < usualDeparture) {
      if (requiredDepartureSeconds >= earliestDeparture) {
        departureSeconds = requiredDepartureSeconds;
        departureReason = 'earlier';
      } else {
        departureSeconds = earliestDeparture;
        departureReason = 'capped';
      }
    }

    const etaSeconds = new Array(withCoords.length).fill(null);
    const isActual = new Array(withCoords.length).fill(false);
    const lateSeconds = new Array(withCoords.length).fill(null); // > 0: arrived after the scheduled time
    const earlySeconds = new Array(withCoords.length).fill(null); // > 0: arrived before the window opened

    let clock = departureSeconds;
    for (let i = 0; i < withCoords.length; i += 1) {
      const delivery = withCoords[i].delivery;
      // The second-trip pickup happens on the way to this stop: note the
      // clock time the driver reaches the kitchen / meeting point, then charge
      // the whole side trip before the (direct) leg below.
      if (detour && i === detour.beforeIndex) {
        detour.arrivalSeconds = clock + detour.toPickupSeconds;
        detour.departureSeconds = detour.arrivalSeconds + detour.dwellSeconds;
        clock += detour.extraSeconds;
      }
      if (delivery.completedAt) {
        // Actually delivered: the real timestamp replaces the projection and
        // re-anchors everything still pending. Early/late straight from the two
        // real timestamps so a delivery just after local midnight can't wrap.
        const completedMs = new Date(delivery.completedAt).getTime();
        etaSeconds[i] = secondsFromMidnight(delivery.completedAt);
        isActual[i] = true;
        if (delivery.scheduledTime) {
          const scheduledMs = new Date(delivery.scheduledTime).getTime();
          lateSeconds[i] = Math.max(0, (completedMs - scheduledMs) / 1000);
          earlySeconds[i] = Math.max(0, (scheduledMs - DELIVERY_WINDOW_SECONDS * 1000 - completedMs) / 1000);
        }
        clock = etaSeconds[i] + serviceSeconds[i];
      } else {
        clock += legDurations[i] ?? 0;
        etaSeconds[i] = clock;
        if (scheduledSeconds[i] !== null) {
          lateSeconds[i] = Math.max(0, clock - scheduledSeconds[i]);
          earlySeconds[i] = Math.max(0, scheduledSeconds[i] - DELIVERY_WINDOW_SECONDS - clock);
        }
        clock += serviceSeconds[i];
      }
    }
    const backAtKitchenSeconds = clock + (legDurations[withCoords.length] ?? 0);

    const statusOf = (i) => {
      if (lateSeconds[i] === null) return null;
      if (lateSeconds[i] > 0) return 'late';
      if (earlySeconds[i] > 0) return 'early';
      return 'on_time';
    };

    const stops = withCoords.map((w, i) => ({
      deliveryId: String(w.delivery._id),
      etaSeconds: etaSeconds[i],
      actual: isActual[i],
      scheduledSeconds: scheduledSeconds[i],
      windowStartSeconds: scheduledSeconds[i] !== null ? scheduledSeconds[i] - DELIVERY_WINDOW_SECONDS : null,
      status: statusOf(i), // 'late' | 'early' | 'on_time' | null (no scheduled time)
      lateSeconds: lateSeconds[i],
      earlySeconds: earlySeconds[i],
      legDurationSeconds: legDurations[i] ?? null,
      legDistanceMeters: legDistances[i] ?? null
    }));

    const counts = stops.reduce((acc, s) => { if (s.status) acc[s.status] += 1; return acc; }, { late: 0, early: 0, on_time: 0 });

    res.json({
      success: true,
      data: {
        departure: {
          seconds: departureSeconds,
          reason: departureReason, // 'usual' | 'earlier' | 'capped' | 'fixed'
          usualSeconds: usualDeparture,
          earliestSeconds: earliestDeparture,
          // Departure that would have every stop on time — may be before the
          // earliest allowed, in which case it's informational only.
          requiredSeconds: requiredDepartureSeconds
        },
        windowSeconds: DELIVERY_WINDOW_SECONDS,
        totals: {
          distanceMeters: legDistances.reduce((a, b) => a + (b ?? 0), 0),
          returnDistanceMeters: legDistances[withCoords.length] ?? 0,
          drivingSeconds: legDurations.reduce((a, b) => a + (b ?? 0), 0),
          serviceSeconds: serviceSeconds.reduce((a, b) => a + b, 0),
          // Extra time for the second-trip side trip, already folded into the
          // ETAs and backAtKitchenSeconds above (0 when there isn't one).
          pickupDetourSeconds: detour?.extraSeconds || 0,
          backAtKitchenSeconds,
          late: counts.late,
          early: counts.early,
          onTime: counts.on_time
        },
        // This driver's own second-trip pickup (bike side), with the clock
        // time it happens — null when the day needs no second trip.
        detour,
        // Bikes meeting THIS driver (van side) — informational; the van's own
        // stop ETAs above don't include its small detour to each meeting.
        meetingBikes: meetingBikes.map((r) => ({
          handoffId: String(r._id),
          bikeName: nameOf(r.bike),
          afterRouteOrder: r.vanAfterRouteOrder,
          meetingPoint: r.meetingPoint,
          plannedVanArrivalSeconds: r.plannedVanArrivalSeconds,
          expectedWaitSeconds: r.expectedWaitSeconds,
          bagCount: (r.deliveryIds || []).length,
          status: r.status
        })),
        stops,
        droppedIds
      }
    });
  } catch (error) {
    console.error('Error estimating route ETAs:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to estimate route ETAs' });
  }
});

// @desc    Get all deliveries
// @route   GET /api/deliveries
// @access  Private
router.get('/', async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 10, 
      status, 
      driver, 
      company, 
      customerId,
      type,
      dateFrom, 
      dateTo,
      search 
    } = req.query;

    const parsedPage = Number.parseInt(page, 10);
    const parsedLimit = Number.parseInt(limit, 10);
    const safePage = Number.isNaN(parsedPage) || parsedPage < 1 ? 1 : parsedPage;
    const MAX_LIMIT = 500;
    const safeLimit = Number.isNaN(parsedLimit) || parsedLimit < 1
      ? 10
      : Math.min(parsedLimit, MAX_LIMIT);

    const query = {};

    if (status) query.status = status;
    if (type) query.type = type;
    if (driver) query.driver = driver;
    if (company) query.company = company;
    if (customerId) query.customerId = customerId;
    
    // Date range filter
    if (dateFrom || dateTo) {
      query.scheduledTime = {};
      if (dateFrom) query.scheduledTime.$gte = new Date(dateFrom);
      if (dateTo) query.scheduledTime.$lte = new Date(dateTo);
    }

    // Search filter
    if (search) {
      query.$or = [
        { customerName: { $regex: search, $options: 'i' } },
        { customerId: { $regex: search, $options: 'i' } },
        { address: { $regex: search, $options: 'i' } }
      ];
    }

    // Drivers can only see their own deliveries
    if (req.user.role === 'driver') {
      query.driver = req.user._id;
    }

    const deliveries = await Delivery.find(query)
      .populate('driver', 'profile.firstName profile.lastName profile.colorCode email')
      .limit(safeLimit)
      .skip((safePage - 1) * safeLimit)
      .sort({ scheduledTime: 1 })
      .lean();

    const timedDeliveries = deliveries.map(delivery => enrichDeliveryTiming(delivery));
    const combinedDeliveries = await applyWeekendCombining(timedDeliveries);
    const enhancedDeliveries = await injectSundayOnlyIntoSaturday(query, dateFrom, dateTo, combinedDeliveries);

    const total = await Delivery.countDocuments(query);

    res.json({
      success: true,
      data: {
        deliveries: enhancedDeliveries,
        pagination: {
          page: safePage,
          limit: safeLimit,
          total,
          pages: Math.ceil(total / safeLimit)
        }
      }
    });
  } catch (error) {
    console.error('Get deliveries error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

function normalizeBagId(bagId) {
  return typeof bagId === 'string' ? bagId.trim().toUpperCase() : '';
}

function resolveUserDisplayName(user) {
  if (!user) {
    return undefined;
  }

  const nameParts = [
    user.profile?.firstName,
    user.profile?.lastName,
  ].filter(Boolean);

  if (nameParts.length > 0) {
    return nameParts.join(' ').trim();
  }

  return user.name || user.email || undefined;
}

function normalizeLocationPayload(raw) {
  if (!raw) {
    return null;
  }

  let payload = raw;
  if (typeof raw === 'string') {
    try {
      payload = JSON.parse(raw);
    } catch {
      return null;
    }
  }

  if (payload && typeof payload === 'object') {
    const lat =
      typeof payload.lat === 'number'
        ? payload.lat
        : typeof payload.latitude === 'number'
        ? payload.latitude
        : typeof payload.coords?.latitude === 'number'
        ? payload.coords.latitude
        : undefined;

    const lng =
      typeof payload.lng === 'number'
        ? payload.lng
        : typeof payload.longitude === 'number'
        ? payload.longitude
        : typeof payload.coords?.longitude === 'number'
        ? payload.coords.longitude
        : undefined;

    const accuracy =
      typeof payload.accuracy === 'number'
        ? payload.accuracy
        : typeof payload.coords?.accuracy === 'number'
        ? payload.coords.accuracy
        : undefined;

    if (typeof lat === 'number' && typeof lng === 'number') {
      return { lat, lng, accuracy };
    }
  }

  return null;
}

// Normalizes free-text location-type input (from the bulk import sheet, a
// batch-wide default, or manual entry) to the schema's enum, or null when it
// doesn't recognize the value — never lets a stray string reach Mongoose and
// fail the addressDetails.locationType enum validation.
function normalizeLocationType(value) {
  const cleaned = String(value || '').trim().toLowerCase();
  if (!cleaned) return null;
  if (['villa', 'house', 'townhouse', 'v'].includes(cleaned)) return 'Villa';
  if (['apartment', 'apt', 'flat', 'a'].includes(cleaned)) return 'Apartment';
  return null;
}

function getUserId(user) {
  if (!user) {
    return null;
  }

  if (typeof user === 'string') {
    return user;
  }

  if (user._id) {
    return user._id.toString();
  }

  if (user.id) {
    return user.id.toString();
  }

  try {
    return user.toString();
  } catch {
    return null;
  }
}

function getDeliveryDriverId(delivery) {
  if (!delivery || !delivery.driver) {
    return null;
  }

  if (delivery.driver._id) {
    return delivery.driver._id.toString();
  }

  try {
    return delivery.driver.toString();
  } catch {
    return null;
  }
}

async function releaseBagAssignment(bagId) {
  const normalizedId = normalizeBagId(bagId);
  if (!normalizedId) return;

  const bag = await Bag.findOne({ bagId: normalizedId });
  if (!bag) return;

  bag.status = 'available';
  bag.location = 'warehouse';
  bag.assignedTo = undefined;
  bag.currentDelivery = undefined;
  await bag.save();
}

async function applyBagAssignmentToDelivery(delivery, bagId, assignedBy) {
  const normalizedId = normalizeBagId(bagId);
  if (!normalizedId) {
    throw Object.assign(new Error('Bag ID is required'), { statusCode: 400 });
  }

  if (delivery.bagAssignment?.bagId && delivery.bagAssignment.bagId !== normalizedId) {
    await releaseBagAssignment(delivery.bagAssignment.bagId);
  }

  let bag = await Bag.findOne({ bagId: normalizedId });
  let isNewBag = false;
  if (!bag) {
    // Drivers scan physical bag tags that may not have been registered in
    // inventory yet (new bags, warehouse onboarding gaps). Auto-provision
    // the bag instead of blocking delivery completion — but still reject
    // scans that clearly aren't a bag code at all (garbage QR, wrong item).
    if (!/^BAG[-_]/.test(normalizedId)) {
      throw Object.assign(new Error('Bag not found'), { statusCode: 404 });
    }
    isNewBag = true;
    bag = new Bag({
      bagId: normalizedId,
      notes: 'Auto-created on first scan — bag was not pre-registered in inventory',
    });
  }

  bag.status = 'assigned';
  bag.location = 'driver';
  bag.currentDelivery = delivery._id;
  bag.assignedTo = {
    driver: delivery.driver,
    customer: {
      customerId: delivery.customerId,
      customerName: delivery.customerName
    },
    assignmentTime: new Date()
  };
  if (isNewBag) {
    if (!bag.$locals) bag.$locals = {};
    bag.$locals.historyNote = 'Auto-created and assigned (bag ID not found in inventory)';
  }
  await bag.save();

  delivery.bagAssignment = {
    bagId: normalizedId,
    assignedAt: new Date(),
    assignedBy,
    status: 'assigned'
  };
}

function enrichDeliveryTiming(delivery) {
  if (!delivery || !delivery.scheduledTime) {
    return delivery;
  }

  const scheduled = new Date(delivery.scheduledTime);
  const delivered = delivery.deliveredTime ? new Date(delivery.deliveredTime) : null;
  const earlyThreshold = new Date(scheduled.getTime() - (180 * 60 * 1000));

  let lateMinutes = delivery.lateMinutes ?? 0;
  let earlyMinutes = delivery.earlyMinutes ?? 0;
  let deliveryType = delivery.deliveryType ?? 'on-time';

  if (delivered && !Number.isNaN(delivered.getTime())) {
    const diffMinutes = Math.round((delivered - scheduled) / (1000 * 60));
    const computedEarlyMinutes = delivered < earlyThreshold
      ? Math.max(0, Math.round((earlyThreshold - delivered) / (1000 * 60)))
      : 0;
    const computedLateMinutes = diffMinutes > 0 ? diffMinutes : 0;

    earlyMinutes = computedEarlyMinutes;
    lateMinutes = computedLateMinutes;

    if (computedLateMinutes > 0) {
      deliveryType = 'late';
    } else if (computedEarlyMinutes > 0) {
      deliveryType = 'early';
    } else {
      deliveryType = 'on-time';
    }
  } else {
    earlyMinutes = 0;
    lateMinutes = 0;
    if (!['early', 'late'].includes(deliveryType)) {
      deliveryType = 'on-time';
    }
  }

  return {
    ...delivery,
    earlyMinutes,
    lateMinutes,
    deliveryType
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function isBusinessSaturday(scheduledTime) {
  const local = new Date(new Date(scheduledTime).getTime() + LOCAL_TZ_OFFSET_MS);
  return local.getUTCDay() === 6;
}

function isBusinessSunday(scheduledTime) {
  const local = new Date(new Date(scheduledTime).getTime() + LOCAL_TZ_OFFSET_MS);
  return local.getUTCDay() === 0;
}

// Weekend combining (owner, 2026-09-14, refined same day: "no delivery
// should be seen on Sunday, all should be seen on Saturday, and this should
// go through the API"): when a customer has a delivery on both Saturday and
// the immediately-following Sunday, the two are combined into one physical
// drop — the Saturday delivery is annotated with `combinedSunday`, and the
// Sunday delivery is REMOVED from list results entirely (list endpoints
// only — a direct fetch by id still returns the real document, annotated
// with `combinedIntoSaturday` instead, so it's never truly invisible, just
// absent from the day-to-day lists where a driver/dispatcher would
// otherwise think it still needs a separate trip).
async function applyWeekendCombining(deliveries) {
  const saturdayIds = new Set();
  const saturdayDeliveries = [];
  const sundayIds = new Set();
  const sundayDeliveries = [];
  for (const d of deliveries) {
    if (!d.scheduledTime || d.type === 'Task') continue;
    if (isBusinessSaturday(d.scheduledTime)) {
      saturdayIds.add(String(d._id));
      saturdayDeliveries.push(d);
    } else if (isBusinessSunday(d.scheduledTime)) {
      sundayIds.add(String(d._id));
      sundayDeliveries.push(d);
    }
  }
  if (saturdayDeliveries.length === 0 && sundayDeliveries.length === 0) return deliveries;

  // --- Saturday -> does the same customer have a Sunday delivery? ---
  // Grouped by the Sunday window immediately following each Saturday
  // delivery, so one query covers every customer sharing that window.
  const sundayWindows = new Map();
  for (const delivery of saturdayDeliveries) {
    const { startOfDay } = getBusinessDayBounds(delivery.scheduledTime);
    const sundayStart = new Date(startOfDay.getTime() + DAY_MS);
    const key = sundayStart.getTime();
    if (!sundayWindows.has(key)) sundayWindows.set(key, { sundayStart, customerIds: new Set() });
    sundayWindows.get(key).customerIds.add(delivery.customerId);
  }
  // customerId + Sunday-window key -> that Sunday's delivery, so a customer
  // appearing under two different Saturdays (a wide date range) can't
  // cross-match to the wrong week.
  const sundayByKey = new Map();
  for (const { sundayStart, customerIds } of sundayWindows.values()) {
    const sundayEndExclusive = new Date(sundayStart.getTime() + DAY_MS);
    const found = await Delivery.find({
      customerId: { $in: [...customerIds] },
      type: 'Delivery',
      scheduledTime: { $gte: sundayStart, $lt: sundayEndExclusive }
    }).select('customerId scheduledTime').lean();
    for (const sd of found) sundayByKey.set(`${sd.customerId}|${sundayStart.getTime()}`, sd);
  }

  // --- Sunday -> does the same customer have a Saturday delivery? ---
  // A separate reverse lookup, since a Sunday-only query (e.g. the
  // dispatcher table filtered to just that day) wouldn't have the Saturday
  // sibling in the current result set to cross-reference against.
  const saturdayWindows = new Map();
  for (const delivery of sundayDeliveries) {
    const { startOfDay } = getBusinessDayBounds(delivery.scheduledTime);
    const saturdayStart = new Date(startOfDay.getTime() - DAY_MS);
    const key = saturdayStart.getTime();
    if (!saturdayWindows.has(key)) saturdayWindows.set(key, { saturdayStart, customerIds: new Set() });
    saturdayWindows.get(key).customerIds.add(delivery.customerId);
  }
  const saturdaySiblingByKey = new Map();
  for (const { saturdayStart, customerIds } of saturdayWindows.values()) {
    const saturdayEndExclusive = new Date(saturdayStart.getTime() + DAY_MS);
    const found = await Delivery.find({
      customerId: { $in: [...customerIds] },
      type: 'Delivery',
      scheduledTime: { $gte: saturdayStart, $lt: saturdayEndExclusive }
    }).select('customerId scheduledTime').lean();
    for (const sat of found) saturdaySiblingByKey.set(`${sat.customerId}|${saturdayStart.getTime()}`, sat);
  }

  const excludedSundayIds = new Set();
  for (const delivery of sundayDeliveries) {
    const { startOfDay } = getBusinessDayBounds(delivery.scheduledTime);
    const saturdayStart = new Date(startOfDay.getTime() - DAY_MS);
    if (saturdaySiblingByKey.has(`${delivery.customerId}|${saturdayStart.getTime()}`)) {
      excludedSundayIds.add(String(delivery._id));
    }
  }

  return deliveries
    .filter((d) => !excludedSundayIds.has(String(d._id)))
    .map((delivery) => {
      if (!saturdayIds.has(String(delivery._id))) return delivery;
      const { startOfDay } = getBusinessDayBounds(delivery.scheduledTime);
      const sundayStart = new Date(startOfDay.getTime() + DAY_MS);
      const match = sundayByKey.get(`${delivery.customerId}|${sundayStart.getTime()}`);
      if (!match) return delivery;
      return {
        ...delivery,
        combinedSunday: {
          deliveryId: String(match._id),
          scheduledTime: match.scheduledTime
        }
      };
    });
}

// Sunday-only carryover: a customer who has ONLY a Sunday delivery (no
// Saturday order at all — so applyWeekendCombining above has nothing to
// combine) still needs a physical drop-off on Saturday's route, since no
// separate Sunday route exists. When the request is for a single business
// Saturday's deliveries (the normal day-view fetch), pull those Sunday-only
// records into the result too, annotated with `sundayOnlyCarriedOver` so the
// UI/prints can call out that the meal itself is for Sunday even though it
// rides along on Saturday's route (their own real `scheduledTime` stays
// Sunday's date, so stickers/bag tags built from it are already correct).
// Scoped to the unfiltered dispatcher view (no driver constraint) since the
// Sunday record carries no driver/route of its own to filter against.
async function injectSundayOnlyIntoSaturday(query, dateFrom, dateTo, deliveries) {
  if (query.driver || (query.type && query.type !== 'Delivery')) return deliveries;
  if (!dateFrom || !dateTo) return deliveries;

  const from = new Date(dateFrom);
  const to = new Date(dateTo);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return deliveries;
  if (to.getTime() - from.getTime() !== DAY_MS) return deliveries;
  if (!isBusinessSaturday(from)) return deliveries;

  const { startOfDay: saturdayStart } = getBusinessDayBounds(from);
  const sundayStart = new Date(saturdayStart.getTime() + DAY_MS);
  const sundayEndExclusive = new Date(sundayStart.getTime() + DAY_MS);

  const sundayDeliveries = await Delivery.find({
    type: 'Delivery',
    scheduledTime: { $gte: sundayStart, $lt: sundayEndExclusive }
  })
    .populate('driver', 'profile.firstName profile.lastName profile.colorCode email')
    .lean();
  if (sundayDeliveries.length === 0) return deliveries;

  const saturdayCustomerIds = new Set(deliveries.map((d) => d.customerId));
  const sundayOnly = sundayDeliveries.filter((d) => !saturdayCustomerIds.has(d.customerId));
  if (sundayOnly.length === 0) return deliveries;

  const carriedOver = sundayOnly.map((d) => ({
    ...enrichDeliveryTiming(d),
    sundayOnlyCarriedOver: true
  }));

  return [...deliveries, ...carriedOver];
}

// Single-record version for GET /:id — never removes the record (a direct
// fetch by id must always return something), just annotates whichever side
// applies: `combinedSunday` on a Saturday delivery, or `combinedIntoSaturday`
// on a Sunday delivery that a list view would have hidden.
async function annotateWeekendCombo(delivery) {
  if (!delivery?.scheduledTime || delivery.type === 'Task') return delivery;
  if (isBusinessSaturday(delivery.scheduledTime)) {
    const { startOfDay } = getBusinessDayBounds(delivery.scheduledTime);
    const sundayStart = new Date(startOfDay.getTime() + DAY_MS);
    const sundayEndExclusive = new Date(sundayStart.getTime() + DAY_MS);
    const match = await Delivery.findOne({
      customerId: delivery.customerId,
      type: 'Delivery',
      scheduledTime: { $gte: sundayStart, $lt: sundayEndExclusive }
    }).select('scheduledTime').lean();
    if (match) {
      return { ...delivery, combinedSunday: { deliveryId: String(match._id), scheduledTime: match.scheduledTime } };
    }
  } else if (isBusinessSunday(delivery.scheduledTime)) {
    const { startOfDay } = getBusinessDayBounds(delivery.scheduledTime);
    const saturdayStart = new Date(startOfDay.getTime() - DAY_MS);
    const saturdayEndExclusive = new Date(saturdayStart.getTime() + DAY_MS);
    const match = await Delivery.findOne({
      customerId: delivery.customerId,
      type: 'Delivery',
      scheduledTime: { $gte: saturdayStart, $lt: saturdayEndExclusive }
    }).select('scheduledTime').lean();
    if (match) {
      return { ...delivery, combinedIntoSaturday: { deliveryId: String(match._id), scheduledTime: match.scheduledTime } };
    }
    // No Saturday sibling — this customer only has a Sunday meal, which
    // still rides along on Saturday's route (mirrors injectSundayOnlyIntoSaturday
    // above, for whoever opens this Sunday delivery's own detail page directly).
    return { ...delivery, sundayOnlyCarriedOver: true };
  }
  return delivery;
}

// Monthly delivery count grouped by customerId
// GET /api/deliveries/monthly-count?dateFrom=2026-05-01&dateTo=2026-05-31
router.get('/monthly-count', async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    if (!dateFrom || !dateTo) {
      return res.status(400).json({ success: false, message: 'dateFrom and dateTo are required' });
    }
    const start = new Date(dateFrom);
    const end = new Date(dateTo);
    end.setHours(23, 59, 59, 999);

    const results = await Delivery.aggregate([
      { $match: { scheduledTime: { $gte: start, $lte: end }, type: { $ne: 'Task' } } },
      { $group: { _id: '$customerId', count: { $sum: 1 } } },
      { $project: { _id: 0, customerId: '$_id', count: 1 } },
    ]);

    res.json({ success: true, data: results });
  } catch (error) {
    console.error('Monthly count error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Non-cancelled deliveries per business day per customer, for the Subscription
// & Sales dashboard. The list endpoint caps a page at 500 rows, far below a
// month of deliveries (~5,000), so the dashboard counts here instead of
// downloading rows.
// GET /api/deliveries/daily-customer-counts?dateFrom=2026-10-01&dateTo=2026-10-21
// (inclusive business-day keys, Dubai time)
router.get('/daily-customer-counts', async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    if (!isDateKey(dateFrom) || !isDateKey(dateTo) || dateFrom > dateTo) {
      return res.status(400).json({ success: false, message: 'dateFrom and dateTo must be YYYY-MM-DD, dateFrom not after dateTo' });
    }
    const start = getBusinessDayBounds(dateFrom).startOfDay;
    const end = getBusinessDayBounds(dateTo).endOfDayExclusive;
    const offsetMin = Math.round(businessOffsetMs() / 60000);
    const sign = offsetMin < 0 ? '-' : '+';
    const hh = String(Math.floor(Math.abs(offsetMin) / 60)).padStart(2, '0');
    const mm = String(Math.abs(offsetMin) % 60).padStart(2, '0');

    const results = await Delivery.aggregate([
      { $match: {
        scheduledTime: { $gte: start, $lt: end },
        type: 'Delivery',
        status: { $ne: 'cancelled' },
        customerId: { $nin: [null, ''] }
      } },
      { $group: {
        _id: {
          day: { $dateToString: { format: '%Y-%m-%d', date: '$scheduledTime', timezone: `${sign}${hh}:${mm}` } },
          customerId: '$customerId'
        },
        count: { $sum: 1 }
      } },
      { $project: { _id: 0, day: '$_id.day', customerId: '$_id.customerId', count: 1 } }
    ]);

    res.json({ success: true, data: results });
  } catch (error) {
    console.error('Daily customer counts error:', error);
    res.status(500).json({ success: false, message: 'Error fetching delivery counts' });
  }
});

// Get late and early deliveries
router.get('/late-early',  async (req, res) => {
  try {
    const { startDate, endDate, type = 'all' } = req.query;
    
    // Default to today if no dates provided
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const rangeStart = startDate ? new Date(startDate) : new Date(today);
    if (Number.isNaN(rangeStart.getTime())) {
      return res.status(400).json({
        message: 'Invalid start date format. Expected YYYY-MM-DD.'
      });
    }
    rangeStart.setHours(0, 0, 0, 0);

    const endBase = endDate ? new Date(endDate) : new Date(rangeStart);
    if (Number.isNaN(endBase.getTime())) {
      return res.status(400).json({
        message: 'Invalid end date format. Expected YYYY-MM-DD.'
      });
    }
    endBase.setHours(0, 0, 0, 0);

    const rangeEndExclusive = new Date(endBase);
    rangeEndExclusive.setDate(rangeEndExclusive.getDate() + 1);

    if (rangeEndExclusive <= rangeStart) {
      return res.status(400).json({
        message: 'End date must be on or after the start date.'
      });
    }

    // Get all deliveries in the date range (for total count)
    const allDeliveriesInRange = await Delivery.countDocuments({
      scheduledTime: {
        $gte: rangeStart,
        $lt: rangeEndExclusive
      }
    });

    // Get incomplete deliveries (not delivered) in the date range
    const incompleteDeliveries = await Delivery.countDocuments({
      scheduledTime: {
        $gte: rangeStart,
        $lt: rangeEndExclusive
      },
      status: { $ne: 'delivered' }
    });

    // Base query for delivered deliveries within date range
    let baseQuery = {
      status: 'delivered',
      deliveredTime: {
        $gte: rangeStart,
        $lt: rangeEndExclusive
      }
    };

    // Add coarse type filter. We skip the on-time case here to avoid dropping
    // records where lateMinutes/earlyMinutes were never persisted (we refine
    // the set after computing exact timing deltas below).
    if (type === 'late') {
      baseQuery.lateMinutes = { $gt: 0 };
    } else if (type === 'early') {
      baseQuery.earlyMinutes = { $gt: 0 };
    }

    const deliveries = await Delivery.find(baseQuery)
      .populate('driver', 'profile.firstName profile.lastName profile.colorCode email')
      .sort({ deliveredTime: -1 })
      .lean();

    // Calculate late/early minutes and enhance data
    const enhancedDeliveries = deliveries.map(delivery => {
      const scheduledTime = new Date(delivery.scheduledTime);
      const deliveredTime = new Date(delivery.deliveredTime);

      const diffMinutes = Math.round((deliveredTime - scheduledTime) / (1000 * 60));
      const earlyThresholdTime = new Date(scheduledTime.getTime() - (180 * 60 * 1000));

      const isLate = diffMinutes > 0;
      const isEarly = deliveredTime < earlyThresholdTime;

      const earlyMinutes = isEarly
        ? Math.max(0, Math.round((earlyThresholdTime - deliveredTime) / (1000 * 60)))
        : 0;

      return {
        ...delivery,
        actualLateMinutes: isLate ? diffMinutes : 0,
        earlyMinutes,
        deliveryType: isEarly ? 'early' : isLate ? 'late' : 'on-time',
        scheduledTime,
        deliveredTime
      };
    });

    // Filter based on type after calculation
    let filteredDeliveries = enhancedDeliveries;
    if (type === 'late') {
      filteredDeliveries = enhancedDeliveries.filter(d => d.deliveryType === 'late');
    } else if (type === 'early') {
      filteredDeliveries = enhancedDeliveries.filter(d => d.deliveryType === 'early');
    } else if (type === 'on-time') {
      filteredDeliveries = enhancedDeliveries.filter(d => d.deliveryType === 'on-time');
    }

    // Get statistics
    const stats = {
      total: allDeliveriesInRange,
      completed: enhancedDeliveries.length,
      incomplete: incompleteDeliveries,
      late: enhancedDeliveries.filter(d => d.deliveryType === 'late').length,
      early: enhancedDeliveries.filter(d => d.deliveryType === 'early').length,
      onTime: enhancedDeliveries.filter(d => d.deliveryType === 'on-time').length,
      avgLateTime: enhancedDeliveries.filter(d => d.deliveryType === 'late').length > 0 
        ? Math.round(enhancedDeliveries.filter(d => d.deliveryType === 'late')
            .reduce((sum, d) => sum + d.actualLateMinutes, 0) / 
            enhancedDeliveries.filter(d => d.deliveryType === 'late').length)
        : 0,
      avgEarlyTime: enhancedDeliveries.filter(d => d.deliveryType === 'early').length > 0 
        ? Math.round(enhancedDeliveries.filter(d => d.deliveryType === 'early')
            .reduce((sum, d) => sum + d.earlyMinutes, 0) / 
            enhancedDeliveries.filter(d => d.deliveryType === 'early').length)
        : 0
    };

    res.json({
      deliveries: filteredDeliveries,
      stats,
      dateRange: {
        start: rangeStart,
        end: endBase
      }
    });

  } catch (error) {
    console.error('Late/early deliveries error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Dashboard delivery overview. Both endpoints take an inclusive Dubai-day range
// (start/end = YYYY-MM-DD) plus optional search / zone / driver / status / customerId
// filters. They must stay above '/:id'.
const TIMING_FILTER_KEYS = ['search', 'zone', 'driver', 'status', 'customerId'];
const pickTimingFilters = (query) => Object.fromEntries(
  TIMING_FILTER_KEYS.filter((key) => query[key] !== undefined).map((key) => [key, String(query[key])])
);
const isRangeError = (error) => /YYYY-MM-DD|End date/.test(error.message);

// Per-day counts (+ per-hour for a single day), lateness stats and filter options.
router.get('/timing-history', async (req, res) => {
  try {
    const range = businessRangeBounds(req.query.start, req.query.end);
    const data = await getTimingOverview(range, pickTimingFilters(req.query), {
      hourly: req.query.start === req.query.end,
    });
    res.json({ success: true, data: { ...data, updatedAt: new Date().toISOString() } });
  } catch (error) {
    if (isRangeError(error)) return res.status(400).json({ success: false, message: error.message });
    console.error('Timing history error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Records behind the table, a chart segment or a CSV export (large limit).
router.get('/timing-records', async (req, res) => {
  try {
    const range = businessRangeBounds(req.query.start, req.query.end);
    const data = await getTimingRecords(range, pickTimingFilters(req.query), {
      timing: req.query.timing,
      hour: req.query.hour ?? null,
      page: req.query.page,
      limit: req.query.limit,
    });
    res.json({ success: true, data });
  } catch (error) {
    if (isRangeError(error)) return res.status(400).json({ success: false, message: error.message });
    console.error('Timing records error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @desc    Get delivery by ID
// @route   GET /api/deliveries/:id
// @access  Private
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid delivery ID',
      });
    }

    const delivery = await Delivery.findById(req.params.id)
      .populate('driver', 'profile.firstName profile.lastName profile.colorCode location email');

    if (!delivery) {
      return res.status(404).json({
        success: false,
        message: 'Delivery not found'
      });
    }

    // Check if driver is accessing their own delivery
    if (req.user.role === 'driver') {
      const deliveryDriverId = getDeliveryDriverId(delivery);
      const requesterId = getUserId(req.user);
      if (!deliveryDriverId || !requesterId || deliveryDriverId !== requesterId) {
        return res.status(403).json({
          success: false,
          message: 'Access denied'
        });
      }
    }

    const deliveryObject = delivery.toObject ? delivery.toObject({ virtuals: true }) : delivery;
    const timedDelivery = enrichDeliveryTiming(deliveryObject);
    const enrichedDelivery = await annotateWeekendCombo(timedDelivery);

    // Street address of where the driver's phone reported the drop-off (the
    // app only sends coordinates). Looked up once, saved, and cached.
    if (enrichedDelivery.proof?.location && !enrichedDelivery.proof.location.address) {
      const dropOffAddress = await resolveProofAddressWithin(enrichedDelivery);
      if (dropOffAddress) enrichedDelivery.proof.location.address = dropOffAddress;
    }

    // Fetch bags that are either assigned to this delivery or to this customer
    const bags = await Bag.find({
      $or: [
        { currentDelivery: delivery._id },
        { 'assignedTo.customer.customerId': delivery.customerId }
      ]
    })
      .select('bagId status condition assignedTo notes location')
      .populate('assignedTo.driver', 'profile.firstName profile.lastName profile.colorCode');

    res.json({
      success: true,
      data: { delivery: enrichedDelivery, bags }
    });
  } catch (error) {
    // Improved logging for debugging: include params and user info
    try {
      console.error('Get delivery error:', {
        message: error.message,
        stack: error.stack,
        params: req.params,
        user: req.user ? { id: req.user._id, role: req.user.role } : null
      });
    } catch (logErr) {
      console.error('Error logging failure in get delivery catch:', logErr);
      console.error('Original error:', error);
    }

    // Return the error message in development to help diagnose (remove or sanitize in production)
    res.status(500).json({
      success: false,
      message: error.message || 'Server error',
      // include basic info for debugging
      error: process.env.NODE_ENV === 'production' ? undefined : (error.stack || error.message)
    });
  }
});

// @desc    Create new delivery
// @route   POST /api/deliveries
// @access  Private/Admin
router.post('/', [
  body('customerId').notEmpty(),
  body('customerName').notEmpty(),
  body('scheduledTime').isISO8601(),
  body('driver').optional({ nullable: true, checkFalsy: true }).isMongoId(),
  body('company').optional({ checkFalsy: true }).isString().trim().isLength({ max: 100 }),
  body('address').if(body('type').not().equals('Collection')).notEmpty()
], authorize(['admin', 'super_admin', 'dispatcher', 'manager']), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const deliveryData = req.body;

    // Normalize scheduledTime to UTC using configured local offset
    const normalizedScheduled = normalizeScheduledTimeInput(deliveryData.scheduledTime);
    if (!normalizedScheduled) {
      return res.status(400).json({
        success: false,
        message: 'Invalid scheduledTime. Provide a valid datetime-local value.'
      });
    }
    deliveryData.scheduledTime = normalizedScheduled;

    const normalizedScheduledTime = normalizeScheduledTimeInput(deliveryData.scheduledTime);
    if (!normalizedScheduledTime) {
      return res.status(400).json({
        success: false,
        message: 'Invalid scheduledTime; please provide a valid date/time'
      });
    }
    deliveryData.scheduledTime = normalizedScheduledTime;

    // Default company when not provided or blank
    if (!deliveryData.company || !deliveryData.company.trim()) {
      deliveryData.company = 'Matter';
    }

    if (deliveryData.addressDetails || deliveryData.locationType) {
      const locationType = normalizeLocationType(deliveryData.addressDetails?.locationType || deliveryData.locationType);
      deliveryData.addressDetails = { ...(deliveryData.addressDetails || {}), locationType };
    }

    // Auto-detect area from address if address is provided and area is empty/missing
    if (deliveryData.address && (!deliveryData.zone || deliveryData.zone.trim() === '')) {
      const detectedArea = detectAreaFromAddress(deliveryData.address, '', {
        company: deliveryData.company || ''
      });
      if (detectedArea) {
        deliveryData.zone = detectedArea;
        console.log(`🗺️ Area auto-detection on creation: "${detectedArea}" for address: "${deliveryData.address}"`);
      }
    }

    // Pin from what the delivery already carries: its own coordinates, a
    // Google Maps link, or the customer's saved pin for this exact address.
    // No address guessing — unpinned deliveries wait for a dispatcher (see
    // resolveDeliveryCoordinates in services/geocoding.js).
    if (!deliveryData.lat || !deliveryData.lng) {
      if (!deliveryData.gpsLocation || !deliveryData.gpsLocation.lat || !deliveryData.gpsLocation.lng) {
        try {
          const coords = await resolveDeliveryCoordinatesCached(deliveryData);
          if (coords) {
            deliveryData.gpsLocation = {
              lat: coords.lat,
              lng: coords.lng,
              link: deliveryData.mapsUrl || undefined
            };
            // Also set top-level for easier access
            deliveryData.lat = coords.lat;
            deliveryData.lng = coords.lng;
            console.log(`📍 Coordinates resolved for delivery:`, coords);
          }
        } catch (err) {
          console.warn('Coordinate lookup failed (non-blocking):', err.message);
        }
      }
    }

    // Create delivery
    const delivery = await Delivery.create(deliveryData);

    // Check for and apply any pending changes
    const appliedChangesCount = await checkAndApplyPendingChanges(delivery);
    
    if (appliedChangesCount > 0) {
      console.log(`Applied ${appliedChangesCount} pending change(s) to delivery ${delivery._id}`);
      // Refresh delivery data after applying changes
      await delivery.populate('driver', 'profile.firstName profile.lastName profile.colorCode email');
    } else {
      // Populate driver info for response
      await delivery.populate('driver', 'profile.firstName profile.lastName profile.colorCode email');
    }

    // Emit real-time update
    const io = req.app.get('io');
    if (io) {
      io.emit('delivery:created', delivery);
    } else {
      console.warn('Socket.io not initialized - cannot emit delivery:created');
    }

    if (delivery.driver) {
      sendDeliveryPushToDriver({ driverId: delivery.driver._id || delivery.driver, type: 'delivery_created', delivery }).catch((err) => {
        console.warn('Delivery-created push notify failed (caught):', err?.message || err);
      });
    }

    // Notify Slack only for manually created single deliveries (not bulk)
    if ((delivery.type || deliveryData.type) !== 'Task' && (delivery.type || deliveryData.type) !== 'Collection') {
      const actorLabel = resolveUserDisplayName(req.user) || req.user?.email || req.user?._id?.toString();
      notifyManualDeliverySlack(delivery, actorLabel).catch((err) => {
        console.warn('Manual delivery Slack notify failed (caught):', err?.message || err);
      });
    }

    res.status(201).json({
      success: true,
      message: appliedChangesCount > 0 
        ? `Delivery created successfully with ${appliedChangesCount} pending change(s) applied`
        : 'Delivery created successfully',
      data: { delivery }
    });
  } catch (error) {
    console.error('Create delivery error:', error);
    console.error('Error stack:', error.stack);
    console.error('Delivery data that caused error:', req.body);
    
    res.status(500).json({
      success: false,
      message: error.message || 'Server error',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// @desc    Create multiple deliveries in bulk
// @route   POST /api/deliveries/bulk
// @access  Private/Admin
router.post('/bulk', [
  body('deliveries').isArray({ min: 1 }).withMessage('deliveries array is required and must have at least 1 item'),
  body('deliveries.*.customerId').notEmpty().withMessage('customerId is required'),
  body('deliveries.*.customerName').notEmpty().withMessage('customerName is required'),
  body('deliveries.*.scheduledTime').isISO8601().withMessage('scheduledTime must be ISO8601 date'),
  body('deliveries.*.company').optional({ checkFalsy: true }).isString().trim().isLength({ max: 100 }).withMessage('company must be a string'),
  body('deliveries.*.address').notEmpty().withMessage('address is required')
], authorize(['admin', 'super_admin', 'dispatcher', 'manager']), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { deliveries: deliveryList } = req.body;
    const startTime = Date.now();
    console.log(`📦 Starting bulk delivery creation for ${deliveryList.length} deliveries...`);

    // Process deliveries to auto-detect areas and attach any known coordinates
    const processedDeliveries = await Promise.all(deliveryList.map(async (delivery) => {
      const deliveryData = { ...delivery };

      const normalizedScheduledTime = normalizeScheduledTimeInput(deliveryData.scheduledTime);
      if (!normalizedScheduledTime) {
        throw Object.assign(new Error('Invalid scheduledTime in bulk payload'), { statusCode: 400 });
      }
      deliveryData.scheduledTime = normalizedScheduledTime;

      // Default company when missing/blank
      if (!deliveryData.company || !deliveryData.company.trim()) {
        deliveryData.company = 'Matter';
      } else {
        deliveryData.company = deliveryData.company.trim();
      }

      if (deliveryData.addressDetails || deliveryData.locationType) {
        const locationType = normalizeLocationType(deliveryData.addressDetails?.locationType || deliveryData.locationType);
        deliveryData.addressDetails = { ...(deliveryData.addressDetails || {}), locationType };
      }

      // Auto-detect area from address if area is empty/missing
      if (deliveryData.address && (!deliveryData.zone || deliveryData.zone.trim() === '')) {
        const detectedArea = detectAreaFromAddress(deliveryData.address, '', {
          company: deliveryData.company || ''
        });
        if (detectedArea) {
          deliveryData.zone = detectedArea;
        }
      }

      // Pin from what the delivery already carries: its own coordinates, a
      // Google Maps link, or the customer's saved pin for this exact address
      // (resolveDeliveryCoordinatesCached — read-only, never calls Google).
      // An unpinned delivery stays unpinned for a dispatcher to place.
      if (!deliveryData.lat || !deliveryData.lng) {
        if (!deliveryData.gpsLocation || !deliveryData.gpsLocation.lat || !deliveryData.gpsLocation.lng) {
          try {
            const coords = await resolveDeliveryCoordinatesCached(deliveryData);
            if (coords) {
              deliveryData.gpsLocation = {
                lat: coords.lat,
                lng: coords.lng,
                link: deliveryData.mapsUrl || undefined
              };
              // Also set top-level for easier access
              deliveryData.lat = coords.lat;
              deliveryData.lng = coords.lng;
            }
          } catch (err) {
            console.warn('Coordinate lookup failed for bulk delivery (non-blocking):', err.message);
          }
        }
      }
      
      return deliveryData;
    }));

    // Insert all deliveries in one batch operation
    const createdDeliveries = await Delivery.insertMany(processedDeliveries, { ordered: false });
    console.log(`✅ Bulk inserted ${createdDeliveries.length} deliveries in ${Date.now() - startTime}ms`);

    // Check and apply pending changes to each delivery (can be parallelized)
    const changePromises = createdDeliveries.map(delivery => 
      checkAndApplyPendingChanges(delivery).then(count => ({
        deliveryId: delivery._id,
        changesApplied: count
      }))
    );

    const changeResults = await Promise.all(changePromises);
    const totalChangesApplied = changeResults.reduce((sum, r) => sum + r.changesApplied, 0);
    
    console.log(`✅ Applied ${totalChangesApplied} total pending changes across bulk deliveries`);

    // Populate driver info for all deliveries (batch populate)
    await Delivery.populate(createdDeliveries, { 
      path: 'driver', 
      select: 'profile.firstName profile.lastName profile.colorCode email' 
    });

    // Emit real-time updates for all created deliveries
    const io = req.app.get('io');
    if (io) {
      createdDeliveries.forEach(delivery => io.emit('delivery:created', delivery));
      console.log(`📡 Emitted delivery:created events for ${createdDeliveries.length} deliveries`);
    }

    const elapsedMs = Date.now() - startTime;
    console.log(`⏱️ Bulk delivery creation completed in ${elapsedMs}ms (${(elapsedMs / createdDeliveries.length).toFixed(2)}ms per delivery)`);

    res.status(201).json({
      success: true,
      message: `Successfully created ${createdDeliveries.length} deliveries${totalChangesApplied > 0 ? ` with ${totalChangesApplied} pending changes applied` : ''}`,
      data: {
        deliveries: createdDeliveries,
        totalCreated: createdDeliveries.length,
        // How many have no map pin (no coordinates, Maps link, or saved pin for
        // the address) — they wait for a dispatcher to place one.
        withoutPin: createdDeliveries.filter(
          (d) => !isPlausibleCoordinate(d.gpsLocation?.lat, d.gpsLocation?.lng)
        ).length,
        changesApplied: totalChangesApplied,
        processingTimeMs: elapsedMs
      }
    });
  } catch (error) {
    console.error('❌ Bulk delivery creation error:', error);
    const statusCode = error.statusCode && Number.isInteger(error.statusCode) ? error.statusCode : 500;
    res.status(statusCode).json({
      success: false,
      message: error.message || 'Server error during bulk creation',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Compute an optimized multi-driver route plan for a set of deliveries.
// Does not modify anything — the dispatcher reviews the proposed plan and
// calls /optimize-routes/apply to actually assign it. Expensive (geocoding
// + Distance Matrix API calls + an OR-Tools solve), same "on demand only"
// cost profile as other heavy endpoints in this codebase.
router.post('/optimize-routes', [
  body('deliveryIds').isArray({ min: 1 }).withMessage('deliveryIds array is required'),
  body('deliveryIds.*').isMongoId().withMessage('Invalid delivery ID'),
  body('driverIds').isArray({ min: 1 }).withMessage('driverIds array is required'),
  body('driverIds.*').isMongoId().withMessage('Invalid driver ID'),
  // Dispatcher controls, both one-time/per-plan — nothing is persisted.
  body('fixedDepartureSeconds').optional({ nullable: true }).isInt({ min: 0, max: 86399 })
    .withMessage('fixedDepartureSeconds must be seconds from midnight (0-86399)'),
  body('hubVans').optional().isArray().withMessage('hubVans must be an array'),
  body('hubVans.*.driverId').isMongoId().withMessage('Invalid hub van driver ID'),
  body('hubVans.*.hubReadySeconds').isInt({ min: 0, max: 86399 })
    .withMessage('hubReadySeconds must be seconds from midnight (0-86399)'),
  // Optional dispatcher-pinned meeting location for a hub van (dragged pin).
  body('hubVans.*.hubLocation.lat').optional().isFloat({ min: -90, max: 90 })
    .withMessage('hubLocation.lat must be a valid latitude'),
  body('hubVans.*.hubLocation.lng').optional().isFloat({ min: -180, max: 180 })
    .withMessage('hubLocation.lng must be a valid longitude'),
  // Simulation-only — previews "what if bikes carried more/fewer per trip"
  // without touching any driver's real profile.stopCapacity.
  body('bikeTripCapacity').optional({ nullable: true }).isInt({ min: 1, max: 200 })
    .withMessage('bikeTripCapacity must be 1-200'),
  // Simulation-only — caps how early a FLOATING departure may go, replacing
  // the real earliest-departure floor for this plan; ignored when
  // fixedDepartureSeconds is also set.
  body('maxEarlyDepartureSeconds').optional({ nullable: true }).isInt({ min: 0 })
    .withMessage('maxEarlyDepartureSeconds must be a non-negative number of seconds')
], authorize(['admin', 'super_admin', 'dispatcher', 'manager']), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
    }

    const { deliveryIds, driverIds, fixedDepartureSeconds, hubVans, bikeTripCapacity, maxEarlyDepartureSeconds } = req.body;
    const plan = await optimizeRoutes(deliveryIds, driverIds, {
      fixedDepartureSeconds: fixedDepartureSeconds ?? null,
      hubVans: hubVans || [],
      bikeTripCapacity: bikeTripCapacity ?? null,
      maxEarlyDepartureSeconds: maxEarlyDepartureSeconds ?? null
    });
    res.json({ success: true, data: plan });
  } catch (error) {
    console.error('Optimize routes error:', error.message);
    res.status(500).json({ success: false, message: error.message || 'Failed to optimize routes' });
  }
});

// Persist a route plan (from /optimize-routes, possibly dispatcher-edited)
// onto the underlying deliveries — sets driver, routeOrder, routeOptimizedAt —
// plus any van↔bike handoffs the plan included.
router.post('/optimize-routes/apply', [
  body('routes').isArray({ min: 1 }).withMessage('routes array is required'),
  body('routes.*.driverId').isMongoId().withMessage('Invalid driver ID'),
  body('routes.*.stops').isArray().withMessage('Each route needs a stops array'),
  body('routes.*.stops.*.deliveryId').isMongoId().withMessage('Invalid delivery ID'),
  body('routes.*.stops.*.routeOrder').isInt({ min: 0 }).withMessage('routeOrder must be a non-negative integer'),
  body('handoffs').optional().isArray().withMessage('handoffs must be an array'),
  body('handoffs.*.bikeDriverId').isMongoId().withMessage('Invalid bike driver ID'),
  body('handoffs.*.vanDriverId').isMongoId().withMessage('Invalid van driver ID'),
  body('handoffs.*.deliveryIds').isArray({ min: 1 }).withMessage('Each handoff needs deliveryIds'),
  body('handoffs.*.deliveryIds.*').isMongoId().withMessage('Invalid handoff delivery ID'),
  body('handoffs.*.meetingPoint.lat').isFloat().withMessage('meetingPoint.lat is required'),
  body('handoffs.*.meetingPoint.lng').isFloat().withMessage('meetingPoint.lng is required'),
  body('handoffs.*.vanAfterRouteOrder').isInt({ min: 0 }).withMessage('vanAfterRouteOrder must be a non-negative integer'),
  body('handoffs.*.bikeAfterRouteOrder').isInt({ min: 0 }).withMessage('bikeAfterRouteOrder must be a non-negative integer'),
  body('kitchenReturns').optional().isArray().withMessage('kitchenReturns must be an array'),
  body('kitchenReturns.*.bikeDriverId').isMongoId().withMessage('Invalid bike driver ID'),
  body('kitchenReturns.*.deliveryIds').isArray({ min: 1 }).withMessage('Each kitchen return needs deliveryIds'),
  body('kitchenReturns.*.deliveryIds.*').isMongoId().withMessage('Invalid kitchen return delivery ID'),
  body('kitchenReturns.*.afterRouteOrder').isInt({ min: 0 }).withMessage('afterRouteOrder must be a non-negative integer'),
  body('kitchenReturns.*.vanReason').optional().isString().withMessage('vanReason must be a string')
], authorize(['admin', 'super_admin', 'dispatcher', 'manager']), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
    }

    const result = await applyRoutePlan(
      req.body.routes,
      req.body.handoffs || [],
      req.body.kitchenReturns || [],
      { createdBy: req.user?._id }
    );
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Apply route plan error:', error.message);
    res.status(500).json({ success: false, message: error.message || 'Failed to apply route plan' });
  }
});

router.patch('/assign-driver', [
  body('deliveryIds').isArray({ min: 1 }).withMessage('deliveryIds array is required'),
  body('deliveryIds.*').isMongoId().withMessage('Invalid delivery ID'),
  body('driverId').isMongoId().withMessage('Valid driverId is required')
], authorize(['admin', 'super_admin', 'dispatcher', 'manager']), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { deliveryIds, driverId } = req.body;

    const driver = await User.findOne({ _id: driverId, role: 'driver' });
    if (!driver) {
      return res.status(404).json({
        success: false,
        message: 'Driver not found'
      });
    }

    const deliveries = await Delivery.find({ _id: { $in: deliveryIds } });
    if (deliveries.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No deliveries found for the provided IDs'
      });
    }

    const updatedDeliveries = [];
    const driverName = resolveUserDisplayName(driver) || driver.email || driver._id.toString();
    const reassignments = [];

    for (const delivery of deliveries) {
      const oldDriverId = delivery.driver ? delivery.driver.toString() : null;
      if (oldDriverId !== driverId) {
        reassignments.push({ delivery, oldDriverId });
      }
      delivery.driver = driverId;
      if (delivery.status === 'pending') {
        delivery.status = 'assigned';
      }

      if (!Array.isArray(delivery.timeline)) {
        delivery.timeline = [];
      }

      delivery.timeline.push({
        status: 'driver_assigned',
        timestamp: new Date(),
        notes: `Assigned to ${driverName}`
      });

      await delivery.save();
      await delivery.populate('driver', 'profile.firstName profile.lastName profile.colorCode email');
      updatedDeliveries.push(delivery);
    }

    const io = req.app.get('io');
    if (io) {
      updatedDeliveries.forEach(delivery => io.emit('delivery:updated', delivery));
    } else {
      console.warn('Socket.io not initialized - cannot emit delivery updates (assign-driver)');
    }

    const pushes = reassignments.flatMap(({ delivery, oldDriverId }) => {
      const jobs = [sendDeliveryPushToDriver({ driverId, type: 'delivery_reassigned', delivery })];
      if (oldDriverId) {
        jobs.push(sendDeliveryPushToDriver({ driverId: oldDriverId, type: 'delivery_removed', delivery }));
      }
      return jobs;
    });
    Promise.allSettled(pushes).catch(() => {});

    res.json({
      success: true,
      message: `Assigned ${updatedDeliveries.length} deliveries to ${driverName}`,
      data: { deliveries: updatedDeliveries }
    });
  } catch (error) {
    console.error('Assign driver to deliveries error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Statuses a delivery can no longer be pulled back from — it's already been
// carried out, so unassigning would just orphan a finished record.
const UNASSIGN_LOCKED_STATUSES = ['delivered', 'completed', 'collected'];

router.patch('/unassign-driver', [
  body('deliveryIds').isArray({ min: 1 }).withMessage('deliveryIds array is required'),
  body('deliveryIds.*').isMongoId().withMessage('Invalid delivery ID')
], authorize(['admin', 'super_admin', 'dispatcher', 'manager']), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { deliveryIds } = req.body;

    const deliveries = await Delivery.find({ _id: { $in: deliveryIds } });
    if (deliveries.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No deliveries found for the provided IDs'
      });
    }

    const unassignerName = resolveUserDisplayName(req.user) || req.user?.email || 'Dispatcher';
    const updatedDeliveries = [];
    const removedFromDrivers = [];

    for (const delivery of deliveries) {
      if (UNASSIGN_LOCKED_STATUSES.includes(delivery.status)) continue;

      const oldDriverId = delivery.driver ? delivery.driver.toString() : null;
      if (!oldDriverId) continue; // already unassigned

      delivery.driver = null;
      if (['assigned', 'on_route', 'picked_up'].includes(delivery.status)) {
        delivery.status = 'pending';
      }

      if (!Array.isArray(delivery.timeline)) {
        delivery.timeline = [];
      }
      delivery.timeline.push({
        status: 'driver_unassigned',
        timestamp: new Date(),
        notes: `Unassigned by ${unassignerName}`
      });

      await delivery.save();
      await delivery.populate('driver', 'profile.firstName profile.lastName profile.colorCode email');
      updatedDeliveries.push(delivery);
      removedFromDrivers.push({ driverId: oldDriverId, delivery });
    }

    if (updatedDeliveries.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Selected deliveries have no driver to unassign, or are already completed'
      });
    }

    const io = req.app.get('io');
    if (io) {
      updatedDeliveries.forEach(delivery => io.emit('delivery:updated', delivery));
    } else {
      console.warn('Socket.io not initialized - cannot emit delivery updates (unassign-driver)');
    }

    const pushes = removedFromDrivers.map(({ driverId, delivery }) =>
      sendDeliveryPushToDriver({ driverId, type: 'delivery_removed', delivery })
    );
    Promise.allSettled(pushes).catch(() => {});

    res.json({
      success: true,
      message: `Unassigned ${updatedDeliveries.length} of ${deliveries.length} selected deliveries`,
      data: { deliveries: updatedDeliveries }
    });
  } catch (error) {
    console.error('Unassign driver from deliveries error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @desc    Update delivery
// @route   PUT /api/deliveries/:id
// @access  Private/Admin
router.put('/:id', authorize(['admin', 'super_admin', 'dispatcher', 'manager']), async (req, res) => {
  try {
    const updateData = req.body;

    if (updateData.scheduledTime) {
      const normalized = normalizeScheduledTimeInput(updateData.scheduledTime);
      if (!normalized) {
        return res.status(400).json({
          success: false,
          message: 'Invalid scheduledTime. Provide a valid datetime-local value.'
        });
      }
      updateData.scheduledTime = normalized;
    }

    // Get the original delivery before updating
    const originalDelivery = await Delivery.findById(req.params.id);
    if (!originalDelivery) {
      return res.status(404).json({
        success: false,
        message: 'Delivery not found'
      });
    }

    const delivery = await Delivery.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    ).populate('driver', 'profile.firstName profile.lastName profile.colorCode email');

    // Track changes
    const changes = [];
    const fieldsToTrack = [
      'customerName', 'customerId', 'company', 'address', 'addressDetails', 'zone',
      'scheduledTime', 'driver', 'status', 'notes', 'gpsLocation'
    ];

    const changesMap = new Map();
    for (const field of fieldsToTrack) {
      const oldValue = originalDelivery[field];
      const newValue = delivery[field];
      
      // Handle nested objects (like driver, address)
      const oldStr = typeof oldValue === 'object' ? JSON.stringify(oldValue) : String(oldValue || '');
      const newStr = typeof newValue === 'object' ? JSON.stringify(newValue) : String(newValue || '');
      
      if (oldStr !== newStr) {
        changesMap.set(field, {
          oldValue: oldValue,
          newValue: newValue
        });
      }
    }

    // Create delivery change record if there are changes
    if (changesMap.size > 0) {
      await DeliveryChange.create({
        customerId: delivery.customerId || 'UNKNOWN',
        customerName: delivery.customerName || 'Unknown Customer',
        customerPhone: '',
        scheduledDate: delivery.scheduledTime || new Date(),
        appliedToDelivery: delivery._id,
        uploadedBy: req.user._id,
        changes: changesMap,
        reason: updateData.changeReason || 'Delivery updated',
        status: 'applied'
      });
    }

    // Surface a "changed since assignment" banner to the driver app when a
    // driver-relevant field changed on a delivery that already has a driver.
    await flagDeliveryChangeIfNeeded(originalDelivery, updateData);

    // Emit real-time update
    const io = req.app.get('io');
    if (io) {
      io.emit('delivery:updated', delivery);
    } else {
      console.warn('Socket.io not initialized - cannot emit delivery:updated');
    }

    // Push notify the driver — only for a real driver reassignment or a
    // status change, not for every minor field edit (avoids spamming the
    // driver's phone every time a dispatcher fixes a typo in notes/address).
    // Note: `changesMap.get('driver')` isn't usable for this comparison —
    // `originalDelivery.driver` is an unpopulated ObjectId while `delivery.driver`
    // is populated, so their JSON always differs even when unchanged.
    const oldDriverId = originalDelivery.driver ? originalDelivery.driver.toString() : null;
    const newDriverId = delivery.driver
      ? (delivery.driver._id ? delivery.driver._id.toString() : delivery.driver.toString())
      : null;

    if (oldDriverId !== newDriverId) {
      if (newDriverId) {
        sendDeliveryPushToDriver({ driverId: newDriverId, type: 'delivery_reassigned', delivery }).catch((err) => {
          console.warn('Delivery-reassigned push notify failed (caught):', err?.message || err);
        });
      }
      if (oldDriverId) {
        sendDeliveryPushToDriver({ driverId: oldDriverId, type: 'delivery_removed', delivery }).catch((err) => {
          console.warn('Delivery-removed push notify failed (caught):', err?.message || err);
        });
      }
    } else if (changesMap.has('status') && newDriverId) {
      sendDeliveryPushToDriver({ driverId: newDriverId, type: 'delivery_updated', delivery }).catch((err) => {
        console.warn('Delivery-updated push notify failed (caught):', err?.message || err);
      });
    }

    res.json({
      success: true,
      message: 'Delivery updated successfully',
      data: { delivery }
    });
  } catch (error) {
    console.error('Update delivery error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @desc    Start delivery (Driver)
// @route   POST /api/deliveries/:id/start
// @access  Private/Driver
router.post('/:id/start', [
  body('bagQRCode').notEmpty()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { bagQRCode, location } = req.body;
    const trimmedCode = typeof bagQRCode === 'string' ? bagQRCode.trim() : bagQRCode;
    const normalizedBagId = typeof trimmedCode === 'string' ? trimmedCode.toUpperCase() : trimmedCode;
    const deliveryId = req.params.id;

    // Find delivery
    const delivery = await Delivery.findById(deliveryId);
    if (!delivery) {
      return res.status(404).json({
        success: false,
        message: 'Delivery not found'
      });
    }

    const deliveryDriverId = getDeliveryDriverId(delivery);
    const requesterId = getUserId(req.user);
    if (!deliveryDriverId) {
      return res.status(400).json({
        success: false,
        message: 'Delivery has not been assigned to a driver yet'
      });
    }

    if (!requesterId || deliveryDriverId !== requesterId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Find and assign bag
    const bag = await Bag.findOne({
      $or: [
        { bagId: normalizedBagId },
        { qrCode: trimmedCode },
      ],
    });
    if (!bag) {
      return res.status(404).json({
        success: false,
        message: 'Bag not found'
      });
    }

    if (bag.status !== 'available') {
      return res.status(400).json({
        success: false,
        message: 'Bag is not available'
      });
    }

    // Assign bag to delivery
    await bag.assignToDriver(req.user._id, deliveryId);
    delivery.bag = {
      bagId: bag.bagId,
      assignedAt: new Date()
    };

    // Update delivery status
    await delivery.updateStatus('picked_up', 'Package picked up and bag assigned', location);

    // Update driver status
    await User.findByIdAndUpdate(req.user._id, {
      'profile.status': 'busy'
    });

    // Emit real-time updates
    const io = req.app.get('io');
    if (io) {
      io.emit('delivery:statusUpdate', delivery);
      io.emit('driver:statusUpdate', {
        driverId: req.user._id,
        status: 'busy'
      });
    } else {
      console.warn('Socket.io not initialized - cannot emit status updates (start)');
    }

    res.json({
      success: true,
      message: 'Delivery started successfully',
      data: { delivery }
    });
  } catch (error) {
    console.error('Start delivery error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @desc    Mark a collection as collected (Driver uploads proof photo)
// @route   POST /api/deliveries/:id/collect
// @access  Private/Driver,Admin,Dispatcher
router.post('/:id/collect', upload.single('proofImage'), handleUploadError, authorize(['driver', 'admin', 'super_admin', 'dispatcher']), async (req, res) => {
  try {
    const delivery = await Delivery.findById(req.params.id);
    if (!delivery) {
      return res.status(404).json({ success: false, message: 'Delivery not found' });
    }
    if (delivery.type !== 'Collection') {
      return res.status(400).json({ success: false, message: 'This delivery is not a collection' });
    }
    if (delivery.status === 'collected') {
      return res.status(400).json({ success: false, message: 'Collection already marked as collected' });
    }

    // Resolve photo URL from uploaded file or body field
    let photoUrl = req.body.photoUrl || null;
    if (req.file) {
      // req.file.path is absolute path like: /path/to/uploads/proofImage-xxxxx.jpg
      // We need to extract just the relative part: uploads/proofImage-xxxxx.jpg
      let filePath = req.file.location || req.file.path || null;
      if (filePath) {
        // If it's an absolute path, extract just the uploads/filename part
        if (filePath.includes('uploads')) {
          filePath = filePath.substring(filePath.indexOf('uploads'));
        }
        // Ensure it starts with /
        photoUrl = filePath.startsWith('/') ? filePath : '/' + filePath;
      }
    }

    delivery.status = 'collected';
    if (!delivery.collectionDetails) delivery.collectionDetails = {};
    delivery.collectionDetails.collectedAt = new Date();
    if (photoUrl) delivery.collectionDetails.collectedPhotoUrl = photoUrl;
    delivery.collectionDetails.noBagsAvailable = req.body.noBagsAvailable === 'true' || req.body.noBagsAvailable === true;

    delivery.timeline.push({
      status: 'collected',
      timestamp: new Date(),
      notes: delivery.collectionDetails.noBagsAvailable
        ? 'No bags available - reported by driver'
        : (req.body.notes || 'Marked as collected')
    });

    await delivery.save();

    const io = req.app.get('io');
    if (io) io.emit('delivery:updated', delivery);

    return res.json({ success: true, message: 'Collection marked as collected', data: { delivery } });
  } catch (error) {
    console.error('Collect endpoint error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Server error' });
  }
});

// @desc    Complete delivery (Driver)
// @route   POST /api/deliveries/:id/complete
// @access  Private/Driver
router.post('/:id/complete', upload.array('proofImages', 5), handleUploadError, async (req, res) => {
  try {
    const { location, notes } = req.body;
    const deliveryId = req.params.id;
    const normalizedLocation = normalizeLocationPayload(location);

    // Find delivery
    const delivery = await Delivery.findById(deliveryId);
    if (!delivery) {
      return res.status(404).json({
        success: false,
        message: 'Delivery not found'
      });
    }

    const deliveryDriverId = getDeliveryDriverId(delivery);
    const requesterId = getUserId(req.user);
    if (!deliveryDriverId) {
      return res.status(400).json({
        success: false,
        message: 'Delivery has not been assigned to a driver yet'
      });
    }

    if (!requesterId || deliveryDriverId !== requesterId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Handle proof images (multipart file uploads — legacy web flow)
    const proofImages = req.files ? req.files.map(file => file.filename) : [];

    // Merge proof from request body (React Native sends CDN URLs here)
    const bodyProof = req.body.proof
      ? (typeof req.body.proof === 'string' ? JSON.parse(req.body.proof) : req.body.proof)
      : {};

    // CDN photo URL can also arrive as a top-level req.body.photoUrl
    const bodyPhotoUrl = req.body.photoUrl || bodyProof.photoUrl || null;

    // Build proof: body proof takes precedence; fall back to uploaded files
    const proofLocation = normalizedLocation || undefined;
    const mergedImages = bodyProof.images?.length
      ? bodyProof.images
      : proofImages.length
        ? proofImages
        : bodyPhotoUrl
          ? [bodyPhotoUrl]
          : [];

    delivery.proof = {
      ...bodyProof,
      images: mergedImages,
      photoUrl: bodyPhotoUrl || mergedImages[0] || undefined,
      timestamp: new Date(),
      location: proofLocation
    };

    // Complete delivery
    await delivery.updateStatus(
      'delivered',
      notes || 'Delivery completed',
      normalizedLocation || location
    );

    // Return bag to warehouse
    if (delivery.bag && delivery.bag.bagId) {
      const bag = await Bag.findOne({ bagId: delivery.bag.bagId });
      if (bag) {
        const userName = resolveUserDisplayName(req.user);
        const updatedBag = await bag.returnToWarehouse({
          returnedBy: req.user?._id,
          returnedByName: userName,
          location: normalizedLocation,
          historyNote: `Bag returned after completing delivery ${deliveryId}`,
        });

        const bagReturnedAt = updatedBag.returnedAt || new Date();

        if (!Array.isArray(delivery.timeline)) {
          delivery.timeline = [];
        }
        delivery.timeline.push({
          status: 'bag_returned',
          timestamp: bagReturnedAt,
          notes: `Bag ${delivery.bag.bagId} returned to warehouse`,
        });

        if (delivery.bagAssignment) {
          delivery.bagAssignment.status = 'returned';
          delivery.bagAssignment.returnedAt = bagReturnedAt;
        }

        if (delivery.bag) {
          delivery.bag.returnedAt = bagReturnedAt;
        } else {
          delivery.bag = {
            bagId: delivery.bagAssignment?.bagId || delivery.bag?.bagId,
            returnedAt: bagReturnedAt,
          };
        }

        await delivery.save();
      }
    }

    // Update driver status; KPI counts are recomputed from scratch below
    // (month-to-date, not incremented) since they reset every calendar month.
    await User.findByIdAndUpdate(req.user._id, {
      'profile.status': 'available'
    });

    // Recalculate this month's KPI scorecard
    await recalculateDriverKPI(req.user._id);

    // Emit real-time updates
    const io = req.app.get('io');
    if (io) {
      io.emit('delivery:statusUpdate', delivery);
      io.emit('driver:statusUpdate', {
        driverId: req.user._id,
        status: 'available'
      });
    } else {
      console.warn('Socket.io not initialized - cannot emit status updates (complete)');
    }

    fillProofAddressInBackground(delivery); // label the drop-off spot; never blocks the driver

    res.json({
      success: true,
      message: 'Delivery completed successfully',
      data: { delivery }
    });
  } catch (error) {
    console.error('Complete delivery error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

router.post('/return-bag', async (req, res) => {
  try {
    const {
      bagId,
      bagQRCode,
      notes,
      reason,
      location,
      driverId,
      driverName,
      timestamp,
    } = req.body || {};

    const identifier = bagId ?? bagQRCode;
    const normalizedBagId = normalizeBagId(identifier);

    if (!normalizedBagId) {
      return res.status(400).json({
        success: false,
        message: 'bagId or bagQRCode is required to return a bag',
      });
    }

    const lookupConditions = [{ bagId: normalizedBagId }];
    if (identifier) {
      lookupConditions.push({ qrCode: identifier });
      if (identifier !== normalizedBagId) {
        lookupConditions.push({ qrCode: normalizedBagId });
      }
    }

    const bag = await Bag.findOne({ $or: lookupConditions });

    if (!bag) {
      return res.status(404).json({
        success: false,
        message: 'Bag not found',
      });
    }

    const normalizedLocation = normalizeLocationPayload(location);
    const resolvedDriverId =
      driverId && mongoose.Types.ObjectId.isValid(driverId)
        ? driverId
        : req.user?._id;

    const resolvedDriverName =
      (typeof driverName === 'string' && driverName.trim()) ||
      resolveUserDisplayName(req.user) ||
      undefined;

    const historyNote = resolvedDriverName
      ? `Bag returned by ${resolvedDriverName}`
      : 'Bag returned to warehouse';

    const updatedBag = await bag.returnToWarehouse({
      returnedBy: resolvedDriverId,
      returnedByName: resolvedDriverName,
      location: normalizedLocation,
      notes: notes || reason,
      returnedAt: timestamp ? new Date(timestamp) : undefined,
      historyNote,
    });

    const bagReturnedAt = updatedBag.returnedAt || new Date();

    const deliveriesToUpdate = await Delivery.find({
      'bagAssignment.bagId': normalizedBagId,
      'bagAssignment.status': { $ne: 'returned' },
    });

    for (const delivery of deliveriesToUpdate) {
      if (delivery.bagAssignment) {
        delivery.bagAssignment.status = 'returned';
        delivery.bagAssignment.returnedAt = bagReturnedAt;
      }

      if (!Array.isArray(delivery.timeline)) {
        delivery.timeline = [];
      }

      delivery.timeline.push({
        status: 'bag_returned',
        timestamp: bagReturnedAt,
        notes: `Bag ${normalizedBagId} returned to warehouse`,
      });

      if (delivery.bag) {
        delivery.bag.returnedAt = bagReturnedAt;
      } else {
        delivery.bag = {
          bagId: normalizedBagId,
          returnedAt: bagReturnedAt,
        };
      }

      await delivery.save();
    }

    await updatedBag.populate('assignedTo.driver', 'profile.firstName profile.lastName profile.colorCode');

    res.json({
      success: true,
      message: 'Bag returned successfully',
      data: {
        bag: updatedBag,
        bagId: updatedBag.bagId,
        returnedAt: bagReturnedAt,
      },
    });
  } catch (error) {
    console.error('Error processing bag return:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message,
    });
  }
});


// @desc    Get driver's today deliveries
// @route   GET /api/deliveries/driver/today
// @access  Private/Driver
router.get('/driver/today', protect, async (req, res) => {
  try {
    const rawDeliveries = await Delivery.getDriverTodaysDeliveries(req.user._id)
      .populate('driver', 'profile.firstName profile.lastName profile.colorCode email')
      .lean();
    const deliveries = await applyWeekendCombining(rawDeliveries);

    // Van↔bike handoffs this driver is part of, for the same day window the
    // deliveries above use (today, plus tomorrow once the early-next-day
    // cutoff has passed — mirroring getDriverTodaysDeliveries).
    const nowLocal = new Date(Date.now() + LOCAL_TZ_OFFSET_MS);
    const todayStr = nowLocal.toISOString().slice(0, 10);
    const dates = [todayStr];
    const earlyNextDay = String(process.env.ENABLE_EARLY_NEXT_DAY || '1') === '1';
    const nextDayHour = parseInt(process.env.NEXT_DAY_AVAILABLE_HOUR || '16', 10);
    if (earlyNextDay && nowLocal.getUTCHours() >= nextDayHour) {
      dates.push(new Date(nowLocal.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
    }
    const handoffs = await Handoff.find({
      date: { $in: dates },
      status: { $ne: 'cancelled' },
      $or: [{ van: req.user._id }, { bike: req.user._id }]
    })
      .populate('van', 'profile.firstName profile.lastName profile.phone profile.vehicleType')
      .populate('bike', 'profile.firstName profile.lastName profile.phone profile.vehicleType')
      .populate('deliveryIds', 'customerName address routeOrder status')
      .lean();

    res.json({
      success: true,
      data: { deliveries, handoffs }
    });
  } catch (error) {
    console.error('❌ Get driver deliveries error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

// Update delivery with bag assignment
// Driver acknowledges the "changed since assignment" banner on their own
// delivery, clearing it. Only the assigned driver can clear their own flag.
router.patch('/:id/acknowledge-change', async (req, res) => {
  try {
    const delivery = await Delivery.findById(req.params.id);
    if (!delivery) {
      return res.status(404).json({ success: false, message: 'Delivery not found' });
    }

    const deliveryDriverId = getDeliveryDriverId(delivery);
    const requesterId = getUserId(req.user);
    if (!deliveryDriverId) {
      return res.status(400).json({ success: false, message: 'Delivery has not been assigned to a driver yet' });
    }
    if (!requesterId || deliveryDriverId !== requesterId) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    delivery.changeFlag = {
      ...(delivery.changeFlag?.toObject?.() ?? delivery.changeFlag ?? {}),
      active: false,
      acknowledgedAt: new Date(),
      acknowledgedBy: req.user._id,
    };
    await delivery.save();

    res.json({ success: true, data: { delivery } });
  } catch (error) {
    console.error('Acknowledge delivery change error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.patch('/:id/bag-assignment', async (req, res) => {
  try {
    const { bagId, proof } = req.body;
    
    const delivery = await Delivery.findById(req.params.id);
    
    if (!delivery) {
      return res.status(404).json({ message: 'Delivery not found' });
    }

    const deliveryDriverId = getDeliveryDriverId(delivery);
    const requesterId = getUserId(req.user);
    if (!deliveryDriverId) {
      return res.status(400).json({ message: 'Delivery has not been assigned to a driver yet' });
    }
    if (!requesterId || deliveryDriverId !== requesterId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Update delivery status and bag assignment
    delivery.status = 'delivered';
    delivery.deliveredTime = new Date();
    
    // Calculate timing deltas with 3-hour early threshold
    const scheduledTime = new Date(delivery.scheduledTime);
    const deliveredTime = new Date();
    const diffMinutes = Math.round((deliveredTime - scheduledTime) / (1000 * 60));
    const earlyThresholdTime = new Date(scheduledTime.getTime() - (180 * 60 * 1000));
    const isEarly = deliveredTime < earlyThresholdTime;

    delivery.lateMinutes = diffMinutes > 0 ? diffMinutes : 0;
    delivery.earlyMinutes = isEarly
      ? Math.max(0, Math.round((earlyThresholdTime - deliveredTime) / (1000 * 60)))
      : 0;
    delivery.deliveryType = isEarly ? 'early' : diffMinutes > 0 ? 'late' : 'on-time';

    // Add bag assignment and proof
    if (bagId) {
      await applyBagAssignmentToDelivery(delivery, bagId, req.user.id);
    }

    if (proof) {
      delivery.proof = { ...delivery.proof, ...proof };
    }

    // Add to timeline
    delivery.timeline.push({
      status: 'delivered',
      timestamp: new Date(),
      notes: bagId ? `Delivery completed with bag ${bagId}` : 'Delivery completed'
    });

    await delivery.save();
    
    res.json(delivery);
  } catch (error) {
    console.error('Error updating delivery with bag assignment:', error);
    res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : 'Server error', error: error.message });
  }
});

// Update delivery status (for driver)
// Update delivery status (for driver)
// Update delivery status (for driver)
// Update delivery status (for driver)
router.patch('/:id/status', async (req, res) => {
  try {
    const { status, proof, bagId } = req.body;
    
    const delivery = await Delivery.findById(req.params.id);
    
    if (!delivery) {
      return res.status(404).json({ message: 'Delivery not found' });
    }

    const deliveryDriverId = getDeliveryDriverId(delivery);
    const requesterId = getUserId(req.user);
    if (!deliveryDriverId) {
      return res.status(400).json({ message: 'Delivery has not been assigned to a driver yet' });
    }
    if (!requesterId || deliveryDriverId !== requesterId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Update delivery status
    delivery.status = status;

    if (status === 'delivered') {
      const deliveredTime = new Date();
      delivery.deliveredTime = deliveredTime;
      delivery.completedAt = deliveredTime;
      
      // Calculate timing deltas with 3-hour early threshold
      const scheduledTime = new Date(delivery.scheduledTime);
      const diffMinutes = Math.round((deliveredTime - scheduledTime) / (1000 * 60));
      const earlyThresholdTime = new Date(scheduledTime.getTime() - (180 * 60 * 1000));
      const isEarly = deliveredTime < earlyThresholdTime;

      delivery.lateMinutes = diffMinutes > 0 ? diffMinutes : 0;
      delivery.earlyMinutes = isEarly
        ? Math.max(0, Math.round((earlyThresholdTime - deliveredTime) / (1000 * 60)))
        : 0;
      delivery.deliveryType = isEarly ? 'early' : diffMinutes > 0 ? 'late' : 'on-time';
    } else if (status === 'completed') {
      const completedTime = new Date();
      delivery.completedAt = completedTime;
      // Tasks marked as completed should not carry over delivery timing penalties
      delivery.deliveredTime = delivery.deliveredTime || completedTime;
      delivery.deliveryType = 'on-time';
      delivery.lateMinutes = 0;
      delivery.earlyMinutes = 0;
    } else {
      // Reset timing metadata if status moves away from terminal states
      delivery.deliveryType = 'on-time';
      delivery.lateMinutes = 0;
      delivery.earlyMinutes = 0;
      delivery.completedAt = undefined;
    }

    // Handle proof data safely
    if (proof) {
      // Initialize proof object if it doesn't exist
      if (!delivery.proof) {
        delivery.proof = {};
      }
      
      // Safely merge proof data
      Object.keys(proof).forEach(key => {
        if (proof[key] !== undefined && proof[key] !== null) {
          delivery.proof[key] = proof[key];
        }
      });

      // Keep photoUrl and images in sync so both web and React Native sources work
      if (delivery.proof.photoUrl && (!delivery.proof.images || delivery.proof.images.length === 0)) {
        delivery.proof.images = [delivery.proof.photoUrl];
      } else if (delivery.proof.images && delivery.proof.images.length > 0 && !delivery.proof.photoUrl) {
        delivery.proof.photoUrl = delivery.proof.images[0];
      }

      // Ensure timestamp is set
      if (!delivery.proof.timestamp) {
        delivery.proof.timestamp = new Date();
      }

      // Owner (2026-10-10): "make two pins, the actual location and the
      // driver location, do not overwrite" — this used to copy the driver's
      // phone GPS at delivery time into delivery.gpsLocation, silently
      // replacing the address/geocoded pin with wherever the driver's phone
      // happened to be standing (which can be off by blocks — GPS drift,
      // parked nearby, inside a building). proof.location is already
      // preserved as its own field by the Object.keys(proof) merge above —
      // it's the driver's on-site GPS, kept separate from the address pin
      // so both can be shown (see DriverRouteMap2GIS.jsx).
    }

    // Add bag assignment if provided
    if (bagId) {
      await applyBagAssignmentToDelivery(delivery, bagId, req.user.id);
    }

    // Add to timeline
    delivery.timeline.push({
      status: status,
      timestamp: new Date(),
      notes: bagId ? `Delivery completed with bag ${bagId}` : `Status updated to ${status}`
    });

    await delivery.save();

    // Populate driver information before returning
    await delivery.populate('driver');

    // Recalculate this month's KPI scorecard whenever this endpoint reaches
    // a terminal outcome (the mobile driver app's status-update path).
    if (['delivered', 'completed', 'failed'].includes(status) && deliveryDriverId) {
      recalculateDriverKPI(deliveryDriverId).catch((err) => {
        console.warn('KPI recalculate failed (caught):', err?.message || err);
      });
    }

    fillProofAddressInBackground(delivery); // label the drop-off spot; never blocks the driver

    res.json({
      success: true,
      message: 'Delivery status updated successfully',
      delivery: delivery.toObject()
    });
  } catch (error) {
    console.error('Error updating delivery status:', error);
    res.status(error.statusCode || 500).json({ 
      success: false,
      message: error.statusCode ? error.message : 'Server error', 
      error: error.message 
    });
  }
});



// @desc    Delete deliveries by ids
// @route   DELETE /api/deliveries/by-ids
// @access  Private/Admin
router.delete('/by-ids', authorize(['admin', 'super_admin']), async (req, res) => {
  try {
    const { deliveryIds } = req.body;

    if (!Array.isArray(deliveryIds) || deliveryIds.length === 0) {
      return res.status(400).json({ success: false, message: 'deliveryIds array is required' });
    }

    // Validate ObjectIds
    const invalidId = deliveryIds.find((id) => !mongoose.Types.ObjectId.isValid(id));
    if (invalidId) {
      return res.status(400).json({ success: false, message: `Invalid delivery id: ${invalidId}` });
    }

    // Fetch deliveries before deletion for Slack notification
    const deliveriesToDelete = await Delivery.find({ _id: { $in: deliveryIds } }).lean();
    
    const result = await Delivery.deleteMany({ _id: { $in: deliveryIds } });

    // Send Slack notification
    const deletedByName = req.user?.profile?.firstName
      ? `${req.user.profile.firstName} ${req.user.profile.lastName || ''}`.trim()
      : req.user?.email || req.user?._id || 'Unknown user';
    
    sendDeliveryRemovalToSlack(deliveriesToDelete, {
      deletedBy: deletedByName
    }).catch(() => {});

    const io = req.app.get('io');
    if (io) {
      io.emit('deliveries:deleted', {
        count: result.deletedCount,
        ids: deliveryIds
      });
    }

    return res.json({
      success: true,
      message: `Deleted ${result.deletedCount} deliveries`,
      data: { deletedCount: result.deletedCount }
    });
  } catch (error) {
    console.error('Delete deliveries by ids error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});


// @desc    Delete deliveries by date range
// @route   DELETE /api/deliveries/bulk-delete
// @access  Private/Admin
router.delete('/bulk-delete', authorize(['admin', 'super_admin']), async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.body;

    // Validate input
    if (!dateFrom || !dateTo) {
      return res.status(400).json({
        success: false,
        message: 'dateFrom and dateTo are required'
      });
    }

    // Parse dates
    const startDate = new Date(dateFrom);
    const endDate = new Date(dateTo);

    // Validate dates
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid date format. Expected ISO 8601 format (YYYY-MM-DDTHH:mm:ss.sssZ)'
      });
    }

    // Validate date range
    if (startDate > endDate) {
      return res.status(400).json({
        success: false,
        message: 'Start date must be on or before end date'
      });
    }

    // Set end date to end of day for inclusive range
    const adjustedEndDate = new Date(endDate);
    adjustedEndDate.setHours(23, 59, 59, 999);

    // Fetch deliveries before deletion for Slack notification
    const deliveriesToDelete = await Delivery.find({
      scheduledTime: {
        $gte: startDate,
        $lte: adjustedEndDate
      }
    }).lean();

    // Delete deliveries within the date range
    const result = await Delivery.deleteMany({
      scheduledTime: {
        $gte: startDate,
        $lte: adjustedEndDate
      }
    });

    // Send Slack notification
    const deletedByName = req.user?.profile?.firstName
      ? `${req.user.profile.firstName} ${req.user.profile.lastName || ''}`.trim()
      : req.user?.email || req.user?._id || 'Unknown user';
    
    sendDeliveryRemovalToSlack(deliveriesToDelete, {
      deletedBy: deletedByName
    }).catch(() => {});

    // Emit real-time update for deleted deliveries
    const io = req.app.get('io');
    if (io) {
      io.emit('deliveries:deleted', {
        count: result.deletedCount,
        dateRange: {
          from: startDate.toISOString(),
          to: adjustedEndDate.toISOString()
        }
      });
    } else {
      console.warn('Socket.io not initialized - cannot emit deliveries:deleted');
    }

    res.json({
      success: true,
      message: `Successfully deleted ${result.deletedCount} deliveries from ${startDate.toDateString()} to ${endDate.toDateString()}`,
      data: {
        deletedCount: result.deletedCount,
        dateRange: {
          from: startDate.toISOString(),
          to: adjustedEndDate.toISOString()
        }
      }
    });
  } catch (error) {
    console.error('Bulk delete deliveries error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// PATCH endpoint to update delivery gpsLocation
// Restricted to dispatch roles (matches PUT /:id) — this used to have no
// role check at all, meaning any authenticated user, including a driver,
// could silently move a delivery's pin with zero audit trail. Only caller
// is the dispatcher map-assign tool (DispatcherMapAssignModal.jsx).
router.patch('/:id', authorize(['admin', 'super_admin', 'dispatcher', 'manager']), async (req, res) => {
  try {
    const { id } = req.params;
    const { gpsLocation } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid delivery ID' });
    }

    const originalDelivery = await Delivery.findById(id);
    if (!originalDelivery) {
      return res.status(404).json({ success: false, message: 'Delivery not found' });
    }

    const delivery = await Delivery.findByIdAndUpdate(
      id,
      { gpsLocation },
      { new: true, runValidators: true }
    );

    await flagDeliveryChangeIfNeeded(originalDelivery, { gpsLocation });

    res.json({
      success: true,
      message: 'Delivery updated successfully',
      data: delivery
    });
  } catch (error) {
    console.error('Update delivery error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Report Issue - POST /:id/report-issue
router.post('/:id/report-issue', protect, async (req, res) => {
  try {
    const { id } = req.params;
    const { complaint } = req.body;

    if (!complaint || !complaint.complaintType) {
      return res.status(400).json({
        success: false,
        message: 'Complaint type is required'
      });
    }

    // Find delivery
    const delivery = await Delivery.findById(id);
    if (!delivery) {
      return res.status(404).json({
        success: false,
        message: 'Delivery not found'
      });
    }

    // Update delivery with complaint (merge with existing complaint data if any)
    const existingComplaint = delivery.complaint || {};
    delivery.complaint = {
      ...existingComplaint,
      ...complaint,
      hasComplaint: true,
      reportedAt: new Date()
    };
    
    console.log('Saving complaint data:', JSON.stringify(delivery.complaint, null, 2));
    await delivery.save();

    // Send to Slack
    const complaintTypeLabel = {
      late: 'Late Delivery',
      early: 'Early Delivery',
      missed: 'Missed Delivery',
      wrong_address: 'Wrong Address',
      delivery_issue: 'Delivery Issue',
      food_quality: 'Food Quality',
      major_incident: 'Major Incident',
      damaged_food: 'Damaged Food',
      macros_inaccuracy: 'Macros Inaccuracy',
      late_delivery_transcorp: 'Late delivery - Transcorp',
      wrong_food: 'Wrong Food',
      other: 'Other'
    }[delivery.complaint?.complaintType] || delivery.complaint?.complaintType || 'Unknown';

    const compensationText = delivery.complaint?.compensation 
      ? delivery.complaint.compensation.type === 'refund'
        ? `💰 Refund: AED ${delivery.complaint.compensation.amount}`
        : `📅 Extra Days: ${delivery.complaint.compensation.days} day(s)`
      : 'None';

    const slackMessage = {
      text: '⚠️ *New Issue Report*',
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '⚠️ Issue Report'
          }
        },
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `*Customer:*\n${delivery.customerName}`
            },
            {
              type: 'mrkdwn',
              text: `*ID:*\n${delivery.customerId}`
            },
            {
              type: 'mrkdwn',
              text: `*Complaint Type:*\n${complaintTypeLabel}`
            },
            {
              type: 'mrkdwn',
              text: `*Status:*\n${delivery.status || 'Unknown'}`
            }
          ]
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Remarks:*\n${delivery.complaint?.remarks || 'None'}`
          }
        },
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `*Compensation:*\n${compensationText}`
            },
            {
              type: 'mrkdwn',
              text: `*Reported By:*\n${req.user?.profile?.firstName || 'Unknown'}`
            }
          ]
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `_Reported at ${new Date().toLocaleString()}_`
            }
          ]
        }
      ]
    };

    // Send to Slack with fallbacks
    const slackWebhooks = [
      process.env.SLACK_ISSUE_REPORT_WEBHOOK_URL,
      process.env.SLACK_MANUAL_ENTRY_WEBHOOK_URL,
      process.env.SLACK_WEBHOOK_URL
    ].filter(Boolean);

    let slackSent = false;
    for (const webhook of slackWebhooks) {
      try {
        await axios.post(webhook, slackMessage, { timeout: 5000 });
        slackSent = true;
        console.log('✅ Issue report sent to Slack');
        break;
      } catch (error) {
        console.warn(`⚠️ Failed to send issue report to Slack (${webhook}):`, error.message);
      }
    }

    if (!slackSent) {
      console.warn('⚠️ Issue report failed to send to all Slack webhooks');
    }

    res.status(200).json({
      success: true,
      message: 'Issue reported successfully',
      data: delivery
    });
  } catch (error) {
    console.error('Report issue error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Add this route to your driver routes

// Get all complaints - GET /api/deliveries/complaints
router.get('/complaints/all', protect, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      complaintType,
      resolved,
      search,
      sortBy = 'reportedAt',
      sortOrder = -1,
      reportedDateFrom,
      reportedDateTo
    } = req.query;

    // Build query filters
    const filters = [];

    // Must have a complaint
    filters.push({ 'complaint.hasComplaint': true });

    // Filter by complaint type
    if (complaintType && complaintType !== 'all') {
      console.log('Filtering by complaint type:', complaintType);
      filters.push({ 'complaint.complaintType': complaintType });
    }

    // Filter by resolved status
    if (resolved !== undefined && resolved !== 'all') {
      console.log('Filtering by resolved:', resolved);
      filters.push({ 'complaint.resolved': resolved === 'true' });
    }

    // Filter by date range
    if (reportedDateFrom || reportedDateTo) {
      console.log('Filtering by date range:', { reportedDateFrom, reportedDateTo });
      const dateFilter = {};
      if (reportedDateFrom) {
        dateFilter.$gte = new Date(reportedDateFrom);
      }
      if (reportedDateTo) {
        dateFilter.$lte = new Date(reportedDateTo);
      }
      filters.push({
        $or: [
          { 'complaint.reportedAt': dateFilter },
          { 'updatedAt': dateFilter }
        ]
      });
    }

    // Search by customer name or ID
    if (search) {
      console.log('Searching for:', search);
      filters.push({
        $or: [
          { customerName: { $regex: search, $options: 'i' } },
          { customerId: { $regex: search, $options: 'i' } },
          { address: { $regex: search, $options: 'i' } }
        ]
      });
    }

    // Combine all filters with $and
    const query = filters.length > 0 ? { $and: filters } : { 'complaint.hasComplaint': true };

    const pageNum = Math.max(1, parseInt(page, 10));
    const pageSize = Math.max(1, Math.min(100, parseInt(limit, 10)));
    const skip = (pageNum - 1) * pageSize;

    const sortObj = {};
    if (sortBy === 'reportedAt') {
      sortObj['complaint.reportedAt'] = parseInt(sortOrder, 10);
      sortObj['updatedAt'] = parseInt(sortOrder, 10);
    } else {
      sortObj[sortBy] = parseInt(sortOrder, 10);
    }

    console.log('Final query:', JSON.stringify(query, null, 2));
    console.log('Sort:', sortObj);

    const [complaints, total] = await Promise.all([
      Delivery.find(query)
        .sort(sortObj)
        .skip(skip)
        .limit(pageSize)
        .populate('driver', 'profile email')
        .lean(),
      Delivery.countDocuments(query)
    ]);

    console.log(`Found ${complaints.length} complaints out of ${total} total`);

    // Ensure complaint data is present
    const complaintsWithData = complaints.map(c => ({
      ...c,
      complaint: {
        ...c.complaint,
        reportedAt: c.complaint?.reportedAt || c.updatedAt
      }
    }));

    res.json({
      success: true,
      data: {
        complaints: complaintsWithData,
        pagination: {
          total,
          pages: Math.ceil(total / pageSize),
          currentPage: pageNum,
          pageSize
        }
      }
    });
  } catch (error) {
    console.error('Fetch complaints error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get assignment suggestions (without saving)
router.post('/:id/assignment-suggestions', protect, authorize(['admin', 'super_admin', 'dispatcher']), async (req, res) => {
  try {
    const { id } = req.params;

    const delivery = await Delivery.findById(id);
    if (!delivery) {
      return res.status(404).json({
        success: false,
        message: 'Delivery not found'
      });
    }

    // Return simple message - AI auto-assignment removed
    return res.status(404).json({
      success: false,
      message: 'AI auto-assignment feature has been removed'
    });
  } catch (error) {
    console.error('Get suggestions error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to get assignment suggestions'
    });
  }
});

// Manually set coordinates for a delivery (persists on the delivery/customer record)
router.post('/:id/manual-coords', protect, authorize(['driver', 'dispatcher', 'manager', 'admin', 'super_admin']), async (req, res) => {
  try {
    const { id } = req.params;
    const { lat, lng, link, mapsUrl, address } = req.body;

    const parsedLat = Number(lat);
    const parsedLng = Number(lng);

    if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLng)) {
      return res.status(400).json({ success: false, message: 'lat and lng are required and must be numbers' });
    }

    const delivery = await Delivery.findById(id);
    if (!delivery) {
      return res.status(404).json({ success: false, message: 'Delivery not found' });
    }

    const before = {
      lat: delivery.gpsLocation?.lat ?? null,
      lng: delivery.gpsLocation?.lng ?? null,
      address: delivery.address || null
    };

    // Optionally update address/link if provided
    if (address) {
      delivery.address = address;
    }
    const linkToSave = link || mapsUrl || delivery.gpsLocation?.link;

    await saveCustomerCoords(delivery, parsedLat, parsedLng, linkToSave);

    // A pin correction applies to THIS delivery, plus other deliveries ONLY if
    // they are provably the same place: same customer AND same Matter
    // addressId, still editable (pending/assigned — never delivered history,
    // never a stop a driver is already working), and scheduled today or later.
    // (Issue #6: this used to write the pin onto every delivery for the
    // customer with no GPS, including completed ones at other addresses.)
    // A delivery with no addressId (manual/CSV, or an address edited since)
    // propagates nowhere; later deliveries at the same address text still
    // reuse the pin via the Customer.gpsLocation cache saveCustomerCoords sets.
    let propagatedIds = [];
    if (delivery.addressId) {
      const { startOfDay: startOfToday } = getBusinessDayBounds(new Date());
      const targets = await Delivery.find({
        _id: { $ne: delivery._id },
        customerId: delivery.customerId,
        addressId: delivery.addressId,
        type: 'Delivery',
        status: { $in: ['pending', 'assigned'] },
        scheduledTime: { $gte: startOfToday }
      }).select('_id').lean();
      propagatedIds = targets.map((t) => String(t._id));
      if (propagatedIds.length > 0) {
        await Delivery.updateMany(
          { _id: { $in: targets.map((t) => t._id) } },
          {
            $set: {
              'gpsLocation.lat': parsedLat,
              'gpsLocation.lng': parsedLng,
              'gpsLocation.link': linkToSave,
              lat: parsedLat,
              lng: parsedLng
            }
          }
        );
      }
    }
    console.info('[manual-coords]', JSON.stringify({
      deliveryId: String(delivery._id),
      customerId: delivery.customerId || null,
      addressId: delivery.addressId || null,
      by: req.user?._id ? String(req.user._id) : null,
      before,
      after: { lat: parsedLat, lng: parsedLng, address: delivery.address || null },
      propagatedTo: propagatedIds
    }));

    res.json({ success: true, message: 'Coordinates saved', data: { delivery } });
  } catch (error) {
    console.error('Manual coords save error:', error);
    res.status(500).json({ success: false, message: 'Server error', error: process.env.NODE_ENV === 'development' ? error.message : undefined });
  }
});

export default router;


