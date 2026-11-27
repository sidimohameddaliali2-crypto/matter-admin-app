import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const roles = new Set(['super_admin', 'admin', 'manager', 'dispatcher']);
const classes = new Set(['bike', 'van', 'car', 'truck']);
const kinds = new Set(['assign', 'swap', 'end']);
const reviewLifetime = 10 * 60_000;

export const activeFleetStatuses = ['active', 'idle'];
export const isFleetSourceId = value => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value);
export const isFleetOperationId = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export const fleetError = (status, message) => Object.assign(new Error(message), { status });
export const fleetUnavailable = () => fleetError(503, 'Vehicle assignments are temporarily unavailable.');
export const fleetChanged = () => fleetError(409, 'The pairing changed. Review it before saving again.');
export const legacyFleetConflict = () => fleetError(409, 'Use Dispatch vehicle assignment to change this pairing.');
export function driverSourceId(value) {
  const id = value?._id ?? value;
  return id ? String(id).toLowerCase() : null;
}
export const trackerAlias = value => typeof value === 'string' || typeof value === 'number' ? String(value).trim() || null : null;

export function operatorAllowed(user, env) {
  const actor = String(user?._id ?? '');
  return env.MATTER_DISPATCH_FLEET_ENABLED === '1' && roles.has(user?.role)
    && isFleetSourceId(actor) && Boolean(env.MATTER_DISPATCH_FLEET_OPERATORS?.split(',').some(id => id.trim() === actor));
}

export function fleetRoster(env = process.env) {
  const config = env.MATTER_DISPATCH_FLEET_ROSTER;
  // Keeping the roster configured during a writer pause preserves the legacy fences.
  if (!config && env.MATTER_DISPATCH_FLEET_ENABLED !== '1') return null;
  let roster;
  try { roster = JSON.parse(config); }
  catch { throw fleetUnavailable(); }
  const { driverIds, assets } = roster ?? {};
  if (!Array.isArray(driverIds) || driverIds.length === 0 || driverIds.length > 100 || !driverIds.every(isFleetSourceId)
      || !Array.isArray(assets) || assets.length === 0 || assets.length > 100) throw fleetUnavailable();

  const byId = new Map();
  const aliases = new Set();
  for (const asset of assets) {
    const { sourceVehicleId, vehicleClass, trackerAlias: alias } = asset ?? {};
    if (!isFleetSourceId(sourceVehicleId) || !classes.has(vehicleClass) || byId.has(sourceVehicleId)
        || (alias !== null && (typeof alias !== 'string' || alias !== trackerAlias(alias)
          || alias.length > 80 || /[\x00-\x1f\x7f]/.test(alias) || aliases.has(alias)))) throw fleetUnavailable();
    byId.set(sourceVehicleId, { vehicleClass, trackerAlias: alias });
    if (alias !== null) aliases.add(alias);
  }
  const drivers = new Set(driverIds);
  if (drivers.size !== driverIds.length) throw fleetUnavailable();
  return { assets: byId, driverIds: drivers, trackerAliases: aliases };
}

export function readFleetCommand(command) {
  const { kind, pairs, ...fields } = command ?? {};
  const swap = kind === 'swap';
  if (!kinds.has(kind) || Object.keys(fields).length > 0 || !Array.isArray(pairs)
      || pairs.length !== (swap ? 2 : 1)) throw fleetError(400, 'Choose a driver and confirmed vehicle for this handover.');
  const valid = pairs.every(pair => pair && typeof pair === 'object' && Object.keys(pair).length === 2
    && isFleetSourceId(pair.driverId) && (kind === 'end' ? pair.sourceVehicleId === null : isFleetSourceId(pair.sourceVehicleId)));
  if (!valid || (swap && (pairs[0].driverId === pairs[1].driverId || pairs[0].sourceVehicleId === pairs[1].sourceVehicleId))) {
    throw fleetError(400, 'Choose distinct drivers and vehicles for this handover.');
  }
  return { kind, pairs: pairs.map(({ driverId, sourceVehicleId }) => ({ driverId, sourceVehicleId })) };
}

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function reviewSignature(secret, actorId, operationId, command, fingerprint, expiresAt) {
  return createHmac('sha256', secret).update('matter-sidi-live-fleet-review-v1\n')
    .update(JSON.stringify([actorId, operationId, command, fingerprint, expiresAt])).digest('hex');
}

export function fleetReviewProof(secret, actorId, operationId, command, fingerprint, now) {
  const expiresAt = now + reviewLifetime;
  return `${expiresAt}.${fingerprint}.${reviewSignature(secret, actorId, operationId, command, fingerprint, expiresAt)}`;
}

export function readFleetReview(secret, actorId, operationId, command, proof) {
  const parts = typeof proof === 'string' && /^(\d{13})\.([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(proof);
  if (!parts) return null;
  const [, time, fingerprint, signature] = parts;
  const expiresAt = Number(time);
  const expected = reviewSignature(secret, actorId, operationId, command, fingerprint, expiresAt);
  return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex')) ? { fingerprint, expiresAt } : null;
}

export const fleetRequestHash = (command, reviewProof) => digest([command, reviewProof]);

function confirmedAsset(vehicle, roster) {
  const asset = roster.assets.get(String(vehicle._id));
  if (!asset || asset.vehicleClass !== vehicle.type) {
    throw fleetError(409, 'Current custody or vehicle class conflicts with the confirmed fleet roster.');
  }
  return asset;
}

export function buildFleetPlan({ kind, pairs }, { drivers, vehicles, heads }, roster) {
  const participants = new Map(pairs.map(pair => [pair.driverId, drivers.find(driver => String(driver._id) === pair.driverId)]));
  for (const [id, driver] of participants) {
    if (!roster.driverIds.has(id) || driver?.role !== 'driver' || (kind !== 'end' && !driver.isActive)) {
      throw fleetError(422, 'Choose an eligible driver from the Dispatch fleet roster.');
    }
  }

  const current = new Map();
  for (const id of participants.keys()) {
    const owned = vehicles.filter(vehicle => driverSourceId(vehicle.assignedDriver) === id);
    if (owned.length > 1) throw fleetError(409, 'A driver already has more than one vehicle in Fleet.');
    if (owned[0]) {
      confirmedAsset(owned[0], roster);
      current.set(id, owned[0]);
    }
  }

  const desired = new Map([...current.values()].map(vehicle => [String(vehicle._id), { vehicle, driverId: null }]));
  if (kind === 'end' && desired.size === 0) throw fleetError(409, 'This driver has no current Dispatch vehicle to end.');
  for (const { driverId, sourceVehicleId } of pairs) {
    if (kind === 'end') break;
    const target = vehicles.find(vehicle => String(vehicle._id) === sourceVehicleId);
    if (!target || !activeFleetStatuses.includes(target.status)) throw fleetError(422, 'Choose an available vehicle.');
    confirmedAsset(target, roster);
    const ownerId = driverSourceId(target.assignedDriver);
    if (kind === 'swap' && (!ownerId || ownerId === driverId || !participants.has(ownerId))) {
      throw fleetError(409, 'Choose the two vehicles these drivers currently hold to make a reciprocal swap.');
    }
    if (kind === 'assign' && ownerId && ownerId !== driverId) {
      throw fleetError(409, 'This vehicle is already assigned. Review a swap or end its current assignment first.');
    }
    desired.set(sourceVehicleId, { vehicle: target, driverId });
  }

  const aliases = new Set([...desired.keys()].map(id => roster.assets.get(id).trackerAlias).filter(Boolean));
  for (const alias of aliases) {
    const holders = drivers.filter(driver => driver.role === 'driver' && trackerAlias(driver.profile?.truckoomVehicleNo) === alias);
    if (holders.length > 1 || holders.some(driver => !participants.has(String(driver._id)))) {
      throw fleetError(409, 'A confirmed tracker has a conflicting driver mapping.');
    }
  }

  const driverStates = [...participants].sort(([a], [b]) => a.localeCompare(b)).map(([id, driver]) => {
    const alias = trackerAlias(driver.profile?.truckoomVehicleNo);
    if (alias && !aliases.has(alias)) throw fleetError(409, 'A driver still has a tracker outside this handover.');
    return [id, driver.isActive, alias];
  });
  const changes = [];
  const vehicleStates = [...desired].sort(([a], [b]) => a.localeCompare(b)).map(([id, { vehicle, driverId }]) => {
    const { vehicleClass, trackerAlias: alias } = roster.assets.get(id);
    const previousDriverId = driverSourceId(vehicle.assignedDriver);
    const head = heads.get(id);
    if (head && (head.change.driverId !== previousDriverId || head.change.vehicleClass !== vehicleClass
        || (previousDriverId && (head.change.trackerAlias !== alias
          || trackerAlias(participants.get(previousDriverId)?.profile?.truckoomVehicleNo) !== alias)))) {
      throw fleetError(409, 'The current Fleet or tracker mapping differs from the last saved pairing.');
    }
    if (!head || previousDriverId !== driverId) {
      changes.push({ sourceVehicleId: id, vehicleClass, trackerAlias: alias, previousDriverId, driverId });
    }
    return [id, vehicleClass, vehicle.status, previousDriverId, alias, head?.id ?? null];
  });
  if (!changes.length) throw fleetError(409, 'This pairing is already saved.');

  // The review commits the actual custody and tracker state, including each
  // asset's last receipt. A swap away and back still invalidates the old review.
  const fingerprint = digest([driverStates, vehicleStates]);
  return { changes, fingerprint };
}
