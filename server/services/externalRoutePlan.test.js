import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan, applyEvent, replaceState, projectPlan, externalRouteEta } from './externalRoutePlan.js';

import { fixture, ids } from './fixtures/externalRoutePlanFixture.js';

export function ready() {
  const plan = fixture();
  for (const r of plan.routes) {
    applyEvent(plan, r.driverId, { eventId: `ack-${r.driverId}`, revision: 1, type: 'acknowledge' });
    applyEvent(plan, r.driverId, { eventId: `load-${r.driverId}`, revision: 1, type: 'load', cargo: r.initialCargo });
  }
  return plan;
}
const at = new Date('2026-10-14T02:18:00+04:00');
const event = (type, extra = {}) => ({ eventId: `event-${type}`, revision: 1, type, transferId: 't1', location: { lat: 25.1, lng: 55.2 }, ...extra });

test('external plan retains two pickups from distinct parked vans in exact route order', () => {
  const p = fixture();
  assert.deepEqual(p.routes[0].stops.map(s => s.id), ['c1', 'p1', 'c2', 'p2', 'c3']);
  assert.equal(projectPlan(p, ids.van).transfers.length, 1);
  assert.equal(projectPlan(p, ids.bike).transfers.length, 2);
  assert.equal(projectPlan(p, ids.van).routes.length, 1);
});
test('rejects wrong windows, duplicate cargo, moving hubs and uncollected customer cargo', () => {
  for (const change of [p => p.routes[0].stops[0].earliestAt = '2026-10-14T01:00:00+04:00', p => p.transfers[0].cargo[0].bagIds = ['WRONG'], p => p.transfers[0].point.lng = 55.9, p => p.routes[0].stops.reverse()]) {
    const p = fixture(); change(p); assert.throws(() => validatePlan(p));
  }
});
test('both arrivals and exact batch/cargo confirmation are required; retries are idempotent', () => {
  const p = ready();
  // A customer completion is persisted by the transactional service; pure state marks it here.
  p.state.completedStops.c1 = at.toISOString();
  const t = p.transfers[0];
  const arrival = event('arrive', { location: t.point });
  applyEvent(p, ids.bike, arrival, at);
  assert.throws(() => applyEvent(p, ids.bike, event('confirm', { batchId: t.batchId, cargo: t.cargo }), at), /counterpart/);
  applyEvent(p, ids.van, { ...arrival, eventId: 'van-arrive' }, at);
  assert.throws(() => applyEvent(p, ids.bike, event('confirm', { batchId: 'WRONG', cargo: t.cargo }), at), /batch/);
  applyEvent(p, ids.bike, event('confirm', { batchId: t.batchId, cargo: t.cargo }), at);
  assert.equal(p.state.completedTransfers.t1, undefined);
  const confirm = event('confirm', { eventId: 'van-confirm', batchId: t.batchId, cargo: t.cargo });
  applyEvent(p, ids.van, confirm, at);
  assert.ok(p.state.completedTransfers.t1);
  const length = p.receipts.length;
  applyEvent(p, ids.van, confirm, at);
  assert.equal(p.receipts.length, length);
  assert.throws(() => applyEvent(p, ids.van, { ...confirm, cargo: [] }, at), /reused/);
});
test('missing counterpart exception, wrong actor, stale revision and cancelled plan fail closed', () => {
  const p = ready();
  applyEvent(p, ids.bike, event('exception', { reason: 'missing_counterpart' }), at);
  assert.equal(p.state.exceptions.t1.reason, 'missing_counterpart');
  assert.throws(() => applyEvent(p, ids.van2, event('arrive', { location: p.transfers[0].point }), at), /participant/);
  assert.throws(() => applyEvent(p, ids.bike, { ...event('arrive'), revision: 0 }, at), /revision/);
  p.cancelled = true;
  assert.throws(() => applyEvent(p, ids.bike, event('arrive'), at), /cancelled/);
});
test('replacement requires new acknowledgement and retains physical custody; unsafe replacement rejected', () => {
  const p = ready();
  const next = fixture(); next.revision = 2; next.expectedRevision = 1;
  replaceState(next, p);
  assert.deepEqual(next.state.acknowledgements, {});
  assert.ok(next.state.loaded[ids.bike]);
  assert.throws(() => applyEvent(next, ids.bike, { ...event('arrive'), revision: 2 }, at), /acknowledge/);
  const bad = fixture(); bad.routes[0].initialCargo = [];
  assert.throws(() => replaceState(bad, p), /loaded/);
});

test('admin preview retains both pickup rows without invoking the optimizer', () => {
  const out = externalRouteEta(fixture(), ids.bike);
  assert.equal(out.source, 'external_plan');
  assert.equal(out.detours.length, 2);
  assert.deepEqual(out.detours.map(d => d.batchId), ['BATCH-1', 'BATCH-2']);
  assert.equal(out.totals, null);
});
