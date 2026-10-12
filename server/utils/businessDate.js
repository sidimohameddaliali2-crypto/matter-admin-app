// Business-day (Asia/Dubai, UTC+4 by default) date math, shared by every
// route/service that turns a calendar date into UTC query bounds or groups
// stored instants by day. scheduledTime is stored as a UTC instant, but
// "Tuesday" means the Dubai calendar day — a 03:00 Tuesday Dubai delivery is
// 23:00 Monday UTC, so UTC-midnight bounds or toISOString() day keys put it
// on the wrong day. Nothing here reads the server's own OS timezone.
//
// The offset is read on every call (not captured at import time) so it
// always reflects the loaded env and tests can set it directly.

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function businessOffsetMs() {
  const minutes = Number.parseInt(
    process.env.LOCAL_TIMEZONE_OFFSET_MINUTES || process.env.BUSINESS_TZ_OFFSET_MINUTES || '240',
    10
  );
  return (Number.isNaN(minutes) ? 240 : minutes) * 60 * 1000;
}

export function isDateKey(value) {
  if (typeof value !== 'string' || !DATE_KEY_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

// UTC instant of 00:00 business-local time on dateKey ("YYYY-MM-DD").
export function businessDayStart(dateKey) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - businessOffsetMs());
}

// Business-local calendar date ("YYYY-MM-DD") an instant falls on.
export function toBusinessDateKey(dateInput) {
  const instant = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(instant.getTime())) return null;
  return new Date(instant.getTime() + businessOffsetMs()).toISOString().slice(0, 10);
}

// { startOfDay, endOfDayExclusive } for the business day containing
// dateInput — a "YYYY-MM-DD" key, or any Date/instant.
export function getBusinessDayBounds(dateInput) {
  let key;
  if (isDateKey(dateInput)) {
    key = dateInput;
  } else {
    key = toBusinessDateKey(dateInput);
    if (!key) throw new Error('Invalid date for business day bounds');
  }
  const startOfDay = businessDayStart(key);
  return { startOfDay, endOfDayExclusive: new Date(startOfDay.getTime() + DAY_MS) };
}

// Turns a caller-supplied range into [start, endExclusive) UTC bounds.
// - Date-only "YYYY-MM-DD" values are business dates: start → that day's
//   business-local 00:00, end → the NEXT business day's 00:00 (exclusive),
//   so the whole end day is included and nothing from the day after is.
// - Full ISO timestamps are exact instants and used as-is (the end becomes
//   exclusive by +1ms, so an inclusive "…23:59:59.999" end still works).
// Returns null if either value is missing/unparseable or end < start.
export function resolveBusinessDateRange(startValue, endValue) {
  const start = isDateKey(startValue) ? businessDayStart(startValue) : new Date(startValue);
  let endExclusive;
  if (isDateKey(endValue)) {
    endExclusive = new Date(businessDayStart(endValue).getTime() + DAY_MS);
  } else {
    const end = new Date(endValue);
    endExclusive = Number.isNaN(end.getTime()) ? end : new Date(end.getTime() + 1);
  }
  if (!startValue || !endValue || Number.isNaN(start.getTime()) || Number.isNaN(endExclusive.getTime())) {
    return null;
  }
  if (endExclusive <= start) return null;
  return { start, endExclusive };
}
