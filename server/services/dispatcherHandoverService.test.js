import test from 'node:test';
import assert from 'node:assert/strict';
import { planBagMovement } from './bagLifecycleService.js';
import { buildDispatcherHandovers, validateDispatcherHandover } from './dispatcherHandoverService.js';
const actor = {
    _id: 'dispatcher',
    role: 'dispatcher',
    name: 'Signed-in dispatcher'
  },
  driver = {
    _id: 'driver',
    role: 'driver',
    name: 'Receiving driver'
  };
const root = 'handover:11111111-1111-4111-8111-111111111111:dispatcher:driver';
const bag = {
  _id: 'b1',
  bagId: 'BAG-00001',
  lifecycleState: 'ready',
  status: 'available',
  location: 'warehouse',
  condition: 'good',
  custodyVersion: 3,
  history: []
};
const apply = (b, p) => {
  const next = {
    ...b,
    ...p.set,
    history: [...b.history, p.event],
    custodyVersion: b.custodyVersion + 1
  };
  for (const key in p.unset) delete next[key];
  return next;
};
const pack = (b = bag, extra = {}) => planBagMovement(b, {
  action: 'pack',
  driverId: 'driver',
  eventId: root + ':' + b._id,
  expectedVersion: 3,
  note: 'Physical bags checked',
  ...extra
}, actor, new Date('2026-11-23T03:00:00Z'));
test('dispatcher prepares ready stock without transferring custody; exact offer is linked to receipt', () => {
  const p = pack();
  assert.equal(p.set.location, undefined);
  assert.equal(p.set.lifecycleState, 'packed');
  assert.equal(p.set.pendingHandover.preparedBy, actor._id);
  assert.equal(p.set.pendingHandover.eventId, root + ':b1');
  assert.equal(p.event.assignedBy.name, actor.name);
  assert.equal(p.event.assignedTo.driver, 'driver');
});
test('dispatcher is not granted warehouse receiving, release, repair or opening-stock access', () => {
  for (const action of ['receive', 'release', 'repair', 'observe_warehouse', 'start_cleaning']) assert.throws(() => planBagMovement({
    ...bag,
    lifecycleState: 'received'
  }, {
    action,
    eventId: 'other',
    note: 'Physical',
    inspected: true
  }, actor), /permission/);
});
test('stale, unverified, damaged, flagged or non-warehouse bags cannot be prepared', () => {
  for (const change of [{
    custodyVersion: 4
  }, {
    lifecycleState: undefined
  }, {
    condition: 'poor'
  }, {
    isFlagged: true
  }, {
    location: 'driver'
  }, {
    isActive: false
  }]) assert.throws(() => pack({
    ...bag,
    ...change
  }));
});
test('retries do not prepare twice or let another actor reuse a bag event', () => {
  const packed = apply(bag, pack());
  assert.equal(planBagMovement(packed, {
    action: 'pack',
    driverId: 'driver',
    eventId: root + ':b1',
    expectedVersion: 3
  }, actor).duplicate, true);
  assert.throws(() => planBagMovement(packed, {
    action: 'pack',
    driverId: 'driver',
    eventId: root + ':b1',
    expectedVersion: 3
  }, {
    ...actor,
    _id: 'other'
  }), /different action/);
});
test('history counts only exact nominated-driver acceptance, preserving individual bag IDs', () => {
  const p = pack(),
    packed = apply(bag, p);
  const acceptance = planBagMovement(packed, {
    action: 'accept',
    eventId: 'accept-1'
  }, driver, new Date('2026-11-23T03:03:00Z'));
  const p2 = pack({
    ...bag,
    _id: 'b2',
    bagId: 'BAG-00002'
  });
  const rows = [{
    bagId: bag.bagId,
    event: p.event
  }, {
    bagId: bag.bagId,
    event: acceptance.event
  }, {
    bagId: 'BAG-00002',
    event: p2.event
  }];
  const receipt = buildDispatcherHandovers(rows, [{
    _id: 'driver',
    name: 'Actual driver'
  }])[0];
  assert.equal(receipt.dispatcherName, actor.name);
  assert.equal(receipt.preparedCount, 2);
  assert.equal(receipt.acceptedCount, 1);
  assert.equal(receipt.pendingCount, 1);
  assert.equal(receipt.status, 'partial');
  assert.deepEqual(receipt.bags.map(b => b.bagId), ['BAG-00001', 'BAG-00002']);
  assert.equal(receipt.driverName, 'Actual driver');
});
test('later physical scans never fabricate driver acceptance', () => {
  const p = pack(),
    packed = apply(bag, p);
  const physical = planBagMovement(packed, {
    action: 'deliver',
    physicalScan: true,
    eventId: 'deliver',
    deliveryId: 'delivery',
    customerId: 'customer'
  }, driver);
  const r = buildDispatcherHandovers([{
    bagId: bag.bagId,
    event: p.event
  }, {
    bagId: bag.bagId,
    event: physical.event
  }])[0];
  assert.equal(r.acceptedCount, 0);
  assert.equal(r.bags[0].status, 'exception');
});
test('wrong receiving actor, cancellation and an unrelated older offer cannot count as accepted', () => {
  const p = pack(),
    event = {
      eventType: 'accept',
      assignedBy: {
        user: 'other'
      },
      before: {
        pendingHandover: {
          eventId: root + ':b1'
        }
      },
      timestamp: '2026-11-23T04:00:00Z'
    };
  assert.equal(buildDispatcherHandovers([{
    bagId: bag.bagId,
    event: p.event
  }, {
    bagId: bag.bagId,
    event
  }])[0].acceptedCount, 0);
  event.eventType = 'cancel_handover';
  assert.equal(buildDispatcherHandovers([{
    bagId: bag.bagId,
    event: p.event
  }, {
    bagId: bag.bagId,
    event
  }])[0].status, 'cancelled');
  event.eventType = 'accept';
  event.assignedBy.user = 'driver';
  event.before.pendingHandover.eventId = 'unrelated';
  assert.equal(buildDispatcherHandovers([{
    bagId: bag.bagId,
    event: p.event
  }, {
    bagId: bag.bagId,
    event
  }])[0].status, 'pending');
});
test('receipts from different actors cannot be grouped by a reused client request ID', () => {
  const a = pack().event,
    b = {
      ...a,
      eventId: a.eventId.replace(':dispatcher:', ':other:'),
      assignedBy: {
        user: 'other',
        name: 'Other staff'
      }
    };
  assert.equal(buildDispatcherHandovers([{
    bagId: 'BAG-00001',
    event: a
  }, {
    bagId: 'BAG-00002',
    event: b
  }]).length, 2);
});
test('handover endpoint validation handles malformed rows and requires explicit physical confirmation', () => {
  const body = {
    requestId: '11111111-1111-4111-8111-111111111111',
    driverId: '1234567890abcdef12345678',
    confirmed: true,
    note: '',
    bags: [{
      bagId: 'BAG-00001',
      expectedVersion: 0
    }]
  };
  assert.equal(validateDispatcherHandover(body), null);
  for (const change of [{
    confirmed: false
  }, {
    bags: [null]
  }, {
    bags: [{}]
  }, {
    bags: [{
      bagId: 'X'.repeat(161),
      expectedVersion: 0
    }]
  }, {
    bags: [{
      bagId: 'BAG-00001',
      expectedVersion: -1
    }]
  }, {
    driverId: 'invalid'
  }]) assert.equal(typeof validateDispatcherHandover({
    ...body,
    ...change
  }), 'string');
});
