import test from 'node:test';
import assert from 'node:assert/strict';
import { driverResponse, staffResponse, hasStaffPermission, canManageStaffTarget } from './staffAccessPolicy.js';

test('operational driver responses never include private HR or authentication fields', () => {
  const record = { _id: 'driver', email: 'fixture@example.com', password: 'hash', pushTokens: [{ token: 'secret' }], sessionVersion: 8,
    futureSecret: 'secret', location: { latitude: 1 }, profile: { firstName: 'Driver', nationalId: 'private', baseSalary: 9000, deductions: [], futureSecret: 'private' } };
  for (const role of ['driver', 'viewer', 'kitchen', 'dispatcher', 'manager']) {
    const result = driverResponse(record, { role });
    assert.deepEqual(result.profile, { firstName: 'Driver' });
    for (const key of ['password', 'pushTokens', 'sessionVersion', 'futureSecret', 'location']) assert.equal(result[key], undefined);
  }
  assert.equal(driverResponse(record, { role: 'admin' }).profile.nationalId, 'private');
  assert.equal(driverResponse(record, { role: 'admin', permissionsConfigured: true, permissions: { drivers: false } }).profile.nationalId, undefined);
  const staff = staffResponse(record);
  for (const key of ['password', 'pushTokens', 'sessionVersion', 'futureSecret', 'location']) assert.equal(staff[key], undefined);
});
test('effective defaults, explicit denials, and super-admin target boundary are respected', () => {
  assert.equal(hasStaffPermission({ role: 'dispatcher' }, 'deliveries'), true);
  assert.equal(hasStaffPermission({ role: 'admin', permissionsConfigured: true, permissions: { users: false } }, 'users'), false);
  assert.equal(canManageStaffTarget({ role: 'admin' }, { role: 'super_admin' }), false);
  assert.equal(canManageStaffTarget({ role: 'super_admin' }, { role: 'super_admin' }), true);
});
