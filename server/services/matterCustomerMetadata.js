import Customer from '../models/Customer.js';
import matter from './matterApiService.js';
import { isDeepStrictEqual } from 'node:util';

const id = value => value == null ? '' : String(value).trim();
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// Preserve missing fields as unknown; explicit null/[] clears a previous value.
export function captureCustomerMetadata(row, previous = {}, fetchedAt = new Date()) {
  if (!id(row?.subscription_id) || !id(row?.customer_id) || !Number.isFinite(Date.parse(row.updated_at))) {
    throw new Error('Matter customer metadata identity or update date is missing.');
  }
  if (id(previous.customer_id) !== id(row.customer_id) || id(previous.subscription_id) !== id(row.subscription_id)) previous = {};
  const metadata = { ...previous, subscription_id: id(row.subscription_id), customer_id: id(row.customer_id),
    updated_at: new Date(row.updated_at), fetchedAt };
  if (own(row, 'customer_type')) metadata.customer_type = row.customer_type == null ? null : String(row.customer_type);
  if (own(row, 'customer_tags')) {
    if (row.customer_tags !== null && !Array.isArray(row.customer_tags)) throw new Error('Matter customer tags are invalid.');
    metadata.customer_tags = row.customer_tags == null ? null : row.customer_tags.map(tag => ({
      id: id(tag.id), name: String(tag.name || ''), color: /^#[a-f\d]{6}$/i.test(tag.color) ? tag.color : null,
    })).filter(tag => tag.name);
  }
  if (own(row, 'upcoming_plan')) {
    const plan = row.upcoming_plan;
    if (plan != null && (!id(plan.subscription_id) || id(plan.customer_id) !== id(row.customer_id))) {
      throw new Error('Matter upcoming plan customer identity does not match.');
    }
    metadata.upcoming_plan = plan == null ? null : {
      subscription_id: id(plan.subscription_id), customer_id: id(plan.customer_id),
      plan: { name: plan.plan?.name == null ? null : String(plan.plan.name) },
      subscription_status: plan.subscription_status ?? null,
      starting_date: plan.starting_date ?? null, cycle_end_date: plan.cycle_end_date ?? null,
      updated_at: plan.updated_at ?? null,
    };
  }
  return metadata;
}

export function findCustomerMetadataRow(customer, rows) {
  // A permanent identity takes precedence over a potentially obsolete subscription.
  const matches = customer.matterCustomerId
    ? rows.filter(row => id(row.customer_id) === id(customer.matterCustomerId))
    : rows.filter(row => id(row.subscription_id) === id(customer.matterSubscriptionId) && id(customer.matterSubscriptionId));
  // Never silently select one of several subscriptions for the same customer.
  return matches.length === 1 ? matches[0] : null;
}

export async function readCustomerMetadataRows(api = matter) {
  const rows = [];
  const ids = new Set();
  let pages;
  let total;
  for (let page = 1; page <= (pages ?? 1); page++) {
    const response = await api.listSubscriptions({ page, pageSize: 100 });
    const count = Number(response?.meta?.total_pages);
    const records = Number(response?.meta?.total_records);
    if (response?.success === false || !Array.isArray(response?.data) || !Number.isInteger(count) || count < 1 || count > 10000
      || !Number.isInteger(records) || records < 0 || (pages != null && (pages !== count || total !== records))) {
      throw new Error('Matter metadata pagination is incomplete or changed. Retry the refresh.');
    }
    pages = count;
    total = records;
    for (const row of response.data) {
      captureCustomerMetadata(row); // Validate the complete response before any write.
      if (ids.has(id(row.subscription_id))) throw new Error('Matter metadata contains duplicate subscriptions.');
      ids.add(id(row.subscription_id));
      rows.push(row);
    }
  }
  if (rows.length !== total) throw new Error('Matter metadata roster is incomplete. Retry the refresh.');
  return rows;
}

let inFlight;
let lastSuccess = 0;
export function createCustomerMetadataRefresh({ api = matter, customers = Customer, clock = () => new Date() } = {}) {
  return async () => {
    const fetchedAt = clock();
    // Read every list page, rather than using updated_since: a nested upcoming
    // plan can change independently of the parent's update clock.
    const rows = await readCustomerMetadataRows(api);
    const docs = await customers.find({ $or: [
      { matterCustomerId: { $nin: [null, ''], $exists: true } },
      { matterSubscriptionId: { $nin: [null, ''], $exists: true } },
    ] }).select('_id matterCustomerId matterSubscriptionId matterMetadata').lean();
    let updated = 0;
    let unmatched = 0;
    for (const customer of docs) {
      const row = findCustomerMetadataRow(customer, rows);
      if (!row) { unmatched++; continue; }
      const old = customer.matterMetadata || {};
      const sameSource = old.customer_id === id(row.customer_id) && old.subscription_id === id(row.subscription_id);
      // Renewal records have their own update clock; compare source timestamps
      // only within the same subscription, and fence all sources by capture time.
      if (sameSource && +new Date(old.updated_at) > +new Date(row.updated_at)) continue;
      const metadata = captureCustomerMetadata(row, old, fetchedAt);
      if (isDeepStrictEqual({ ...old, fetchedAt: undefined }, { ...metadata, fetchedAt: undefined })) continue;
      const result = await customers.updateOne({ _id: customer._id,
        matterCustomerId: customer.matterCustomerId ?? null,
        matterSubscriptionId: customer.matterSubscriptionId ?? null,
        $and: [
          { $or: [{ 'matterMetadata.fetchedAt': { $exists: false } }, { 'matterMetadata.fetchedAt': { $lt: fetchedAt } }] },
          { $or: [{ 'matterMetadata.updated_at': { $exists: false } }, { 'matterMetadata.updated_at': { $lte: metadata.updated_at } },
            { 'matterMetadata.customer_id': { $ne: metadata.customer_id } }, { 'matterMetadata.subscription_id': { $ne: metadata.subscription_id } }] },
        ],
      }, { $set: { matterMetadata: metadata } });
      updated += result.modifiedCount || 0;
    }
    return { fetchedAt, updated, unmatched, subscriptions: rows.length };
  };
}

const refresh = createCustomerMetadataRefresh();
export async function refreshCustomerMetadata() {
  if (inFlight) return inFlight;
  if (Date.now() - lastSuccess < 60000) return { cached: true };
  inFlight = refresh();
  try { const result = await inFlight; lastSuccess = Date.now(); return result; }
  finally { inFlight = null; }
}
