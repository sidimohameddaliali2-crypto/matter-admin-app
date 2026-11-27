import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmedFleetVehicles, dispatchFleet, fleetDispatchClient, fleetReviewExpiry, fleetReviewProof, operatorAllowed } from './fleetDispatch.js';

const actorId = 'a'.repeat(24);
const command = {
  kind: 'assign', from: '2026-11-26T08:00:00+04:00', to: '2026-11-26T12:00:00+04:00',
  pairs: [{ driverId: 'b'.repeat(24), sourceVehicleId: 'c'.repeat(24) }], expected: [],
  expectedAssets: [{ id: '00000000-0000-4000-8000-000000000001', confirmedAt: '2026-11-26T07:20:00.123456+04:00' }],
};
const operation = {
  phase: 'commit', operationId: 'aaaa1234-2222-4333-8333-bbbbbbbbbbbb', actorId, command,
};
const env = {
  MATTER_DISPATCH_FLEET_ENABLED: '1', MATTER_DISPATCH_FLEET_OPERATORS: actorId,
  MATTER_DISPATCH_FLEET_REPORTS_ORIGIN: 'https://reports-staging.example.com',
  MATTER_FLEET_LINK_SECRET: 'qa-only-'.repeat(5),
};
const now = Date.parse('2026-11-27T00:05:00+04:00');
const current = { ...command, from: '2026-11-26T23:55:00+04:00', to: null };
const receipt = { state: 'saved', operationId: operation.operationId };
const result = { expected: current.expected, expectedAssets: current.expectedAssets, current: [] };
const stale = { ...current, from: '2026-11-26T23:49:59.999+04:00' };

function fixture(options = {}) {
  const phases = [];
  const secret = env.MATTER_FLEET_LINK_SECRET;
  const deps = {
    actorId, secret, allowCorrection: false, clock: () => now,
    checkRoster: async () => true,
    send: async request => {
      phases.push(request);
      if (request.phase === 'review') return result;
      if (request.phase === 'receipt') return { state: 'not-found' };
      return receipt;
    },
    ...options,
  };
  const withProof = (request, issuedAt = now) => ({
    ...operation,
    command: request,
    reviewProof: fleetReviewProof(secret, actorId, operation.operationId, request, issuedAt),
  });
  return { phases, deps, withProof };
}

test('uses an explicit allowlist for dispatch roles without granting any new existing role', () => {
  assert.equal(operatorAllowed({ _id: actorId, role: 'dispatcher' }, env), true);
  assert.equal(operatorAllowed({ _id: actorId, role: 'viewer' }, env), false);
  assert.equal(operatorAllowed({ _id: 'd'.repeat(24), role: 'admin' }, env), false);
  assert.equal(operatorAllowed({ _id: actorId, role: 'dispatcher' }, {}), false);
});

test('sends one signed request per action and preserves the same operation ID for a lost response', async () => {
  const requests = [];
  const client = fleetDispatchClient(env, {
    clock: () => 1795750000000,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (requests.length === 1) throw Error('connection ended after commit');
      return Response.json({ state: 'saved', operationId: operation.operationId });
    },
  });
  await assert.rejects(client(operation), { status: 503 });
  assert.equal(requests.length, 1);
  assert.equal((await client(operation)).operationId, operation.operationId);
  assert.deepEqual(requests.map(r => JSON.parse(r.options.body)), [operation, operation]);
  assert.equal(requests[0].url, env.MATTER_DISPATCH_FLEET_REPORTS_ORIGIN + '/api/reporting/fleet-dispatch');
  assert.match(requests[0].options.headers['x-matter-fleet-signature'], /^[a-f0-9]{64}$/);
  assert.equal(requests[0].options.redirect, 'error');
});

test('the review permits one operation for that actor and that exact pairing', () => {
  const secret = env.MATTER_FLEET_LINK_SECRET;
  const proof = fleetReviewProof(secret, actorId, operation.operationId, command, now);
  const expiry = (request, operator = actorId, id = operation.operationId, token = proof) =>
    fleetReviewExpiry(secret, operator, id, request, token);
  assert.equal(expiry(command), now + 600_000);
  assert.equal(expiry(command, actorId, 'different-operation'), null);
  assert.equal(expiry(command, 'other-user'), null);
  assert.equal(expiry({ ...command, from: current.from }), null);
  assert.equal(expiry({ ...command, to: null }), null);
  assert.equal(expiry({ ...command, pairs: [{ ...command.pairs[0], sourceVehicleId: 'd'.repeat(24) }] }), null);
  assert.equal(expiry({ ...command, expected: [operation.operationId] }), null);
  assert.equal(expiry({ ...command, expectedAssets: [] }), null);
  assert.equal(expiry(command, actorId, operation.operationId, proof.replace(String(now + 600_000), String(now + 700_000))), null);
});

test('the first save uses a 15-minute epoch window across midnight and accepts future times', async () => {
  const cutoff = { ...current, from: '2026-11-26T23:50:00+04:00' };
  const future = { ...current, from: '2026-11-30T08:00:00+04:00' };
  const { phases, deps, withProof } = fixture();
  for (const kind of ['assign', 'swap', 'end']) {
    const pairs = kind === 'swap' ? [...current.pairs, { driverId: 'd'.repeat(24), sourceVehicleId: 'e'.repeat(24) }]
      : kind === 'end' ? [{ driverId: current.pairs[0].driverId, sourceVehicleId: null }] : current.pairs;
    const build = input => ({
      ...input, kind, pairs,
      expected: kind === 'end' ? [operation.operationId] : [],
      expectedAssets: kind === 'end' ? [] : kind === 'swap'
        ? [...input.expectedAssets, { ...input.expectedAssets[0], id: '00000000-0000-4000-8000-000000000002' }]
        : input.expectedAssets,
    });
    await assert.rejects(dispatchFleet({ phase: 'review', command: build(stale) }, deps), { status: 422 });
    await assert.rejects(dispatchFleet(withProof(build(stale)), deps), { status: 422 });
    assert.equal(phases.at(-1).phase, 'receipt');
    for (const allowed of [cutoff, future]) {
      assert.deepEqual(await dispatchFleet(withProof(build(allowed)), deps), receipt);
      assert.equal(phases.at(-1).phase, 'commit');
      assert.equal(phases.at(-1).expiresAt, now + 600_000);
    }
  }
  const closed = { ...cutoff, to: '2026-11-26T23:55:00+04:00' };
  await assert.rejects(dispatchFleet(withProof(closed), deps), { status: 422 });
  assert.equal(phases.at(-1).phase, 'receipt');
  assert.equal('expiresAt' in phases.at(-1), false);
  const historical = { ...stale, kind: 'correct' };
  await assert.rejects(dispatchFleet(withProof(historical), deps), { status: 403 });
  assert.deepEqual(await dispatchFleet(withProof(historical), { ...deps, allowCorrection: true }), receipt);
});

test('a stale or newly ineligible retry looks up the exact prior receipt and cannot write', async () => {
  const sent = [];
  let eligible = true;
  let serverNow = now;
  const { deps, withProof } = fixture({
    clock: () => serverNow,
    checkRoster: async () => eligible,
    send: async request => {
      sent.push(request);
      if (request.phase === 'commit') throw Object.assign(new Error('Lost response'), { status: 503 });
      return receipt;
    },
  });
  const request = withProof(current);
  await assert.rejects(dispatchFleet(request, deps), { status: 503 });
  eligible = false;
  assert.deepEqual(await dispatchFleet(request, deps), receipt);
  serverNow += 600_000;
  assert.deepEqual(await dispatchFleet(request, deps), receipt);
  const saving = { phase: 'commit', actorId, operationId: operation.operationId, command: current };
  const lookup = { ...saving, phase: 'receipt' };
  assert.deepEqual(sent, [{ ...saving, expiresAt: now + 600_000 }, lookup, lookup]);
});

test('an expired review without a receipt cannot save and an uncertain lookup preserves retry', async () => {
  const { phases, deps, withProof } = fixture();
  assert.deepEqual(await dispatchFleet(withProof(current, now - 599_999), deps), receipt);
  const request = withProof(current, now - 600_000);
  await assert.rejects(dispatchFleet(request, deps), { status: 422 });
  assert.deepEqual(phases.map(request => request.phase), ['commit', 'receipt']);
  const uncertain = { ...deps, send: async () => { throw Object.assign(new Error('Unconfirmed'), { status: 503 }); } };
  await assert.rejects(dispatchFleet(request, uncertain), { status: 503 });
  await assert.rejects(dispatchFleet({ ...request, command: { ...current, to: command.to } }, deps), { status: 400 });
  await assert.rejects(dispatchFleet({ ...request, command: { ...current, to: '2026-11-28T12:00:00+04:00' } }, deps), { status: 422 });
  assert.equal(phases.length, 2);
});

test('the roster only accepts a matching verified vehicle class for immutable source IDs', () => {
  const van = { _id: 'c'.repeat(24), type: 'van' };
  const changed = { _id: 'd'.repeat(24), type: 'van' };
  const unverified = { _id: 'e'.repeat(24), type: 'bike' };
  assert.deepEqual(confirmedFleetVehicles([van, changed, unverified], [
    { sourceVehicleId: van._id, vehicleClass: 'van' },
    { sourceVehicleId: changed._id, vehicleClass: 'bike' },
  ]), [van]);
});

test('signed receipt lookup distinguishes absent, mismatched and uncertain results', async () => {
  const lookup = { ...operation, phase: 'receipt' };
  const fetchReceipt = response => fleetDispatchClient(env, {
    clock: () => now,
    fetchImpl: async (_url, { body, headers }) => {
      assert.deepEqual(JSON.parse(body), lookup);
      assert.match(headers['x-matter-fleet-signature'], /^[a-f0-9]{64}$/);
      return response;
    },
  })(lookup);
  assert.deepEqual(await fetchReceipt(Response.json({ state: 'not-found' })), { state: 'not-found' });
  assert.deepEqual(await fetchReceipt(Response.json(receipt)), receipt);
  await assert.rejects(fetchReceipt(Response.json({ state: 'saved', operationId: 'other' })), { status: 503 });
  await assert.rejects(fetchReceipt(new Response(null, { status: 409 })), { status: 409 });
  await assert.rejects(fetchReceipt(new Response(null, { status: 503 })), { status: 503 });
});
