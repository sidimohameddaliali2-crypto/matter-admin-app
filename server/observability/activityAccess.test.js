import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { hasActivityHistoryAccess, requireActivityHistoryReader } from './activityAccess.js';

test('history is restricted to the configured active account, with no role or email bypass', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'activity-reader-policy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'readers.json');
  const approved = '111111111111111111111111';
  const other = '222222222222222222222222';
  assert.equal(hasActivityHistoryAccess({ _id: approved, isActive: true }, { file }), false);
  await writeFile(file, JSON.stringify({ version: 1, readerIds: [approved] }), { mode: 0o600 });
  for (const role of ['admin', 'super_admin', 'manager']) {
    assert.equal(hasActivityHistoryAccess({ _id: approved, isActive: true, role }, { file }), true);
    assert.equal(hasActivityHistoryAccess({ _id: other, isActive: true, role, email: 'approved@example.invalid', canViewActivityHistory: true }, { file }), false);
  }
  assert.equal(hasActivityHistoryAccess({ _id: approved, isActive: false }, { file }), false);
  assert.equal(hasActivityHistoryAccess(null, { file }), false);
  await writeFile(file, JSON.stringify({ version: 1, readerIds: [approved, other] }));
  assert.equal(hasActivityHistoryAccess({ _id: approved, isActive: true }, { file }), false, 'The release permits one reader only');
  await writeFile(file, JSON.stringify({ version: 1, readerIds: [other] }));
  assert.equal(hasActivityHistoryAccess({ _id: approved, isActive: true }, { file }), false, 'Revocation takes effect on the next check');
  await chmod(file, 0o644);
  assert.equal(hasActivityHistoryAccess({ _id: other, isActive: true }, { file }), false, 'A publicly readable configuration is rejected');
});

test('reader middleware rejects an unapproved super-admin and missing authentication', () => {
  const result = [];
  const res = { status(code) { result.push(code); return this; }, json(body) { result.push(body); } };
  requireActivityHistoryReader({ user: { _id: '333333333333333333333333', isActive: true, role: 'super_admin' } }, res, () => assert.fail('No role shortcut'));
  assert.equal(result[0], 403);
  result.length = 0;
  requireActivityHistoryReader({}, res, () => assert.fail('Authentication is required'));
  assert.equal(result[0], 401);
});
