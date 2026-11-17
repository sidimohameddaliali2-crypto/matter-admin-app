import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execute = promisify(execFile), hash = value => createHash('sha256').update(value).digest('hex');
const sourceManifest = 'e1650c0a521271976629fafc1ad6d6eb0abf39074b5eeaf909f2d93f929f9d9d';
const capacityBytes = 16 * 1024 ** 3;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const same = (a, b) => isDeepStrictEqual(a, b);
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const check = (value, message) => { if (!value) throw Object.assign(Error(message), { activationGuard: true }); };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const twoPhaseAuthorityBinding = value => value?.fence?.mode === 'reporting-database-capability-v2'
  || Object.hasOwn(value || {}, 'verifiedSourceFenceSha256') || Object.hasOwn(value?.fence || {}, 'sourceFence');

async function templateProvenance({ read, privateDirectory, folder, transferRoot, sessionId, profileSha256, targetDatabase,
  received, templateBytes, templateSha256, inputPins, externalPins }) {
  const name = 'activation-template.private.json', direct = received.inputFiles?.filter(row => row.name === name);
  if (direct?.length === 1) {
    check(direct[0].sha256 === templateSha256 && direct[0].bytes === templateBytes.length,
      'The original activation template input differs'); return;
  }
  check(!direct?.length, 'Repeated activation template inputs differ');
  const metadataBytes = await read(path.join(folder, 'activation-template-source.private.json'), 128 * 1024);
  inputPins.set('activation-template-source.private.json', { expected: hash(metadataBytes), maximum: 128 * 1024 });
  const value = JSON.parse(metadataBytes), fields = ['version', 'kind', 'targetSessionId', 'profileSha256', 'sourceSessionId',
    'sourceSessionSha256', 'sourceReceivedSha256', 'input', 'supplementSha256'];
  check(same(Object.keys(value).sort(), fields.sort()) && value.version === 1
    && value.kind === 'native-activation-template-provenance-v1' && value.targetSessionId === sessionId
    && value.profileSha256 === profileSha256 && uuid(value.sourceSessionId) && value.sourceSessionId !== sessionId
    && [value.sourceSessionSha256, value.sourceReceivedSha256, value.supplementSha256].every(digest)
    && same(value.input, { name, sha256: templateSha256, bytes: templateBytes.length }),
  'The supplemental activation template provenance differs');
  const sourceFolder = path.join(transferRoot, value.sourceSessionId);
  await privateDirectory(sourceFolder);
  const sourceRead = async (name, expected, maximum) => {
    const file = path.join(sourceFolder, name), bytes = await read(file, maximum);
    check(hash(bytes) === expected, 'A supplemental source input differs');
    externalPins.set(file, { expected, maximum }); return bytes;
  };
  const source = JSON.parse(await sourceRead('session.private.json', value.sourceSessionSha256, 128 * 1024));
  const sourceReceived = JSON.parse(await sourceRead('received.private.json', value.sourceReceivedSha256, 1024 * 1024));
  check(source.version === 1 && source.sessionId === value.sourceSessionId && source.targetDatabase === targetDatabase
    && source.capacityBytes === capacityBytes && digest(source.inventorySha256) && source.plan?.inventorySha256 === source.inventorySha256
    && integer(source.createdAt) && source.createdAt <= Date.now() && sourceReceived.version === 1
    && sourceReceived.status === 'transfer-received' && sourceReceived.verified === true && sourceReceived.authorityChanged === false
    && sourceReceived.sessionId === source.sessionId && sourceReceived.targetDatabase === targetDatabase
    && sourceReceived.inventorySha256 === source.inventorySha256 && sourceReceived.objects === source.plan.objectCount
    && sourceReceived.bytes === source.plan.objectBytes && integer(sourceReceived.objects) && sourceReceived.objects > 1
    && integer(sourceReceived.bytes) && sourceReceived.bytes > 0 && sourceReceived.bytes <= 64 * 1024 ** 2 + 128 * 1024
    && Date.parse(sourceReceived.completedAt) >= source.createdAt && Date.parse(sourceReceived.completedAt) <= Date.now(),
  'The verified supplemental session or target database differs');
  const supplementBytes = await sourceRead('supplement-template.private.json', value.supplementSha256, 128 * 1024);
  const supplement = JSON.parse(supplementBytes), names = ['activation-template', 'closure-proof', 'source-release', 'source-backup',
    'source-parity', 'source-credentials', 'source-fence', 'capability-audit', 'drain-audit', 'quiet-audit', 'checkpoint'].map(item => item + '.private.json');
  check(same(Object.keys(supplement).sort(), ['files', 'kind', 'profileSha256', 'targetSessionId', 'version'])
    && supplement.version === 1 && supplement.kind === 'native-proof-supplement-v1' && supplement.targetSessionId === sessionId
    && supplement.profileSha256 === profileSha256 && Array.isArray(supplement.files) && supplement.files.length > 0
    && supplement.files.length <= names.length && supplement.files.every(row => names.includes(row?.name) && digest(row.sha256)
      && integer(row.bytes) && row.bytes > 0 && row.bytes <= 16 * 1024 * 1024
      && same(Object.keys(row).sort(), ['bytes', 'name', 'sha256']))
    && new Set(supplement.files.map(row => row.name)).size === supplement.files.length
    && supplement.files.reduce((sum, row) => sum + row.bytes, 0) <= 64 * 1024 ** 2
    && supplement.files.some(row => same(row, value.input)), 'The fixed supplemental proof manifest differs');
  const union = [{ name: 'supplement-template.private.json', sha256: value.supplementSha256, bytes: supplementBytes.length }, ...supplement.files];
  check(Array.isArray(sourceReceived.inputFiles) && sourceReceived.inputFiles.length === union.length
    && sourceReceived.objects === union.length && sourceReceived.bytes === union.reduce((sum, row) => sum + row.bytes, 0)
    && union.every(row => sourceReceived.inputFiles.filter(saved => same(saved, row)).length === 1),
  'The supplemental received inventory differs');
  check((await sourceRead(name, templateSha256, templateBytes.length)).equals(templateBytes),
    'The original supplemental template bytes differ');
}

async function savePrivate(file, bytes, read) {
  try { check((await read(file, 4 * 1024 * 1024)).equals(bytes), 'An immutable activation receipt differs'); return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = file + '.' + randomUUID() + '.tmp', handle = await fs.open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await fs.link(temporary, file);
    const directory = await fs.open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await fs.rm(temporary, { force: true }); }
}

async function commitSettings(file, before, after, read) {
  check((await read(file, 1024 * 1024)).equals(before), 'Application settings changed before native commit');
  const temporary = file + '.native-' + randomUUID() + '.tmp';
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(after); await handle.sync(); } finally { await handle.close(); }
    check((await read(file, 1024 * 1024)).equals(before), 'Application settings changed before native rename');
    await fs.rename(temporary, file);
    const directory = await fs.open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await fs.rm(temporary, { force: true }); }
}

async function baseSettings(file) {
  const stat = await fs.lstat(file);
  check(stat.isFile() && stat.uid === process.getuid() && stat.size <= 1024 * 1024
    && await fs.realpath(file) === file, 'The durable base settings file differs');
  const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    check(opened.ino === stat.ino && opened.dev === stat.dev, 'The base settings changed while reading');
    const bytes = await handle.readFile(); check(bytes.length <= 1024 * 1024, 'The base settings exceed their bound'); return bytes;
  } finally { await handle.close(); }
}

// Dispatch provides public identities only. The host derives all private paths.
// Adapters are limited to isolated fixture execution, never workflow inputs.
export async function runDriverAuditNativeActivation({ operation, sessionId, profileSha256, templateSha256, expectedSha, appRoot }, adapters = {}) {
  let phase = 'checkout', lock, connection, pauseWorkers, startAttempted = false;
  const heldLocks = [];
  const releaseWorkers = async () => { while (heldLocks.length) await heldLocks.pop().release(); };
  const exec = adapters.exec || execute, env = adapters.env || process.env;
  try {
    check(['activate-native', 'start-native'].includes(operation) && digest(profileSha256) && digest(templateSha256)
      && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(sessionId || ''), 'Exact public activation identities are required');
    check(typeof appRoot === 'string' && path.isAbsolute(appRoot) && path.resolve(appRoot) === appRoot
      && await fs.realpath(appRoot) === appRoot, 'The exact application root is required');
    const checkout = async () => {
      check((adapters.platform || process.platform) === 'linux' && /^[a-f0-9]{40}$/.test(expectedSha || '')
        && (await exec('git', ['rev-parse', 'HEAD'], { cwd: appRoot, timeout: 5000, maxBuffer: 4096 })).stdout.trim() === expectedSha,
      'The exact reviewed Linux checkout is required');
      await exec('git', ['diff', '--quiet', expectedSha, '--', 'server/services/driverAuditMongoImport.js',
        'server/services/driverAuditMongoRpc.js', 'server/services/driverAuditSource.js', 'server/services/driverAuditLiveImport.js',
        'server/services/driverAuditOriginalSourceLineage.js', 'server/services/driverAuditMongoText.js',
        'server/services/driverAuditTechnicalState.js',
        'server/services/driverAuditMongoArchive.js', 'server/services/driverAuditDataBackend.js',
        'server/scripts/driverAuditSourceDeploy.js', 'server/scripts/driverAuditSourceQualify.js',
        'server/scripts/driverAuditDeploy.js'], { cwd: appRoot, timeout: 5000, maxBuffer: 4096 });
    };
    await checkout(); const server = path.join(appRoot, 'server');
    const load = adapters.load || (name => import(pathToFileURL(path.join(server, name)).href));
    await load('loadEnv.js');
    const { default: dotenv } = await load('node_modules/dotenv/lib/main.js');
    const { readPrivateDriverAuditSource: read, requirePrivateDriverAuditSourceDirectory: privateDirectory,
      readDriverAuditSourceConfig, verifyDriverAuditSourceRelease } = await load('services/driverAuditSource.js');
    const transferRoot = path.join(server, '.private/driver-audit-native-transfer'), folder = path.join(transferRoot, sessionId);
    phase = 'private-inputs'; await privateDirectory(transferRoot); await privateDirectory(folder);
    const { acquireWorkerLock } = await load('vendor/driver-audits/integration/hosted/worker-lock.mjs');
    lock = await acquireWorkerLock(path.join(transferRoot, 'operator.lock'));
    const inputPins = new Map(), externalPins = new Map();
    const pinned = async (name, expected, maximum = 4 * 1024 * 1024) => {
      check(!name.includes('/') && digest(expected), 'A fixed pinned activation file is required');
      const bytes = await read(path.join(folder, name), maximum);
      check(hash(bytes) === expected, 'A pinned activation file differs'); inputPins.set(name, { expected, maximum });
      return bytes;
    };
    const stateBytes = await read(path.join(folder, 'session.private.json'), 128 * 1024);
    const receivedBytes = await read(path.join(folder, 'received.private.json'), 1024 * 1024);
    inputPins.set('session.private.json', { expected: hash(stateBytes), maximum: 128 * 1024 });
    inputPins.set('received.private.json', { expected: hash(receivedBytes), maximum: 1024 * 1024 });
    const state = JSON.parse(stateBytes), received = JSON.parse(receivedBytes);
    check(state.version === 1 && state.sessionId === sessionId && state.capacityBytes === capacityBytes
      && digest(state.inventorySha256) && state.plan?.inventorySha256 === state.inventorySha256 && integer(state.createdAt)
      && state.createdAt <= Date.now() && received.version === 1 && received.status === 'transfer-received'
      && received.verified === true && received.authorityChanged === false && received.sessionId === sessionId
      && received.targetDatabase === state.targetDatabase && received.inventorySha256 === state.inventorySha256
      && received.objects === state.plan.objectCount && received.bytes === state.plan.objectBytes
      && integer(received.objects) && received.objects > 0 && received.objects <= 100000
      && integer(received.bytes) && received.bytes > 0 && received.bytes <= 2 * 1024 ** 3
      && Date.parse(received.completedAt) >= state.createdAt && Date.parse(received.completedAt) <= Date.now(),
    'The verified activation transfer session differs');
    const templateBytes = await pinned('activation-template.private.json', templateSha256, 128 * 1024);
    await templateProvenance({ read, privateDirectory, folder, transferRoot, sessionId, profileSha256, targetDatabase: state.targetDatabase,
      received, templateBytes, templateSha256, inputPins, externalPins });
    const template = JSON.parse(templateBytes), templateKeys = ['version', 'profileSha256', 'closureProofSha256',
      'nativeParityReceiptSha256', 'parityVerifierSha256', 'sourceReleaseSha256', 'settingsPlanSha256'];
    check(same(Object.keys(template).sort(), [...templateKeys].sort()) && template.version === 1
      && template.profileSha256 === profileSha256 && templateKeys.filter(key => key !== 'version').every(key => digest(template[key])),
    'The complete fixed activation template differs');
    const profileBytes = await pinned('profile.private.json', profileSha256), profile = JSON.parse(profileBytes);
    const closureBytes = await pinned('closure-proof.private.json', template.closureProofSha256, 16 * 1024 * 1024), closure = JSON.parse(closureBytes);
    const parityName = 'parity-' + profileSha256 + '-' + template.closureProofSha256 + '-' + template.nativeParityReceiptSha256 + '.private.json';
    const priorParity = JSON.parse(await pinned(parityName, template.nativeParityReceiptSha256));
    check(priorParity.status === 'complete-native-parity-verified' && priorParity.verified === true && priorParity.sessionId === sessionId
      && priorParity.profileSha256 === profileSha256 && priorParity.closureProofSha256 === template.closureProofSha256
      && priorParity.completeByteParity?.verified === true && priorParity.freshOriginalRecordComparisons === true
      && ['resultsEqual', 'gpsEqual', 'photosEqual', 'reviewHistoryEqual'].every(key => priorParity[key] === true),
    'Complete independently pinned native parity is required');
    const settings = JSON.parse(await pinned('native-settings-plan.private.json', template.settingsPlanSha256));
    const before = await pinned('native-settings-before.private.env', settings.beforeSha256, 1024 * 1024);
    const after = await pinned('native-settings-after.private.env', settings.afterSha256, 1024 * 1024);
    const sourceRoot = path.join(server, '.private/driver-audit-source', sourceManifest);
    const syncRoot = profile.syncRoot, cache = path.join(syncRoot || '', 'work/archive-cache');
    check(profile.version === 2 && profile.targetDatabase === state.targetDatabase && profile.capacityBytes === capacityBytes
      && path.dirname(syncRoot || '') === path.join(server, '.private/driver-audits') && digest(path.basename(syncRoot))
      && profile.runtimeRoot === path.join(sourceRoot, 'runtime') && profile.runtimeSha256 === sourceManifest
      && settings.version === 1 && settings.operation === 'prepare-native-settings' && settings.profileSha256 === profileSha256
      && settings.applicationCommit === expectedSha && settings.targetDatabase === profile.targetDatabase
      && settings.sourceManifestSha256 === sourceManifest && settings.archiveCacheDirectory === cache
      && settings.nativeSettingsApplied === false && settings.requiresFinalFenceAndParity === true,
    'The native profile and prepared settings context differ');
    await privateDirectory(syncRoot); await privateDirectory(sourceRoot); await privateDirectory(cache);
    const config = await readDriverAuditSourceConfig(path.join(sourceRoot, 'source.json'));
    check(config.configSha256 === settings.sourceConfigSha256 && config.manifestSha256 === sourceManifest
      && config.dataStore === 'mongo' && config.archiveCacheDirectory === cache, 'The qualified source configuration differs');
    const localFile = path.join(server, '.env.local'), baseFile = path.join(server, '.env');
    // The base file is not required to be secret, but must be the exact owned
    // regular file whose bytes the settings proposal reviewed.
    const base = await baseSettings(baseFile); check(hash(base) === settings.baseSha256, 'The base settings changed');
    const originalEnv = { ...dotenv.parse(base), ...dotenv.parse(before) }, nativeEnv = { ...dotenv.parse(base), ...dotenv.parse(after) };
    const changed = ['DRIVER_AUDIT_DATA_STORE', 'DRIVER_AUDIT_NATIVE_CAPACITY_BYTES', 'MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY'];
    check(nativeEnv.DRIVER_AUDIT_DATA_STORE === 'mongo' && nativeEnv.DRIVER_AUDIT_NATIVE_CAPACITY_BYTES === String(capacityBytes)
      && nativeEnv.MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY === cache && nativeEnv.DRIVER_AUDIT_REPLICA_GC_ENABLED === '0'
      && originalEnv.DRIVER_AUDIT_REPLICA_GC_ENABLED === '0' && nativeEnv.DRIVER_AUDIT_ENABLED === '1'
      && nativeEnv.DRIVER_AUDIT_IMPORT_ENABLED === '0' && typeof nativeEnv.MONGODB_URI === 'string'
      && nativeEnv.MONGODB_URI === env.MONGODB_URI
      && Object.entries(originalEnv).every(([key, value]) => changed.includes(key) || nativeEnv[key] === value)
      && Object.keys(nativeEnv).every(key => Object.hasOwn(originalEnv, key) || changed.includes(key)),
    'Only the three reviewed native settings may be committed');
    phase = 'database';
    const { default: mongoose } = await load('node_modules/mongoose/index.js');
    connection = mongoose.createConnection(nativeEnv.MONGODB_URI, { autoCreate: false, autoIndex: false, maxPoolSize: 4, serverSelectionTimeoutMS: 10000 });
    await connection.asPromise(); const db = connection.db, client = connection.getClient();
    check(db.databaseName === profile.targetDatabase, 'The activation targets another database');
    const hello = await db.command({ hello: 1 });
    check((hello.setName || hello.msg === 'isdbgrid') && Number.isFinite(hello.logicalSessionTimeoutMinutes),
      'The existing target must support MongoDB transactions');
    const authority = () => db.collection('driverAuditNativeControl').findOne({ _id: 'authority' });
    const proofFile = path.join(folder, 'native-authority-parity.private.json');
    const activeProof = async active => {
      const bytes = await read(proofFile, 4 * 1024 * 1024), proof = JSON.parse(bytes);
      const { paritySha256, ...content } = proof;
      check(digest(paritySha256) && hash(JSON.stringify(content)) === paritySha256 && content.verified === true
        && content.importSha256 === profileSha256 && active?.status === 'active' && active.verified === true
        && active.importSha256 === profileSha256 && active.paritySha256 === paritySha256
        && active.oldWritersFenced === true && active.oldReviewsFenced === true && Number.isFinite(Date.parse(active.activatedAt)),
      'The exact verified native authority and preserved parity proof are required');
      if (twoPhaseAuthorityBinding(active) || Object.hasOwn(content, 'sourceFenceSha256')) {
        check(active.fence?.mode === 'reporting-database-capability-v2'
          && active.fence.sourceFence?.mode === 'reporting-database-capability-v2'
          && digest(content.sourceFenceSha256) && content.sourceFenceSha256 === active.verifiedSourceFenceSha256
          && hash(JSON.stringify(active.fence.sourceFence)) === content.sourceFenceSha256,
        'The active two-phase authority and preserved source fence differ');
      }
      inputPins.set('native-authority-parity.private.json', { expected: hash(bytes), maximum: 4 * 1024 * 1024 });
      return proof;
    };
    const readProcesses = async () => JSON.parse((await exec('pm2', ['jlist'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 })).stdout);
    let admittedHeadSha256, admittedPointerSha256;
    const safety = async ({ stopped = true, apiOnline = operation === 'start-native' } = {}) => {
      await checkout();
      for (const [name, pin] of inputPins) check(hash(await read(path.join(folder, name), pin.maximum)) === pin.expected, 'An activation input changed');
      for (const [file, pin] of externalPins) check(hash(await read(file, pin.maximum)) === pin.expected, 'A supplemental provenance input changed');
      check(hash(await baseSettings(baseFile)) === settings.baseSha256, 'The base settings changed during activation');
      const local = await read(localFile, 1024 * 1024);
      check(local.equals(before) || local.equals(after), 'The effective settings changed outside the exact proposal');
      const entries = await readProcesses(); check(Array.isArray(entries), 'The process inventory differs');
      const api = entries.filter(row => row.name === 'matter-delivery-api'), sync = entries.filter(row => row.name === 'matter-driver-audit-sync');
      const source = entries.filter(row => row.name === 'matter-driver-audit-source');
      check(api.length === 1 && api[0].pm2_env?.pm_cwd === appRoot && api[0].pm2_env?.pm_exec_path === path.join(server, 'server.js')
        && sync.length === 1 && sync[0].pm2_env?.pm_cwd === server
        && sync[0].pm2_env?.pm_exec_path === path.join(server, 'scripts/driverAuditSync.js')
        && same(sync[0].pm2_env?.args, ['--config', path.join(syncRoot, 'sync.json')])
        && source.length <= 1 && source.every(row => row.pm2_env?.pm_cwd === server
          && row.pm2_env?.pm_exec_path === path.join(server, 'scripts/driverAuditSource.js')
          && same(row.pm2_env?.args, ['--config', path.join(sourceRoot, 'source.json')]))
        && (stopped ? sync[0].pm2_env.status === 'stopped' && source.every(row => row.pm2_env.status === 'stopped')
          : sync[0].pm2_env.status === 'online' && source.length === 1 && source[0].pm2_env.status === 'online')
        && (!apiOnline || api[0].pm2_env.status === 'online'),
      'The exact managed report workers must remain stopped');
      const [head, directStage, allowance] = await Promise.all([
        db.collection('driverAuditControl').findOne({ _id: 'head' }), db.collection('driverAuditControl').findOne({ _id: 'direct-stage' }),
        db.collection('driverAuditNativeControl').findOne({ _id: 'capacity' }),
      ]);
      check(!directStage && allowance?.limitBytes === capacityBytes && integer(allowance.usedBytes) && allowance.usedBytes <= capacityBytes,
        'A direct stage or native allowance changed');
      if (stopped) {
        let pointer = null;
        try { pointer = await read(path.join(syncRoot, 'work/current.private.json'), 1024 * 1024); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const headSha = hash(JSON.stringify(head)), pointerSha = hash(pointer ?? 'null'), currentAuthority = await authority();
        check(currentAuthority?.importSha256 === profileSha256 && ['staging', 'active'].includes(currentAuthority.status),
          'The native authority identity differs');
        if (currentAuthority.status === 'staging') {
          check(headSha === settings.servingHeadSha256 && pointerSha === settings.workspacePointerSha256,
            'The serving or candidate head changed after settings preparation');
        } else check(currentAuthority.verified === true && currentAuthority.oldWritersFenced === true
          && currentAuthority.oldReviewsFenced === true, 'The active authority is not verified');
        // After activation, a previous startup may already have published a
        // newer report. Freeze the observed heads for this attempt and retain
        // them; never replace them with pre-activation profile pointers.
        check((!admittedHeadSha256 || admittedHeadSha256 === headSha)
          && (!admittedPointerSha256 || admittedPointerSha256 === pointerSha), 'The held native serving or candidate head changed');
        admittedHeadSha256 = headSha; admittedPointerSha256 = pointerSha;
        for (const name of ['collector', 'qualification']) {
          const lease = await db.collection('driverAuditNativeLeases').findOne({ _id: name });
          check(!lease?.owner_id || Date.parse(lease.expires_at) <= Date.now(), 'A native collector lease remains active');
        }
      }
      check(hash(await read(path.join(syncRoot, 'sync.json'), 1024 * 1024)) === settings.syncConfigSha256,
        'The managed builder configuration changed');
      check((await readDriverAuditSourceConfig(path.join(sourceRoot, 'source.json'))).configSha256 === config.configSha256,
        'The source configuration changed');
      return local;
    };
    phase = 'source-fence';
    const releaseFile = path.join(folder, 'source-release.private.json');
    await pinned('source-release.private.json', template.sourceReleaseSha256);
    const releaseReference = { path: releaseFile, sha256: template.sourceReleaseSha256 };
    let acceptedReleaseTime, sourceAction = 'audit-source-start';
    const observedAuthority = await authority();
    if (observedAuthority?.status === 'active') {
      await activeProof(observedAuthority);
      if (operation === 'activate-native') acceptedReleaseTime = new Date(observedAuthority.activatedAt);
      else {
        let sourceActivation;
        try { sourceActivation = JSON.parse(await read(path.join(sourceRoot, 'deployment-source.private.json'), 1024 * 1024)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const workers = (await readProcesses()).filter(row => row.name === 'matter-driver-audit-source');
        if (sourceActivation?.version === 1 && sourceActivation.verified === true && sourceActivation.status === 'active'
          && sourceActivation.configSha256 === config.configSha256 && sourceActivation.manifestSha256 === config.manifestSha256
          && sourceActivation.release?.path === releaseFile && sourceActivation.release.sha256 === template.sourceReleaseSha256
          && Number.isFinite(Date.parse(sourceActivation.verifiedAt)) && workers.length === 1
          && workers[0].pm2_env?.status === 'stopped' && workers[0].pm2_env.pm_cwd === server
          && workers[0].pm2_env.pm_exec_path === path.join(server, 'scripts/driverAuditSource.js')
          && same(workers[0].pm2_env.args, ['--config', path.join(sourceRoot, 'source.json')])) {
          sourceAction = 'audit-source-resume'; acceptedReleaseTime = new Date(sourceActivation.verifiedAt);
        }
      }
    }
    const verifyRelease = () => verifyDriverAuditSourceRelease(config, releaseReference, acceptedReleaseTime || new Date());
    const { release, validatedFence } = await verifyRelease();
    const aliases = { backup: 'source-backup.private.json', parity: 'source-parity.private.json',
      credentials: 'source-credentials.private.json', sourceFence: 'source-fence.private.json' }, receipts = {};
    for (const [kind, name] of Object.entries(aliases)) {
      check(release[kind]?.path === name, 'The source release must use the fixed private proof aliases');
      receipts[kind] = JSON.parse(await pinned(name, release[kind].sha256));
    }
    check(receipts.parity.nativeParity?.path === parityName && receipts.parity.nativeParity.sha256 === template.nativeParityReceiptSha256,
      'The source release does not bind the complete native parity receipt');
    check(digest(receipts.parity.hostQualification?.fixtureSha256) && digest(receipts.parity.hostQualification?.receiptSha256),
      'The exact Linux fixture and qualification receipt identities are required');
    const fenceProof = receipts.sourceFence;
    const twoPhase = fenceProof.mode === 'reporting-database-capability-v2';
    check((twoPhase || fenceProof.mode === 'reporting-database-capability-v1') && fenceProof.checkpoint?.path === 'checkpoint.private.json',
      'The reviewed native capability fence and fixed checkpoint are required');
    const checkpoint = JSON.parse(await pinned('checkpoint.private.json', fenceProof.checkpoint.sha256));
    if (twoPhase) {
      for (const [name, alias] of [['capabilityAudit', 'capability-audit.private.json'], ['drainAudit', 'drain-audit.private.json'],
        ['quietAudit', 'quiet-audit.private.json']]) {
        check(fenceProof[name]?.path === alias, 'The two-phase fence must use the fixed private audit aliases');
        await pinned(alias, fenceProof[name].sha256);
      }
      check(validatedFence?.version === 2 && validatedFence.mode === fenceProof.mode && fenceProof.writersStopped === false
        && validatedFence.sourceProjectRef === fenceProof.sourceProjectRef
        && ['legacyRuntimeSha256', 'legacyEntrypointsSha256'].every(key => digest(validatedFence[key]) && validatedFence[key] === fenceProof[key])
        && validatedFence.admissionBlockedAt === fenceProof.admissionBlockedAt
        && validatedFence.dataWritesBlockedAt === fenceProof.dataWritesBlockedAt
        && ['phase1ReceiptSha256', 'phase2ReceiptSha256'].every(key => digest(validatedFence[key]) && validatedFence[key] === fenceProof[key])
        && validatedFence.sourceReleaseSha256 === template.sourceReleaseSha256
        && validatedFence.sourceFenceSha256 === release.sourceFence.sha256
        && validatedFence.capabilityAuditSha256 === fenceProof.capabilityAudit.sha256
        && validatedFence.checkpointSha256 === fenceProof.checkpoint.sha256
        && validatedFence.backupReceiptSha256 === release.backup.sha256 && validatedFence.parityReceiptSha256 === release.parity.sha256
        && validatedFence.initialCursor === release.initialCursor && validatedFence.backupAt === checkpoint.capturedAt
        && validatedFence.validUntil === release.validUntil,
      'The actual verified two-phase source origin differs');
    }
    if (observedAuthority?.status === 'active' && (twoPhase || twoPhaseAuthorityBinding(observedAuthority))) {
      check(twoPhase && observedAuthority.fence?.mode === fenceProof.mode
        && observedAuthority.verifiedSourceFenceSha256 === hash(JSON.stringify(validatedFence))
        && same(observedAuthority.fence.sourceFence, validatedFence), 'The active two-phase source fence changed');
    }
    const baseline = receipts.backup.uncertainAttemptsBaseline;
    check(baseline?.sourceSnapshotSha256 === closure.origin?.sourceSnapshotSha256
      && baseline.restoreVerificationSha256 === closure.origin?.restoreVerificationSha256
      && checkpoint.sourceSnapshotSha256 === baseline.sourceSnapshotSha256 && checkpoint.restoreVerificationSha256 === baseline.restoreVerificationSha256
      && checkpoint.snapshotId === baseline.snapshotId && checkpoint.collectorRevision === closure.sourceRevision
      && priorParity.sourceRevision === closure.sourceRevision && priorParity.originSha256 === hash(JSON.stringify(closure.origin)),
    'The final source backup, checkpoint and closure differ');
    const { readDriverAuditImportRows } = await load('services/driverAuditLiveImport.js');
    const original = await Array.fromAsync(readDriverAuditImportRows(folder, profile.documents));
    check(checkpoint.reviewRevision === original.find(row => row.key === 'review-journal')?.revision,
      'The final review revision differs from the imported original');
    const shell = { ...env, ...nativeEnv, DRIVER_AUDIT_DEPLOY_SHA: expectedSha, DRIVER_AUDIT_SOURCE_MANIFEST: sourceManifest,
      DRIVER_AUDIT_SOURCE_NODE: config.nodeExecutable, DRIVER_AUDIT_SOURCE_RELEASE_FILE: releaseFile,
      DRIVER_AUDIT_SOURCE_RELEASE_SHA256: template.sourceReleaseSha256 };
    const runScript = (name, action, effective = shell) => exec(process.execPath, [path.join(server, 'scripts', name), action],
      { cwd: appRoot, env: effective, timeout: 360_000, maxBuffer: 1024 * 1024 });
    phase = 'held-host-qualification'; await safety();
    heldLocks.push(await acquireWorkerLock(path.join(path.dirname(sourceRoot), 'source-deployment.lock')));
    heldLocks.push(await acquireWorkerLock(path.join(path.dirname(sourceRoot), 'source-worker.lock')));
    const { requireDriverAuditSourceHostQualification, withDriverAuditHeldQualificationSync } = await load('scripts/driverAuditSourceQualify.js');
    check(typeof withDriverAuditHeldQualificationSync === 'function', 'The deployed real held qualification lifecycle is required');
    // Use the actual durable backend selection during this read-only cycle.
    // In particular, never force Mongo before its authority has been admitted.
    const heldValues = { ...dotenv.parse(base), ...dotenv.parse(await safety()) }, heldShell = { ...shell, ...heldValues };
    for (const key of changed) if (!Object.hasOwn(heldValues, key)) delete heldShell[key];
    await withDriverAuditHeldQualificationSync({ config, supervisor: readProcesses,
      startSync: async () => {
        const result = await runScript('driverAuditDeploy.js', 'deploy-worker-resume', heldShell);
        check(result.stdout.trim() === 'resumed', 'The real held sync did not confirm startup');
      },
      stopSync: async () => {
        await runScript('driverAuditDeploy.js', 'deploy-worker-pause', heldShell);
        await exec('pm2', ['save'], { timeout: 10000, maxBuffer: 256 * 1024 });
        const drained = await acquireWorkerLock(path.join(path.dirname(syncRoot), 'sync-worker.lock'));
        await drained.release();
      } }, () => requireDriverAuditSourceHostQualification({ config, commit: expectedSha,
      reference: receipts.parity.hostQualification, supervisor: readProcesses }));
    await safety();
    pauseWorkers = async () => {
      let failed = false;
      try { await runScript('driverAuditSourceDeploy.js', 'deploy-source-pause'); } catch { failed = true; }
      try { await runScript('driverAuditDeploy.js', 'deploy-worker-pause'); } catch { failed = true; }
      try { await exec('pm2', ['save'], { timeout: 10000, maxBuffer: 256 * 1024 }); } catch { failed = true; }
      if (failed) throw Error('Report worker pause recovery needs inspection');
    };
    phase = 'activation-admission'; await safety();
    const heavyRoot = path.join(server, '.private/driver-audit-heavy-work');
    await fs.mkdir(heavyRoot, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await privateDirectory(heavyRoot);
    for (const file of [path.join(path.dirname(syncRoot), 'sync-worker.lock'), path.join(heavyRoot, 'work.lock')]) {
      heldLocks.push(await acquireWorkerLock(file));
    }
    await safety();
    const intent = { version: 1, sessionId, applicationCommit: expectedSha, profileSha256, templateSha256,
      settingsPlanSha256: template.settingsPlanSha256, sourceConfigSha256: config.configSha256, afterSha256: settings.afterSha256 };
    await savePrivate(path.join(folder, 'native-activation-intent.private.json'), json(intent), read);
    const started = await authority();
    if (operation === 'activate-native' && started?.status === 'staging') {
      check(started.importSha256 === profileSha256 && started.writeFence === settings.authority?.writeFence,
        'The native staged authority changed after settings preparation');
      const { createDriverAuditMongoArchive } = await load('services/driverAuditMongoArchive.js');
      const archive = createDriverAuditMongoArchive({ db, client, capacityBytes });
      const { createDriverAuditMongoRpc } = await load('services/driverAuditMongoRpc.js');
      const rpc = createDriverAuditMongoRpc({ db, client, objects: archive });
      const { verifyDriverAuditMongoAuthority } = await load('services/driverAuditMongoImport.js');
      phase = 'authority-parity';
      const proof = await verifyDriverAuditMongoAuthority({ db, rpc, original, importSha256: profileSha256,
        ...(twoPhase ? { sourceFence: validatedFence } : {}), verifyResults: async () => {
        let fresh;
        if (adapters.verifyParity) fresh = await adapters.verifyParity();
        else {
          const verifierFile = path.join(server, '.private/driver-audit-native-operators', template.parityVerifierSha256 + '.mjs');
          check(hash(await read(verifierFile, 256 * 1024)) === template.parityVerifierSha256, 'The reviewed parity verifier code differs');
          const { verifyDriverAuditNativeParity, nativeDriverAuditTargetIdentity } = await import(pathToFileURL(verifierFile).href);
          const { createDriverAuditMongoTextReader } = await load('services/driverAuditMongoText.js');
          const { createDriverAuditTechnicalState } = await load('services/driverAuditTechnicalState.js');
          const { collectDriverAuditReceiptRoots, isDriverAuditTechnicalKey } = await load('services/driverAuditLiveImport.js');
          const technical = createDriverAuditTechnicalState({ db, objects: archive });
          fresh = await verifyDriverAuditNativeParity({ db, archive, profileBytes, profileSha256, closureProofBytes: closureBytes,
            closureProofSha256: template.closureProofSha256, sessionId,
            implementationIdentities: { verifierSha256: template.parityVerifierSha256,
              archiveSha256: hash(await fs.readFile(path.join(server, 'services/driverAuditMongoArchive.js'))),
              migrationCliSha256: hash(await fs.readFile(path.join(server, 'scripts/driverAuditMongoMigrate.js'))) },
            targetIdentitySha256: nativeDriverAuditTargetIdentity(nativeEnv.MONGODB_URI, db.databaseName),
            readRows: ref => readDriverAuditImportRows(folder, ref),
            readPinnedJson: async ref => JSON.parse(await pinned(ref.file, ref.sha256)),
            readText: createDriverAuditMongoTextReader(archive), readTechnical: ref => technical.read(ref), isTechnicalKey: isDriverAuditTechnicalKey,
            collectCensus: async documents => {
              const value = await collectDriverAuditReceiptRoots({ db, documents, syncRoot });
              const seedBytes = await read(path.join(syncRoot, 'seed.json'), 1024 * 1024), seed = JSON.parse(seedBytes);
              check(value.roots.some(row => row.kind === 'seed.json' && row.sha256 === hash(seedBytes)), 'The bootstrap census changed');
              return { ...value, bootstrap: { collectorRevision: seed.collectorRevision, manifestSha256: seed.manifestSha256,
                sourceBasis: seed.sourceBasis, seedSha256: hash(seedBytes) } };
            }, readArchiveAttestation: async metadata => {
              const bytes = await read(path.join(transferRoot, 'archive-bytes-' + metadata.inventorySha256 + '-' + metadata.metadataSha256 + '.private.json'), 1024 * 1024);
              check(hash(bytes) === priorParity.archiveAttestationSha256, 'The independently pinned archive attestation differs');
              return JSON.parse(bytes);
            } });
        }
        check(fresh?.verified === true && ['profileSha256', 'closureProofSha256', 'collectorRootsSha256', 'sourceRevision',
          'counts', 'fingerprints', 'originSha256', 'bootstrapSha256'].every(key => same(fresh[key], priorParity[key])),
        'Fresh complete native parity differs from its independent receipt');
        return fresh;
      } });
      await savePrivate(proofFile, json(proof), read);
      await pinned('native-authority-parity.private.json', hash(json(proof)));
      await safety(); const checkedRelease = await verifyRelease();
      check(!twoPhase || same(checkedRelease.validatedFence, validatedFence), 'The verified two-phase source origin changed during parity');
      const { activateDriverAuditMongoAuthority } = await load('services/driverAuditMongoImport.js');
      phase = 'authority-activation';
      await activateDriverAuditMongoAuthority({ db, importSha256: profileSha256, paritySha256: proof.paritySha256,
        fence: { oldWritersFenced: true, oldReviewsFenced: true, leasesDrained: true,
          ...(twoPhase ? { mode: fenceProof.mode, sourceFence: checkedRelease.validatedFence } : { stoppedAt: fenceProof.admissionBlockedAt }),
          backupAt: checkpoint.capturedAt, validUntil: release.validUntil } });
    }
    const active = await authority(); await activeProof(active);
    if (operation === 'activate-native') {
      phase = 'settings-commit'; const local = await safety();
      if (local.equals(before)) await commitSettings(localFile, before, after, read);
      check((await read(localFile, 1024 * 1024)).equals(after), 'Native settings did not read back exactly');
      const { createDriverAuditDataBackend } = await load('services/driverAuditDataBackend.js');
      const backend = await createDriverAuditDataBackend({ db, env: nativeEnv });
      check(backend.kind === 'mongo' && backend.archiveCacheDirectory === cache, 'The selected native backend differs');
      phase = 'api-restart';
      await exec('pm2', ['restart', 'matter-delivery-api'], { timeout: 360_000, maxBuffer: 1024 * 1024 });
      await runScript('customerServiceDeploy.js', '--verify'); await safety({ apiOnline: true });
      await exec('pm2', ['save'], { timeout: 10000, maxBuffer: 256 * 1024 });
      const receipt = { ...intent, status: 'native-activated', authorityParitySha256: active.paritySha256,
        activatedAt: new Date(active.activatedAt).toISOString(), reportWorkersStopped: true, liveAcceptancePending: true };
      await savePrivate(path.join(folder, 'native-activation.private.json'), json(receipt), read);
      return { ...receipt, apiRestartVerified: true, nativeSettingsApplied: true };
    }
    phase = 'worker-admission';
    const activation = JSON.parse(await read(path.join(folder, 'native-activation.private.json')));
    check(activation.profileSha256 === profileSha256 && activation.templateSha256 === templateSha256
      && activation.authorityParitySha256 === active.paritySha256 && (await read(localFile, 1024 * 1024)).equals(after),
    'The completed native API/settings activation is required before starting workers');
    await safety(); await verifyRelease();
    await releaseWorkers();
    startAttempted = true; phase = 'worker-start';
    const sync = await runScript('driverAuditDeploy.js', 'deploy-worker-resume');
    check(sync.stdout.trim() === 'resumed', 'The managed native builder did not confirm startup');
    await verifyRelease();
    const source = JSON.parse((await runScript('driverAuditSourceDeploy.js', sourceAction)).stdout);
    check((sourceAction === 'audit-source-resume' ? ['resumed'] : ['started', 'already-started']).includes(source.status),
      'The managed native source did not confirm startup');
    await safety({ stopped: false });
    const receipt = { ...intent, status: 'native-workers-started', authorityParitySha256: active.paritySha256,
      admittedHeadSha256, admittedPointerSha256, liveAcceptancePending: true };
    const receiptBytes = json(receipt), receiptSha256 = hash(receiptBytes);
    await savePrivate(path.join(folder, 'native-workers-started-' + receiptSha256 + '.private.json'), receiptBytes, read);
    return { ...receipt, receiptSha256 };
  } catch (error) {
    if (startAttempted) {
      try { await pauseWorkers(); } catch { phase = 'worker-pause-recovery'; }
    }
    throw Object.assign(Error(error.activationGuard ? error.message : 'Native activation stopped at ' + phase), { phase });
  } finally {
    let failed = false; try { await releaseWorkers(); } catch { failed = true; }
    try { await connection?.close(); } catch { failed = true; }
    try { await lock?.release(); } catch { failed = true; }
    if (failed) throw Object.assign(Error('Native activation cleanup stopped; preserve native authority'), { phase: 'cleanup' });
  }
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runDriverAuditNativeActivation({ operation: process.env.NATIVE_HANDOFF_OPERATION,
    sessionId: process.env.NATIVE_TRANSFER_SESSION_ID, profileSha256: process.env.NATIVE_IMPORT_PROFILE_SHA256,
    templateSha256: process.env.NATIVE_ACTIVATION_TEMPLATE_SHA256, expectedSha: process.env.EXPECTED_DEPLOYED_SHA,
    appRoot: await fs.realpath(process.cwd()) }))); }
  catch (error) { console.error('Native activation stopped at ' + (error.phase || 'checkout') + '. Preserve native authority and inspect the private activation receipts.'); process.exitCode = 1; }
}
