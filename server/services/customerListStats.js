// Customer-list delivery counters. These are the counters the Customers page
// used to compute from whatever GET /deliveries returned. They are not a new
// subscription-lifecycle contract.
//
// totalDeliveries counts every row except status "cancelled", including
// pending, assigned, on_route, picked_up, failed, completed and delivered.
// completedDeliveries is status "delivered" only. pendingDeliveries is
// pending, assigned or picked_up. lateDeliveries and totalLateMinutes count
// lateMinutes > 0 on any status. lastDeliveryDate is the latest scheduledTime,
// including a cancelled row. A counted row is not proof the meal was handed over.
//
// GET /deliveries caps a page at 500 oldest rows and then combines weekend
// stops. That presentation must not change these counters. This pipeline has
// no $limit. Current-cycle isolation, pauses and historical relinking are
// not decided here.

const PENDING_STATUSES = Object.freeze(['pending', 'assigned', 'picked_up']);

function blankStats(customerId) {
  return {
    customerId,
    totalDeliveries: 0,
    completedDeliveries: 0,
    pendingDeliveries: 0,
    lateDeliveries: 0,
    totalLateMinutes: 0,
    lastDeliveryDate: null,
  };
}

export function summarizeCustomerListStats(rows) {
  const byCustomer = new Map();
  for (const row of rows || []) {
    const customerId = row?.customerId;
    if (!customerId) continue;
    const current = byCustomer.get(customerId) || blankStats(customerId);
    if (row.status !== 'cancelled') current.totalDeliveries += 1;
    if (row.scheduledTime) {
      const time = new Date(row.scheduledTime);
      const previous = current.lastDeliveryDate ? new Date(current.lastDeliveryDate) : null;
      if (!Number.isNaN(time.getTime()) && (!previous || time > previous)) {
        current.lastDeliveryDate = time.toISOString();
      }
    }
    if (row.status === 'delivered') current.completedDeliveries += 1;
    else if (PENDING_STATUSES.includes(row.status)) current.pendingDeliveries += 1;
    if (row.lateMinutes > 0) {
      current.lateDeliveries += 1;
      current.totalLateMinutes += row.lateMinutes;
    }
    byCustomer.set(customerId, current);
  }
  return [...byCustomer.values()];
}

// No $limit and no find().limit. Callers must not page this pipeline.
export function customerListStatsPipeline() {
  return [
    { $match: { customerId: { $nin: [null, ''] } } },
    {
      $group: {
        _id: '$customerId',
        totalDeliveries: {
          $sum: { $cond: [{ $ne: ['$status', 'cancelled'] }, 1, 0] },
        },
        completedDeliveries: {
          $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, 1, 0] },
        },
        pendingDeliveries: {
          $sum: { $cond: [{ $in: ['$status', [...PENDING_STATUSES]] }, 1, 0] },
        },
        lateDeliveries: {
          $sum: { $cond: [{ $gt: ['$lateMinutes', 0] }, 1, 0] },
        },
        totalLateMinutes: {
          $sum: { $cond: [{ $gt: ['$lateMinutes', 0] }, '$lateMinutes', 0] },
        },
        lastDeliveryDate: { $max: '$scheduledTime' },
      },
    },
    {
      $project: {
        _id: 0,
        customerId: '$_id',
        totalDeliveries: 1,
        completedDeliveries: 1,
        pendingDeliveries: 1,
        lateDeliveries: 1,
        totalLateMinutes: 1,
        lastDeliveryDate: 1,
      },
    },
  ];
}
