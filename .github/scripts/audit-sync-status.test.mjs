import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {readAuditSyncStatus} from './audit-sync-status.mjs';

async function fixture(t) {
  const appRoot = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'audit-status-'));
  t.after(() => fs.rm(appRoot, { recursive: true, force: true }));
  const root = path.join(appRoot, 'server/.private/driver-audits', 'a'.repeat(64));
  const attemptId = '10000000-0000-4000-8000-000000000000';
  const attempt = path.join(root, 'work/attempts', attemptId);
  const pm2Home = path.join(appRoot, 'pm2');
  await fs.mkdir(attempt, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(pm2Home, 'logs'), { recursive: true, mode: 0o700 });
  const entry = {
    name: 'matter-driver-audit-sync', pid: 123,
    pm2_env: { pm_exec_path: path.join(appRoot, 'server/scripts/driverAuditSync.js'), pm_cwd: path.join(appRoot, 'server'),
      args: ['--config', path.join(root, 'sync.json')], status: 'online', restart_time: 2, env: { SECRET: 'private-value' } },
    monit: { memory: 4096, cpu: 12 },
  };
  return { appRoot, root, attemptId, attempt, pm2Home, entry };
}

test('status reports bounded build progress and omits private values and paths', async t => {
  const { appRoot, root, attemptId, attempt, pm2Home, entry } = await fixture(t);
  const write = (file, value) => fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
  await write(path.join(root, 'sync-status.private.json'), { status: 'checking', replicaGcStatus: 'proof-stale', checkedAt: '2026-11-12T14:53:31Z', private: 'private-value' });
  await write(path.join(root, 'work/status.private.json'), { status: 'building', id: attemptId, startedAt: '2026-11-12T14:53:31Z' });
  await fs.writeFile(path.join(attempt, 'combined-reviews.private.json'), 'private-value');
  await fs.writeFile(path.join(pm2Home, 'logs/matter-driver-audit-sync-error.log'), 'private-value\nDriver audit sync paused this refresh. See private sync status.\n');
  const status = await readAuditSyncStatus({ appRoot, pm2Home, entry });
  assert.equal(status.worker.status, 'online');
  assert.equal(status.worker.restarts, 2);
  assert.equal(status.heartbeat.status, 'checking');
  assert.equal(status.heartbeat.replicaGcStatus, 'proof-stale');
  assert.equal(status.build.status, 'building');
  assert.equal(status.build.files['combined-reviews.private.json'].bytes, 13);
  assert.deepEqual(status.logs, { refreshPaused: 1, startupFailed: 0, memoryLimit: 0, other: 1 });
  const output = JSON.stringify(status);
  assert.ok(!output.includes('private-value') && !output.includes(appRoot) && !output.includes(attemptId));
});

test('status rejects a named worker pointing outside the fixed audit directory', async t => {
  const args = await fixture(t);
  args.entry.pm2_env.args[1] = path.join(args.appRoot, 'other/sync.json');
  await assert.rejects(readAuditSyncStatus(args), /reviewed audit worker/);
});
