import WeeklyMenu from '../models/WeeklyMenu.js';
import { FIXED_SELECTION_DEADLINES } from '../config/selectionDeadlines.js';
import { businessOffsetMs, isDateKey } from '../utils/businessDate.js';

const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const kitchenSelectionWindow = (menu, date, now = new Date()) => {
  if (!isDateKey(date)) throw Object.assign(new Error('Select a valid delivery date.'), { statusCode: 400 });
  const delivery = new Date(`${date}T00:00:00Z`);
  const rules = menu.selectionDeadlines?.length ? menu.selectionDeadlines : FIXED_SELECTION_DEADLINES;
  const rule = rules.find(row => row.deliveryDay === days[delivery.getUTCDay()]);
  if (!rule || !Number.isInteger(Number(rule.daysBefore)) || Number(rule.daysBefore) < 0 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.deadlineTime || '')) {
    throw Object.assign(new Error('The selection deadline is invalid. Verify the menu deadline before auto-assignment.'), { statusCode: 409, code: 'KITCHEN_DEADLINE_INVALID' });
  }
  const [hour, minute] = rule.deadlineTime.split(':').map(Number);
  delivery.setUTCDate(delivery.getUTCDate() - Number(rule.daysBefore));
  delivery.setUTCHours(hour, minute, 59, 999);
  const cutoff = new Date(delivery.getTime() - businessOffsetMs());
  const canAutoAssign = new Date(now).getTime() > cutoff.getTime();
  const display = cutoff.toLocaleString('en-GB', { timeZone: 'Asia/Dubai', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  return { date, canAutoAssign, deadlineAt: cutoff.toISOString(),
    message: canAutoAssign ? 'The selection deadline has passed. Missing meals may be auto-assigned.'
      : `Customer selection is still open until ${display} (Dubai). Auto-assignment is blocked until the deadline passes.` };
};

export const assertKitchenSelectionClosed = (menu, date, now) => {
  const window = kitchenSelectionWindow(menu, date, now);
  if (!window.canAutoAssign) throw Object.assign(new Error(window.message), { statusCode: 409, code: 'KITCHEN_SELECTION_OPEN', selectionWindow: window });
  return window;
};

export const readKitchenSelectionWindow = async (menuId, date, now) => {
  const menu = await WeeklyMenu.findById(menuId).select('selectionDeadlines').lean();
  if (!menu) throw Object.assign(new Error('Menu not found'), { statusCode: 404 });
  return kitchenSelectionWindow(menu, date, now);
};
