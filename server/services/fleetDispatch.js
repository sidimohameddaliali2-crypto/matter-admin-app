import { createHmac, timingSafeEqual } from 'node:crypto';

const roles = new Set(['super_admin', 'admin', 'manager', 'dispatcher']);
const objectId = /^[a-f0-9]{24}$/;
const fleetPath = '/api/reporting/fleet-dispatch';

export function operatorAllowed(user, env) {
  const actor = String(user?._id ?? '');
  return env.MATTER_DISPATCH_FLEET_ENABLED === '1' && roles.has(user?.role)
    && objectId.test(actor) && Boolean(env.MATTER_DISPATCH_FLEET_OPERATORS?.split(',').some(id => id.trim() === actor));
}

export function fleetReviewProof(secret, actorId, operationId, { kind, from, to, pairs, expected, expectedAssets }) {
  const fields = [actorId, operationId, kind, from, to,
    pairs.map(({ driverId, sourceVehicleId }) => [driverId, sourceVehicleId]), expected, expectedAssets];
  return createHmac('sha256', secret).update('matter-sidi-fleet-review-v1\n').update(JSON.stringify(fields)).digest('hex');
}

export function validFleetReview(secret, actorId, operationId, command, proof) {
  if (typeof proof !== 'string' || !/^[a-f0-9]{64}$/.test(proof)) return false;
  return timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(fleetReviewProof(secret, actorId, operationId, command), 'hex'));
}

function targetOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.origin === value && !url.port && url.hostname.includes('.')) return value;
  } catch { /* Invalid configuration leaves the optional action unavailable. */ }
  return null;
}

const failure = (status, message) => Object.assign(new Error(message), { status });
const unknown = () => failure(503, 'Vehicle save could not be confirmed. Retry this same request.');

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
      if (result.status === 400 || result.status === 422) throw failure(422, 'Choose a valid driver, confirmed vehicle and time.');
      throw unknown();
    }
    try {
      const data = await result.json();
      if (request.phase === 'commit' && (data.state !== 'saved' || data.operationId !== request.operationId)) throw unknown();
      if (request.phase === 'review' && (!Array.isArray(data.expected) || !Array.isArray(data.expectedAssets)
          || !Array.isArray(data.current))) throw unknown();
      return data;
    } catch { throw unknown(); }
  };
}
