import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import FleetAssignmentReceipt from '../models/FleetAssignmentReceipt.js';
import User from '../models/User.js';
import Vehicle from '../models/Vehicle.js';
import { reportingCaptureEnabled, withReportingEvents } from './reportingOutbox.js';
import {
  activeFleetStatuses, buildFleetPlan, driverSourceId, fleetChanged, fleetError, fleetRequestHash,
  fleetReviewProof, isFleetOperationId, operatorAllowed, readFleetCommand, readFleetReview, trackerAlias,
} from './fleetDispatch.js';

const eventType = 'fleet.assignment-changed';
const trackerField = 'profile.truckoomVehicleNo';
const queryTimeout = 3000;
let initialization;

async function initializeFleetReceipts() {
  if (!initialization) {
    initialization = (async () => {
      try { await FleetAssignmentReceipt.createCollection(); }
      catch (error) { if (error.code !== 48) throw error; }
      await FleetAssignmentReceipt.createIndexes();
    })().catch(error => {
      initialization = undefined;
      throw error;
    });
  }
  return initialization;
}

export async function readDispatchOptions(roster) {
  const vehicles = await Vehicle.find({ _id: { $in: [...roster.assets.keys()] } })
    .select('vehicleId type status assignedDriver').sort('vehicleId').maxTimeMS(queryTimeout).lean();
  const available = vehicles.filter(vehicle => roster.assets.get(String(vehicle._id)).vehicleClass === vehicle.type);
  const held = available.map(vehicle => driverSourceId(vehicle.assignedDriver)).filter(Boolean);
  const drivers = await User.find({
    _id: { $in: [...roster.driverIds] }, role: 'driver', $or: [{ isActive: true }, { _id: { $in: held } }],
  }).select('isActive profile.firstName profile.lastName').maxTimeMS(queryTimeout).lean();

  const driverIds = new Set(drivers.map(driver => String(driver._id)));
  return {
    data: available.map(vehicle => {
      const owner = driverSourceId(vehicle.assignedDriver);
      return {
        id: String(vehicle._id), label: vehicle.vehicleId, type: vehicle.type,
        driverId: driverIds.has(owner) ? owner : null,
        available: activeFleetStatuses.includes(vehicle.status) && (!owner || driverIds.has(owner)),
      };
    }),
    drivers: drivers.map(({ _id, isActive, profile }) => ({
      _id: String(_id), isActive, name: [profile?.firstName, profile?.lastName].filter(Boolean).join(' ') || 'Driver',
    })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

async function readFleetPlan(command, roster, session = null) {
  const driverIds = command.pairs.map(pair => pair.driverId);
  const vehicleIds = command.pairs.map(pair => pair.sourceVehicleId).filter(Boolean);
  const vehicles = await Vehicle.find({ $or: [{ _id: { $in: vehicleIds } }, { assignedDriver: { $in: driverIds } }] })
    .select('type status assignedDriver').session(session).maxTimeMS(queryTimeout).lean();

  const managed = vehicles.map(vehicle => String(vehicle._id)).filter(id => roster.assets.has(id));
  const aliases = managed.map(id => roster.assets.get(id).trackerAlias).filter(Boolean);
  const candidates = [{ _id: { $in: driverIds } }];
  if (aliases.length) {
    // Match whitespace normalization used by Live Tracking and GPS capture.
    candidates.push({ role: 'driver', $expr: { $in: [
      { $trim: { input: { $convert: { input: '$' + trackerField, to: 'string', onError: '', onNull: '' } } } },
      aliases,
    ] } });
  }
  const drivers = await User.find({ $or: candidates }).select('role isActive ' + trackerField)
    .session(session).maxTimeMS(queryTimeout).lean();

  const heads = new Map();
  for (const id of managed) {
    const receipt = await FleetAssignmentReceipt.findOne({ 'changes.sourceVehicleId': id }).sort({ sourceVersion: -1 })
      .select('changes').session(session).maxTimeMS(queryTimeout).lean();
    if (receipt) heads.set(id, { id: String(receipt._id), change: receipt.changes.find(change => change.sourceVehicleId === id) });
  }
  return buildFleetPlan(command, { vehicles, drivers, heads }, roster);
}

const publicChanges = changes => changes.map(({ sourceVehicleId, vehicleClass, previousDriverId, driverId }) =>
  ({ sourceVehicleId, vehicleClass, previousDriverId, driverId }));

export async function readFleetAssignmentReceipt(id) {
  const receipt = await FleetAssignmentReceipt.findById(id).read('primary').readConcern('majority')
    .select('sourceVersion previousReceiptId operationId actorId kind effectiveAt changes')
    .maxTimeMS(5000).lean();
  if (!receipt) return null;
  const { sourceVersion, previousReceiptId, operationId, actorId, kind, effectiveAt, changes } = receipt;
  return {
    id: String(receipt._id), sourceVersion, previousReceiptId: previousReceiptId ? String(previousReceiptId) : null,
    operationId, actorId, kind, effectiveAt: effectiveAt.toISOString(), changes: publicChanges(changes),
  };
}

function committedDriverFleetReceipt(driverId, effectiveAt = {}) {
  return FleetAssignmentReceipt.findOne({
    $or: [{ 'changes.driverId': driverId }, { 'changes.previousDriverId': driverId }],
    ...effectiveAt,
  }).read('primary').readConcern('majority').maxTimeMS(queryTimeout);
}

export async function firstFleetReceiptTime(driverId) {
  const first = await committedDriverFleetReceipt(driverId).sort({ effectiveAt: 1 }).select('effectiveAt').lean();
  return first?.effectiveAt ?? null;
}

export async function readFleetTrackerBinding(driverId, capturedAt, receivedAt) {
  const read = (effectiveAt, direction) => committedDriverFleetReceipt(driverId, { effectiveAt })
    .sort({ effectiveAt: direction }).select('effectiveAt changes').lean();
  const opening = await read({ $lte: capturedAt }, -1);
  const custody = opening?.changes.filter(change => change.driverId === driverId);
  if (custody?.length !== 1) return null;
  const alias = custody[0].trackerAlias;
  if (alias !== trackerAlias(alias)) return null; // Require an explicit untracked null or exact alias.
  const closing = await read({ $gt: capturedAt }, 1);
  if (closing && closing.effectiveAt <= receivedAt) return null;
  return { trackerAlias: alias, startsAt: opening.effectiveAt, endsAt: closing?.effectiveAt ?? null };
}

function savedOperation(receipt) {
  return { state: 'saved', operationId: receipt.operationId, receiptId: String(receipt._id), effectiveAt: receipt.effectiveAt.toISOString() };
}

async function applyFleetPlan(command, changes, session) {
  for (const { sourceVehicleId, vehicleClass, previousDriverId, driverId } of changes) {
    const result = await Vehicle.updateOne({ _id: sourceVehicleId, type: vehicleClass, assignedDriver: previousDriverId },
      { $set: { assignedDriver: driverId } }, { session, runValidators: true });
    if (result.matchedCount !== 1) throw fleetChanged();
  }
  for (const { driverId } of command.pairs) {
    const alias = changes.find(change => change.driverId === driverId)?.trackerAlias ?? null;
    const result = await User.updateOne({ _id: driverId, role: 'driver', ...(command.kind !== 'end' && { isActive: true }) },
      { $set: { [trackerField]: alias } }, { session, runValidators: true });
    if (result.matchedCount !== 1) throw fleetChanged();
  }
}

export async function dispatchFleet({ phase, command: input, operationId, reviewProof }, { actorId, secret, roster }) {
  if (!['review', 'commit'].includes(phase)) throw fleetError(400, 'Review the pairing before saving it.');
  const command = readFleetCommand(input);
  if (phase === 'review') {
    const plan = await readFleetPlan(command, roster);
    const id = randomUUID();
    return {
      operationId: id, changes: publicChanges(plan.changes),
      reviewProof: fleetReviewProof(secret, actorId, id, command, plan.fingerprint, Date.now()),
    };
  }

  if (!isFleetOperationId(operationId)) throw fleetError(400, 'Invalid pairing operation.');
  if (typeof reviewProof !== 'string' || reviewProof.length > 143) {
    throw fleetError(422, 'Review this pairing before saving it.');
  }
  if (!reportingCaptureEnabled()) throw new Error('Fleet assignments require reporting capture');
  await initializeFleetReceipts();

  let saved;
  await withReportingEvents(async (session, enqueue) => {
    if (!session) throw new Error('Fleet assignments require a MongoDB transaction');
    const actor = await User.findById(actorId).select('role isActive').session(session).maxTimeMS(queryTimeout).lean();
    if (!actor?.isActive || !operatorAllowed(actor, process.env)) {
      throw fleetError(403, 'This account cannot save a Dispatch vehicle assignment.');
    }

    const requestHash = fleetRequestHash(command, reviewProof);
    const existing = await FleetAssignmentReceipt.findOne({ operationId }).select('+requestHash')
      .session(session).maxTimeMS(queryTimeout).lean();
    if (existing) {
      if (existing.actorId !== actorId || existing.requestHash !== requestHash) throw fleetChanged();
      // An acknowledged or previously uncertain save remains recoverable even
      // after expiry, a clock change or subsequent vehicle/driver changes.
      saved = savedOperation(existing);
      return;
    }

    const review = readFleetReview(secret, actorId, operationId, command, reviewProof);
    if (!review) throw fleetError(422, 'Review this pairing before saving it.');
    if (Date.now() >= review.expiresAt) throw fleetError(422, 'This pairing review expired. Review the pairing again.');
    const plan = await readFleetPlan(command, roster, session);
    if (plan.fingerprint !== review.fingerprint) throw fleetChanged();

    const previous = await FleetAssignmentReceipt.findOne().sort({ sourceVersion: -1 })
      .select('effectiveAt').session(session).maxTimeMS(queryTimeout).lean();
    const effectiveAt = new Date(Date.now());
    if (+effectiveAt >= review.expiresAt) throw fleetError(422, 'This pairing review expired. Review the pairing again.');
    if (previous && +effectiveAt <= +previous.effectiveAt) throw new Error('Fleet receipt clock must advance');

    const _id = new mongoose.Types.ObjectId();
    // The sequence write serializes fleet transactions with all other change
    // feed writers. A competing commit retries the entire snapshot.
    const [{ sourceVersion }] = await enqueue(eventType, [_id], effectiveAt);
    await applyFleetPlan(command, plan.changes, session);
    const [receipt] = await FleetAssignmentReceipt.create([{
      _id, operationId, actorId, requestHash, sourceVersion, previousReceiptId: previous?._id ?? null,
      kind: command.kind, effectiveAt, changes: plan.changes,
    }], { session });
    saved = savedOperation(receipt);
  });
  return saved;
}
