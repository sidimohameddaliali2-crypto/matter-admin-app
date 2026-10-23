import Invoice from '../models/Invoice.js';
import InvoiceLine from '../models/InvoiceLine.js';

// Legacy deadline locking could leave a locked order without invoices. A pair
// is complete only when both locked documents have their line snapshots.
export const invoicedPartnerOrders = async (orderIds) => {
  if (!orderIds.length) return new Set();
  const invoices = await Invoice.find({ order: { $in: orderIds }, status: 'locked' }).select('_id order type');
  const withLines = new Set((await InvoiceLine.distinct('invoice', { invoice: { $in: invoices.map(i => i._id) } })).map(String));
  const typesByOrder = new Map();
  for (const invoice of invoices) {
    if (!withLines.has(String(invoice._id))) continue;
    const key = String(invoice.order);
    if (!typesByOrder.has(key)) typesByOrder.set(key, new Set());
    typesByOrder.get(key).add(invoice.type);
  }
  return new Set([...typesByOrder].filter(([, types]) => types.has('partner') && types.has('matter')).map(([id]) => id));
};
