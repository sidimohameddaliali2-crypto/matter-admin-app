import { businessComponentsToUtcDate, formatBusinessDateInput, toBusinessComponents } from './businessTime';
export const driverId = d => String(d?._id ?? d ?? '');
export const staffName = u => [u?.profile?.firstName, u?.profile?.lastName].filter(Boolean).join(' ') || u?.name || u?.email || 'Driver';
export const shiftDay = (date, days) => {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
export const businessToday = () => formatBusinessDateInput(new Date());
export function dayRange(date) {
  const start = businessComponentsToUtcDate(date, '00:00'),
    end = businessComponentsToUtcDate(shiftDay(date, 1), '00:00');
  return {
    dateFrom: start.toISOString(),
    dateTo: new Date(end.getTime() - 1).toISOString()
  };
}
export const emirate = d => String(d.addressDetails?.city || '').split(' - ')[0].trim().replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
export const emptyFilters = () => ({
  zones: [],
  drivers: [],
  hours: [],
  emirates: []
});
export const isFinished = d => ['delivered', 'completed', 'collected', 'failed'].includes(d.status);
export function filterDispatchDeliveries(deliveries, {
  date,
  search = '',
  filters = emptyFilters(),
  collections = false,
  unassigned = false
}) {
  const term = search.trim().toLowerCase();
  return deliveries.filter(d => (formatBusinessDateInput(d.scheduledTime) === date || d.sundayOnlyCarriedOver && new Date(date + 'T12:00:00Z').getUTCDay() === 6 && formatBusinessDateInput(d.scheduledTime) === shiftDay(date, 1)) && (!collections || d.type === 'Collection') && (!unassigned || !driverId(d.driver)) && (!filters.zones.length || filters.zones.includes(d.zone || d.addressDetails?.area || '')) && (!filters.drivers.length || filters.drivers.includes(driverId(d.driver) || 'unassigned')) && (!filters.hours.length || filters.hours.includes(String(toBusinessComponents(d.scheduledTime)?.hours))) && (!filters.emirates.length || filters.emirates.includes(emirate(d))) && (!term || [d.customerName, d.customerId, d._id, d.address, d.zone, d.customerPhone].some(v => String(v || '').toLowerCase().includes(term)))).sort((a, b) => new Date(a.scheduledTime) - new Date(b.scheduledTime));
}
// Read every page: the server caps a request at 500 records.
export async function loadDispatchDay(api, date) {
  const records = new Map();
  let page = 1,
    pages = 1;
  do {
    const r = await api.get('/deliveries', {
      params: {
        ...dayRange(date),
        limit: 500,
        page
      }
    });
    if (r.data.success === false) throw new Error(r.data.message || 'Unable to load deliveries.');
    const data = r.data.data;
    for (const d of data.deliveries || []) records.set(String(d._id), d);
    pages = data.pagination?.pages || 1;
    page++;
  } while (page <= pages);
  return [...records.values()];
}
export const errorMessage = e => e.response?.data?.message || e.message || 'Please retry.';
export const newRequestId = () => window.crypto?.randomUUID?.() || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
  const r = Math.floor(Math.random() * 16);
  return (c === 'x' ? r : r & 3 | 8).toString(16);
});
// Legacy multipart proof is stored as a filename or /uploads path; native
// clients store absolute CDN URLs. Local evidence belongs to the API origin.
export function proofImageUrl(value, apiBaseUrl, origin = typeof window === 'undefined' ? 'http://localhost:5000' : window.location.origin) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  try {
    if (/^https?:\/\//i.test(raw)) return new URL(raw).href;
    const local = raw.replace(/^\/?uploads\//, '');
    if (local === raw && /[\/:?#\\]/.test(raw)) return null;
    const parts = local.split('/').map(part => decodeURIComponent(part));
    if (parts.some(part => !part || part === '.' || part === '..' || /[\/:?#\\\u0000-\u001f\u007f]/.test(part))) return null;
    const base = new URL(apiBaseUrl || '/api', origin);
    if (!['http:', 'https:'].includes(base.protocol)) return null;
    return new URL('/uploads/' + parts.map(part => encodeURIComponent(part)).join('/'), base.origin).href;
  } catch {
    return null;
  }
}
