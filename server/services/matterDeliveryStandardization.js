import Delivery from '../models/Delivery.js';
import Customer from '../models/Customer.js';
import matterApiService from './matterApiService.js';
import { displayMatterName } from '../utils/matterName.js';
import { getBusinessDayBounds, isDateKey, toBusinessDateKey } from '../utils/businessDate.js';
import { parseWindowHour, scheduledTimeFor } from './matterDeliveryImportService.js';
import { recalculateDriverKPI } from './driverKpiService.js';

const SYNCHRONIZABLE_STATUSES = ['pending', 'assigned', 'delivered', 'completed', 'failed', 'cancelled'];
const APPROVED_HISTORY_START = '2026-10-12';

// Past schedules cannot prove a historical window. Owner explicitly approved
// replacing completed records with CURRENT Matter values on 2026-10-21.
export async function loadCurrentMatterDeliveryProfiles(deliveries, customers) {
  const customerIds = new Set([...customers.map((item) => item.matterCustomerId), ...deliveries.map((item) => item.matterCustomerId)].filter(Boolean).map(String));
  const legacyIds = new Set(deliveries.map((item) => item.matterSubscriptionId).filter(Boolean).map(String));
  const all = await matterApiService.listAllSubscriptions();
  const chosen = new Map();
  for (const id of customerIds) {
    const rows = all.filter((item) => String(item.customer_id) === id);
    const active = rows.filter((item) => item.subscription_status === 'active');
    const candidates = active.length === 1 ? active : rows;
    if (candidates.length === 1) chosen.set(String(candidates[0].subscription_id), candidates[0]);
  }
  for (const row of all) if (legacyIds.has(String(row.subscription_id)) && !customerIds.has(String(row.customer_id))) chosen.set(String(row.subscription_id), row);
  const rows = [...chosen.values()];
  const result = [];
  for (let offset = 0; offset < rows.length; offset += 20) {
    result.push(...await Promise.all(rows.slice(offset, offset + 20).map(async (row) => {
      const sub = (await matterApiService.getSubscription(row.subscription_id))?.data;
      if (!sub || String(sub.subscription_id) !== String(row.subscription_id) || String(sub.customer_id) !== String(row.customer_id)) throw new Error('Matter customer identity could not be verified.');
      return sub;
    })));
  }
  return result;
}

// Only names and windows come from Matter here. Internal profiles supply the
// permanent identity link, never a fallback name, time, or meal configuration.
export function planMatterDeliveryStandardization(deliveries, customers, roster, date, now = new Date(), { useCurrentValues = false } = {}) {
  const byInternalId = new Map(customers.map((customer) => [customer.customerId, customer]));
  const updates = [];
  const unresolved = [];
  for (const delivery of deliveries) {
    if ((!useCurrentValues && date < toBusinessDateKey(now)) || toBusinessDateKey(delivery.scheduledTime) !== date
      || !(useCurrentValues ? SYNCHRONIZABLE_STATUSES : ['pending', 'assigned']).includes(delivery.status) || delivery.type !== 'Delivery'
      || String(delivery.company || '').toLowerCase() !== 'matter') continue;
    const customer = byInternalId.get(delivery.customerId);
    const permanentId = String(delivery.matterCustomerId || customer?.matterCustomerId || '').trim();
    if (delivery.matterCustomerId && customer?.matterCustomerId
      && String(delivery.matterCustomerId) !== String(customer.matterCustomerId)) {
      unresolved.push({ deliveryId: String(delivery._id), reason: 'identity-conflict' });
      continue;
    }
    const matches = roster.filter((sub) => permanentId
      ? String(sub.customer_id) === permanentId
      : delivery.matterSubscriptionId && String(sub.subscription_id) === String(delivery.matterSubscriptionId));
    const sub = matches.length === 1 ? matches[0] : null;
    const name = displayMatterName(sub?.name);
    const hour = parseWindowHour(sub?.delivery_window);
    if (!sub || !name || hour == null || !String(sub.customer_id ?? '').trim()
      || !String(sub.subscription_id ?? '').trim() || (sub.delivery_date && sub.delivery_date !== date && !(useCurrentValues && date < toBusinessDateKey(now)))) {
      unresolved.push({ deliveryId: String(delivery._id), reason: 'missing-or-ambiguous-matter-inputs' });
      continue;
    }
    const scheduledTime = scheduledTimeFor(date, hour);
    const fields = { customerName: name, scheduledTime, matterCustomerId: String(sub.customer_id), matterSubscriptionId: String(sub.subscription_id) };
    if (delivery.customerName === name && +new Date(delivery.scheduledTime) === +scheduledTime
      && String(delivery.matterCustomerId || '') === fields.matterCustomerId
      && String(delivery.matterSubscriptionId || '') === fields.matterSubscriptionId) continue;
    if (+new Date(delivery.scheduledTime) !== +scheduledTime && delivery.deliveredTime) {
      const difference = Math.round((+new Date(delivery.deliveredTime) - +scheduledTime) / 60000);
      fields.lateMinutes = Math.max(0, difference);
      fields.earlyMinutes = Math.max(0, -difference - 180);
      fields.deliveryType = fields.lateMinutes > 0 ? 'late' : fields.earlyMinutes > 0 ? 'early' : 'on-time';
    }
    updates.push({ deliveryId: String(delivery._id), before: { customerName: delivery.customerName, scheduledTime: delivery.scheduledTime },
      identity: { customerId: delivery.customerId, matterCustomerId: delivery.matterCustomerId ?? null, matterSubscriptionId: delivery.matterSubscriptionId ?? null,
        status: delivery.status, deliveredTime: delivery.deliveredTime ?? null, completedAt: delivery.completedAt ?? null }, fields });
  }
  return { updates, unresolved };
}

export async function standardizeMatterDeliveries(date, { dryRun = false, roster, now = new Date(), useCurrentValues = true } = {}) {
  if (!isDateKey(date)) throw new Error('A valid delivery date is required.');
  if (date < APPROVED_HISTORY_START) return { date, updated: 0, unresolved: [], outsideApprovedHistory: true };
  if (!useCurrentValues && date < toBusinessDateKey(now)) return { date, updated: 0, unresolved: [], historical: true };
  const { startOfDay, endOfDayExclusive } = getBusinessDayBounds(date);
  const deliveries = await Delivery.find({ type: 'Delivery', company: /^matter$/i,
    status: { $in: useCurrentValues ? SYNCHRONIZABLE_STATUSES : ['pending', 'assigned'] }, scheduledTime: { $gte: startOfDay, $lt: endOfDayExclusive } }).lean();
  if (!deliveries.length) return { date, updated: 0, unresolved: [] };
  const customers = await Customer.find({ customerId: { $in: deliveries.map((delivery) => delivery.customerId) } })
    .select('customerId matterCustomerId').lean();
  const verifiedRoster = roster || (date < toBusinessDateKey(now)
    ? await loadCurrentMatterDeliveryProfiles(deliveries, customers)
    : await matterApiService.findSubscriptionsWithDeliveryOnDate(date));
  const plan = planMatterDeliveryStandardization(deliveries, customers, verifiedRoster, date, now, { useCurrentValues });
  if (dryRun) return { date, ...plan };
  let updated = 0;
  if (plan.updates.length) {
    const result = await Delivery.bulkWrite(plan.updates.map(({ deliveryId, before, identity, fields }) => ({ updateOne: {
      // A concurrent completion or dispatcher edit must not be overwritten.
      filter: { _id: deliveryId, type: 'Delivery', company: /^matter$/i, ...before, ...identity },
      update: { $set: fields },
    } })));
    updated = result.modifiedCount;
    const changedIds = new Set(plan.updates.filter((item) => +new Date(item.before.scheduledTime) !== +item.fields.scheduledTime).map((item) => item.deliveryId));
    const drivers = new Set(deliveries.filter((item) => changedIds.has(String(item._id)) && item.driver).map((item) => String(item.driver)));
    for (const driver of drivers) await recalculateDriverKPI(driver);
  }
  return { date, updated, unresolved: plan.unresolved };
}

// Coalesce tabs and brief reloads, including when Redis is unavailable.
const recent = new Map();
export async function standardizeMatterDeliveriesForPage(date) {
  const previous = recent.get(date);
  if (previous && previous.expires > Date.now()) return previous.promise;
  for (const [key, value] of recent) if (value.expires <= Date.now()) recent.delete(key);
  const entry = { expires: Infinity };
  entry.promise = standardizeMatterDeliveries(date).then((result) => {
    entry.expires = Date.now() + 60000;
    return result;
  }).catch((error) => { recent.delete(date); throw error; });
  recent.set(date, entry);
  const promise = entry.promise;
  return promise;
}
