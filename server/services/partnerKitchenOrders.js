import SpaceOrder from '../models/SpaceOrder.js';
import OrderLine from '../models/OrderLine.js';
import { isDateKey } from '../utils/businessDate.js';

// Partner deliveryDate is a calendar date stored at UTC midnight, unlike
// Delivery.scheduledTime. Read the original orders so edits/cancellations can
// never leave a second, stale copy in customer MenuSelectionRecord data.
export async function getPartnerKitchenOrders(date) {
  if (!isDateKey(date)) throw Object.assign(new Error('A valid delivery date is required.'), { statusCode: 400 });
  const start = new Date(`${date}T00:00:00Z`);
  const end = new Date(+start + 86400000);
  const orders = await SpaceOrder.find({ deliveryDate: { $gte: start, $lt: end }, status: { $in: ['submitted', 'locked'] } })
    .populate('space', 'businessName').sort({ submittedAt: -1, createdAt: -1 });
  const lines = orders.length ? await OrderLine.find({ order: { $in: orders.map(o => o._id) } })
    .populate('menuItem', 'name mealType') : [];
  const byOrder = new Map();
  const totals = new Map();
  for (const line of lines) {
    const quantity = Number(line.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 1) throw Object.assign(new Error('A partner order contains an invalid quantity. Review the order before production.'), { statusCode: 409 });
    const itemId = String(line.menuItem?._id || line._id);
    const item = { itemId, name: line.menuItem?.name || 'Deleted menu item — review order', mealType: line.menuItem?.mealType || 'unknown', quantity, needsReview: !line.menuItem };
    const key = String(line.order);
    if (!byOrder.has(key)) byOrder.set(key, []);
    byOrder.get(key).push(item);
    if (!totals.has(itemId)) totals.set(itemId, { ...item, quantity: 0 });
    totals.get(itemId).quantity += quantity;
  }
  const rows = orders.map(order => ({
    id: String(order._id), reference: `PO-${String(order._id).slice(-4).toUpperCase()}`,
    partnerName: order.space?.businessName || 'Deleted partner — review order',
    deliveryDate: date, deliveryTime: order.deliveryTime || '', notes: order.notes || '',
    status: order.status, lines: byOrder.get(String(order._id)) || [],
  }));
  const counts = [...totals.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { date, orders: rows, counts, orderCount: rows.length, totalQuantity: counts.reduce((sum, item) => sum + item.quantity, 0) };
}

export function emitPartnerKitchenChange(req, order) {
  // Only the date is broadcast; the authenticated kitchen endpoint supplies
  // order details. Slack/invoicing/acknowledgement are never production gates.
  try { req.app?.get('io')?.emit('partner:ordersChanged', { date: new Date(order.deliveryDate).toISOString().slice(0, 10) }); }
  catch { /* A disconnected socket must not fail a saved order. */ }
}
