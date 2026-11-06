import { parseTruckoomAlertTime } from './truckoomVisitRules.js';

const invalidResponse = () => Object.assign(new Error('Invalid Truckoom alert data response'), { code: 'TRUCKOOM_INVALID_RESPONSE' });

export function alertDataRows(payload) {
  const envelopes = Array.isArray(payload) ? payload : [payload];
  if (!envelopes.length) throw invalidResponse();
  const rows = [];
  for (const envelope of envelopes) {
    // This endpoint reports application failures even with HTTP 200.
    if (Number(envelope?.result ?? envelope?.status) !== 1 || !Array.isArray(envelope?.data)) {
      if (Number(envelope?.result) === 0 && /^No Records Found\.?$/i.test(envelope?.message || '')
        && Array.isArray(envelope?.data) && !envelope.data.length) continue;
      throw invalidResponse();
    }
    rows.push(...envelope.data);
  }
  return rows;
}

export function parseAlertDataTime(value) {
  // Verified against vehicle GPS and camera times on 2026-11-06: unlike the
  // old getGeofenceAlerts endpoint, this endpoint returns Dubai wall-clock time.
  const match = String(value || '').match(/^(\d{2}-\d{2}-\d{4}) (\d{2}):(\d{2}):(\d{2}) (AM|PM)$/);
  if (!match || +match[2] < 1 || +match[2] > 12) return null;
  const [, date, h, m, s, period] = match;
  const hour = (+h % 12) + (period === 'PM' ? 12 : 0);
  const wall = parseTruckoomAlertTime(`${date} ${String(hour).padStart(2, '0')}:${m}:${s}`);
  return wall ? new Date(+wall - 240 * 60000) : null;
}

export function normalizeAlertData(rows, { companyName, start, end }) {
  if (!Array.isArray(rows)) throw invalidResponse();
  const events = new Map();
  for (const row of rows) {
    if (typeof row?.company !== 'string' || row.company.trim() !== companyName?.trim()) continue;
    const type = String(row.alert_type || '').trim().toLowerCase();
    const flag = type === 'enter in geofence' ? 'entry' : type === 'out of geofence' ? 'exit' : null;
    if (!flag) continue;
    // alert_id identifies an alert rule, not the customer or a unique event.
    // alert_info can have reused kitchen text; extract only an exact managed name.
    const names = [...String(row.alert_info || '').matchAll(/(?:^|[^A-Za-z0-9_-])(MATTER-(?:\d{8}-)?[a-f0-9]{24})(?![A-Za-z0-9_-])/g)].map(match => match[1]);
    if (new Set(names).size !== 1) continue;
    const vehicleNo = String(row.vehicle_no ?? '').trim();
    const at = parseAlertDataTime(row.alert_generation);
    if (!vehicleNo || !at) throw invalidResponse();
    if (+at < +start || +at >= +end) continue;
    const name = names[0];
    const event = { name, vehicleNo, flag, at, source: 'truckoom_alert_data', vendorTimestamp: row.alert_generation };
    events.set(`${name}:${vehicleNo}:${flag}:${+at}`, event);
  }
  return [...events.values()].sort((a, b) => a.at - b.at);
}
