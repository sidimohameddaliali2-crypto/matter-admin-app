import Delivery from '../models/Delivery.js';
import matterApiService from './matterApiService.js';
import { resolveCustomerMatch, createCustomerFromMatterSubscription } from './customerMatchService.js';
import { detectAreaFromAddress } from '../config/areas.js';
import { getBusinessDayBounds } from '../utils/businessDate.js';

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
  const match = String(label).match(/(\d{1,2})\s*(AM|PM)/i);
  if (!match) return null;
  let hour = parseInt(match[1], 10);
  if (Number.isNaN(hour) || hour < 1 || hour > 12) return null;
  const isPM = /PM/i.test(match[2]);
  if (isPM && hour !== 12) hour += 12;
  if (!isPM && hour === 12) hour = 0;
  return hour;
}

// "YYYY-MM-DD" (business-local calendar date) + an hour -> the UTC instant
// for that local wall-clock time, same convention scheduledTime uses
// throughout the app (see routes/deliveries.js's normalizeScheduledTimeInput).
export function scheduledTimeFor(dateKey, hour) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hour, 0, 0, 0) - LOCAL_TZ_OFFSET_MS);
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
  return [addr.building, addr.unit ? `Unit ${addr.unit}` : null, addr.floor, addr.area, addr.emirate]
    .filter(Boolean)
    .join(', ');
}

// The safe fallback when nothing is flagged current_delivery_address: if the
// customer has exactly one `status: 'active'` saved address, there's nothing
// to guess between — using it is as safe as the current flag would've been.
// Returns null (caller should skip) when there are zero or multiple active
// addresses and none is marked current, since picking among several really
// would be a guess.
function unambiguousActiveAddress(addresses) {
  const active = (Array.isArray(addresses) ? addresses : []).filter((a) => a.status === 'active');
  return active.length === 1 ? active[0] : null;
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
  const matches = await matterApiService.findSubscriptionsWithDeliveryOnDate(dateKey);
  const summary = { date: dateKey, total: matches.length, created: 0, alreadyExisted: 0, alreadyHadOtherDelivery: 0, customersCreated: 0, noCurrentAddress: 0, failed: 0, errors: [] };

  for (const sub of matches) {
    try {
      const subscriptionId = String(sub.subscription_id);
      const { startOfDay, endOfDayExclusive } = getBusinessDayBounds(sub.delivery_date || dateKey);

      const existingFromThisImport = await Delivery.findOne({
        matterSubscriptionId: subscriptionId,
        scheduledTime: { $gte: startOfDay, $lt: endOfDayExclusive }
      }).select('_id');
      if (existingFromThisImport) {
        summary.alreadyExisted += 1;
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
      const addr = sub.address_detail || {};
      const useAddr = addr.current_delivery_address === true ? addr : unambiguousActiveAddress(sub.customer_addresses);
      if (!useAddr) {
        summary.noCurrentAddress += 1;
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
        }).select('_id');
        if (existingOtherDelivery) {
          summary.alreadyHadOtherDelivery += 1;
          continue;
        }
      }

      const hour = parseWindowHour(sub.delivery_window) ?? DEFAULT_WINDOW_HOUR;
      const scheduledTime = scheduledTimeFor(sub.delivery_date || dateKey, hour);
      const addressLine = buildAddressLine(useAddr) || sub.address || '';
      const customerName = [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim() || sub.name || 'Matter Customer';

      await Delivery.create({
        customerId: customer.customerId,
        customerName,
        scheduledTime,
        company: 'Matter',
        type: 'Delivery',
        address: addressLine,
        addressDetails: {
          label: useAddr.label || '',
          city: useAddr.emirate || '',
          area: useAddr.area || '',
          building: useAddr.building || '',
          floor: useAddr.floor || '',
          apartment: useAddr.unit || '',
          addressStatus: useAddr.status || ''
        },
        zone: useAddr.area || detectAreaFromAddress(addressLine) || '',
        gpsLocation: (useAddr.coordinates && Number.isFinite(useAddr.coordinates.lat) && Number.isFinite(useAddr.coordinates.lng))
          ? { lat: useAddr.coordinates.lat, lng: useAddr.coordinates.lng }
          : undefined,
        matterSubscriptionId: subscriptionId,
        // Matter's id for this saved address — the stable identity pin
        // corrections key on (see Delivery.addressId).
        addressId: useAddr.id != null ? String(useAddr.id) : null
      });
      summary.created += 1;
    } catch (err) {
      summary.failed += 1;
      summary.errors.push({ subscription_id: sub.subscription_id, message: err.message });
    }
  }

  return summary;
}
