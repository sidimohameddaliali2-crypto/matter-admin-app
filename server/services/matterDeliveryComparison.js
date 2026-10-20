// Read-only comparison. A current Matter snapshot cannot establish a future
// or historical effective address/window, nor invalidate a dispatcher correction.
export function compareMatterDelivery(delivery, proposed, { date, fetchedAt, addressResolution } = {}) {
  const conflicts = [];
  const fields = ['addressId', 'address', 'scheduledTime', 'zone', 'gpsLocation', 'addressDetails'];
  const normalized = (field, value) => {
    if (field === 'scheduledTime') return value ? new Date(value).toISOString() : null;
    if (field === 'gpsLocation') return value?.lat != null && value?.lng != null ? { lat: value.lat, lng: value.lng } : null;
    if (field === 'addressDetails') return Object.fromEntries(Object.keys(proposed.addressDetails || {}).sort().map((key) => [key, value?.[key] ?? null]));
    return value ?? null;
  };
  for (const field of fields) {
    const before = normalized(field, delivery[field]);
    const after = normalized(field, proposed[field]);
    if (JSON.stringify(before) !== JSON.stringify(after)) conflicts.push({ field, before, after, source: 'matter', disposition: 'review', reason: 'Effective date and Internal overrides require review.' });
  }
  return {
    deliveryId: String(delivery._id), subscriptionId: proposed.matterSubscriptionId,
    serviceDate: date, fetchedAt, source: 'matter', effectiveState: 'UNKNOWN',
    addressResolution, protected: !['pending', 'assigned'].includes(delivery.status),
    action: 'review-only', conflicts,
  };
}
