import Delivery from '../models/Delivery.js';
import Customer from '../models/Customer.js';
import { addDaysToDateKey, getBusinessDayBounds, toBusinessDateKey } from '../utils/businessDate.js';
import { observeWebsiteDeadline } from './matterBookingDeadline.js';
import { recordReportingDeliveryChanges, withReportingEvents } from './reportingOutbox.js';

export async function appendWebsiteDeadline(delivery, observation) {
  if (!observation || !delivery.customerId
    || observation.serviceDate !== toBusinessDateKey(delivery.scheduledTime)
    || observation.subscriptionId !== String(delivery.matterSubscriptionId)
    || observation.matterCustomerId !== String(delivery.matterCustomerId)) return false;
  const record = { ...observation, customerId: String(delivery.customerId) };
  const path = 'matterBookingObservations';
  return withReportingEvents(async (session, enqueue) => {
    const result = await Delivery.collection.updateOne({
      _id: delivery._id, type: 'Delivery', customerId: delivery.customerId, company: /^matter$/i,
      matterSubscriptionId: delivery.matterSubscriptionId, matterCustomerId: delivery.matterCustomerId,
      scheduledTime: delivery.scheduledTime, status: { $in: ['pending', 'assigned'] },
      [path]: { $not: { $elemMatch: { reference: record.reference, observedAt: record.observedAt } } },
      $or: [
        { [path + '.0']: { $exists: false } },
        // Skip unchanged polls. A late-arriving earlier read still belongs in
        // chronological order and cannot replace a more recent observation.
        { $expr: { $or: [
          { $ne: [{ $arrayElemAt: ['$' + path + '.reference', -1] }, record.reference] },
          { $lt: [record.observedAt, { $arrayElemAt: ['$' + path + '.observedAt', -1] }] },
        ] } },
      ],
    }, { $push: { [path]: { $each: [record], $sort: { observedAt: 1, reference: 1 } } } },
    session ? { session } : {});
    if (!result.modifiedCount) return false;
    await recordReportingDeliveryChanges(session, enqueue, [delivery._id], Delivery.collection);
    return true;
  });
}

// Reuse the normal hourly complete subscription detail read, including on
// installations where the optional creation of tomorrow's deliveries is off.
export async function captureTomorrowWebsiteDeadlines(sources, observedAt) {
  const date = addDaysToDateKey(toBusinessDateKey(observedAt), 1);
  const bounds = getBusinessDayBounds(date);
  const deliveries = await Delivery.find({ type: 'Delivery', company: /^matter$/i,
    scheduledTime: { $gte: bounds.startOfDay, $lt: bounds.endOfDayExclusive },
  }).select('_id customerId matterCustomerId matterSubscriptionId matterImportKey addressId scheduledTime status +matterBookingObservations').lean();
  if (!deliveries.length) return 0;
  const customers = await Customer.find({ customerId: { $in: deliveries.map(row => row.customerId) } })
    .select('customerId matterCustomerId').lean();
  const customerMatches = new Map();
  for (const row of customers) customerMatches.set(row.customerId,
    customerMatches.has(row.customerId) ? null : String(row.matterCustomerId || ''));
  const counts = new Map();
  for (const row of deliveries) {
    const key = customerMatches.get(row.customerId) || row.matterCustomerId;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const bySubscription = new Map();
  // Once a renewal is independently activated its own verified detail takes
  // precedence over a potentially older embedded copy.
  for (const source of sources) {
    if (!source.embedded || !bySubscription.has(source.subscriptionId)) bySubscription.set(source.subscriptionId, source);
  }
  const activeCounts = new Map();
  for (const source of bySubscription.values()) {
    if (source.days?.get(date) === 'active' && source.cycleStart <= date && source.cycleEnd >= date
      && !(source.nextStart && source.nextStart <= date)) {
      activeCounts.set(source.matterCustomerId, (activeCounts.get(source.matterCustomerId) || 0) + 1);
    }
  }
  let changed = 0;
  for (const order of deliveries) {
    if (!['pending','assigned'].includes(order.status) || !order.matterCustomerId || !order.matterSubscriptionId) continue;
    const subscriptionId = String(order.matterSubscriptionId);
    const source = bySubscription.get(subscriptionId);
    const customerId = String(order.matterCustomerId);
    const linked = customerMatches.get(order.customerId);
    if (order.matterImportKey !== date + ':' + subscriptionId && linked !== customerId && !order.matterBookingObservations?.length) continue;
    let reason = null;
    if (!source) reason = 'subscription-unavailable-in-website-read';
    else if (source.unreadable) reason = 'website-deadline-detail-unreadable';
    else if (source.matterCustomerId !== customerId || (customerMatches.has(order.customerId) && linked !== customerId)) reason = 'website-customer-link-conflict';
    else if (counts.get(customerId) !== 1) reason = 'ambiguous-customer-orders';
    else if ((activeCounts.get(customerId) ?? 0) > 1) reason = 'ambiguous-customer-subscriptions';
    const observed = !source || source.matterCustomerId !== customerId
      ? { observedAt: new Date(observedAt).toISOString(), subscriptionId, matterCustomerId: customerId, addressId: '' }
      : source;
    const observation = observeWebsiteDeadline(observed, date, reason);
    if (await appendWebsiteDeadline(order, observation)) changed += 1;
  }
  return changed;
}
