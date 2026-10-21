import Snapshot from '../models/MatterSalesSnapshot.js';
import Delivery from '../models/Delivery.js';
import Customer from '../models/Customer.js';
import matter from './matterApiService.js';
import { getBusinessDayBounds, isDateKey, toBusinessDateKey } from '../utils/businessDate.js';
import { normalizeSalesProfile, hashSalesValue, captureSalesAllocation, buildMatterSalesReport } from './matterSalesCalculations.js';

let inFlight;
let lastRefresh = 0;
export async function readSalesSubscriptionList() {
  const rows = new Map();
  let pages = 1;
  for (let page = 1; page <= pages; page++) {
    const result = await matter.listSubscriptions({ page, pageSize: 100 });
    if (result?.success === false || !Array.isArray(result?.data)) throw new Error('Matter subscription list is incomplete.');
    const count = Number(result.meta?.total_pages ?? (result.data.length < 100 ? 1 : NaN));
    if (!Number.isInteger(count) || count < 1 || count > 10000 || (page > 1 && count !== pages)) throw new Error('Matter pagination changed or could not be verified. Retry the capture.');
    pages = count;
    if (!result.data.length && page < pages) throw new Error('Matter subscription page is incomplete.');
    for (const row of result.data) {
      const id = String(row.subscription_id ?? '');
      if (!id || row.customer_id == null || (rows.has(id) && String(rows.get(id).customer_id) !== String(row.customer_id))) throw new Error('Matter subscription identity could not be verified.');
      rows.set(id, row);
    }
  }
  return [...rows.values()];
}
export async function refreshMatterSales() {
  if (inFlight) return inFlight;
  if (Date.now() - lastRefresh < 60000) return { reused: true };
  inFlight = (async () => {
    const list = await readSalesSubscriptionList();
    const profiles = [];
    for (let offset = 0; offset < list.length; offset += 20) {
      profiles.push(...await Promise.all(list.slice(offset, offset + 20).map(async (row) => {
        const sub = (await matter.getSubscription(row.subscription_id))?.data;
        if (!sub || String(sub.subscription_id) !== String(row.subscription_id) || String(sub.customer_id) !== String(row.customer_id)) throw new Error('Matter sales identity could not be verified.');
        return normalizeSalesProfile({ ...sub, subscription_status: sub.subscription_status || row.subscription_status });
      })));
    }
    // No write happens until every source profile has been verified.
    const observedAt = new Date();
    profiles.sort((a, b) => a.subscriptionId.localeCompare(b.subscriptionId));
    const sourceHash = hashSalesValue(profiles);
    const previous = await Snapshot.findOne().sort({ observedAt: -1 }).lean();
    if (previous?.sourceHash !== sourceHash) await Snapshot.create({ observedAt, lastVerifiedAt: observedAt, sourceHash, profiles });
    else await Snapshot.updateOne({ _id: previous._id }, { $set: { lastVerifiedAt: observedAt } });
    const today = toBusinessDateKey(observedAt);
    const capturedDeliveries = await capturePendingMatterRevenue(profiles, observedAt);
    lastRefresh = Date.now();
    return { observedAt, today, profiles: profiles.length, capturedDeliveries };
  })();
  try { return await inFlight; } finally { inFlight = undefined; }
}

export async function capturePendingMatterRevenue(profiles, observedAt = new Date()) {
    if (!profiles) {
      if (Snapshot.db.readyState !== 1) return 0;
      const latest = await Snapshot.findOne().sort({ observedAt: -1 }).lean();
      // Import remains fast and independent of Matter availability. A stale
      // source is never promoted to a fresh price just because a delivery exists.
      if (!latest || Date.now() - +new Date(latest.lastVerifiedAt || latest.observedAt) > 7200000) return 0;
      profiles = latest.profiles;
    }
    const pending = await Delivery.find({ type: 'Delivery', company: /^matter$/i, status: { $in: ['pending', 'assigned', 'on_route', 'picked_up'] },
      scheduledTime: { $gte: observedAt }, matterRevenue: { $exists: false } }).lean();
    const customers = await Customer.find({ customerId: { $in: pending.map((delivery) => delivery.customerId) } }).select('customerId matterCustomerId').lean();
    const byId = new Map(customers.map((customer) => [customer.customerId, String(customer.matterCustomerId || '')]));
    const ops = [];
    const history = await Snapshot.find({ observedAt: { $lt: observedAt } }).select('profiles.subscriptionId profiles.pricingHash').lean();
    const hashes = new Map();
    for (const snapshot of history) for (const profile of snapshot.profiles) {
      if (!hashes.has(profile.subscriptionId)) hashes.set(profile.subscriptionId, new Set());
      hashes.get(profile.subscriptionId).add(profile.pricingHash);
    }
    for (const delivery of pending) {
      const permanent = String(delivery.matterCustomerId || byId.get(delivery.customerId) || '');
      if (delivery.matterCustomerId && byId.get(delivery.customerId) && String(delivery.matterCustomerId) !== byId.get(delivery.customerId)) continue;
      const matches = profiles.filter((profile) => permanent ? profile.customerId === permanent : delivery.matterSubscriptionId && profile.subscriptionId === String(delivery.matterSubscriptionId));
      if (matches.length !== 1) continue;
      const profile = matches[0];
      const day = toBusinessDateKey(delivery.scheduledTime);
      if (!profile.start || !profile.end || day < profile.start || day > profile.end) continue;
      const allocation = captureSalesAllocation(profile, observedAt);
      const past = [...(hashes.get(profile.subscriptionId) || [])].some((hash) => hash !== profile.pricingHash);
      if (past) { allocation.state = 'review'; allocation.reason = 'subscription-change-needs-effective-date'; allocation.unitAmount = null; }
      ops.push({ updateOne: { filter: { _id: delivery._id, type: 'Delivery', company: /^matter$/i, customerId: delivery.customerId,
        matterCustomerId: delivery.matterCustomerId ?? null, matterSubscriptionId: delivery.matterSubscriptionId ?? null,
        matterRevenue: { $exists: false }, status: delivery.status, scheduledTime: delivery.scheduledTime }, update: { $set: { matterRevenue: allocation } } } });
    }
    if (ops.length) return (await Delivery.bulkWrite(ops)).modifiedCount;
    return 0;
}

export async function getMatterSalesReport(from, to) {
  if (!isDateKey(from) || !isDateKey(to) || from > to || Date.parse(to) - Date.parse(from) > 400 * 86400000) throw Object.assign(new Error('Choose a valid range of at most 400 days.'), { statusCode: 400 });
  const [snapshots, deliveries] = await Promise.all([
    Snapshot.find().sort({ observedAt: 1 }).lean(),
    Delivery.find({ type: 'Delivery', company: /^matter$/i, scheduledTime: { $gte: getBusinessDayBounds(from).startOfDay, $lt: getBusinessDayBounds(to).endOfDayExclusive } }).select('customerId customerName matterCustomerId matterSubscriptionId +matterRevenue scheduledTime status type company deliveredTime completedAt').lean(),
  ]);
  const subscriptionIds = [...new Set(deliveries.filter((delivery) => ['captured', 'verified-history'].includes(delivery.matterRevenue?.state)).map((delivery) => delivery.matterRevenue.matterSubscriptionId).filter(Boolean))];
  // Load earlier completed deliveries too: selecting a new month must not grant
  // a fresh allowance. Legacy completion can consume entitlement even when its
  // historical price is unavailable. Failed/cancelled/pending work cannot.
  const entitlementHistory = subscriptionIds.length ? await Delivery.find({ type: 'Delivery', company: /^matter$/i,
    status: { $in: ['delivered', 'completed'] }, scheduledTime: { $lt: getBusinessDayBounds(to).endOfDayExclusive },
    $or: [{ 'matterRevenue.matterSubscriptionId': { $in: subscriptionIds } }, { matterSubscriptionId: { $in: subscriptionIds } }],
  }).select('customerId matterCustomerId matterSubscriptionId +matterRevenue scheduledTime status type company deliveredTime completedAt').lean() : [];
  return buildMatterSalesReport({ snapshots, deliveries, entitlementHistory, from, to, today: toBusinessDateKey(new Date()) });
}
