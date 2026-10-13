import mongoose from 'mongoose';
import ExternalRoutePlan from '../models/ExternalRoutePlan.js';
import Delivery from '../models/Delivery.js';
import User from '../models/User.js';
import { validatePlan, replaceState, applyEvent, projectPlan, fingerprint, fail, businessDate } from './externalRoutePlan.js';

const customers = plan => plan.routes.flatMap(r => r.stops.filter(s => s.type === 'customer').map(s => ({ ...s, driverId: r.driverId })));
const planId = value => String(value?._id || value);

// Used at import and before each action, including reconnect retries. A
// dispatcher edit/deletion outside this protocol cannot silently change cargo.
export async function validateDeliveries(plan, session, importing = false) {
  const stops = customers(plan);
  const docs = await Delivery.find({ _id: { $in: stops.map(s => s.deliveryId) } }).session(session).lean();
  for (const stop of stops) {
    const d = docs.find(d => String(d._id) === stop.deliveryId);
    if (!d || d.type !== 'Delivery' || !['pending', 'assigned', 'on_route', 'picked_up', 'delivered', 'completed'].includes(d.status)) fail('Delivery missing, cancelled or failed; replace the plan');
    if (new Date(d.scheduledTime).toISOString() !== stop.deadlineAt || businessDate(d.scheduledTime) !== plan.serviceDate) fail('Delivery deadline changed; replace the plan');
    if (d.gpsLocation?.lat !== stop.point.lat || d.gpsLocation?.lng !== stop.point.lng) fail('Delivery pin changed or is unconfirmed; replace the plan');
    if (d.externalRoutePlan && planId(d.externalRoutePlan) !== planId(plan)) fail('Delivery belongs to another external plan');
    if (!importing && (!d.externalRoutePlan || String(d.driver) !== stop.driverId || d.externalRouteRevision !== plan.revision)) fail('Assignment changed; replace the plan');
    const done = Boolean(plan.state.completedStops[stop.id]);
    if (['delivered', 'completed', 'collected'].includes(d.status) !== done) fail('Delivery progress changed outside this plan; dispatcher review required');
  }
  return docs;
}

export async function importExternalPlan(raw, actorId) {
  const draft = validatePlan(raw);
  const importHash = fingerprint(draft);
  await ExternalRoutePlan.init();
  let result;
  await mongoose.connection.transaction(async session => {
    let current = await ExternalRoutePlan.findOne({ serviceDate: draft.serviceDate }).session(session);
    if (current?.requestId === draft.requestId) {
      if (current.importHash !== importHash) fail('Import request ID reused with different content');
      result = current; return;
    }
    if ((current?.revision || 0) !== draft.expectedRevision) fail('Plan revision changed; reload before importing');
    if (current) replaceState(draft, current.toObject());
    else current = new ExternalRoutePlan({ serviceDate: draft.serviceDate, createdBy: actorId });
    draft._id = current._id;
    const users = await User.find({ _id: { $in: draft.routes.map(r => r.driverId) }, role: 'driver', isActive: true }).session(session).lean();
    if (users.length !== draft.routes.length) fail('Every vehicle requires an active driver account', 400);
    for (const r of draft.routes) {
      const u = users.find(u => String(u._id) === r.driverId);
      if (u.profile?.vehicleType !== r.vehicleType) fail('Driver vehicle profile does not match the manifest', 400);
      r.driverName = [u.profile?.firstName, u.profile?.lastName].filter(Boolean).join(' ') || r.vehicleLabel;
    }
    await validateDeliveries(draft, session, true);
    const dayStart = new Date(`${draft.serviceDate}T00:00:00+04:00`);
    const ids = customers(draft).map(s => s.deliveryId);
    const otherAssigned = await Delivery.exists({
      driver: { $in: draft.routes.map(r => r.driverId) }, _id: { $nin: ids },
      scheduledTime: { $gte: dayStart, $lt: new Date(dayStart.getTime() + 86400000) },
      status: { $in: ['pending', 'assigned', 'on_route', 'picked_up'] },
      externalRoutePlan: { $ne: current._id }
    }).session(session);
    if (otherAssigned) fail('A participating driver has other assigned work on this service date; reconcile it before import');
    // Clear only removed, untouched assignments; progress never gets reset.
    await Delivery.updateMany({ externalRoutePlan: current._id, _id: { $nin: ids } }, { $set: { driver: null, routeOrder: null, handoff: null }, $unset: { externalRoutePlan: '', externalRouteRevision: '', externalRouteTiming: '' } }, { session });
    await Delivery.bulkWrite(customers(draft).map(s => ({ updateOne: {
      filter: { _id: s.deliveryId },
      update: { $set: { driver: s.driverId, routeOrder: draft.routes.find(r => r.driverId === s.driverId).stops.findIndex(n => n.id === s.id), routeOptimizedAt: new Date(), handoff: null, externalRoutePlan: current._id, externalRouteRevision: draft.revision, externalRouteTiming: { earliestAt: s.earliestAt, planByAt: s.planByAt, plannedArrivalAt: s.plannedArrivalAt, plannedCompletionAt: s.plannedCompletionAt } } }
    } })), { session });
    current.set({ ...draft, importHash, updatedBy: actorId, participantIds: [...new Set([...(current.participantIds || []), ...draft.routes.map(r => r.driverId)])] });
    current.revisionHistory.push({ revision: draft.revision, requestId: draft.requestId, importHash, actorId, at: new Date() });
    await current.save({ session });
    result = current;
  });
  return result;
}

export async function recordPlanEvent(id, actorId, event) {
  if (event.driverId !== actorId) fail('Event belongs to another driver', 403);
  let result;
  await mongoose.connection.transaction(async session => {
    const doc = await ExternalRoutePlan.findById(id).session(session);
    if (!doc) fail('Plan not found', 404);
    const plan = doc.toObject();
    if (!plan.participantIds.includes(actorId)) fail('Not a participant', 403);
    // Exact old retries are read-only receipts; never reapply physical stock.
    const prior = plan.receipts.find(r => r.eventId === event.eventId && r.driverId === actorId);
    if (prior) {
      if (prior.hash !== fingerprint(event)) fail('Event ID reused with different content');
      const own = customers(plan).filter(s => s.driverId === actorId).map(s => s.deliveryId);
      const rows = await Delivery.find({ _id: { $in: own } }).session(session).lean();
      result = { duplicate: true, plan: projectForDriver(plan, actorId, rows) }; return;
    }
    const deliveries = await validateDeliveries(plan, session);
    // Writing the inspected rows makes concurrent edits/reassignment conflict
    // with this transaction, including transfer events that otherwise only
    // change the plan document. A snapshot read alone permits write skew.
    await Delivery.updateMany({ _id: { $in: deliveries.map(d => d._id) } }, { $inc: { externalRouteStateVersion: 1 } }, { session });
    const outcome = applyEvent(plan, actorId, event);
    if (event.type === 'complete') {
      const stop = customers(plan).find(s => s.id === event.stopId);
      const delivery = deliveries.find(d => String(d._id) === stop.deliveryId);
      const now = new Date(plan.state.completedStops[stop.id]);
      const proof = event.proof || {};
      const images = Array.isArray(proof.images) ? proof.images : [];
      if (images.some(url => typeof url !== 'string' || !/^https:\/\//.test(url)) || (proof.photoUrl && !/^https:\/\//.test(proof.photoUrl))) fail('Uploaded photo URL required', 400);
      // Keep physical package labels in proof; do not create bags, fabricate
      // a warehouse return, or mutate the unrelated reusable-bag inventory.
      await Delivery.updateOne({ _id: delivery._id, driver: actorId, externalRouteRevision: plan.revision }, { $set: {
        status: 'delivered', completedAt: now, deliveredTime: now,
        proof: { images: images.length ? images : [proof.photoUrl], photoUrl: proof.photoUrl || images[0], captureId: typeof proof.captureId === 'string' ? proof.captureId.slice(0, 120) : undefined, bagId: event.bagId || undefined, notes: String(proof.notes || '').slice(0, 1000), timestamp: now, location: { lat: event.location.lat, lng: event.location.lng }, verified: Boolean(event.bagId), deliveryMethod: event.bagId ? 'qr_verified' : 'photo_only' },
        deliveryType: now > new Date(stop.deadlineAt) ? 'late' : 'on-time', lateMinutes: Math.max(0, Math.round((now - new Date(stop.deadlineAt)) / 60000)), earlyMinutes: 0
      }, $push: { timeline: { status: 'delivered', timestamp: now, notes: `External plan revision ${plan.revision}; stop ${stop.id}` } } }, { session });
    }
    doc.state = plan.state;
    doc.receipts = plan.receipts;
    doc.markModified('state');
    doc.markModified('receipts');
    await doc.save({ session });
    result = { ...outcome, plan: projectForDriver(doc.toObject(), actorId, deliveries) };
  });
  return result;
}

export function projectForDriver(plan, driverId, deliveries = []) {
  const scoped = projectPlan(plan, driverId);
  if (!scoped) return { id: String(plan._id), serviceDate: plan.serviceDate, revision: plan.revision, cancelled: true, routes: [], transfers: [], counterparts: [], state: {}, removed: true };
  scoped.routes = scoped.routes.map(r => ({ ...r, stops: r.stops.map(s => {
    const d = deliveries.find(d => String(d._id) === s.deliveryId);
    return d ? { ...s, customerName: d.customerName, address: d.address, addressDetails: d.addressDetails, customerPhone: d.customerPhone } : s;
  }) }));
  return scoped;
}

export async function driverPlans(driverId, now = new Date()) {
  const local = new Date(now.getTime() + 14400000);
  const last = new Date(local.getTime() + (local.getUTCHours() >= Number(process.env.NEXT_DAY_AVAILABLE_HOUR || 16) ? 86400000 : 0)).toISOString().slice(0, 10);
  // Keep yesterday visible for unfinished shifts. Explicit selection prevents
  // yesterday/tomorrow routeOrder=0 from taking over today's navigation.
  const first = new Date(local.getTime() - 86400000).toISOString().slice(0, 10);
  const plans = await ExternalRoutePlan.find({ serviceDate: { $gte: first, $lte: last }, participantIds: driverId }).sort({ serviceDate: 1 }).lean();
  const result = [];
  for (const p of plans) {
    let scoped = projectForDriver(p, driverId);
    const ownRoute = scoped.routes[0];
    if (p.serviceDate < local.toISOString().slice(0, 10) && (p.cancelled || !ownRoute || (
      ownRoute.stops.every(s => s.type === 'pickup' ? p.state.completedTransfers[s.transferId] : p.state.completedStops[s.id])
      && scoped.transfers.every(t => p.state.completedTransfers[t.id])
    ))) continue;
    if (!p.cancelled) {
      try { scoped = projectForDriver(p, driverId, await validateDeliveries(p, null)); } catch (e) { scoped.blockedReason = e.message; }
    }
    result.push(scoped);
  }
  return result;
}

export async function cancelExternalPlan(id, expectedRevision, requestId, actorId) {
  let result;
  await mongoose.connection.transaction(async session => {
    const plan = await ExternalRoutePlan.findById(id).session(session);
    if (!plan) fail('Plan not found', 404);
    if (plan.cancelled && plan.cancellation?.requestId === requestId && plan.cancellation?.expectedRevision === expectedRevision) { result = plan; return; }
    if (plan.revision !== expectedRevision) fail('Plan revision changed');
    if (typeof requestId !== 'string' || !requestId.length || requestId.length > 120) fail('Cancellation request ID required', 400);
    plan.cancelled = true;
    plan.revision += 1;
    plan.cancellation = { requestId, expectedRevision, actorId, at: new Date() };
    plan.revisionHistory.push({ revision: plan.revision, requestId, cancelled: true, actorId, at: new Date() });
    plan.updatedBy = actorId;
    await plan.save({ session });
    result = plan;
  });
  return result;
}
