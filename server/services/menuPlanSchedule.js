const key = value => String(value || '').slice(0, 10);
const fail = message => { throw Object.assign(new Error(message), { statusCode: 409 }); };

// A scheduled renewal is embedded in the current subscription detail. Its own
// standalone endpoint may return 404 until activation; never infer its meals
// from the list summary or from the customer's current plan.
export function menuNutritionForDate(nutrition, date) {
  const next = nutrition?.upcoming_plan;
  if (!next) return nutrition;
  const parentId = String(nutrition.subscription_id ?? '').trim();
  const nextId = String(next.subscription_id ?? '').trim();
  const start = key(next.starting_date);
  const parsed = new Date(`${start}T00:00:00Z`);
  if (!parentId || !nextId || nextId === parentId || !nutrition.customer_id || String(next.customer_id) !== String(nutrition.customer_id)
    || String(next.replaces_subscription_id ?? '').trim() !== parentId
    || !/^\d{4}-\d{2}-\d{2}$/.test(start) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== start) {
    return fail('The upcoming Matter plan identity or start date could not be verified.');
  }
  return key(date) >= key(next.starting_date) ? next : nutrition;
}

export function menuPlanDates(nutrition) {
  if (nutrition.upcoming_plan) menuNutritionForDate(nutrition, nutrition.upcoming_plan.starting_date);
  if (nutrition.upcoming_plan && !Array.isArray(nutrition.upcoming_plan.active_delivery_dates)) {
    return fail('The upcoming Matter delivery calendar is unavailable. Please retry.');
  }
  const candidates = [...(nutrition.active_delivery_dates || []), ...(nutrition.upcoming_plan?.active_delivery_dates || [])];
  return [...new Set(candidates)].sort().filter(date => {
    const plan = menuNutritionForDate(nutrition, date);
    return (!plan.starting_date || date >= key(plan.starting_date))
      && (!plan.cycle_end_date || date <= key(plan.cycle_end_date))
      && plan.active_delivery_dates?.includes(date);
  });
}

export function menuMealPlanFields(nutrition) {
  return { matterSubscriptionId: String(nutrition.subscription_id), isUpcomingPlan: nutrition.is_upcoming_plan === true };
}


export function menuReservedDates(nutrition) {
  return [...new Set([nutrition, nutrition?.upcoming_plan].filter(Boolean)
    .flatMap(plan => [...(plan.paused_delivery_dates || []), ...(plan.reserved_resume_dates || [])]))];
}
