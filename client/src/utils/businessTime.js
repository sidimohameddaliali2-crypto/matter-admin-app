// scheduledTime (and similar delivery timestamps) are stored as UTC instants
// representing a fixed business timezone (Dubai, UTC+4 by default), not the
// viewer's own device timezone. Rendering them with raw `Date.getHours()` /
// `.toLocaleString()` only looks correct when the viewer's OS timezone
// happens to be set to Dubai — anywhere else, times drift by the difference
// between the two zones. These helpers always read/write the fixed business
// offset instead, matching the server's normalizeScheduledTimeInput.
const BUSINESS_TZ_OFFSET_MINUTES = Number(process.env.REACT_APP_LOCAL_TIMEZONE_OFFSET_MINUTES || 240);
const MS_PER_MINUTE = 60 * 1000;

const pad2 = (n) => String(n).padStart(2, '0');

// Business-timezone Y/M/D/H/M for a stored UTC instant.
export function toBusinessComponents(dateInput) {
  if (!dateInput) return null;
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(d.getTime())) return null;
  const shifted = new Date(d.getTime() + BUSINESS_TZ_OFFSET_MINUTES * MS_PER_MINUTE);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(), // 0-indexed
    day: shifted.getUTCDate(),
    hours: shifted.getUTCHours(),
    minutes: shifted.getUTCMinutes(),
  };
}

// "YYYY-MM-DD" in business time — for <input type="date"> values.
export function formatBusinessDateInput(dateInput) {
  const c = toBusinessComponents(dateInput);
  if (!c) return '';
  return `${c.year}-${pad2(c.month + 1)}-${pad2(c.day)}`;
}

// "HH:mm" (24h) in business time — for <input type="time"> values.
export function formatBusinessTimeInput(dateInput) {
  const c = toBusinessComponents(dateInput);
  if (!c) return '';
  return `${pad2(c.hours)}:${pad2(c.minutes)}`;
}

// "HH:mm" (24h) in business time, for display.
export function formatBusinessTime(dateInput) {
  const c = toBusinessComponents(dateInput);
  if (!c) return 'N/A';
  return `${pad2(c.hours)}:${pad2(c.minutes)}`;
}

// "MM/DD/YYYY HH:mm" in business time, for display.
export function formatBusinessDateTime(dateInput) {
  const c = toBusinessComponents(dateInput);
  if (!c) return 'N/A';
  return `${pad2(c.month + 1)}/${pad2(c.day)}/${c.year} ${pad2(c.hours)}:${pad2(c.minutes)}`;
}

// 12h clock ("h:mm AM/PM") from a count of seconds since business-day
// midnight — the convention the route-ETA/soft-deadline calculations use.
// Wraps properly for a negative or >86400 input (an implied "yesterday" or
// "tomorrow" anchor), unlike a bare `%`, which stays negative in JS for a
// negative left-hand side.
export function formatClockFromSecondsSinceMidnight(seconds) {
  if (seconds == null || Number.isNaN(seconds)) return null;
  // Round to the nearest whole minute FIRST, then wrap — rounding hours/minutes
  // separately from raw seconds can carry a fractional minute up to a literal
  // "60" (e.g. 3599.6s -> 59.99 -> rounds to 60 minutes past the hour).
  const totalMinutes = Math.round(seconds / 60);
  const wrapped = ((totalMinutes % 1440) + 1440) % 1440;
  let h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${pad2(m)} ${ampm}`;
}

// Business-local "YYYY-MM-DD" + "HH:mm" -> the equivalent UTC Date instant.
export function businessComponentsToUtcDate(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hours, minutes] = timeStr.split(':').map(Number);
  if (!year || !month || !day || Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  const utcMillis = Date.UTC(year, month - 1, day, hours, minutes) - BUSINESS_TZ_OFFSET_MINUTES * MS_PER_MINUTE;
  const result = new Date(utcMillis);
  return Number.isNaN(result.getTime()) ? null : result;
}
