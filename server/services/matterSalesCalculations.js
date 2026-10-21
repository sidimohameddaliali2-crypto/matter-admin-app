import crypto from 'node:crypto';
import { isDateKey, toBusinessDateKey } from '../utils/businessDate.js';

export const hashSalesValue = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const money = (value) => ['number', 'string'].includes(typeof value) && String(value).trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
export const addSalesDays = (key, days) => new Date(Date.parse(key + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);

export function normalizeSalesProfile(sub) {
  const profile = {
    subscriptionId: String(sub.subscription_id ?? ''), customerId: String(sub.customer_id ?? ''),
    name: String(sub.name || ''), plan: String(sub.plan?.name || ''), status: sub.subscription_status,
    start: String(sub.cycle_start_date || sub.starting_date || '').slice(0, 10),
    end: String(sub.cycle_end_date || '').slice(0, 10),
    amountPaid: money(sub.gross_paid), paidDeliveries: money(sub.total_deliveries), currency: sub.currency || null,
    payments: Array.isArray(sub.payments) ? sub.payments.map((payment) => ({
      id: String(payment.id ?? payment.transaction_id ?? ''), amount: money(payment.amount),
      currency: payment.currency || null, date: String(payment.date || '').slice(0, 10), status: payment.status,
    })).sort((a, b) => a.id.localeCompare(b.id)) : null,
  };
  profile.pricingHash = hashSalesValue([profile.subscriptionId, profile.customerId, profile.plan, profile.amountPaid, profile.paidDeliveries, profile.currency, profile.payments]);
  return profile;
}

export function captureSalesAllocation(profile, observedAt) {
  const payments = profile.payments?.filter((payment) => payment.status === 'active');
  let reason = null;
  if (!profile.customerId || !profile.subscriptionId) reason = 'missing-matter-identity';
  else if (profile.currency !== 'AED') reason = 'unsupported-or-missing-currency';
  else if (profile.amountPaid == null || !Number.isInteger(profile.paidDeliveries) || profile.paidDeliveries <= 0) reason = 'missing-paid-entitlement';
  else if (profile.payments?.some((payment) => payment.status !== 'active')) reason = 'payment-status-needs-review';
  else if (!payments || payments.length > 1 || (profile.amountPaid > 0 && payments.length !== 1)) reason = 'payment-allocation-history-required';
  else if (payments.length && (payments[0].currency !== 'AED' || payments[0].amount == null || Math.abs(payments[0].amount - profile.amountPaid) > 0.005)) reason = 'payment-total-does-not-match-entitlement';
  else if (payments.some((payment) => !isDateKey(payment.date) || payment.date > toBusinessDateKey(observedAt))) reason = 'payment-date-needs-review';
  return {
    state: reason ? 'review' : 'captured', reason, capturedAt: new Date(observedAt),
    matterCustomerId: profile.customerId, matterSubscriptionId: profile.subscriptionId,
    plan: profile.plan, sourceHash: profile.pricingHash, currency: profile.currency,
    amountPaid: profile.amountPaid, paidDeliveries: profile.paidDeliveries,
    cycleStart: profile.start, cycleEnd: profile.end,
    unitAmount: reason ? null : profile.amountPaid / profile.paidDeliveries,
  };
}

// A previously captured rate is never replaced by today's customer/subscription.
export function salesPricingForDelivery(delivery, snapshots) {
  const allocation = delivery.matterRevenue;
  if (!allocation || !['captured', 'verified-history'].includes(allocation.state) || allocation.currency !== 'AED'
    || money(allocation.unitAmount) == null) return { amount: null, reason: allocation?.reason || 'historical-pricing-unavailable' };
  const completedAt = delivery.deliveredTime || delivery.completedAt;
  if (allocation.state === 'verified-history') {
    const serviceDate = toBusinessDateKey(delivery.scheduledTime);
    if (!completedAt || !Number.isFinite(+new Date(completedAt)) || allocation.verificationMethod !== 'matter-single-payment-contract'
      || !allocation.evidenceHash || !allocation.historicalPaymentId || allocation.historicalServiceDate !== serviceDate
      || !isDateKey(allocation.cycleStart) || !isDateKey(allocation.cycleEnd) || serviceDate < allocation.cycleStart || serviceDate > allocation.cycleEnd
      || (delivery.matterCustomerId && String(delivery.matterCustomerId) !== allocation.matterCustomerId)) return { amount: null, reason: 'historical-verification-needs-review' };
    return { amount: allocation.unitAmount, reason: null };
  }
  if (!completedAt || !Number.isFinite(+new Date(completedAt)) || !Number.isFinite(+new Date(allocation.capturedAt))
    || !Number.isFinite(+new Date(delivery.scheduledTime)) || +new Date(allocation.capturedAt) > +new Date(completedAt)
    || +new Date(allocation.capturedAt) > +new Date(delivery.scheduledTime)) return { amount: null, reason: 'pricing-not-captured-before-service' };
  if (delivery.matterCustomerId && String(delivery.matterCustomerId) !== allocation.matterCustomerId) return { amount: null, reason: 'matter-customer-identity-conflict' };
  const history = Array.isArray(snapshots) ? snapshots : snapshots ? [snapshots] : [];
  for (const snapshot of history) {
    const time = +new Date(snapshot.observedAt);
    if (time < +new Date(allocation.capturedAt) || time > +new Date(completedAt)) continue;
    const profiles = snapshot.profiles?.filter((profile) => profile.customerId === allocation.matterCustomerId) || [];
    if (profiles.length !== 1 || profiles[0].pricingHash !== allocation.sourceHash) return { amount: null, reason: 'subscription-change-needs-effective-date' };
  }
  return { amount: allocation.unitAmount, reason: null };
}

// Entitlement is shared across reports/months and pricing hashes. Changing a
// price hash must never reset the number of paid deliveries already consumed.
export function classifySalesEntitlements(deliveries, snapshots = []) {
  const keyFor = (customerId, subscriptionId) => customerId && subscriptionId ? `${customerId}:${subscriptionId}` : null;
  const groups = new Map();
  const profileByHash = new Map();
  for (const snapshot of snapshots) for (const profile of snapshot.profiles || []) profileByHash.set(profile.pricingHash, profile);
  for (const delivery of deliveries) {
    const allocation = delivery.matterRevenue;
    if (!['captured', 'verified-history'].includes(allocation?.state) || !Number.isInteger(allocation.paidDeliveries) || allocation.paidDeliveries < 1) continue;
    const key = keyFor(allocation.matterCustomerId, allocation.matterSubscriptionId);
    if (!key) continue;
    const profile = profileByHash.get(allocation.sourceHash);
    const start = allocation.cycleStart || profile?.start;
    const end = allocation.cycleEnd || profile?.end;
    const group = groups.get(key) || { entitlement: allocation.paidDeliveries, start, end, inconsistent: false, count: 0 };
    if (group.entitlement !== allocation.paidDeliveries || (group.start && start && group.start !== start)) group.inconsistent = true;
    // A pause can extend the service period without adding paid deliveries.
    if (end && (!group.end || end > group.end)) group.end = end;
    groups.set(key, group);
  }
  const result = new Map();
  const bySubscription = new Map();
  for (const key of groups.keys()) {
    const subscriptionId = key.slice(key.indexOf(':') + 1);
    if (!bySubscription.has(subscriptionId)) bySubscription.set(subscriptionId, []);
    bySubscription.get(subscriptionId).push(key);
  }
  const completed = deliveries.filter((delivery) => ['delivered', 'completed'].includes(delivery.status)
    && delivery.type === 'Delivery' && String(delivery.company || '').toLowerCase() === 'matter')
    .sort((a, b) => +new Date(a.scheduledTime) - +new Date(b.scheduledTime) || String(a._id).localeCompare(String(b._id)));
  const seen = new Set();
  for (const delivery of completed) {
    if (seen.has(String(delivery._id))) continue;
    seen.add(String(delivery._id));
    const allocation = delivery.matterRevenue;
    const subscriptionId = allocation?.matterSubscriptionId || delivery.matterSubscriptionId;
    const candidates = bySubscription.get(subscriptionId) || [];
    const key = keyFor(allocation?.matterCustomerId || delivery.matterCustomerId, subscriptionId)
      || (candidates.length === 1 ? candidates[0] : null);
    const group = groups.get(key);
    if (!group) continue;
    const date = toBusinessDateKey(delivery.scheduledTime);
    if (group.inconsistent || !isDateKey(group.start) || !isDateKey(group.end)) {
      result.set(String(delivery._id), { review: 'entitlement-history-needs-review' });
      continue;
    }
    if (date < group.start || date > group.end) {
      if (allocation) result.set(String(delivery._id), { review: 'outside-captured-entitlement-period' });
      continue;
    }
    group.count++;
    result.set(String(delivery._id), { additional: group.count > group.entitlement, number: group.count, entitlement: group.entitlement });
  }
  return result;
}

export function buildMatterSalesReport({ snapshots, deliveries, entitlementHistory = deliveries, from, to, today }) {
  const ordered = [...snapshots].sort((a, b) => +new Date(a.observedAt) - +new Date(b.observedAt));
  const latest = ordered.at(-1);
  const current = latest?.profiles || [];
  const captureStartedOn = ordered.length ? toBusinessDateKey(ordered[0].observedAt) : null;
  const days = new Map();
  for (let day = from; day <= to; day = addSalesDays(day, 1)) days.set(day, { day, paymentsReceived: 0, knownDeliveryRevenue: 0, orders: 0, completed: 0, additional: 0, unpriced: 0, pricingReasons: {}, unknownPayments: 0 });
  // The same payment can be exposed on more than one subscription. Identity
  // is customer + Matter payment ID, never subscription + payment ID.
  const payments = new Map();
  let unidentifiedPayments = current.filter((profile) => !Array.isArray(profile.payments)).length;
  for (const snapshot of ordered) {
    const seen = new Map();
    for (const profile of snapshot.profiles) for (const payment of profile.payments || []) {
      if (!payment.id || !profile.customerId) { unidentifiedPayments++; continue; }
      const key = profile.customerId + ':' + payment.id;
      const value = { ...payment, customerId: profile.customerId };
      if (seen.has(key) && JSON.stringify(seen.get(key)) !== JSON.stringify(value)) value.conflict = true;
      seen.set(key, value);
    }
    for (const [key, value] of seen) payments.set(key, value);
  }
  for (const payment of payments.values()) {
    if (!isDateKey(payment.date)) { unidentifiedPayments++; continue; }
    const day = days.get(payment.date);
    if (!day) continue;
    if (payment.status !== 'active' || payment.conflict || payment.currency !== 'AED' || payment.amount == null) day.unknownPayments++;
    else day.paymentsReceived += payment.amount;
  }
  const details = [];
  const entitlements = classifySalesEntitlements([...new Map([...entitlementHistory, ...deliveries].map((delivery) => [String(delivery._id), delivery])).values()], ordered);
  for (const delivery of deliveries) {
    const date = toBusinessDateKey(delivery.scheduledTime);
    const day = days.get(date);
    if (!day || delivery.type !== 'Delivery' || String(delivery.company || '').toLowerCase() !== 'matter' || delivery.status === 'cancelled') continue;
    const entitlement = entitlements.get(String(delivery._id));
    const additional = entitlement?.additional === true;
    if (additional) day.additional++;
    else day.orders++;
    const completed = ['delivered', 'completed'].includes(delivery.status);
    const pricing = additional ? { amount: 0, reason: 'additional-delivery-excluded' }
      : entitlement?.review ? { amount: null, reason: entitlement.review }
        : completed ? salesPricingForDelivery(delivery, ordered) : { amount: null, reason: 'not-completed' };
    if (completed && !additional) {
      day.completed++;
      if (pricing.amount == null) { day.unpriced++; day.pricingReasons[pricing.reason] = (day.pricingReasons[pricing.reason] || 0) + 1; }
      else day.knownDeliveryRevenue += pricing.amount;
    }
    details.push({ id: String(delivery._id), date, customerId: delivery.customerId, matterCustomerId: delivery.matterRevenue?.matterCustomerId || delivery.matterCustomerId || null,
      name: delivery.customerName, status: delivery.status, plan: delivery.matterRevenue?.plan || null,
      subscriptionId: delivery.matterRevenue?.matterSubscriptionId || null, paidDeliveries: delivery.matterRevenue?.paidDeliveries ?? null,
      additional, includedInPaidCounts: !additional, entitlementDeliveryNumber: entitlement?.number ?? null, paidEntitlement: entitlement?.entitlement ?? null,
      amountPaid: delivery.matterRevenue?.amountPaid ?? null, unitAmount: completed && !additional ? pricing.amount : null, pricingStatus: pricing.reason || 'captured', revenue: pricing.amount });
  }
  const sum = (start, end) => [...days.values()].filter((day) => day.day >= start && day.day <= end).reduce((total, day) => {
    for (const key of ['paymentsReceived', 'knownDeliveryRevenue', 'orders', 'completed', 'additional', 'unpriced', 'unknownPayments']) total[key] += day[key];
    return total;
  }, { paymentsReceived: 0, knownDeliveryRevenue: 0, orders: 0, completed: 0, additional: 0, unpriced: 0, unknownPayments: 0 });
  const active = new Map(current.filter((profile) => profile.status === 'active' && (!profile.end || profile.end >= today)).map((profile) => [profile.subscriptionId, profile]));
  const starts = new Set(current.filter((profile) => profile.start >= addSalesDays(today, -6) && profile.start <= today).map((profile) => profile.subscriptionId));
  const plans = new Map();
  for (const profile of active.values()) {
    const plan = plans.get(profile.plan) || { plan: profile.plan || 'Unspecified', count: 0, knownPlanValue: 0, missingValue: 0 };
    plan.count++;
    if (profile.amountPaid == null || profile.currency !== 'AED') plan.missingValue++;
    else plan.knownPlanValue += profile.amountPaid;
    plans.set(profile.plan, plan);
  }
  return { from, to, today, observedAt: latest?.lastVerifiedAt || latest?.observedAt || null, days: [...days.values()], details, totals: sum(from, to),
    activeSubscriptions: active.size, subscriptionStartsLast7Days: starts.size, renewalRate: null,
    renewalReason: 'Matter does not provide complete renewal events and the eligible historical cohort.',
    paymentCoverage: 'Payments observed in Matter; accounts absent before the first capture cannot be reconstructed.',
    captureStartedOn, unidentifiedPayments, plans: [...plans.values()] };
}
