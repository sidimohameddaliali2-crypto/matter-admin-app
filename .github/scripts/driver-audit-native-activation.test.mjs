import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import test from 'node:test';
import dotenv from '../../server/node_modules/dotenv/lib/main.js';
import { verifyDriverAuditMongoAuthority, activateDriverAuditMongoAuthority } from '../../server/services/driverAuditMongoImport.js';
import { readPrivateDriverAuditSource, requirePrivateDriverAuditSourceDirectory } from '../../server/services/driverAuditSource.js';
import { acquireWorkerLock } from '../../server/vendor/driver-audits/integration/hosted/worker-lock.mjs';
import { withDriverAuditHeavyWork } from '../../server/services/driverAuditHeavyWork.js';
import { runDriverAuditNativeActivation } from './driver-audit-native-activation.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const sourceSha = 'e1650c0a521271976629fafc1ad6d6eb0abf39074b5eeaf909f2d93f929f9d9d';
const commit = 'a'.repeat(40), sessionId = '00000000-0000-4000-8000-000000000009', capacity = 16 * 1024 ** 3;

async function fixture(t) {
  const appRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-activation-')));
  t.after(() => fs.rm(appRoot, { recursive: true, force: true }));
  const server = path.join(appRoot, 'server'), transferRoot = path.join(server, '.private/driver-audit-native-transfer');
  const folder = path.join(transferRoot, sessionId), syncRoot = path.join(server, '.private/driver-audits', 'b'.repeat(64));
  const sourceRoot = path.join(server, '.private/driver-audit-source', sourceSha), cache = path.join(syncRoot, 'work/archive-cache');
  const operators = path.join(server, '.private/driver-audit-native-operators');
  for (const directory of [folder, sourceRoot, cache, operators]) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const save = async (name, value) => { const bytes = Buffer.isBuffer(value) ? value : json(value);
    await fs.writeFile(path.join(folder, name), bytes, { mode: 0o600 }); return hash(bytes); };
  const before = Buffer.from('DRIVER_AUDIT_ENABLED=1\nDRIVER_AUDIT_IMPORT_ENABLED=0\nDRIVER_AUDIT_REPLICA_GC_ENABLED=0\nPRIVATE_SETTING="fictional secret unchanged"\n');
  const base = Buffer.from('MONGODB_URI=mongodb://fictional.invalid/existing\n');
  const after = Buffer.concat([before, Buffer.from('DRIVER_AUDIT_DATA_STORE=mongo\nDRIVER_AUDIT_NATIVE_CAPACITY_BYTES=' + capacity
    + '\nMATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY=' + cache + '\n')]);
  const envFile = path.join(server, '.env.local');
  await fs.writeFile(path.join(server, '.env'), base, { mode: 0o600 }); await fs.writeFile(envFile, before, { mode: 0o600 });
  const config = { root: sourceRoot, file: path.join(sourceRoot, 'source.json'), runtimeRoot: path.join(sourceRoot, 'runtime'),
    manifestSha256: sourceSha, configSha256: 'c'.repeat(64), environmentReference: { sha256: 'd'.repeat(64) },
    dataStore: 'mongo', archiveCacheDirectory: cache, nodeExecutable: process.execPath, nodeVersion: process.version };
  const profile = { version: 2, targetDatabase: 'existing', capacityBytes: capacity, syncRoot, runtimeRoot: config.runtimeRoot,
    runtimeSha256: sourceSha, collectorRootsSha256: 'e'.repeat(64), documents: { file: 'documents.private.jsonl.gz', sha256: 'f'.repeat(64) } };
  const profileSha256 = await save('profile.private.json', profile);
  const documents = [{ key: 'collector-state', revision: 9, body_text: '{"fictional":"capture"}' },
    { key: 'review-journal', revision: 4, body_text: '{"fictional":"original reviews"}' }];
  const origin = { sourceSnapshotSha256: '1'.repeat(64), restoreVerificationSha256: '2'.repeat(64) };
  const closure = { sourceRevision: 9, origin }, closureProofSha256 = await save('closure-proof.private.json', closure);
  const verifierCode = Buffer.from('reviewed fictional verifier identity'), verifierSha256 = hash(verifierCode);
  await fs.writeFile(path.join(operators, verifierSha256 + '.mjs'), verifierCode, { mode: 0o600 });
  const nativeParity = { version: 1, status: 'complete-native-parity-verified', verified: true, sessionId, profileSha256,
    closureProofSha256, collectorRootsSha256: profile.collectorRootsSha256, sourceRevision: 9,
    counts: { documents: 2 }, fingerprints: { originals: '3'.repeat(64) }, originSha256: hash(JSON.stringify(origin)),
    bootstrapSha256: '4'.repeat(64), completeByteParity: { verified: true },
    resultsEqual: true, gpsEqual: true, photosEqual: true, reviewHistoryEqual: true, freshOriginalRecordComparisons: true };
  const nativeParityReceiptSha256 = hash(json(nativeParity));
  const parityName = 'parity-' + profileSha256 + '-' + closureProofSha256 + '-' + nativeParityReceiptSha256 + '.private.json';
  await save(parityName, nativeParity);
  const now = Date.now(), stoppedAt = new Date(now - 600_000).toISOString(), backupAt = new Date(now - 60_000).toISOString();
  const release = { version: 1, verified: true, verifiedAt: new Date(now - 30_000).toISOString(),
    validUntil: new Date(now + 600_000).toISOString(), configSha256: config.configSha256, runtimeManifestSha256: sourceSha,
    environmentSha256: config.environmentReference.sha256, nodeVersion: process.version, initialCursor: '2026-11-17T00:00:00.000Z' };
  const backup = { version: 1, verified: true, uncertainAttemptsBaseline: { ...origin, snapshotId: 'fictional-restored-snapshot' } };
  const sourceParity = { version: 1, verified: true, nativeParity: { path: parityName, sha256: nativeParityReceiptSha256 },
    hostQualification: { fixtureSha256: '5'.repeat(64), receiptSha256: '6'.repeat(64) } };
  const fence = { version: 1, verified: true, mode: 'reporting-database-capability-v1', admissionBlockedAt: stoppedAt,
    validUntil: release.validUntil, checkpoint: { path: 'checkpoint.private.json', sha256: await save('checkpoint.private.json', {
      version: 1, verified: true, capturedAt: backupAt, collectorRevision: 9, reviewRevision: 4, ...origin,
      snapshotId: backup.uncertainAttemptsBaseline.snapshotId }) } };
  for (const [kind, name, value] of [['backup', 'source-backup.private.json', backup], ['parity', 'source-parity.private.json', sourceParity],
    ['credentials', 'source-credentials.private.json', { version: 1, verified: true }], ['sourceFence', 'source-fence.private.json', fence]]) {
    release[kind] = { path: name, sha256: await save(name, value) };
  }
  const sourceReleaseSha256 = await save('source-release.private.json', release);
  const syncConfig = { version: 1, root: syncRoot, codeRoot: path.join(syncRoot, 'builder'), baselineRoot: path.join(syncRoot, 'baseline'),
    rendererBuild: { path: path.join(syncRoot, 'baseline/build.private.json') }, journals: { path: path.join(syncRoot, 'validation-journals.private.json') } };
  await fs.writeFile(path.join(syncRoot, 'sync.json'), json(syncConfig), { mode: 0o600 });
  const settingsPlan = { version: 1, operation: 'prepare-native-settings', applicationCommit: commit, profileSha256, targetDatabase: 'existing',
    sourceManifestSha256: sourceSha, sourceConfigSha256: config.configSha256, archiveCacheDirectory: cache,
    syncConfigSha256: hash(json(syncConfig)), servingHeadSha256: hash('null'), workspacePointerSha256: hash('null'),
    authority: { status: 'staging', importSha256: profileSha256, writeFence: 7 }, baseSha256: hash(base), beforeSha256: hash(before),
    afterSha256: hash(after), nativeSettingsApplied: false, requiresFinalFenceAndParity: true };
  await save('native-settings-before.private.env', before); await save('native-settings-after.private.env', after);
  const settingsPlanSha256 = await save('native-settings-plan.private.json', settingsPlan);
  const template = { version: 1, profileSha256, closureProofSha256, nativeParityReceiptSha256, parityVerifierSha256: verifierSha256,
    sourceReleaseSha256, settingsPlanSha256 };
  let templateSha256 = await save('activation-template.private.json', template);
  const state = { version: 1, sessionId, targetDatabase: 'existing', capacityBytes: capacity, inventorySha256: '6'.repeat(64),
    createdAt: now - 1000, plan: { inventorySha256: '6'.repeat(64), objectCount: 1, objectBytes: 100 } };
  await save('session.private.json', state);
  await save('received.private.json', { version: 1, status: 'transfer-received', verified: true, authorityChanged: false,
    sessionId, targetDatabase: 'existing', inventorySha256: state.inventorySha256, objects: 1, bytes: 100,
    completedAt: new Date(now).toISOString(), inputFiles: [{ name: 'activation-template.private.json', sha256: templateSha256, bytes: json(template).length }] });
  let authority = { status: 'staging', importSha256: profileSha256, writeFence: 7 }, locked = false, failAt, parityValid = true, head = null;
  const events = [], entries = [{ name: 'matter-delivery-api', pm_id: 1, pm2_env: { status: 'online', pm_cwd: appRoot,
    pm_exec_path: path.join(server, 'server.js') } }, { name: 'matter-driver-audit-sync', pm_id: 2,
    pm2_env: { status: 'stopped', pm_cwd: server, pm_exec_path: path.join(server, 'scripts/driverAuditSync.js'),
      args: ['--config', path.join(syncRoot, 'sync.json')] } }];
  const db = { databaseName: 'existing', async command() { return { setName: 'fixture', logicalSessionTimeoutMinutes: 30 }; }, collection(name) { return { async findOne(query) {
    if (name === 'driverAuditNativeControl') return query._id === 'authority' ? structuredClone(authority) : { limitBytes: capacity, usedBytes: 1 };
    return name === 'driverAuditControl' && query._id === 'head' ? head : null;
  }, async updateOne(query, update) {
    assert.equal(name, 'driverAuditNativeControl');
    const match = Object.entries(query).every(([key, value]) => key === '_id' || key === '$expr'
      ? key !== '$expr' || authority.writeFence === authority.verifiedWriteFence : authority[key] === value);
    if (!match) return { matchedCount: 0 };
    events.push(update.$set?.status === 'active' ? 'authority-active' : 'authority-parity');
    Object.assign(authority, update.$set); return { matchedCount: 1 };
  } }; } };
  const adapters = { platform: 'linux', env: { MONGODB_URI: 'mongodb://fictional.invalid/existing' },
    async exec(file, args, options) {
      if (file === 'git') return { stdout: args[0] === 'rev-parse' ? commit + '\n' : '' };
      if (file === 'pm2') {
        if (args[0] === 'jlist') return { stdout: JSON.stringify(entries) };
        events.push(args.join(' '));
        if (args[0] === 'restart') { assert.equal(args[1], 'matter-delivery-api'); assert.equal(authority.status, 'active');
          assert.equal(dotenv.parse(await fs.readFile(envFile)).DRIVER_AUDIT_DATA_STORE, 'mongo'); }
        if (failAt === 'api' && args[0] === 'restart') throw Error('fictional private failure');
        return { stdout: '' };
      }
      const script = path.basename(args[0]); events.push(script + ':' + (args[1] || ''));
      if (script === 'driverAuditDeploy.js') {
        entries[1].pm2_env.status = args[1] === 'deploy-worker-resume' ? 'online' : 'stopped'; return { stdout: 'resumed\n' };
      }
      assert.equal(options.env.DRIVER_AUDIT_DATA_STORE, 'mongo');
      if (script === 'driverAuditSourceDeploy.js') {
        if (args[1] === 'audit-source-start' && failAt === 'source') throw Error('fictional source failure');
        const starting = ['audit-source-start', 'audit-source-resume'].includes(args[1]);
        let source = entries.find(row => row.name === 'matter-driver-audit-source');
        if (starting && !source) {
          source = { name: 'matter-driver-audit-source', pm_id: 3, pm2_env: { status: 'online', pm_cwd: server,
            pm_exec_path: path.join(server, 'scripts/driverAuditSource.js'), args: ['--config', config.file] } };
          entries.push(source);
        }
        if (source) source.pm2_env.status = starting ? 'online' : 'stopped';
        if (args[1] === 'audit-source-start') await fs.writeFile(path.join(sourceRoot, 'deployment-source.private.json'), json({
          version: 1, verified: true, status: 'active', configSha256: config.configSha256, manifestSha256: config.manifestSha256,
          verifiedAt: new Date().toISOString(), release: { path: path.join(folder, 'source-release.private.json'), sha256: sourceReleaseSha256 },
        }), { mode: 0o600 });
        return { stdout: JSON.stringify({ status: args[1] === 'audit-source-resume' ? 'resumed' : starting ? 'started' : 'paused' }) };
      }
      assert.equal(script, 'customerServiceDeploy.js'); return { stdout: '{}' };
    },
    async load(name) {
      if (name === 'loadEnv.js') return {};
      if (name === 'node_modules/dotenv/lib/main.js') return { default: dotenv };
      if (name === 'node_modules/mongoose/index.js') return { default: { createConnection() { return { db, getClient: () => ({}), async asPromise() {}, async close() {} }; } } };
      if (name === 'services/driverAuditSource.js') return { readPrivateDriverAuditSource, requirePrivateDriverAuditSourceDirectory,
        async readDriverAuditSourceConfig() { return config; }, async verifyDriverAuditSourceRelease(_config, _ref, at = new Date()) {
          assert.equal(_config, config); assert(Date.parse(release.validUntil) > at.getTime()); events.push('source-fence-verified'); return { release }; } };
      if (name === 'scripts/driverAuditSourceQualify.js') return { async requireDriverAuditSourceHostQualification({ supervisor }) {
        const rows = await supervisor(); assert.equal(rows.find(row => row.name === 'matter-driver-audit-sync').pm2_env.status, 'online');
        events.push('linux-qualified');
      }, async withDriverAuditHeldQualificationSync(options, action) {
        return withDriverAuditHeavyWork({ root: path.join(server, '.private/driver-audit-heavy-work'), owner: 'source' }, async () => {
          try { await options.startSync(); return await action(); } finally { await options.stopSync(); }
        });
      } };
      if (name === 'services/driverAuditMongoImport.js') return { verifyDriverAuditMongoAuthority, activateDriverAuditMongoAuthority };
      if (name === 'services/driverAuditLiveImport.js') return { async *readDriverAuditImportRows() { yield* documents; } };
      if (name === 'services/driverAuditMongoArchive.js') return { createDriverAuditMongoArchive: () => ({}) };
      if (name === 'services/driverAuditMongoRpc.js') return { createDriverAuditMongoRpc: () => async (_name, args) => documents.find(row => row.key === args.p_key) };
      if (name === 'services/driverAuditDataBackend.js') return { async createDriverAuditDataBackend() { assert.equal(authority.status, 'active');
        return { kind: 'mongo', archiveCacheDirectory: cache }; } };
      if (name === 'vendor/driver-audits/integration/hosted/worker-lock.mjs') return { async acquireWorkerLock(file) {
        if (file === path.join(transferRoot, 'operator.lock')) { assert(!locked); locked = true; return { async release() { locked = false; } }; }
        return { async release() {} };
      } };
      throw Error('Unexpected activation dependency');
    }, async verifyParity() { events.push('fresh-complete-parity'); return { ...nativeParity, verified: parityValid }; } };
  return { folder, appRoot, syncRoot, envFile, before, after, events, entries, config, release, template, templateSha256, profileSha256, adapters,
    priorParity: nativeParity, async refreshTemplate() {
      templateSha256 = await save('activation-template.private.json', template);
      const receipt = JSON.parse(await fs.readFile(path.join(folder, 'received.private.json')));
      receipt.inputFiles[0] = { name: 'activation-template.private.json', sha256: templateSha256, bytes: json(template).length };
      await save('received.private.json', receipt);
    },
    authority: () => authority, setAuthority: value => { authority = value; }, head: value => { head = value; }, failure: value => { failAt = value; },
    parityValid: value => { parityValid = value; }, locked: () => locked,
    run: (operation, extra = {}) => runDriverAuditNativeActivation({ operation, appRoot, sessionId, profileSha256,
      templateSha256, expectedSha: commit, ...extra }, adapters) };
}

test('real authority exports require fresh complete parity before settings/API and leave report workers stopped', async t => {
  const f = await fixture(t), result = await f.run('activate-native');
  assert.equal(result.status, 'native-activated'); assert.equal(f.authority().status, 'active');
  assert(f.events.indexOf('fresh-complete-parity') < f.events.indexOf('authority-active'));
  assert(f.events.indexOf('authority-active') < f.events.indexOf('restart matter-delivery-api'));
  assert.deepEqual(await fs.readFile(f.envFile), f.after); assert.equal(f.entries[1].pm2_env.status, 'stopped');
  assert(!f.events.some(value => value.includes('audit-source-start'))); assert.equal(f.locked(), false);
  assert(!JSON.stringify(result).includes('fictional secret'));
});

test('startup uses existing sync/source controls only after committed native authority and preserves it on failure', async t => {
  const f = await fixture(t); await assert.rejects(f.run('start-native'));
  await f.run('activate-native'); f.failure('source');
  await assert.rejects(f.run('start-native'));
  assert.equal(f.authority().status, 'active'); assert.deepEqual(await fs.readFile(f.envFile), f.after);
  assert.equal(f.entries[1].pm2_env.status, 'stopped');
  f.failure(null); const result = await f.run('start-native');
  assert.equal(result.status, 'native-workers-started'); assert.equal(result.liveAcceptancePending, true);
});

test('failed parity cannot select authority, commit settings or start processes', async t => {
  const f = await fixture(t); f.parityValid(false);
  await assert.rejects(f.run('activate-native')); assert.equal(f.authority().status, 'staging');
  assert.deepEqual(await fs.readFile(f.envFile), f.before); assert(!f.events.some(value => value.startsWith('restart')));
});

test('API failure retains active authority and prepared native settings without starting report workers', async t => {
  const f = await fixture(t); f.failure('api'); await assert.rejects(f.run('activate-native'));
  assert.equal(f.authority().status, 'active'); assert.deepEqual(await fs.readFile(f.envFile), f.after);
  assert.equal(f.entries[1].pm2_env.status, 'stopped'); f.failure(null);
  assert.equal((await f.run('activate-native')).status, 'native-activated');
});

test('changed qualification, inputs, authority, environment or active workers cannot reach native selection', async t => {
  for (const reason of ['source-config', 'profile', 'settings', 'base', 'local', 'worker', 'expired-fence',
    'other-import', 'write-fence', 'verifier-missing', 'checkout']) await t.test(reason, async t => {
    const f = await fixture(t);
    if (reason === 'source-config') f.config.configSha256 = '9'.repeat(64);
    if (reason === 'profile') await fs.appendFile(path.join(f.folder, 'profile.private.json'), ' ');
    if (reason === 'settings') await fs.appendFile(path.join(f.folder, 'native-settings-after.private.env'), '# independent edit\n');
    if (reason === 'base') await fs.appendFile(path.join(f.appRoot, 'server/.env'), '# independent edit\n');
    if (reason === 'local') await fs.appendFile(f.envFile, '# independent edit\n');
    if (reason === 'worker') f.entries[1].pm2_env.status = 'online';
    if (reason === 'expired-fence') f.release.validUntil = new Date(Date.now() - 1).toISOString();
    if (reason === 'other-import') f.setAuthority({ ...f.authority(), importSha256: '9'.repeat(64) });
    if (reason === 'write-fence') f.setAuthority({ ...f.authority(), writeFence: 8 });
    if (reason === 'verifier-missing') {
      delete f.adapters.verifyParity;
      await fs.unlink(path.join(f.appRoot, 'server/.private/driver-audit-native-operators', f.template.parityVerifierSha256 + '.mjs'));
    }
    const actualBefore = await fs.readFile(f.envFile);
    await assert.rejects(f.run('activate-native', reason === 'checkout' ? { expectedSha: '9'.repeat(40) } : {}));
    assert.equal(f.authority().status, 'staging'); assert.deepEqual(await fs.readFile(f.envFile), actualBefore);
    assert(!f.events.includes('authority-active')); assert(!f.events.some(value => value.startsWith('restart '))); assert.equal(f.locked(), false);
  });
});

test('parity drift or a changed staging fence during the real authority callback prevents activation', async t => {
  for (const reason of ['semantic-count', 'write-fence', 'expired-during-parity']) await t.test(reason, async t => {
    const f = await fixture(t), verify = f.adapters.verifyParity;
    f.adapters.verifyParity = async () => {
      const result = await verify();
      if (reason === 'semantic-count') result.counts = { documents: 0 };
      if (reason === 'write-fence') f.setAuthority({ ...f.authority(), writeFence: 8 });
      if (reason === 'expired-during-parity') f.release.validUntil = new Date(Date.now() - 1).toISOString();
      return result;
    };
    await assert.rejects(f.run('activate-native'));
    assert.equal(f.authority().status, 'staging'); assert.deepEqual(await fs.readFile(f.envFile), f.before);
    assert(!f.events.includes('authority-active')); assert.equal(f.locked(), false);
  });
});

test('an independent managed disable at the actual native environment commit is retained without reversing authority', async t => {
  const f = await fixture(t), load = f.adapters.load;
  f.adapters.load = async name => {
    const value = await load(name);
    if (name !== 'services/driverAuditMongoImport.js') return value;
    return { ...value, async activateDriverAuditMongoAuthority(args) {
      const result = await value.activateDriverAuditMongoAuthority(args);
      await fs.writeFile(f.envFile, f.before.toString().replace('DRIVER_AUDIT_ENABLED=1', 'DRIVER_AUDIT_ENABLED=0'), { mode: 0o600 });
      return result;
    } };
  };
  await assert.rejects(f.run('activate-native'), /effective settings changed/);
  assert.equal(f.authority().status, 'active'); assert.equal(dotenv.parse(await fs.readFile(f.envFile)).DRIVER_AUDIT_ENABLED, '0');
  assert(!f.events.some(value => value.startsWith('restart '))); assert.equal(f.entries[1].pm2_env.status, 'stopped');
});

test('worker startup rechecks actual online registrations instead of trusting a successful child receipt', async t => {
  const f = await fixture(t); await f.run('activate-native');
  const exec = f.adapters.exec;
  f.adapters.exec = async (file, args, options) => {
    const result = await exec(file, args, options);
    if (path.basename(args[0]) === 'driverAuditSourceDeploy.js' && args[1] === 'audit-source-start') {
      f.entries.find(row => row.name === 'matter-driver-audit-source').pm2_env.status = 'stopped';
    }
    return result;
  };
  await assert.rejects(f.run('start-native'), /managed report workers/);
  assert.equal(f.entries[1].pm2_env.status, 'stopped'); assert.equal(f.authority().status, 'active');
  assert.equal((await fs.readdir(f.folder)).some(name => name.startsWith('native-workers-started-')), false);
});

test('source pause failure still attempts builder pause and saves the held process state', async t => {
  const f = await fixture(t); await f.run('activate-native'); f.failure('source');
  const exec = f.adapters.exec;
  f.adapters.exec = (file, args, options) => path.basename(args[0]) === 'driverAuditSourceDeploy.js' && args[1] === 'deploy-source-pause'
    ? Promise.reject(Error('fictional private pause failure')) : exec(file, args, options);
  await assert.rejects(f.run('start-native'), error => { assert.equal(error.phase, 'worker-pause-recovery');
    assert(!error.message.includes('fictional private')); return true; });
  assert.equal(f.entries[1].pm2_env.status, 'stopped'); assert(f.events.includes('driverAuditDeploy.js:deploy-worker-pause'));
  assert.equal(f.authority().status, 'active'); assert.equal(f.locked(), false);
});

test('staging head drift blocks activation, while a retry retains a newer report already published under active native authority', async t => {
  const f = await fixture(t), newer = { head: { version: 1, sourceRevision: 10, sourceBodySha256: '8'.repeat(64) } };
  f.head(newer); await assert.rejects(f.run('activate-native'), /head changed/); assert.equal(f.authority().status, 'staging');
  f.head(null); await f.run('activate-native'); f.head(newer);
  const result = await f.run('start-native'); assert.equal(result.admittedHeadSha256, hash(JSON.stringify(newer)));
  assert.equal(f.authority().status, 'active'); assert.deepEqual(await fs.readFile(f.envFile), f.after);
});

test('the default path loads the hash-pinned host verifier module and wires fresh native comparison dependencies', async t => {
  const f = await fixture(t), module = Buffer.from(`
    export function nativeDriverAuditTargetIdentity(uri, database) {
      if (!uri.startsWith('mongodb://') || database !== 'existing') throw Error('wrong target');
      return '${'7'.repeat(64)}';
    }
    export async function verifyDriverAuditNativeParity(args) {
      const rows = await Array.fromAsync(args.readRows(JSON.parse(args.profileBytes).documents));
      if (rows.length !== 2 || typeof args.readText !== 'function' || typeof args.collectCensus !== 'function'
        || typeof args.readArchiveAttestation !== 'function' || !/^[a-f0-9]{64}$/.test(args.implementationIdentities.archiveSha256)
        || args.targetIdentitySha256 !== '${'7'.repeat(64)}') throw Error('missing fresh native dependency');
      return ${JSON.stringify(f.priorParity)};
    }
  `);
  delete f.adapters.verifyParity;
  f.template.parityVerifierSha256 = hash(module);
  await fs.writeFile(path.join(f.appRoot, 'server/.private/driver-audit-native-operators', hash(module) + '.mjs'), module, { mode: 0o600 });
  for (const file of ['services/driverAuditMongoArchive.js', 'scripts/driverAuditMongoMigrate.js']) {
    await fs.mkdir(path.dirname(path.join(f.appRoot, 'server', file)), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(f.appRoot, 'server', file), 'fictional app implementation identity', { mode: 0o600 });
  }
  await f.refreshTemplate();
  const load = f.adapters.load;
  f.adapters.load = async name => {
    if (name === 'services/driverAuditMongoText.js') return { createDriverAuditMongoTextReader: () => async () => 'fictional original text' };
    if (name === 'services/driverAuditTechnicalState.js') return { createDriverAuditTechnicalState: () => ({ read: async () => 'fictional original technical state' }) };
    if (name === 'services/driverAuditLiveImport.js') return { ...await load(name), isDriverAuditTechnicalKey: () => false,
      collectDriverAuditReceiptRoots: async () => { throw Error('the public parity fixture only checks the callback contract'); } };
    return load(name);
  };
  assert.equal((await f.run('activate-native')).status, 'native-activated');
  assert.equal(f.authority().status, 'active');
});

async function inFuture(milliseconds, operation) {
  const OriginalDate = globalThis.Date, now = OriginalDate.now() + milliseconds;
  globalThis.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  try { return await operation(); } finally { globalThis.Date = OriginalDate; }
}

test('exact active API recovery uses accepted authority time while a first source start still requires a fresh fence', async t => {
  const f = await fixture(t); f.failure('api'); await assert.rejects(f.run('activate-native')); f.failure(null);
  await inFuture(2 * 60 * 60_000, async () => {
    assert.equal((await f.run('activate-native')).status, 'native-activated');
    const before = f.events.filter(value => value === 'driverAuditDeploy.js:deploy-worker-resume').length;
    await assert.rejects(f.run('start-native'));
    assert.equal(f.events.filter(value => value === 'driverAuditDeploy.js:deploy-worker-resume').length, before);
    assert.equal(f.authority().status, 'active');
  });
});

test('an already admitted stopped source resumes at its recorded activation time and retains newer native report evidence', async t => {
  const f = await fixture(t); await f.run('activate-native'); await f.run('start-native');
  f.entries[1].pm2_env.status = 'stopped'; f.entries.find(row => row.name === 'matter-driver-audit-source').pm2_env.status = 'stopped';
  f.head({ head: { sourceRevision: 10, sourceBodySha256: '9'.repeat(64) } });
  await inFuture(2 * 60 * 60_000, async () => {
    assert.equal((await f.run('start-native')).status, 'native-workers-started');
    assert(f.events.includes('driverAuditSourceDeploy.js:audit-source-resume'));
    assert.equal((await fs.readdir(f.folder)).filter(name => name.startsWith('native-workers-started-')).length, 2);
    assert.equal(f.authority().status, 'active');
  });
});

test('real SQLite locks permit only the held online verification cycle and block queued work until it is stopped', async t => {
  const f = await fixture(t), load = f.adapters.load, exec = f.adapters.exec;
  const file = path.join(path.dirname(f.syncRoot), 'sync-worker.lock'), heavyRoot = path.join(f.appRoot, 'server/.private/driver-audit-heavy-work');
  let runningLock, queued, controller, cycles = 0, unapprovedWork = 0;
  f.adapters.load = async name => name === 'vendor/driver-audits/integration/hosted/worker-lock.mjs'
    ? { acquireWorkerLock } : load(name);
  f.adapters.exec = async (program, args, options) => {
    if (path.basename(args[0]) === 'driverAuditDeploy.js' && args[1] === 'deploy-worker-resume') {
      assert.equal(options.env.DRIVER_AUDIT_DATA_STORE, undefined, 'pre-authority sync must use its real legacy selection');
      runningLock = await acquireWorkerLock(file); controller = new AbortController(); cycles++;
      let waiting;
      const ready = new Promise(resolve => { waiting = resolve; });
      queued = withDriverAuditHeavyWork({ root: heavyRoot, owner: 'sync', pollMs: 5, signal: controller.signal,
        onWaiting: waiting }, async () => { unapprovedWork++; });
      await ready;
    }
    if (path.basename(args[0]) === 'driverAuditDeploy.js' && args[1] === 'deploy-worker-pause' && runningLock) {
      controller.abort(); await assert.rejects(queued, { code: 'AUDIT_ADMISSION_CANCELLED' });
      await runningLock.release(); runningLock = null;
    }
    return exec(program, args, options);
  };
  t.after(async () => { controller?.abort(); await runningLock?.release(); });
  assert.equal((await f.run('activate-native')).status, 'native-activated');
  assert.equal(cycles, 1); assert.equal(unapprovedWork, 0); assert.equal(runningLock, null);
  const released = await acquireWorkerLock(file); await released.release();
  assert.equal(f.entries[1].pm2_env.status, 'stopped');
});

async function supplementFixture(t) {
  const f = await fixture(t), sourceSessionId = '00000000-0000-4000-8000-000000000019';
  const sourceFolder = path.join(path.dirname(f.folder), sourceSessionId); await fs.mkdir(sourceFolder, { mode: 0o700 });
  const templateBytes = await fs.readFile(path.join(f.folder, 'activation-template.private.json'));
  const input = { name: 'activation-template.private.json', sha256: hash(templateBytes), bytes: templateBytes.length };
  const supplement = { version: 1, kind: 'native-proof-supplement-v1', targetSessionId: sessionId,
    profileSha256: f.profileSha256, files: [input] }, supplementBytes = json(supplement);
  const files = [{ name: 'supplement-template.private.json', sha256: hash(supplementBytes), bytes: supplementBytes.length }, input];
  const state = { version: 1, sessionId: sourceSessionId, targetDatabase: 'existing', capacityBytes: capacity,
    inventorySha256: '8'.repeat(64), createdAt: Date.now() - 1000,
    plan: { inventorySha256: '8'.repeat(64), objectCount: 2, objectBytes: files.reduce((n, row) => n + row.bytes, 0) } };
  const received = { version: 1, status: 'transfer-received', verified: true, authorityChanged: false, sessionId: sourceSessionId,
    targetDatabase: 'existing', inventorySha256: state.inventorySha256, objects: 2, bytes: state.plan.objectBytes,
    completedAt: new Date().toISOString(), inputFiles: files };
  const metadata = { version: 1, kind: 'native-activation-template-provenance-v1', targetSessionId: sessionId,
    profileSha256: f.profileSha256, sourceSessionId, sourceSessionSha256: hash(json(state)), sourceReceivedSha256: hash(json(received)),
    input, supplementSha256: hash(supplementBytes) };
  for (const [name, bytes] of [['session.private.json', json(state)], ['received.private.json', json(received)],
    ['supplement-template.private.json', supplementBytes], ['activation-template.private.json', templateBytes]]) {
    await fs.writeFile(path.join(sourceFolder, name), bytes, { mode: 0o600 });
  }
  const targetReceived = JSON.parse(await fs.readFile(path.join(f.folder, 'received.private.json')));
  targetReceived.inputFiles = [{ name: 'documents.private.jsonl.gz', sha256: 'f'.repeat(64), bytes: 100 }];
  const originalTargetBytes = json(targetReceived); await fs.writeFile(path.join(f.folder, 'received.private.json'), originalTargetBytes, { mode: 0o600 });
  await fs.writeFile(path.join(f.folder, 'activation-template-source.private.json'), json(metadata), { mode: 0o600 });
  return { ...f, sourceFolder, metadata, originalTargetBytes };
}

test('supplemental template provenance verifies its actual encrypted source session without altering the original receipt', async t => {
  const f = await supplementFixture(t); assert.equal((await f.run('activate-native')).status, 'native-activated');
  assert.deepEqual(await fs.readFile(path.join(f.folder, 'received.private.json')), f.originalTargetBytes);
});

test('supplemental provenance rejects mismatched target, source receipt, inventory or template bytes before selection', async t => {
  for (const reason of ['target', 'session', 'received', 'supplement', 'source-template', 'missing-proof', 'source-mode']) await t.test(reason, async t => {
    const f = await supplementFixture(t);
    if (reason === 'target') {
      f.metadata.targetSessionId = '00000000-0000-4000-8000-000000000029';
      await fs.writeFile(path.join(f.folder, 'activation-template-source.private.json'), json(f.metadata), { mode: 0o600 });
    }
    if (reason === 'session') await fs.appendFile(path.join(f.sourceFolder, 'session.private.json'), ' ');
    if (reason === 'received') await fs.appendFile(path.join(f.sourceFolder, 'received.private.json'), ' ');
    if (reason === 'supplement') await fs.appendFile(path.join(f.sourceFolder, 'supplement-template.private.json'), ' ');
    if (reason === 'source-template') await fs.appendFile(path.join(f.sourceFolder, 'activation-template.private.json'), ' ');
    if (reason === 'missing-proof') await fs.unlink(path.join(f.folder, 'activation-template-source.private.json'));
    if (reason === 'source-mode') await fs.chmod(f.sourceFolder, 0o750);
    await assert.rejects(f.run('activate-native')); assert.equal(f.authority().status, 'staging');
    assert.deepEqual(await fs.readFile(f.envFile), f.before); assert(!f.events.includes('authority-active'));
  });
});

test('activation consumes the actual proof-stager provenance without changing original transfer metadata', async t => {
  const f = await supplementFixture(t);
  await fs.unlink(path.join(f.folder, 'activation-template-source.private.json'));
  const { runDriverAuditNativeProofs } = await import('./driver-audit-native-proofs.mjs');
  const result = await runDriverAuditNativeProofs({ operation: 'stage-native-proofs', sessionId: path.basename(f.sourceFolder),
    templateSha256: f.metadata.supplementSha256, expectedSha: commit, appRoot: f.appRoot }, f.adapters);
  assert.equal(result.status, 'native-proofs-staged');
  const source = JSON.parse(await fs.readFile(path.join(f.folder, 'activation-template-source.private.json')));
  assert.deepEqual(source, f.metadata);
  assert.equal((await f.run('activate-native')).status, 'native-activated');
  assert.deepEqual(await fs.readFile(path.join(f.folder, 'received.private.json')), f.originalTargetBytes);
});
