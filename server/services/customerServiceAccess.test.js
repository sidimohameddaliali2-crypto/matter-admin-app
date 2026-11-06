import test from 'node:test';
import assert from 'node:assert/strict';
import { getServiceCapabilities, assertServiceRecordAccess } from './customerServicePolicy.js';
const user = { _id: 'a', role: 'admin', isActive: true };
const profile = { userId: 'a', enabled: true, mode: 'reviewer' };
test('generic administrators and page permission alone grant no service access', () => {
  assert.equal(getServiceCapabilities(user, null).view, false);
  assert.equal(getServiceCapabilities({ ...user, permissions: { customer_service: true } }, null).supervise, false);
});
test('membership grants bounded review capability and disabled identities are denied', () => {
  assert.deepEqual(getServiceCapabilities(user, profile), { view: true, review: true, supervise: false, workActions: true, setup: false });
  for (const [u, p] of [[{ ...user, isActive: false }, profile], [user, { ...profile, enabled: false }], [user, { ...profile, userId: 'b' }]]) {
    assert.equal(getServiceCapabilities(u, p).view, false);
  }
});
test('a reviewer cannot inspect another assignment or reassign their own', () => {
  assert.throws(() => assertServiceRecordAccess({ actor: user, profile, record: { reviewerId: 'b' }, operation: 'review' }), /assigned/);
  assert.throws(() => assertServiceRecordAccess({ actor: user, profile, record: { reviewerId: 'a' }, operation: 'reassign' }), /supervisor/i);
  assert.equal(assertServiceRecordAccess({ actor: user, profile, record: { reviewerId: 'a' }, operation: 'review' }), true);
});
test('supervisors inspect team work, while super_admin setup does not imply data access', () => {
  assert.equal(assertServiceRecordAccess({ actor: user, profile: { ...profile, mode: 'supervisor' }, record: { reviewerId: 'b' }, operation: 'read' }), true);
  const caps = getServiceCapabilities({ ...user, role: 'super_admin' }, null);
  assert.equal(caps.setup, true);
  assert.equal(caps.view, false);
});
test('driver and portal identities cannot become service members through a forged profile', () => {
  for (const role of ['driver', 'partner', 'member', 'yellowblock_user']) assert.equal(getServiceCapabilities({ ...user, role }, profile).view, false);
});
