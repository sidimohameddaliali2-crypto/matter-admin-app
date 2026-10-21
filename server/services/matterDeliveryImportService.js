import Delivery from '../models/Delivery.js';
import matterApiService from './matterApiService.js';
import { resolveCustomerMatch, createCustomerFromMatterSubscription } from './customerMatchService.js';
import { detectAreaFromAddress } from '../config/areas.js';
import { getBusinessDayBounds } from '../utils/businessDate.js';
import { displayMatterName } from '../utils/matterName.js';
import { resolveMatterDeliveryAddress } from './matterSubscriptionContract.js';
import { compareMatterDelivery } from './matterDeliveryComparison.js';

// Only pending/assigned work today or later can receive a name refresh.
const EDITABLE_STATUSES = new Set(['pending', 'assigned']);

// Owner (2026-09-22): "read all the delivery schedule for the day from the
// matter api and put them in the delivery page, use sub id for each
// customer delivery." Turns matterApiService's read-only
// findSubscriptionsWithDeliveryOnDate results into real Delivery documents —
// once created, the dispatcher table, Driver Routes, and the driver app all
// pick them up automatically, since they already just read the Delivery
// collection. Each created delivery carries `matterSubscriptionId` so it can
// always be traced back to (and de-duplicated against) its Matter
// subscription.

const LOCAL_TZ_OFFSET_MINUTES = parseInt(process.env.LOCAL_TIMEZONE_OFFSET_MINUTES || '240', 10);
const LOCAL_TZ_OFFSET_MS = LOCAL_TZ_OFFSET_MINUTES * 60 * 1000;
const DEFAULT_WINDOW_HOUR = 6; // "By 6 AM" — used only if delivery_window is missing/unparseable.

// Matter's delivery_window label is "By N AM" (verified live against every
// window id 1-8 on 2026-09-22: 3 AM through 10 AM, one hour apart) — a
// simple regex is more resilient to a label wording tweak than hardcoding
// the id->hour map.
export function parseWindowHour(deliveryWindow) {
  const label = deliveryWindow?.label;
  if (!label) return null;
  const match = String(label).match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
  if (!match) return null;
  let hour = parseInt(match[1], 10);
  if (Number.isNaN(hour) || hour < 1 || hour > 12) return null;
  const minutes = Number(match[2] || 0);
  if (minutes > 59) return null;
  const isPM = /PM/i.test(match[3]);
  if (isPM && hour !== 12) hour += 12;
  if (!isPM && hour === 12) hour = 0;
  return hour + minutes / 60;
}

// "YYYY-MM-DD" (business-local calendar date) + an hour -> the UTC instant
// for that local wall-clock time, same convention scheduledTime uses
// throughout the app (see routes/deliveries.js's normalizeScheduledTimeInput).
export function scheduledTimeFor(dateKey, hour) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, Math.round(hour * 60), 0, 0) - LOCAL_TZ_OFFSET_MS);
}


// Matter's `area` field is usually English, but has been observed live
// (2026-10-15, James Connolly sub 498/1239 and Zara Cooper sub 542) to come
// back in Arabic script for some addresses — the same street/building
// record, same coordinates, just localized differently on Matter's side.
// Taking it as-is leaked Arabic text into both the driver-facing address
// line and the dispatcher's zone filter. `street`/`additional_details`
// usually still carry an English place name alongside the Arabic (e.g.
// "... - Jumeirah Village Triangle - دبي - ..."), so keyword-detecting
// against those is the fallback instead of ever displaying the raw Arabic.
const ARABIC_SCRIPT = /[؀-ۿ]/;
function resolveEnglishArea(addr) {
  const rawArea = addr.area || '';
  if (rawArea && !ARABIC_SCRIPT.test(rawArea)) return rawArea;
  const fallbackText = [addr.street, addr.additional_details, addr.building].filter(Boolean).join(' ');
  return detectAreaFromAddress(fallbackText) || '';
}

// Owner (2026-09-22): "the delivery address ... need to be not one line as
// before but changed to field: label, emirate, area, building, unit, floor,
// status" — addressDetails now carries every one of those as its own field
// (see models/Delivery.js). This still builds a single readable line too
// (kept in `address`) since the rest of the app — the dispatcher table's
// Location column, the driver app's address banner, map popups — reads that
// one flat string; nothing there assembles addressDetails into a line on
// its own, so dropping it would leave those views blank for every
// Matter-imported delivery.
export function buildAddressLine(addr) {
  return [addr.building, addr.unit ? `Unit ${addr.unit}` : null, addr.floor, resolveEnglishArea(addr), addr.emirate]
    .filter(Boolean)
    .join(', ');
}

// One proposal shape for new imports and read-only comparisons. No writes.
export function buildMatterDeliverySnapshot(sub, dateKey, customer = null) {
  const useAddr = resolveMatterDeliveryAddress(sub.customer_addresses).address;
  if (!useAddr) return null;
  const subscriptionId = String(sub.subscription_id);
  const hour = parseWindowHour(sub.delivery_window);
  const addressLine = buildAddressLine(useAddr) || sub.address || '';
  const savedPin = customer?.gpsLocation;
  const manualPin = savedPin?.source === 'manual' && useAddr.id != null
    && String(savedPin.addressId || '') === String(useAddr.id)
    && String(savedPin.address || '').trim() === addressLine.trim()
    && Number.isFinite(savedPin.lat) && Number.isFinite(savedPin.lng) ? savedPin : null;
  return {
    customerId: customer?.customerId,
    customerName: displayMatterName(sub.name),
    scheduledTime: hour == null ? null : scheduledTimeFor(sub.delivery_date || dateKey, hour),
    company: 'Matter',
    type: 'Delivery',
    address: addressLine,
    addressDetails: {
      label: useAddr.label ?? null,
      city: useAddr.emirate ?? null,
      area: useAddr.area ?? null,
      street: useAddr.street ?? null,
      additionalDetails: useAddr.additional_details ?? null,
      sourceCategory: useAddr.category ?? null,
      locationType: ['villa', 'apartment'].includes(String(useAddr.category || '').toLowerCase())
        ? (String(useAddr.category).toLowerCase() === 'villa' ? 'Villa' : 'Apartment') : null,
      building: useAddr.building ?? null,
      floor: useAddr.floor ?? null,
      apartment: useAddr.unit ?? null,
      addressStatus: useAddr.status ?? null
    },
    zone: resolveEnglishArea(useAddr) || detectAreaFromAddress(addressLine) || '',
    gpsLocation: manualPin ? { lat: manualPin.lat, lng: manualPin.lng } : (useAddr.coordinates && Number.isFinite(useAddr.coordinates.lat) && Number.isFinite(useAddr.coordinates.lng))
      ? { lat: useAddr.coordinates.lat, lng: useAddr.coordinates.lng }
      : undefined,
    matterSource: { fetchedAt: sub.source_fetched_at || new Date(), updatedAt: sub.source_updated_at ?? null, effectiveState: 'current-snapshot-only', pinSource: manualPin ? 'internal-manual-same-address' : 'matter' },
    matterSubscriptionId: subscriptionId,
    matterCustomerId: sub.customer_id == null ? null : String(sub.customer_id),
    // Matter's id for this saved address — the stable identity pin
    // corrections key on (see Delivery.addressId).
    addressId: useAddr.id != null ? String(useAddr.id) : null
  };
}

/**
 * Imports every subscription with an active delivery on dateKey
 * ("YYYY-MM-DD") as a real Delivery document. Idempotent — safe to re-run
 * for the same date (already-imported subscriptions are skipped, matched by
 * matterSubscriptionId + that day's bounds, not exact scheduledTime, so a
 * dispatcher hand-editing the time afterward doesn't cause a re-run to
 * insert a duplicate).
 *
 * Also skips a subscription entirely if that CUSTOMER already has ANY
 * delivery that day from another source (manual entry, CSV import, etc.) —
 * not just one this job created. Found via real data (2026-09-22, Charles
 * Thompson / subscription 2830): plenty of customers already have today's
 * delivery tracked the existing way, and checking only matterSubscriptionId
 * would have created a genuine duplicate delivery for every one of them —
 * a real duplicate driver stop, not just a harmless double DB row.
 */
export async function importMatterDeliveriesForDate(dateKey) {
  let matches;
  try {
    matches = await matterApiService.findSubscriptionsWithDeliveryOnDate(dateKey);
  } catch (error) {
    if (error.code !== 'INCOMPLETE_DELIVERY_ROSTER') throw error;
    return { date: dateKey, complete: false, total: error.discovery.candidates, created: 0, alreadyExisted: 0, alreadyHadOtherDelivery: 0, customersCreated: 0, noCurrentAddress: 0, failed: error.discovery.failed, discoveryFailed: error.discovery.failed, writeFailed: 0, errors: error.discovery.errors };
  }
  const summary = { date: dateKey, complete: true, discoveryFailed: 0, writeFailed: 0, total: matches.length, created: 0, alreadyExisted: 0, alreadyHadOtherDelivery: 0, customersCreated: 0, noCurrentAddress: 0, noDeliveryWindow: 0, failed: 0, errors: [], comparisons: [] };

  for (const sub of matches) {
    try {
      const subscriptionId = String(sub.subscription_id);
      const { startOfDay, endOfDayExclusive } = getBusinessDayBounds(sub.delivery_date || dateKey);

      const existingFromThisImport = await Delivery.findOne({
        matterSubscriptionId: subscriptionId,
        scheduledTime: { $gte: startOfDay, $lt: endOfDayExclusive }
      }).select('_id customerName status addressId address addressDetails zone gpsLocation scheduledTime');
      if (existingFromThisImport) {
        summary.alreadyExisted += 1;
        const proposed = buildMatterDeliverySnapshot(sub, dateKey);
        summary.comparisons.push(proposed
          ? compareMatterDelivery(existingFromThisImport, proposed, { date: dateKey, fetchedAt: sub.source_fetched_at, addressResolution: resolveMatterDeliveryAddress(sub.customer_addresses) })
          : { deliveryId: String(existingFromThisImport._id), action: 'review-only', effectiveState: 'UNKNOWN', addressResolution: resolveMatterDeliveryAddress(sub.customer_addresses) });
        // A name changed (or was fixed) in Matter after the delivery was
        // imported — keep the sheet in step, unless the delivery is finished.
        const matterName = displayMatterName(sub.name);
        if (matterName && existingFromThisImport.customerName !== matterName && EDITABLE_STATUSES.has(existingFromThisImport.status) && startOfDay >= getBusinessDayBounds(new Date()).startOfDay) {
          await Delivery.updateOne({ _id: existingFromThisImport._id, status: { $in: ['pending', 'assigned'] } }, { $set: { customerName: matterName } });
          summary.namesRefreshed = (summary.namesRefreshed || 0) + 1;
        }
        continue;
      }

      // Owner (2026-10-11): "use only the location that have current from
      // matter api." selectBestAddress (matterApiService.js) falls back to
      // a "most complete"/primary address when no saved address is flagged
      // current_delivery_address — fine for contact-list exports, not for
      // where a driver actually goes, so address_detail alone isn't
      // trusted here. BUT (owner, 2026-10-11, after Adoré Rossouw/Chris
      // Shrubsole/Emily de Rooy's real Monday deliveries got silently
      // skipped): requiring the flag outright turned out too strict —
      // current_delivery_address just isn't reliably set in Matter even for
      // ordinary active customers. The actual goal is "never guess between
      // multiple candidates," not "require the flag" — so a subscription
      // with exactly ONE active address is unambiguous and safe to use even
      // unflagged; only skip when there's genuine ambiguity (0 or 2+ active
      // addresses with none marked current). Checked before customer
      // resolution so a skipped subscription doesn't still leave behind a
      // newly-created Customer record.
      const resolution = resolveMatterDeliveryAddress(sub.customer_addresses);
      const useAddr = resolution.address;
      if (!useAddr) {
        summary.noCurrentAddress += 1;
        summary.comparisons.push({ subscriptionId, serviceDate: dateKey, addressResolution: resolution, action: 'review-only', effectiveState: 'UNKNOWN' });
        continue;
      }

      if (parseWindowHour(sub.delivery_window) == null) {
        summary.noDeliveryWindow += 1;
        summary.comparisons.push({ subscriptionId, serviceDate: dateKey, windowResolution: 'unresolved', action: 'review-only', effectiveState: 'UNKNOWN' });
        continue;
      }

      let customer = (await resolveCustomerMatch({
        email: sub.email,
        phone: sub.phone,
        name: sub.name,
        subscriptionId: sub.subscription_id
      })).customer;

      if (!customer) {
        customer = await createCustomerFromMatterSubscription(sub);
        summary.customersCreated += 1;
      } else {
        // A pre-existing customer may already have today's delivery tracked
        // the existing (non-Matter) way — skip rather than double it up.
        const existingOtherDelivery = await Delivery.findOne({
          customerId: customer.customerId,
          type: 'Delivery',
          scheduledTime: { $gte: startOfDay, $lt: endOfDayExclusive }
        }).select('_id status addressId address addressDetails zone gpsLocation scheduledTime');
        if (existingOtherDelivery) {
          summary.alreadyHadOtherDelivery += 1;
          summary.comparisons.push(compareMatterDelivery(existingOtherDelivery, buildMatterDeliverySnapshot(sub, dateKey), { date: dateKey, fetchedAt: sub.source_fetched_at, addressResolution: resolution }));
          continue;
        }
      }

      const snapshot = buildMatterDeliverySnapshot(sub, dateKey, customer);
      snapshot.customerName = displayMatterName(sub.name)
        || [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim() || 'Matter Customer';
      await Delivery.create(snapshot);
      summary.created += 1;
    } catch (err) {
      summary.failed += 1;
      summary.writeFailed += 1;
      summary.complete = false;
      summary.errors.push({ subscription_id: sub.subscription_id, message: err.message });
    }
  }

  summary.requiresReview = summary.noCurrentAddress > 0 || summary.noDeliveryWindow > 0 || summary.comparisons.some((item) => item.conflicts?.length || item.addressResolution?.status === 'unresolved');
  return summary;
}
