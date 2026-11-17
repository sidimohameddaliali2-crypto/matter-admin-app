import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import test from 'node:test';
import dotenv from '../../server/node_modules/dotenv/lib/main.js';
import { writeDriverAuditEnvironment } from '../../server/scripts/driverAuditDeploy.js';
import { readPrivateDriverAuditSource, requirePrivateDriverAuditSourceDirectory } from '../../server/services/driverAuditSource.js';
import { runDriverAuditNativeSettings } from './driver-audit-native-settings.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const commit = 'a'.repeat(40), sourceManifest = 'e1650c0a521271976629fafc1ad6d6eb0abf39074b5eeaf909f2d93f929f9d9d';
const sessionId = '00000000-0000-4000-8000-000000000007', capacity = 16 * 1024 ** 3;

async function fixture(t) {
  const appRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-settings-')));
  t.after(() => fs.rm(appRoot, { recursive: true, force: true }));
  const serverRoot = path.join(appRoot, 'server'), transferRoot = path.join(serverRoot, '.private/driver-audit-native-transfer');
  const folder = path.join(transferRoot, sessionId), syncRoot = path.join(serverRoot, '.private/driver-audits', 'c'.repeat(64));
  const sourceRoot = path.join(serverRoot, '.private/driver-audit-source', sourceManifest), cacheRoot = path.join(syncRoot, 'work/archive-cache');
  for (const directory of [folder, sourceRoot, cacheRoot]) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const envFile = path.join(serverRoot, '.env.local'), baseFile = path.join(serverRoot, '.env');
  const base = 'MONGODB_URI=mongodb://fictional.invalid/existing\nJWT_SECRET=fictional-secret-keep\n';
  const before = '# Keep this comment and original settings\r\nUNRELATED_TOKEN="fictional-private value # keep"\r\n' +
    '# BEGIN MANAGED DRIVER AUDIT SETTINGS\nDRIVER_AUDIT_ENABLED=1\nDRIVER_AUDIT_IMPORT_ENABLED=0\n' +
    'DRIVER_AUDIT_ORIGIN=https://matterapp.online\nDRIVER_AUDIT_CAPACITY_BYTES=268435456\n' +
    'DRIVER_AUDIT_SUPABASE_SECRET=fictional-report-key\nDRIVER_AUDIT_REPLICA_GC_ENABLED=1\n# END MANAGED DRIVER AUDIT SETTINGS\n';
  await fs.writeFile(baseFile, base, { mode: 0o600 }); await fs.writeFile(envFile, before, { mode: 0o600 });
  const profile = { version: 2, targetDatabase: 'existing', capacityBytes: capacity, syncRoot,
    collectorRootsSha256: 'd'.repeat(64), runtimeRoot: path.join(sourceRoot, 'runtime'), runtimeSha256: sourceManifest };
  const profileBytes = Buffer.from(JSON.stringify(profile)), profileSha256 = sha(profileBytes);
  await fs.writeFile(path.join(folder, 'profile.private.json'), profileBytes, { mode: 0o600 });
  const createdAt = Date.now() - 1000;
  await fs.writeFile(path.join(folder, 'session.private.json'), JSON.stringify({ version: 1, sessionId, createdAt,
    targetDatabase: 'existing', capacityBytes: capacity, inventorySha256: 'e'.repeat(64),
    plan: { inventorySha256: 'e'.repeat(64), objectCount: 1, objectBytes: 100 } }), { mode: 0o600 });
  await fs.writeFile(path.join(folder, 'received.private.json'), JSON.stringify({ version: 1, status: 'transfer-received', verified: true,
    sessionId, targetDatabase: 'existing', inventorySha256: 'e'.repeat(64), authorityChanged: false,
    objects: 1, bytes: 100, completedAt: new Date(createdAt + 1).toISOString() }), { mode: 0o600 });
  await fs.writeFile(path.join(syncRoot, 'sync.json'), JSON.stringify({ version: 1, root: syncRoot,
    codeRoot: path.join(syncRoot, 'builder'), baselineRoot: path.join(syncRoot, 'baseline'),
    rendererBuild: { path: path.join(syncRoot, 'baseline/build.private.json') },
    journals: { path: path.join(syncRoot, 'validation-journals.private.json') } }), { mode: 0o600 });
  const source = { root: sourceRoot, runtimeRoot: profile.runtimeRoot, manifestSha256: sourceManifest,
    configSha256: 'f'.repeat(64), archiveCacheDirectory: cacheRoot, dataStore: 'mongo',
    environment: { DRIVER_AUDIT_DATA_STORE: 'mongo', MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY: cacheRoot } };
  let authority = { status: 'staging', importSha256: profileSha256, writeFence: 7 }, directStage = null, head = null, locked = false;
  let saves = 0, closes = 0;
  const entries = [{ name: 'matter-delivery-api', pm_id: 1, pm2_env: { status: 'online' } },
    { name: 'matter-driver-audit-sync', pm_id: 2, pm2_env: { status: 'stopped', pm_cwd: serverRoot,
      pm_exec_path: path.join(serverRoot, 'scripts/driverAuditSync.js'), args: ['--config', path.join(syncRoot, 'sync.json')] } }];
  const db = { databaseName: 'existing', collection: name => ({ findOne: async query => name === 'driverAuditNativeControl'
    ? query._id === 'authority' ? authority : { limitBytes: capacity, usedBytes: 1 }
    : query._id === 'head' ? head : directStage }) };
  const adapters = { platform: 'linux', env: { MONGODB_URI: 'mongodb://fictional.invalid/existing' },
    async execute(file, args) {
      if (file === 'git') return { stdout: commit + '\n' };
      assert.equal(file, 'pm2');
      if (args[0] === 'save') { saves++; return { stdout: 'saved' }; }
      assert.deepEqual(args, ['jlist']); return { stdout: JSON.stringify(entries) };
    },
    async load(name) {
      if (name === 'loadEnv.js') return {};
      if (name === 'node_modules/dotenv/lib/main.js') return { default: dotenv };
      if (name === 'scripts/driverAuditDeploy.js') return { writeDriverAuditEnvironment };
      if (name === 'services/driverAuditSource.js') return { readPrivateDriverAuditSource, requirePrivateDriverAuditSourceDirectory,
        async readDriverAuditSourceConfig(file) { assert.equal(file, path.join(sourceRoot, 'source.json')); return source; } };
      if (name === 'node_modules/mongoose/index.js') return { default: { createConnection(uri) {
        assert.equal(uri, adapters.env.MONGODB_URI); return { db, async asPromise() {}, async close() { closes++; } };
      } } };
      if (name === 'vendor/driver-audits/integration/hosted/worker-lock.mjs') return { async acquireWorkerLock(file) {
        assert.equal(file, path.join(transferRoot, 'operator.lock')); assert.equal(locked, false); locked = true;
        return { async release() { locked = false; } };
      } };
      throw Error('Unexpected test dependency');
    } };
  const run = (operation, extra = {}) => runDriverAuditNativeSettings({ operation, appRoot, sessionId,
    profileSha256, expectedSha: commit, ...extra }, adapters);
  return { appRoot, serverRoot, folder, envFile, baseFile, before, base, source, entries, adapters, run,
    profileSha256, saves: () => saves, closes: () => closes, locked: () => locked,
    authority: value => { authority = value; }, stage: value => { directStage = value; }, head: value => { head = value; } };
}

test('disabling pruning preserves exact backup, all other values/comments and the stopped PM2 registration', async t => {
  const f = await fixture(t), result = await f.run('disable-pruning');
  const after = await fs.readFile(f.envFile, 'utf8'), original = dotenv.parse(f.base + f.before), next = dotenv.parse(f.base + after);
  assert.equal(result.status, 'pruning-disabled'); assert.equal(next.DRIVER_AUDIT_REPLICA_GC_ENABLED, '0');
  for (const [key, value] of Object.entries(original)) if (key !== 'DRIVER_AUDIT_REPLICA_GC_ENABLED') assert.equal(next[key], value);
  assert(after.startsWith('# Keep this comment and original settings\r\nUNRELATED_TOKEN="fictional-private value # keep"\r\n'));
  assert.deepEqual(await fs.readFile(path.join(f.folder, 'pruning-before.private.env')), Buffer.from(f.before));
  assert.equal(result.beforeSha256, sha(f.before)); assert.equal(result.afterSha256, sha(after));
  assert.equal(result.nativeSettingsApplied, false); assert.equal(f.entries[1].pm2_env.status, 'stopped');
  assert.equal(f.saves(), 1); assert.equal(f.locked(), false);
  assert(!JSON.stringify(result).includes('fictional-private'));
  assert.equal((await f.run('disable-pruning')).afterSha256, result.afterSha256);
  assert.deepEqual(await fs.readFile(path.join(f.folder, 'pruning-before.private.env')), Buffer.from(f.before));
});

test('native settings preparation changes only the three proposed keys and never writes the effective file', async t => {
  const f = await fixture(t); await f.run('disable-pruning');
  const before = await fs.readFile(f.envFile), result = await f.run('prepare-native-settings');
  assert.deepEqual(await fs.readFile(f.envFile), before);
  const prepared = await fs.readFile(path.join(f.folder, 'native-settings-after.private.env'));
  const original = dotenv.parse(f.base + before), next = dotenv.parse(f.base + prepared);
  assert.equal(next.DRIVER_AUDIT_DATA_STORE, 'mongo'); assert.equal(next.DRIVER_AUDIT_NATIVE_CAPACITY_BYTES, String(capacity));
  assert.equal(next.MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY, f.source.archiveCacheDirectory);
  for (const [key, value] of Object.entries(original)) assert.equal(next[key], value);
  assert(prepared.subarray(0, before.length).equals(before));
  assert.equal(result.status, 'native-settings-prepared'); assert.equal(result.nativeSettingsApplied, false);
  assert.equal(result.requiresFinalFenceAndParity, true);
  assert.equal((await f.run('prepare-native-settings')).planSha256, result.planSha256);
  assert.equal((await fs.stat(path.join(f.folder, 'native-settings-before.private.env'))).mode & 0o777, 0o600);
  assert(!JSON.stringify(result).includes('fictional-private'));
});

test('an external environment edit or base-file change invalidates an immutable settings plan without reverting it', async t => {
  for (const operation of ['disable-pruning', 'prepare-native-settings']) {
    for (const baseChange of [false, true]) await t.test(operation + ':' + baseChange, async t => {
      const f = await fixture(t); await f.run('disable-pruning');
      if (operation === 'prepare-native-settings') await f.run(operation);
      const file = baseChange ? f.baseFile : f.envFile;
      await fs.appendFile(file, '# Later independent edit\n'); const current = await fs.readFile(file);
      await assert.rejects(f.run(operation), /changed|differ|settings|plan/i);
      assert.deepEqual(await fs.readFile(file), current); assert.equal(f.locked(), false);
    });
  }
});

test('settings operations reject active authority, mismatched stage/profile, running workers and a different cache owner', async t => {
  for (const reason of ['active', 'profile', 'writer', 'direct-stage', 'cache', 'uri', 'commit']) await t.test(reason, async t => {
    const f = await fixture(t);
    if (reason === 'active') f.authority({ status: 'active', importSha256: f.profileSha256, writeFence: 7 });
    if (reason === 'profile') f.authority({ status: 'staging', importSha256: 'f'.repeat(64), writeFence: 7 });
    if (reason === 'writer') f.entries[1].pm2_env.status = 'online';
    if (reason === 'direct-stage') f.stage({ status: 'pending' });
    if (reason === 'cache') f.source.archiveCacheDirectory += '-different';
    if (reason === 'uri') f.adapters.env.MONGODB_URI = 'mongodb://other.invalid/existing';
    const op = reason === 'cache' ? 'prepare-native-settings' : 'disable-pruning';
    if (reason === 'cache') await f.run('disable-pruning');
    await assert.rejects(f.run(op, reason === 'commit' ? { expectedSha: 'f'.repeat(40) } : {}));
    if (reason !== 'cache') assert.equal(await fs.readFile(f.envFile, 'utf8'), f.before);
    assert.equal(f.locked(), false);
  });
});

test('a failed PM2 save leaves pruning off and retries from the original immutable backup without restarting', async t => {
  const f = await fixture(t), execute = f.adapters.execute;
  let failSave = true;
  f.adapters.execute = async (file, args, options) => {
    if (file === 'pm2' && args[0] === 'save' && failSave) throw Error('PRIVATE FIXTURE must stay out of errors');
    return execute(file, args, options);
  };
  await assert.rejects(f.run('disable-pruning'), error => {
    assert.equal(error.message, 'Native settings stopped at disable-pruning'); return true;
  });
  const disabled = await fs.readFile(f.envFile);
  assert.equal(dotenv.parse(disabled).DRIVER_AUDIT_REPLICA_GC_ENABLED, '0');
  assert.deepEqual(await fs.readFile(path.join(f.folder, 'pruning-before.private.env')), Buffer.from(f.before));
  failSave = false;
  const result = await f.run('disable-pruning');
  assert.equal(result.beforeSha256, sha(f.before)); assert.deepEqual(await fs.readFile(f.envFile), disabled);
  assert.equal(f.saves(), 1); assert.equal(f.locked(), false); assert.equal(f.closes(), 2);
});

test('a last-moment environment edit is preserved and blocks the planned pruning write', async t => {
  const f = await fixture(t), execute = f.adapters.execute;
  let inventories = 0;
  f.adapters.execute = async (file, args, options) => {
    const result = await execute(file, args, options);
    if (file === 'pm2' && args[0] === 'jlist' && ++inventories === 3) await fs.appendFile(f.envFile, '# independent edit\n');
    return result;
  };
  await assert.rejects(f.run('disable-pruning'), /settings changed/);
  assert.equal(await fs.readFile(f.envFile, 'utf8'), f.before + '# independent edit\n');
  assert.equal(f.saves(), 0); assert.equal(f.locked(), false);
});

test('a managed disable at the actual writer first-read or pre-rename boundary is preserved and fails closed', async t => {
  for (const boundary of [5, 6]) await t.test(boundary === 5 ? 'writer first read' : 'before rename', async t => {
    const f = await fixture(t), lstat = fs.lstat;
    let reads = 0, injected = false;
    // The first four reads are admission/plan/readback guards. The fifth starts
    // the actual writer; the sixth guards its final rename.
    fs.lstat = async (file, ...options) => {
      if (file === f.envFile && ++reads === boundary) {
        injected = true;
        await fs.writeFile(f.envFile, f.before.replace('DRIVER_AUDIT_ENABLED=1', 'DRIVER_AUDIT_ENABLED=0'), { mode: 0o600 });
      }
      return lstat(file, ...options);
    };
    try { await assert.rejects(f.run('disable-pruning'), /settings changed/); }
    finally { fs.lstat = lstat; }
    assert.equal(injected, true);
    assert.equal(dotenv.parse(await fs.readFile(f.envFile)).DRIVER_AUDIT_ENABLED, '0');
    assert.equal(dotenv.parse(await fs.readFile(f.envFile)).DRIVER_AUDIT_REPLICA_GC_ENABLED, '1');
    assert.equal((await fs.readdir(f.serverRoot)).some(name => name.includes('.native-')), false);
    assert.equal(f.saves(), 0); assert.equal(f.locked(), false);
  });
});

test('preparation requires durable pruning off and the exact source identity, without applying native mode', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run('prepare-native-settings'), /Pruning must be durably disabled/);
  assert.equal(await fs.readFile(f.envFile, 'utf8'), f.before);
  await f.run('disable-pruning'); const disabled = await fs.readFile(f.envFile);
  f.source.manifestSha256 = '0'.repeat(64);
  await assert.rejects(f.run('prepare-native-settings'), /source and managed archive cache/);
  assert.deepEqual(await fs.readFile(f.envFile), disabled);
  assert.equal(dotenv.parse(disabled).DRIVER_AUDIT_DATA_STORE, undefined);
});

test('private plan inputs and managed cache directories cannot be group readable or symlinked', async t => {
  for (const reason of ['profile-mode', 'profile-link', 'cache-mode', 'cache-link']) await t.test(reason, async t => {
    const f = await fixture(t), profile = path.join(f.folder, 'profile.private.json');
    if (reason.startsWith('cache-')) await f.run('disable-pruning');
    if (reason === 'profile-mode') await fs.chmod(profile, 0o640);
    if (reason === 'profile-link') { await fs.rename(profile, profile + '.saved'); await fs.symlink(profile + '.saved', profile); }
    if (reason === 'cache-mode') await fs.chmod(f.source.archiveCacheDirectory, 0o750);
    if (reason === 'cache-link') {
      await fs.rename(f.source.archiveCacheDirectory, f.source.archiveCacheDirectory + '-saved');
      await fs.symlink(f.source.archiveCacheDirectory + '-saved', f.source.archiveCacheDirectory);
    }
    const before = await fs.readFile(f.envFile);
    await assert.rejects(f.run(reason.startsWith('cache-') ? 'prepare-native-settings' : 'disable-pruning'));
    assert.deepEqual(await fs.readFile(f.envFile), before); assert.equal(f.locked(), false);
  });
});

test('a changed staged authority invalidates the existing private plan rather than silently rebinding it', async t => {
  const f = await fixture(t); await f.run('disable-pruning');
  const before = await fs.readFile(f.envFile);
  f.authority({ status: 'staging', importSha256: f.profileSha256, writeFence: 8 });
  await assert.rejects(f.run('disable-pruning'), /immutable settings plan changed/);
  assert.deepEqual(await fs.readFile(f.envFile), before); assert.equal(f.saves(), 1);
});

test('pruning can be disabled before semantic import while native settings still require the staged authority', async t => {
  const f = await fixture(t); f.authority(null);
  assert.equal((await f.run('disable-pruning')).pruningEnabled, false);
  const disabled = await fs.readFile(f.envFile);
  await assert.rejects(f.run('prepare-native-settings'), /inactive authority/);
  assert.deepEqual(await fs.readFile(f.envFile), disabled);
  const plan = JSON.parse(await fs.readFile(path.join(f.folder, 'pruning-plan.private.json')));
  assert.equal(plan.authority, null);
  f.authority({ status: 'staging', importSha256: f.profileSha256, writeFence: 7 });
  await assert.rejects(f.run('disable-pruning'), /immutable settings plan changed/);
  assert.deepEqual(await fs.readFile(f.envFile), disabled);
});

test('serving and accepted-candidate heads are preserved and changes invalidate the existing plan', async t => {
  for (const kind of ['serving', 'candidate']) await t.test(kind, async t => {
    const f = await fixture(t); f.authority(null); await f.run('disable-pruning');
    const disabled = await fs.readFile(f.envFile);
    if (kind === 'serving') f.head({ head: { version: 1, sourceRevision: 9, sourceBodySha256: '9'.repeat(64) } });
    else await fs.writeFile(path.join(path.dirname(f.source.archiveCacheDirectory), 'current.private.json'),
      JSON.stringify({ candidate: 'fictional-retained-root' }), { mode: 0o600 });
    await assert.rejects(f.run('disable-pruning'), /immutable settings plan changed/);
    assert.deepEqual(await fs.readFile(f.envFile), disabled);
  });
});
