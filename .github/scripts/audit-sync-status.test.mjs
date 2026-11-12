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
  t.mock.method(fs, 'statfs', async directory => ({ bsize: 4096, bavail: directory === path.join(root, 'work') ? 123 : 456 }));
  const status = await readAuditSyncStatus({ appRoot, pm2Home, entry });
  assert.equal(status.host.workFreeDiskBytes, 123 * 4096);
  assert.equal(status.host.freeDiskBytes, 456 * 4096);
  assert.equal(status.worker.status, 'online');
  assert.equal(status.worker.restarts, 2);
  assert.equal(status.heartbeat.status, 'checking');
  assert.equal(status.heartbeat.replicaGcStatus, 'proof-stale');
  assert.equal(status.build.status, 'building');
  assert.equal(status.build.files['combined-reviews.private.json'].bytes, 13);
  assert.deepEqual(status.logs, { refreshPaused: 1, startupFailed: 0, memoryLimit: 0, retirementDeferred: 0, lastRetirementDeferredAttempts: null, lastAbandonedRetirement: null, other: 1 });
  const output = JSON.stringify(status);
  assert.ok(!output.includes('private-value') && !output.includes(appRoot));
});

test('status rejects a named worker pointing outside the fixed audit directory', async t => {
  const args = await fixture(t);
  args.entry.pm2_env.args[1] = path.join(args.appRoot, 'other/sync.json');
  await assert.rejects(readAuditSyncStatus(args), /reviewed audit worker/);
});

test('inventory identifies populated, protected, prepared and retired attempts without exposing payloads', async t => {
  const f = await fixture(t), parent = path.dirname(f.attempt);
  const id = n => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
  const write = (file, value) => fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
  const active = path.join(parent, id(1)), prepared = path.join(parent, id(2)), retired = path.join(parent, id(3));
  for (const directory of [active, prepared, retired]) {
    await fs.mkdir(path.join(directory, 'server-data'), { recursive: true, mode: 0o700 });
    await write(path.join(directory, 'accepted.private.json'), { collectorRevision: 123, private: 'private-value' });
    await write(path.join(directory, 'direct-seed.private.json'), { pointer: { generation: 'b'.repeat(64) } });
  }
  await write(path.join(f.root, 'work/current.private.json'), { privateRoot: path.join(active, 'server-data') });
  await write(path.join(prepared, 'retired-workspace.private.json'), { status: 'prepared' });
  await write(path.join(retired, 'retired-workspace.private.json'), { status: 'retired' });
  await write(path.join(f.attempt, 'abandoned-workspace.private.json'), { status: 'retired', private: 'private-value' });
  await fs.writeFile(path.join(f.attempt, 'interrupted.private.json'), 'private-value');
  await fs.writeFile(path.join(prepared, 'server-data', 'private-filename.json'), 'private-value');
  await fs.writeFile(path.join(f.pm2Home, 'logs/matter-driver-audit-sync-error.log'), '{"event":"audit-workspace-retirement-deferred","attempts":2}\n'
    +'{"event":"audit-workspace-abandoned-retired","attempts":1,"files":100,"bytes":123,"allocatedBytes":456,"freeDiskDeltaBytes":400}\n');
  const status = await readAuditSyncStatus(f);
  const attempts = new Map(status.attempts.summaries.map(item => [item.id, item]));
  assert.equal(status.attempts.observed, 4);
  assert.equal(attempts.get(id(1)).protected, true);
  assert.equal(attempts.get(id(2)).prepared, true);
  assert.equal(attempts.get(id(2)).accepted, true);
  assert.equal(attempts.get(id(2)).seed, true);
  assert.equal(attempts.get(id(2)).directories['server-data'].bytes, 13);
  assert.equal(attempts.get(id(3)).retired, true);
  assert.equal(attempts.get(f.attemptId).accepted, false);
  assert.equal(attempts.get(f.attemptId).abandonedRetired, true);
  assert.ok(attempts.get(f.attemptId).direct.bytes > 13);
  assert.equal(status.logs.retirementDeferred, 1);
  assert.equal(status.logs.lastRetirementDeferredAttempts, 2);
  assert.deepEqual(status.logs.lastAbandonedRetirement, { attempts: 1, files: 100, bytes: 123, allocatedBytes: 456, freeDiskDeltaBytes: 400 });
  assert.ok(!JSON.stringify(status).includes('private-filename') && !JSON.stringify(status).includes('private-value'));
});

test('inventory prioritizes old populated attempts and bounds how many it reports', async t => {
  const f = await fixture(t), parent = path.dirname(f.attempt);
  await fs.writeFile(path.join(f.attempt, 'old-build.private.json'), 'saved output');
  await fs.utimes(f.attempt, new Date(0), new Date(0));
  await Promise.all(Array.from({ length: 66 }, (_, index) => fs.mkdir(path.join(parent, `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`))));
  await fs.symlink(f.attempt, path.join(parent, '90000000-0000-4000-8000-000000000000'));
  const { attempts } = await readAuditSyncStatus(f);
  assert.equal(attempts.observed, 67);
  assert.equal(attempts.nonempty, 1);
  assert.equal(attempts.summaries.length, 64);
  assert.equal(attempts.omitted, 3);
  assert.equal(attempts.summaries[0].id, f.attemptId);
});
