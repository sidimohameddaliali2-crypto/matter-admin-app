import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { createMenuSessionService, issueMenuSession, verifyMenuSession } from './menuCustomerAuth.js';

const key = 'fixture-menu-session-key-at-least-32-characters';
const menuId = '507f1f77bcf86cd799439012';
const previous = { jwt: process.env.JWT_SECRET, menu: process.env.MENU_CUSTOMER_AUTH_SECRET };
process.env.JWT_SECRET = key;
delete process.env.MENU_CUSTOMER_AUTH_SECRET;
test.after(() => {
  for (const [name, value] of [['JWT_SECRET', previous.jwt], ['MENU_CUSTOMER_AUTH_SECRET', previous.menu]]) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});
const limits = () => {
  const rows = new Map();
  return { findOneAndUpdate({ _id }, update) {
    const row = rows.get(_id) || { _id, count: 0 };
    row.count += update.$inc.count; rows.set(_id, row);
    const result = { ...row };
    return { lean: async () => result };
  } };
};
const nutrition = email => ({ customer_id: 'fixture-customer', customer_email: email });

test('accepted email-only policy issues a scoped session for a matching subscription without a code or email delivery', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('email-only sign-in must not send email'));
  let lookedUp;
  const service = createMenuSessionService({ limits: limits(), lookup: async email => { lookedUp = email; return nutrition(email); } });
  const result = await service.start(' CUSTOMER@example.invalid ', menuId);
  assert.equal(lookedUp, 'customer@example.invalid');
  assert.deepEqual(Object.keys(result).sort(), ['email', 'menuId', 'token']);
  const claims = verifyMenuSession(result.token);
  assert.equal(claims.email, 'customer@example.invalid');
  assert.equal(claims.menuId, menuId);
  assert.equal(claims.accessMethod, 'shared-link-email');
  assert.equal(claims.exp - claims.iat, 3600);
  // This establishes subscription matching, deliberately NOT email ownership.
});

test('unknown, mismatched and unavailable subscriptions fail without a session', async () => {
  for (const [lookup, statusCode] of [[async () => null, 404], [async () => nutrition('other@example.invalid'), 409], [async () => { throw new Error('fixture upstream outage'); }, 502]]) {
    const service = createMenuSessionService({ limits: limits(), lookup });
    await assert.rejects(service.start('customer@example.invalid', menuId), { statusCode });
  }
  await assert.rejects(createMenuSessionService({ limits: limits() }).start('invalid-email', menuId), { statusCode: 400 });
});

test('repeated opens are allowed while excessive requests are limited across workers', async () => {
  const counters = limits(); let clock = Date.now();
  const deps = { limits: counters, lookup: async email => nutrition(email), now: () => clock };
  const first = createMenuSessionService(deps); const second = createMenuSessionService(deps);
  for (let i = 0; i < 30; i++) await first.start('customer@example.invalid', menuId);
  await assert.rejects(second.start('customer@example.invalid', menuId), { statusCode: 429 });
  clock += 16 * 60 * 1000;
  assert.equal((await second.start('customer@example.invalid', menuId)).email, 'customer@example.invalid');
});

test('staff, partner, member, expired and modified tokens are not menu sessions', () => {
  for (const claims of [{ id: 'staff' }, { partnerId: 'partner' }, { memberId: 'member' }]) assert.throws(() => verifyMenuSession(jwt.sign(claims, key)), { statusCode: 401 });
  const valid = issueMenuSession('customer@example.invalid', menuId);
  assert.throws(() => verifyMenuSession(valid.slice(0, -8) + 'modified'), { statusCode: 401 });
  assert.throws(() => verifyMenuSession(jwt.sign({ purpose: 'menu-selection', accessMethod: 'shared-link-email', email: 'customer@example.invalid', menuId }, key, { audience: 'matter-menu-customer', issuer: 'matter-menu-auth', expiresIn: -1 })), { statusCode: 401 });
});

test('signing configuration fails closed and a dedicated key does not alter staff keys', () => {
  delete process.env.JWT_SECRET;
  assert.throws(() => issueMenuSession('customer@example.invalid', menuId), { statusCode: 503 });
  process.env.JWT_SECRET = 'legacy-staff-fixture';
  process.env.MENU_CUSTOMER_AUTH_SECRET = key;
  try {
    assert.equal(verifyMenuSession(issueMenuSession('customer@example.invalid', menuId)).email, 'customer@example.invalid');
    assert.equal(process.env.JWT_SECRET, 'legacy-staff-fixture');
  } finally { process.env.JWT_SECRET = key; delete process.env.MENU_CUSTOMER_AUTH_SECRET; }
});
