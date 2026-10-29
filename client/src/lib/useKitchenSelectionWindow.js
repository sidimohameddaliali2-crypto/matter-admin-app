import { useEffect, useState } from 'react';
import { FIXED_SELECTION_DEADLINES } from '../utils/selectionDeadlines';

export const kitchenSelectionWindow = (menu, date, now = Date.now()) => {
  const delivery = new Date(`${date}T00:00:00Z`);
  const invalid = { canAutoAssign: false, message: 'Select a menu and date with a valid selection deadline before auto-assignment.' };
  if (!menu || !date || !Number.isFinite(delivery.getTime()) || delivery.toISOString().slice(0, 10) !== date) return invalid;
  const rules = menu.selectionDeadlines?.length ? menu.selectionDeadlines : FIXED_SELECTION_DEADLINES;
  const rule = rules.find(row => row.deliveryDay === ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][delivery.getUTCDay()]);
  if (!rule || !Number.isInteger(Number(rule.daysBefore)) || Number(rule.daysBefore) < 0 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.deadlineTime || '')) return invalid;
  const [hour, minute] = rule.deadlineTime.split(':').map(Number);
  delivery.setUTCDate(delivery.getUTCDate() - Number(rule.daysBefore));
  delivery.setUTCHours(hour, minute, 59, 999);
  const cutoff = new Date(delivery.getTime() - 240 * 60000);
  const canAutoAssign = Number(new Date(now)) > cutoff.getTime();
  return { canAutoAssign, deadlineAt: cutoff.toISOString(), message: canAutoAssign ? ''
    : `Customer selection is still open until ${cutoff.toLocaleString('en-GB', { timeZone: 'Asia/Dubai', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hour12: false })} (Dubai). Existing choices are shown without auto-assignment.` };
};

export default function useKitchenSelectionWindow(menu, date) {
  const [tick, refresh] = useState(0);
  const window = kitchenSelectionWindow(menu, date);
  useEffect(() => {
    if (!window.deadlineAt || window.canAutoAssign) return undefined;
    // Wake at the cutoff rather than re-rendering hundreds of cards each second.
    const timer = setTimeout(() => refresh(value => value + 1), Math.min(2147483647, Math.max(1, Date.parse(window.deadlineAt) - Date.now() + 1)));
    return () => clearTimeout(timer);
  }, [menu, date, window.deadlineAt, window.canAutoAssign, tick]);
  return window;
}
