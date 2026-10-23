// Owner (2026-10-23): a Matter Core customer delivered only on Monday,
// Wednesday and Friday gets a DOUBLE delivery on Monday (covering Monday +
// Tuesday) and on Wednesday (covering Wednesday + Thursday); Friday stays a
// single delivery.
//
// A date counts as a double-delivery day only when the customer's own Matter
// delivery dates for that week are exactly that pattern: deliveries on Mon,
// Wed and Fri and none on Tue or Thu. A customer who is normally delivered
// every day but has one day paused is therefore never mistaken for it.
//
// Pure function — client/src/utils/kitchenListCalculations.js carries the same
// rule (the client can't import from server/), keep the two in step.
const dayKey = (utcMs) => new Date(utcMs).toISOString().slice(0, 10);

export function isMatterCoreDoubleDay(dateKey, deliveryDates) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || '')) || !Array.isArray(deliveryDates)) return false;
  const [y, m, d] = dateKey.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 1 = Monday, 3 = Wednesday
  if (dow !== 1 && dow !== 3) return false;
  const dates = new Set(deliveryDates);
  const monday = Date.UTC(y, m - 1, d - (dow - 1));
  const at = (offset) => dayKey(monday + offset * 86400000);
  return dates.has(at(0)) && dates.has(at(2)) && dates.has(at(4)) && !dates.has(at(1)) && !dates.has(at(3));
}
