// Renewal-screen allowance. This is the screen's existing consumption rule,
// not a new subscription-lifecycle contract.
//
// Every delivery whose status is not cancelled counts as used, including
// pending, assigned, on_route, picked_up, failed, completed, collected and
// delivered. Cancelled does not. A used row is not proof the meal was handed
// over. Weekend stop combining on GET /deliveries is presentation only and
// is not applied here. Remaining is cycle duration minus used and is not
// clamped at zero. Current-cycle isolation, pauses and historical relinking
// are not decided here.

export const RENEWAL_IGNORED_STATUSES = Object.freeze(['cancelled', 'Cancelled', 'CANCELLED']);

const ignored = new Set(RENEWAL_IGNORED_STATUSES);

function parseInstant(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function remainingEntitlement(cycleDuration, used) {
  const total = Number(cycleDuration);
  const consumed = Number(used);
  if (!Number.isFinite(total) || !Number.isFinite(consumed)) return null;
  return total - consumed;
}

// In-memory form of the same rule. Tests use it so a global first-N slice
// cannot change one customer's balance.
export function summarizeRenewalUsage(rows) {
  const byCustomer = new Map();
  for (const row of rows || []) {
    const customerId = row?.customerId;
    if (!customerId || ignored.has(row.status)) continue;
    const current = byCustomer.get(customerId) || {
      customerId,
      used: 0,
      lastScheduledTime: null,
    };
    current.used += 1;
    if (row.scheduledTime) {
      const time = new Date(row.scheduledTime);
      const previous = current.lastScheduledTime ? new Date(current.lastScheduledTime) : null;
      if (!Number.isNaN(time.getTime()) && (!previous || time > previous)) {
        current.lastScheduledTime = time.toISOString();
      }
    }
    byCustomer.set(customerId, current);
  }
  return [...byCustomer.values()];
}

// No $limit and no find().limit. Callers must not page this pipeline.
export function renewalUsagePipeline({ dateFrom, dateTo } = {}) {
  const match = {
    status: { $nin: [...RENEWAL_IGNORED_STATUSES] },
    customerId: { $nin: [null, ''] },
  };
  const start = parseInstant(dateFrom);
  const end = parseInstant(dateTo);
  if (start || end) {
    match.scheduledTime = {};
    if (start) match.scheduledTime.$gte = start;
    if (end) match.scheduledTime.$lte = end;
  }
  return [
    { $match: match },
    {
      $group: {
        _id: '$customerId',
        used: { $sum: 1 },
        lastScheduledTime: { $max: '$scheduledTime' },
      },
    },
    {
      $project: {
        _id: 0,
        customerId: '$_id',
        used: 1,
        lastScheduledTime: 1,
      },
    },
  ];
}
