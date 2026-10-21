import Customer from '../models/Customer.js';

// Only allergy data comes from Customer. Matter still owns the menu identity,
// entitlements and exclusions. Never match an allergy profile by phone/name.
export async function resolveMenuAllergyProfile(nutrition) {
  const customerId = String(nutrition.customer_id || '').trim();
  const subscriptionId = String(nutrition.subscription_id || '').trim();
  const email = String(nutrition.customer_email || '').trim().toLowerCase();
  const escapedEmail = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const alternatives = [
    ...(customerId ? [{ matterCustomerId: customerId }] : []),
    ...(subscriptionId ? [{ matterSubscriptionId: subscriptionId }] : []),
    ...(email ? [{ email: new RegExp(`^${escapedEmail}$`, 'i') }] : []),
  ];
  if (!alternatives.length) return { allergies: [], allergiesAvailable: false };
  const candidates = await Customer.find({ $or: alternatives })
    .select('allergies email matterCustomerId matterSubscriptionId').lean();
  const eligible = candidates.filter((c) => !c.matterCustomerId || String(c.matterCustomerId) === customerId);
  const matches = [
    eligible.filter((c) => customerId && String(c.matterCustomerId || '') === customerId),
    eligible.filter((c) => subscriptionId && String(c.matterSubscriptionId || '') === subscriptionId),
    eligible.filter((c) => email && String(c.email || '').trim().toLowerCase() === email),
  ].find((rows) => rows.length) || [];
  if (matches.length > 1) {
    const error = new Error('More than one internal allergy profile matches this account. Please contact customer service.');
    error.statusCode = 409;
    throw error;
  }
  return {
    allergies: [...new Set((matches[0]?.allergies || []).map((a) => String(a).trim()).filter(Boolean))],
    allergiesAvailable: matches.length === 1,
  };
}
