// Owner (2026-10-20): Matter owns kitchen subscription inputs. Never resolve
// delivery ambiguity through array order or address completeness.
export function resolveMatterDeliveryAddress(addresses) {
  const list = Array.isArray(addresses) ? addresses : [];
  const current = list.filter((address) => address?.current_delivery_address === true);
  if (current.length === 1) return { status: 'resolved', reason: 'current', address: current[0] };
  if (current.length > 1) return { status: 'unresolved', reason: 'multiple-current-addresses', address: null };
  const active = list.filter((address) => address?.status === 'active');
  if (active.length === 1) return { status: 'resolved', reason: 'single-active-address', address: active[0] };
  return { status: 'unresolved', reason: active.length ? 'multiple-active-addresses' : 'no-active-address', address: null };
}

export function matterMealContract(subscription) {
  const count = subscription?.plan?.meal_frequency;
  const snacks = subscription?.snacks_per_day;
  return {
    source: 'matter', subscriptionId: subscription?.subscription_id == null ? null : String(subscription.subscription_id),
    mealsPerDay: Number.isInteger(count) && count > 0 ? count : null,
    snacksPerDay: Number.isInteger(snacks) && snacks >= 0 ? snacks : null,
    breakfastIncluded: typeof subscription?.breakfast_included === 'boolean' ? subscription.breakfast_included : null,
    planName: subscription?.plan?.name ?? null,
    units: String(subscription?.plan?.name || '').trim().toLowerCase() === 'matter core' ? 'food-weight-grams' : 'nutrient-grams',
    // The current upstream response contains no dated address/window history.
    effectiveState: 'current-snapshot-only',
  };
}
