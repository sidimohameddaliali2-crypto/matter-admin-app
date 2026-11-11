// Customer-detail "Days Used". This is the detail box's existing comparison,
// not the customer-list total and not a current-cycle contract.
//
// Every delivery for that customer counts, including cancelled. When since is
// a valid instant, only scheduledTime >= since counts. An invalid since counts
// as zero, matching a plan start the browser cannot parse. A missing scheduled
// time does not count once since is set. Weekend stop combining is not applied.
// This count is not clamped.
//
// GET /deliveries?customerId caps the page at 500 and then combines weekend
// stops, so the box cannot count that page. This pipeline has no $limit.

export function countCustomerDetailUsage(rows, { customerId, since } = {}) {
  if (!customerId) return 0;
  let start = null;
  if (since != null && since !== '') {
    start = new Date(since);
    if (Number.isNaN(start.getTime())) return 0;
  }
  return (rows || []).reduce((count, row) => {
    if (row?.customerId !== customerId) return count;
    if (!start) return count + 1;
    const time = new Date(row.scheduledTime);
    if (Number.isNaN(time.getTime()) || time < start) return count;
    return count + 1;
  }, 0);
}

// No $limit and no find().limit. Callers must not page this pipeline.
export function customerDetailUsagePipeline({ customerId, since } = {}) {
  const match = { customerId };
  if (since != null && since !== '') {
    const start = new Date(since);
    if (Number.isNaN(start.getTime())) match._id = { $exists: false };
    else match.scheduledTime = { $gte: start };
  }
  return [
    { $match: match },
    { $count: 'used' },
  ];
}
