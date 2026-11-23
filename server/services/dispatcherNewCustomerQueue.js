import { newSubscriptionCustomers } from './dispatcherLocationReviewService.js';
import { getBusinessDayBounds } from '../utils/businessDate.js';
const key = value => value == null ? '' : String(value).trim();
export const UPCOMING_DELIVERY_STATUSES = ['pending', 'assigned', 'on_route', 'picked_up'];
const addLink = (map, id, customer) => {
  if (!id || !customer) return;
  map.set(id, map.has(id) && map.get(id) !== customer ? null : customer);
};
export function buildNewCustomerQueue(sources, customers, deliveries, now = new Date()) {
  const candidates = newSubscriptionCustomers(sources).subscriptions;
  const subscriptionOwners = new Map(), internalOwners = new Map();
  for (const s of sources) addLink(subscriptionOwners, key(s.subscription_id), key(s.customer_id));
  for (const c of customers) addLink(internalOwners, key(c.customerId), key(c.matterCustomerId) || subscriptionOwners.get(key(c.matterSubscriptionId)));
  const owner = d => key(d.matterCustomerId) || (key(d.matterSubscriptionId) ? subscriptionOwners.get(key(d.matterSubscriptionId)) : null) || internalOwners.get(key(d.customerId));
  const served = new Set(), upcoming = new Map(), { startOfDay } = getBusinessDayBounds(now);
  for (const d of deliveries) {
    if (d.type !== 'Delivery') continue;
    const id = owner(d);
    if (!id) continue;
    if (['delivered', 'completed'].includes(d.status)) { served.add(id); continue; }
    const time = new Date(d.scheduledTime);
    if (!UPCOMING_DELIVERY_STATUSES.includes(d.status) || !Number.isFinite(+time) || time < startOfDay) continue;
    if (!upcoming.has(id)) upcoming.set(id, []);
    upcoming.get(id).push(d);
  }
  const candidateCounts = new Map();
  for (const s of candidates) candidateCounts.set(key(s.customer_id), (candidateCounts.get(key(s.customer_id)) || 0) + 1);
  const subscriptions = candidates.flatMap(s => {
    const id = key(s.customer_id);
    if (served.has(id)) return [];
    const jobs = (upcoming.get(id) || []).filter(d => key(d.matterSubscriptionId) === key(s.subscription_id) || (!key(d.matterSubscriptionId) && candidateCounts.get(id) === 1)).sort((a,b) => new Date(a.scheduledTime) - new Date(b.scheduledTime));
    return jobs.length ? [{...s, nextDeliveryAt:new Date(jobs[0].scheduledTime).toISOString()}] : [];
  }).sort((a,b) => new Date(a.nextDeliveryAt) - new Date(b.nextDeliveryAt));
  return { subscriptions, count:new Set(subscriptions.map(s => key(s.customer_id))).size };
}
export async function loadNewCustomerQueue({matter, Customer, Delivery, now = new Date()}) {
  const sources = await matter.listAllSubscriptions();
  const candidates = newSubscriptionCustomers(sources).subscriptions;
  if (!candidates.length) return {subscriptions:[],count:0};
  const ids = [...new Set(candidates.map(s => key(s.customer_id)))];
  const subscriptions = sources.filter(s => ids.includes(key(s.customer_id))).map(s => key(s.subscription_id)).filter(Boolean);
  const customers = await Customer.find({$or:[{matterCustomerId:{$in:ids}},{matterSubscriptionId:{$in:subscriptions}}]}).select('customerId matterCustomerId matterSubscriptionId').lean();
  const {startOfDay} = getBusinessDayBounds(now);
  const deliveries = await Delivery.find({type:'Delivery', $and:[{$or:[{matterCustomerId:{$in:ids}},{matterSubscriptionId:{$in:subscriptions}},{customerId:{$in:customers.map(c=>c.customerId).filter(Boolean)}}]},{$or:[{status:{$in:['delivered','completed']}},{status:{$in:UPCOMING_DELIVERY_STATUSES},scheduledTime:{$gte:startOfDay}}]}]}).select('customerId matterCustomerId matterSubscriptionId type status scheduledTime').lean();
  return buildNewCustomerQueue(sources, customers, deliveries, now);
}
