import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import dotenv from '../../server/node_modules/dotenv/lib/main.js';
import { readPrivateDriverAuditSource, requirePrivateDriverAuditSourceDirectory } from '../../server/services/driverAuditSource.js';
import { transitionDriverAuditBuilder, driverAuditBuilderConfigGuardVersion } from '../../server/services/driverAuditBuilderTransition.js';
import { readDriverAuditImportRows } from '../../server/services/driverAuditLiveImport.js';
import { verifyAuditBuilder } from '../../server/vendor/driver-audits/integration/cloud/driver-audit-handoff.mjs';
import { acquireWorkerLock } from '../../server/vendor/driver-audits/integration/hosted/worker-lock.mjs';

const implementation = await import('./driver-audit-native-builder.mjs').catch(() => ({}));
const sha = value => createHash('sha256').update(value).digest('hex'), exec = promisify(execFile);
const appCommit = 'a'.repeat(40), sessionId = '00000000-0000-4000-8000-000000000008';
const sourceManifest = '15301337474717828b88997faac92cbc23763b16ed1fc7881fa6bd553696a64b';
const capacity = 16 * 1024 ** 3, repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function fixture(t) {
  const appRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-builder-')));
  t.after(() => fs.rm(appRoot, { recursive: true, force: true }));
  const server = path.join(appRoot, 'server'), transferRoot = path.join(server, '.private/driver-audit-native-transfer');
  const folder = path.join(transferRoot, sessionId), syncRoot = path.join(server, '.private/driver-audits', 'c'.repeat(64));
  const sourceRoot = path.join(server, '.private/driver-audit-source');
  for (const directory of [folder, syncRoot, sourceRoot]) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const files = {
    'integration/cloud/automatic-release.mjs': 'export function automaticReleaseBasis(){};export function createAutomaticRelease(){}',
    'integration/cloud/automatic-release-source.mjs': 'export function createAutomaticReleaseSource(){}',
    'integration/cloud/automatic-release-build.mjs': 'export function buildAutomaticRelease(){}',
    'scripts/run-automatic-report.mjs': 'export function validateAutomaticCandidate(){}',
  };
  for (let i = 0; i < 69; i++) files['fixture/module-' + i + '.mjs'] = 'export const item=' + i + ';';
  const manifest = values => Buffer.from(JSON.stringify({ version: 1,
    files: Object.fromEntries(Object.entries(values).map(([name, code]) => [name, sha(code)])) }));
  const fromManifest = manifest(files), from = sha(fromManifest);
  const updated = { ...files, 'integration/cloud/automatic-release-source.mjs':
    'export function createAutomaticReleaseSource(){};export const supportsManagedArchiveCache=true;' };
  const toManifest = manifest(updated), to = sha(toManifest);
  const builder = path.join(syncRoot, 'builder'), staging = path.join(syncRoot, 'builder-staged-' + to);
  const retained = path.join(syncRoot, 'builder-retained-' + from);
  for (const [root, values, bytes] of [[builder, files, fromManifest], [staging, updated, toManifest]]) {
    for (const [name, code] of Object.entries(values)) {
      await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(root, name), code, { mode: 0o600 });
    }
    await fs.writeFile(path.join(root, 'runtime-manifest.json'), bytes, { mode: 0o600 });
  }
  const configFile = path.join(syncRoot, 'sync.json');
  const config = { version: 1, root: syncRoot, codeRoot: builder, builderSha256: from, baselineRoot: path.join(syncRoot, 'baseline'),
    rendererBuild: { path: path.join(syncRoot, 'baseline/build.private.json') },
    journals: { path: path.join(syncRoot, 'validation-journals.private.json') },
    unrelatedPrivateValue: 'FICTIONAL PRIVATE CONFIG MUST STAY PRIVATE' };
  const beforeConfig = Buffer.from(JSON.stringify(config, null, 2) + '\n');
  await fs.writeFile(configFile, beforeConfig, { mode: 0o600 });
  await fs.mkdir(path.join(syncRoot, 'work'), { mode: 0o700 });
  const pointer = { collectorRevision: 5771, privateRoot: path.join(syncRoot, 'work/fictional-pointer'), basis: 'd'.repeat(64) };
  await fs.writeFile(path.join(syncRoot, 'work/current.private.json'), JSON.stringify(pointer), { mode: 0o600 });
  const seed = { version: 1, mode: 'bootstrap', collectorRevision: 2118, sourceBasis: 'e'.repeat(64), manifestSha256: 'f'.repeat(64) };
  const seedBytes = Buffer.from(JSON.stringify(seed)); await fs.writeFile(path.join(syncRoot, 'seed.json'), seedBytes, { mode: 0o600 });
  const documents = [{ key: 'collector-state', revision: 5771, body_text: '{"fictional":"original source"}' }];
  const documentBytes = gzipSync(Buffer.from(documents.map(JSON.stringify).join('\n') + '\n'));
  const documentRef = { file: 'documents.private.jsonl.gz', sha256: sha(documentBytes) };
  await fs.writeFile(path.join(folder, documentRef.file), documentBytes, { mode: 0o600 });
  const census = { collectorRevisions: [2118, 2994, 5771],
    roots: [{ kind: 'sync.json', sha256: sha(beforeConfig) }, { kind: 'seed.json', sha256: sha(seedBytes) }] };
  census.sha256 = sha(JSON.stringify(census));
  const profile = { version: 2, receiptInput: 'selected', capacityBytes: capacity, targetDatabase: 'fictional_existing',
    syncRoot, collectorRootsSha256: census.sha256, documents: documentRef, runtimeSha256: sourceManifest,
    runtimeRoot: path.join(sourceRoot, sourceManifest, 'runtime') };
  const profileBytes = Buffer.from(JSON.stringify(profile)), profileSha256 = sha(profileBytes);
  await fs.writeFile(path.join(folder, 'profile.private.json'), profileBytes, { mode: 0o600 });
  const state = { version: 1, sessionId, targetDatabase: profile.targetDatabase, capacityBytes: capacity,
    inventorySha256: '2'.repeat(64), createdAt: Date.now() - 1000,
    plan: { inventorySha256: '2'.repeat(64), objectCount: 1, objectBytes: documentBytes.length } };
  const received = { version: 1, status: 'transfer-received', verified: true, authorityChanged: false, sessionId,
    targetDatabase: profile.targetDatabase, inventorySha256: state.inventorySha256,
    objects: 1, bytes: documentBytes.length, completedAt: new Date().toISOString(),
    inputFiles: [{ name: documentRef.file, sha256: documentRef.sha256, bytes: documentBytes.length }] };
  const save = async (name, value) => fs.writeFile(path.join(folder, name), JSON.stringify(value), { mode: 0o600 });
  await save('session.private.json', state); await save('received.private.json', received);
  const uri = 'mongodb://fictional.invalid/fictional_existing';
  const envFile = path.join(server, '.env.local'), baseFile = path.join(server, '.env');
  await fs.writeFile(baseFile, 'MONGODB_URI=' + uri + '\nUNRELATED_SECRET=fictional-private-secret\n', { mode: 0o600 });
  await fs.writeFile(envFile, '# Keep exact values\nDRIVER_AUDIT_REPLICA_GC_ENABLED=0\n', { mode: 0o600 });
  const entries = [
    { name: 'matter-delivery-api', pm_id: 3, pid: 4242, pm2_env: { status: 'online', pm_cwd: appRoot,
      pm_exec_path: '/usr/bin/npm', args: ['start', '--prefix', 'server'], pm_uptime: 100 } },
    { name: 'matter-driver-audit-sync', pm_id: 4, pid: 0, pm2_env: { status: 'stopped', pm_cwd: server,
      pm_exec_path: path.join(server, 'scripts/driverAuditSync.js'), args: ['--config', configFile] } },
  ];
  const control = {
    authority: { _id: 'authority', status: 'staging', importSha256: profileSha256, writeFence: 1 },
    stage: null, capacity: { _id: 'capacity', limitBytes: capacity, usedBytes: 100 },
    head: { _id: 'head', head: { version: 1, generation: '3'.repeat(64), reportHash: '4'.repeat(64),
      sourceRevision: 5771, sourceBodySha256: '5'.repeat(64),
      directImport: { version: 1, collectorRevision: 5771, sourceBasis: '6'.repeat(64), manifestSha256: '7'.repeat(64) } } },
  };
  const db = { databaseName: profile.targetDatabase, collection(name) {
    return { async findOne(query) {
      if (name === 'driverAuditNativeControl') return query._id === 'authority' ? control.authority : control.capacity;
      assert.equal(name, 'driverAuditControl'); return query._id === 'direct-stage' ? control.stage : control.head;
    }, async updateOne() { throw Error('Unexpected application data write'); }, async insertOne() { throw Error('Unexpected application data write'); } };
  } };
  const calls = [], smokes = [], locks = []; let closes = 0, saves = 0;
  const events = {};
  const adapters = { platform: 'linux', builderPins: { from, to },
    env: { MONGODB_URI: uri, DRIVER_AUDIT_REPLICA_GC_ENABLED: '0' },
    async systemFile(file) { assert.equal(file, '/usr/bin/npm'); return { realpath: '/usr/lib/node_modules/npm/bin/npm-cli.js',
      isFile: true, uid: 0, mode: 0o100644, bytes: 100, sha256: 'f'.repeat(64) }; },
    async exec(file, argv, options) {
      calls.push({ file, argv, options });
      if (file === 'git') return { stdout: argv[0] === 'rev-parse' ? appCommit + '\n'
        : argv[0] === 'ls-files' ? argv.slice(argv.indexOf('--') + 1).join('\n') + '\n' : '' };
      if (file === 'pm2') {
        if (argv[0] === 'jlist') return { stdout: JSON.stringify(entries) };
        assert.deepEqual(argv, ['save']); saves++; await events.save?.(saves); return { stdout: 'saved' };
      }
      assert.equal(file, process.execPath);
      if (argv[0] === '--version') return exec(file, argv, options);
      assert.equal(argv[0], path.join(server, 'scripts/checkDriverAuditBuilder.js'));
      assert.equal(argv[2], to); assert.equal(argv[3], syncRoot);
      assert(!JSON.stringify(options.env || {}).includes('fictional-private-secret'));
      await events.beforeSmoke?.(); smokes.push(argv[1]);
      const result = await exec(file, [path.join(repo, 'server/scripts/checkDriverAuditBuilder.js'), ...argv.slice(1)], options);
      await events.afterSmoke?.(); return result;
    },
    async load(name) {
      if (name === 'loadEnv.js') return {};
      if (name === 'node_modules/dotenv/lib/main.js') return { default: dotenv };
      if (name === 'services/driverAuditSource.js') return { readPrivateDriverAuditSource, requirePrivateDriverAuditSourceDirectory };
      if (name === 'vendor/driver-audits/integration/hosted/worker-lock.mjs') return { async acquireWorkerLock(file) {
        locks.push(file); return acquireWorkerLock(file);
      } };
      if (name === 'vendor/driver-audits/integration/cloud/driver-audit-handoff.mjs') return { verifyAuditBuilder };
      if (name === 'services/driverAuditBuilderTransition.js') return { transitionDriverAuditBuilder, driverAuditBuilderConfigGuardVersion };
      if (name === 'services/driverAuditLiveImport.js') return { readDriverAuditImportRows,
        async collectDriverAuditReceiptRoots({ documents: rows, syncRoot: root }) {
          assert.deepEqual(rows, documents); assert.equal(root, syncRoot);
          const value = structuredClone(census), current = sha(await fs.readFile(configFile));
          if (current !== sha(beforeConfig)) {
            value.roots[0].sha256 = current; delete value.sha256; value.sha256 = sha(JSON.stringify(value));
          }
          return value;
        } };
      if (name === 'node_modules/mongoose/index.js') return { default: { createConnection(value) {
        assert.equal(value, uri); return { db, asPromise: async () => {}, close: async () => { closes++; } };
      } } };
      throw Error('Unexpected app import');
    } };
  const run = extra => implementation.runDriverAuditNativeBuilder({ operation: 'swap-builder-held', sessionId, profileSha256,
    expectedSha: appCommit, appRoot, ...extra }, adapters);
  return { appRoot, server, folder, syncRoot, sourceRoot, from, to, builder, staging, retained, beforeConfig, configFile, config,
    profile, profileSha256, state, received, seed, census, control, entries, adapters, events, run, save, calls, smokes, locks,
    envFile, baseFile, get saves() { return saves; }, get closes() { return closes; } };
}

test('the held swap runs the actual host smoke and transition, preserves old bytes and saves only stopped report registrations', async t => {
  const f = await fixture(t);
  assert.equal(typeof implementation.runDriverAuditNativeBuilder, 'function', 'held builder operation is not implemented');
  const result = await f.run();
  assert.equal(result.status, 'builder-swapped-held'); assert.equal(result.builderSha256, f.to);
  assert.equal(result.authorityChanged, false); assert.equal(result.reportWorkersStopped, true); assert.equal(result.pruningEnabled, false);
  assert.equal(result.previousCollectorRootsSha256, f.profile.collectorRootsSha256);
  assert.notEqual(result.collectorRootsSha256, f.profile.collectorRootsSha256); assert.equal(result.requiresNewImportProfile, true);
  await verifyAuditBuilder(f.builder, f.to); await verifyAuditBuilder(f.retained, f.from);
  const transition = JSON.parse(await fs.readFile(path.join(f.syncRoot, 'builder-transition-' + f.from + '-' + f.to + '.private.json')));
  assert.deepEqual(Buffer.from(transition.oldConfig, 'base64'), f.beforeConfig);
  assert.equal(JSON.parse(await fs.readFile(f.configFile)).unrelatedPrivateValue, f.config.unrelatedPrivateValue);
  assert.equal(f.smokes.length, 1); assert(f.saves >= 2); assert.equal(f.closes, 1);
  assert(f.calls.filter(row => row.file === 'pm2').every(row => ['jlist', 'save'].includes(row.argv[0])));
  assert(f.entries.filter(row => row.name !== 'matter-delivery-api').every(row => row.pm2_env.status === 'stopped'));
  for (const privateText of [f.appRoot, f.config.unrelatedPrivateValue, 'fictional-private-secret']) assert(!JSON.stringify(result).includes(privateText));
  const retainedFiles = await fs.readdir(f.folder);
  assert(retainedFiles.some(name => name.startsWith('held-builder-plan-')));
  assert(retainedFiles.some(name => name.startsWith('held-builder-receipt-')));
  assert.equal((await f.run()).status, 'builder-already-held'); assert.equal(f.smokes.length, 2);
});

test('held builder admits the declared NPM launch and tracks its native dependency files', async t => {
  const f = await fixture(t); assert.equal((await f.run()).status, 'builder-swapped-held');
  for (const file of ['server/loadEnv.js', 'server/package.json', 'server/services/driverAuditPollProgress.js',
    'server/services/driverAuditSpacesArchive.js', 'server/services/driverAuditNativeObjectStore.js']) {
    assert(f.calls.some(row => row.file === 'git' && row.argv[0] === 'ls-files' && row.argv.includes(file)), file);
    assert(f.calls.some(row => row.file === 'git' && row.argv[0] === 'diff' && row.argv.includes(file)), file);
  }
});

test('held builder rejects changed NPM identity and unreviewed dependencies before any swap or PM2 save', async t => {
  for (const reason of ['args', 'direct-node', 'writable-npm', 'foreign-npm', 'changed-npm', 'untracked', 'dirty-reader']) await t.test(reason, async t => {
    const f = await fixture(t), systemFile = f.adapters.systemFile, execute = f.adapters.exec;
    if (reason === 'args') f.entries[0].pm2_env.args = ['start', '--prefix', 'other'];
    if (reason === 'direct-node') f.entries[0].pm2_env.pm_exec_path = path.join(f.server, 'server.js');
    if (['writable-npm', 'foreign-npm', 'changed-npm'].includes(reason)) {
      let calls = 0;
      f.adapters.systemFile = async file => ({ ...await systemFile(file),
        ...(reason === 'writable-npm' ? { mode: 0o100666 } : reason === 'foreign-npm' ? { realpath: '/tmp/npm-cli.js' }
          : ++calls > 1 ? { sha256: 'a'.repeat(64) } : {}) });
    }
    if (reason === 'untracked' || reason === 'dirty-reader') f.adapters.exec = async (file, argv, options) => {
      if (file === 'git' && argv[0] === (reason === 'untracked' ? 'ls-files' : 'diff')
          && argv.includes('server/services/driverAuditSpacesArchive.js')) throw Error('Fictional unreviewed code');
      return execute(file, argv, options);
    };
    await assert.rejects(f.run()); assert.deepEqual(await fs.readFile(f.configFile), f.beforeConfig);
    assert.equal(f.saves, 0); await verifyAuditBuilder(f.builder, f.from);
  });
});

test('unsafe held-swap admissions fail without switching code or saving PM2', async t => {
  for (const reason of ['active', 'sync-online', 'source-online', 'stage', 'database', 'gc-file', 'gc-loaded',
    'profile', 'census', 'bootstrap', 'builder', 'candidate', 'private-env', 'source-path']) await t.test(reason, async t => {
    const f = await fixture(t);
    if (reason === 'active') f.control.authority.status = 'active';
    if (reason === 'sync-online') f.entries[1].pm2_env.status = 'online';
    if (reason === 'source-online') f.entries.push({ name: 'matter-driver-audit-source', pm_id: 5, pid: 55, pm2_env: { status: 'online' } });
    if (reason === 'stage') f.control.stage = { _id: 'direct-stage' };
    if (reason === 'database') f.state.targetDatabase = 'another_database';
    if (reason === 'gc-file') await fs.writeFile(f.envFile, 'DRIVER_AUDIT_REPLICA_GC_ENABLED=1\n', { mode: 0o600 });
    if (reason === 'gc-loaded') f.adapters.env.DRIVER_AUDIT_REPLICA_GC_ENABLED = '1';
    if (reason === 'profile') await f.save('profile.private.json', { ...f.profile, syncRoot: '/untrusted/root' });
    if (reason === 'census') f.census.sha256 = '9'.repeat(64);
    if (reason === 'bootstrap') await fs.writeFile(path.join(f.syncRoot, 'seed.json'), JSON.stringify({ ...f.seed, collectorRevision: 1 }), { mode: 0o600 });
    if (reason === 'builder') await fs.writeFile(path.join(f.builder, 'scripts/run-automatic-report.mjs'), 'changed');
    if (reason === 'candidate') await fs.writeFile(path.join(f.staging, 'scripts/run-automatic-report.mjs'), 'changed');
    if (reason === 'private-env') await fs.chmod(f.envFile, 0o644);
    if (reason === 'source-path') f.entries.push({ name: 'matter-driver-audit-source', pm_id: 5, pid: 0, pm2_env: {
      status: 'stopped', pm_cwd: f.server, pm_exec_path: path.join(f.server, 'scripts/driverAuditSource.js'),
      args: ['--config', '/untrusted/source.json'] } });
    await f.save('session.private.json', f.state);
    await assert.rejects(f.run(), error => !String(error).includes(f.appRoot) && !String(error).includes('fictional-private'));
    assert.deepEqual(await fs.readFile(f.configFile), f.beforeConfig); assert.equal(f.saves, 0);
    await assert.rejects(fs.stat(f.retained), { code: 'ENOENT' });
  });
});

test('an interrupted rename remains held and retries through the real preserved transition receipt', async t => {
  const f = await fixture(t), rename = fs.rename;
  let interrupted = false;
  fs.rename = async (from, to) => {
    if (!interrupted && from === f.staging && to === f.builder) { interrupted = true; throw Error('fictional-private interruption'); }
    return rename(from, to);
  };
  try { await assert.rejects(f.run(), error => !String(error).includes('fictional-private')); }
  finally { fs.rename = rename; }
  assert(interrupted); assert.deepEqual(await fs.readFile(f.configFile), f.beforeConfig);
  await assert.rejects(fs.stat(f.builder), { code: 'ENOENT' }); await verifyAuditBuilder(f.retained, f.from);
  assert.equal(f.entries[1].pm2_env.status, 'stopped');
  assert.equal((await f.run()).status, 'builder-swapped-held'); await verifyAuditBuilder(f.builder, f.to);
});

test('head or private-input drift after the fresh smoke prevents the switch', async t => {
  for (const reason of ['head', 'pointer', 'profile', 'gc']) await t.test(reason, async t => {
    const f = await fixture(t);
    f.events.afterSmoke = async () => {
      if (reason === 'head') f.control.head.head.generation = '9'.repeat(64);
      if (reason === 'pointer') await fs.writeFile(path.join(f.syncRoot, 'work/current.private.json'), '{}', { mode: 0o600 });
      if (reason === 'profile') await f.save('profile.private.json', {});
      if (reason === 'gc') await fs.writeFile(f.envFile, 'DRIVER_AUDIT_REPLICA_GC_ENABLED=1\n', { mode: 0o600 });
    };
    await assert.rejects(f.run()); assert.deepEqual(await fs.readFile(f.configFile), f.beforeConfig); assert.equal(f.saves, 0);
    await assert.rejects(fs.stat(f.retained), { code: 'ENOENT' });
  });
});

test('failure to persist the final held state preserves the installed and retained builders for an exact retry', async t => {
  const f = await fixture(t);
  f.events.save = async count => { if (count === 2) throw Error('fictional-private PM2 failure'); };
  await assert.rejects(f.run(), error => !String(error).includes('fictional-private'));
  await verifyAuditBuilder(f.builder, f.to); await verifyAuditBuilder(f.retained, f.from);
  assert.equal(f.entries[1].pm2_env.status, 'stopped');
  f.events.save = undefined;
  assert.equal((await f.run()).status, 'builder-already-held');
});

test('actual worker exclusion prevents a held swap while either report worker lease is held', async t => {
  for (const name of ['sync', 'source']) await t.test(name, async t => {
    const f = await fixture(t), file = name === 'sync' ? path.join(path.dirname(f.syncRoot), 'sync-worker.lock')
      : path.join(f.sourceRoot, 'source-worker.lock');
    const lock = await acquireWorkerLock(file);
    try { await assert.rejects(f.run()); }
    finally { await lock.release(); }
    assert.equal(f.saves, 0); assert.deepEqual(await fs.readFile(f.configFile), f.beforeConfig);
    assert.equal((await f.run()).status, 'builder-swapped-held');
  });
});

test('a changed application checkout or failed fresh host smoke cannot switch the builder', async t => {
  for (const reason of ['commit', 'dirty-module', 'node', 'smoke']) await t.test(reason, async t => {
    const f = await fixture(t), original = f.adapters.exec;
    f.adapters.exec = (file, argv, options) => {
      if (file === 'git' && reason === 'commit' && argv[0] === 'rev-parse') return { stdout: 'b'.repeat(40) };
      if (file === 'git' && reason === 'dirty-module' && argv[0] === 'diff') throw Error('fictional-private changed module');
      if (file === process.execPath && reason === 'node' && argv[0] === '--version') return { stdout: 'v0.0.0' };
      return original(file, argv, options);
    };
    if (reason === 'smoke') f.events.beforeSmoke = () => { throw Error('fictional-private smoke failure'); };
    await assert.rejects(f.run(), error => !String(error).includes('fictional-private'));
    assert.equal(f.saves, 0); assert.deepEqual(await fs.readFile(f.configFile), f.beforeConfig);
  });
});

test('the expected sync configuration change never permits another census control to change', async t => {
  const f = await fixture(t), original = f.adapters.load;
  f.adapters.load = async name => {
    const value = await original(name);
    if (name !== 'services/driverAuditBuilderTransition.js') return value;
    return { ...value, async transitionDriverAuditBuilder(args) {
      const changed = await value.transitionDriverAuditBuilder(args);
      f.census.roots.push({ kind: 'fictional-other-original-control', sha256: '9'.repeat(64) });
      return changed;
    } };
  };
  await assert.rejects(f.run());
  await verifyAuditBuilder(f.builder, f.to); await verifyAuditBuilder(f.retained, f.from);
  assert.equal(f.entries[1].pm2_env.status, 'stopped');
  assert.equal(f.saves, 1);
});

test('private config drift after the swap is retained for inspection and never silently adopted on retry', async t => {
  const f = await fixture(t), original = f.adapters.load;
  f.adapters.load = async name => {
    const value = await original(name);
    if (name !== 'services/driverAuditBuilderTransition.js') return value;
    return { ...value, async transitionDriverAuditBuilder(args) {
      const changed = await value.transitionDriverAuditBuilder(args);
      const config = JSON.parse(await fs.readFile(f.configFile)); config.unrelatedPrivateValue = 'unexpected later private edit';
      await fs.writeFile(f.configFile, JSON.stringify(config), { mode: 0o600 }); return changed;
    } };
  };
  await assert.rejects(f.run()); await verifyAuditBuilder(f.retained, f.from);
  f.adapters.load = original;
  await assert.rejects(f.run());
  assert.equal(JSON.parse(await fs.readFile(f.configFile)).unrelatedPrivateValue, 'unexpected later private edit');
  assert.equal(f.entries[1].pm2_env.status, 'stopped');
});

test('the actual transition rejects a config edit after preflight instead of adopting it as the original', async t => {
  const f = await fixture(t), original = f.adapters.load;
  const edited = Buffer.from(JSON.stringify({ ...f.config, unrelatedPrivateValue: 'independent edit before actual transition read' }));
  f.adapters.load = async name => {
    const value = await original(name);
    if (name === 'services/driverAuditBuilderTransition.js') await fs.writeFile(f.configFile, edited, { mode: 0o600 });
    return value;
  };
  await assert.rejects(f.run()); assert.deepEqual(await fs.readFile(f.configFile), edited);
  await verifyAuditBuilder(f.builder, f.from);
  await assert.rejects(fs.stat(f.retained), { code: 'ENOENT' });
  assert.equal(f.entries[1].pm2_env.status, 'stopped');
});

test('an edit during the real builder directory rename is preserved, never hidden by the planned config write', async t => {
  const f = await fixture(t), rename = fs.rename;
  const edited = Buffer.from(JSON.stringify({ ...f.config, unrelatedPrivateValue: 'independent edit during directory rename' }));
  fs.rename = async (from, to) => {
    const result = await rename(from, to);
    if (from === f.staging && to === f.builder) await fs.writeFile(f.configFile, edited, { mode: 0o600 });
    return result;
  };
  try { await assert.rejects(f.run()); } finally { fs.rename = rename; }
  assert.deepEqual(await fs.readFile(f.configFile), edited);
  await verifyAuditBuilder(f.builder, f.to); await verifyAuditBuilder(f.retained, f.from);
  assert.equal(f.saves, 1); assert.equal(f.entries[1].pm2_env.status, 'stopped');
});

test('an operator-only publish cannot swap through an older app transition without actual config guards', async t => {
  const f = await fixture(t), original = f.adapters.load;
  f.adapters.load = async name => {
    const value = await original(name);
    return name === 'services/driverAuditBuilderTransition.js' ? { transitionDriverAuditBuilder: value.transitionDriverAuditBuilder } : value;
  };
  await assert.rejects(f.run(), /lacks exact config guards/);
  assert.equal(f.saves, 0); assert.deepEqual(await fs.readFile(f.configFile), f.beforeConfig);
  assert.equal((await fs.readdir(f.folder)).some(name => name.startsWith('held-builder-plan-')), false);
  await verifyAuditBuilder(f.builder, f.from);
});
