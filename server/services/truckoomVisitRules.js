// Owner (2026-10-23): compare the photo shutter time with the tracker visit,
// using a 50 m circle around the customer's saved pin. Never use upload time.
export const CUSTOMER_RADIUS_METRES = 50;

export function parseTruckoomAlertTime(value) {
  const m = String(value || '').match(/^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, d, mo, y, h, mi, s] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`;
  const date = new Date(iso);
  return Number.isFinite(+date) && date.toISOString() === iso ? date : null;
}

export function alertDateKeys(start, end) {
  const keys = [];
  for (let t = Date.parse(start); t < Date.parse(end);) {
    const iso = new Date(t).toISOString().slice(0, 10);
    keys.push(iso.split('-').reverse().join('-'));
    t = Date.parse(`${iso}T00:00:00Z`) + 86400000;
  }
  return keys;
}

export function normalizeGeofenceAlerts(payload) {
  if (!Array.isArray(payload)) throw new Error('Unexpected Truckoom geofence alert response');
  const events = [];
  for (const vehicle of payload) {
    for (const event of vehicle.geofence_data || []) {
      const at = parseTruckoomAlertTime(event.geofence_alarm_time);
      if (at && ['entry', 'exit'].includes(event.geofence_entry_exit_flag)) {
        events.push({ vehicleNo: String(vehicle.vehicle_no).trim(), name: event.geofence_name,
          flag: event.geofence_entry_exit_flag, at });
      }
    }
  }
  return events;
}

export function evaluateTrackerVisit({ events, photoCapturedAt, photoSource, start, end }) {
  const unique = new Map();
  for (const e of events) {
    if (+e.at >= +start && +e.at < +end) unique.set(`${+e.at}:${e.flag}`, e);
  }
  const ordered = [...unique.values()].sort((a, b) => +a.at - +b.at || a.flag.localeCompare(b.flag));
  const windows = [];
  let arrival = null;
  let incomplete = false;
  for (const e of ordered) {
    if (e.flag === 'entry') {
      if (arrival) incomplete = true;
      arrival = e.at;
    } else if (arrival) {
      if (+e.at <= +arrival) incomplete = true;
      else windows.push({ arrivedAt: arrival, departedAt: e.at });
      arrival = null;
    } else incomplete = true;
  }
  const photo = photoCapturedAt ? new Date(photoCapturedAt) : null;
  const validPhoto = photo && Number.isFinite(+photo);
  const inside = validPhoto && windows.filter(w => +photo >= +w.arrivedAt && +photo <= +w.departedAt);
  const nearest = validPhoto && windows.length ? [...windows].sort((a, b) =>
    Math.min(Math.abs(photo - a.arrivedAt), Math.abs(photo - a.departedAt)) -
    Math.min(Math.abs(photo - b.arrivedAt), Math.abs(photo - b.departedAt)))[0] : windows[0];
  const selected = inside?.[0] || nearest;
  const result = { arrivedAt: selected?.arrivedAt || arrival || null,
    departedAt: selected?.departedAt || null, photoCapturedAt: validPhoto ? photo : null,
    visitCount: windows.length, needsReview: false };
  if (photoSource === 'upload') return { ...result, status: 'uploaded_photo', needsReview: true };
  if (!validPhoto || photoSource !== 'camera') return { ...result, status: 'missing_photo_time' };
  if (incomplete || inside?.length > 1) return { ...result, status: 'incomplete_events' };
  // An open later visit could still contain the photo: do not judge it against
  // an earlier closed visit, or mark it valid until its exit is received.
  if (arrival && +photo >= +arrival) return { ...result, arrivedAt: arrival, departedAt: null, status: 'pending_exit' };
  if (inside?.length === 1) return { ...result, status: 'inside_window' };
  if (!windows.length || +photo < +start || +photo >= +end) return { ...result, status: 'awaiting_events' };
  return { ...result, status: 'outside_window', needsReview: true };
}

export function recordProofReceipt(delivery, incoming, now = new Date()) {
  if (!incoming || !(delivery.proof?.photoUrl || delivery.proof?.images?.length)) return;
  if (!(incoming.photoUrl || incoming.images?.length || incoming.photoCapturedAt !== undefined || incoming.photoSource !== undefined)) return;
  const firstReceipt = !delivery.proof.receivedAt;
  delivery.proof.receivedAt = now;
  const value = incoming.photoCapturedAt;
  // Require an explicit timezone. Browser/device time is reported evidence,
  // not a server-attested shutter timestamp. Old clients stay unverified.
  const valid = typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value)) && Date.parse(value) <= +now + 60000;
  delivery.proof.photoCapturedAt = valid ? new Date(value) : undefined;
  delivery.proof.photoSource = ['camera', 'upload'].includes(incoming.photoSource) ? incoming.photoSource : 'unknown';
  const snapshot = delivery.trackerVisit;
  const driverId = String(delivery.driver?._id || delivery.driver || '');
  if (firstReceipt && snapshot?.geofenceId && (
    (snapshot.driverId && snapshot.driverId !== driverId) ||
    (Number.isFinite(delivery.gpsLocation?.lat) && Number.isFinite(delivery.gpsLocation?.lng) &&
      (snapshot.lat !== delivery.gpsLocation.lat || snapshot.lng !== delivery.gpsLocation.lng))
  )) delivery.trackerVisit = undefined;
  // Keep the destination/vehicle snapshot, but invalidate the previous verdict.
  if (delivery.trackerVisit) {
    delivery.trackerVisit.status = 'awaiting_events';
    delivery.trackerVisit.needsReview = false;
    delivery.trackerVisit.arrivedAt = undefined;
    delivery.trackerVisit.departedAt = undefined;
    delivery.trackerVisit.photoCapturedAt = undefined;
    delivery.trackerVisit.checkedAt = undefined;
  }
}
