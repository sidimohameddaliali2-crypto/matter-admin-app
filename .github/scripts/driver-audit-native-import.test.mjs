import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { gunzipSync } from 'node:zlib';
import { generateKeyPairSync } from 'node:crypto';
import { sealTransferSecrets, openTransferSecrets } from '../../server/services/driverAuditTransferCodec.js';
import { readPrivateDriverAuditSource, requirePrivateDriverAuditSourceDirectory, readDriverAuditSourceConfig } from '../../server/services/driverAuditSource.js';
import { stageDriverAuditSource } from '../../server/scripts/driverAuditSourceStage.js';
import { readDriverAuditImportRows } from '../../server/services/driverAuditLiveImport.js';
import { verifyAuditBuilder } from '../../server/vendor/driver-audits/integration/cloud/driver-audit-handoff.mjs';
import { runDriverAuditNativeImport, NATIVE_IMPORT_FILES, NATIVE_IMPORT_SOURCE_MANIFEST,
  NATIVE_IMPORT_CAPACITY_BYTES } from './driver-audit-native-import.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const commit = 'a'.repeat(40), censusSha = 'b'.repeat(64), sessionId = '00000000-0000-4000-8000-000000000001';

async function fixture(t) {
  const appRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-import-')));
  t.after(() => fs.rm(appRoot, { recursive: true, force: true }));
  const server = path.join(appRoot, 'server'), root = path.join(server, '.private/driver-audit-native-transfer');
  const folder = path.join(root, sessionId), syncRoot = path.join(server, '.private/driver-audits', 'c'.repeat(64));
  const sourceRoot = path.join(server, '.private/driver-audit-source', NATIVE_IMPORT_SOURCE_MANIFEST);
  for (const directory of [folder, syncRoot, sourceRoot]) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const save = (name, value) => fs.writeFile(path.join(folder, name), JSON.stringify(value), { mode: 0o600 });
  await fs.writeFile(path.join(syncRoot, 'sync.json'), JSON.stringify({ version: 1, root: syncRoot,
    codeRoot: path.join(syncRoot, 'builder'), baselineRoot: path.join(syncRoot, 'baseline'),
    rendererBuild: { path: path.join(syncRoot, 'baseline/build.private.json') },
    journals: { path: path.join(syncRoot, 'validation-journals.private.json') } }), { mode: 0o600 });
  await fs.writeFile(path.join(sourceRoot, 'source.json'), JSON.stringify({ version: 1, root: sourceRoot,
    runtimeRoot: path.join(sourceRoot, 'runtime'), manifestSha256: NATIVE_IMPORT_SOURCE_MANIFEST }), { mode: 0o600 });
  const template = { version: 2, capacityBytes: NATIVE_IMPORT_CAPACITY_BYTES, receiptInput: 'full' };
  for (const [key, file] of Object.entries(NATIVE_IMPORT_FILES)) {
    const bytes = key === 'bookkeepingBackup' ? Buffer.from('{"verified":true}')
      : gzipSync(Buffer.from(JSON.stringify(key === 'documents'
        ? { key: 'collector-state', revision: 7, body_text: '{"fictional":"private body"}' } : { fixture: key }) + '\n'));
    await fs.writeFile(path.join(folder, file), bytes, { mode: 0o600 });
    template[key] = { file, sha256: hash(bytes) };
  }
  await save('profile-template.private.json', template);
  const targetDatabase = 'fictional_existing';
  const state = { version: 1, sessionId, targetDatabase, capacityBytes: NATIVE_IMPORT_CAPACITY_BYTES,
    inventorySha256: 'd'.repeat(64), createdAt: Date.now() - 1000, plan: {} };
  const receipt = { version: 1, status: 'transfer-received', verified: true, sessionId, targetDatabase,
    inventorySha256: state.inventorySha256, authorityChanged: false, completedAt: new Date().toISOString() };
  const refresh = async () => {
    const names = ['profile-template.private.json', ...Object.values(NATIVE_IMPORT_FILES)];
    receipt.inputFiles = await Promise.all(names.map(async name => {
      const bytes = await fs.readFile(path.join(folder, name)); return { name, bytes: bytes.length, sha256: hash(bytes) };
    }));
    receipt.objects = names.length; receipt.bytes = receipt.inputFiles.reduce((sum, row) => sum + row.bytes, 0);
    state.plan = { inventorySha256: state.inventorySha256, objectCount: receipt.objects, objectBytes: receipt.bytes };
    await save('session.private.json', state); await save('received.private.json', receipt);
  };
  await refresh();
  const entries = [{ name: 'matter-delivery-api', pm2_env: { status: 'online' } },
    { name: 'matter-driver-audit-sync', pm2_env: { status: 'stopped', pm_cwd: server,
      pm_exec_path: path.join(server, 'scripts/driverAuditSync.js'), args: ['--config', path.join(syncRoot, 'sync.json')] } }];
  let authority = null, stage = null, locked = false, closes = 0, actualCensus = censusSha;
  const cli = [], calls = [];
  const db = { databaseName: targetDatabase, collection: name => ({ findOne: async query => name === 'driverAuditNativeControl'
    ? query._id === 'authority' ? authority : { limitBytes: NATIVE_IMPORT_CAPACITY_BYTES, usedBytes: 0 } : stage }) };
  const archivedCode = new Map();
  const connection = { db, getClient: () => ({ fixture: true }), async asPromise() {}, async close() { closes++; } };
  const adapters = { platform: 'linux', env: { MONGODB_URI: 'mongodb://fictional.invalid/fictional_existing' },
    async exec(file, args, options) {
      calls.push({ file, args, options });
      if (file === 'git') return { stdout: commit + '\n' };
      if (file === 'pm2') return { stdout: JSON.stringify(entries) };
      assert.equal(file, process.execPath);
      if (args.length === 1 && args[0] === '--version') return { stdout: process.version + '\n' };
      assert.equal(args[0], path.join(server, 'scripts/driverAuditMongoMigrate.js'));
      assert.equal(args[2], path.join(folder, 'profile.private.json'));
      cli.push(args);
      const status = { plan: 'planned', stage: 'staged', verify: 'staged-data-verified' }[args[1]];
      return { stdout: JSON.stringify({ status, importSha256: args[3], collectorRootsSha256: actualCensus,
        objects: 2, missingObjects: 0, missingBytes: 0, availableAllowanceBytes: NATIVE_IMPORT_CAPACITY_BYTES,
        activationPending: true, archiveClosurePending: true, resultsEqual: true,
        privateBodyMustNeverLeak: 'fictional private payload' }) };
    },
    async load(name) {
      if (name === 'loadEnv.js') return {};
      if (name === 'services/driverAuditTransferCodec.js') return { sealTransferSecrets };
      if (name === 'scripts/driverAuditSourceStage.js') return { stageDriverAuditSource };
      if (name === 'services/driverAuditMongoArchive.js') return { createDriverAuditMongoArchive({ capacityBytes }) {
        assert.equal(capacityBytes, NATIVE_IMPORT_CAPACITY_BYTES);
        return { async putVerifiedObject(key, bytes) { archivedCode.set(key, Buffer.from(bytes));
          return { key, sha256: hash(bytes), bytes: bytes.length, verified: true }; },
        async readObject(key, { maxBytes }) { const bytes = archivedCode.get(key); assert(bytes.length <= maxBytes); return [bytes]; } };
      } };
      if (name === 'node_modules/mongoose/index.js') return { default: { createConnection(uri) {
        assert.equal(uri, adapters.env.MONGODB_URI); return connection;
      } } };
      if (name === 'vendor/driver-audits/integration/hosted/worker-lock.mjs') return { async acquireWorkerLock(file) {
        if (file === path.join(server, '.private/driver-audit-source/source-deployment.lock')) return { async release() {} };
        assert.equal(file, path.join(root, 'operator.lock')); assert.equal(locked, false, 'operator already locked'); locked = true;
        return { async release() { locked = false; } };
      } };
      if (name === 'services/driverAuditSource.js') return { readPrivateDriverAuditSource, requirePrivateDriverAuditSourceDirectory, readDriverAuditSourceConfig,
        async verifyDriverAuditSource({ runtimeRoot, expectedSha256 }) {
          assert.equal(runtimeRoot, path.join(sourceRoot, 'runtime')); assert.equal(expectedSha256, NATIVE_IMPORT_SOURCE_MANIFEST);
        } };
      if (name === 'services/driverAuditLiveImport.js') return { readDriverAuditImportRows,
        async collectDriverAuditReceiptRoots(input) {
          assert.equal(input.db, db); assert.equal(input.syncRoot, syncRoot);
          assert.equal(input.documents[0].key, 'collector-state'); return { sha256: actualCensus, collectorRevisions: [7] };
        } };
      throw Error('Unexpected host module ' + name);
    } };
  const run = async (operation, extra = {}) => runDriverAuditNativeImport({ operation, appRoot, sessionId,
    expectedSha: commit, templateSha256: extra.templateSha256 ?? hash(await fs.readFile(path.join(folder, 'profile-template.private.json'))), ...extra }, adapters);
  return { appRoot, folder, syncRoot, sourceRoot, state, receipt, template, entries, adapters, run, save, refresh, cli, calls, archivedCode,
    authority: value => { authority = value; }, stage: value => { stage = value; }, census: value => { actualCensus = value; },
    locked: () => locked, closes: () => closes };
}

test('creates a host-bound private profile and routes plan/stage/verify through the exact app CLI without activating', async t => {
  const f = await fixture(t), created = await f.run('create-profile');
  const bytes = await fs.readFile(path.join(f.folder, 'profile.private.json')), profile = JSON.parse(bytes);
  assert.equal(created.profileSha256, hash(bytes));
  assert.equal(profile.targetDatabase, 'fictional_existing');
  assert.equal(profile.syncRoot, f.syncRoot);
  assert.equal(profile.runtimeRoot, path.join(f.sourceRoot, 'runtime'));
  assert.equal(profile.runtimeSha256, NATIVE_IMPORT_SOURCE_MANIFEST);
  assert.equal(profile.collectorRootsSha256, censusSha);
  assert.equal(profile.capacityBytes, 16 * 1024 ** 3);
  assert.equal((await fs.stat(path.join(f.folder, 'profile.private.json'))).mode & 0o777, 0o600);
  assert.equal((await f.run('create-profile')).profileSha256, created.profileSha256);
  assert.equal((await f.run('plan-import')).status, 'planned');
  assert.equal((await f.run('stage-import', { profileSha256: created.profileSha256 })).status, 'staged');
  const result = await f.run('verify-import', { profileSha256: created.profileSha256 });
  assert.equal(result.status, 'staged-data-verified');
  assert.equal(result.activationPending, true);
  assert.equal(result.archiveClosurePending, true);
  assert(!JSON.stringify(result).includes('fictional private payload'));
  assert.deepEqual(f.cli.map(args => args[1]), ['plan', 'stage', 'verify']);
  assert.equal(f.closes(), 5); assert.equal(f.locked(), false);
});

test('stage and verification require the exact profile pin and refuse census drift before invoking the CLI', async t => {
  const f = await fixture(t), profile = await f.run('create-profile');
  for (const operation of ['stage-import', 'verify-import']) {
    await assert.rejects(f.run(operation), /profile/i);
    await assert.rejects(f.run(operation, { profileSha256: 'f'.repeat(64) }), /profile/i);
    f.census('e'.repeat(64));
    await assert.rejects(f.run(operation, { profileSha256: profile.profileSha256 }), /root|census|profile/i);
    f.census(censusSha);
  }
  assert.equal(f.cli.length, 0);
});

test('authority, unmanaged processes, incomplete transfers and input tampering fail closed', async t => {
  for (const reason of ['active', 'writer', 'direct-stage', 'database', 'proof', 'hash', 'size', 'symlink', 'source', 'template-path']) {
    await t.test(reason, async t => {
      const f = await fixture(t);
      if (reason === 'active') f.authority({ status: 'active' });
      if (reason === 'writer') f.entries[1].pm2_env.status = 'online';
      if (reason === 'direct-stage') f.stage({ status: 'pending' });
      if (reason === 'database') { f.state.targetDatabase = 'other'; await f.save('session.private.json', f.state); }
      if (reason === 'proof') { f.receipt.verified = false; await f.save('received.private.json', f.receipt); }
      if (reason === 'hash') await fs.appendFile(path.join(f.folder, NATIVE_IMPORT_FILES.documents), 'corrupt');
      if (reason === 'size') { f.receipt.inputFiles[0].bytes++; await f.save('received.private.json', f.receipt); }
      if (reason === 'symlink') {
        const file = path.join(f.folder, NATIVE_IMPORT_FILES.documents), saved = file + '.preserved';
        await fs.rename(file, saved); await fs.symlink(saved, file);
      }
      if (reason === 'source') await fs.unlink(path.join(f.sourceRoot, 'source.json'));
      if (reason === 'template-path') { f.template.syncRoot = '/untrusted/local/private/path';
        await f.save('profile-template.private.json', f.template); await f.refresh(); }
      await assert.rejects(f.run('create-profile'));
      assert.equal(f.cli.length, 0); assert.equal(f.locked(), false);
      await assert.rejects(fs.stat(path.join(f.folder, 'profile.private.json')), { code: 'ENOENT' });
    });
  }
});

test('rejects non-Linux, changed checkout and nonpublic identifiers without opening the database', async t => {
  const f = await fixture(t);
  for (const extra of [{ sessionId: '../escape' }, { expectedSha: 'f'.repeat(40) }, { templateSha256: 'private value' },
    { operation: 'activate' }, { appRoot: path.join(f.appRoot, '..') }]) {
    await assert.rejects(f.run('create-profile', extra));
  }
  f.adapters.platform = 'darwin'; await assert.rejects(f.run('create-profile'));
  assert.equal(f.closes(), 0); assert.equal(f.locked(), false);
});

test('a CLI failure or concurrent census/writer change cannot produce a success receipt and cleanup always releases admission', async t => {
  for (const failure of ['cli', 'census', 'writer', 'receipt']) {
    await t.test(failure, async t => {
      const f = await fixture(t), created = await f.run('create-profile'), original = f.adapters.exec;
      f.adapters.exec = async (...args) => {
        if (args[0] !== process.execPath) return original(...args);
        if (failure === 'cli') throw Error('fictional-private-body-and-connection-string');
        const result = await original(...args);
        if (failure === 'census') f.census('f'.repeat(64));
        if (failure === 'writer') f.entries[1].pm2_env.status = 'online';
        if (failure === 'receipt') result.stdout = JSON.stringify({ status: 'active', privateBody: 'fictional-private-body' });
        return result;
      };
      await assert.rejects(f.run('stage-import', { profileSha256: created.profileSha256 }), error =>
        !String(error).includes('fictional-private') && typeof error.phase === 'string');
      assert.equal(f.locked(), false); assert.equal(f.closes(), 2);
    });
  }
});

test('the same profile may retry a staging import and only an exact prior import can advance', async t => {
  const f = await fixture(t), created = await f.run('create-profile');
  f.authority({ status: 'staging', importSha256: created.profileSha256 });
  assert.equal((await f.run('stage-import', { profileSha256: created.profileSha256 })).status, 'staged');
  f.authority({ status: 'staging', importSha256: 'f'.repeat(64) });
  await assert.rejects(f.run('stage-import', { profileSha256: created.profileSha256 }), /previous import/i);
  assert.equal(f.cli.length, 1);
  const forward = await fixture(t);
  forward.template.previousImportSha256 = 'f'.repeat(64);
  await forward.save('profile-template.private.json', forward.template); await forward.refresh();
  forward.authority({ status: 'staging', importSha256: 'f'.repeat(64) });
  const next = await forward.run('create-profile');
  assert.equal((await forward.run('stage-import', { profileSha256: next.profileSha256 })).status, 'staged');
});

test('the host operator lock excludes concurrent imports from the encrypted-transfer directory', async t => {
  const f = await fixture(t), created = await f.run('create-profile'), original = f.adapters.exec;
  let entered, release;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  f.adapters.exec = async (...args) => {
    if (args[0] === process.execPath) { entered(); await held; }
    return original(...args);
  };
  const first = f.run('stage-import', { profileSha256: created.profileSha256 });
  await enteredPromise;
  await assert.rejects(f.run('plan-import'));
  assert.equal(f.locked(), true);
  release(); await first;
  assert.equal(f.locked(), false);
});

async function diagnosticFixture(t) {
  const f = await fixture(t), baseline = path.join(f.syncRoot, 'baseline');
  await fs.mkdir(baseline, { mode: 0o700 });
  const manifest = Buffer.from(JSON.stringify({ 'fictional.private.json': hash('fictional') }));
  await fs.writeFile(path.join(baseline, 'files.private.json'), manifest, { mode: 0o600 });
  await fs.writeFile(path.join(f.syncRoot, 'seed.json'), JSON.stringify({ version: 1, collectorRevision: 2118,
    sourceBasis: 'd'.repeat(64), manifestSha256: hash(manifest), fixtureSecret: 'fictional-diagnostic-secret' }), { mode: 0o600 });
  const attempt = path.join(f.syncRoot, 'work/attempts/11111111-1111-4111-8111-111111111111');
  await fs.mkdir(path.join(attempt, 'server-data'), { recursive: true, mode: 0o700 });
  const accepted = { version: 1, collectorRevision: 5771, basis: 'b'.repeat(64), sourceBasis: 'b'.repeat(64),
    privateRoot: path.join(attempt, 'server-data'), baselineRoot: baseline, manifestSha256: hash(manifest),
    previous: { privateRoot: baseline, manifestSha256: hash(manifest), basis: 'e'.repeat(64) } };
  await fs.writeFile(path.join(attempt, 'accepted.private.json'), JSON.stringify(accepted), { mode: 0o600 });
  await fs.writeFile(path.join(attempt, 'server-data/files.private.json'), manifest, { mode: 0o600 });
  await fs.writeFile(path.join(f.syncRoot, 'work/current.private.json'), JSON.stringify(accepted), { mode: 0o600 });
  const diagnose = extra => runDriverAuditNativeImport({ operation: 'diagnose-roots', appRoot: f.appRoot,
    sessionId, expectedSha: commit, ...extra }, f.adapters);
  return { ...f, diagnose, accepted, attempt };
}

test('read-only root diagnostics report the actual previous-reference mismatch without relaxing census or loading source/profile inputs', async t => {
  const f = await diagnosticFixture(t);
  await fs.rm(f.sourceRoot, { recursive: true });
  await fs.unlink(path.join(f.folder, 'profile-template.private.json'));
  const result = await f.diagnose();
  assert.equal(result.status, 'roots-diagnosed');
  assert.equal(result.censusVerified, false); assert.equal(result.authorityChanged, false);
  assert.ok(result.candidateRevisions.includes(2118));
  assert.ok(result.mismatches.length > 0 && result.mismatches.length <= 8);
  const mismatch = result.mismatches.find(row => row.targetKind === 'bootstrap');
  assert.equal(mismatch.matches.manifest, true); assert.equal(mismatch.matches.basis, false);
  assert.equal(mismatch.reference.basis, 'e'.repeat(64)); assert.equal(mismatch.target.sourceBasis, 'd'.repeat(64));
  const output = JSON.stringify(result);
  assert(!output.includes(f.appRoot)); assert(!output.includes('fictional-diagnostic-secret'));
  assert.equal(f.cli.length, 0); assert.equal(f.locked(), false);
  await assert.rejects(fs.stat(path.join(f.folder, 'profile.private.json')), { code: 'ENOENT' });
});

test('diagnostic control metadata is paged and RSA-sealed while public mismatch records stay bounded', async t => {
  const f = await diagnosticFixture(t), recipient = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const result = await f.diagnose({ recipientPublicKey: recipient.publicKey.export({ type: 'spki', format: 'pem' }) });
  assert.ok(result.capsule); assert(!JSON.stringify(result).includes('fictional-diagnostic-secret'));
  const payload = openTransferSecrets(recipient.privateKey, result.capsule);
  assert.equal(payload.page, 0); assert.equal(payload.pages, 1);
  const metadata = JSON.parse(gunzipSync(Buffer.from(payload.gzipChunkBase64, 'base64')));
  assert.ok(metadata.controls.some(row => row.value?.fixtureSecret === 'fictional-diagnostic-secret'));
  assert.equal(hash(JSON.stringify(metadata)), payload.metadataSha256);
  await assert.rejects(f.diagnose({ recipientPublicKey: 'invalid recipient' }));
  await assert.rejects(f.diagnose({ diagnosticPage: 999999 }));
});

async function orphanFixture(t) {
  const f = await diagnosticFixture(t), orphan = path.join(f.syncRoot, 'work/attempts/22222222-2222-4222-8222-222222222222');
  for (const name of ['server-data', 'saved-current', 'source']) await fs.mkdir(path.join(orphan, name), { recursive: true, mode: 0o700 });
  const publication = { head: { reportHash: '4'.repeat(64) }, fictionalSecret: 'fictional-orphan-private-evidence' };
  const publicationBytes = Buffer.from(JSON.stringify(publication));
  const manifest = Buffer.from(JSON.stringify({ 'publication.private.json': hash(publicationBytes) }));
  await fs.writeFile(path.join(orphan, 'server-data/files.private.json'), manifest, { mode: 0o600 });
  await fs.writeFile(path.join(orphan, 'server-data/publication.private.json'), publicationBytes, { mode: 0o600 });
  await fs.writeFile(path.join(orphan, 'saved-current/collector-state.private.json'), JSON.stringify({ revision: 2994,
    body: JSON.stringify(publication) }), { mode: 0o600 });
  await fs.writeFile(path.join(orphan, 'source/collector-state.private.json'), JSON.stringify({ revision: 2994,
    body: JSON.stringify(publication) }), { mode: 0o600 });
  await fs.writeFile(path.join(orphan, 'saved-current/current-reviews.private.json'), 'fictional-reviews-read-hash-only', { mode: 0o600 });
  await fs.writeFile(path.join(orphan, 'source/current-browser.private.json'), 'fictional-browser-read-hash-only', { mode: 0o600 });
  await fs.writeFile(path.join(orphan, 'automatic-build.private.json'), JSON.stringify({ version: 1,
    basis: '7'.repeat(64), manifestSha256: hash(manifest) }), { mode: 0o600 });
  await fs.writeFile(path.join(orphan, 'build-recipe.private.json'), JSON.stringify({ version: 1,
    fixtureSecret: 'fictional-orphan-private-recipe' }), { mode: 0o600 });
  await fs.writeFile(path.join(orphan, 'customer-private-filename.json'), 'must not be read', { mode: 0o600 });
  f.accepted.previous = { privateRoot: path.join(orphan, 'server-data'), manifestSha256: hash(manifest), basis: '7'.repeat(64) };
  for (const file of [path.join(f.attempt, 'accepted.private.json'), path.join(f.syncRoot, 'work/current.private.json')]) {
    await fs.writeFile(file, JSON.stringify(f.accepted), { mode: 0o600 });
  }
  return { ...f, orphan, manifest };
}

test('unresolved original workspaces are probed read-only without manufacturing a collector identity or publishing private metadata', async t => {
  const f = await orphanFixture(t), recipient = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const before = await fs.readFile(path.join(f.attempt, 'accepted.private.json'));
  const result = await f.diagnose({ recipientPublicKey: recipient.publicKey.export({ type: 'spki', format: 'pem' }) });
  assert.equal(result.orphanProbeCount, 1); assert.equal(result.orphanProbes.length, 1);
  const probe = result.orphanProbes[0];
  assert.equal(probe.inventory.sha256, hash(f.manifest)); assert.equal(probe.inventory.bytes, f.manifest.length);
  assert.equal(probe.inventory.matchesReference, true); assert.equal(probe.inventory.entriesValid, true);
  assert.equal(probe.attempt.ownerPrivate, true); assert.equal(probe.serverData.ownerPrivate, true);
  assert(probe.metadataFiles.some(row => row.name === 'publication.private.json' && row.present));
  assert.equal(probe.sourceSnapshots.length, 2); assert(probe.sourceSnapshots.every(row => row.revision === 2994 && /^[a-f0-9]{64}$/.test(row.bodySha256)));
  assert(probe.metadataFiles.some(row => row.name === 'current-reviews.private.json' && row.sha256 === hash('fictional-reviews-read-hash-only')));
  assert(result.mismatches.every(row => row.targetKind === 'unresolved' && row.matches.resolved === false));
  assert.equal(result.censusVerified, false); assert(!result.candidateRevisions.includes(2994));
  const publicOutput = JSON.stringify(result);
  for (const secret of [f.orphan, f.appRoot, 'fictional-orphan-private', 'customer-private-filename']) assert(!publicOutput.includes(secret));
  const payload = openTransferSecrets(recipient.privateKey, result.capsule);
  assert.equal(payload.pages, 1);
  const metadata = JSON.parse(gunzipSync(Buffer.from(payload.gzipChunkBase64, 'base64')));
  assert(metadata.orphans.some(row => row.relative.endsWith('/server-data')));
  assert(metadata.controls.some(row => row.kind === 'orphan-publication' && row.value.fictionalSecret === 'fictional-orphan-private-evidence'));
  assert(metadata.controls.some(row => row.kind === 'orphan-saved-collector' && row.value.revision === 2994));
  assert(metadata.controls.some(row => row.kind === 'orphan-source-collector' && row.value.revision === 2994));
  assert(!JSON.stringify(metadata).includes('fictional-reviews-read-hash-only'));
  assert(!JSON.stringify(metadata).includes('fictional-browser-read-hash-only'));
  assert(metadata.orphans[0].attempt.entries.some(row => row.name === 'customer-private-filename.json'));
  assert.deepEqual(await fs.readFile(path.join(f.attempt, 'accepted.private.json')), before);
  await assert.rejects(fs.stat(path.join(f.orphan, 'accepted.private.json')), { code: 'ENOENT' });
  assert.equal(f.cli.length, 0); assert.equal(f.archivedCode.size, 0);
});

test('orphan diagnostics reject unowned directories, symlinked known metadata and changed manifests without following private evidence paths', async t => {
  for (const reason of ['permissions', 'symlink', 'changed', 'directory-changed']) await t.test(reason, async t => {
    const f = await orphanFixture(t);
    if (reason === 'permissions') await fs.chmod(path.join(f.orphan, 'server-data'), 0o755);
    if (reason === 'symlink') {
      await fs.unlink(path.join(f.orphan, 'server-data/publication.private.json'));
      await fs.symlink(path.join(f.folder, 'profile-template.private.json'), path.join(f.orphan, 'server-data/publication.private.json'));
    }
    if (reason === 'changed' || reason === 'directory-changed') {
      const original = f.adapters.load;
      f.adapters.load = async name => {
        const value = await original(name);
        if (name !== 'services/driverAuditSource.js') return value;
        let reads = 0;
        return { ...value, async readPrivateDriverAuditSource(file, maximum) {
          const bytes = await value.readPrivateDriverAuditSource(file, maximum);
          if (reason === 'directory-changed' && file === path.join(f.orphan, 'server-data/publication.private.json')) {
            await fs.writeFile(path.join(f.orphan, 'later-private-file.json'), 'changed', { mode: 0o600 });
          }
          return file === path.join(f.orphan, 'server-data/files.private.json') && ++reads > 1 ? Buffer.from('{}') : bytes;
        } };
      };
    }
    await assert.rejects(f.diagnose(), error => !String(error).includes(f.orphan));
    assert.equal(f.cli.length, 0); assert.equal(f.archivedCode.size, 0);
  });
});

test('orphan probes are capped at eight and never follow an invalid reference path', async t => {
  const f = await diagnosticFixture(t), manifest = await fs.readFile(path.join(f.attempt, 'server-data/files.private.json'));
  for (let index = 0; index < 9; index++) {
    const suffix = String(index).padStart(12, '0');
    const owner = path.join(f.syncRoot, 'work/attempts/33333333-3333-4333-8333-' + suffix);
    const orphan = path.join(f.syncRoot, 'work/attempts/44444444-4444-4444-8444-' + suffix);
    await fs.mkdir(path.join(owner, 'server-data'), { recursive: true, mode: 0o700 });
    await fs.mkdir(orphan, { mode: 0o700 });
    const value = { ...f.accepted, privateRoot: path.join(owner, 'server-data'),
      previous: { basis: '7'.repeat(64), manifestSha256: hash(manifest), privateRoot: path.join(orphan, 'server-data') } };
    await fs.writeFile(path.join(owner, 'accepted.private.json'), JSON.stringify(value), { mode: 0o600 });
    await fs.writeFile(path.join(owner, 'server-data/files.private.json'), manifest, { mode: 0o600 });
  }
  const result = await f.diagnose();
  assert.equal(result.orphanProbeCount, 8); assert.equal(result.orphanUnprobedCount, 1); assert.equal(result.orphanProbes.length, 8);
  f.accepted.previous.privateRoot = path.join(f.folder, 'private-server-data-outside-managed-root');
  await fs.writeFile(path.join(f.attempt, 'accepted.private.json'), JSON.stringify(f.accepted), { mode: 0o600 });
  await fs.writeFile(path.join(f.syncRoot, 'work/current.private.json'), JSON.stringify(f.accepted), { mode: 0o600 });
  const changed = await f.diagnose();
  assert.equal(changed.orphanProbeCount, 8); assert.equal(changed.orphanUnprobedCount, 1);
  assert(!JSON.stringify(changed).includes('private-server-data-outside-managed-root'));
});

async function sourceStageFixture(t) {
  const f = await fixture(t), files = [];
  const paths = ['source/api/collector.mjs', 'source/integration/hosted/native-backend.mjs',
    'source/integration/hosted/archive-read-cache.mjs', ...Array.from({ length: 131 }, (_, i) => 'source/fixture-' + i + '.mjs')];
  const manifest = { schemaVersion: 1, files: paths.map(file => {
    const bytes = Buffer.from('export const fictional = true;\n'); files.push({ path: file, dataBase64: bytes.toString('base64') });
    return { path: file, bytes: bytes.length, sha256: hash(bytes) };
  }), entrypoints: Array.from({ length: 13 }, (_, i) => ({ id: 'fixture-' + i, module: paths[0], exportName: 'default',
    method: 'GET', path: '/api/collector?task=fixture-' + i, schedule: '* * * * *', timeZone: 'UTC', maxDurationSeconds: 300,
    requiredEnvironment: ['CRON_SECRET'] })) };
  const manifestBytes = Buffer.from(JSON.stringify(manifest)), manifestSha256 = hash(manifestBytes);
  files.push({ path: 'manifest.private.json', dataBase64: manifestBytes.toString('base64') });
  const bundle = { version: 1, manifestSha256, nodeExecutable: process.execPath, nodeVersion: process.version, files };
  const environment = { DRIVER_AUDIT_DATA_STORE: 'mongo', CRON_SECRET: 'fictional-private-secret-'.repeat(3),
    MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY: path.join(f.syncRoot, 'work/archive-cache') };
  await fs.mkdir(environment.MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY, { recursive: true, mode: 0o700 });
  const refresh = async () => {
    const compressed = gzipSync(Buffer.from(JSON.stringify(bundle))), environmentBytes = Buffer.from(JSON.stringify(environment));
    await fs.writeFile(path.join(f.folder, 'source-bundle.private.json.gz'), compressed, { mode: 0o600 });
    await fs.writeFile(path.join(f.folder, 'environment.private.json'), environmentBytes, { mode: 0o600 });
    f.receipt.inputFiles = [{ name: 'source-bundle.private.json.gz', bytes: compressed.length, sha256: hash(compressed) },
      { name: 'environment.private.json', bytes: environmentBytes.length, sha256: hash(environmentBytes) }];
    f.receipt.objects = 2; f.receipt.bytes = compressed.length + environmentBytes.length;
    f.state.plan.objectCount = 2; f.state.plan.objectBytes = f.receipt.bytes;
    await f.save('received.private.json', f.receipt); await f.save('session.private.json', f.state);
    return { compressed, environmentBytes, sha256: hash(compressed) };
  };
  f.adapters.sourcePins = { manifest: manifestSha256, files: 134 };
  const runSource = async () => f.run('stage-source', { templateSha256: (await refresh()).sha256 });
  return { ...f, bundle, environment, refresh, runSource, target: path.join(f.appRoot, 'server/.private/driver-audit-source', manifestSha256) };
}

test('source staging verifies exact code/runtime, retains credentials privately and archives only the original gzip code envelope', async t => {
  const f = await sourceStageFixture(t);
  await fs.unlink(path.join(f.folder, 'profile-template.private.json'));
  const result = await f.runSource();
  assert.equal(result.status, 'source-staged'); assert.equal(result.files, 134);
  assert.equal(result.authorityChanged, false); assert.equal(result.activationPending, true);
  const record = JSON.parse(await fs.readFile(path.join(f.target, 'stage.private.json')));
  assert.equal(record.bundleSha256, result.bundleSha256);
  assert.deepEqual(f.archivedCode.get(result.bundleSha256 + '.gz'), (await f.refresh()).compressed);
  assert(!gunzipSync(f.archivedCode.get(result.bundleSha256 + '.gz')).includes(Buffer.from(f.environment.CRON_SECRET)));
  const privateEnvironment = JSON.parse(await fs.readFile(path.join(f.target, 'environment.private.json')));
  assert.equal(privateEnvironment.CRON_SECRET, f.environment.CRON_SECRET);
  assert(!JSON.stringify(result).includes(f.appRoot)); assert(!JSON.stringify(result).includes(f.environment.CRON_SECRET));
  assert.equal((await f.runSource()).status, 'source-already-staged'); assert.equal(f.cli.length, 0);
  assert.equal(f.calls.filter(call => call.file === 'pm2').every(call => call.args[0] === 'jlist'), true);
});

test('source staging rejects unsafe environment, hidden envelope data, stale Node and changed code before staging or archive writes', async t => {
  for (const reason of ['mongo-uri', 'allowance', 'cache', 'oidc', 'nul', 'cron', 'switch', 'gateway', 'extra-code-field', 'extra-file-field', 'code', 'node', 'node-version', 'node-probe']) {
    await t.test(reason, async t => {
      const f = await sourceStageFixture(t);
      if (reason === 'mongo-uri') f.environment.MONGODB_URI = 'mongodb://fictional.invalid/private';
      if (reason === 'allowance') f.environment.DRIVER_AUDIT_NATIVE_CAPACITY_BYTES = '1000';
      if (reason === 'cache') f.environment.MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY = '/untrusted/cache';
      if (reason === 'oidc') f.environment.VERCEL_OIDC_TOKEN = 'fictional-private-token';
      if (reason === 'nul') f.environment.FICTIONAL_SETTING = 'invalid\0setting';
      if (reason === 'cron') f.environment.CRON_SECRET = 'short';
      if (reason === 'switch') f.environment.MATTER_DELIVERY_ENABLED = 'yes';
      if (reason === 'gateway') f.environment.MATTER_PHOTO_GRADE_ENABLED = '1';
      if (reason === 'extra-code-field') f.bundle.environment = f.environment;
      if (reason === 'extra-file-field') f.bundle.files[0].hiddenEnvironment = f.environment;
      if (reason === 'code') f.bundle.files[0].dataBase64 = Buffer.from('changed-code').toString('base64');
      if (reason === 'node') f.bundle.nodeExecutable = '/untrusted/node';
      if (reason === 'node-version') f.bundle.nodeVersion = 'v0.0.0';
      if (reason === 'node-probe') {
        const original = f.adapters.exec;
        f.adapters.exec = (file, args, options) => args[0] === '--version' ? Promise.resolve({ stdout: 'v0.0.0\n' }) : original(file, args, options);
      }
      await assert.rejects(f.runSource());
      assert.equal(f.archivedCode.size, 0); assert.equal(f.cli.length, 0);
      await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
    });
  }
});

test('source staging cannot report success until its native code copy reads back, and a retry preserves the private staged release', async t => {
  const f = await sourceStageFixture(t), original = f.adapters.load;
  f.adapters.load = async name => {
    const value = await original(name);
    if (name !== 'services/driverAuditMongoArchive.js') return value;
    return { createDriverAuditMongoArchive(options) {
      return { ...value.createDriverAuditMongoArchive(options), async readObject() { return [Buffer.from('wrong code readback')]; } };
    } };
  };
  await assert.rejects(f.runSource(), /archive readback/i);
  const staged = await fs.readFile(path.join(f.target, 'stage.private.json'));
  f.adapters.load = original;
  assert.equal((await f.runSource()).status, 'source-already-staged');
  assert.deepEqual(await fs.readFile(path.join(f.target, 'stage.private.json')), staged);
  assert.equal(f.locked(), false);
});

test('source staging accepts only the two verified fixed-name inputs', async t => {
  for (const reason of ['missing', 'duplicate', 'extra']) await t.test(reason, async t => {
    const f = await sourceStageFixture(t), prepared = await f.refresh();
    if (reason === 'missing') f.receipt.inputFiles.pop();
    if (reason === 'duplicate') f.receipt.inputFiles[1] = { ...f.receipt.inputFiles[0] };
    if (reason === 'extra') f.receipt.inputFiles.push({ name: 'unreviewed.private.json', sha256: hash('extra'), bytes: 5 });
    await f.save('received.private.json', f.receipt);
    await assert.rejects(f.run('stage-source', { templateSha256: prepared.sha256 }), /exact two private source inputs/i);
    assert.equal(f.archivedCode.size, 0); assert.equal(f.cli.length, 0);
    await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
  });
});

async function lineageStageFixture(t) {
  const f = await fixture(t), name = 'historical-source-lineage.private.json';
  const proof = { version: 1, entries: [{ fixture: 'fictional-private-source-receipt' }] };
  const raw = Buffer.from(JSON.stringify(proof)), originalLoad = f.adapters.load;
  await fs.writeFile(path.join(f.folder, name), raw, { mode: 0o600 });
  f.receipt.inputFiles = [{ name, sha256: hash(raw), bytes: raw.length }];
  f.receipt.objects = 1; f.receipt.bytes = raw.length; f.state.plan.objectCount = 1; f.state.plan.objectBytes = raw.length;
  await f.save('received.private.json', f.receipt); await f.save('session.private.json', f.state);
  f.adapters.env.DRIVER_AUDIT_SUPABASE_SECRET = 'fictional-private-source-key';
  const source = { revision: 7, body: '{"fictional":"source body"}' };
  let reads = 0, advance = false, invalid = false;
  f.adapters.load = async module => {
    if (module === 'services/driverAuditOriginalSourceLineage.js') return { DRIVER_AUDIT_HISTORICAL_SOURCE_FILE: name,
      async validateDriverAuditHistoricalSourceProof({ proof: value, config }) {
        assert.deepEqual(value, proof); assert.equal(config.root, f.syncRoot);
        if (invalid) throw Error('fictional-private-source-receipt');
      } };
    if (module === 'vendor/driver-audits/integration/cloud/rpc.mjs') return { createHostedRpc({ secret }) {
      assert.equal(secret, f.adapters.env.DRIVER_AUDIT_SUPABASE_SECRET); return { fixture: true };
    } };
    if (module === 'vendor/driver-audits/integration/cloud/cloud-state.mjs') return { createCloudState() {
      return { async read(key) { assert.equal(key, 'collector-state'); reads++;
        return advance && reads > 1 ? { ...source, revision: 8 } : source; } };
    } };
    if (module === 'services/driverAuditLiveImport.js') return { async collectDriverAuditReceiptRoots({ db, syncRoot, documents }) {
      assert.equal(syncRoot, f.syncRoot); assert(db); assert.deepEqual(documents, [{ key: 'collector-state', revision: 7, body_text: source.body }]);
      assert.deepEqual(await fs.readFile(path.join(syncRoot, name)), raw);
      return { sha256: censusSha, collectorRevisions: [2, 3, 7], receiptBindings: [{ key: 'collector-state', revision: 3, receiptSha256: hash('original') }] };
    } };
    return originalLoad(module);
  };
  return { ...f, name, raw, runLineage: () => f.run('stage-lineage', { templateSha256: hash(raw) }),
    advance: () => { advance = true; }, invalidate: () => { invalid = true; } };
}

test('historical source retention stages only immutable proof metadata and checks the actual unchanged source census', async t => {
  const f = await lineageStageFixture(t), config = await fs.readFile(path.join(f.syncRoot, 'sync.json'));
  const result = await f.runLineage();
  assert.equal(result.status, 'historical-source-retained'); assert.equal(result.collectorRootsSha256, censusSha);
  assert.equal(result.renderedWorkspaceRecovered, false); assert.equal(result.sourceRecordsChanged, false);
  assert.equal(result.authorityChanged, false); assert.equal(result.activationPending, true);
  assert.deepEqual(await fs.readFile(path.join(f.syncRoot, 'sync.json')), config);
  assert.equal((await f.runLineage()).status, 'historical-source-already-retained');
  assert(!JSON.stringify(result).includes('fictional-private')); assert.equal(f.cli.length, 0);
  assert(f.calls.every(call => call.file === 'git' || call.file === 'pm2' && call.args.join() === 'jlist'));
});

test('historical source retention rejects input, source, proof or existing-target drift without changing source records', async t => {
  for (const reason of ['name', 'extra', 'hash', 'conflict', 'advanced', 'secret', 'proof']) await t.test(reason, async sub => {
    const f = await lineageStageFixture(sub);
    if (reason === 'name') f.receipt.inputFiles[0].name = 'other.private.json';
    if (reason === 'extra') f.receipt.inputFiles.push(f.receipt.inputFiles[0]);
    if (reason === 'hash') await fs.appendFile(path.join(f.folder, f.name), 'changed');
    if (reason === 'conflict') await fs.writeFile(path.join(f.syncRoot, f.name), 'preserve-existing', { mode: 0o600 });
    if (reason === 'advanced') f.advance();
    if (reason === 'secret') delete f.adapters.env.DRIVER_AUDIT_SUPABASE_SECRET;
    if (reason === 'proof') f.invalidate();
    await f.save('received.private.json', f.receipt);
    await assert.rejects(f.runLineage(), error => !String(error).includes('fictional-private'));
    if (reason === 'conflict') assert.equal(await fs.readFile(path.join(f.syncRoot, f.name), 'utf8'), 'preserve-existing');
    assert.equal(f.cli.length, 0); assert.equal(f.locked(), false);
  });
});

async function builderFixture(t) {
  const f = await fixture(t), originalLoad = f.adapters.load;
  f.adapters.load = name => name === 'vendor/driver-audits/integration/cloud/driver-audit-handoff.mjs'
    ? { verifyAuditBuilder } : originalLoad(name);
  const source = path.join(f.syncRoot, 'builder'), changed = 'integration/cloud/automatic-release-source.mjs';
  const files = { [changed]: hash('export const legacy=true;'), 'scripts/run-automatic-report.mjs': hash('export const fixture=true;') };
  const contents = new Map([[changed, 'export const legacy=true;'], ['scripts/run-automatic-report.mjs', 'export const fixture=true;']]);
  for (let index = 0; index < 71; index++) { const file = 'fixture/module-' + index + '.mjs', bytes = 'export const item=' + index + ';';
    files[file] = hash(bytes); contents.set(file, bytes); }
  for (const [file, bytes] of contents) { await fs.mkdir(path.dirname(path.join(source, file)), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(source, file), bytes, { mode: 0o600 }); }
  const original = Buffer.from(JSON.stringify({ version: 1, files }));
  await fs.writeFile(path.join(source, 'runtime-manifest.json'), original, { mode: 0o600 });
  const replacement = Buffer.from('export const managed=true;');
  const manifest = Buffer.from(JSON.stringify({ version: 1, files: { ...files, [changed]: hash(replacement) } }));
  const pins = { from: hash(original), to: hash(manifest) };
  f.adapters.builderPins = pins;
  const configFile = path.join(f.syncRoot, 'sync.json'), config = JSON.parse(await fs.readFile(configFile));
  await fs.writeFile(configFile, JSON.stringify({ ...config, builderSha256: pins.from }), { mode: 0o600 });
  const bundle = { version: 1, manifest: manifest.toString('base64'), delta: { [changed]: replacement.toString('base64') } };
  async function saveBundle(value = bundle) {
    const bytes = gzipSync(JSON.stringify(value));
    await fs.writeFile(path.join(f.folder, 'builder-bundle.private.json.gz'), bytes, { mode: 0o600 });
    const existing = f.receipt.inputFiles.filter(row => row.name !== 'builder-bundle.private.json.gz');
    const priorBytes = f.receipt.inputFiles.find(row => row.name === 'builder-bundle.private.json.gz')?.bytes ?? 0;
    f.receipt.inputFiles = [...existing, { name: 'builder-bundle.private.json.gz', sha256: hash(bytes), bytes: bytes.length }];
    f.receipt.objects = f.receipt.inputFiles.length; f.receipt.bytes += bytes.length - priorBytes;
    f.state.plan.objectCount = f.receipt.objects; f.state.plan.objectBytes = f.receipt.bytes;
    await f.save('received.private.json', f.receipt); await f.save('session.private.json', f.state);
    return hash(bytes);
  }
  const bundleSha256 = await saveBundle();
  return { ...f, source, pins, bundle, saveBundle, bundleSha256, changed,
    target: path.join(f.syncRoot, 'builder-staged-' + pins.to) };
}

test('builder staging copies the exact reviewed 73-file delta without source/profile requirements or worker restart', async t => {
  const f = await builderFixture(t);
  await fs.unlink(path.join(f.sourceRoot, 'source.json'));
  await fs.unlink(path.join(f.folder, 'profile-template.private.json'));
  const run = () => f.run('stage-builder', { templateSha256: f.bundleSha256 });
  const result = await run();
  assert.equal(result.status, 'builder-staged'); assert.equal(result.files, 73);
  assert.equal(result.builderSha256, f.pins.to); assert.equal(result.activationPending, true);
  await verifyAuditBuilder(f.source, f.pins.from); await verifyAuditBuilder(f.target, f.pins.to);
  assert.equal((await fs.stat(path.join(f.target, f.changed))).mode & 0o777, 0o600);
  assert.equal((await run()).status, 'builder-already-staged');
  assert.equal(f.cli.length, 0);
  assert(f.calls.every(call => call.file === 'git' || call.file === 'pm2' && call.args.join() === 'jlist'));
});

test('builder staging preserves conflicting targets and rejects any unreviewed delta before creating a target', async t => {
  for (const failure of ['target', 'extra-delta', 'changed-unchanged-file', 'old-builder', 'encoding']) {
    await t.test(failure, async t => {
      const f = await builderFixture(t);
      if (failure === 'target') { await fs.mkdir(f.target, { mode: 0o700 });
        await fs.writeFile(path.join(f.target, 'preserved.txt'), 'preserve', { mode: 0o600 }); }
      if (failure === 'extra-delta') f.bundle.delta['other.mjs'] = Buffer.from('unexpected').toString('base64');
      if (failure === 'changed-unchanged-file') await fs.appendFile(path.join(f.source, 'fixture/module-1.mjs'), 'changed');
      if (failure === 'old-builder') f.adapters.builderPins.from = 'f'.repeat(64);
      if (failure === 'encoding') f.bundle.delta[f.changed] += '=';
      const pin = await f.saveBundle();
      await assert.rejects(f.run('stage-builder', { templateSha256: pin }));
      if (failure === 'target') assert.equal(await fs.readFile(path.join(f.target, 'preserved.txt'), 'utf8'), 'preserve');
      else await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
      assert.equal(f.cli.length, 0); assert.equal(f.locked(), false);
    });
  }
});
