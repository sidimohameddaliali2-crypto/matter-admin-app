import assert from 'node:assert/strict';
import test from 'node:test';
import { fleetDispatchClient, fleetReviewProof, operatorAllowed, validFleetReview } from './fleetDispatch.js';

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
  const proof = fleetReviewProof(secret, actorId, operation.operationId, command);
  assert.equal(validFleetReview(secret, actorId, operation.operationId, command, proof), true);
  assert.equal(validFleetReview(secret, actorId, 'different-operation', command, proof), false);
  assert.equal(validFleetReview(secret, 'other-user', operation.operationId, command, proof), false);
  assert.equal(validFleetReview(secret, actorId, operation.operationId, { ...command, to: null }, proof), false);
  assert.equal(validFleetReview(secret, actorId, operation.operationId, { ...command, expectedAssets: [] }, proof), false);
});
