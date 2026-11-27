import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import test from 'node:test';
import FleetAssignmentReceipt from '../models/FleetAssignmentReceipt.js';
import User from '../models/User.js';
import Vehicle from '../models/Vehicle.js';
import { readReportingChanges, readReportingWatermark } from '../services/reportingOutbox.js';
import truckoomApiService from '../services/truckoomApiService.js';
import dispatcherFleet from './dispatcherFleet.js';
import drivers from './drivers.js';
import externalReporting from './externalReportingApi.js';
import truckoom from './truckoomApi.js';
import users from './users.js';
import vehicles from './vehicles.js';

const uri = process.env.REPORTING_TEST_MONGO_URI;
const actor = 'a'.repeat(24);
const admin = 'b'.repeat(24);
const viewer = 'c'.repeat(24);
const denied = 'd'.repeat(24);
const first = '1'.repeat(24);
const second = '2'.repeat(24);
const third = '3'.repeat(24);
const outside = '4'.repeat(24);
const van = '5'.repeat(24);
const bike = '6'.repeat(24);
const trackedBike = '7'.repeat(24);
const privateVanAlias = 'fixture-tracked-van';
const privateBikeAlias = 'fixture-tracked-bike';
const staffSecret = 'synthetic-dispatcher-fleet-staff-secret';
const command = (kind, ...pairs) => ({ kind, pairs: pairs.map(([driverId, sourceVehicleId]) => ({ driverId, sourceVehicleId })) });

const bearer = id => ({ authorization: 'Bearer ' + jwt.sign({ id }, staffSecret) });

async function request(router, method, routePath, { path = routePath, params = {}, body, headers = {} } = {}) {
  const route = router.stack.find(layer => layer.route?.path === routePath && layer.route.methods[method]);
  assert.ok(route, method + ' ' + routePath);
  const req = { method: method.toUpperCase(), path, body, params, headers, get(name) { return this.headers[name.toLowerCase()]; } };
  const res = {
    code: 200,
    headers: {},
    locals: {},
    set(name, value) { this.headers[name] = value; },
    status(code) { this.code = code; return this; },
    sendStatus(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  };
  for (const middleware of [...router.stack.filter(layer => !layer.route), ...route.route.stack]) {
    let passed = false;
    await middleware.handle(req, res, () => { passed = true; });
    if (!passed) break;
  }
  return res;
}

function useEnv(t, entries) {
  const before = Object.fromEntries(Object.keys(entries).map(name => [name, process.env[name]]));
  Object.assign(process.env, entries);
  t.after(() => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

const syntheticUser = (id, role, alias = null) => ({
  _id: new mongoose.Types.ObjectId(id), role, isActive: true, email: id + '@example.invalid',
  password: 'fixture-not-used-for-login', profile: { firstName: 'Fixture', truckoomVehicleNo: alias, vehicleType: 'car' },
});

test('the authorized Dispatch save powers Fleet, Live Tracking and the sequenced reporting receipt', { skip: !uri, timeout: 55_000 }, async t => {
  assert.equal(uri, 'mongodb://127.0.0.1:27017/driver_reports_ci?directConnection=true');
  await mongoose.connect(uri, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 5000 });
  t.after(() => mongoose.disconnect());
  useEnv(t, {
    JWT_SECRET: staffSecret,
    DELIVERY_API_KEYS: 'reporting:synthetic-reporting-key,ordinary:synthetic-ordinary-key',
    MATTER_REPORTING_API_CLIENTS: 'reporting',
    MATTER_REPORTING_CAPTURE_ENABLED: '1',
    MATTER_DISPATCH_FLEET_ENABLED: '1',
    MATTER_DISPATCH_FLEET_OPERATORS: [actor, viewer].join(','),
    MATTER_FLEET_LINK_SECRET: 'synthetic-local-review-secret'.repeat(2),
    MATTER_DISPATCH_FLEET_ROSTER: JSON.stringify({
      driverIds: [first, second, third],
      assets: [
        { sourceVehicleId: van, vehicleClass: 'van', trackerAlias: privateVanAlias },
        { sourceVehicleId: bike, vehicleClass: 'bike', trackerAlias: null },
        { sourceVehicleId: trackedBike, vehicleClass: 'bike', trackerAlias: privateBikeAlias },
      ],
    }),
  });
  await User.collection.insertMany([
    syntheticUser(actor, 'dispatcher'), syntheticUser(admin, 'super_admin'), syntheticUser(viewer, 'viewer'),
    syntheticUser(denied, 'dispatcher'), syntheticUser(first, 'driver', privateVanAlias), syntheticUser(second, 'driver'),
    syntheticUser(third, 'driver'), syntheticUser(outside, 'driver', 'fixture-unmanaged-old'),
  ]);
  await Vehicle.create([
    { _id: van, vehicleId: 'FIXTURE-VAN', plateNumber: 'V-001', type: 'van', status: 'active', assignedDriver: first },
    { _id: bike, vehicleId: 'FIXTURE-BIKE', plateNumber: 'B-001', type: 'bike', status: 'idle', assignedDriver: second },
    { _id: trackedBike, vehicleId: 'FIXTURE-TRACKED-BIKE', plateNumber: 'B-002', type: 'bike', status: 'active' },
  ]);

  const staffHeaders = id => ({ ...bearer(id), 'x-matter-fleet-actor': id });
  const dispatch = (body, headers = staffHeaders(actor)) => request(dispatcherFleet, 'post', '/', { headers, body });
  const options = headers => request(dispatcherFleet, 'get', '/options', { headers });
  const reporting = (id, key) => request(externalReporting, 'get', '/fleet-assignments/:id', {
    path: '/fleet-assignments/' + id, params: { id }, headers: { 'x-api-key': key },
  });
  const fleet = id => request(vehicles, 'get', '/:id', { params: { id }, headers: bearer(actor) });
  const editFleet = (id, body) => request(vehicles, 'put', '/:id', { params: { id }, headers: bearer(admin), body });
  const updateTracker = (vehicleNo, driverId) => request(truckoom, 'put', '/vehicles/:vehicleNo/driver', {
    params: { vehicleNo }, headers: bearer(admin), body: { driverId },
  });
  const driverMapping = async id => (await User.findById(id).select('profile').lean()).profile;
  const review = async input => {
    const res = await dispatch({ phase: 'review', command: input });
    assert.equal(res.code, 200, res.body?.message);
    return { phase: 'commit', command: input, operationId: res.body.data.operationId, reviewProof: res.body.data.reviewProof };
  };

  assert.equal((await options({})).code, 401);
  assert.equal((await options(staffHeaders(viewer))).code, 403);
  assert.equal((await options(staffHeaders(denied))).code, 404);
  assert.equal((await options({ ...bearer(actor), 'x-matter-fleet-actor': denied })).code, 403);
  assert.equal((await options({ ...staffHeaders(actor), 'sec-fetch-site': 'cross-site' })).code, 403);
  const roster = await options(staffHeaders(actor));
  assert.equal(roster.code, 200);
  assert.equal(roster.headers['Cache-Control'], 'private, no-store');
  assert.deepEqual(roster.body.data.map(row => [row.id, row.type, row.driverId, row.available]), [
    [bike, 'bike', second, true], [trackedBike, 'bike', null, true], [van, 'van', first, true],
  ]);
  assert.ok(!JSON.stringify(roster.body).includes(privateVanAlias));

  const captureDisabled = await review(command('assign', [first, van]));
  process.env.MATTER_REPORTING_CAPTURE_ENABLED = '0';
  assert.equal((await dispatch(captureDisabled)).code, 503);
  process.env.MATTER_REPORTING_CAPTURE_ENABLED = '1';

  const directNetwork = t.mock.method(globalThis, 'fetch', async () => { throw Error('Unexpected network use in Dispatch'); });
  const base = await readReportingWatermark();
  const firstSaved = await dispatch(captureDisabled);
  assert.equal(firstSaved.code, 200, firstSaved.body?.message);
  const firstReceiptId = firstSaved.body.data.receiptId;
  const baseline = await reporting(firstReceiptId, 'synthetic-reporting-key');
  assert.equal(baseline.code, 200);
  assert.deepEqual(baseline.body.data, {
    id: firstReceiptId, sourceVersion: base + 1, previousReceiptId: null, operationId: captureDisabled.operationId,
    actorId: actor, kind: 'assign', effectiveAt: firstSaved.body.data.effectiveAt,
    changes: [{ sourceVehicleId: van, vehicleClass: 'van', previousDriverId: first, driverId: first }],
  });
  assert.equal((await reporting(firstReceiptId, 'synthetic-ordinary-key')).code, 403);
  assert.equal((await reporting(firstReceiptId, 'invalid-key')).code, 401);
  assert.equal((await reporting('invalid-id', 'synthetic-reporting-key')).code, 400);
  assert.equal((await reporting('f'.repeat(24), 'synthetic-reporting-key')).code, 404);

  const stale = await review(command('end', [first, null]));
  const swap = await review(command('swap', [first, bike], [second, van]));
  const responses = await Promise.all([dispatch(swap), dispatch(swap)]);
  assert.ok(responses.every(res => res.code === 200), JSON.stringify(responses.map(res => res.body)));
  assert.deepEqual(responses[0].body, responses[1].body);
  const swapReceiptId = responses[0].body.data.receiptId;
  const savedSwap = (await reporting(swapReceiptId, 'synthetic-reporting-key')).body.data;
  assert.equal(savedSwap.previousReceiptId, firstReceiptId);
  assert.deepEqual(savedSwap.changes, [
    { sourceVehicleId: van, vehicleClass: 'van', previousDriverId: first, driverId: second },
    { sourceVehicleId: bike, vehicleClass: 'bike', previousDriverId: second, driverId: first },
  ]);
  assert.deepEqual(await dispatch(stale).then(res => res.code), 409);
  assert.equal((await dispatch({ ...swap, reviewProof: 'altered proof' })).code, 409);
  assert.equal(await readReportingWatermark(), base + 2);

  const vanAfter = await fleet(van);
  assert.equal(String(vanAfter.body.data.assignedDriver._id), second);
  assert.equal(String((await fleet(bike)).body.data.assignedDriver._id), first);
  assert.equal((await driverMapping(second)).truckoomVehicleNo, privateVanAlias);
  assert.equal((await driverMapping(first)).truckoomVehicleNo, null);
  assert.equal((await driverMapping(first)).vehicleType, 'car');
  t.mock.method(truckoomApiService, 'getFleetStatus', async () => [{ vehicleNo: privateVanAlias }]);
  const live = await request(truckoom, 'get', '/vehicles', { headers: bearer(admin) });
  assert.equal(live.code, 200);
  assert.equal(live.body.data[0].driver.id, second);
  assert.equal(directNetwork.mock.callCount(), 0);

  assert.equal((await editFleet(van, { assignedDriver: { _id: second }, type: 'van', notes: 'Routine service' })).code, 200);
  assert.equal((await Vehicle.findById(van).lean()).notes, 'Routine service');
  assert.equal((await editFleet(van, { assignedDriver: first })).code, 409);
  assert.equal((await editFleet(van, { type: 'car' })).code, 409);
  assert.equal((await request(vehicles, 'post', '/', {
    headers: bearer(admin), body: { vehicleId: 'BLOCKED', type: 'bike', plateNumber: 'TEST-3', assignedDriver: first },
  })).code, 409);
  assert.equal((await updateTracker(privateVanAlias, outside)).code, 409);
  assert.equal((await updateTracker('fixture-unmanaged-new', second)).code, 409);
  assert.equal((await updateTracker('fixture-unmanaged-new', outside)).code, 200);
  assert.equal((await request(drivers, 'put', '/:id', {
    params: { id: first }, headers: bearer(admin), body: { profile: { truckoomVehicleNo: privateVanAlias } },
  })).code, 409);
  assert.equal((await request(users, 'delete', '/:id', { params: { id: first }, headers: bearer(admin) })).code, 409);

  const saveTrackedBike = await review(command('assign', [third, trackedBike]));
  const competingBike = await review(command('assign', [first, trackedBike]));
  const tracked = await dispatch(saveTrackedBike);
  assert.equal(tracked.code, 200, tracked.body?.message);
  assert.equal((await driverMapping(third)).truckoomVehicleNo, privateBikeAlias);
  assert.equal((await dispatch(competingBike)).code, 409);

  const patch = await request(drivers, 'patch', '/:id/status', {
    params: { id: second }, headers: bearer(admin), body: { isActive: false },
  });
  assert.equal(patch.code, 200);
  const end = await review(command('end', [second, null]));
  const failAfterWrites = t.mock.method(FleetAssignmentReceipt, 'create', async () => { throw new Error('Fixture receipt write failure'); });
  assert.equal((await dispatch(end)).code, 503);
  assert.equal(failAfterWrites.mock.callCount(), 1);
  failAfterWrites.mock.restore();
  assert.equal(String((await fleet(van)).body.data.assignedDriver._id), second);
  assert.equal((await driverMapping(second)).truckoomVehicleNo, privateVanAlias);
  assert.equal(await readReportingWatermark(), base + 3);
  assert.equal(await FleetAssignmentReceipt.countDocuments({ operationId: end.operationId }), 0);

  const ended = await dispatch(end);
  assert.equal(ended.code, 200, ended.body?.message);
  assert.equal((await fleet(van)).body.data.assignedDriver, null);
  assert.equal((await driverMapping(second)).truckoomVehicleNo, null);
  const endReceipt = await reporting(ended.body.data.receiptId, 'synthetic-reporting-key');
  assert.equal(endReceipt.body.data.previousReceiptId, tracked.body.data.receiptId);
  const unsaved = await review(command('end', [first, null]));
  const actualNow = Date.now;
  const clock = t.mock.method(Date, 'now', () => actualNow() + 11 * 60_000);
  assert.deepEqual((await dispatch(swap)).body, responses[0].body);
  assert.equal((await dispatch(unsaved)).code, 422);
  clock.mock.restore();

  const page = await readReportingChanges({ after: String(base) });
  assert.deepEqual(page.data.map(({ eventType, subjectId, occurredAt, sourceVersion }) =>
    [eventType, subjectId, occurredAt, sourceVersion]), [
    ['fleet.assignment-changed', firstReceiptId, firstSaved.body.data.effectiveAt, base + 1],
    ['fleet.assignment-changed', swapReceiptId, responses[0].body.data.effectiveAt, base + 2],
    ['fleet.assignment-changed', tracked.body.data.receiptId, tracked.body.data.effectiveAt, base + 3],
    ['fleet.assignment-changed', ended.body.data.receiptId, ended.body.data.effectiveAt, base + 4],
  ]);
  assert.equal(page.hasMore, false);
  assert.equal((await FleetAssignmentReceipt.collection.indexes()).find(index => index.key.operationId === 1).unique, true);
  assert.equal(directNetwork.mock.callCount(), 0);
  process.env.MATTER_DISPATCH_FLEET_ENABLED = '0';
  assert.equal((await dispatch(swap)).code, 404);
  assert.equal((await editFleet(van, { assignedDriver: first })).code, 409);
});
