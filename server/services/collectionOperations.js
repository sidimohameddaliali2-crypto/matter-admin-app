import { businessDayStart, addDaysToDateKey, isDateKey, toBusinessDateKey } from '../utils/businessDate.js';

export const openCollectionStatuses = ['pending', 'assigned', 'on_route', 'picked_up', 'failed'];
export const collectionHistoryStatuses = ['collected', 'completed', 'delivered', 'cancelled'];
export const literalPattern = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function collectionCsv(headers, rows) {
  const cell = value => { const text = String(value ?? ''); return `"${(/^[\s]*[=+@-]/.test(text) ? "'" : '') + text.replace(/"/g, '""')}"`; };
  return '\uFEFF' + [headers, ...rows].map(row => row.map(cell).join(',')).join('\r\n');
}
const invalid = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };
export function collectionSearchFilter(query = {}) {
  const filter = {};
  if (query.search) {
    if (typeof query.search !== 'string' || query.search.length > 120) invalid('Customer search must be at most 120 characters.');
    const pattern = literalPattern(query.search.trim());
    if (pattern) filter.$or = ['customerName', 'customerId', 'collectionRequest.phone'].map(key => ({ [key]: { $regex: pattern, $options: 'i' } }));
  }
  for (const key of ['dateFrom', 'dateTo']) if (query[key] && !isDateKey(query[key])) invalid('Choose valid collection dates.');
  if (query.dateFrom && query.dateTo && query.dateFrom > query.dateTo) invalid('End date must be on or after start date.');
  if (query.dateFrom || query.dateTo) {
    filter.scheduledTime = {};
    if (query.dateFrom) filter.scheduledTime.$gte = businessDayStart(query.dateFrom);
    if (query.dateTo) filter.scheduledTime.$lt = businessDayStart(addDaysToDateKey(query.dateTo, 1));
  }
  return filter;
}
export function collectionListFilter(query = {}) {
  const view = query.view || 'open';
  if (!['open', 'history', 'all'].includes(view)) invalid('Choose Open, History or All collections.');
  const filter = { type: 'Collection', ...collectionSearchFilter(query) };
  if (view !== 'all') filter.status = { $in: view === 'open' ? openCollectionStatuses : collectionHistoryStatuses };
  if (query.driver === 'unassigned') filter.driver = null;
  else if (query.driver) {
    if (typeof query.driver !== 'string' || !/^[a-f\d]{24}$/i.test(query.driver)) invalid('Choose a valid driver.');
    filter.driver = query.driver;
  }
  return filter;
}
export function collectionDuplicateFilter(data) {
  const day = toBusinessDateKey(data.scheduledTime);
  const names = { customerName: { $regex: `^${literalPattern(data.customerName.trim()).replace(/\s+/g, '\\s+')}\\s*$`, $options: 'i' } };
  const matches = [names];
  if (data.collectionRequest.customerSource === 'internal') matches.push({ customerId: data.customerId });
  if (data.collectionRequest.phone) matches.push({ 'collectionRequest.phone': data.collectionRequest.phone });
  return { type: 'Collection', status: { $in: openCollectionStatuses }, scheduledTime: { $gte: businessDayStart(day), $lt: businessDayStart(addDaysToDateKey(day, 1)) }, $or: matches };
}

export function buildRefundAssignment(record, input, owner, actor, now = new Date()) {
  if (!['super_admin', 'admin', 'manager'].includes(actor?.role)) invalid('Management access is required.');
  if (!Number.isInteger(input.version) || input.version !== (record.collectionRefund?.version || 0)) throw Object.assign(new Error('This refund changed. Refresh before updating it.'), { statusCode: 409 });
  if (record.collectionRefund?.status === 'refunded') invalid('A completed refund cannot be reassigned.');
  if (!owner) invalid('Choose an active refund owner.');
  if (input.dueDate && !isDateKey(input.dueDate)) invalid('Choose a valid follow-up date.');
  if (typeof input.eventId !== 'string' || !/^[a-zA-Z0-9:_-]{8,180}$/.test(input.eventId)) invalid('A valid update ID is required.');
  const ownerName = [owner.profile?.firstName, owner.profile?.lastName].filter(Boolean).join(' ') || owner.email;
  const actorName = [actor.profile?.firstName, actor.profile?.lastName].filter(Boolean).join(' ') || actor.email;
  return { $set: { 'collectionRefund.owner': owner._id, 'collectionRefund.ownerName': ownerName, 'collectionRefund.dueDate': input.dueDate || null }, $inc: { 'collectionRefund.version': 1 }, $push: { 'collectionRefund.assignmentHistory': { eventId: input.eventId, owner: owner._id, ownerName, dueDate: input.dueDate || null, actor: actor._id, actorName, timestamp: now } } };
}
