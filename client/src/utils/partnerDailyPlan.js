import { FIXED_SELECTION_DEADLINES, isPastSelectionDeadline } from './selectionDeadlines';

export const DELIVERY_WINDOWS = ['Morning · 5–6am', 'Morning · 7–10am'];
export const dayTotal = day => Object.values(day.items || {}).reduce((sum, item) => sum + item.quantity * item.price, 0);
export const dayQuantity = day => Object.values(day.items || {}).reduce((sum, item) => sum + item.quantity, 0);
export const dateClosed = date => isPastSelectionDeadline(date, FIXED_SELECTION_DEADLINES);

export function deliveryDays(from, to) {
  const start = new Date(from + 'T00:00:00Z'), end = new Date(to + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)
    || !Number.isFinite(+start) || !Number.isFinite(+end) || start.toISOString().slice(0, 10) !== from
    || end.toISOString().slice(0, 10) !== to || end < start) throw new Error('Choose a valid start and end date.');
  if ((end - start) / 86400000 >= 90) throw new Error('Choose a range of up to 90 calendar days.');
  const days = [];
  for (let instant = +start; instant <= +end; instant += 86400000) {
    const day = new Date(instant);
    if (day.getUTCDay() !== 0) days.push(day.toISOString().slice(0, 10));
  }
  if (!days.length) throw new Error('There are no deliveries on Sunday. Choose another date.');
  return days;
}

export const makePlanDay = date => ({ date, items: {}, window: DELIVERY_WINDOWS[0], reviewed: false, skipped: false, placed: false, orderId: null, error: '' });

export function assertDayReady(day, minimum) {
  if (day.placed || day.skipped) return;
  if (dateClosed(day.date)) throw new Error(day.date + ': the ordering cutoff has passed.');
  if (!dayQuantity(day)) throw new Error('Add items for this day, or explicitly skip it.');
  if (dayTotal(day) < minimum) throw new Error('Minimum per delivery is AED ' + Number(minimum).toFixed(2) + '.');
}

export function quotePlanDay(day, menu) {
  const items = {};
  for (const old of Object.values(day.items)) {
    const item = menu.find(m => m._id === old.id);
    if (!item) throw new Error(day.date + ': ' + old.name + ' is no longer available. Edit this day.');
    const price = Number(item.price);
    if (item.price == null || !Number.isFinite(price) || price < 0) throw new Error(day.date + ': a price could not be verified.');
    items[old.id] = { ...old, name: item.name, price };
  }
  return { ...day, items };
}

// A retry never rewrites an order that was accepted when its response was lost.
export async function submitPlanDay(api, day, onDraftSaved) {
  const lines = Object.values(day.items).map(item => ({ menuItemId: item.id, quantity: item.quantity }));
  if (day.orderId) {
    const existing = (await api.get('/partner/orders/' + day.orderId)).data;
    if (!existing?.success) throw new Error('Could not verify the saved order for ' + day.date + '.');
    if (['submitted', 'locked'].includes(existing.data.status)) {
      const expected = Object.values(day.items).map(i => [i.id, i.quantity]).sort();
      const actual = (existing.data.lines || []).map(l => [String(l.menuItem?._id || l.menuItem), l.quantity]).sort();
      if (JSON.stringify(expected) !== JSON.stringify(actual) || existing.data.deliveryTime !== day.window) {
        throw new Error('An accepted order for ' + day.date + ' has different items. Review it in My Orders.');
      }
      return day.orderId;
    }
    if (existing.data.status !== 'draft') throw new Error('The saved order for ' + day.date + ' can no longer be submitted.');
    if (!Array.isArray(existing.data.lines)) throw new Error('Could not verify the saved draft items for ' + day.date + '. Please retry.');
    // The server merges draft lines. Omission does not remove an old meal:
    // explicitly delete every stored item that is absent from the latest cart.
    const reconciledIds = new Set(lines.map(line => line.menuItemId));
    for (const stored of existing.data.lines) {
      const id = stored?.menuItem?._id || stored?.menuItem;
      if (typeof id !== 'string' || !id.trim()) {
        throw new Error('Could not identify a saved draft item for ' + day.date + '. Review this order in My Orders.');
      }
      if (!reconciledIds.has(id)) {
        lines.push({ menuItemId: id, quantity: 0 });
        reconciledIds.add(id);
      }
    }
  }
  const result = (await api.post('/partner/orders', {
    deliveryDate: day.date,
    lines,
    deliveryTime: day.window, notes: '',
  })).data;
  if (!result?.success || !result.data?._id) throw new Error('Could not save the order for ' + day.date + '.');
  const id = result.data._id;
  onDraftSaved(id);
  const submitted = (await api.post('/partner/orders/' + id + '/submit')).data;
  if (!submitted?.success) throw new Error('Could not submit the order for ' + day.date + '.');
  return id;
}
