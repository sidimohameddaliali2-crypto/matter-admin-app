import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const NATIVE_IMPORT_CAPACITY_BYTES = 16 * 1024 ** 3;
export const NATIVE_IMPORT_SOURCE_MANIFEST = 'e1650c0a521271976629fafc1ad6d6eb0abf39074b5eeaf909f2d93f929f9d9d';
export const NATIVE_BUILDER_FROM = '293c5001a5cc3aa61e422dc659db507d9be00e79c0848900f074279f6a02960f';
export const NATIVE_BUILDER_TO = 'aa624979d3d119bb3fd8eb4ca82ed1b976aaa6319ec3974596745c3a30a24b65';
export const NATIVE_IMPORT_FILES = Object.freeze({
  documents: 'documents.private.jsonl.gz', receipts: 'receipts.private.jsonl.gz',
  historical: 'historical.private.jsonl.gz', objects: 'objects.private.jsonl.gz',
  bookkeepingBackup: 'bookkeeping-backup.private.json', reviewContexts: 'review-contexts.private.jsonl.gz',
  reviewDependencies: 'review-dependencies.private.jsonl.gz',
});
const exec = promisify(execFile), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requireImport = (condition, message) => { if (!condition) throw Object.assign(Error(message), { importGuard: true }); };

async function saveProfile(file, bytes, read) {
  try {
    const existing = await read(file, 1024 * 1024);
    requireImport(hash(existing) === hash(bytes), 'The immutable import profile differs');
    return;
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

async function stageBuilder({ folder, received, bundleSha256, syncRoot, read, privateDirectory, load, pins }) {
  const changed = 'integration/cloud/automatic-release-source.mjs', filename = 'builder-bundle.private.json.gz';
  requireImport(digest(pins.from) && digest(pins.to) && pins.from !== pins.to, 'The reviewed builder identities differ');
  const matching = Array.isArray(received.inputFiles) ? received.inputFiles.filter(row => row?.name === filename) : [];
  requireImport(matching.length === 1 && matching[0].sha256 === bundleSha256 && integer(matching[0].bytes)
    && matching[0].bytes > 0 && matching[0].bytes <= 36 * 1024, 'The received reviewed builder bundle is required');
  const compressed = await read(path.join(folder, filename), 36 * 1024);
  requireImport(compressed.length === matching[0].bytes && hash(compressed) === bundleSha256, 'The received builder bundle differs');
  const bundle = JSON.parse(gunzipSync(compressed, { maxOutputLength: 128 * 1024 }));
  requireImport(object(bundle) && bundle.version === 1 && Object.keys(bundle).sort().join(',') === 'delta,manifest,version'
    && typeof bundle.manifest === 'string' && object(bundle.delta) && Object.keys(bundle.delta).join(',') === changed,
  'Only the reviewed one-file builder delta is accepted');
  const decode = value => {
    requireImport(typeof value === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(value), 'The builder encoding differs');
    const bytes = Buffer.from(value, 'base64');
    requireImport(bytes.toString('base64') === value, 'The builder encoding differs'); return bytes;
  };
  const manifestBytes = decode(bundle.manifest), manifest = JSON.parse(manifestBytes), replacement = decode(bundle.delta[changed]);
  requireImport(hash(manifestBytes) === pins.to && manifest.version === 1 && object(manifest.files)
    && Object.keys(manifest.files).length === 73, 'The exact replacement 73-file builder manifest is required');
  const source = path.join(syncRoot, 'builder'), target = path.join(syncRoot, 'builder-staged-' + pins.to);
  const config = JSON.parse(await read(path.join(syncRoot, 'sync.json'), 1024 * 1024));
  requireImport(config.codeRoot === source && config.builderSha256 === pins.from, 'The active source builder differs');
  const { verifyAuditBuilder } = await load('vendor/driver-audits/integration/cloud/driver-audit-handoff.mjs');
  await verifyAuditBuilder(source, pins.from);
  const originalBytes = await read(path.join(source, 'runtime-manifest.json'), 128 * 1024), original = JSON.parse(originalBytes);
  requireImport(hash(originalBytes) === pins.from && original.version === 1 && object(original.files)
    && Object.keys(original.files).length === 73 && JSON.stringify(Object.keys(original.files).sort())
      === JSON.stringify(Object.keys(manifest.files).sort()), 'The exact original builder inventory differs');
  const candidate = [];
  for (const [name, expected] of Object.entries(manifest.files)) {
    requireImport(name.length < 512 && name.split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))
      && digest(expected) && (name === changed ? expected !== original.files[name] : expected === original.files[name]),
    'The builder delta changed an unreviewed file');
    const saved = await read(path.join(source, name), 8 * 1024 * 1024);
    requireImport(hash(saved) === original.files[name], 'The original builder file differs');
    const bytes = name === changed ? replacement : saved;
    requireImport(bytes.length <= 8 * 1024 * 1024 && hash(bytes) === expected, 'The replacement builder file differs');
    candidate.push([name, bytes]);
  }
  const verify = async directory => {
    await verifyAuditBuilder(directory, pins.to);
    async function directories(root) {
      await privateDirectory(root);
      for (const entry of await fs.readdir(root, { withFileTypes: true })) if (entry.isDirectory()) await directories(path.join(root, entry.name));
    }
    await directories(directory);
    for (const [name, expected] of Object.entries(manifest.files)) {
      requireImport(hash(await read(path.join(directory, name), 8 * 1024 * 1024)) === expected, 'The staged builder file differs');
    }
    requireImport(hash(await read(path.join(directory, 'runtime-manifest.json'), 128 * 1024)) === pins.to,
      'The staged builder manifest differs');
  };
  const result = { builderSha256: pins.to, sourceBuilderSha256: pins.from, bundleSha256, files: 73, activationPending: true,
    authorityChanged: false };
  if (await fs.lstat(target).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; })) {
    await verify(target); return { ...result, status: 'builder-already-staged' };
  }
  await fs.mkdir(target, { mode: 0o700 });
  for (const [name, bytes] of [...candidate, ['runtime-manifest.json', manifestBytes]]) {
    await fs.mkdir(path.dirname(path.join(target, name)), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(target, name), bytes, { flag: 'wx', mode: 0o600 });
  }
  await verify(target);
  return { ...result, status: 'builder-staged' };
}

// The optional adapters are for isolated fixture tests. Dispatch supplies only
// reviewed public identities; all private paths/modules come from the host.
export async function runDriverAuditNativeImport({ operation, sessionId, templateSha256, profileSha256,
  expectedSha, appRoot }, adapters = {}) {
  let phase = 'checkout', lock, connection;
  const execute = adapters.exec || exec, env = adapters.env || process.env;
  try {
    requireImport(['create-profile', 'plan-import', 'stage-import', 'verify-import', 'stage-builder'].includes(operation)
      && typeof sessionId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(sessionId)
      && digest(templateSha256), 'A reviewed import operation and public input identities are required');
    requireImport(profileSha256 === undefined || digest(profileSha256), 'The import profile pin is invalid');
    requireImport(!['stage-import', 'verify-import'].includes(operation) || digest(profileSha256), 'The exact import profile pin is required');
    requireImport(typeof appRoot === 'string' && path.isAbsolute(appRoot) && path.resolve(appRoot) === appRoot
      && await fs.realpath(appRoot) === appRoot, 'The exact application root is required');
    const checkout = async () => {
      const actual = (await execute('git', ['rev-parse', 'HEAD'], { cwd: appRoot, timeout: 5000, maxBuffer: 4096 })).stdout.trim();
      requireImport((adapters.platform || process.platform) === 'linux' && /^[a-f0-9]{40}$/.test(expectedSha || '')
        && actual === expectedSha, 'The exact Linux application checkout is required');
    };
    await checkout();
    const server = path.join(appRoot, 'server');
    const load = adapters.load || (name => import(pathToFileURL(path.join(server, name)).href));
    await load('loadEnv.js');
    const { readPrivateDriverAuditSource: read, requirePrivateDriverAuditSourceDirectory: privateDirectory,
      verifyDriverAuditSource } = await load('services/driverAuditSource.js');
    phase = 'private-session';
    const transferRoot = path.join(server, '.private/driver-audit-native-transfer'), folder = path.join(transferRoot, sessionId);
    await privateDirectory(transferRoot); await privateDirectory(folder);
    const { acquireWorkerLock } = await load('vendor/driver-audits/integration/hosted/worker-lock.mjs');
    lock = await acquireWorkerLock(path.join(transferRoot, 'operator.lock'));
    await checkout();
    const state = JSON.parse(await read(path.join(folder, 'session.private.json'), 128 * 1024));
    const received = JSON.parse(await read(path.join(folder, 'received.private.json'), 1024 * 1024));
    requireImport(state.version === 1 && state.sessionId === sessionId && state.capacityBytes === NATIVE_IMPORT_CAPACITY_BYTES
      && digest(state.inventorySha256) && state.plan?.inventorySha256 === state.inventorySha256
      && integer(state.createdAt) && state.createdAt <= Date.now(), 'The verified private transfer session differs');
    requireImport(received.version === 1 && received.status === 'transfer-received' && received.verified === true
      && received.authorityChanged === false && received.sessionId === sessionId && received.targetDatabase === state.targetDatabase
      && received.inventorySha256 === state.inventorySha256 && received.objects === state.plan.objectCount
      && received.bytes === state.plan.objectBytes && integer(received.objects) && received.objects > 0 && received.objects <= 100000
      && integer(received.bytes) && received.bytes > 0 && received.bytes <= 2 * 1024 ** 3
      && Number.isFinite(Date.parse(received.completedAt)) && Date.parse(received.completedAt) >= state.createdAt
      && Date.parse(received.completedAt) <= Date.now(), 'The verified native transfer receipt differs');
    phase = 'database';
    requireImport(typeof env.MONGODB_URI === 'string' && env.MONGODB_URI.length > 0, 'The existing app database connection is required');
    const { default: mongoose } = await load('node_modules/mongoose/index.js');
    connection = mongoose.createConnection(env.MONGODB_URI, {
      autoCreate: false, autoIndex: false, maxPoolSize: 1, serverSelectionTimeoutMS: 10000,
    });
    await connection.asPromise();
    const db = connection.db;
    requireImport(db.databaseName === state.targetDatabase, 'The received inputs target another database');
    let syncRoot;
    const stopped = async () => {
      const entries = JSON.parse((await execute('pm2', ['jlist'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 })).stdout);
      requireImport(Array.isArray(entries), 'The managed process inventory is invalid');
      const sync = entries.filter(row => row.name === 'matter-driver-audit-sync');
      requireImport(entries.filter(row => row.name === 'matter-delivery-api').length === 1 && sync.length === 1
        && sync[0].pm2_env?.status === 'stopped'
        && entries.filter(row => row.name === 'matter-driver-audit-source').every(row => row.pm2_env?.status === 'stopped'),
      'Native import requires stopped report workers');
      const worker = sync[0].pm2_env, args = worker.args;
      requireImport(worker.pm_cwd === server && worker.pm_exec_path === path.join(server, 'scripts/driverAuditSync.js')
        && Array.isArray(args) && args.length === 2 && args[0] === '--config', 'The managed sync invocation differs');
      const candidate = typeof args[1] === 'string' ? path.dirname(args[1]) : '';
      requireImport(path.dirname(candidate) === path.join(server, '.private/driver-audits') && digest(path.basename(candidate))
        && args[1] === path.join(candidate, 'sync.json') && (!syncRoot || syncRoot === candidate), 'The managed sync root differs');
      syncRoot = candidate;
      await privateDirectory(syncRoot);
      const config = JSON.parse(await read(args[1], 1024 * 1024));
      requireImport(config.version === 1 && config.root === syncRoot && config.codeRoot === path.join(syncRoot, 'builder')
        && config.baselineRoot === path.join(syncRoot, 'baseline')
        && config.rendererBuild?.path === path.join(syncRoot, 'baseline/build.private.json')
        && config.journals?.path === path.join(syncRoot, 'validation-journals.private.json'), 'The managed sync configuration differs');
      const [authority, stage, capacity] = await Promise.all([
        db.collection('driverAuditNativeControl').findOne({ _id: 'authority' }),
        db.collection('driverAuditControl').findOne({ _id: 'direct-stage' }),
        db.collection('driverAuditNativeControl').findOne({ _id: 'capacity' }),
      ]);
      requireImport(!authority || authority.status === 'staging', 'Native import requires inactive authority');
      requireImport(!stage, 'An unresolved direct publication blocks native import');
      requireImport(!capacity || capacity.limitBytes === NATIVE_IMPORT_CAPACITY_BYTES
        && integer(capacity.usedBytes) && capacity.usedBytes <= capacity.limitBytes, 'The explicit native storage allowance differs');
      return authority;
    };
    phase = 'writers'; await stopped();
    if (operation === 'stage-builder') {
      phase = 'builder-staging';
      const result = await stageBuilder({ folder, received, bundleSha256: templateSha256, syncRoot, read, privateDirectory, load,
        pins: adapters.builderPins || { from: NATIVE_BUILDER_FROM, to: NATIVE_BUILDER_TO } });
      await stopped(); await checkout();
      return { version: 1, sessionId, applicationCommit: expectedSha, ...result };
    }
    phase = 'input-files';
    const templateFile = 'profile-template.private.json', names = [templateFile, ...Object.values(NATIVE_IMPORT_FILES)];
    requireImport(Array.isArray(received.inputFiles) && received.inputFiles.length === names.length,
      'The complete fixed-name private import inputs are required');
    const inputs = new Map();
    for (const row of received.inputFiles) {
      requireImport(object(row) && names.includes(row.name) && !inputs.has(row.name) && digest(row.sha256)
        && integer(row.bytes) && row.bytes > 0 && row.bytes <= 64 * 1024 * 1024, 'The private import input inventory differs');
      const bytes = await read(path.join(folder, row.name), row.bytes);
      requireImport(bytes.length === row.bytes && hash(bytes) === row.sha256, 'The received private import input hash or size differs');
      inputs.set(row.name, row);
    }
    requireImport([...inputs.values()].reduce((sum, row) => sum + row.bytes, 0) <= received.bytes,
      'The received private import byte coverage differs');
    const templateBytes = await read(path.join(folder, templateFile), 128 * 1024);
    requireImport(templateSha256 === inputs.get(templateFile)?.sha256 && hash(templateBytes) === templateSha256,
      'The private import template hash differs');
    const template = JSON.parse(templateBytes), fields = Object.keys(NATIVE_IMPORT_FILES);
    requireImport(object(template) && Object.keys(template).every(name => [...fields, 'version', 'capacityBytes', 'receiptInput', 'previousImportSha256'].includes(name))
      && template.version === 2 && template.capacityBytes === NATIVE_IMPORT_CAPACITY_BYTES
      && ['full', 'selected'].includes(template.receiptInput)
      && (template.previousImportSha256 === undefined || digest(template.previousImportSha256)), 'The host-neutral private import template differs');
    const refs = {};
    for (const [name, file] of Object.entries(NATIVE_IMPORT_FILES)) {
      const ref = template[name];
      requireImport(object(ref) && Object.keys(ref).sort().join(',') === 'file,sha256' && ref.file === file
        && digest(ref.sha256) && ref.sha256 === inputs.get(file)?.sha256, 'A fixed-name private import reference differs');
      refs[name] = { file, sha256: ref.sha256 };
    }
    phase = 'source-runtime';
    const sourceRoot = path.join(server, '.private/driver-audit-source', NATIVE_IMPORT_SOURCE_MANIFEST);
    await privateDirectory(sourceRoot);
    const source = JSON.parse(await read(path.join(sourceRoot, 'source.json'), 1024 * 1024));
    requireImport(source.version === 1 && source.root === sourceRoot && source.manifestSha256 === NATIVE_IMPORT_SOURCE_MANIFEST
      && source.runtimeRoot === path.join(sourceRoot, 'runtime'), 'The staged pinned source runtime differs');
    await verifyDriverAuditSource({ runtimeRoot: source.runtimeRoot, expectedSha256: NATIVE_IMPORT_SOURCE_MANIFEST });
    const { readDriverAuditImportRows, collectDriverAuditReceiptRoots } = await load('services/driverAuditLiveImport.js');
    const census = async () => {
      const documents = await Array.fromAsync(readDriverAuditImportRows(folder, refs.documents));
      const value = await collectDriverAuditReceiptRoots({ db, documents, syncRoot });
      requireImport(digest(value.sha256), 'The actual retained collector census is unavailable'); return value.sha256;
    };
    phase = 'collector-census'; const collectorRootsSha256 = await census();
    const profile = { version: 2, targetDatabase: db.databaseName, capacityBytes: NATIVE_IMPORT_CAPACITY_BYTES,
      ...(template.previousImportSha256 ? { previousImportSha256: template.previousImportSha256 } : {}),
      syncRoot, collectorRootsSha256, receiptInput: template.receiptInput, ...refs,
      runtimeRoot: source.runtimeRoot, runtimeSha256: NATIVE_IMPORT_SOURCE_MANIFEST };
    const profileBytes = Buffer.from(JSON.stringify(profile, null, 2) + '\n'), actualProfileSha = hash(profileBytes);
    phase = 'profile';
    requireImport(profileSha256 === undefined || actualProfileSha === profileSha256, 'The exact import profile or collector roots differ');
    const profileFile = path.join(folder, 'profile.private.json');
    const safety = async () => {
      await checkout(); const authority = await stopped();
      requireImport(!authority ? !profile.previousImportSha256 : authority.importSha256 === actualProfileSha
        || authority.importSha256 === profile.previousImportSha256, 'The staged previous import identity differs');
      requireImport(await census() === collectorRootsSha256, 'The actual retained collector roots changed');
    };
    await safety();
    if (operation === 'create-profile') await saveProfile(profileFile, profileBytes, read);
    requireImport(hash(await read(profileFile, 1024 * 1024)) === actualProfileSha, 'The pinned import profile or collector roots differ');
    const output = { version: 1, sessionId, applicationCommit: expectedSha, templateSha256, profileSha256: actualProfileSha,
      collectorRootsSha256, capacityBytes: NATIVE_IMPORT_CAPACITY_BYTES, activationPending: true };
    if (operation === 'create-profile') return { ...output, status: 'profile-created' };
    phase = operation;
    const cliOperation = { 'plan-import': 'plan', 'stage-import': 'stage', 'verify-import': 'verify' }[operation];
    const result = await execute(process.execPath, [path.join(server, 'scripts/driverAuditMongoMigrate.js'), cliOperation,
      profileFile, actualProfileSha], { cwd: server, env, timeout: 55 * 60 * 1000, maxBuffer: 256 * 1024 });
    const receipt = JSON.parse(result.stdout);
    requireImport(receipt.status === { plan: 'planned', stage: 'staged', verify: 'staged-data-verified' }[cliOperation]
      && receipt.importSha256 === actualProfileSha
      && (receipt.collectorRootsSha256 === undefined || receipt.collectorRootsSha256 === collectorRootsSha256)
      && (cliOperation === 'plan' || receipt.activationPending === true), 'The native migration CLI receipt differs');
    await safety();
    const counts = {};
    for (const name of ['objects', 'missingObjects', 'missingBytes', 'availableAllowanceBytes', 'archiveObjects']) {
      if (integer(receipt[name])) counts[name] = receipt[name];
    }
    for (const [name, count] of Object.entries({ documents: receipt.documents?.documents ?? receipt.documents,
      receipts: receipt.receipts?.receipts ?? receipt.receipts, historical: receipt.historical?.records ?? receipt.historical })) {
      if (integer(count)) counts[name] = count;
    }
    return { ...output, status: receipt.status, counts,
      ...(cliOperation === 'verify' ? { archiveClosurePending: true, resultsEqual: receipt.resultsEqual === true,
        reportIdentityEqual: receipt.reportIdentityEqual === true, assessmentHistoryEqual: receipt.assessmentHistoryEqual === true } : {}) };
  } catch (error) {
    throw Object.assign(Error(error.importGuard ? error.message : 'Native import stopped at ' + phase), { phase });
  } finally {
    let cleanupFailed = false;
    try { await connection?.close(); } catch { cleanupFailed = true; }
    try { await lock?.release(); } catch { cleanupFailed = true; }
    if (cleanupFailed) throw Object.assign(Error('Native import cleanup stopped'), { phase: 'cleanup' });
  }
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await runDriverAuditNativeImport({ operation: process.env.NATIVE_HANDOFF_OPERATION,
      sessionId: process.env.NATIVE_TRANSFER_SESSION_ID, templateSha256: process.env.NATIVE_IMPORT_TEMPLATE_SHA256,
      profileSha256: process.env.NATIVE_IMPORT_PROFILE_SHA256 || undefined,
      expectedSha: process.env.EXPECTED_DEPLOYED_SHA, appRoot: await fs.realpath(process.cwd()) })));
  } catch (error) {
    console.error('Native import stopped at ' + (error.phase || 'checkout') + '. Check the reviewed inputs and stopped report workers.');
    process.exitCode = 1;
  }
}
