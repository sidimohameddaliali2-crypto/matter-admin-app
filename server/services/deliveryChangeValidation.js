export const DELIVERY_CHANGE_LIMITS = Object.freeze({ rangeDays: 366, csvRows: 500, batchChanges: 1000, listPageSize: 200 });
export const deliveryChangeInputError = message => Object.assign(new Error(message), { statusCode: 400 });

const text = (value, name, max, required = false) => {
  if (value === undefined || value === null) {
    if (required) throw deliveryChangeInputError(`${name} is required`);
    return;
  }
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw deliveryChangeInputError(`Invalid ${name}`);
};

// Preserve this workflow's existing UTC calendar-date convention. Applying a
// record still uses getBusinessDayBounds and setBusinessTimeOfDay (Dubai).
export function deliveryChangeRange(startValue, endValue = startValue) {
  if (![startValue, endValue].every(value => typeof value === 'string' && value.trim() || value instanceof Date)) throw deliveryChangeInputError('Invalid scheduled date range');
  const start = new Date(startValue); const end = new Date(endValue);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) throw deliveryChangeInputError('Invalid scheduled date range');
  const first = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const last = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  const days = (last - first) / 86400000 + 1;
  if (days < 1) throw deliveryChangeInputError('End date cannot be earlier than start date');
  if (days > DELIVERY_CHANGE_LIMITS.rangeDays) throw deliveryChangeInputError(`A delivery-change range cannot exceed ${DELIVERY_CHANGE_LIMITS.rangeDays} days`);
  return days;
}

export function validateDeliveryChangeInput(value) {
  text(value.customerId, 'Customer ID', 200, true);
  text(value.customerName, 'Customer Name', 300, true);
  text(value.customerPhone, 'Customer Phone', 100);
  text(value.reason, 'Reason', 4000);
  const days = deliveryChangeRange(value.scheduledDate, value.endDate || value.scheduledDate);
  if (value.daysOfWeek !== undefined && (!Array.isArray(value.daysOfWeek) || value.daysOfWeek.length > 7 || value.daysOfWeek.some(day => !Number.isInteger(day) || day < 0 || day > 6))) throw deliveryChangeInputError('Weekdays must be numbers from 0 (Sunday) to 6 (Saturday)');
  const changes = value.changes;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length) throw deliveryChangeInputError('At least one change must be specified');
  const allowed = new Set(['address', 'location', 'zone', 'scheduledTime', 'company', 'notes', 'customerName', 'customerPhone', 'phone', 'type']);
  for (const [field, input] of Object.entries(changes)) {
    if (!allowed.has(field)) throw deliveryChangeInputError(`Field ${field} cannot be changed through this workflow`);
    text(input, field, 4000, true);
  }
  return days;
}

export function deliveryChangePagination(pageValue = '1', limitValue = '50') {
  if (!/^\d+$/.test(String(pageValue)) || !/^\d+$/.test(String(limitValue))) throw deliveryChangeInputError('Invalid page or limit');
  const page = Number(pageValue); const limit = Number(limitValue);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > DELIVERY_CHANGE_LIMITS.listPageSize || !Number.isSafeInteger((page - 1) * limit)) throw deliveryChangeInputError(`Page must be positive and limit must be 1-${DELIVERY_CHANGE_LIMITS.listPageSize}`);
  return { page, limit };
}
