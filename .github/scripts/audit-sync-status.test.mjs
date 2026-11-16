import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {readAuditSyncStatus,reclaimReportingMetadata,reclaimArchivedAuditCopies,offloadReportingBackup,planRetiredReportingScratch,reclaimReplicatedBundle,reclaimPreviousRuntimeCopies,linkIdenticalBaselineArchive,compactRotatedReportingLogs,releaseClientBuildDependencies} from './audit-sync-status.mjs';

async function clientBuildFixture(t) {
  const { appRoot } = await fixture(t);
  const files = {
    'client/package.json': JSON.stringify({ scripts: { build: 'react-scripts build' } }),
    'client/package-lock.json': JSON.stringify({ packages: {} }),
    'server/package.json': JSON.stringify({ scripts: { start: 'node server.js' } }),
    'server/package-lock.json': JSON.stringify({ packages: {} }),
    'client/build/asset-manifest.json': JSON.stringify({ files: { 'main.js': '/static/js/main.js' } }),
    'client/build/index.html': '<script src="/static/js/main.js"></script>',
    'client/build/static/js/main.js': 'window.staticBuild=true;',
    'client/node_modules/build-only/index.js': 'disposable builder package',
    'server/node_modules/runtime/index.js': 'required server package',
    'server/uploads/original.jpg': 'original photo bytes',
    'server/.private/review.json': 'original review event',
  };
  for (const [name, bytes] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(appRoot, name)), { recursive: true });
    await fs.writeFile(path.join(appRoot, name), bytes);
  }
  return { appRoot, files, dependencies: path.join(appRoot, 'client/node_modules') };
}

test('client dependency release preserves the complete static build, runtime, photos and reviews and can retry', async t => {
  const { appRoot, dependencies, files } = await clientBuildFixture(t);
  let healthChecks = 0;
  const run = apply => releaseClientBuildDependencies({ appRoot, apply, verifyHealth: async () => { healthChecks++; } });
  const plan = await run(false);
  assert.ok(plan.allocatedBytes > 0);
  assert.ok(await fs.stat(dependencies));
  assert.equal(healthChecks, 0);
  const result = await run(true);
  assert.equal(result.preservedSha256, plan.preservedSha256);
  assert.equal(healthChecks, 2);
  await assert.rejects(fs.stat(dependencies), { code: 'ENOENT' });
  for (const [name, bytes] of Object.entries(files)) {
    if (!name.startsWith('client/node_modules/')) assert.equal(await fs.readFile(path.join(appRoot, name), 'utf8'), bytes);
  }
  assert.equal((await run(true)).allocatedBytes, 0);
});

test('client dependency release refuses a missing build asset, linked runtime or failed health before deleting', async t => {
  for (const reason of ['missing-asset', 'linked-runtime', 'failed-health', 'linked-client']) {
    await t.test(reason, async t => {
      const { appRoot, dependencies } = await clientBuildFixture(t);
      if (reason === 'missing-asset') await fs.unlink(path.join(appRoot, 'client/build/static/js/main.js'));
      if (reason === 'linked-runtime') await fs.writeFile(path.join(appRoot, 'server/package-lock.json'), JSON.stringify({ packages: { linked: { link: true } } }));
      if (reason === 'linked-client') {
        await fs.rename(dependencies, dependencies + '-retained');
        await fs.symlink(dependencies + '-retained', dependencies);
      }
      await assert.rejects(releaseClientBuildDependencies({ appRoot, apply: true,
        verifyHealth: async () => { if (reason === 'failed-health') throw Error('health unavailable'); } }));
      assert.equal(await fs.readFile(path.join(dependencies, 'build-only/index.js'), 'utf8'), 'disposable builder package');
    });
  }
});

test('closed rotated logs keep exact bytes and never match an active supervisor path', async t => {
  const {root} = await fixture(t);
  const directory = path.join(root,'rotated-logs');
  await fs.mkdir(directory,{mode:0o700});
  const source = path.join(directory,'matter-driver-audit-sync-out__2026-11-13_06-00-00.log');
  const contents = Buffer.alloc(128*1024,86);
  await fs.writeFile(source,contents,{mode:0o600});
  const old = new Date(Date.now()-48*60*60*1000);
  await fs.utimes(source,old,old);
  const run = (apply,active=new Set()) => compactRotatedReportingLogs({directory,active,apply});
  assert.equal((await run(false)).files,1);
  assert.equal((await run(true,new Set([source]))).files,0);
  assert.equal((await run(true)).files,1);
  await assert.rejects(fs.stat(source),{code:'ENOENT'});
  assert.deepEqual(gunzipSync(await fs.readFile(source+'.verified.gz')),contents);
  assert.equal((await run(true)).files,0);
});

test('baseline archive relink leaves both exact paths readable and skips unbound data', async t => {
  const {root, attempt} = await fixture(t);
  const baseline = path.join(root,'baseline'), current = path.join(attempt,'server-data');
  await Promise.all([baseline,current].map(file => fs.mkdir(file, {mode:0o700})));
  const content = Buffer.from('retained compressed archive object');
  const sha256 = createHash('sha256').update(content).digest('hex'), name = 'archive-'+sha256+'.private.bin';
  const source = path.join(current,name), target = path.join(baseline,name);
  for (const file of [source, target]) await fs.writeFile(file, content, {mode:0o600});
  const matches = {[name]:sha256};
  const run = (apply, activeFiles=matches) => linkIdenticalBaselineArchive({
    baseline, current, baselineFiles:matches, activeFiles, apply,
  });
  assert.equal((await run(true, {})).linked, 0);
  assert.equal((await run(false)).linked, 1);
  assert.notEqual((await fs.stat(source)).ino, (await fs.stat(target)).ino);
  await fs.writeFile(target, Buffer.alloc(content.length));
  await assert.rejects(() => run(true), /archive hash mismatch/);
  assert.notEqual((await fs.stat(source)).ino, (await fs.stat(target)).ino);
  await fs.writeFile(target, content);
  assert.equal((await run(true)).linked, 1);
  assert.equal((await fs.stat(source)).ino, (await fs.stat(target)).ino);
  assert.equal((await run(true)).linked, 0);
  await fs.unlink(source);
  assert.deepEqual(await fs.readFile(target), content);
});

test('previous local runtime is reclaimed only when its exact bytes are protected in both stores', async t => {
  const { root, attempt } = await fixture(t);
  const directory = path.join(attempt, 'server-data'), receipts = path.join(root, 'archive-receipts');
  await Promise.all([directory, receipts].map(file => fs.mkdir(file, {mode: 0o700})));
  const name = 'browser-data.private.json.gz', file = path.join(directory, name);
  const bytes = Buffer.from('complete previous runtime bytes');
  const sha256 = createHash('sha256').update(bytes).digest('hex'), key = sha256 + '.gz';
  const reference = {version:1, domain:'previewRuntime', path:name, size:bytes.length, sha256,
    chunks:[{sha256, size:bytes.length, offset:0}]};
  const receipt = path.join(receipts, key + '.json');
  await fs.writeFile(file, bytes, {mode: 0o600});
  const verify = async () => fs.writeFile(receipt, JSON.stringify({
    target:'matter-report-archive', key, sha256, bytes:bytes.length, verified:true,
  }), {mode: 0o600});
  const run = (apply, readFile = async ref => { assert.equal(ref, reference); return bytes; }) =>
    reclaimPreviousRuntimeCopies({directory, receipts, files:{[name]:reference},
      manifestFiles:{[name]:sha256}, readFile, apply});
  assert.equal((await run(true)).removed, 0);
  await verify();
  const shared = path.join(root, 'active-copy');
  await fs.link(file, shared);
  assert.equal((await run(true)).removed, 0);
  await fs.unlink(shared);
  assert.equal((await run(false)).removed, 1);
  await assert.rejects(() => run(true, async () => Buffer.alloc(bytes.length)), /replica readback/);
  assert.deepEqual(await fs.readFile(file), bytes);
  assert.equal((await run(true)).removed, 1);
  await assert.rejects(fs.stat(file), {code:'ENOENT'});
});

test('active build staging cache only reclaims bytes verified in Mongo and the private archive', async t => {
  const { root, attempt } = await fixture(t);
  const bundle = path.join(attempt, 'audit-objects');
  const receipts = path.join(root, 'archive-receipts');
  await Promise.all([bundle, receipts].map(file => fs.mkdir(file, {mode: 0o700})));
  const body = Buffer.from('exact selected report object');
  const sha256 = createHash('sha256').update(body).digest('hex');
  const key = sha256 + '.gz', file = path.join(bundle, key);
  const write = (target, value) => fs.writeFile(target, value, {mode: 0o600});
  await write(file, body);
  await write(path.join(receipts, key + '.json'), JSON.stringify({
    target: 'matter-report-archive', key, sha256, bytes: body.length, verified: true,
  }));
  const ref = {sha256, size: body.length, chunks: [{sha256, size: body.length, offset: 0}]};
  const read = async(_key, {maxBytes}) => { assert.equal(maxBytes, body.length); return [body]; };
  const make = (skip, apply, replicaRead = read) => reclaimReplicatedBundle({
    bundle, receipts, references: [ref], skip, replicaRead, apply,
  });
  assert.equal((await make(new Set([key]), true)).removed, 0);
  assert.equal((await make(new Set(), false)).removed, 1);
  assert.ok(await fs.stat(file));
  await assert.rejects(() => make(new Set(), true, async() => [Buffer.alloc(body.length)]), /replica readback/);
  assert.ok(await fs.stat(file));
  assert.equal((await make(new Set(), true)).removed, 1);
  await assert.rejects(fs.stat(file), {code: 'ENOENT'});
});

test('retired scratch offload selects exclusive files inside only terminal abandoned attempts', async t => {
  const { root, attempt } = await fixture(t);
  const work = path.join(root, 'work');
  const write = (file, value) => fs.writeFile(file, value, { mode: 0o600 });
  await write(path.join(attempt, 'abandoned-workspace.private.json'), JSON.stringify({
    version: 1, kind: 'abandoned', status: 'retired', manifestSha256: null,
  }));
  const generated = path.join(attempt, 'combined-reviews.private.json.retained.gz');
  await write(generated, Buffer.alloc(2 * 1024 * 1024, 37));
  await write(path.join(attempt, 'operator-note.private.json'), Buffer.alloc(2 * 1024 * 1024, 40));
  const find = protectedRoots => planRetiredReportingScratch(work, protectedRoots, null);
  assert.equal((await find([])).files.length, 1);
  assert.equal((await find([path.join(attempt, 'server-data')])).files.length, 0);
  await fs.link(generated, path.join(attempt, 'another-copy.private.gz'));
  assert.equal((await find([])).files.length, 0);
});

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
  await assert.rejects(() => offloadReportingBackup({
    backup, expectedBytes:content.length+1, verify, save:()=>assert.fail('Mismatched backup can never be saved'),
  }), /Unverified retained reporting backup/);
  assert.equal(known.size, 0);
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
