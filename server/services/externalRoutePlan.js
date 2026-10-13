import { createHash } from 'node:crypto';

export const fail = (message, statusCode = 409) => { throw Object.assign(new Error(message), { statusCode }); };
const requireThat = (ok, message) => { if (!ok) fail(message, 400); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const businessDate = value => new Date(new Date(value).getTime() + 14400000).toISOString().slice(0, 10);
const id = value => { requireThat(typeof value === 'string' && /^[a-f\d]{24}$/i.test(value), 'Invalid driver or delivery ID'); return value.toLowerCase(); };
const label = value => { requireThat(typeof value === 'string' && value.length > 0 && value.length <= 120 && !['__proto__', 'constructor', 'prototype'].includes(value), 'Invalid identifier/label'); return value; };
const bagLabel = value => /^BAG[-_]/i.test(value) ? value.trim().toUpperCase().replace(/^BAG_/, 'BAG-') : value;
const instant = value => { requireThat(typeof value === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)), 'Explicit timezone required'); return new Date(value).toISOString(); };
const point = value => {
  requireThat(value && Number.isFinite(value.lat) && Number.isFinite(value.lng) && value.lat >= 24.7 && value.lat <= 25.6 && value.lng >= 54.8 && value.lng <= 55.8, 'A numeric Dubai pin is required');
  return { lat: value.lat, lng: value.lng, name: label(value.name) };
};
export const cargoKey = cargo => JSON.stringify(cargo.map(c => ({ deliveryId: String(c.deliveryId), bagIds: [...c.bagIds].sort() })).sort((a, b) => a.deliveryId.localeCompare(b.deliveryId)));
const cargo = value => {
  requireThat(Array.isArray(value) && value.length <= 500, 'Cargo list required');
  const entries = value.map(c => {
    requireThat(Array.isArray(c.bagIds) && c.bagIds.length > 0 && c.bagIds.length <= 100, 'Physical bag identifiers required');
    return { deliveryId: id(c.deliveryId), bagIds: c.bagIds.map(label).map(bagLabel).sort() };
  });
  requireThat(new Set(entries.map(c => c.deliveryId)).size === entries.length, 'Duplicate cargo delivery');
  requireThat(new Set(entries.flatMap(c => c.bagIds)).size === entries.flatMap(c => c.bagIds).length, 'Duplicate bag identifier');
  return entries;
};
export const emptyState = () => ({ acknowledgements: {}, loaded: {}, arrivals: {}, confirmations: {}, completedTransfers: {}, completedStops: {}, exceptions: {} });

// This accepts an already planned, fixed-hub manifest. It never invokes a solver.
export function validatePlan(raw) {
  requireThat(raw && /^\d{4}-\d{2}-\d{2}$/.test(raw.serviceDate) && businessDate(`${raw.serviceDate}T01:00:00+04:00`) === raw.serviceDate, 'Invalid service date');
  requireThat(Number.isSafeInteger(raw.revision) && raw.revision > 0 && raw.expectedRevision === raw.revision - 1, 'Revision must follow expectedRevision');
  requireThat(Array.isArray(raw.routes) && raw.routes.length > 0 && raw.routes.length <= 9, 'Routes required (up to 3 vans and 6 bikes)');
  const routes = raw.routes.map(r => {
    requireThat(['bike', 'van'].includes(r.vehicleType), 'Vehicle must be bike or van');
    requireThat(Array.isArray(r.stops) && r.stops.length <= 500, 'Ordered stops required');
    const stops = r.stops.map(s => {
      if (s.type === 'pickup') return { id: label(s.id), type: 'pickup', transferId: label(s.transferId) };
      requireThat(s.type === 'customer' || s.type === 'return', 'Unsupported stop type');
      const base = { id: label(s.id), type: s.type, point: point(s.point) };
      if (s.type === 'return') return { ...base, plannedArrivalAt: instant(s.plannedArrivalAt) };
      const result = { ...base, deliveryId: id(s.deliveryId), earliestAt: instant(s.earliestAt), plannedArrivalAt: instant(s.plannedArrivalAt), plannedCompletionAt: instant(s.plannedCompletionAt), planByAt: instant(s.planByAt), deadlineAt: instant(s.deadlineAt) };
      requireThat(businessDate(result.deadlineAt) === raw.serviceDate, 'Customer deadline belongs to another service date');
      requireThat(Date.parse(result.earliestAt) === Date.parse(result.deadlineAt) - 10800000 && Date.parse(result.planByAt) === Date.parse(result.deadlineAt) - 1800000, 'Window must be D minus 180 through D minus 30 minutes');
      requireThat(result.plannedArrivalAt >= result.earliestAt && result.plannedCompletionAt >= result.plannedArrivalAt && result.plannedCompletionAt <= result.planByAt, 'Planned customer completion outside window');
      return result;
    });
    requireThat(r.vehicleType !== 'van' || stops.length === 0, 'Parked vans have no customer route');
    requireThat(!stops.some((s, i) => s.type === 'return' && i !== stops.length - 1), 'Return must be the final stop; no mid-shift reload');
    return { driverId: id(r.driverId), vehicleType: r.vehicleType, vehicleLabel: label(r.vehicleLabel), initialBatchId: label(r.initialBatchId), ...(r.vehicleType === 'van' ? { hub: point(r.hub) } : {}), initialCargo: cargo(r.initialCargo), stops };
  });
  requireThat(new Set(routes.map(r => r.driverId)).size === routes.length, 'Duplicate driver');
  requireThat(routes.filter(r => r.vehicleType === 'van').length <= 3 && routes.filter(r => r.vehicleType === 'bike').length <= 6, 'Fleet exceeds 3 vans / 6 bikes');
  requireThat(Array.isArray(raw.transfers) && raw.transfers.length <= 500, 'Transfers required');
  const transfers = raw.transfers.map(t => ({ id: label(t.id), batchId: label(t.batchId), vanDriverId: id(t.vanDriverId), bikeDriverId: id(t.bikeDriverId), point: point(t.point), pickupAt: instant(t.pickupAt), plannedDepartureAt: instant(t.plannedDepartureAt), cargo: cargo(t.cargo) }));
  requireThat(new Set(transfers.map(t => t.id)).size === transfers.length && new Set(transfers.map(t => t.batchId)).size === transfers.length, 'Duplicate transfer/batch ID');
  requireThat(new Set([...routes.map(r => r.initialBatchId), ...transfers.map(t => t.batchId)]).size === routes.length + transfers.length, 'Batch identifiers must be unique');
  const allStops = routes.flatMap(r => r.stops);
  requireThat(new Set(allStops.map(s => s.id)).size === allStops.length, 'Duplicate stop ID');
  const allCargo = routes.flatMap(r => r.initialCargo);
  const customers = allStops.filter(s => s.type === 'customer');
  requireThat(customers.length > 0 && customers.length === new Set(customers.map(s => s.deliveryId)).size, 'Duplicate or missing customers');
  requireThat(allCargo.length === customers.length && new Set(allCargo.map(c => c.deliveryId)).size === allCargo.length, 'Each customer needs exactly one initial stock owner');
  requireThat(new Set(allCargo.flatMap(c => c.bagIds)).size === allCargo.flatMap(c => c.bagIds).length, 'Bag allocated more than once');
  const used = new Set();
  for (const t of transfers) {
    const van = routes.find(r => r.driverId === t.vanDriverId && r.vehicleType === 'van');
    const bike = routes.find(r => r.driverId === t.bikeDriverId && r.vehicleType === 'bike');
    requireThat(van && bike && t.cargo.length > 0, 'Transfer needs both participants and cargo');
    requireThat(same(t.point, van.hub), 'Pickup must use the stationary van hub');
    for (const c of t.cargo) {
      requireThat(!used.has(c.deliveryId) && cargoKey([c]) === cargoKey(van.initialCargo.filter(v => v.deliveryId === c.deliveryId)), 'Transfer cargo does not match van stock');
      used.add(c.deliveryId);
    }
    requireThat(bike.stops.filter(s => s.transferId === t.id).length === 1, 'Transfer needs one ordered bike pickup');
  }
  for (const r of routes) {
    if (r.vehicleType === 'van') {
      requireThat(r.initialCargo.length <= 80, 'Planned van capacity exceeded');
      requireThat(r.initialCargo.every(c => used.has(c.deliveryId)), 'Van has undistributed cargo');
      const queue = transfers.filter(t => t.vanDriverId === r.driverId).sort((a, b) => a.pickupAt.localeCompare(b.pickupAt));
      requireThat(queue.every((t, i) => i === 0 || t.pickupAt >= queue[i - 1].plannedDepartureAt), 'Van pickups must be serial');
      continue;
    }
    const held = new Set(r.initialCargo.map(c => c.deliveryId));
    let clock = `${raw.serviceDate}T01:00:00+04:00`;
    clock = instant(clock);
    requireThat(held.size <= 15, 'Theoretical bike capacity exceeded');
    for (const s of r.stops) {
      if (s.type === 'pickup') {
        const t = transfers.find(t => t.id === s.transferId && t.bikeDriverId === r.driverId);
        requireThat(t && t.pickupAt >= clock && t.plannedDepartureAt > t.pickupAt, 'Invalid pickup order/time');
        t.cargo.forEach(c => held.add(c.deliveryId));
        requireThat(held.size <= 15, 'Theoretical bike capacity exceeded');
        clock = t.plannedDepartureAt;
      } else if (s.type === 'customer') {
        requireThat(held.delete(s.deliveryId) && s.plannedArrivalAt >= clock, 'Customer cargo missing or planned sequence runs backwards');
        clock = s.plannedCompletionAt;
      } else {
        requireThat(s.plannedArrivalAt >= clock && held.size === 0, 'Return precedes deliveries');
      }
    }
    requireThat(held.size === 0, 'Unserved bike cargo');
  }
  return { serviceDate: raw.serviceDate, revision: raw.revision, expectedRevision: raw.expectedRevision, requestId: label(raw.requestId), routes, transfers, cancelled: false, state: emptyState(), receipts: [] };
}

export function replaceState(next, previous) {
  const state = previous.state;
  for (const driver of Object.keys(state.loaded)) {
    const before = previous.routes.find(r => r.driverId === driver);
    const after = next.routes.find(r => r.driverId === driver);
    if (!same(after?.initialCargo, before?.initialCargo) || after?.initialBatchId !== before?.initialBatchId) fail('Cannot change already loaded stock');
  }
  for (const t of previous.transfers) {
    if (state.arrivals[t.id] || state.confirmations[t.id] || state.completedTransfers[t.id]) {
      if (!same(next.transfers.find(n => n.id === t.id), t)) fail('Cannot remove or change a started transfer');
    }
  }
  for (const r of previous.routes) for (const s of r.stops) {
    if (state.completedStops[s.id] && !same(next.routes.find(n => n.driverId === r.driverId)?.stops.find(n => n.id === s.id), s)) fail('Cannot change a completed stop');
  }
  for (const r of previous.routes) {
    let frozenThrough = -1;
    r.stops.forEach((stop, index) => {
      if (state.completedStops[stop.id] || state.arrivals[stop.transferId] || state.completedTransfers[stop.transferId]) frozenThrough = index;
    });
    if (frozenThrough >= 0 && !same(r.stops.slice(0, frozenThrough + 1), next.routes.find(n => n.driverId === r.driverId)?.stops.slice(0, frozenThrough + 1))) fail('Cannot reorder an already started route prefix');
  }
  next.state = { ...structuredClone(state), acknowledgements: {} };
  next.receipts = previous.receipts;
}

export function activeStop(plan, driverId) {
  const route = plan.routes.find(r => r.driverId === driverId);
  if (!route) return null;
  if (route.vehicleType === 'van') return plan.transfers.filter(t => t.vanDriverId === driverId && !plan.state.completedTransfers[t.id]).sort((a, b) => a.pickupAt.localeCompare(b.pickupAt))[0] || null;
  return route.stops.find(s => s.type === 'pickup' ? !plan.state.completedTransfers[s.transferId] : !plan.state.completedStops[s.id]) || null;
}
function nearby(actual, target) {
  if (!actual || !Number.isFinite(actual.lat) || !Number.isFinite(actual.lng) || Math.abs(actual.lat) > 90 || Math.abs(actual.lng) > 180) fail('Current location is required');
  const rad = Math.PI / 180;
  const a = Math.sin((actual.lat - target.lat) * rad / 2) ** 2 + Math.cos(actual.lat * rad) * Math.cos(target.lat * rad) * Math.sin((actual.lng - target.lng) * rad / 2) ** 2;
  if (6371000 * 2 * Math.asin(Math.sqrt(a)) > 100) fail('Get within 100 metres of the planned pin');
}

export function applyEvent(plan, driverId, event, now = new Date()) {
  label(event.eventId);
  const hash = fingerprint(event);
  const receipt = plan.receipts.find(r => r.eventId === event.eventId && r.driverId === driverId);
  if (receipt) { if (receipt.hash !== hash) fail('Event ID reused with different content'); return { duplicate: true }; }
  if (plan.cancelled) fail('Plan cancelled; refresh your assignment');
  if (event.revision !== plan.revision) fail('Plan revision changed; refresh and acknowledge');
  const route = plan.routes.find(r => r.driverId === driverId);
  if (!route) fail('Not a plan participant', 403);
  const s = plan.state;
  const timestamp = now.toISOString();
  if (event.type === 'acknowledge') s.acknowledgements[driverId] = plan.revision;
  else {
    if (s.acknowledgements[driverId] !== plan.revision) fail('Review and acknowledge this revision first');
    if (event.type === 'load') {
      if (cargoKey(cargo(event.cargo)) !== cargoKey(route.initialCargo)) fail('Initial load does not match cargo');
      s.loaded[driverId] ||= timestamp;
    } else if (event.type === 'exception') {
      requireThat(['delayed', 'missing_counterpart', 'wrong_cargo', 'blocked_access'].includes(event.reason), 'Invalid exception reason');
      const t = plan.transfers.find(t => t.id === event.transferId && [t.bikeDriverId, t.vanDriverId].includes(driverId));
      const stop = route.stops.find(s => s.id === event.stopId);
      if (!t && !stop) fail('Not a transfer participant or assigned stop', 403);
      if (s.completedTransfers[t?.id] || s.completedStops[stop?.id]) fail('Completed work cannot become a new exception');
      s.exceptions[t?.id || stop.id] = { reason: event.reason, driverId, timestamp };
    } else {
      if (now.getTime() < Date.parse(`${plan.serviceDate}T01:00:00+04:00`)) fail('Shift starts at 01:00 Dubai');
      if (!s.loaded[driverId]) fail('Confirm initial physical load first');
      const next = activeStop(plan, driverId);
      if (event.type === 'complete' || event.type === 'return') {
        if (!next || next.id !== event.stopId || next.type !== (event.type === 'complete' ? 'customer' : 'return')) fail('This is not the next stop');
        nearby(event.location, next.point);
        if (event.type === 'complete') {
          if (timestamp < next.earliestAt) fail(`Wait until ${next.earliestAt}`);
          const c = [...route.initialCargo, ...plan.transfers.filter(t => t.bikeDriverId === driverId && s.completedTransfers[t.id]).flatMap(t => t.cargo)].find(c => c.deliveryId === next.deliveryId);
          if (!c || (event.bagId && !c.bagIds.includes(bagLabel(event.bagId)))) fail('Wrong bag for this customer');
          if (!event.proof?.photoUrl && !event.proof?.images?.length) fail('Delivery photo required', 400);
        }
        s.completedStops[next.id] = timestamp;
      } else {
        const t = plan.transfers.find(t => t.id === event.transferId);
        if (!t || ![t.bikeDriverId, t.vanDriverId].includes(driverId)) fail('Not a transfer participant', 403);
        if ((route.vehicleType === 'bike' ? next?.transferId : next?.id) !== t.id) fail('This is not the next pickup');
        if (!s.loaded[t.vanDriverId] || s.acknowledgements[t.vanDriverId] !== plan.revision || s.acknowledgements[t.bikeDriverId] !== plan.revision) fail('Wait for counterpart to acknowledge and load');
        nearby(event.location, t.point);
        if (event.type === 'arrive') {
          s.arrivals[t.id] ||= {};
          s.arrivals[t.id][driverId] ||= timestamp;
        } else if (event.type === 'confirm') {
          if (!s.arrivals[t.id]?.[t.vanDriverId] || !s.arrivals[t.id]?.[t.bikeDriverId]) fail('Wait for counterpart arrival');
          if (timestamp < t.plannedDepartureAt) fail(`Wait until planned transfer completion ${t.plannedDepartureAt}`);
          if (event.batchId !== t.batchId || cargoKey(cargo(event.cargo)) !== cargoKey(t.cargo)) fail('Wrong batch or cargo');
          s.confirmations[t.id] ||= {};
          s.confirmations[t.id][driverId] ||= timestamp;
          if (s.confirmations[t.id][t.vanDriverId] && s.confirmations[t.id][t.bikeDriverId]) {
            s.completedTransfers[t.id] = timestamp;
            delete s.exceptions[t.id];
          }
        } else fail('Unsupported event', 400);
      }
    }
  }
  if (plan.receipts.length >= 10000) fail('Event limit reached; contact dispatcher');
  plan.receipts.push({ eventId: event.eventId, driverId, revision: plan.revision, hash, type: event.type, target: event.transferId || event.stopId || driverId, timestamp });
  return { duplicate: false };
}

export function projectPlan(plan, driverId) {
  const route = plan.routes.find(r => r.driverId === driverId);
  if (!route) return null;
  const transfers = plan.transfers.filter(t => [t.bikeDriverId, t.vanDriverId].includes(driverId));
  const counterparts = plan.routes.filter(r => transfers.some(t => [t.bikeDriverId, t.vanDriverId].includes(r.driverId))).map(r => ({ driverId: r.driverId, vehicleType: r.vehicleType, vehicleLabel: r.vehicleLabel, driverName: r.driverName }));
  const subset = (obj, keys) => Object.fromEntries(Object.entries(obj || {}).filter(([k]) => keys.includes(k)));
  const transferIds = transfers.map(t => t.id);
  const driverIds = counterparts.map(c => c.driverId).concat(driverId);
  return { id: String(plan._id), serviceDate: plan.serviceDate, revision: plan.revision, cancelled: plan.cancelled, routes: [route], transfers, counterparts, state: {
    acknowledgements: subset(plan.state.acknowledgements, driverIds), loaded: subset(plan.state.loaded, driverIds),
    arrivals: subset(plan.state.arrivals, transferIds), confirmations: subset(plan.state.confirmations, transferIds), completedTransfers: subset(plan.state.completedTransfers, transferIds), exceptions: subset(plan.state.exceptions, [...transferIds, ...route.stops.map(s => s.id)]), completedStops: subset(plan.state.completedStops, route.stops.map(s => s.id))
  } };
}

// This is the supplied schedule, not a new route calculation or live ETA.
export function externalRouteEta(plan, driverId) {
  const route = plan.routes.find(r => r.driverId === driverId);
  if (!route) fail('Driver is not assigned to this plan', 404);
  const midnight = Date.parse(`${plan.serviceDate}T00:00:00+04:00`);
  const seconds = value => (Date.parse(value) - midnight) / 1000;
  const pickups = plan.transfers.filter(t => t.bikeDriverId === driverId);
  return {
    source: 'external_plan', planId: String(plan._id), revision: plan.revision, cancelled: plan.cancelled,
    departure: { seconds: 3600, reason: 'external' }, totals: null, windowSeconds: 9000, droppedIds: [],
    stops: route.stops.filter(s => s.type === 'customer').map(s => ({
      deliveryId: s.deliveryId, etaSeconds: seconds(plan.state.completedStops[s.id] || s.plannedCompletionAt), actual: Boolean(plan.state.completedStops[s.id]),
      scheduledSeconds: seconds(s.deadlineAt), windowStartSeconds: seconds(s.earliestAt), planBySeconds: seconds(s.planByAt), status: plan.state.completedStops[s.id] && plan.state.completedStops[s.id] > s.planByAt ? 'late' : 'on_time'
    })),
    detour: null,
    detours: pickups.map(t => {
      const idx = route.stops.findIndex(s => s.transferId === t.id);
      return { type: 'van_handoff', batchId: t.batchId, beforeDeliveryId: route.stops.slice(idx + 1).find(s => s.type === 'customer')?.deliveryId,
        arrivalSeconds: seconds(t.pickupAt), departureSeconds: seconds(t.plannedDepartureAt), meetingPoint: t.point, counterpartName: plan.routes.find(r => r.driverId === t.vanDriverId)?.driverName,
        bagCount: t.cargo.reduce((n, c) => n + c.bagIds.length, 0), status: plan.state.completedTransfers[t.id] ? 'completed' : 'planned' };
    }),
    meetingBikes: plan.transfers.filter(t => t.vanDriverId === driverId).map(t => ({ handoffId: t.id, batchId: t.batchId, bikeName: plan.routes.find(r => r.driverId === t.bikeDriverId)?.driverName, meetingPoint: t.point, plannedVanArrivalSeconds: seconds(t.pickupAt), bagCount: t.cargo.reduce((n, c) => n + c.bagIds.length, 0), status: plan.state.completedTransfers[t.id] ? 'completed' : 'planned' }))
  };
}
