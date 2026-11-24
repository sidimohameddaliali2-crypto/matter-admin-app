import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repository = 'sidimohameddaliali2-crypto/matter-admin-app';
const environmentName = 'driver-reports-worker';
const secretNames = ['DRIVER_AUDIT_WORKER_CACHE_KEY', 'DRIVER_AUDIT_WORKER_SUPABASE_SECRET'];
const releasePinsFile = 'hosted-release-pins.private.json';
const pinHashes = ['sourceManifestSha256', 'builderSha256', 'baselineManifestSha256', 'rendererSha256', 'journalsSha256'];
const pinCounts = ['sourceFiles', 'builderFiles', 'baselineFiles'];
const schedules = Object.freeze([{ dubai: '10:30', utc: '06:30', cron: '30 6 * * *' },
  { dubai: '12:00', utc: '08:00', cron: '0 8 * * *' }]);
const routes = ['/api/collector?task=delivery-history', '/api/collector?task=delivery', '/api/morning-gps',
  '/api/collector?task=gps-publish', '/api/collector?task=photo-backlog', '/api/collector?task=photo-grade'];
const need = condition => { if (!condition) throw Error('Hosted bootstrap input differs'); };
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const relative = value => typeof value === 'string' && value.length <= 512
  && value.split('/').every(part => /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..');
const signature = value => ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(key => String(value[key])).join(':');
const privateOwner = info => info.uid === BigInt(process.getuid()) && !(Number(info.mode) & 0o077);
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function parse(bytes) {
  need(Buffer.isBuffer(bytes) && bytes.length <= 1024 * 1024 && Buffer.from(bytes.toString('utf8')).equals(bytes));
  try { return JSON.parse(bytes); } catch { throw Error('Hosted bootstrap JSON differs'); }
}

export function driverAuditHostedWorkerPlan() {
  return { version: 1, kind: 'driver-audit-hosted-worker-plan', repository, environment: environmentName,
    ref: 'refs/heads/main', schedules: structuredClone(schedules), releasePinsFile,
    requiredEnvironmentSecrets: [...secretNames], environmentConfigurationRequires: 'repository-owner',
    workerArmed: false, networkRequests: 0 };
}

// This receipt binds original API metadata bytes supplied by the provisioning
// operator. Offline validation does not authenticate their live GitHub origin
// or make an environment/secret change, qualify Linux, or enroll a worker.
export function createDriverAuditHostedEnvironmentActivation({ captures, observedAt } = {}) {
  need(exact(captures, ['repository', 'environment', 'branches', 'secrets']) && iso(observedAt) && Date.parse(observedAt) <= Date.now());
  const source = Object.fromEntries(Object.entries(captures).map(([key, bytes]) => [key, parse(bytes)]));
  need(source.repository.full_name === repository && source.repository.default_branch === 'main' && source.repository.private === false
    && source.repository.owner?.login === repository.split('/')[0] && source.repository.owner.type === 'User');
  const env = source.environment;
  need(env.name === environmentName && Array.isArray(env.protection_rules) && env.protection_rules.length === 1
    && env.protection_rules[0].type === 'branch_policy'
    && exact(env.deployment_branch_policy, ['protected_branches', 'custom_branch_policies'])
    && env.deployment_branch_policy.protected_branches === false && env.deployment_branch_policy.custom_branch_policies === true);
  need(source.branches.total_count === 1 && Array.isArray(source.branches.branch_policies) && source.branches.branch_policies.length === 1
    && source.branches.branch_policies[0].name === 'main' && source.branches.branch_policies[0].type === 'branch');
  const secrets = source.secrets;
  need(secrets.total_count === 2 && Array.isArray(secrets.secrets) && secrets.secrets.length === 2
    && secrets.secrets.every(entry => object(entry) && Object.keys(entry).every(key => ['name', 'created_at', 'updated_at'].includes(key)))
    && same(secrets.secrets.map(entry => entry.name).sort(), secretNames));
  return { version: 1, kind: 'driver-audit-hosted-environment-activation', repository, environment: environmentName,
    ref: 'refs/heads/main', observedAt, metadataSha256: Object.fromEntries(Object.entries(captures).map(([key, bytes]) => [key, sha(bytes)])),
    validationScope: 'offline-metadata-inputs-only', workerArmed: false };
}

async function directory(folder) {
  need(path.isAbsolute(folder) && path.resolve(folder) === folder && await fs.realpath(folder) === folder);
  const info = await fs.lstat(folder, { bigint: true }); need(info.isDirectory() && privateOwner(info));
  return info;
}

async function read(file, maximum, collect = true, observations) {
  const parent = path.dirname(file), parentBefore = await directory(parent);
  need(await fs.realpath(file) === file);
  const before = await fs.lstat(file, { bigint: true });
  need(before.isFile() && privateOwner(before) && before.size <= BigInt(maximum));
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    need(signature(await handle.stat({ bigint: true })) === signature(before));
    const digest = createHash('sha256'), chunks = [], buffer = Buffer.alloc(64 * 1024);
    let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, size); if (!bytesRead) break;
      size += bytesRead; need(size <= maximum); const bytes = buffer.subarray(0, bytesRead); digest.update(bytes);
      if (collect) chunks.push(Buffer.from(bytes));
    }
    need(BigInt(size) === before.size && signature(await handle.stat({ bigint: true })) === signature(before)
      && signature(await fs.lstat(file, { bigint: true })) === signature(before) && await fs.realpath(file) === file
      && signature(await directory(parent)) === signature(parentBefore));
    observations?.push({ file, signature: signature(before), parent, parentSignature: signature(parentBefore) });
    return { sha256: digest.digest('hex'), bytes: size, ...(collect ? { body: Buffer.concat(chunks, size) } : {}) };
  } finally { await handle.close(); }
}

async function tree(root, entries, manifestName, expectedCount, observations) {
  const before = await directory(root), declared = new Map([[manifestName, null]]);
  need(entries.length === expectedCount && entries.length > 0 && entries.length <= 4096);
  let bytes = 0;
  for (const entry of entries) {
    need(relative(entry.path) && hash(entry.sha256) && !declared.has(entry.path)); declared.set(entry.path, entry.sha256);
    const file = await read(path.join(root, entry.path), 128 * 1024 ** 2, false, observations);
    need(file.sha256 === entry.sha256 && (entry.bytes === undefined || entry.bytes === file.bytes));
    bytes += file.bytes; need(bytes <= 512 * 1024 ** 2);
  }
  async function walk(folder) {
    const original = await directory(folder);
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(file);
      else need(entry.isFile() && declared.has(path.relative(root, file).split(path.sep).join('/')));
    }
    need(signature(await directory(folder)) === signature(original));
    observations?.push({ directory: folder, signature: signature(original) });
  }
  await walk(root); need(signature(await directory(root)) === signature(before));
  return { files: entries.length, bytes };
}

export async function preflightDriverAuditHostedBootstrap(input) {
  need(exact(input, ['root', 'syncSha256', 'sourceConfigSha256', 'activationSha256', 'pinsSha256'])
    && [input.syncSha256, input.sourceConfigSha256, input.activationSha256, input.pinsSha256].every(hash));
  const root = input.root, rootBefore = await directory(root);
  const observations = [], checkedRead = (file, maximum, collect = true) => read(file, maximum, collect, observations);
  const pinned = await checkedRead(path.join(root, releasePinsFile), 16 * 1024);
  need(pinned.sha256 === input.pinsSha256); const expected = parse(pinned.body);
  need(exact(expected, [...pinHashes, ...pinCounts, 'nodeVersion']) && pinHashes.every(key => hash(expected[key]))
    && pinCounts.every(key => Number.isSafeInteger(expected[key]) && expected[key] > 0 && expected[key] <= 4096)
    && typeof expected.nodeVersion === 'string' && expected.nodeVersion.length <= 32 && /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(expected.nodeVersion));
  const syncFile = await checkedRead(path.join(root, 'sync.json'), 1024 * 1024); need(syncFile.sha256 === input.syncSha256);
  const sync = parse(syncFile.body);
  need(sync.version === 1 && sync.root === root && sync.codeRoot === path.join(root, 'builder') && sync.baselineRoot === path.join(root, 'baseline')
    && (sync.hostedSlotClaims === undefined || typeof sync.hostedSlotClaims === 'boolean')
    && (sync.incrementalDeliveries === undefined || typeof sync.incrementalDeliveries === 'boolean')
    && sync.builderSha256 === expected.builderSha256
    && sync.rendererBuild?.path === path.join(root, 'baseline/build.private.json') && sync.rendererBuild.sha256 === expected.rendererSha256
    && sync.journals?.path === path.join(root, 'validation-journals.private.json') && sync.journals.sha256 === expected.journalsSha256);
  const sourceRoot = path.join(root, 'collector', expected.sourceManifestSha256), sourceFile = await checkedRead(path.join(sourceRoot, 'source.json'), 1024 * 1024);
  need(sourceFile.sha256 === input.sourceConfigSha256); const source = parse(sourceFile.body);
  need(source.version === 1 && source.root === sourceRoot && source.runtimeRoot === path.join(sourceRoot, 'runtime')
    && source.manifestSha256 === expected.sourceManifestSha256 && source.nodeVersion === expected.nodeVersion
    && typeof source.nodeExecutable === 'string' && path.isAbsolute(source.nodeExecutable) && path.basename(source.nodeExecutable) === 'node'
    && source.environment?.path === path.join(sourceRoot, 'environment.private.json') && hash(source.environment.sha256));
  const manifest = await checkedRead(path.join(source.runtimeRoot, 'manifest.private.json'), 1024 * 1024);
  need(manifest.sha256 === expected.sourceManifestSha256); const runtime = parse(manifest.body);
  need(runtime.schemaVersion === 1 && runtime.managedSourceExecutionHost === 'off-host' && runtime.managedSourceExecutionAdmission === 'fixed-host-v1'
    && Array.isArray(runtime.files) && runtime.files.every(entry => entry.path.startsWith('source/')) && Array.isArray(runtime.entrypoints)
    && routes.every(route => runtime.entrypoints.some(entry => entry.path === route && entry.method === 'GET'
      && entry.exportName === 'default' && entry.timeZone === 'UTC' && entry.maxDurationSeconds > 0 && entry.maxDurationSeconds <= 300)));
  const sourceTree = await tree(source.runtimeRoot, runtime.files, 'manifest.private.json', expected.sourceFiles, observations);
  const builderFile = await checkedRead(path.join(sync.codeRoot, 'runtime-manifest.json'), 1024 * 1024);
  need(builderFile.sha256 === expected.builderSha256); const builder = parse(builderFile.body);
  need(builder.version === 1 && object(builder.files) && hash(builder.files['scripts/run-automatic-report.mjs']));
  const builderTree = await tree(sync.codeRoot, Object.entries(builder.files).map(([file, sha256]) => ({ path: file, sha256 })),
    'runtime-manifest.json', expected.builderFiles, observations);
  const baselineFile = await checkedRead(path.join(sync.baselineRoot, 'files.private.json'), 1024 * 1024);
  need(baselineFile.sha256 === expected.baselineManifestSha256); const baseline = parse(baselineFile.body);
  const baselineTree = await tree(sync.baselineRoot, Object.entries(baseline).map(([file, sha256]) => ({ path: file, sha256 })),
    'files.private.json', expected.baselineFiles, observations);
  need(baseline['build.private.json'] === expected.rendererSha256
    && (await checkedRead(sync.journals.path, 1024 * 1024, false)).sha256 === expected.journalsSha256);
  const environmentFile = await checkedRead(source.environment.path, 1024 * 1024); need(environmentFile.sha256 === source.environment.sha256);
  const env = parse(environmentFile.body);
  need(object(env) && Object.entries(env).every(([key, value]) => /^[A-Z][A-Z0-9_]*$/.test(key)
    && typeof value === 'string' && value.length <= 16384 && !value.includes('\0'))
    && !Object.keys(env).some(key => /MONGO|OIDC|^NODE_OPTIONS$|^NODE_PATH$|^PATH$|^HOME$|^LD_PRELOAD$|^DYLD_INSERT_LIBRARIES$/.test(key))
    && env.DRIVER_AUDIT_EXECUTION_HOST === 'off-host' && env.DRIVER_AUDIT_DATA_STORE === 'supabase'
    && env.MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY === path.join(root, 'work/archive-cache')
    && ['MATTER_DELIVERY_ENABLED', 'MATTER_GPS_ENABLED', 'MATTER_GPS_PUBLICATION_ENABLED', 'MATTER_PHOTO_READ_ENABLED'].every(key => env[key] === '1')
    && ['MATTER_SUPABASE_SECRET', 'MATTER_DELIVERY_API_KEY', 'CRON_SECRET'].every(key => typeof env[key] === 'string'
      && env[key].length > 0 && !/[\r\n]/.test(env[key])) && env.CRON_SECRET.length >= 32
    && ['0', '1'].includes(env.MATTER_PHOTO_GRADE_ENABLED)
    && (source.gatewayCredential == null || exact(source.gatewayCredential, ['environmentKey'])
      && source.gatewayCredential.environmentKey === 'AI_GATEWAY_API_KEY')
    && (env.MATTER_PHOTO_GRADE_ENABLED !== '1' || source.gatewayCredential?.environmentKey === 'AI_GATEWAY_API_KEY'
      && typeof env.AI_GATEWAY_API_KEY === 'string' && env.AI_GATEWAY_API_KEY.length > 0 && !/[\r\n]/.test(env.AI_GATEWAY_API_KEY))
    && runtime.entrypoints.every(entry => Array.isArray(entry.requiredEnvironment)
      && entry.requiredEnvironment.every(key => /^[A-Z][A-Z0-9_]*$/.test(key) && typeof env[key] === 'string' && env[key].length > 0)));
  await directory(env.MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY);
  await fs.access(env.MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY, constants.R_OK | constants.W_OK);
  const recoveryStore = env.DRIVER_AUDIT_PHOTO_RECOVERY_STORE;
  need(recoveryStore === undefined || recoveryStore === 'supabase'
    && env.DRIVER_AUDIT_PHOTO_RECOVERY_DIRECTORY === undefined && sync.hostedSlotClaims === true);
  if (recoveryStore === undefined) {
    need(typeof env.DRIVER_AUDIT_PHOTO_RECOVERY_DIRECTORY === 'string'
      && env.DRIVER_AUDIT_PHOTO_RECOVERY_DIRECTORY !== env.MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY
      && !env.DRIVER_AUDIT_PHOTO_RECOVERY_DIRECTORY.startsWith(env.MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY + path.sep));
    await directory(env.DRIVER_AUDIT_PHOTO_RECOVERY_DIRECTORY);
  }
  const activationFile = await checkedRead(path.join(root, 'hosted-environment-activation.private.json'), 1024 * 1024);
  need(activationFile.sha256 === input.activationSha256); const activation = parse(activationFile.body), captures = {};
  for (const name of ['repository', 'environment', 'branches', 'secrets']) captures[name] = (await checkedRead(path.join(root, 'provisioning', name + '.private.json'), 1024 * 1024)).body;
  need(same(activation, createDriverAuditHostedEnvironmentActivation({ captures, observedAt: activation.observedAt })));
  need((await checkedRead(path.join(root, 'sync.json'), 1024 * 1024)).sha256 === input.syncSha256
    && (await checkedRead(path.join(sourceRoot, 'source.json'), 1024 * 1024)).sha256 === input.sourceConfigSha256
    && signature(await directory(root)) === signature(rootBefore));
  for (const observed of observations) {
    if (observed.directory) need(signature(await directory(observed.directory)) === observed.signature);
    else need(await fs.realpath(observed.file) === observed.file
      && signature(await fs.lstat(observed.file, { bigint: true })) === observed.signature
      && signature(await directory(observed.parent)) === observed.parentSignature);
  }
  return { status: 'hosted-bootstrap-inputs-validated', version: 1, repository, environment: environmentName,
    ref: 'refs/heads/main', schedules: structuredClone(schedules), sourceManifestSha256: expected.sourceManifestSha256,
    builderSha256: expected.builderSha256, baselineManifestSha256: expected.baselineManifestSha256,
    sourceFiles: sourceTree.files, builderFiles: builderTree.files, baselineFiles: baselineTree.files,
    retainedInputBytes: sourceTree.bytes + builderTree.bytes + baselineTree.bytes,
    activationSha256: input.activationSha256, pinsSha256: input.pinsSha256, workerArmed: false, remoteEnvironmentAuthenticated: false,
    hostedSlotClaimsConfigured: sync.hostedSlotClaims === true, photoRecoveryStore: recoveryStore ?? 'private-directory',
    remainingGates: ['authenticated-environment-readback', 'linux-qualification', 'durable-slot-admission',
      'durable-photo-recovery', 'authenticated-cache-checkpoint'],
    networkRequests: 0, databaseWrites: 0 };
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (same(args, ['--plan'])) console.log(JSON.stringify(driverAuditHostedWorkerPlan()));
    else {
      need(args.length === 11 && args[0] === '--validate-inputs' && args[1] === '--root' && args[3] === '--sync-sha'
        && args[5] === '--source-config-sha' && args[7] === '--activation-sha' && args[9] === '--pins-sha');
      console.log(JSON.stringify(await preflightDriverAuditHostedBootstrap({ root: args[2], syncSha256: args[4],
        sourceConfigSha256: args[6], activationSha256: args[8], pinsSha256: args[10] })));
    }
  } catch { console.error('Hosted bootstrap input validation stopped. Private inputs are unchanged.'); process.exitCode = 1; }
}
