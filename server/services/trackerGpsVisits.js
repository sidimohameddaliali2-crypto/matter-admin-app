// Fallback evidence from real vehicle GPS, not the driver's phone or an
// invented Truckoom alert. Times are first observed inside/outside the radius.
export function gpsVisitEvents(points, pin, radiusMetres = 50) {
  const coordinate = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng)
    && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
  if (!coordinate(pin?.lat, pin?.lng)) return [];
  const rows = points.map(p => ({ ...p, at: new Date(p.gpsTime || p.recordedAt) }))
    .filter(p => Number.isFinite(+p.at) && coordinate(p.latitude, p.longitude)).sort((a,b) => a.at-b.at);
  const events = [];
  let wasInside = false;
  const seen = new Set();
  for (const p of rows) {
    const key = `${+p.at}:${p.latitude}:${p.longitude}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = Math.PI / 180;
    const h = Math.sin((p.latitude-pin.lat)*r/2)**2
      + Math.cos(pin.lat*r)*Math.cos(p.latitude*r)*Math.sin((p.longitude-pin.lng)*r/2)**2;
    const metres = 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0,1-h)));
    const inside = metres <= radiusMetres;
    if (inside !== wasInside) events.push({ flag: inside ? 'entry' : 'exit', at: p.at });
    wasInside = inside;
  }
  return events;
}
