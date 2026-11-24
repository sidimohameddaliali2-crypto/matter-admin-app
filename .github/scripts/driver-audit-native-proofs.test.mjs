import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { readPrivateDriverAuditSource, requirePrivateDriverAuditSourceDirectory } from '../../server/services/driverAuditSource.js';
import { acquireWorkerLock } from '../../server/vendor/driver-audits/integration/hosted/worker-lock.mjs';
import { sealTransferSecrets, openTransferSecrets } from '../../server/services/driverAuditTransferCodec.js';

const implementation = await import('./driver-audit-native-proofs.mjs').catch(() => ({}));
const hash = value => createHash('sha256').update(value).digest('hex');
const encoded = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const commit = 'a'.repeat(40), sourceId = '00000000-0000-4000-8000-000000000011';
const targetId = '00000000-0000-4000-8000-000000000012', capacity = 16 * 1024 ** 3;
const recipient = generateKeyPairSync('rsa', { modulusLength: 3072 });
const publicKey = recipient.publicKey.export({ type: 'spki', format: 'pem' });

async function fixture(t) {
  const appRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-proofs-')));
  t.after(() => fs.rm(appRoot, { recursive: true, force: true }));
  const server = path.join(appRoot, 'server'), transferRoot = path.join(server, '.private/driver-audit-native-transfer');
  const source = path.join(transferRoot, sourceId), target = path.join(transferRoot, targetId);
  const syncRoot = path.join(server, '.private/driver-audits', 'b'.repeat(64));
  for (const directory of [source, target, syncRoot]) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(syncRoot, 'sync.json'), encoded({ version: 1, root: syncRoot, codeRoot: path.join(syncRoot, 'builder'),
    baselineRoot: path.join(syncRoot, 'baseline'), rendererBuild: { path: path.join(syncRoot, 'baseline/build.private.json') },
    journals: { path: path.join(syncRoot, 'validation-journals.private.json') } }), { mode: 0o600 });
  const profile = { version: 2, capacityBytes: capacity, targetDatabase: 'fictional_existing', syncRoot, collectorRootsSha256: 'c'.repeat(64) };
  const profileBytes = encoded(profile), profileSha256 = hash(profileBytes);
  await fs.writeFile(path.join(target, 'profile.private.json'), profileBytes, { mode: 0o600 });
  const files = new Map([['closure-proof.private.json', encoded({ version: 1, kind: 'fictional final closure',
    privateNote: 'PRIVATE FICTIONAL PROOF MUST NOT LEAK' })], ['activation-template.private.json', encoded({ version: 1,
    profileSha256, privateNote: 'PRIVATE FICTIONAL TEMPLATE MUST NOT LEAK' })]]);
  const template = { version: 1, kind: 'native-proof-supplement-v1', targetSessionId: targetId, profileSha256, files: [] };
  const now = Date.now() - 1000;
  const session = id => ({ version: 1, sessionId: id, targetDatabase: profile.targetDatabase, capacityBytes: capacity,
    inventorySha256: 'd'.repeat(64), createdAt: now, plan: { inventorySha256: 'd'.repeat(64), objectCount: 1, objectBytes: 10 } });
  const received = id => ({ version: 1, status: 'transfer-received', verified: true, authorityChanged: false,
    sessionId: id, targetDatabase: profile.targetDatabase, inventorySha256: 'd'.repeat(64), completedAt: new Date().toISOString(),
    objects: 1, bytes: 10, inputFiles: [{ name: 'original.private.json', sha256: hash('preserved'), bytes: 10 }] });
  const sourceSession = session(sourceId), sourceReceived = received(sourceId);
  const targetSession = session(targetId), targetReceived = received(targetId);
  const save = (root, name, value) => fs.writeFile(path.join(root, name), Buffer.isBuffer(value) ? value : encoded(value), { mode: 0o600 });
  await save(target, 'session.private.json', targetSession); await save(target, 'received.private.json', targetReceived);
  await fs.writeFile(path.join(target, 'documents.private.jsonl.gz'), 'original dataset must remain unchanged', { mode: 0o600 });
  const refresh = async () => {
    template.files = [...files].map(([name, bytes]) => ({ name, sha256: hash(bytes), bytes: bytes.length }));
    const templateBytes = encoded(template);
    await save(source, 'supplement-template.private.json', templateBytes);
    for (const [name, bytes] of files) await save(source, name, bytes);
    sourceReceived.inputFiles = [{ name: 'supplement-template.private.json', sha256: hash(templateBytes), bytes: templateBytes.length }, ...template.files];
    sourceReceived.objects = sourceReceived.inputFiles.length;
    sourceReceived.bytes = sourceReceived.inputFiles.reduce((n, row) => n + row.bytes, 0);
    sourceSession.plan.objectCount = sourceReceived.objects; sourceSession.plan.objectBytes = sourceReceived.bytes;
    await save(source, 'session.private.json', sourceSession); await save(source, 'received.private.json', sourceReceived);
    return hash(templateBytes);
  };
  let templateSha256 = await refresh(), closes = 0;
  const control = { authority: { status: 'staging', importSha256: profileSha256, writeFence: 1 }, stage: null };
  const db = { databaseName: profile.targetDatabase, collection(name) { return {
    async findOne(query) {
      if (name === 'driverAuditNativeControl') return query._id === 'authority' ? control.authority : { limitBytes: capacity, usedBytes: 100 };
      assert.equal(name, 'driverAuditControl'); return query._id === 'direct-stage' ? control.stage : { _id: 'head', fixture: 'unchanged' };
    }, async updateOne() { assert.fail('Proof staging must not mutate application data'); },
  }; } };
  const entries = [{ name: 'matter-delivery-api', pm2_env: { status: 'online', pm_cwd: appRoot, pm_exec_path: path.join(server, 'server.js') } },
    { name: 'matter-driver-audit-sync', pm2_env: { status: 'stopped', pm_cwd: server,
      pm_exec_path: path.join(server, 'scripts/driverAuditSync.js'), args: ['--config', path.join(syncRoot, 'sync.json')] } }];
  const calls = [], adapters = { platform: 'linux', env: { MONGODB_URI: 'mongodb://fictional.invalid/fictional_existing' },
    async exec(file, args) {
      calls.push({ file, args });
      if (file === 'git') return { stdout: args[0] === 'rev-parse' ? commit + '\n' : '' };
      assert.equal(file, 'pm2'); assert.deepEqual(args, ['jlist']); return { stdout: JSON.stringify(entries) };
    },
    async load(name) {
      if (name === 'loadEnv.js') return {};
      if (name === 'services/driverAuditSource.js') return { readPrivateDriverAuditSource, requirePrivateDriverAuditSourceDirectory };
      if (name === 'vendor/driver-audits/integration/hosted/worker-lock.mjs') return { acquireWorkerLock };
      if (name === 'node_modules/mongoose/index.js') return { default: { createConnection(uri) {
        assert.equal(uri, adapters.env.MONGODB_URI); return { db, asPromise: async () => {}, close: async () => { closes++; } };
      } } };
      throw Error('Unexpected app import');
    } };
  const run = extra => implementation.runDriverAuditNativeProofs({ operation: 'stage-native-proofs',
    sessionId: sourceId, templateSha256, appRoot, expectedSha: commit, ...extra }, adapters);
  return { appRoot, server, transferRoot, source, target, syncRoot, files, profile, profileSha256, template,
    sourceSession, sourceReceived, targetSession, targetReceived, entries, control, calls, adapters, save, run,
    async refresh() { templateSha256 = await refresh(); return templateSha256; }, get templateSha256() { return templateSha256; },
    get closes() { return closes; } };
}

async function controlFixture(t) {
  const f = await fixture(t), manifest = '15301337474717828b88997faac92cbc23763b16ed1fc7881fa6bd553696a64b';
  const sourceRoot = path.join(f.server, '.private/driver-audit-source', manifest), fixtureSha256 = 'e'.repeat(64);
  await fs.mkdir(sourceRoot, { recursive: true, mode: 0o700 });
  Object.assign(f.profile, { runtimeRoot: path.join(sourceRoot, 'runtime'), runtimeSha256: manifest });
  const profileBytes = encoded(f.profile), profileSha256 = hash(profileBytes);
  await f.save(f.target, 'profile.private.json', profileBytes); f.control.authority.importSha256 = profileSha256;
  const source = { version: 1, root: sourceRoot, runtimeRoot: f.profile.runtimeRoot, manifestSha256: manifest,
    nodeExecutable: '/usr/bin/node', nodeVersion: 'v22.23.4',
    environment: { path: path.join(sourceRoot, 'environment.private.json'), sha256: hash('fictional secret environment') } };
  await f.save(sourceRoot, 'source.json', source);
  const sync = JSON.parse(await fs.readFile(path.join(f.syncRoot, 'sync.json'))); sync.builderSha256 = 'f'.repeat(64);
  await f.save(f.syncRoot, 'sync.json', sync);
  const settings = { version: 1, operation: 'prepare-native-settings', sessionId: targetId, applicationCommit: commit,
    profileSha256, targetDatabase: f.profile.targetDatabase, sourceManifestSha256: manifest,
    syncConfigSha256: hash(encoded(sync)), sourceConfigSha256: hash(encoded(source)),
    archiveCacheDirectory: path.join(f.syncRoot, 'work/archive-cache'), nativeSettingsApplied: false, requiresFinalFenceAndParity: true };
  await f.save(f.target, 'native-settings-plan.private.json', settings);
  const qualificationName = 'qualification-' + fixtureSha256 + '.private.json';
  const qualification = { version: 1, status: 'partial', verified: false, fixtureSha256, commit,
    configSha256: settings.sourceConfigSha256, manifestSha256: manifest, environmentSha256: source.environment.sha256,
    privateNote: 'PRIVATE FICTIONAL QUALIFICATION MUST NOT LEAK' };
  await f.save(sourceRoot, qualificationName, qualification);
  const load = f.adapters.load;
  f.adapters.load = async name => {
    if (name === 'services/driverAuditTransferCodec.js') return { sealTransferSecrets };
    const result = await load(name);
    if (name !== 'services/driverAuditSource.js') return result;
    return { ...result, async readDriverAuditSourceConfig(file) {
      assert.equal(file, path.join(sourceRoot, 'source.json'));
      const raw = await readPrivateDriverAuditSource(file);
      return { ...JSON.parse(raw), configSha256: hash(raw), dataStore: 'mongo',
        environmentReference: source.environment, archiveCacheDirectory: settings.archiveCacheDirectory };
    } };
  };
  const runExport = extra => implementation.runDriverAuditNativeControlExport({ operation: 'export-native-controls',
    sessionId: targetId, profileSha256, appRoot: f.appRoot, expectedSha: commit, recipientPublicKey: publicKey,
    qualificationFixtureSha256: fixtureSha256, ...extra }, f.adapters);
  return { ...f, sourceRoot, sourceConfig: source, profileSha256, settings, qualification, qualificationName, runExport };
}

test('fixed native controls are read-only and exported as exact private bytes inside the RSA capsule', async t => {
  const f = await controlFixture(t), result = await f.runExport();
  assert.equal(result.status, 'native-controls-exported'); assert.equal(result.files, 5);
  assert.equal(result.authorityChanged, false); assert.equal(result.proofsVerified, false);
  const sealed = openTransferSecrets(recipient.privateKey, result.capsule);
  assert.equal(sealed.kind, 'native-control-export-capsule-v1'); assert.equal(sealed.profileSha256, f.profileSha256);
  const packed = Buffer.from(sealed.gzipBase64, 'base64'); assert.equal(hash(packed), sealed.gzipSha256);
  const raw = gunzipSync(packed); assert.equal(hash(raw), result.envelopeSha256); assert.equal(raw.length, sealed.envelopeBytes);
  const value = JSON.parse(raw); assert.equal(value.applicationCommit, commit); assert.equal(value.sessionId, targetId);
  assert.deepEqual(value.files.map(row => row.name).sort(), ['profile.private.json', 'source.json', 'sync.json',
    'native-settings-plan.private.json', f.qualificationName].sort());
  for (const row of value.files) {
    const directory = row.name === 'sync.json' ? f.syncRoot : row.name === 'source.json' || row.name === f.qualificationName ? f.sourceRoot : f.target;
    const bytes = await fs.readFile(path.join(directory, row.name));
    assert.equal(row.dataBase64, bytes.toString('base64')); assert.equal(row.sha256, hash(bytes)); assert.equal(row.bytes, bytes.length);
  }
  assert(!JSON.stringify(result).includes(f.appRoot)); assert(!JSON.stringify(result).includes('PRIVATE FICTIONAL'));
  assert.equal((await f.runExport({ qualificationFixtureSha256: undefined })).files, 4);
  assert(f.calls.filter(row => row.file === 'pm2').every(row => row.args[0] === 'jlist'));
});

test('control export rejects changed profiles, active writers, unsafe paths and control drift without a capsule', async t => {
  for (const reason of ['profile', 'settings', 'source', 'symlink', 'fixture', 'active', 'worker', 'stage', 'drift', 'pointer', 'overflow']) await t.test(reason, async t => {
    const f = await controlFixture(t);
    if (reason === 'profile') await fs.appendFile(path.join(f.target, 'profile.private.json'), ' ');
    if (reason === 'settings') { f.settings.sourceConfigSha256 = '9'.repeat(64); await f.save(f.target, 'native-settings-plan.private.json', f.settings); }
    if (reason === 'source') { f.sourceConfig.runtimeRoot = '/untrusted/runtime'; await f.save(f.sourceRoot, 'source.json', f.sourceConfig); }
    if (reason === 'symlink') { const file = path.join(f.sourceRoot, 'source.json'); await fs.rename(file, file + '.saved'); await fs.symlink(file + '.saved', file); }
    if (reason === 'fixture') { f.qualification.commit = '9'.repeat(40); await f.save(f.sourceRoot, f.qualificationName, f.qualification); }
    if (reason === 'active') f.control.authority.status = 'active';
    if (reason === 'worker') f.entries[1].pm2_env.status = 'online';
    if (reason === 'stage') f.control.stage = { status: 'pending' };
    if (reason === 'overflow') { f.qualification.privatePayload = randomBytes(48 * 1024).toString('base64'); await f.save(f.sourceRoot, f.qualificationName, f.qualification); }
    if (reason === 'drift' || reason === 'pointer') {
      const load = f.adapters.load;
      f.adapters.load = async name => {
        if (name === 'services/driverAuditTransferCodec.js') {
          if (reason === 'drift') await fs.appendFile(path.join(f.target, 'native-settings-plan.private.json'), ' ');
          else { await fs.mkdir(path.join(f.syncRoot, 'work'), { mode: 0o700 });
            await f.save(path.join(f.syncRoot, 'work'), 'current.private.json', { independentlyChanged: true }); }
        }
        return load(name);
      };
    }
    await assert.rejects(f.runExport(), error => !String(error).includes(f.appRoot) && !String(error).includes('PRIVATE FICTIONAL'));
  });
});

test('control export accepts only a strong public RSA key before opening the database', async t => {
  const f = await controlFixture(t), weak = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  for (const key of [undefined, '', 'fictional invalid key', recipient.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    weak.publicKey.export({ type: 'spki', format: 'pem' }), ec.publicKey.export({ type: 'spki', format: 'pem' })]) {
    await assert.rejects(f.runExport({ recipientPublicKey: key }));
  }
  assert.equal(f.closes, 0); assert.equal(f.calls.length, 0);
});

test('a verified metadata supplement preserves the original transfer and binds activation provenance to its real source receipt', async t => {
  const f = await fixture(t);
  assert.equal(typeof implementation.runDriverAuditNativeProofs, 'function', 'Proof supplement staging is not implemented');
  const names = ['session.private.json', 'received.private.json', 'profile.private.json', 'documents.private.jsonl.gz'];
  const originals = new Map(await Promise.all(names.map(async name => [name, await fs.readFile(path.join(f.target, name))])));
  const result = await f.run();
  assert.equal(result.status, 'native-proofs-staged'); assert.equal(result.files, 2); assert.equal(result.authorityChanged, false);
  assert.equal(result.proofsVerified, false); assert.equal(result.originalInputsUnchanged, true);
  for (const [name, bytes] of f.files) assert.deepEqual(await fs.readFile(path.join(f.target, name)), bytes);
  for (const [name, bytes] of originals) assert.deepEqual(await fs.readFile(path.join(f.target, name)), bytes);
  const provenance = JSON.parse(await fs.readFile(path.join(f.target, 'activation-template-source.private.json')));
  assert.deepEqual(Object.keys(provenance).sort(), ['version', 'kind', 'targetSessionId', 'profileSha256', 'sourceSessionId',
    'sourceSessionSha256', 'sourceReceivedSha256', 'input', 'supplementSha256'].sort());
  assert.equal(provenance.kind, 'native-activation-template-provenance-v1'); assert.equal(provenance.targetSessionId, targetId);
  assert.equal(provenance.profileSha256, f.profileSha256); assert.equal(provenance.sourceSessionId, sourceId);
  assert.equal(provenance.sourceSessionSha256, hash(await fs.readFile(path.join(f.source, 'session.private.json'))));
  assert.equal(provenance.sourceReceivedSha256, hash(await fs.readFile(path.join(f.source, 'received.private.json'))));
  assert.equal(provenance.supplementSha256, f.templateSha256);
  assert.deepEqual(provenance.input, f.template.files.find(row => row.name === 'activation-template.private.json'));
  assert.equal((await f.run()).status, 'native-proofs-already-staged'); assert.equal(f.closes, 2);
  for (const value of [f.appRoot, 'PRIVATE FICTIONAL']) assert(!JSON.stringify(result).includes(value));
  assert(f.calls.filter(row => row.file === 'pm2').every(row => row.args[0] === 'jlist'));
});

test('only fixed proof metadata names can be supplemented, without hidden fields or alternate target paths', async t => {
  for (const name of ['environment.private.json', 'profile.private.json', 'received.private.json', 'documents.private.jsonl.gz',
    'native-settings-plan.private.json', 'native-authority-parity.private.json', 'activation-template-source.private.json', '../closure-proof.private.json']) {
    await t.test(name, async t => {
      const f = await fixture(t); f.files.clear(); f.files.set(name, encoded({ version: 1 }));
      // The forbidden relative path must never be written even in the input fixture.
      f.template.files = [{ name, sha256: hash(encoded({ version: 1 })), bytes: encoded({ version: 1 }).length }];
      const bytes = encoded(f.template); await f.save(f.source, 'supplement-template.private.json', bytes);
      await assert.rejects(f.run({ templateSha256: hash(bytes) }), /fixed proof metadata names/);
      await assert.rejects(fs.stat(path.join(f.target, 'closure-proof.private.json')), { code: 'ENOENT' });
    });
  }
});

test('conflicting or unsafe proofs fail before any target proof is copied', async t => {
  for (const reason of ['conflict', 'provenance-conflict', 'symlink', 'body', 'version', 'duplicate', 'extra-field', 'profile',
    'same-session', 'source-db', 'target-clock', 'capacity', 'active', 'other-import', 'stage', 'worker']) await t.test(reason, async t => {
    const f = await fixture(t);
    if (reason === 'conflict') await f.save(f.target, 'closure-proof.private.json', { version: 1, independent: 'must survive' });
    if (reason === 'provenance-conflict') await f.save(f.target, 'activation-template-source.private.json', { version: 1, independent: true });
    if (reason === 'symlink') await fs.symlink(path.join(f.target, 'profile.private.json'), path.join(f.target, 'closure-proof.private.json'));
    if (reason === 'body') await fs.appendFile(path.join(f.source, 'closure-proof.private.json'), ' ');
    if (reason === 'version') { f.files.set('closure-proof.private.json', encoded({ version: 2 })); await f.refresh(); }
    if (reason === 'duplicate') {
      f.template.files.push({ ...f.template.files[0] });
      const bytes = encoded(f.template); await f.save(f.source, 'supplement-template.private.json', bytes);
      await assert.rejects(f.run({ templateSha256: hash(bytes) }), /unique fixed proof metadata names/); return;
    }
    if (reason === 'extra-field') { f.template.privatePayload = 'unreviewed'; const bytes = encoded(f.template);
      await f.save(f.source, 'supplement-template.private.json', bytes); await assert.rejects(f.run({ templateSha256: hash(bytes) })); return; }
    if (reason === 'profile') await f.save(f.target, 'profile.private.json', { ...f.profile, targetDatabase: 'other' });
    if (reason === 'same-session') { f.template.targetSessionId = sourceId; await f.refresh(); }
    if (reason === 'source-db') { f.sourceSession.targetDatabase = 'other'; f.sourceReceived.targetDatabase = 'other'; await f.refresh(); }
    if (reason === 'target-clock') { f.targetReceived.completedAt = '2099-01-01T00:00:00Z'; await f.save(f.target, 'received.private.json', f.targetReceived); }
    if (reason === 'capacity') { f.sourceSession.capacityBytes = 100; await f.refresh(); }
    if (reason === 'active') f.control.authority.status = 'active';
    if (reason === 'other-import') f.control.authority.importSha256 = '9'.repeat(64);
    if (reason === 'stage') f.control.stage = { _id: 'direct-stage' };
    if (reason === 'worker') f.entries[1].pm2_env.status = 'online';
    await assert.rejects(f.run(), error => !String(error).includes(f.appRoot) && !String(error).includes('PRIVATE FICTIONAL'));
    await assert.rejects(fs.stat(path.join(f.target, 'activation-template.private.json')), { code: 'ENOENT' });
    assert.equal((await fs.readdir(f.target)).some(name => name.startsWith('proof-supplement-')), false);
  });
});

test('a partial interrupted copy is retryable and never replaces a concurrently created proof', async t => {
  const f = await fixture(t), link = fs.link;
  let interrupted = false;
  fs.link = async (from, to) => {
    if (!interrupted && to === path.join(f.target, 'activation-template.private.json')) {
      interrupted = true; throw Error('fictional private interruption');
    }
    return link(from, to);
  };
  try { await assert.rejects(f.run(), error => !String(error).includes('fictional private')); } finally { fs.link = link; }
  assert(interrupted); assert.deepEqual(await fs.readFile(path.join(f.target, 'closure-proof.private.json')), f.files.get('closure-proof.private.json'));
  assert.equal((await f.run()).status, 'native-proofs-staged');
  assert.equal((await fs.readdir(f.target)).some(name => name.endsWith('.tmp')), false);
});

test('a concurrently created target proof is retained without overwrite or a false completion receipt', async t => {
  const f = await fixture(t), link = fs.link, independent = encoded({ version: 1, independentlyWritten: true });
  fs.link = async (from, to) => {
    if (to === path.join(f.target, 'activation-template.private.json')) await fs.writeFile(to, independent, { flag: 'wx', mode: 0o600 });
    return link(from, to);
  };
  try { await assert.rejects(f.run(), /concurrently created proof differs/); } finally { fs.link = link; }
  assert.deepEqual(await fs.readFile(path.join(f.target, 'activation-template.private.json')), independent);
  assert.equal((await fs.readdir(f.target)).some(name => name.startsWith('proof-supplement-')), false);
});

test('source or target receipt drift during a partial copy cannot produce completion', async t => {
  for (const root of ['source', 'target']) await t.test(root, async t => {
    const f = await fixture(t), link = fs.link;
    fs.link = async (from, to) => {
      const result = await link(from, to);
      if (to === path.join(f.target, 'closure-proof.private.json')) await fs.appendFile(path.join(f[root], 'received.private.json'), ' ');
      return result;
    };
    try { await assert.rejects(f.run(), /transfer or proof source changed/); } finally { fs.link = link; }
    assert.equal((await fs.readdir(f.target)).some(name => name.startsWith('proof-supplement-')), false);
    assert.equal(f.control.authority.status, 'staging');
  });
});

test('a source transfer with undeclared archive objects or extra inputs is not a metadata supplement', async t => {
  const f = await fixture(t);
  f.sourceReceived.inputFiles.push({ name: 'unexpected.private.json', sha256: hash('extra'), bytes: 5 });
  f.sourceReceived.objects++; f.sourceReceived.bytes += 5;
  f.sourceSession.plan.objectCount++; f.sourceSession.plan.objectBytes += 5;
  await f.save(f.source, 'session.private.json', f.sourceSession); await f.save(f.source, 'received.private.json', f.sourceReceived);
  await assert.rejects(f.run(), /supplement inventory differs/);
  await assert.rejects(fs.stat(path.join(f.target, 'closure-proof.private.json')), { code: 'ENOENT' });
});

test('a later supplement can add another proof subset without changing earlier staged metadata or original receipts', async t => {
  const f = await fixture(t); f.control.authority = null;
  f.files.delete('activation-template.private.json'); await f.refresh();
  await f.run();
  const closure = await fs.readFile(path.join(f.target, 'closure-proof.private.json'));
  const originalSourceReceipt = await fs.readFile(path.join(f.source, 'received.private.json'));
  await assert.rejects(fs.stat(path.join(f.target, 'activation-template-source.private.json')), { code: 'ENOENT' });
  const nextId = '00000000-0000-4000-8000-000000000013', nextSource = path.join(f.transferRoot, nextId);
  await fs.mkdir(nextSource, { mode: 0o700 });
  const proof = encoded({ version: 1, fictional: 'bounded quiet evidence' });
  const ref = { name: 'quiet-audit.private.json', sha256: hash(proof), bytes: proof.length };
  const template = encoded({ version: 1, kind: 'native-proof-supplement-v1', targetSessionId: targetId,
    profileSha256: f.profileSha256, files: [ref] });
  const inputs = [{ name: 'supplement-template.private.json', sha256: hash(template), bytes: template.length }, ref];
  const size = template.length + proof.length;
  await f.save(nextSource, 'session.private.json', { ...f.sourceSession, sessionId: nextId,
    plan: { ...f.sourceSession.plan, objectCount: 2, objectBytes: size } });
  await f.save(nextSource, 'received.private.json', { ...f.sourceReceived, sessionId: nextId, objects: 2, bytes: size, inputFiles: inputs });
  await f.save(nextSource, 'supplement-template.private.json', template); await f.save(nextSource, ref.name, proof);
  const result = await f.run({ sessionId: nextId, templateSha256: hash(template) });
  assert.equal(result.files, 1); assert.deepEqual(await fs.readFile(path.join(f.target, 'closure-proof.private.json')), closure);
  assert.deepEqual(await fs.readFile(path.join(f.source, 'received.private.json')), originalSourceReceipt);
  assert.equal((await fs.readdir(f.target)).filter(name => name.startsWith('proof-supplement-')).length, 2);
});
