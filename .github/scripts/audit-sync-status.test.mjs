import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {readAuditSyncStatus,reclaimReportingMetadata,reclaimArchivedAuditCopies,offloadReportingBackup} from './audit-sync-status.mjs';

test('old workspace backup is removed only after every chunk has a verified private archive copy', async t => {
  const { root } = await fixture(t);
  const backup = path.join(root, 'backup.tar.gz');
  const content = Buffer.from('file contents of a fixture archive');
  await fs.writeFile(backup, content, { mode: 0o600 });
  const known = new Map();
  let fail = true, saved = null;
  async function verify(key, size, local) {
    if (fail && known.size === 1) throw Error('archive unavailable');
    const bytes = await local();
    assert.equal(bytes.length, size);
    assert.equal(key, createHash('sha256').update(bytes).digest('hex') + '.gz');
    known.set(key, bytes);
    return { verified: true, key, sha256: key.slice(0, -3) };
  }
  const publish = () => offloadReportingBackup({
    backup, maxChunkBytes: 10, verify, save: manifest => { saved = manifest; },
  });
  await assert.rejects(async () => publish(), /archive unavailable/);
  assert.equal(saved, null);
  assert.deepEqual(await fs.readFile(backup), content);
  fail = false;
  const result = await publish();
  assert.deepEqual(Buffer.concat(saved.chunks.map(ref => known.get(ref.key))), content);
  assert.equal(saved.sha256, createHash('sha256').update(content).digest('hex'));
  assert.equal(result.bytes, content.length);
  await assert.rejects(fs.stat(backup), {code: 'ENOENT'});
});

test('superseded scratch reclamation requires an exact private archive receipt', async t => {
  const { root, attempt } = await fixture(t);
  const receipts = path.join(root, 'archive-receipts');
  const data = path.join(attempt, 'server-data');
  await fs.mkdir(receipts, { mode: 0o700 });
  await fs.mkdir(data, { mode: 0o755 });
  await fs.chmod(data, 0o775);
  const originals = [Buffer.from('old verified object'), Buffer.from('old object without receipt')];
  const hashes = originals.map(bytes => createHash('sha256').update(bytes).digest('hex'));
  const names = hashes.map(hash => 'archive-' + hash + '.private.bin');
  for (const [i, name] of names.entries()) {
    await fs.writeFile(path.join(data, name), originals[i], { mode: 0o600 });
  }
  const manifest = Object.fromEntries(names.map((name, i) => [name, hashes[i]]));
  const key = hashes[0] + '.gz';
  await fs.writeFile(path.join(receipts, key + '.json'), JSON.stringify({
    target: 'matter-report-archive', key, sha256: hashes[0], bytes: originals[0].length, verified: true,
  }), { mode: 0o600 });
  const plan = await reclaimArchivedAuditCopies(data, receipts, manifest, false);
  assert.equal(plan.copies, 1);
  assert.ok(await fs.stat(path.join(data, names[0])));
  const applied = await reclaimArchivedAuditCopies(data, receipts, manifest, true);
  assert.equal(applied.copies, 1);
  await assert.rejects(fs.stat(path.join(data, names[0])), {code: 'ENOENT'});
  assert.ok(await fs.stat(path.join(data, names[1])));
});

test('reclaims only hash-verified reporting metadata copies when build space is short', async t => {
  const { root } = await fixture(t);
  const data = path.join(root, 'work/metadata');
  await fs.mkdir(data, { mode: 0o700 });
  const bytes = Buffer.from('saved catalog metadata');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const copy = path.join(data, digest + '.gz');
  const unrelated = path.join(data, 'private-review.json');
  const corrupt = path.join(data, 'b'.repeat(64) + '.gz');
  await Promise.all([copy, unrelated, corrupt].map(file => fs.writeFile(file, bytes, { mode: 0o600 })));
  await fs.symlink(copy, path.join(data, 'c'.repeat(64) + '.gz'));
  const floor = 1024 * 1024 * 1024;
  t.mock.method(fs, 'statfs', async () => ({bsize: 1, bavail: floor - 1}));
  const result = await reclaimReportingMetadata(path.join(root, 'work'));
  assert.equal(result.removed, 1);
  await assert.rejects(fs.stat(copy), {code: 'ENOENT'});
  assert.ok(await fs.stat(unrelated));
  assert.ok(await fs.stat(corrupt));
  assert.ok((await fs.lstat(path.join(data, 'c'.repeat(64) + '.gz'))).isSymbolicLink());
});

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
  assert.deepEqual(status.logs, { refreshPaused: 1, startupFailed: 0, memoryLimit: 0, retirementDeferred: 0, lastRetirementDeferredAttempts: null, lastAbandonedRetirement: null, lastArchiveCopyRetirement: null, other: 1 });
  const output = JSON.stringify(status);
  assert.ok(!output.includes('private-value') && !output.includes(appRoot));
});

test('status rejects a named worker pointing outside the fixed audit directory', async t => {
  const args = await fixture(t);
  args.entry.pm2_env.args[1] = path.join(args.appRoot, 'other/sync.json');
  await assert.rejects(readAuditSyncStatus(args), /reviewed audit worker/);
});

test('status exposes only validated capacity measurements for the current failure', async t => {
  const f = await fixture(t);
  const file = path.join(f.root, 'sync-status.private.json');
  const save = (status, capacity) => fs.writeFile(file, JSON.stringify({ status, errorCode: 'AUDIT_CAPACITY', capacity }), { mode: 0o600 });
  const capacity = { kind: 'build-disk', availableBytes: 120, requiredBytes: 200 };
  await save('capacity-blocked', { ...capacity, file: 'private-value' });
  assert.deepEqual((await readAuditSyncStatus(f)).heartbeat.capacity, capacity);
  await save('capacity-blocked', { ...capacity, availableBytes: -1 });
  assert.equal((await readAuditSyncStatus(f)).heartbeat.capacity, null);
  const fullDisk = { kind: 'build-disk', availableBytes: null, requiredBytes: null };
  await save('capacity-blocked', fullDisk);
  assert.deepEqual((await readAuditSyncStatus(f)).heartbeat.capacity, fullDisk);
  await save('ready', capacity);
  assert.equal((await readAuditSyncStatus(f)).heartbeat.capacity, null);
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
    +'{"event":"audit-workspace-abandoned-retired","attempts":1,"files":100,"bytes":123,"allocatedBytes":456,"freeDiskDeltaBytes":400}\n'
    +'{"event":"audit-workspace-archive-copies-retired","files":90,"bytes":120,"allocatedBytes":450,"freeDiskDeltaBytes":390}\n');
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
  assert.deepEqual(status.logs.lastArchiveCopyRetirement, { files: 90, bytes: 120, allocatedBytes: 450, freeDiskDeltaBytes: 390 });
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
