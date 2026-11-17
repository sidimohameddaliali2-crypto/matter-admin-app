import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configureActivityHistoryAccess } from './activityDeployment.js';
import { hasActivityHistoryAccess } from '../observability/activityAccess.js';

test('release setup resolves the exact approved email to one active account without changing its permissions', async t => {
  const serverRoot = await mkdtemp(path.join(os.tmpdir(), 'activity-release-'));
  t.after(() => rm(serverRoot, { recursive: true, force: true }));
  const account = { _id: '111111111111111111111111', email: 'owner@example.invalid', role: 'admin', isActive: true, permissions: { users: false } };
  const before = JSON.stringify(account);
  const result = await configureActivityHistoryAccess({ serverRoot, emails: 'OWNER@example.invalid', findAccounts: async emails => { assert.deepEqual(emails, ['owner@example.invalid']); return [account]; } });
  const file = path.join(serverRoot, '.private/activity-history/readers.json');
  assert.equal(result.readers, 1);
  assert.equal(hasActivityHistoryAccess(account, { file }), true);
  assert.equal(hasActivityHistoryAccess({ _id: '222222222222222222222222', isActive: true, role: 'super_admin' }, { file }), false);
  assert.equal(JSON.stringify(account), before);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const raw = await readFile(file, 'utf8');
  assert.ok(!raw.includes('@'), 'Emails are resolved only during setup, not stored as runtime grants');
  await assert.rejects(configureActivityHistoryAccess({ serverRoot, emails: 'missing@example.invalid', findAccounts: async () => [] }), /approved active account/);
  assert.equal(await readFile(file, 'utf8'), raw, 'A failed resolution preserves existing access');
});
test('release setup fails closed for missing, duplicate, inactive or ambiguous account selections', async t => {
  const serverRoot = await mkdtemp(path.join(os.tmpdir(), 'activity-release-denied-'));
  t.after(() => rm(serverRoot, { recursive: true, force: true }));
  for (const emails of ['', 'invalid', 'a@example.invalid,a@example.invalid', 'a@example.invalid,b@example.invalid']) await assert.rejects(configureActivityHistoryAccess({ serverRoot, emails, findAccounts: async () => [] }));
  await assert.rejects(configureActivityHistoryAccess({ serverRoot, emails: 'a@example.invalid', findAccounts: async () => [{ _id: '111111111111111111111111', email: 'a@example.invalid', isActive: false }] }), /approved active account/);
});
