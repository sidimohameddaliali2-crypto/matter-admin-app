const DAY_MS = 86400000;
const DUBAI_OFFSET_MS = 4 * 60 * 60 * 1000;

// Renewal CTA only: use the verified subscription date, never the menu range
// or its last delivery. Unknown/expired dates do not qualify.
export function isWithinRenewalWindow(cycleEndDate, now = new Date()) {
  if (typeof cycleEndDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(cycleEndDate)) return false;
  const end = new Date(`${cycleEndDate}T00:00:00.000Z`);
  const instant = new Date(now).getTime();
  if (!Number.isFinite(end.getTime()) || !Number.isFinite(instant) || end.toISOString().slice(0, 10) !== cycleEndDate) return false;
  const today = new Date(instant + DUBAI_OFFSET_MS).toISOString().slice(0, 10);
  const daysLeft = (end.getTime() - new Date(`${today}T00:00:00.000Z`).getTime()) / DAY_MS;
  return daysLeft >= 0 && daysLeft <= 3;
}
