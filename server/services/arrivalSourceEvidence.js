import { bagIdAliases, normalizeBagId } from './bagInventoryAudit.js';
import { toBusinessDateKey, setBusinessTimeOfDay, parseTimeOfDay } from '../utils/businessDate.js';

const maxItems = 32;
const rapidReuseMs = 5 * 60 * 1000;
const id = value => value == null ? null : String(value._id ?? value);
const stamp = value => {
  if (!value || !(typeof value === 'string' || value instanceof Date)) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const orderIdPattern = /^[a-f0-9]{24}$/;

export function proofBagIds(delivery) {
  if (delivery.proof?.qrSkipped === true) return [];
  return [...new Set([delivery.proof?.bagId, ...(delivery.proof?.bagIds ?? [])]
    .filter(value => typeof value === 'string' && value.trim()).map(normalizeBagId))].sort();
}

// The old physicalScan flag was also set by driver manual entry. Only the new
// acquisition receipt records how the delivery app actually obtained this tag.
export function acquisitionForProof(proof, scanCode, orderId, now = new Date()) {
  if (proof.qrSkipped || !Array.isArray(proof.bagAcquisitions)) return null;
  const matches = proof.bagAcquisitions.filter(record => record?.orderId === String(orderId)
    && typeof record.bagId === 'string' && normalizeBagId(record.bagId) === normalizeBagId(scanCode));
  if (matches.length !== 1) return null;
  const [match] = matches;
  if (match.method === 'manual') return { acquisition: 'manual' };
  const scannedAt = stamp(match.scannedAt);
  if (match.method !== 'qr' || !scannedAt || Date.parse(scannedAt) > now.getTime()) return null;
  return { acquisition: 'qr', scannedAt };
}

function allocation(bagId, event) {
  if (event.eventType !== 'deliver' || typeof event.eventId !== 'string') return null;
  const match = /^delivery:([a-f0-9]{24}):deliver:(.{1,100})$/.exec(event.eventId);
  const recordedOrder = id(event.deliveryId);
  const orderId = recordedOrder ?? match?.[1];
  if (!orderIdPattern.test(orderId ?? '') || (match && (match[1] !== orderId || normalizeBagId(match[2]) !== bagId))) return null;
  const actorId = id(event.assignedBy?.user), driverId = id(event.assignedTo?.driver);
  const customerId = id(event.assignedTo?.customer?.customerId);
  const recordedAt = stamp(event.timestamp), occurredAt = stamp(event.occurredAt);
  const scan = stamp(event.scannedAt);
  const qr = event.physicalScan === true && event.acquisition === 'qr'
    && scan && recordedAt && Date.parse(scan) <= Date.parse(recordedAt) && actorId && actorId === driverId;
  return { bagId, eventId:event.eventId, orderId, actorId, driverId, customerId, occurredAt, recordedAt,
    acquisition: qr ? 'qr' : event.acquisition === 'manual' ? 'manual' : 'unknown', physicalScan:!!qr, scannedAt:qr ? scan : null };
}

function near(first, second) {
  // Clocks can diverge during offline delivery. Either acquisition, occurrence
  // or server receipt can establish competing use, never a second arrival.
  const close = (left,right) => left && right && Math.abs(Date.parse(left) - Date.parse(right)) <= rapidReuseMs;
  const deviceClocks = event => [event.scannedAt,event.occurredAt].filter(Boolean);
  return close(first.recordedAt,second.recordedAt)
    || deviceClocks(first).some(left => deviceClocks(second).some(right => close(left,right)));
}

export function bagEvidence(delivery, bags) {
  const bagIds = proofBagIds(delivery);
  const own = [], peers = [];
  let partial = bagIds.length > maxItems;
  const validIds = bagIds.slice(0, maxItems);
  for (const bagId of validIds) {
    const matches = bags.filter(bag => normalizeBagId(bag.bagId) === bagId);
    if (matches.length !== 1) { partial = true; continue; }
    if ((matches[0].history?.length ?? 0) > 512) partial = true;
    const seen = new Map();
    for (const raw of matches[0].history ?? []) {
      if (raw.eventType !== 'deliver') continue;
      const event = allocation(bagId, raw);
      if (!event) continue;
      const prior = seen.get(event.eventId);
      if (prior && JSON.stringify(prior) !== JSON.stringify(event)) partial = true;
      else seen.set(event.eventId,event);
    }
    const events = [...seen.values()];
    const ownEvents = events.filter(event => event.orderId === id(delivery._id));
    if (ownEvents.length !== 1 || ownEvents.some(event => event.customerId !== id(delivery.customerId)
      || !event.occurredAt || !event.recordedAt || !orderIdPattern.test(event.actorId ?? '')
      || event.actorId !== id(delivery.driver) || event.driverId !== id(delivery.driver))) partial = true;
    for (const raw of matches[0].history ?? []) {
      if (raw.eventType !== 'deliver') continue;
      const clocks = {occurredAt:stamp(raw.occurredAt),recordedAt:stamp(raw.timestamp),scannedAt:stamp(raw.scannedAt)};
      if (!clocks.occurredAt || !clocks.recordedAt) { partial = true; continue; }
      if (!ownEvents.some(ours => near(ours,clocks))) continue;
      const event = allocation(bagId,raw);
      if (!event || !orderIdPattern.test(event.actorId ?? '') || !orderIdPattern.test(event.driverId ?? '') || !event.customerId)
        partial = true;
    }
    own.push(...ownEvents);
    peers.push(...events.filter(event => event.orderId !== id(delivery._id) && ownEvents.some(ours => near(ours, event))));
  }
  const ordered = events => events.sort((a, b) => a.eventId.localeCompare(b.eventId)).slice(0,maxItems);
  return { state: validIds.length === 0 ? 'unavailable' : partial || peers.length > maxItems ? 'partial' : 'recorded',
    proofBagIds:validIds, events:ordered(own), peerEvents:ordered(peers) };
}

export function affectedBagDeliveries(bag, eventId) {
  const events = (bag.history ?? []).filter(row => row.eventType === 'deliver').map(row => allocation(normalizeBagId(bag.bagId), row)).filter(Boolean);
  const own = events.find(event => event.eventId === eventId);
  return own ? [...new Set(events.filter(event => event.orderId === own.orderId || near(own,event)).map(event => event.orderId))] : [];
}

const changeFields = new Set(['scheduledTime','address','newAddress','location','addressId','addressDetails','gpsLocation','zone','customerId','matterSubscriptionId','driver']);
export function amendmentEvidence(delivery, changes) {
  const serviceDate = toBusinessDateKey(delivery.scheduledTime);
  const events = [];
  let partial = changes.length > maxItems;
  for (const change of changes.slice(0,maxItems)) {
    const appliedAt = stamp(change.appliedAt);
    const orderId = id(delivery._id);
    const bindings = change.appliedOrderIds?.length ? change.appliedOrderIds.map(id) : [id(change.appliedToDelivery)];
    if (!bindings.includes(orderId) || id(change.customerId) !== id(delivery.customerId)
      || toBusinessDateKey(change.scheduledDate) !== serviceDate || change.status !== 'applied' || !appliedAt) {
      partial = true;
      continue;
    }
    const input = change.changes instanceof Map ? Object.fromEntries(change.changes) : change.changes ?? {};
    const fields = [...new Set(Object.keys(input).filter(key => changeFields.has(key))
      .map(key => ['newAddress','location','addressDetails'].includes(key) ? 'address' : key))].sort();
    if (!fields.length) continue;
    const previousScheduledTime = stamp(input.scheduledTime?.oldValue);
    const scheduledTime = stamp(input.scheduledTime?.newValue) ?? (parseTimeOfDay(input.scheduledTime) ? stamp(setBusinessTimeOfDay(change.scheduledDate,input.scheduledTime)) : null);
    if (fields.includes('scheduledTime') && !scheduledTime) partial = true;
    events.push({ changeId:id(change._id), orderId, serviceDate, customerId:id(change.customerId), status:'applied', appliedAt, fields,
      ...(previousScheduledTime && {previousScheduledTime}), ...(scheduledTime && {scheduledTime}) });
  }
  return {state:partial ? 'partial' : 'complete',events};
}

export const bagAliasQuery = delivery => proofBagIds(delivery).slice(0,maxItems).flatMap(bagIdAliases);
export const amendmentReadLimit = maxItems + 1;
