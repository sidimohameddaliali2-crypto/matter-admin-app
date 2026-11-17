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
import { readPrivateDriverAuditSource, requirePrivateDriverAuditSourceDirectory } from '../../server/services/driverAuditSource.js';
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
  const connection = { db, async asPromise() {}, async close() { closes++; } };
  const adapters = { platform: 'linux', env: { MONGODB_URI: 'mongodb://fictional.invalid/fictional_existing' },
    async exec(file, args, options) {
      calls.push({ file, args, options });
      if (file === 'git') return { stdout: commit + '\n' };
      if (file === 'pm2') return { stdout: JSON.stringify(entries) };
      assert.equal(file, process.execPath);
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
      if (name === 'node_modules/mongoose/index.js') return { default: { createConnection(uri) {
        assert.equal(uri, adapters.env.MONGODB_URI); return connection;
      } } };
      if (name === 'vendor/driver-audits/integration/hosted/worker-lock.mjs') return { async acquireWorkerLock(file) {
        assert.equal(file, path.join(root, 'operator.lock')); assert.equal(locked, false, 'operator already locked'); locked = true;
        return { async release() { locked = false; } };
      } };
      if (name === 'services/driverAuditSource.js') return { readPrivateDriverAuditSource, requirePrivateDriverAuditSourceDirectory,
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
  return { appRoot, folder, syncRoot, sourceRoot, state, receipt, template, entries, adapters, run, save, refresh, cli, calls,
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
