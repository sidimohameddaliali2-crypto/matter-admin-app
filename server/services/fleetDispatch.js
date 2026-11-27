import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const roles = new Set(['super_admin', 'admin', 'manager', 'dispatcher']);
const objectId = /^[a-f0-9]{24}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const kinds = new Set(['assign', 'swap', 'end', 'correct']);
const classes = new Set(['bike', 'van', 'car', 'truck', 'other']);
const clockText = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const reviewLifetime = 10 * 60_000;
const pastWindow = 15 * 60_000;
const fleetPath = '/api/reporting/fleet-dispatch';
const failure = (status, message) => Object.assign(new Error(message), { status });
const unknown = () => failure(503, 'Vehicle save could not be confirmed. Retry this same request.');
const isSourceId = value => typeof value === 'string' && objectId.test(value);
const isClock = value => typeof value === 'string' && clockText.test(value) && Number.isFinite(Date.parse(value));

export function operatorAllowed(user, env) {
  const actor = String(user?._id ?? '');
  return env.MATTER_DISPATCH_FLEET_ENABLED === '1' && roles.has(user?.role)
    && objectId.test(actor) && Boolean(env.MATTER_DISPATCH_FLEET_OPERATORS?.split(',').some(id => id.trim() === actor));
}

function reviewSignature(secret, actorId, operationId, { kind, from, to, pairs, expected, expectedAssets }, expiresAt) {
  const fields = [actorId, operationId, kind, from, to,
    pairs.map(({ driverId, sourceVehicleId }) => [driverId, sourceVehicleId]), expected, expectedAssets];
  if (expiresAt !== null) fields.push(expiresAt);
  const version = expiresAt === null ? 'v1' : 'v2';
  return createHmac('sha256', secret).update(`matter-sidi-fleet-review-${version}\n`).update(JSON.stringify(fields)).digest('hex');
}

export function fleetReviewProof(secret, actorId, operationId, command, now = Date.now()) {
  const expiresAt = now + reviewLifetime;
  return `${expiresAt}.${reviewSignature(secret, actorId, operationId, command, expiresAt)}`;
}

export function fleetReviewExpiry(secret, actorId, operationId, command, proof) {
  const match = typeof proof === 'string' && /^(?:(\d{13})\.)?([a-f0-9]{64})$/.exec(proof);
  if (!match) return null;
  const expiresAt = match[1] === undefined ? null : Number(match[1]);
  const signed = reviewSignature(secret, actorId, operationId, command, expiresAt);
  if (!timingSafeEqual(Buffer.from(match[2], 'hex'), Buffer.from(signed, 'hex'))) return null;
  // Previously issued proofs have no expiry and can only recover a receipt.
  return expiresAt ?? 0;
}

function validCommand(command) {
  const { kind, from, to, pairs } = command ?? {};
  if (!kinds.has(kind) || !isClock(from) || (kind === 'end' && to !== null)
      || (to !== null && (!isClock(to) || Date.parse(to) <= Date.parse(from)))
      || !Array.isArray(pairs) || pairs.length !== (kind === 'swap' ? 2 : 1)) return false;
  return pairs.every(pair => isSourceId(pair?.driverId)
    && (kind === 'end' ? pair.sourceVehicleId === null : isSourceId(pair.sourceVehicleId)))
    && (kind !== 'swap' || (pairs[0].driverId !== pairs[1].driverId && pairs[0].sourceVehicleId !== pairs[1].sourceVehicleId));
}

function checkFirstSaveTime(command, now, expiresAt = Infinity) {
  if (now >= expiresAt) throw failure(422, 'This pairing review expired. Review the pairing again.');
  if (command.kind !== 'correct' && Date.parse(command.from) < now - pastWindow) {
    throw failure(422, 'Use an effective time within the last 15 minutes or a future time.');
  }
}

export async function dispatchFleet({ phase, operationId, command, reviewProof }, {
  actorId, secret, allowCorrection, checkRoster, send, clock = Date.now,
}) {
  if (!['review', 'commit'].includes(phase) || !validCommand(command)) {
    throw failure(400, 'Choose a driver, confirmed vehicle and effective time.');
  }
  if (command.kind === 'correct' && !allowCorrection) {
    throw failure(403, 'Historical corrections require an authorized administrator.');
  }
  const confirmRoster = async () => {
    if (!await checkRoster(command)) throw failure(422, command.kind === 'end'
      ? 'Choose a driver with a vehicle assignment to end.'
      : 'Choose an active driver and an available vehicle with a confirmed class.');
  };
  if (phase === 'review') {
    checkFirstSaveTime(command, clock());
    await confirmRoster();
    const data = await send({ phase, command, actorId });
    const id = randomUUID();
    return { ...data, operationId: id, reviewProof: fleetReviewProof(secret, actorId, id,
      { ...command, expected: data.expected, expectedAssets: data.expectedAssets }, clock()) };
  }

  if (typeof operationId !== 'string' || !uuid.test(operationId)) throw failure(400, 'Invalid pairing operation.');
  const expiresAt = fleetReviewExpiry(secret, actorId, operationId, command, reviewProof);
  if (expiresAt === null) throw failure(422, 'Review this pairing before saving it.');
  const request = { operationId, command, actorId };
  try {
    checkFirstSaveTime(command, clock(), expiresAt);
    await confirmRoster();
    checkFirstSaveTime(command, clock(), expiresAt);
  } catch (error) {
    // The original write may have succeeded before eligibility changed.
    const receipt = await send({ phase: 'receipt', ...request });
    if (receipt.state === 'saved') return receipt;
    throw error;
  }
  return send({ phase, ...request });
}

export function confirmedFleetVehicles(rows, registry) {
  const verifiedClass = new Map(registry.map(vehicle => [vehicle.sourceVehicleId, vehicle.vehicleClass]));
  return rows.filter(row => verifiedClass.has(String(row._id)) && row.type === verifiedClass.get(String(row._id)));
}

function validRoster(data) {
  const { vehicles, currentDriverIds } = data ?? {};
  return Array.isArray(vehicles) && vehicles.length <= 100
    && vehicles.every(vehicle => isSourceId(vehicle?.sourceVehicleId) && classes.has(vehicle.vehicleClass))
    && new Set(vehicles.map(vehicle => vehicle.sourceVehicleId)).size === vehicles.length
    && Array.isArray(currentDriverIds) && currentDriverIds.length <= 100 && currentDriverIds.every(isSourceId);
}

function targetOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.origin === value && !url.port && url.hostname.includes('.')) return value;
  } catch { /* Invalid configuration leaves the optional action unavailable. */ }
  return null;
}

export function fleetDispatchClient(env, { fetchImpl = fetch, clock = Date.now } = {}) {
  const origin = targetOrigin(env.MATTER_DISPATCH_FLEET_REPORTS_ORIGIN);
  const secret = env.MATTER_FLEET_LINK_SECRET;
  if (env.MATTER_DISPATCH_FLEET_ENABLED !== '1' || !origin
      || !/^[\x21-\x7e]{32,256}$/.test(secret ?? '')) return null;
  return async function send(request) {
    const body = JSON.stringify(request);
    const timestamp = String(Math.floor(clock() / 1000));
    const signature = createHmac('sha256', secret).update('matter-fleet-v1\n' + timestamp + '\n').update(body).digest('hex');
    let result;
    try {
      result = await fetchImpl(origin + fleetPath, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3500),
        headers: { 'content-type': 'application/json', 'x-matter-fleet-time': timestamp,
          'x-matter-fleet-signature': signature,
          ...(env.MATTER_DISPATCH_FLEET_VERCEL_BYPASS && {
            'x-vercel-protection-bypass': env.MATTER_DISPATCH_FLEET_VERCEL_BYPASS,
          }),
        },
        body,
      });
    } catch { throw unknown(); }
    if (!result.ok) {
      await result.body?.cancel().catch(() => {});
      if (result.status === 409) throw failure(409, 'The pairing changed. Review it before saving again.');
      if (request.phase !== 'receipt' && (result.status === 400 || result.status === 422)) {
        throw failure(422, request.command?.kind === 'end'
          ? 'No unique vehicle assignment covers this driver at the effective time.'
          : 'Choose a valid driver, confirmed vehicle and time.');
      }
      throw unknown();
    }
    try {
      const data = await result.json();
      if (request.phase === 'receipt' && data?.state === 'not-found') return data;
      if (['commit', 'receipt'].includes(request.phase)
          && (data?.state !== 'saved' || data.operationId !== request.operationId)) throw unknown();
      if (request.phase === 'review' && (!Array.isArray(data.expected) || !Array.isArray(data.expectedAssets)
          || !Array.isArray(data.current))) throw unknown();
      if (request.phase === 'options' && !validRoster(data)) throw unknown();
      return data;
    } catch { throw unknown(); }
  };
}
