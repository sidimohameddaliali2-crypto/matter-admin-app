export const dubaiToday = (now = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(now);

export function customerMatterMetadata(customer) {
  const metadata = customer?.matterMetadata;
  if (!metadata) return null;
  if (customer.matterCustomerId) return String(customer.matterCustomerId) === metadata.customer_id ? metadata : null;
  return String(customer.matterSubscriptionId || '') === metadata.subscription_id ? metadata : null;
}

export function hasUpcomingPlan(customer, today = dubaiToday()) {
  const plan = customerMatterMetadata(customer)?.upcoming_plan;
  if (!plan) return false;
  // Do not infer a start date from updated_at. An undated upcoming plan stays
  // visible with an explicit unavailable date until Matter supplies one.
  return !plan.starting_date || plan.starting_date.slice(0, 10) >= today;
}

export const customerType = customer => customerMatterMetadata(customer)?.customer_type || '';
// Website Customer Management also includes subscribers without an internal record.
export const websiteMetadataCustomer = subscription => ({
  matterCustomerId: subscription?.customer_id == null ? null : String(subscription.customer_id),
  matterSubscriptionId: subscription?.subscription_id == null ? null : String(subscription.subscription_id),
  matterMetadata: subscription ? { ...subscription,
    customer_id: subscription.customer_id == null ? '' : String(subscription.customer_id),
    subscription_id: subscription.subscription_id == null ? '' : String(subscription.subscription_id),
  } : null,
});
export const typeLabel = value => value ? String(value).replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()) : 'Not provided';
export const matchesCustomerType = (customer, type) => !type || (type === '__unknown' ? !customerType(customer) : customerType(customer) === type);

export const matterDateLabel = value => value && /^\d{4}-\d{2}-\d{2}$/.test(value)
  ? new Date(`${value}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
  : 'Not provided';
