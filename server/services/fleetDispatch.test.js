import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fleetRoster, operatorAllowed, readFleetCommand, buildFleetPlan,
  fleetReviewProof, readFleetReview,
} from './fleetDispatch.js';

const actor = 'a'.repeat(24);
const first = 'b'.repeat(24);
const second = 'c'.repeat(24);
const outside = 'd'.repeat(24);
const van = '1'.repeat(24);
const bike = '2'.repeat(24);
const outsideVehicle = '3'.repeat(24);
const op = 'aaaa1234-2222-4333-8333-bbbbbbbbbbbb';
const secret = 'fixture-fleet-review-secret-'.repeat(2);
const now = Date.parse('2026-11-27T08:01:00.000Z');
const rosterData = { driverIds: [first, second], assets: [
  { sourceVehicleId: van, vehicleClass: 'van', trackerAlias: 'fixture-van' },
  { sourceVehicleId: bike, vehicleClass: 'bike', trackerAlias: null },
] };
const env = {
  MATTER_DISPATCH_FLEET_ENABLED: '1',
  MATTER_DISPATCH_FLEET_OPERATORS: actor,
  MATTER_DISPATCH_FLEET_ROSTER: JSON.stringify(rosterData),
};
const command = (kind, ...pairs) => ({ kind, pairs: pairs.map(([driverId, sourceVehicleId]) => ({ driverId, sourceVehicleId })) });

function state({ vanDriver = first, bikeDriver = second, firstAlias = 'fixture-van', heads = [] } = {}) {
  return {
    vehicles: [
      { _id: van, type: 'van', assignedDriver: vanDriver, status: 'active' },
      { _id: bike, type: 'bike', assignedDriver: bikeDriver, status: 'idle' },
    ],
    drivers: [
      { _id: first, role: 'driver', isActive: true, profile: { truckoomVehicleNo: firstAlias } },
      { _id: second, role: 'driver', isActive: true, profile: {} },
    ],
    heads: new Map(heads),
  };
}

test('limits entry to explicitly approved Dispatch actors and requires independently confirmed tracker coverage', () => {
  assert.equal(operatorAllowed({ _id: actor, role: 'dispatcher' }, env), true);
  assert.equal(operatorAllowed({ _id: actor, role: 'viewer' }, env), false);
  assert.equal(operatorAllowed({ _id: outside, role: 'admin' }, env), false);
  assert.equal(operatorAllowed({ _id: actor, role: 'dispatcher' }, {}), false);
  assert.equal(fleetRoster({}), null);
  const roster = fleetRoster(env);
  assert.equal(roster.assets.get(van).trackerAlias, 'fixture-van');
  assert.equal(roster.assets.get(bike).trackerAlias, null);
  for (const assets of [
    [{ sourceVehicleId: bike, vehicleClass: 'bike' }],
    [rosterData.assets[0], { ...rosterData.assets[1], trackerAlias: 'fixture-van' }],
    [{ ...rosterData.assets[0], vehicleClass: 'unknown' }],
  ]) {
    assert.throws(() => fleetRoster({ ...env, MATTER_DISPATCH_FLEET_ROSTER: JSON.stringify({ ...rosterData, assets }) }), { status: 503 });
  }
});

test('rejects client scheduling and malformed swaps before touching assignments', () => {
  const assign = command('assign', [first, van]);
  assert.deepEqual(readFleetCommand(assign), assign);
  assert.throws(() => readFleetCommand({ ...assign, from: '2099-01-02T03:04:00.000Z' }), { status: 400 });
  assert.throws(() => readFleetCommand({ ...assign, to: null }), { status: 400 });
  assert.throws(() => readFleetCommand(command('correct', [first, van])), { status: 400 });
  assert.throws(() => readFleetCommand(command('swap', [first, van], [first, bike])), { status: 400 });
  assert.throws(() => readFleetCommand(command('swap', [first, van], [second, van])), { status: 400 });
});

test('binds the review clock and current state to the same operator, operation and command', () => {
  const swap = command('swap', [first, bike], [second, van]);
  const fingerprint = buildFleetPlan(swap, state(), fleetRoster(env)).fingerprint;
  const proof = fleetReviewProof(secret, actor, op, swap, fingerprint, now);
  assert.deepEqual(readFleetReview(secret, actor, op, swap, proof), { fingerprint, expiresAt: now + 600_000 });
  assert.equal(readFleetReview(secret, outside, op, swap, proof), null);
  assert.equal(readFleetReview(secret, actor, op, command('assign', [first, bike]), proof), null);
  assert.equal(readFleetReview(secret, actor, op.replace(/^a/, 'b'), swap, proof), null);
  assert.equal(readFleetReview(secret, actor, op, swap, proof.replace(String(now + 600_000), String(now + 700_000))), null);
  const changed = state();
  changed.vehicles[0].status = 'idle';
  assert.notEqual(buildFleetPlan(swap, changed, fleetRoster(env)).fingerprint, fingerprint);
});

test('a reciprocal swap updates both vehicle owners and clears tracking for the untracked bike', () => {
  const swap = command('swap', [first, bike], [second, van]);
  const roster = fleetRoster(env);
  const data = state();
  assert.deepEqual(buildFleetPlan(swap, data, roster).changes, [
    { sourceVehicleId: van, vehicleClass: 'van', trackerAlias: 'fixture-van', previousDriverId: first, driverId: second },
    { sourceVehicleId: bike, vehicleClass: 'bike', trackerAlias: null, previousDriverId: second, driverId: first },
  ]);
  assert.throws(() => buildFleetPlan(command('swap', [first, van], [second, bike]), data, roster), { status: 409 });
  assert.throws(() => buildFleetPlan(command('assign', [first, bike]), data, roster), { status: 409 });
  data.vehicles[1].assignedDriver = null;
  assert.deepEqual(buildFleetPlan(command('assign', [first, bike]), data, roster).changes.map(change => change.driverId), [null, first]);
});

test('records the first confirmation of a current pair and rejects an already recorded no-op', () => {
  const assign = command('assign', [first, van]);
  const roster = fleetRoster(env);
  const existing = state();
  const { changes } = buildFleetPlan(assign, existing, roster);
  assert.deepEqual(changes, [
    { sourceVehicleId: van, vehicleClass: 'van', trackerAlias: 'fixture-van', previousDriverId: first, driverId: first },
  ]);
  existing.heads.set(van, { id: '4'.repeat(24), change: changes[0] });
  assert.throws(() => buildFleetPlan(assign, existing, roster), { status: 409 });
  existing.drivers[0].isActive = false;
  existing.vehicles[0].status = 'maintenance';
  assert.deepEqual(buildFleetPlan(command('end', [first, null]), existing, roster).changes.map(change => change.driverId), [null]);
});

test('an unmanaged Fleet link or competing tracker holder stops the operation before writes', () => {
  const roster = fleetRoster(env);
  const swap = command('swap', [first, bike], [second, van]);
  const overlappingFleet = state();
  overlappingFleet.vehicles.push({ _id: outsideVehicle, type: 'van', assignedDriver: first, status: 'active' });
  assert.throws(() => buildFleetPlan(swap, overlappingFleet, roster), { status: 409 });
  const duplicateAlias = state();
  duplicateAlias.drivers.push({ _id: outside, role: 'driver', isActive: true, profile: { truckoomVehicleNo: ' fixture-van ' } });
  assert.throws(() => buildFleetPlan(swap, duplicateAlias, roster), { status: 409 });
  const outsideAlias = state({ firstAlias: 'outside-tracker' });
  assert.throws(() => buildFleetPlan(swap, outsideAlias, roster), { status: 409 });
});

test('a verified alias can change only after the last receipt ended active custody', () => {
  const nextRoster = fleetRoster({ ...env, MATTER_DISPATCH_FLEET_ROSTER: JSON.stringify({
    ...rosterData, assets: [{ ...rosterData.assets[0], trackerAlias: 'replacement-alias' }, rosterData.assets[1]],
  }) });
  const oldChange = { sourceVehicleId: van, vehicleClass: 'van', trackerAlias: 'fixture-van', previousDriverId: first, driverId: first };
  const live = state({ heads: [[van, { id: '4'.repeat(24), change: oldChange }]] });
  assert.throws(() => buildFleetPlan(command('end', [first, null]), live, nextRoster), { status: 409 });

  const closed = state({ vanDriver: null, firstAlias: null, heads: [[van, { id: '5'.repeat(24),
    change: { ...oldChange, driverId: null } }]] });
  assert.deepEqual(buildFleetPlan(command('assign', [first, van]), closed, nextRoster).changes, [
    { sourceVehicleId: van, vehicleClass: 'van', trackerAlias: 'replacement-alias', previousDriverId: null, driverId: first },
  ]);
});
