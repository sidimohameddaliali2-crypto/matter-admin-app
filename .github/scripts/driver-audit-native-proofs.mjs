import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID, createPublicKey } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

export const NATIVE_PROOF_FILES = Object.freeze(['activation-template.private.json', 'closure-proof.private.json',
  'source-release.private.json', 'source-backup.private.json', 'source-parity.private.json', 'source-credentials.private.json',
  'source-fence.private.json', 'capability-audit.private.json', 'drain-audit.private.json', 'quiet-audit.private.json', 'checkpoint.private.json']);
const exec = promisify(execFile), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, fields) => object(value) && isDeepStrictEqual(Object.keys(value).sort(), [...fields].sort());
const check = (condition, message) => { if (!condition) throw Object.assign(Error(message), { supplementGuard: true }); };
const capacityBytes = 16 * 1024 ** 3, maximumFile = 16 * 1024 * 1024;
const sourceManifest = '15301337474717828b88997faac92cbc23763b16ed1fc7881fa6bd553696a64b';

function publicRecipient(value) {
  check(typeof value === 'string' && value.length <= 8192 && !value.includes('PRIVATE KEY')
    && /^-----BEGIN (?:RSA )?PUBLIC KEY-----[\s\S]+-----END (?:RSA )?PUBLIC KEY-----\s*$/.test(value),
  'A bounded strong public RSA recipient is required');
  let key;
  try { key = createPublicKey(value); } catch { throw Error('A bounded strong public RSA recipient is required'); }
  check(key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails.modulusLength >= 3072,
    'A bounded strong public RSA recipient is required');
}

function verifiedSession(state, received, sessionId) {
  check(state.version === 1 && state.sessionId === sessionId && state.capacityBytes === capacityBytes
    && typeof state.targetDatabase === 'string' && state.targetDatabase.length > 0 && digest(state.inventorySha256)
    && state.plan?.inventorySha256 === state.inventorySha256 && integer(state.createdAt) && state.createdAt <= Date.now()
    && received.version === 1 && received.status === 'transfer-received' && received.verified === true
    && received.authorityChanged === false && received.sessionId === sessionId && received.targetDatabase === state.targetDatabase
    && received.inventorySha256 === state.inventorySha256 && received.objects === state.plan.objectCount
    && received.bytes === state.plan.objectBytes && integer(received.objects) && received.objects > 0 && received.objects <= 100000
    && integer(received.bytes) && received.bytes > 0 && received.bytes <= 2 * 1024 ** 3
    && Number.isFinite(Date.parse(received.completedAt)) && Date.parse(received.completedAt) >= state.createdAt
    && Date.parse(received.completedAt) <= Date.now() && Array.isArray(received.inputFiles) && received.inputFiles.length > 0
    && received.inputFiles.length <= received.objects, 'The verified proof transfer session differs');
}

async function immutable(file, bytes, read) {
  try { check((await read(file, maximumFile)).equals(bytes), 'An existing immutable proof differs'); return false; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path.join(path.dirname(file), '.native-proof-' + randomUUID() + '.tmp');
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try { await fs.link(temporary, file); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      check((await read(file, maximumFile)).equals(bytes), 'A concurrently created proof differs'); return false;
    }
    const directory = await fs.open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    check((await read(file, maximumFile)).equals(bytes), 'The staged proof did not read back exactly'); return true;
  } finally { await fs.unlink(temporary); }
}

// Export only fixed control files selected from the actual import profile.
// File bodies and host paths leave the server only inside the RSA capsule.
export async function runDriverAuditNativeControlExport({ operation, sessionId, profileSha256, expectedSha,
  appRoot, recipientPublicKey, qualificationFixtureSha256 }, adapters = {}) {
  let phase = 'checkout', connection, lock;
  const execute = adapters.exec || exec, env = adapters.env || process.env;
  try {
    check(operation === 'export-native-controls' && uuid(sessionId) && digest(profileSha256)
      && (qualificationFixtureSha256 === undefined || digest(qualificationFixtureSha256)), 'Exact control export identities are required');
    publicRecipient(recipientPublicKey);
    check(typeof appRoot === 'string' && path.isAbsolute(appRoot) && path.resolve(appRoot) === appRoot
      && await fs.realpath(appRoot) === appRoot, 'The exact application root is required');
    const checkout = async () => {
      check((adapters.platform || process.platform) === 'linux' && /^[a-f0-9]{40}$/.test(expectedSha || '')
        && (await execute('git', ['rev-parse', 'HEAD'], { cwd: appRoot, timeout: 5000, maxBuffer: 4096 })).stdout.trim() === expectedSha,
      'The exact reviewed Linux checkout is required');
      await execute('git', ['diff', '--quiet', expectedSha, '--', 'server/loadEnv.js', 'server/services/driverAuditSource.js',
        'server/services/driverAuditTransferCodec.js', 'server/vendor/driver-audits/integration/hosted/worker-lock.mjs'],
      { cwd: appRoot, timeout: 5000, maxBuffer: 4096 });
    };
    await checkout(); const server = path.join(appRoot, 'server');
    check(await fs.realpath(server) === server, 'The exact server directory is required');
    const load = adapters.load || (name => import(pathToFileURL(path.join(server, name)).href));
    await load('loadEnv.js');
    const { readPrivateDriverAuditSource: read, requirePrivateDriverAuditSourceDirectory: privateDirectory,
      readDriverAuditSourceConfig } = await load('services/driverAuditSource.js');
    const transferRoot = path.join(server, '.private/driver-audit-native-transfer'), folder = path.join(transferRoot, sessionId);
    phase = 'private-controls'; await privateDirectory(transferRoot); await privateDirectory(folder);
    const { acquireWorkerLock } = await load('vendor/driver-audits/integration/hosted/worker-lock.mjs');
    lock = await acquireWorkerLock(path.join(transferRoot, 'operator.lock'));
    const pins = new Map(), files = [];
    const pinned = async (file, name, expected) => {
      const bytes = await read(file, 1024 * 1024);
      check(expected === undefined || hash(bytes) === expected, 'A fixed control file differs');
      pins.set(file, hash(bytes));
      if (name) files.push({ name, sha256: hash(bytes), bytes: bytes.length, dataBase64: bytes.toString('base64') });
      return JSON.parse(bytes);
    };
    const state = await pinned(path.join(folder, 'session.private.json'));
    const received = await pinned(path.join(folder, 'received.private.json'));
    verifiedSession(state, received, sessionId);
    const profile = await pinned(path.join(folder, 'profile.private.json'), 'profile.private.json', profileSha256);
    const syncRoot = profile.syncRoot, sourceRoot = path.join(server, '.private/driver-audit-source', sourceManifest);
    check(profile.version === 2 && profile.targetDatabase === state.targetDatabase && profile.capacityBytes === capacityBytes
      && path.dirname(syncRoot || '') === path.join(server, '.private/driver-audits') && digest(path.basename(syncRoot))
      && profile.runtimeRoot === path.join(sourceRoot, 'runtime') && profile.runtimeSha256 === sourceManifest,
    'The exact original control profile differs');
    await privateDirectory(syncRoot); await privateDirectory(sourceRoot);
    const source = await pinned(path.join(sourceRoot, 'source.json'), 'source.json');
    const config = await readDriverAuditSourceConfig(path.join(sourceRoot, 'source.json'));
    check(source.root === sourceRoot && source.runtimeRoot === profile.runtimeRoot && source.manifestSha256 === sourceManifest
      && config.configSha256 === pins.get(path.join(sourceRoot, 'source.json')) && config.dataStore === 'mongo'
      && config.archiveCacheDirectory === path.join(syncRoot, 'work/archive-cache'), 'The exact qualified source configuration differs');
    const sync = await pinned(path.join(syncRoot, 'sync.json'), 'sync.json');
    check(sync.version === 1 && sync.root === syncRoot && sync.codeRoot === path.join(syncRoot, 'builder')
      && sync.baselineRoot === path.join(syncRoot, 'baseline') && digest(sync.builderSha256), 'The exact managed builder differs');
    const pointerFile = path.join(syncRoot, 'work/current.private.json');
    try { await pinned(pointerFile); }
    catch (error) { if (error.code !== 'ENOENT') throw error; pins.set(pointerFile, null); }
    const settings = await pinned(path.join(folder, 'native-settings-plan.private.json'), 'native-settings-plan.private.json');
    check(settings.version === 1 && settings.operation === 'prepare-native-settings' && settings.sessionId === sessionId
      && settings.applicationCommit === expectedSha && settings.profileSha256 === profileSha256
      && settings.targetDatabase === profile.targetDatabase && settings.sourceManifestSha256 === sourceManifest
      && settings.syncConfigSha256 === pins.get(path.join(syncRoot, 'sync.json')) && settings.sourceConfigSha256 === config.configSha256
      && settings.archiveCacheDirectory === config.archiveCacheDirectory && settings.nativeSettingsApplied === false
      && settings.requiresFinalFenceAndParity === true, 'The exact prepared native settings differ');
    if (qualificationFixtureSha256) {
      const name = 'qualification-' + qualificationFixtureSha256 + '.private.json';
      const qualification = await pinned(path.join(sourceRoot, name), name);
      check(qualification.version === 1 && qualification.fixtureSha256 === qualificationFixtureSha256
        && qualification.commit === expectedSha && qualification.configSha256 === config.configSha256
        && qualification.manifestSha256 === sourceManifest && qualification.environmentSha256 === config.environmentReference.sha256,
      'The actual host qualification receipt differs');
    }
    phase = 'database'; check(typeof env.MONGODB_URI === 'string' && env.MONGODB_URI.length > 0, 'The existing app database is required');
    const { default: mongoose } = await load('node_modules/mongoose/index.js');
    connection = mongoose.createConnection(env.MONGODB_URI, { autoCreate: false, autoIndex: false, maxPoolSize: 1, serverSelectionTimeoutMS: 10000 });
    await connection.asPromise(); const db = connection.db;
    check(db.databaseName === profile.targetDatabase, 'The control export targets another app database');
    let baseline;
    const safety = async () => {
      await checkout();
      for (const [file, expected] of pins) {
        let bytes;
        try { bytes = await read(file, 1024 * 1024); }
        catch (error) { if (error.code !== 'ENOENT' || expected !== null) throw error; }
        check(expected === null ? bytes === undefined : bytes && hash(bytes) === expected, 'A private control changed during export');
      }
      check((await readDriverAuditSourceConfig(path.join(sourceRoot, 'source.json'))).configSha256 === config.configSha256,
        'The source configuration changed during export');
      const entries = JSON.parse((await execute('pm2', ['jlist'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 })).stdout);
      check(Array.isArray(entries), 'The managed process inventory differs');
      const syncWorkers = entries.filter(row => row.name === 'matter-driver-audit-sync');
      const sourceWorkers = entries.filter(row => row.name === 'matter-driver-audit-source');
      check(syncWorkers.length === 1 && syncWorkers[0].pm2_env?.status === 'stopped' && syncWorkers[0].pm2_env.pm_cwd === server
        && syncWorkers[0].pm2_env.pm_exec_path === path.join(server, 'scripts/driverAuditSync.js')
        && isDeepStrictEqual(syncWorkers[0].pm2_env.args, ['--config', path.join(syncRoot, 'sync.json')])
        && sourceWorkers.length <= 1 && sourceWorkers.every(row => row.pm2_env?.status === 'stopped'
          && row.pm2_env.pm_cwd === server && row.pm2_env.pm_exec_path === path.join(server, 'scripts/driverAuditSource.js')
          && isDeepStrictEqual(row.pm2_env.args, ['--config', path.join(sourceRoot, 'source.json')])),
      'Control export requires stopped exact managed report workers');
      const [authority, stage, capacity, head] = await Promise.all([
        db.collection('driverAuditNativeControl').findOne({ _id: 'authority' }), db.collection('driverAuditControl').findOne({ _id: 'direct-stage' }),
        db.collection('driverAuditNativeControl').findOne({ _id: 'capacity' }), db.collection('driverAuditControl').findOne({ _id: 'head' }),
      ]);
      check(!authority || authority.status === 'staging' && authority.importSha256 === profileSha256 && integer(authority.writeFence),
        'Control export requires inactive matching native authority');
      check(!stage && (!capacity || capacity.limitBytes === capacityBytes && integer(capacity.usedBytes) && capacity.usedBytes <= capacityBytes),
        'A direct stage or native allowance blocks control export');
      const current = hash(JSON.stringify([authority, stage, capacity, head, [...syncWorkers, ...sourceWorkers].map(row => ({
        name: row.name, id: row.pm_id ?? null, pid: row.pid ?? null, status: row.pm2_env.status,
        cwd: row.pm2_env.pm_cwd, script: row.pm2_env.pm_exec_path, args: row.pm2_env.args,
        nodeArgs: row.pm2_env.node_args ?? [], uptime: row.pm2_env.pm_uptime ?? null,
      }))]));
      check(!baseline || current === baseline, 'Protected reporting controls changed during export'); baseline = current;
    };
    phase = 'held-readback'; await safety();
    const envelope = Buffer.from(JSON.stringify({ version: 1, kind: 'native-control-export-v1', sessionId,
      applicationCommit: expectedSha, profileSha256, ...(qualificationFixtureSha256 ? { qualificationFixtureSha256 } : {}), files }));
    check(envelope.length <= 4 * 1024 * 1024, 'The fixed private control export exceeds its bound');
    const packed = gzipSync(envelope); check(packed.length <= 40 * 1024, 'The sealed private control export exceeds its bound');
    const { sealTransferSecrets } = await load('services/driverAuditTransferCodec.js');
    const capsule = sealTransferSecrets(recipientPublicKey, { version: 1, kind: 'native-control-export-capsule-v1',
      sessionId, applicationCommit: expectedSha, profileSha256, envelopeSha256: hash(envelope), envelopeBytes: envelope.length,
      gzipSha256: hash(packed), gzipBytes: packed.length, gzipBase64: packed.toString('base64') });
    await safety();
    return { version: 1, status: 'native-controls-exported', sessionId, applicationCommit: expectedSha, profileSha256,
      files: files.length, recipientSha256: hash(recipientPublicKey), envelopeSha256: hash(envelope), capsule,
      authorityChanged: false, proofsVerified: false };
  } catch (error) {
    throw Object.assign(Error(error.supplementGuard ? error.message : 'Native control export stopped at ' + phase), { phase });
  } finally {
    let failed = false;
    try { await connection?.close(); } catch { failed = true; }
    try { await lock?.release(); } catch { failed = true; }
    if (failed) throw Object.assign(Error('Native control export cleanup stopped'), { phase: 'cleanup' });
  }
}

// Later proof metadata has its own verified encrypted transfer. This operation
// never changes the original transfer, import profile, datasets or authority.
export async function runDriverAuditNativeProofs({ operation, sessionId, templateSha256, expectedSha, appRoot }, adapters = {}) {
  let phase = 'checkout', connection, lock;
  const execute = adapters.exec || exec, env = adapters.env || process.env;
  try {
    check(operation === 'stage-native-proofs' && uuid(sessionId) && digest(templateSha256), 'Exact public proof supplement identities are required');
    check(typeof appRoot === 'string' && path.isAbsolute(appRoot) && path.resolve(appRoot) === appRoot
      && await fs.realpath(appRoot) === appRoot, 'The exact app root is required');
    const checkout = async () => {
      check((adapters.platform || process.platform) === 'linux' && /^[a-f0-9]{40}$/.test(expectedSha || '')
        && (await execute('git', ['rev-parse', 'HEAD'], { cwd: appRoot, timeout: 5000, maxBuffer: 4096 })).stdout.trim() === expectedSha,
      'The exact reviewed Linux checkout is required');
      await execute('git', ['diff', '--quiet', expectedSha, '--', 'server/loadEnv.js', 'server/services/driverAuditSource.js',
        'server/vendor/driver-audits/integration/hosted/worker-lock.mjs'], { cwd: appRoot, timeout: 5000, maxBuffer: 4096 });
    };
    await checkout(); const server = path.join(appRoot, 'server');
    check(await fs.realpath(server) === server, 'The exact server directory is required');
    const load = adapters.load || (name => import(pathToFileURL(path.join(server, name)).href));
    await load('loadEnv.js');
    const { readPrivateDriverAuditSource: read, requirePrivateDriverAuditSourceDirectory: privateDirectory } = await load('services/driverAuditSource.js');
    const transferRoot = path.join(server, '.private/driver-audit-native-transfer'), source = path.join(transferRoot, sessionId);
    phase = 'private-source'; await privateDirectory(transferRoot); await privateDirectory(source);
    const { acquireWorkerLock } = await load('vendor/driver-audits/integration/hosted/worker-lock.mjs');
    lock = await acquireWorkerLock(path.join(transferRoot, 'operator.lock'));
    const pins = new Map();
    const pinned = async (file, maximum, expected) => {
      const bytes = await read(file, maximum);
      check(expected === undefined || hash(bytes) === expected, 'A pinned proof supplement input differs');
      pins.set(file, { maximum, sha256: hash(bytes) }); return bytes;
    };
    const sourceSessionBytes = await pinned(path.join(source, 'session.private.json'), 128 * 1024);
    const sourceReceivedBytes = await pinned(path.join(source, 'received.private.json'), 1024 * 1024);
    const sourceSession = JSON.parse(sourceSessionBytes), sourceReceived = JSON.parse(sourceReceivedBytes);
    verifiedSession(sourceSession, sourceReceived, sessionId);
    const templateBytes = await pinned(path.join(source, 'supplement-template.private.json'), 128 * 1024, templateSha256);
    const template = JSON.parse(templateBytes);
    check(exact(template, ['version', 'kind', 'targetSessionId', 'profileSha256', 'files']) && template.version === 1
      && template.kind === 'native-proof-supplement-v1' && uuid(template.targetSessionId) && template.targetSessionId !== sessionId
      && digest(template.profileSha256) && Array.isArray(template.files) && template.files.length > 0
      && template.files.length <= NATIVE_PROOF_FILES.length, 'The fixed proof supplement template differs');
    const names = new Set(), inputs = [];
    for (const ref of template.files) {
      check(exact(ref, ['name', 'sha256', 'bytes']) && NATIVE_PROOF_FILES.includes(ref.name) && !names.has(ref.name)
        && digest(ref.sha256) && integer(ref.bytes) && ref.bytes > 0 && ref.bytes <= maximumFile,
      'Only unique fixed proof metadata names are accepted');
      names.add(ref.name); inputs.push({ ...ref });
    }
    const union = [{ name: 'supplement-template.private.json', sha256: templateSha256, bytes: templateBytes.length }, ...inputs];
    check(sourceReceived.inputFiles.length === union.length && sourceReceived.objects === union.length
      && sourceReceived.bytes === union.reduce((n, row) => n + row.bytes, 0)
      && union.every(ref => sourceReceived.inputFiles.filter(row => exact(row, ['name', 'sha256', 'bytes'])
        && isDeepStrictEqual(row, ref)).length === 1), 'The received proof supplement inventory differs');
    const target = path.join(transferRoot, template.targetSessionId);
    phase = 'private-target'; await privateDirectory(target);
    const targetSessionBytes = await pinned(path.join(target, 'session.private.json'), 128 * 1024);
    const targetReceivedBytes = await pinned(path.join(target, 'received.private.json'), 1024 * 1024);
    const targetSession = JSON.parse(targetSessionBytes), targetReceived = JSON.parse(targetReceivedBytes);
    verifiedSession(targetSession, targetReceived, template.targetSessionId);
    check(targetSession.targetDatabase === sourceSession.targetDatabase, 'The two proof transfers target different databases');
    const profileBytes = await pinned(path.join(target, 'profile.private.json'), 1024 * 1024, template.profileSha256);
    const profile = JSON.parse(profileBytes), syncRoot = profile.syncRoot;
    check(profile.version === 2 && profile.capacityBytes === capacityBytes && profile.targetDatabase === targetSession.targetDatabase
      && path.dirname(syncRoot || '') === path.join(server, '.private/driver-audits') && digest(path.basename(syncRoot)),
    'The exact original target profile differs');
    await privateDirectory(syncRoot);
    const staged = [];
    let bytes = 0;
    for (const ref of inputs) {
      bytes += ref.bytes; check(bytes <= 64 * 1024 * 1024, 'The proof metadata supplement exceeds its bound');
      const value = await pinned(path.join(source, ref.name), ref.bytes, ref.sha256);
      check(value.length === ref.bytes && Buffer.from(value.toString('utf8')).equals(value), 'The proof metadata byte length or encoding differs');
      const parsed = JSON.parse(value);
      check(object(parsed) && parsed.version === 1, 'Proof supplements must be version-one JSON metadata objects');
      staged.push({ name: ref.name, bytes: value });
    }
    if (names.has('activation-template.private.json')) staged.push({ name: 'activation-template-source.private.json',
      bytes: Buffer.from(JSON.stringify({ version: 1, kind: 'native-activation-template-provenance-v1',
        targetSessionId: template.targetSessionId, profileSha256: template.profileSha256, sourceSessionId: sessionId,
        sourceSessionSha256: hash(sourceSessionBytes), sourceReceivedSha256: hash(sourceReceivedBytes),
        input: inputs.find(ref => ref.name === 'activation-template.private.json'), supplementSha256: templateSha256 }, null, 2) + '\n') });
    // Check the complete destination set before copying any proof.
    for (const item of staged) {
      try { check((await read(path.join(target, item.name), maximumFile)).equals(item.bytes), 'An existing target proof or provenance differs'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    phase = 'database'; check(typeof env.MONGODB_URI === 'string' && env.MONGODB_URI.length > 0, 'The existing app database is required');
    const { default: mongoose } = await load('node_modules/mongoose/index.js');
    connection = mongoose.createConnection(env.MONGODB_URI, { autoCreate: false, autoIndex: false, maxPoolSize: 1, serverSelectionTimeoutMS: 10000 });
    await connection.asPromise(); const db = connection.db;
    check(db.databaseName === profile.targetDatabase, 'The proof supplement targets another app database');
    let baseline;
    const safety = async () => {
      await checkout();
      for (const [file, pin] of pins) check(hash(await read(file, pin.maximum)) === pin.sha256, 'An original transfer or proof source changed');
      const entries = JSON.parse((await execute('pm2', ['jlist'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 })).stdout);
      check(Array.isArray(entries), 'The managed process inventory differs');
      const sync = entries.filter(row => row.name === 'matter-driver-audit-sync'), sourceWorkers = entries.filter(row => row.name === 'matter-driver-audit-source');
      check(sync.length === 1 && sync[0].pm2_env?.status === 'stopped' && sync[0].pm2_env.pm_cwd === server
        && sync[0].pm2_env.pm_exec_path === path.join(server, 'scripts/driverAuditSync.js')
        && isDeepStrictEqual(sync[0].pm2_env.args, ['--config', path.join(syncRoot, 'sync.json')])
        && sourceWorkers.length <= 1 && sourceWorkers.every(row => row.pm2_env?.status === 'stopped'),
      'Proof staging requires stopped managed report workers');
      const [authority, directStage, capacity, head] = await Promise.all([
        db.collection('driverAuditNativeControl').findOne({ _id: 'authority' }),
        db.collection('driverAuditControl').findOne({ _id: 'direct-stage' }),
        db.collection('driverAuditNativeControl').findOne({ _id: 'capacity' }),
        db.collection('driverAuditControl').findOne({ _id: 'head' }),
      ]);
      check(!authority || authority.status === 'staging' && authority.importSha256 === template.profileSha256 && integer(authority.writeFence),
        'The exact profile must have inactive native authority');
      check(!directStage && (!capacity || capacity.limitBytes === capacityBytes && integer(capacity.usedBytes) && capacity.usedBytes <= capacityBytes),
        'A direct stage or native allowance blocks proof staging');
      const configBytes = await read(path.join(syncRoot, 'sync.json'), 1024 * 1024), config = JSON.parse(configBytes);
      check(config.version === 1 && config.root === syncRoot && config.codeRoot === path.join(syncRoot, 'builder')
        && config.baselineRoot === path.join(syncRoot, 'baseline'), 'The managed sync configuration differs');
      const current = hash(JSON.stringify([authority, directStage, capacity, head, hash(configBytes),
        [...sync, ...sourceWorkers].map(row => ({ name: row.name, id: row.pm_id ?? null, pid: row.pid ?? null, config: row.pm2_env.args ?? null }))]));
      check(!baseline || current === baseline, 'The protected report state changed during proof staging'); baseline = current;
    };
    phase = 'held-admission'; await safety();
    let copied = 0;
    for (const item of staged) {
      phase = 'private-copy'; if (await immutable(path.join(target, item.name), item.bytes, read)) copied++;
    }
    phase = 'readback';
    for (const item of staged) check((await read(path.join(target, item.name), maximumFile)).equals(item.bytes), 'A staged proof changed during readback');
    await safety();
    const receipt = { version: 1, kind: 'native-proof-supplement-receipt-v1', sourceSessionId: sessionId,
      targetSessionId: template.targetSessionId, profileSha256: template.profileSha256, supplementSha256: templateSha256,
      sourceSessionSha256: hash(sourceSessionBytes), sourceReceivedSha256: hash(sourceReceivedBytes),
      targetSessionSha256: hash(targetSessionBytes), targetReceivedSha256: hash(targetReceivedBytes), files: inputs,
      ...(names.has('activation-template.private.json') ? { activationTemplateProvenanceSha256: hash(staged.at(-1).bytes) } : {}),
      originalInputsUnchanged: true, proofsVerified: false, authorityChanged: false };
    const receiptBytes = Buffer.from(JSON.stringify(receipt, null, 2) + '\n');
    phase = 'private-receipt'; await immutable(path.join(target, 'proof-supplement-' + templateSha256 + '.private.json'), receiptBytes, read);
    await safety();
    return { version: 1, status: copied ? 'native-proofs-staged' : 'native-proofs-already-staged',
      sourceSessionId: sessionId, targetSessionId: template.targetSessionId, profileSha256: template.profileSha256,
      supplementSha256: templateSha256, files: inputs.length, bytes, receiptSha256: hash(receiptBytes),
      originalInputsUnchanged: true, proofsVerified: false, authorityChanged: false, activationPending: true };
  } catch (error) {
    throw Object.assign(Error(error.supplementGuard ? error.message : 'Native proof staging stopped at ' + phase), { phase });
  } finally {
    let failed = false;
    try { await connection?.close(); } catch { failed = true; }
    try { await lock?.release(); } catch { failed = true; }
    if (failed) throw Object.assign(Error('Native proof staging cleanup stopped'), { phase: 'cleanup' });
  }
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runDriverAuditNativeProofs({ operation: process.env.NATIVE_HANDOFF_OPERATION,
    sessionId: process.env.NATIVE_TRANSFER_SESSION_ID, templateSha256: process.env.NATIVE_IMPORT_TEMPLATE_SHA256,
    expectedSha: process.env.EXPECTED_DEPLOYED_SHA, appRoot: await fs.realpath(process.cwd()) }))); }
  catch (error) { console.error('Native proof staging stopped at ' + (error.phase || 'checkout') + '. Preserve the original transfer and inspect its proof supplement.'); process.exitCode = 1; }
}
