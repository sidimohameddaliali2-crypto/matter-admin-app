import { randomUUID } from 'node:crypto';
import { toBusinessDateKey } from '../utils/businessDate.js';

export function buildCollectionRequest(input, customer, actorId, now = new Date()) {
  const fail = message => { const error = new Error(message); error.statusCode = 400; throw error; };
  const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
  if (!['internal', 'manual'].includes(input.customerSource)) fail('Choose an internal customer or manual entry.');
  if (input.customerSource === 'internal' && !customer) fail('Customer no longer exists. Search again or clear the search and type the customer name.');
  const customerName = input.customerSource === 'internal'
    ? [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim() || customer.customerId
    : text(input.customerName, 200);
  if (!customerName) fail('Customer name is required.');
  const address = text(input.address, 2000);
  if (!address) fail('Collection address is required.');
  // Date-only requests use the start of the chosen Dubai day for the existing
  // dispatch date index. This is not a promised collection appointment time.
  if (typeof input.collectionDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.collectionDate)) fail('Choose a valid collection date.');
  const calendarDate = new Date(`${input.collectionDate}T00:00:00Z`);
  if (!Number.isFinite(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== input.collectionDate) fail('Choose a valid collection date.');
  const scheduledTime = new Date(`${input.collectionDate}T00:00:00+04:00`);
  const dubaiWeekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Dubai', weekday: 'short' }).format(scheduledTime);
  if (!['Tue', 'Fri', 'Sat'].includes(dubaiWeekday)) fail('Collections are available only on Tuesday, Friday and Saturday (Dubai time).');
  if (input.collectionDate < toBusinessDateKey(now)) fail('New collections must be scheduled for today or later (Dubai time).');
  if (typeof input.refundRequestedAfterCollection !== 'boolean') fail('Confirm whether a bag refund is requested after collection.');
  const latRaw = input.latitude;
  const lngRaw = input.longitude;
  const hasLat = latRaw !== '' && latRaw !== undefined && latRaw !== null;
  const hasLng = lngRaw !== '' && lngRaw !== undefined && lngRaw !== null;
  let gpsLocation;
  if (hasLat || hasLng) {
    const lat = Number(latRaw), lng = Number(lngRaw);
    if (!hasLat || !hasLng || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) fail('Provide a valid latitude and longitude pair.');
    gpsLocation = { lat, lng, link: `https://www.google.com/maps?q=${lat},${lng}` };
  }
  return {
    type: 'Collection', taskType: 'Bag Collection', status: 'pending', company: 'Matter',
    customerId: customer ? customer.customerId : `MANUAL-COLLECTION-${randomUUID()}`,
    customerName, address, scheduledTime, gpsLocation,
    addressDetails: { label: text(input.addressLabel, 100) },
    notes: text(input.notes, 2000),
    collectionRequest: {
      customerSource: input.customerSource,
      phone: text(input.phone, 50),
      refundRequestedAfterCollection: input.refundRequestedAfterCollection,
      recordedBy: actorId, recordedAt: now
    }
  };
}
