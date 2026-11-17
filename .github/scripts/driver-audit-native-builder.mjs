import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const NATIVE_BUILDER_FROM = '5780bdb95450558e4cc7dba91b3ed593fdd0b149648a6602b7c5ed441dec84c3';
export const NATIVE_BUILDER_TO = '76790677571490ea75f63c8954ac0c798311b80458b45bf1ccbf54f00ae0701d';
const sourceManifest = '15301337474717828b88997faac92cbc23763b16ed1fc7881fa6bd553696a64b';
const capacityBytes = 16 * 1024 ** 3, exec = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const check = (condition, message) => { if (!condition) throw Object.assign(Error(message), { builderGuard: true }); };
const trackedDependencies = ['loadEnv.js', 'server.js', 'package.json', 'package-lock.json',
  'services/driverAuditSource.js', 'services/driverAuditLiveImport.js', 'services/driverAuditOriginalSourceLineage.js',
  'services/driverAuditBuilderTransition.js', 'services/driverAuditDataBackend.js', 'services/driverAuditMongoArchive.js',
  'services/driverAuditSpacesArchive.js', 'services/driverAuditNativeObjectStore.js', 'services/driverAuditMongoRpc.js',
  'services/driverAuditPollProgress.js', 'scripts/checkDriverAuditBuilder.js',
  'vendor/driver-audits/integration/cloud/driver-audit-handoff.mjs', 'vendor/driver-audits/integration/hosted/worker-lock.mjs']
  .map(file => 'server/' + file);

async function systemFileIdentity(file) {
  const realpath = await fs.realpath(file), before = await fs.lstat(realpath);
  check(before.isFile() && before.uid === 0 && !(before.mode & 0o022) && before.size > 0 && before.size <= 64 * 1024,
    'The managed system executable differs');
  const handle = await fs.open(realpath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    check(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size
      && opened.uid === before.uid && opened.mode === before.mode, 'The system executable changed while opening');
    const bytes = await handle.readFile(), final = await handle.stat();
    check(bytes.length === opened.size && final.isFile() && final.dev === opened.dev && final.ino === opened.ino
      && final.size === opened.size && final.uid === opened.uid && final.mode === opened.mode
      && await fs.realpath(file) === realpath, 'The system executable changed while reading');
    return { realpath, isFile: true, uid: opened.uid, mode: opened.mode, bytes: opened.size, sha256: hash(bytes) };
  } finally { await handle.close(); }
}

async function apiLaunchIdentity(api, appRoot, systemFile) {
  const settings = api?.pm2_env, npm = await systemFile('/usr/bin/npm');
  check(integer(api?.pm_id) && settings?.pm_cwd === appRoot && isDeepStrictEqual(settings.args, ['start', '--prefix', 'server'])
    && npm?.isFile === true && npm.uid === 0 && !(npm.mode & 0o022) && integer(npm.bytes) && npm.bytes > 0
    && npm.bytes <= 64 * 1024 && digest(npm.sha256)
    && /^\/usr\/(?:share\/nodejs|(?:local\/)?lib\/node_modules)\/npm\/bin\/npm-cli\.js$/.test(npm.realpath || '')
    && ['/usr/bin/npm', npm.realpath].includes(settings.pm_exec_path), 'The exact trusted NPM application launch is required');
  return hash(JSON.stringify([api.pm_id, settings.pm_cwd, settings.pm_exec_path, settings.args, npm.realpath, npm.sha256]));
}

async function environmentBytes(file, optional = false) {
  const stat = await fs.lstat(file).catch(error => { if (optional && error.code === 'ENOENT') return null; throw error; });
  if (!stat) return Buffer.alloc(0);
  check(stat.isFile() && stat.uid === process.getuid() && await fs.realpath(file) === file && stat.size <= 1024 * 1024
    && (path.basename(file) !== '.env.local' || !(stat.mode & 0o077)), 'The durable app settings must be bounded owned files');
  const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    check(opened.ino === stat.ino && opened.dev === stat.dev, 'Durable app settings changed while reading');
    const bytes = await handle.readFile();
    check(bytes.length <= 1024 * 1024 && !bytes.includes(0) && Buffer.from(bytes.toString('utf8')).equals(bytes),
      'The durable app settings must be bounded UTF-8');
    return bytes;
  } finally { await handle.close(); }
}

async function immutable(file, bytes, read) {
  try { check((await read(file, 4 * 1024 * 1024)).equals(bytes), 'The preserved held-builder evidence differs'); return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path.join(path.dirname(file), '.held-builder-' + randomUUID() + '.tmp');
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await fs.link(temporary, file);
    const directory = await fs.open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await fs.unlink(temporary); }
}

function checkedCensus(value) {
  const { sha256, ...content } = value || {};
  check(digest(sha256) && hash(JSON.stringify(content)) === sha256 && Array.isArray(content.roots)
    && Array.isArray(content.collectorRevisions), 'The complete collector census differs');
  return value;
}

function changedCensus(before, from, to) {
  checkedCensus(before);
  const { sha256, ...content } = before;
  check(content.roots.filter(row => row.kind === 'sync.json').length === 1, 'The census lacks its exact managed sync configuration');
  const roots = content.roots.map(row => {
    if (row.kind !== 'sync.json') return row;
    check(row.sha256 === from, 'The original census sync configuration differs');
    return { ...row, sha256: to };
  });
  const result = { ...content, roots };
  return { ...result, sha256: hash(JSON.stringify(result)) };
}

// This operation never starts a process or invokes the auto-resuming deployment
// wrapper. Public dispatch supplies identities; every private path is host-derived.
export async function runDriverAuditNativeBuilder({ operation, sessionId, profileSha256, expectedSha, appRoot }, adapters = {}) {
  let phase = 'checkout', connection;
  const locks = [], execute = adapters.exec || exec, env = adapters.env || process.env;
  try {
    check(operation === 'swap-builder-held' && digest(profileSha256)
      && typeof sessionId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(sessionId),
    'The reviewed held swap and exact public identities are required');
    check(typeof appRoot === 'string' && path.isAbsolute(appRoot) && path.resolve(appRoot) === appRoot
      && await fs.realpath(appRoot) === appRoot, 'The exact app directory is required');
    const checkout = async () => {
      check((adapters.platform || process.platform) === 'linux' && /^[a-f0-9]{40}$/.test(expectedSha || '')
        && (await execute('git', ['rev-parse', 'HEAD'], { cwd: appRoot, timeout: 5000, maxBuffer: 4096 })).stdout.trim() === expectedSha,
      'The exact reviewed Linux checkout is required');
      await execute('git', ['ls-files', '--error-unmatch', '--', ...trackedDependencies], { cwd: appRoot, timeout: 5000, maxBuffer: 16 * 1024 });
      await execute('git', ['diff', '--quiet', expectedSha, '--', 'server', ...trackedDependencies], { cwd: appRoot, timeout: 5000, maxBuffer: 4096 });
    };
    await checkout();
    const server = path.join(appRoot, 'server');
    check(await fs.realpath(server) === server, 'The exact server directory is required');
    const load = adapters.load || (name => import(pathToFileURL(path.join(server, name)).href));
    await load('loadEnv.js');
    const { readPrivateDriverAuditSource: read, requirePrivateDriverAuditSourceDirectory: privateDirectory } = await load('services/driverAuditSource.js');
    const { default: dotenv } = await load('node_modules/dotenv/lib/main.js');
    const transferRoot = path.join(server, '.private/driver-audit-native-transfer'), folder = path.join(transferRoot, sessionId);
    phase = 'private-session'; await privateDirectory(transferRoot); await privateDirectory(folder);
    const { acquireWorkerLock } = await load('vendor/driver-audits/integration/hosted/worker-lock.mjs');
    locks.push(await acquireWorkerLock(path.join(transferRoot, 'operator.lock')));
    const sessionBytes = await read(path.join(folder, 'session.private.json'), 128 * 1024);
    const receivedBytes = await read(path.join(folder, 'received.private.json'), 1024 * 1024);
    const state = JSON.parse(sessionBytes), received = JSON.parse(receivedBytes);
    check(state.version === 1 && state.sessionId === sessionId && state.capacityBytes === capacityBytes
      && digest(state.inventorySha256) && state.plan?.inventorySha256 === state.inventorySha256
      && integer(state.createdAt) && state.createdAt <= Date.now()
      && received.version === 1 && received.status === 'transfer-received' && received.verified === true
      && received.authorityChanged === false && received.sessionId === sessionId && received.targetDatabase === state.targetDatabase
      && received.inventorySha256 === state.inventorySha256 && received.objects === state.plan.objectCount
      && received.bytes === state.plan.objectBytes && integer(received.objects) && received.objects > 0 && received.objects <= 100000
      && integer(received.bytes) && received.bytes > 0 && received.bytes <= 2 * 1024 ** 3
      && Number.isFinite(Date.parse(received.completedAt)) && Date.parse(received.completedAt) >= state.createdAt
      && Date.parse(received.completedAt) <= Date.now(), 'The verified original transfer session differs');
    const profileFile = path.join(folder, 'profile.private.json'), profileBytes = await read(profileFile, 1024 * 1024);
    check(hash(profileBytes) === profileSha256, 'The exact pre-swap profile differs');
    const profile = JSON.parse(profileBytes), syncRoot = profile.syncRoot;
    const syncParent = path.join(server, '.private/driver-audits'), sourceRoot = path.join(server, '.private/driver-audit-source');
    check(profile.version === 2 && profile.receiptInput === 'selected' && profile.capacityBytes === capacityBytes
      && profile.targetDatabase === state.targetDatabase && digest(profile.collectorRootsSha256)
      && path.dirname(syncRoot || '') === syncParent && digest(path.basename(syncRoot))
      && profile.runtimeSha256 === sourceManifest && profile.runtimeRoot === path.join(sourceRoot, sourceManifest, 'runtime'),
    'The pre-swap profile or managed native source differs');
    const originalInput = received.inputFiles?.filter(row => row?.name === profile.documents?.file);
    check(typeof profile.documents?.file === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]+\.jsonl(?:\.gz)?$/.test(profile.documents.file)
      && digest(profile.documents.sha256) && originalInput?.length === 1 && originalInput[0].sha256 === profile.documents.sha256
      && integer(originalInput[0].bytes) && originalInput[0].bytes > 0 && originalInput[0].bytes <= 64 * 1024 * 1024,
    'The original documents lack received provenance');
    await privateDirectory(syncParent); await privateDirectory(syncRoot);
    const readEnvironment = async () => {
      const base = await environmentBytes(path.join(server, '.env'), true), local = await environmentBytes(path.join(server, '.env.local'));
      const values = { ...dotenv.parse(base), ...dotenv.parse(local) };
      check(typeof values.MONGODB_URI === 'string' && values.MONGODB_URI.length > 0 && values.MONGODB_URI === env.MONGODB_URI,
        'The durable and loaded app database settings differ');
      check(values.DRIVER_AUDIT_REPLICA_GC_ENABLED === '0' && env.DRIVER_AUDIT_REPLICA_GC_ENABLED === '0',
        'Replica pruning must be durably disabled before the held swap');
      return { uri: values.MONGODB_URI, baseSha256: hash(base), localSha256: hash(local) };
    };
    const settings = await readEnvironment();
    phase = 'database';
    const { default: mongoose } = await load('node_modules/mongoose/index.js');
    connection = mongoose.createConnection(settings.uri, { autoCreate: false, autoIndex: false, maxPoolSize: 1, serverSelectionTimeoutMS: 10000 });
    await connection.asPromise(); const db = connection.db;
    check(db.databaseName === profile.targetDatabase, 'The held swap targets another database');
    const { readDriverAuditImportRows, collectDriverAuditReceiptRoots } = await load('services/driverAuditLiveImport.js');
    const pins = adapters.builderPins || { from: NATIVE_BUILDER_FROM, to: NATIVE_BUILDER_TO };
    check(digest(pins.from) && digest(pins.to) && pins.from !== pins.to, 'The two reviewed builder identities differ');
    const configFile = path.join(syncRoot, 'sync.json'), builder = path.join(syncRoot, 'builder');
    const staging = path.join(syncRoot, 'builder-staged-' + pins.to), retained = path.join(syncRoot, 'builder-retained-' + pins.from);
    const transitionFile = path.join(syncRoot, 'builder-transition-' + pins.from + '-' + pins.to + '.private.json');
    const optional = async (file, maximum = 1024 * 1024) => {
      try { return await read(file, maximum); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    };
    let admittedApiLaunchSha256;
    const capture = async () => {
      await checkout();
      check((await read(profileFile, 1024 * 1024)).equals(profileBytes)
        && (await read(path.join(folder, 'session.private.json'), 128 * 1024)).equals(sessionBytes)
        && (await read(path.join(folder, 'received.private.json'), 1024 * 1024)).equals(receivedBytes), 'The pinned swap inputs changed');
      const input = await read(path.join(folder, profile.documents.file), originalInput[0].bytes);
      check(input.length === originalInput[0].bytes && hash(input) === profile.documents.sha256, 'The original document input changed');
      const entries = JSON.parse((await execute('pm2', ['jlist'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 })).stdout);
      check(Array.isArray(entries), 'The managed process inventory differs');
      const api = entries.filter(row => row.name === 'matter-delivery-api'), sync = entries.filter(row => row.name === 'matter-driver-audit-sync');
      const source = entries.filter(row => row.name === 'matter-driver-audit-source');
      check(api.length === 1 && api[0].pm2_env?.status === 'online' && integer(api[0].pm_id)
        && Number.isSafeInteger(api[0].pid) && api[0].pid > 0
        && sync.length === 1 && integer(sync[0].pm_id) && sync[0].pid === 0 && sync[0].pm2_env?.status === 'stopped'
        && sync[0].pm2_env.pm_cwd === server && sync[0].pm2_env.pm_exec_path === path.join(server, 'scripts/driverAuditSync.js')
        && isDeepStrictEqual(sync[0].pm2_env.args, ['--config', configFile]) && source.length <= 1
        && source.every(row => integer(row.pm_id) && row.pid === 0 && row.pm2_env?.status === 'stopped'),
      'The existing app and stopped report registrations are required');
      const apiIdentity = await apiLaunchIdentity(api[0], appRoot, adapters.systemFile || systemFileIdentity);
      check(!admittedApiLaunchSha256 || apiIdentity === admittedApiLaunchSha256, 'The managed application launch changed');
      admittedApiLaunchSha256 = apiIdentity;
      for (const row of source) {
        const value = row.pm2_env, args = value.args, file = args?.[1], parent = typeof file === 'string' ? path.dirname(file) : '';
        check(value.pm_cwd === server && value.pm_exec_path === path.join(server, 'scripts/driverAuditSource.js')
          && Array.isArray(args) && args.length === 2 && args[0] === '--config' && path.dirname(parent) === sourceRoot
          && digest(path.basename(parent)) && file === path.join(parent, 'source.json'), 'The stopped source invocation differs');
      }
      const processes = [...api, ...sync, ...source].map(row => ({ name: row.name, id: row.pm_id, pid: row.pid,
        cwd: row.pm2_env.pm_cwd, script: row.pm2_env.pm_exec_path, args: row.pm2_env.args ?? null,
        uptime: row.pm2_env.pm_uptime ?? null, status: row.pm2_env.status }));
      const configBytes = await read(configFile, 1024 * 1024), config = JSON.parse(configBytes);
      check(config.version === 1 && config.root === syncRoot && config.codeRoot === builder
        && [pins.from, pins.to].includes(config.builderSha256) && config.baselineRoot === path.join(syncRoot, 'baseline')
        && config.rendererBuild?.path === path.join(syncRoot, 'baseline/build.private.json')
        && config.journals?.path === path.join(syncRoot, 'validation-journals.private.json'), 'The managed builder configuration differs');
      const [authority, stage, capacity, head] = await Promise.all([
        db.collection('driverAuditNativeControl').findOne({ _id: 'authority' }),
        db.collection('driverAuditControl').findOne({ _id: 'direct-stage' }),
        db.collection('driverAuditNativeControl').findOne({ _id: 'capacity' }),
        db.collection('driverAuditControl').findOne({ _id: 'head' }),
      ]);
      check(!authority || authority.status === 'staging' && authority.importSha256 === profileSha256 && integer(authority.writeFence),
        'The held swap requires inactive native authority bound to this profile');
      check(!stage, 'An unresolved direct publication blocks the held swap');
      check(capacity?.limitBytes === capacityBytes && integer(capacity.usedBytes) && capacity.usedBytes <= capacityBytes,
        'The explicit native storage allowance differs');
      check(head?.head?.directImport?.version === 1 && Number.isSafeInteger(head.head.sourceRevision) && head.head.sourceRevision > 0
        && head.head.directImport.collectorRevision === head.head.sourceRevision
        && [head.head.generation, head.head.reportHash, head.head.sourceBodySha256,
          head.head.directImport.sourceBasis, head.head.directImport.manifestSha256].every(digest), 'The active direct-import head differs');
      const seedBytes = await read(path.join(syncRoot, 'seed.json'), 1024 * 1024), seed = JSON.parse(seedBytes);
      check(seed.version === 1 && seed.mode === 'bootstrap' && Number.isSafeInteger(seed.collectorRevision)
        && seed.collectorRevision > 0 && digest(seed.sourceBasis) && digest(seed.manifestSha256), 'The original bootstrap identity differs');
      const pointer = await optional(path.join(syncRoot, 'work/current.private.json'));
      const documents = await Array.fromAsync(readDriverAuditImportRows(folder, profile.documents));
      check(documents.length > 0 && documents.length <= 100000, 'The original document coverage differs');
      const census = checkedCensus(await collectDriverAuditReceiptRoots({ db, documents, syncRoot }));
      check(census.collectorRevisions.includes(seed.collectorRevision)
        && census.roots.some(root => root.kind === 'seed.json' && root.sha256 === hash(seedBytes)), 'The actual bootstrap and census differ');
      const values = await readEnvironment();
      const baseline = { processesSha256: hash(JSON.stringify(processes)), apiLaunchIdentitySha256: admittedApiLaunchSha256,
        authoritySha256: hash(JSON.stringify(authority)),
        capacitySha256: hash(JSON.stringify(capacity)), servingHeadSha256: hash(JSON.stringify(head)),
        workspacePointerSha256: hash(pointer ?? 'null'), seedSha256: hash(seedBytes), baseSha256: values.baseSha256, localSha256: values.localSha256 };
      return { configBytes, config, census, baseline };
    };
    phase = 'held-admission'; await capture();
    locks.push(await acquireWorkerLock(path.join(syncParent, 'sync-worker.lock')));
    const sourcePresent = await fs.lstat(sourceRoot).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; });
    if (sourcePresent) {
      await privateDirectory(sourceRoot);
      locks.push(await acquireWorkerLock(path.join(sourceRoot, 'source-deployment.lock')));
      locks.push(await acquireWorkerLock(path.join(sourceRoot, 'source-worker.lock')));
    }
    phase = 'preserved-plan';
    const planFile = path.join(folder, 'held-builder-plan-' + pins.from + '-' + pins.to + '.private.json');
    const beforeFile = path.join(folder, 'held-builder-before-' + pins.from + '-' + pins.to + '.private.json');
    const previousPlanBytes = await optional(planFile, 4 * 1024 * 1024), previousPlan = previousPlanBytes && JSON.parse(previousPlanBytes);
    const initial = await capture(), beforeConfig = previousPlan ? await read(beforeFile, 1024 * 1024) : initial.configBytes;
    const original = JSON.parse(beforeConfig);
    check(original.builderSha256 === pins.from && original.root === syncRoot && original.codeRoot === builder,
      'The preserved source builder configuration differs');
    const afterConfig = Buffer.from(JSON.stringify({ ...original, builderSha256: pins.to, legacyBuildRecipe: original.legacyBuildRecipe ?? null }));
    const beforeCensus = previousPlan ? checkedCensus(previousPlan.beforeCensus) : initial.census;
    check(beforeCensus.sha256 === profile.collectorRootsSha256, 'The pre-swap census differs from its pinned profile');
    const afterCensus = changedCensus(beforeCensus, hash(beforeConfig), hash(afterConfig));
    const plan = { version: 1, operation, sessionId, profileSha256, applicationCommit: expectedSha, from: pins.from, to: pins.to,
      baseline: initial.baseline, beforeConfigSha256: hash(beforeConfig), afterConfigSha256: hash(afterConfig), beforeCensus, afterCensus };
    const planBytes = Buffer.from(JSON.stringify(plan, null, 2) + '\n');
    check(!previousPlanBytes || previousPlanBytes.equals(planBytes), 'The held-builder plan or protected controls changed');
    const expectedCapture = value => {
      check(isDeepStrictEqual(value.baseline, plan.baseline), 'Protected heads, settings or process registrations changed');
      const before = value.configBytes.equals(beforeConfig), after = value.configBytes.equals(afterConfig);
      check((before || after) && isDeepStrictEqual(value.census, before ? beforeCensus : afterCensus),
        'A control other than the exact builder configuration changed in the census');
      return after;
    };
    const already = expectedCapture(initial);
    const oldTransitionBytes = await optional(transitionFile);
    check(!oldTransitionBytes || previousPlan, 'An unbound previous builder transition requires independent recovery');
    const verifyTransition = bytes => {
      const receipt = JSON.parse(bytes), decoded = typeof receipt.oldConfig === 'string' ? Buffer.from(receipt.oldConfig, 'base64') : null;
      check(receipt.version === 1 && receipt.from === pins.from && receipt.to === pins.to && decoded?.equals(beforeConfig)
        && decoded.toString('base64') === receipt.oldConfig, 'The exact original transition receipt differs');
    };
    if (oldTransitionBytes) verifyTransition(oldTransitionBytes);
    const transition = await load('services/driverAuditBuilderTransition.js');
    check(transition.driverAuditBuilderConfigGuardVersion === 1, 'The deployed builder transition lacks exact config guards');
    const { verifyAuditBuilder } = await load('vendor/driver-audits/integration/cloud/driver-audit-handoff.mjs');
    if (!previousPlan) { await privateDirectory(builder); await verifyAuditBuilder(builder, pins.from); }
    const staged = await fs.lstat(staging).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; });
    const candidate = staged ? staging : builder; await privateDirectory(candidate); await verifyAuditBuilder(candidate, pins.to);
    phase = 'fresh-smoke';
    const node = await execute(process.execPath, ['--version'], { env: {}, timeout: 5000, maxBuffer: 4096 });
    check(node.stdout.trim() === process.version, 'The fresh host Node version differs');
    const smoked = await execute(process.execPath, [path.join(server, 'scripts/checkDriverAuditBuilder.js'), candidate, pins.to, syncRoot],
      { cwd: server, env: {}, timeout: 60000, maxBuffer: 16384 });
    const smoke = JSON.parse(smoked.stdout);
    check(smoke.status === 'checked' && smoke.builderSha256 === pins.to && smoke.node === process.version
      && smoke.platform === process.platform, 'The actual host builder smoke check differs');
    expectedCapture(await capture());
    await immutable(beforeFile, beforeConfig, read); await immutable(planFile, planBytes, read);
    phase = 'held-state-save'; await execute('pm2', ['save'], { timeout: 10000, maxBuffer: 256 * 1024 });
    const beforeSwitch = await capture(); expectedCapture(beforeSwitch);
    phase = 'builder-transition';
    const changed = await transition.transitionDriverAuditBuilder({ root: syncRoot, from: pins.from, to: pins.to,
      expectedConfigSha256: hash(beforeSwitch.configBytes) });
    check(changed.builderSha256 === pins.to, 'The actual held builder transition differs');
    check(expectedCapture(await capture()), 'The installed held configuration differs');
    await privateDirectory(builder); await privateDirectory(retained);
    await verifyAuditBuilder(builder, pins.to); await verifyAuditBuilder(retained, pins.from);
    const transitionBytes = await read(transitionFile, 1024 * 1024); verifyTransition(transitionBytes);
    phase = 'held-state-save'; await execute('pm2', ['save'], { timeout: 10000, maxBuffer: 256 * 1024 });
    check(expectedCapture(await capture()), 'The final held builder configuration differs');
    const receipt = { version: 1, status: 'builder-swapped-held', sessionId, profileSha256, applicationCommit: expectedSha,
      builderSha256: pins.to, retainedBuilderSha256: pins.from, nodeVersion: process.version,
      planSha256: hash(planBytes), beforeConfigSha256: hash(beforeConfig), afterConfigSha256: hash(afterConfig),
      transitionReceiptSha256: hash(transitionBytes), previousCollectorRootsSha256: beforeCensus.sha256,
      collectorRootsSha256: afterCensus.sha256, requiresNewImportProfile: true, reportWorkersStopped: true,
      processScope: 'managed-native-report-workers', pruningEnabled: false, authorityChanged: false,
      activationPending: true, verifiedAt: new Date().toISOString() };
    const receiptBytes = Buffer.from(JSON.stringify(receipt, null, 2) + '\n');
    phase = 'private-receipt';
    await immutable(path.join(folder, 'held-builder-receipt-' + pins.from + '-' + pins.to + '-' + hash(receiptBytes) + '.private.json'), receiptBytes, read);
    return { ...receipt, status: already ? 'builder-already-held' : 'builder-swapped-held', receiptSha256: hash(receiptBytes) };
  } catch (error) {
    throw Object.assign(Error(error.builderGuard ? error.message : 'Held builder stopped at ' + phase), { phase });
  } finally {
    let failed = false;
    try { await connection?.close(); } catch { failed = true; }
    for (const lock of locks.reverse()) try { await lock.release(); } catch { failed = true; }
    if (failed) throw Object.assign(Error('Held builder cleanup stopped'), { phase: 'cleanup' });
  }
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runDriverAuditNativeBuilder({ operation: process.env.NATIVE_HANDOFF_OPERATION,
    sessionId: process.env.NATIVE_TRANSFER_SESSION_ID, profileSha256: process.env.NATIVE_IMPORT_PROFILE_SHA256,
    expectedSha: process.env.EXPECTED_DEPLOYED_SHA, appRoot: await fs.realpath(process.cwd()) }))); }
  catch (error) { console.error('Held builder stopped at ' + (error.phase || 'checkout') + '. Check the preserved plan and stopped report workers.'); process.exitCode = 1; }
}
