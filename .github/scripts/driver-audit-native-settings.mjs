import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const exec = promisify(execFile), sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceManifest = '15301337474717828b88997faac92cbc23763b16ed1fc7881fa6bd553696a64b';
const capacityBytes = 16 * 1024 ** 3;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const requireSettings = (value, message) => { if (!value) throw Object.assign(Error(message), { settingsGuard: true }); };
const managedKeys = ['DRIVER_AUDIT_ENABLED', 'DRIVER_AUDIT_IMPORT_ENABLED', 'DRIVER_AUDIT_ORIGIN',
  'DRIVER_AUDIT_CAPACITY_BYTES', 'DRIVER_AUDIT_SUPABASE_SECRET', 'DRIVER_AUDIT_REPLICA_GC_ENABLED'];

async function environmentBytes(file, optional = false) {
  let stat;
  try { stat = await fs.lstat(file); } catch (error) { if (optional && error.code === 'ENOENT') return Buffer.alloc(0); throw error; }
  requireSettings(await fs.realpath(file) === file && stat.isFile() && stat.uid === process.getuid()
    && stat.size <= 1024 * 1024 && (path.basename(file) !== '.env.local' || !(stat.mode & 0o077)),
  'Application settings must be bounded, owned regular files');
  const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    requireSettings(opened.ino === stat.ino && opened.dev === stat.dev, 'Application settings changed while reading');
    const bytes = await handle.readFile();
    requireSettings(bytes.length <= 1024 * 1024 && Buffer.from(bytes.toString('utf8')).equals(bytes),
      'Application settings must be bounded UTF-8');
    return bytes;
  } finally { await handle.close(); }
}

async function immutable(file, bytes, read) {
  try {
    requireSettings((await read(file, 2 * 1024 * 1024)).equals(bytes), 'The immutable settings plan differs'); return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = file + '.' + randomUUID() + '.tmp';
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await fs.link(temporary, file);
    const directory = await fs.open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await fs.unlink(temporary); }
}

async function commitEnvironment(file, before, after) {
  // The proposal was produced by the existing managed-settings writer on an
  // isolated exact copy. Never let that writer adopt a newer effective file as
  // its baseline while applying values captured from this older plan.
  requireSettings((await environmentBytes(file)).equals(before), 'Application settings changed before the planned write');
  const temporary = file + '.native-' + randomUUID() + '.tmp';
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(after); await handle.sync(); } finally { await handle.close(); }
    requireSettings((await environmentBytes(file)).equals(before), 'Application settings changed during the planned write');
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

// All host modules and paths are resolved after the exact checkout guard. The
// optional adapters exist only for isolated fixtures; dispatch passes identities.
export async function runDriverAuditNativeSettings({ operation, sessionId, profileSha256, expectedSha, appRoot }, adapters = {}) {
  let phase = 'checkout', lock, connection;
  const execute = adapters.exec || adapters.execute || exec, env = adapters.env || process.env;
  try {
    requireSettings(['disable-pruning', 'prepare-native-settings'].includes(operation) && digest(profileSha256)
      && typeof sessionId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(sessionId),
    'A reviewed settings operation and exact public identities are required');
    requireSettings(typeof appRoot === 'string' && path.isAbsolute(appRoot) && path.resolve(appRoot) === appRoot
      && await fs.realpath(appRoot) === appRoot, 'The exact application root is required');
    const checkout = async () => {
      const actual = (await execute('git', ['rev-parse', 'HEAD'], { cwd: appRoot, timeout: 5000, maxBuffer: 4096 })).stdout.trim();
      requireSettings((adapters.platform || process.platform) === 'linux' && /^[a-f0-9]{40}$/.test(expectedSha || '')
        && actual === expectedSha, 'The exact Linux application checkout is required');
    };
    await checkout();
    const server = path.join(appRoot, 'server');
    requireSettings(await fs.realpath(server) === server, 'The exact server directory is required');
    const load = adapters.load || (name => import(pathToFileURL(path.join(server, name)).href));
    await load('loadEnv.js');
    const { default: dotenv } = await load('node_modules/dotenv/lib/main.js');
    const { readPrivateDriverAuditSource: read, requirePrivateDriverAuditSourceDirectory: privateDirectory,
      readDriverAuditSourceConfig } = await load('services/driverAuditSource.js');
    const transferRoot = path.join(server, '.private/driver-audit-native-transfer'), folder = path.join(transferRoot, sessionId);
    phase = 'private-session'; await privateDirectory(transferRoot); await privateDirectory(folder);
    const { acquireWorkerLock } = await load('vendor/driver-audits/integration/hosted/worker-lock.mjs');
    lock = await acquireWorkerLock(path.join(transferRoot, 'operator.lock'));
    await checkout();
    const sessionBytes = await read(path.join(folder, 'session.private.json'), 128 * 1024);
    const receivedBytes = await read(path.join(folder, 'received.private.json'), 1024 * 1024);
    const state = JSON.parse(sessionBytes), received = JSON.parse(receivedBytes);
    requireSettings(state.version === 1 && state.sessionId === sessionId && state.capacityBytes === capacityBytes
      && typeof state.targetDatabase === 'string' && state.targetDatabase.length > 0 && digest(state.inventorySha256)
      && state.plan?.inventorySha256 === state.inventorySha256 && integer(state.createdAt) && state.createdAt <= Date.now(),
    'The private transfer session differs');
    requireSettings(received.version === 1 && received.status === 'transfer-received' && received.verified === true
      && received.authorityChanged === false && received.sessionId === sessionId && received.targetDatabase === state.targetDatabase
      && received.inventorySha256 === state.inventorySha256 && received.objects === state.plan.objectCount
      && received.bytes === state.plan.objectBytes && integer(received.objects) && received.objects > 0
      && received.objects <= 100000 && integer(received.bytes) && received.bytes > 0 && received.bytes <= 2 * 1024 ** 3
      && Number.isFinite(Date.parse(received.completedAt)) && Date.parse(received.completedAt) >= state.createdAt
      && Date.parse(received.completedAt) <= Date.now(), 'The verified private transfer receipt differs');
    const profileFile = path.join(folder, 'profile.private.json'), profileBytes = await read(profileFile, 1024 * 1024);
    requireSettings(sha(profileBytes) === profileSha256, 'The exact staged profile is required');
    const profile = JSON.parse(profileBytes), sourceRoot = path.join(server, '.private/driver-audit-source', sourceManifest);
    requireSettings(profile.version === 2 && profile.targetDatabase === state.targetDatabase && profile.capacityBytes === capacityBytes
      && digest(profile.collectorRootsSha256) && profile.runtimeSha256 === sourceManifest
      && profile.runtimeRoot === path.join(sourceRoot, 'runtime'), 'The staged profile or source identity differs');
    const baseFile = path.join(server, '.env'), localFile = path.join(server, '.env.local');
    const readEnvironment = async () => {
      const base = await environmentBytes(baseFile, true), local = await environmentBytes(localFile);
      const values = { ...dotenv.parse(base), ...dotenv.parse(local) };
      requireSettings(typeof values.MONGODB_URI === 'string' && values.MONGODB_URI.length > 0
        && values.MONGODB_URI === env.MONGODB_URI, 'The durable and loaded database settings differ');
      return { base, local, values };
    };
    phase = 'database'; const initial = await readEnvironment();
    const { default: mongoose } = await load('node_modules/mongoose/index.js');
    connection = mongoose.createConnection(initial.values.MONGODB_URI, {
      autoCreate: false, autoIndex: false, maxPoolSize: 1, serverSelectionTimeoutMS: 10000,
    });
    await connection.asPromise(); const db = connection.db;
    requireSettings(db.databaseName === state.targetDatabase, 'The settings profile targets another database');
    let syncRoot, syncConfigSha256, authorityIdentity, servingHeadSha256, workspacePointerSha256;
    const safety = async () => {
      await checkout();
      requireSettings(sha(await read(profileFile, 1024 * 1024)) === profileSha256
        && sha(await read(path.join(folder, 'session.private.json'), 128 * 1024)) === sha(sessionBytes)
        && sha(await read(path.join(folder, 'received.private.json'), 1024 * 1024)) === sha(receivedBytes),
      'The pinned private settings inputs changed');
      const entries = JSON.parse((await execute('pm2', ['jlist'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 })).stdout);
      requireSettings(Array.isArray(entries), 'The managed process inventory differs');
      const api = entries.filter(row => row.name === 'matter-delivery-api'), sync = entries.filter(row => row.name === 'matter-driver-audit-sync');
      const source = entries.filter(row => row.name === 'matter-driver-audit-source');
      requireSettings(api.length === 1 && api[0].pm2_env?.status === 'online' && sync.length === 1
        && sync[0].pm2_env?.status === 'stopped' && source.length <= 1 && source.every(row => row.pm2_env?.status === 'stopped'),
      'Settings preparation requires stopped report workers and the existing app');
      const worker = sync[0].pm2_env, args = worker.args;
      requireSettings(worker.pm_cwd === server && worker.pm_exec_path === path.join(server, 'scripts/driverAuditSync.js')
        && Array.isArray(args) && args.length === 2 && args[0] === '--config', 'The managed sync invocation differs');
      const root = typeof args[1] === 'string' ? path.dirname(args[1]) : '';
      requireSettings(path.dirname(root) === path.join(server, '.private/driver-audits') && digest(path.basename(root))
        && args[1] === path.join(root, 'sync.json') && root === profile.syncRoot && (!syncRoot || root === syncRoot),
      'The managed sync root differs');
      syncRoot = root; await privateDirectory(syncRoot);
      const configBytes = await read(args[1], 1024 * 1024), config = JSON.parse(configBytes);
      requireSettings(config.version === 1 && config.root === syncRoot && config.codeRoot === path.join(syncRoot, 'builder')
        && config.baselineRoot === path.join(syncRoot, 'baseline')
        && config.rendererBuild?.path === path.join(syncRoot, 'baseline/build.private.json')
        && config.journals?.path === path.join(syncRoot, 'validation-journals.private.json')
        && (!syncConfigSha256 || sha(configBytes) === syncConfigSha256), 'The managed sync configuration changed');
      syncConfigSha256 = sha(configBytes);
      const [authority, directStage, capacity, head] = await Promise.all([
        db.collection('driverAuditNativeControl').findOne({ _id: 'authority' }),
        db.collection('driverAuditControl').findOne({ _id: 'direct-stage' }),
        db.collection('driverAuditNativeControl').findOne({ _id: 'capacity' }),
        db.collection('driverAuditControl').findOne({ _id: 'head' }),
      ]);
      requireSettings(operation === 'disable-pruning' && !authority || authority?.status === 'staging'
        && authority.importSha256 === profileSha256 && integer(authority.writeFence),
      'Settings preparation requires inactive authority and the exact staged profile when present');
      const identity = JSON.stringify(authority ? { status: authority.status, importSha256: authority.importSha256,
        writeFence: authority.writeFence } : null);
      requireSettings(!authorityIdentity || authorityIdentity === identity, 'The staged authority changed');
      authorityIdentity = identity;
      requireSettings(!directStage, 'An unresolved direct publication blocks settings preparation');
      requireSettings(capacity?.limitBytes === capacityBytes && integer(capacity.usedBytes) && capacity.usedBytes <= capacityBytes,
        'The explicit native storage allowance differs');
      let pointer = null;
      try { pointer = await read(path.join(syncRoot, 'work/current.private.json'), 1024 * 1024); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const headSha = sha(JSON.stringify(head)), pointerSha = sha(pointer ?? 'null');
      requireSettings((!servingHeadSha256 || servingHeadSha256 === headSha)
        && (!workspacePointerSha256 || workspacePointerSha256 === pointerSha), 'The serving or candidate workspace heads changed');
      servingHeadSha256 = headSha; workspacePointerSha256 = pointerSha;
      return readEnvironment();
    };
    phase = 'writers'; await safety();
    let source;
    if (operation === 'prepare-native-settings') {
      phase = 'source-settings'; await privateDirectory(sourceRoot);
      source = await readDriverAuditSourceConfig(path.join(sourceRoot, 'source.json'));
      const cache = path.join(syncRoot, 'work/archive-cache');
      requireSettings(source.root === sourceRoot && source.runtimeRoot === profile.runtimeRoot && source.manifestSha256 === sourceManifest
        && digest(source.configSha256) && source.dataStore === 'mongo' && source.environment?.DRIVER_AUDIT_DATA_STORE === 'mongo'
        && source.archiveCacheDirectory === cache && source.environment?.MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY === cache,
      'The source and managed archive cache settings differ');
      await privateDirectory(cache);
    }
    phase = 'settings-plan';
    const prefix = operation === 'disable-pruning' ? 'pruning' : 'native-settings';
    const planFile = path.join(folder, prefix + '-plan.private.json');
    let existingPlan;
    try { existingPlan = await read(planFile, 128 * 1024); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const current = await safety();
    let before = current.local;
    if (existingPlan) before = await read(path.join(folder, prefix + '-before.private.env'), 1024 * 1024);
    const original = { ...dotenv.parse(current.base), ...dotenv.parse(before) };
    let after;
    if (operation === 'disable-pruning') {
      requireSettings(original.DRIVER_AUDIT_ENABLED === '1' && managedKeys.every(key => typeof original[key] === 'string')
        && ['0', '1'].includes(original.DRIVER_AUDIT_REPLICA_GC_ENABLED), 'The existing managed settings differ');
      const { writeDriverAuditEnvironment } = await load('scripts/driverAuditDeploy.js');
      const preview = path.join(folder, 'settings-preview-' + randomUUID());
      await fs.mkdir(preview, { mode: 0o700 });
      try {
        await fs.writeFile(path.join(preview, '.env.local'), before, { flag: 'wx', mode: 0o600 });
        await writeDriverAuditEnvironment(preview, Object.fromEntries(managedKeys.map(key => [key,
          key === 'DRIVER_AUDIT_REPLICA_GC_ENABLED' ? '0' : original[key]])));
        after = await read(path.join(preview, '.env.local'), 1024 * 1024);
      } finally { await fs.rm(preview, { recursive: true, force: true }); }
    } else {
      requireSettings(original.DRIVER_AUDIT_REPLICA_GC_ENABLED === '0', 'Pruning must be durably disabled before preparing native settings');
      const patch = { DRIVER_AUDIT_DATA_STORE: 'mongo', DRIVER_AUDIT_NATIVE_CAPACITY_BYTES: String(capacityBytes),
        MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY: source.archiveCacheDirectory };
      const separator = before.length && before[before.length - 1] !== 10 ? '\n' : '';
      after = Buffer.concat([before, Buffer.from(separator + '# BEGIN PREPARED DRIVER AUDIT NATIVE SETTINGS\n'
        + Object.entries(patch).map(([key, value]) => key + '=' + JSON.stringify(value)).join('\n')
        + '\n# END PREPARED DRIVER AUDIT NATIVE SETTINGS\n')]);
      const values = { ...dotenv.parse(current.base), ...dotenv.parse(after) };
      requireSettings(Object.entries(patch).every(([key, value]) => values[key] === value), 'The proposed native settings cannot be encoded exactly');
    }
    const parsed = { ...dotenv.parse(current.base), ...dotenv.parse(after) };
    const changed = operation === 'disable-pruning' ? ['DRIVER_AUDIT_REPLICA_GC_ENABLED']
      : ['DRIVER_AUDIT_DATA_STORE', 'DRIVER_AUDIT_NATIVE_CAPACITY_BYTES', 'MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY'];
    requireSettings(Object.entries(original).every(([key, value]) => changed.includes(key) || parsed[key] === value),
      'The proposed settings affect another application value');
    const plan = { version: 1, operation, sessionId, applicationCommit: expectedSha, profileSha256,
      targetDatabase: db.databaseName, sourceManifestSha256: sourceManifest, syncConfigSha256,
      servingHeadSha256, workspacePointerSha256,
      authority: JSON.parse(authorityIdentity), baseSha256: sha(current.base), beforeSha256: sha(before), afterSha256: sha(after),
      ...(source ? { sourceConfigSha256: source.configSha256, archiveCacheDirectory: source.archiveCacheDirectory } : {}),
      nativeSettingsApplied: false, ...(source ? { requiresFinalFenceAndParity: true } : {}) };
    const planBytes = Buffer.from(JSON.stringify(plan, null, 2) + '\n');
    requireSettings(!existingPlan || existingPlan.equals(planBytes), 'Application settings or the immutable settings plan changed');
    requireSettings(current.local.equals(before) || operation === 'disable-pruning' && current.local.equals(after),
      'Application settings changed after the settings plan');
    await immutable(path.join(folder, prefix + '-base.private.env'), current.base, read);
    await immutable(path.join(folder, prefix + '-before.private.env'), before, read);
    await immutable(path.join(folder, prefix + '-after.private.env'), after, read);
    await immutable(planFile, planBytes, read);
    const recheck = async local => {
      const value = await safety();
      requireSettings(value.base.equals(current.base) && value.local.equals(local), 'Application settings changed during preparation');
    };
    await recheck(current.local);
    if (operation === 'disable-pruning') {
      phase = 'disable-pruning';
      if (!current.local.equals(after)) {
        await commitEnvironment(localFile, before, after);
      }
      await recheck(after);
      const persisted = await fs.open(localFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { await persisted.sync(); } finally { await persisted.close(); }
      const directory = await fs.open(server, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      // The existing pause operation stops the worker without saving PM2's dump.
      // Saving this already-stopped registration does not start either worker.
      await execute('pm2', ['save'], { timeout: 10000, maxBuffer: 256 * 1024 });
      await recheck(after);
    } else {
      requireSettings((await readDriverAuditSourceConfig(path.join(sourceRoot, 'source.json'))).configSha256 === source.configSha256,
        'The staged source configuration changed');
      await recheck(before);
    }
    return { version: 1, operation, sessionId, applicationCommit: expectedSha, profileSha256,
      status: operation === 'disable-pruning' ? 'pruning-disabled' : 'native-settings-prepared', planSha256: sha(planBytes),
      baseSha256: plan.baseSha256, beforeSha256: plan.beforeSha256, afterSha256: plan.afterSha256,
      nativeSettingsApplied: false, ...(source ? { requiresFinalFenceAndParity: true } : { reportWorkersStopped: true, pruningEnabled: false }) };
  } catch (error) {
    throw Object.assign(Error(error.settingsGuard ? error.message : 'Native settings stopped at ' + phase), { phase });
  } finally {
    let failed = false;
    try { await connection?.close(); } catch { failed = true; }
    try { await lock?.release(); } catch { failed = true; }
    if (failed) throw Object.assign(Error('Native settings cleanup stopped'), { phase: 'cleanup' });
  }
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await runDriverAuditNativeSettings({ operation: process.env.NATIVE_HANDOFF_OPERATION,
      sessionId: process.env.NATIVE_TRANSFER_SESSION_ID, profileSha256: process.env.NATIVE_IMPORT_PROFILE_SHA256,
      expectedSha: process.env.EXPECTED_DEPLOYED_SHA, appRoot: await fs.realpath(process.cwd()) })));
  } catch (error) {
    console.error('Native settings stopped at ' + (error.phase || 'checkout') + '. Check the pinned plan and stopped report workers.');
    process.exitCode = 1;
  }
}
