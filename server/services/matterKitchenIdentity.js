// Kitchen identity is owned by Matter. This module must never import Customer.
export const normalizeMatterEmail = (value) => String(value || '').trim().toLowerCase();

export function matterSelectionIdentity(nutrition) {
  if (!String(nutrition?.customer_id ?? '').trim() || !normalizeMatterEmail(nutrition.customer_email)) {
    const error = new Error('Matter customer ID and website email are required. Verify the account in Matter.');
    error.statusCode = 409;
    throw error;
  }
  const name = String(nutrition.customer_name || '').trim();
  const [firstName, ...rest] = name.split(/\s+/);
  return {
    customerId: String(nutrition.customer_id), matterCustomerId: String(nutrition.customer_id),
    matterEmail: normalizeMatterEmail(nutrition.customer_email),
    matterSubscriptionId: nutrition.subscription_id == null ? null : String(nutrition.subscription_id),
    firstName: firstName || '', lastName: rest.join(' '),
  };
}

export function matterSelectionFilter(menuId, nutrition) {
  const identity = matterSelectionIdentity(nutrition);
  // Modern records join only on permanent Matter ID. Email/subscription may
  // identify an unlinked legacy selection; they cannot override another ID.
  return { weeklyMenuId: menuId, $or: [
    { matterCustomerId: identity.matterCustomerId },
    { matterCustomerId: { $in: [null, ''] }, $or: [
      { email: identity.matterEmail }, { matterEmail: identity.matterEmail },
      ...(identity.matterSubscriptionId ? [{ matterSubscriptionId: identity.matterSubscriptionId }] : []),
    ] },
  ] };
}
