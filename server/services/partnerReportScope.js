import SpaceOrder from '../models/SpaceOrder.js';

// Financial and waste reports use the order's delivery day, including the last day.
export const partnerReportScope = async ({ from, to, spaceId } = {}) => {
  const dateFilter = {};
  for (const [key, value, end] of [['$gte', from, false], ['$lte', to, true]]) {
    if (!value) continue;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw Object.assign(new Error('Invalid report date.'), { status: 400 });
    date.setUTCHours(end ? 23 : 0, end ? 59 : 0, end ? 59 : 0, end ? 999 : 0);
    dateFilter[key] = date;
  }
  if (from && to && dateFilter.$gte > dateFilter.$lte) {
    throw Object.assign(new Error('Report start date must be before its end date.'), { status: 400 });
  }
  const orderFilter = spaceId ? { space: spaceId } : {};
  let invoiceOrderFilter = {};
  if (from || to) {
    orderFilter.deliveryDate = dateFilter;
    const orders = await SpaceOrder.find(orderFilter).select('_id');
    invoiceOrderFilter = { order: { $in: orders.map(o => o._id) } };
  }
  return { dateFilter, orderFilter, invoiceOrderFilter };
};
