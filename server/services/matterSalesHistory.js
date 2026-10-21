import { normalizeSalesProfile, captureSalesAllocation, hashSalesValue } from './matterSalesCalculations.js';
import { isDateKey, toBusinessDateKey } from '../utils/businessDate.js';
import matter from './matterApiService.js';
import { readSalesSubscriptionList } from './matterSalesService.js';

export async function loadHistoricalMatterSources(deliveries) {
  const current = await readSalesSubscriptionList();
  const ids = [...new Set([...current.map((row) => String(row.subscription_id)), ...deliveries.map((row) => String(row.matterSubscriptionId || '')).filter(Boolean)])];
  const sources = [], failures = [];
  for (let offset = 0; offset < ids.length; offset += 20) {
    const batch = await Promise.all(ids.slice(offset, offset + 20).map(async (id) => {
      try {
        const data = (await matter.getSubscription(id))?.data;
        if (!data || String(data.subscription_id) !== id || data.customer_id == null) throw new Error('identity');
        return data;
      } catch (error) {
        if ([401, 403].includes(error.response?.status)) throw new Error('Matter did not authorize historical subscription access.');
        failures.push({ subscriptionId: id, reason: [404, 410].includes(error.response?.status) ? 'not-returned-by-matter' : 'lookup-failed' });
        return null;
      }
    }));
    sources.push(...batch.filter(Boolean));
  }
  return { sources, failures };
}

// Historical verification is different from pretending a price was captured
// before service. Keep the actual verification time and the underlying evidence.
export function planHistoricalMatterPricing({ deliveries, customers, sources, snapshots = [], verifiedAt = new Date() }) {
  const customersById = new Map(customers.map((row) => [row.customerId, row]));
  const contracts = sources.map((sub) => {
    const profile = normalizeSalesProfile(sub);
    const allocation = captureSalesAllocation(profile, verifiedAt);
    const dates = new Set((sub.delivery_schedule || []).filter((day) => ['active', 'delivered', 'completed'].includes(day.status)).map((day) => String(day.date).slice(0, 10)));
    const conflicting = snapshots.some((snapshot) => (snapshot.profiles || []).some((old) => old.subscriptionId === profile.subscriptionId && old.pricingHash !== profile.pricingHash));
    const evidence = { subscriptionId: profile.subscriptionId, customerId: profile.customerId, profile,
      deliverySchedule: sub.delivery_schedule || [], sourceUpdatedAt: sub.updated_at || null, verifiedAt };
    return { profile, allocation, dates, conflicting, evidence, evidenceHash: hashSalesValue(evidence) };
  });
  const updates = [], unresolved = [];
  for (const delivery of deliveries) {
    if (!['delivered', 'completed'].includes(delivery.status) || delivery.type !== 'Delivery' || String(delivery.company || '').toLowerCase() !== 'matter') continue;
    if (['captured', 'verified-history'].includes(delivery.matterRevenue?.state)) continue;
    const date = toBusinessDateKey(delivery.scheduledTime);
    const internalId = String(customersById.get(delivery.customerId)?.matterCustomerId || '');
    const savedId = String(delivery.matterCustomerId || '');
    const reject = (reason) => unresolved.push({ deliveryId: String(delivery._id), date, reason });
    if (savedId && internalId && savedId !== internalId) { reject('matter-customer-identity-conflict'); continue; }
    const permanentId = savedId || internalId;
    const exact = delivery.matterSubscriptionId ? contracts.filter((contract) => contract.profile.subscriptionId === String(delivery.matterSubscriptionId)) : [];
    const belongs = (contract) => (!permanentId || contract.profile.customerId === permanentId)
      && isDateKey(contract.profile.start) && isDateKey(contract.profile.end) && contract.profile.start <= date && contract.profile.end >= date && contract.dates.has(date);
    // A saved subscription link cannot silently fall through to a different
    // renewal. Without one, the permanent customer/date/calendar must be unique.
    const candidates = delivery.matterSubscriptionId ? exact.filter(belongs)
      : permanentId ? contracts.filter((contract) => contract.profile.customerId === permanentId && belongs(contract)) : [];
    if (candidates.length !== 1) { reject(candidates.length ? 'ambiguous-subscription-period' : 'historical-contract-not-returned-or-linked'); continue; }
    const contract = candidates[0];
    if (contract.conflicting) { reject('subscription-change-needs-effective-date'); continue; }
    if (contract.allocation.state !== 'captured') { reject(contract.allocation.reason); continue; }
    const payment = contract.profile.payments[0];
    if (!payment?.id || !isDateKey(payment.date) || payment.date > date) { reject('historical-payment-does-not-cover-service-date'); continue; }
    if (!delivery.deliveredTime && !delivery.completedAt) { reject('completion-time-missing'); continue; }
    updates.push({ deliveryId: String(delivery._id), date, evidence: contract.evidence, evidenceHash: contract.evidenceHash,
      allocation: { ...contract.allocation, state: 'verified-history', verificationMethod: 'matter-single-payment-contract', verifiedAt,
        historicalServiceDate: date, historicalPaymentId: payment.id, evidenceHash: contract.evidenceHash },
      before: { matterRevenue: delivery.matterRevenue, status: delivery.status, scheduledTime: delivery.scheduledTime,
        customerId: delivery.customerId, matterCustomerId: delivery.matterCustomerId ?? null, matterSubscriptionId: delivery.matterSubscriptionId ?? null,
        deliveredTime: delivery.deliveredTime ?? null, completedAt: delivery.completedAt ?? null } });
  }
  return { updates, unresolved };
}
