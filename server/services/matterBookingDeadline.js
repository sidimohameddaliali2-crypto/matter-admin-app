import { isDateKey, toBusinessDateKey } from '../utils/businessDate.js';
import { captureSalesAllocation, hashSalesValue, normalizeSalesProfile } from './matterSalesCalculations.js';
import { resolveMatterDeliveryAddress } from './matterSubscriptionContract.js';
import { menuNutritionForDate } from './menuPlanSchedule.js';

const basis = 'website-observed-deadline-v1';
const id = value => value == null ? '' : String(value);
const dateOf = value => typeof value === 'string' ? value.slice(0, 10) : '';
const timeOf = value => {
  const match = typeof value === 'string' && /^By\s+(1[0-2]|[1-9])(?::([0-5]\d))?\s*(AM|PM)$/i.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]) % 12 + (match[3].toUpperCase() === 'PM' ? 12 : 0);
  return String(hour).padStart(2, '0') + ':' + (match[2] || '00');
};

// The website publishes a customer's current "By" selection. Neither the
// label nor a payment authorizes reconstructing a promised opening time.
export function websiteDeadlineSource(sub, observedAt, profile = normalizeSalesProfile(sub)) {
  const address = resolveMatterDeliveryAddress(sub.customer_addresses).address;
  const paid = captureSalesAllocation(profile, observedAt);
  const payment = profile.payments?.[0];
  const days = new Map();
  for (const entry of Array.isArray(sub.delivery_schedule) ? sub.delivery_schedule : []) {
    const day = dateOf(entry?.date);
    if (!isDateKey(day)) continue;
    days.set(day, days.has(day) ? 'ambiguous' : entry.status);
  }
  return {
    observedAt: new Date(observedAt).toISOString(), subscriptionId: profile.subscriptionId,
    matterCustomerId: profile.customerId, cycleStart: dateOf(sub.cycle_start_date), cycleEnd: dateOf(sub.cycle_end_date),
    addressId: address?.status === 'active' ? id(address.id) : '', windowId: id(sub.delivery_window?.id),
    time: sub.delivery_window?.timezone === 'Asia/Dubai' ? timeOf(sub.delivery_window.label) : null,
    paid: ['active','paused','cancelled'].includes(profile.status)
      && paid.state === 'captured' && profile.amountPaid > 0 && !!payment?.id,
    pricingHash: profile.pricingHash, days, nextStart: dateOf(sub.upcoming_plan?.starting_date),
  };
}

export function salesWebsiteDeadlineSources(sub, observedAt, profile) {
  const current = websiteDeadlineSource(sub, observedAt, profile);
  const renewal = sub.upcoming_plan;
  if (!renewal || menuNutritionForDate(sub, renewal.starting_date) !== renewal) return [current];
  return [current, { ...websiteDeadlineSource(renewal, observedAt), embedded: true }];
}

export function observeWebsiteDeadline(source, serviceDate, fallbackReason = null) {
  if (!source || !isDateKey(serviceDate) || !source.subscriptionId || !source.matterCustomerId
    || !(Date.parse(source.observedAt) < Date.parse(serviceDate + 'T00:00:00+04:00'))) return null;
  let reason = fallbackReason || (source.unreadable ? 'website-deadline-detail-unreadable' : null);
  if (!reason && (!isDateKey(source.cycleStart) || !isDateKey(source.cycleEnd)
    || serviceDate < source.cycleStart || serviceDate > source.cycleEnd
    || (isDateKey(source.nextStart) && source.nextStart <= serviceDate))) reason = 'paid-cycle-date-unverified';
  if (!reason && source.days.get(serviceDate) !== 'active') reason = 'active-service-date-unverified';
  if (!reason && !source.paid) reason = 'dated-payment-unverified';
  if (!reason && !source.addressId) reason = 'active-address-unverified';
  if (!reason && (!source.windowId || !source.time)) reason = 'website-deadline-unverified';
  const end = reason ? null : new Date(serviceDate + 'T' + source.time + ':00+04:00').toISOString();
  const { subscriptionId, matterCustomerId, addressId, observedAt } = source;
  const reference = hashSalesValue([basis, serviceDate, subscriptionId, matterCustomerId, addressId,
    source.windowId, source.pricingHash, end, reason]);
  return { serviceDate, subscriptionId, matterCustomerId, addressId, observedAt, reference, end, reason };
}

export function withholdOverlappingWebsiteDeadlines(rows) {
  const counts = new Map();
  const group = row => JSON.stringify([String(row.customer_id), row.delivery_date]);
  for (const row of rows) counts.set(group(row), (counts.get(group(row)) || 0) + 1);
  for (const row of rows) {
    const evidence = row.bookingObservation;
    if (evidence && counts.get(group(row)) > 1) {
      const reason = 'ambiguous-customer-subscriptions';
      row.bookingObservation = { ...evidence, end: null, reason, reference: hashSalesValue([evidence.reference, reason]) };
    }
  }
}

export function bookingDeadlineEvidence(delivery) {
  const serviceDate = toBusinessDateKey(delivery.scheduledTime);
  const observations = delivery.matterBookingObservations ?? [];
  if (!observations.length) return { state: 'unverified', reason: 'no-pre-service-website-observation' };
  if (!observations.every(row => row.serviceDate === serviceDate && row.subscriptionId === id(delivery.matterSubscriptionId)
    && row.matterCustomerId === id(delivery.matterCustomerId) && row.customerId === id(delivery.customerId))) {
    return { state: 'unverified', reason: 'website-order-identity-changed' };
  }
  const first = observations.find(row => row.end);
  const latest = observations.at(-1);
  if (!first) return { state: 'unverified', reason: latest.reason || 'website-deadline-unverified' };
  const bound = row => ({ addressId: row.addressId, start: null, end: row.end,
    observedAt: row.observedAt, reference: row.reference });
  const conflictingClock = observations.some(row => row.observedAt === latest.observedAt && row.reference !== latest.reference);
  const reason = latest.reason || (conflictingClock ? 'simultaneous-website-observations-conflict'
    : latest.addressId !== id(delivery.addressId) ? 'website-destination-conflict' : null);
  return { state: 'partial', basis, serviceDate, subscriptionId: latest.subscriptionId,
    matterCustomerId: latest.matterCustomerId, addressId: id(delivery.addressId),
    coverage: 'pre-service-observations-only', original: bound(first), effective: reason ? null : bound(latest),
    reason: reason || 'opening-and-customer-amendment-history-unavailable' };
}
