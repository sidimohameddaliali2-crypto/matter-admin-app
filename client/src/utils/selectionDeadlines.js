// Mirror of the company-wide policy in server/config/selectionDeadlines.js.
export const FIXED_SELECTION_DEADLINES = [
  { deliveryDay: 'Monday', daysBefore: 3, deadlineTime: '15:00' },
  { deliveryDay: 'Tuesday', daysBefore: 2, deadlineTime: '00:00' },
  { deliveryDay: 'Wednesday', daysBefore: 2, deadlineTime: '00:00' },
  { deliveryDay: 'Thursday', daysBefore: 2, deadlineTime: '00:00' },
  { deliveryDay: 'Friday', daysBefore: 2, deadlineTime: '00:00' },
  { deliveryDay: 'Saturday', daysBefore: 3, deadlineTime: '00:00' },
  { deliveryDay: 'Sunday', daysBefore: 4, deadlineTime: '00:00' },
];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DUBAI_OFFSET_MS = 240 * 60 * 1000;

// Both the partner calendar and customer Menu Selection use Dubai wall time,
// even when the customer is travelling or the browser uses another timezone.
export const isPastSelectionDeadline = (dateKey, selectionDeadlines, now = new Date()) => {
  if (!dateKey) return false;
  const day = new Date(`${dateKey}T00:00:00Z`);
  if (!Number.isFinite(day.getTime())) return false;
  const rule = Array.isArray(selectionDeadlines)
    ? selectionDeadlines.find(r => r.deliveryDay === DAY_NAMES[day.getUTCDay()]) : null;
  if (!rule) {
    const today = new Date(new Date(now).getTime() + DUBAI_OFFSET_MS).toISOString().slice(0, 10);
    return dateKey < today;
  }
  const [hh, mm] = String(rule.deadlineTime || '23:59').split(':').map(Number);
  day.setUTCDate(day.getUTCDate() - (rule.daysBefore || 0));
  day.setUTCHours(hh, mm, 59, 999);
  return new Date(now).getTime() > day.getTime() - DUBAI_OFFSET_MS;
};
