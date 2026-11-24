import { createHash, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const driverAuditSourceHash = value => createHash('sha256').update(value).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;
const minuteMs = 60_000;

function requireSource(condition, message) {
  if (!condition) throw new Error(message);
}

export async function readPrivateDriverAuditSource(file, maxBytes = 16 * 1024 * 1024) {
  requireSource(path.isAbsolute(file) && await fs.realpath(file) === file, 'A real private source path is required.');
  const stat = await fs.lstat(file);
  requireSource(stat.isFile() && !(stat.mode & 0o077) && stat.uid === process.getuid() && stat.size <= maxBytes,
    'Source files must be owner-private regular files within the size limit.');
  const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    requireSource(opened.ino === stat.ino && opened.dev === stat.dev, 'Source file changed while reading.');
    const bytes = await handle.readFile();
    requireSource(bytes.length <= maxBytes, 'Source file exceeded its size limit.');
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function requirePrivateDriverAuditSourceDirectory(directory) {
  requireSource(path.isAbsolute(directory) && await fs.realpath(directory) === directory, 'A real private source directory is required.');
  const stat = await fs.lstat(directory);
  requireSource(stat.isDirectory() && !(stat.mode & 0o077) && stat.uid === process.getuid(),
    'Source directories must be owner-private.');
}

export async function writeDriverAuditSourceState(file, state) {
  await requirePrivateDriverAuditSourceDirectory(path.dirname(file));
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(state) + '\n');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    const directory = await fs.open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function safeRelativePath(value) {
  return typeof value === 'string' && value.length <= 1024 && value.split('/').every(part =>
    part !== '.' && part !== '..' && /^[a-zA-Z0-9_.-]+$/.test(part));
}

function parseSchedule(schedule) {
  requireSource(typeof schedule === 'string' && schedule.length <= 64, 'Invalid source schedule.');
  const fields = schedule.split(' ');
  requireSource(fields.length === 5, 'Invalid source schedule.');
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  return fields.map((field, index) => {
    const [minimum, maximum] = ranges[index];
    const values = new Set();
    for (const item of field.split(',')) {
      const match = /^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,2}))?$/.exec(item);
      requireSource(match, 'Invalid source schedule.');
      const step = match[2] === undefined ? 1 : Number(match[2]);
      const bounds = match[1] === '*' ? [minimum, maximum] : match[1].split('-').map(Number);
      const [start, end = match[2] === undefined ? start : maximum] = bounds;
      requireSource(step >= 1 && step <= maximum - minimum + 1 && start >= minimum && end <= maximum && start <= end,
        'Invalid source schedule.');
      for (let value = start; value <= end; value += step) values.add(index === 4 && value === 7 ? 0 : value);
    }
    return { values, wildcard: field.startsWith('*') };
  });
}

export function sourceScheduleMatches(schedule, date) {
  requireSource(date instanceof Date && Number.isFinite(date.getTime()), 'Invalid source schedule time.');
  const fields = parseSchedule(schedule);
  const values = [date.getUTCMinutes(), date.getUTCHours(), date.getUTCDate(), date.getUTCMonth() + 1, date.getUTCDay()];
  const matches = fields.map((field, index) => field.values.has(values[index]));
  const dayMatches = fields[2].wildcard || fields[4].wildcard ? matches[2] && matches[4] : matches[2] || matches[4];
  return matches[0] && matches[1] && matches[3] && dayMatches;
}

export async function verifyDriverAuditSource({ runtimeRoot, expectedSha256 }) {
  requireSource(hashPattern.test(expectedSha256 ?? ''), 'A pinned source manifest is required.');
  await requirePrivateDriverAuditSourceDirectory(runtimeRoot);
  const manifestBytes = await readPrivateDriverAuditSource(path.join(runtimeRoot, 'manifest.private.json'));
  requireSource(driverAuditSourceHash(manifestBytes) === expectedSha256, 'Source manifest integrity failure.');
  const manifest = JSON.parse(manifestBytes);
  requireSource(manifest.schemaVersion === 1 && Array.isArray(manifest.files) && manifest.files.length > 0
    && manifest.files.length <= 4096 && Array.isArray(manifest.entrypoints) && manifest.entrypoints.length > 0
    && manifest.entrypoints.length <= 128, 'Invalid source manifest.');
  const declared = new Set();
  for (const file of manifest.files) {
    requireSource(safeRelativePath(file.path) && file.path.startsWith('source/'), 'Invalid source file path.');
    requireSource(!declared.has(file.path) && hashPattern.test(file.sha256 ?? '')
      && Number.isSafeInteger(file.bytes) && file.bytes >= 0 && file.bytes <= 16 * 1024 * 1024, 'Invalid source file identity.');
    declared.add(file.path);
    const bytes = await readPrivateDriverAuditSource(path.join(runtimeRoot, file.path));
    requireSource(bytes.length === file.bytes && driverAuditSourceHash(bytes) === file.sha256, 'Source file integrity failure.');
  }
  async function checkDirectory(directory) {
    await requirePrivateDriverAuditSourceDirectory(directory);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await checkDirectory(file);
      else requireSource(entry.isFile() && declared.has(path.relative(runtimeRoot, file).split(path.sep).join('/')),
        'Unlisted source file or symlink in runtime.');
    }
  }
  await checkDirectory(path.join(runtimeRoot, 'source'));
  const ids = new Set();
  for (const entry of manifest.entrypoints) {
    requireSource(typeof entry.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(entry.id) && !ids.has(entry.id),
      'Invalid or duplicate source schedule identity.');
    ids.add(entry.id);
    requireSource(declared.has(entry.module) && /\.mjs$/.test(entry.module) && entry.exportName === 'default'
      && entry.method === 'GET' && entry.timeZone === 'UTC' && typeof entry.path === 'string'
      && entry.path.startsWith('/api/') && !entry.path.startsWith('//') && !/[\s#\\]/.test(entry.path)
      && Number.isSafeInteger(entry.maxDurationSeconds) && entry.maxDurationSeconds > 0 && entry.maxDurationSeconds <= 300
      && Array.isArray(entry.requiredEnvironment) && entry.requiredEnvironment.every(key => /^[A-Z][A-Z0-9_]*$/.test(key)),
    'Invalid source schedule handler.');
    parseSchedule(entry.schedule);
  }
  return { ...manifest, manifestSha256: expectedSha256 };
}

async function readPinnedJson(reference, label) {
  requireSource(reference && hashPattern.test(reference.sha256 ?? '') && path.isAbsolute(reference.path ?? ''),
    `A pinned ${label} file is required.`);
  const bytes = await readPrivateDriverAuditSource(reference.path);
  requireSource(driverAuditSourceHash(bytes) === reference.sha256, `${label} integrity failure.`);
  return JSON.parse(bytes);
}

export const DRIVER_AUDIT_SOURCE_CACHE_ENV = 'MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY';
export const DRIVER_AUDIT_SOURCE_EXECUTION_HOST_ENV = 'DRIVER_AUDIT_EXECUTION_HOST';

export function driverAuditSourceExecutionHost(runtime, environment) {
  const host = environment[DRIVER_AUDIT_SOURCE_EXECUTION_HOST_ENV];
  if (host === undefined) return null;
  requireSource(['sidi', 'off-host'].includes(host) && runtime.managedSourceExecutionHost === host
    && runtime.managedSourceExecutionAdmission === 'fixed-host-v1'
    && ['source/integration/hosted/native-backend.mjs', 'source/integration/hosted/archive-read-cache.mjs',
      'source/integration/cloud/native-poll-progress.mjs'].every(relative => runtime.files.some(file => file.path === relative)),
  'The source execution host needs its pinned runtime capability.');
  requireSource(environment.MONGODB_URI === undefined && environment.DRIVER_AUDIT_NATIVE_CAPACITY_BYTES === undefined,
    'Source execution uses the app database configuration.');
  return host;
}

export function driverAuditSourceUsesAppBackend(config) {
  return (config.dataStore ?? config.environment?.DRIVER_AUDIT_DATA_STORE) === 'mongo'
    || ['sidi', 'off-host'].includes(config.executionHost ?? config.environment?.[DRIVER_AUDIT_SOURCE_EXECUTION_HOST_ENV]);
}

export function driverAuditSourceBackendEnvironment(config, appEnvironment = process.env) {
  const environment = { ...appEnvironment, ...config.environment };
  if (['sidi', 'off-host'].includes(config.executionHost) && config.dataStore === 'supabase') {
    const secret = config.environment.MATTER_SUPABASE_SECRET;
    requireSource(typeof secret === 'string' && secret.length > 0 && secret.length <= 8192 && !/[\r\n\0]/.test(secret),
      'The staged Supabase source credential is required.');
    // The private source environment is the qualified identity. An inherited
    // app alias must not select another credential inside this child.
    environment.DRIVER_AUDIT_DATA_STORE = 'supabase';
    environment.DRIVER_AUDIT_SUPABASE_SECRET = secret;
    delete environment.MONGODB_URI;
    delete environment.DRIVER_AUDIT_NATIVE_CAPACITY_BYTES;
  }
  return environment;
}

export function requireDriverAuditSourceBackend(config, backend) {
  requireSource(backend?.kind === config.dataStore && typeof backend.rpc === 'function'
    && typeof backend.archive?.readObject === 'function' && typeof backend.archive?.putVerifiedObject === 'function'
    && typeof backend.createExecutionBudget === 'function', 'The app source backend differs from its qualified store.');
  if (['sidi', 'off-host'].includes(config.executionHost)) {
    requireSource(backend.executionHost === config.executionHost && backend.executionAdmission === 'fixed-host-v1'
      && backend.archive.managedReadCache === true && backend.archiveCacheDirectory === config.archiveCacheDirectory
      && backend.pollProgress?.version === 1 && typeof backend.pollProgress.read === 'function'
      && typeof backend.pollProgress.compareAndSwap === 'function' && backend.transferAccounting === 'supabase-http-bytes-v1'
      && typeof backend.archiveReadBudget?.reserve === 'function' && typeof backend.archiveReadBudget?.settle === 'function'
      && typeof backend.readTransferUsage === 'function', 'The qualified Sidi source capabilities are unavailable.');
  }
  return backend;
}

export function driverAuditSourceDataStore(files, environment) {
  const kind = environment.DRIVER_AUDIT_DATA_STORE || 'supabase';
  requireSource(['supabase', 'mongo'].includes(kind), 'Unknown source reporting data store.');
  if (kind === 'mongo') {
    requireSource(files.some(file => file.path === 'source/integration/hosted/native-backend.mjs'),
      'The source runtime does not support the app native data store.');
    requireSource(environment.MONGODB_URI === undefined && environment.DRIVER_AUDIT_NATIVE_CAPACITY_BYTES === undefined,
      'Native source jobs use the app database connection and storage allowance.');
  }
  return kind;
}

export function driverAuditSourceArchiveCacheDirectory(root, files, environment) {
  const directory = environment[DRIVER_AUDIT_SOURCE_CACHE_ENV];
  const supportsCache = files.some(file => file.path === 'source/integration/hosted/archive-read-cache.mjs');
  if (!supportsCache && directory === undefined) return null;
  const privateRoot = path.dirname(path.dirname(root));
  if (environment[DRIVER_AUDIT_SOURCE_EXECUTION_HOST_ENV] === 'off-host') {
    requireSource(supportsCache && directory === path.join(privateRoot, 'work', 'archive-cache'),
      'Use the off-host builder archive cache directory.');
    return directory;
  }
  const parts = typeof directory === 'string' && path.isAbsolute(directory)
    ? path.relative(privateRoot, directory).split(path.sep) : [];
  requireSource(supportsCache && parts.length === 4 && parts[0] === 'driver-audits'
    && hashPattern.test(parts[1]) && parts[2] === 'work' && parts[3] === 'archive-cache'
    && directory === path.join(privateRoot, ...parts), 'Use the managed builder archive cache directory.');
  return directory;
}

export async function readDriverAuditSourceConfig(file) {
  const bytes = await readPrivateDriverAuditSource(file);
  const config = JSON.parse(bytes);
  requireSource(config.version === 1 && path.dirname(file) === config.root && path.basename(file) === 'source.json'
    && config.runtimeRoot === path.join(config.root, 'runtime') && config.nodeVersion === process.version,
  'Source configuration or the qualified Node version changed.');
  requireSource(typeof config.nodeExecutable === 'string' && path.isAbsolute(config.nodeExecutable),
    'An exact source Node executable is required.');
  let actualExecutable;
  try { actualExecutable = await fs.realpath(config.nodeExecutable); } catch { throw new Error('The qualified Node executable is unavailable.'); }
  requireSource(actualExecutable === await fs.realpath(process.execPath), 'Source Node executable differs from the qualified path.');
  await requirePrivateDriverAuditSourceDirectory(config.root);
  const runtime = await verifyDriverAuditSource({ runtimeRoot: config.runtimeRoot, expectedSha256: config.manifestSha256 });
  const environment = await readPinnedJson(config.environment, 'source environment');
  requireSource(environment && typeof environment === 'object' && !Array.isArray(environment)
    && Object.entries(environment).every(([key, value]) => /^[A-Z][A-Z0-9_]*$/.test(key)
      && typeof value === 'string' && value.length <= 16384 && !value.includes('\0')),
  'Invalid source environment.');
  const archiveCacheDirectory = driverAuditSourceArchiveCacheDirectory(config.root, runtime.files, environment);
  const dataStore = driverAuditSourceDataStore(runtime.files, environment);
  const executionHost = driverAuditSourceExecutionHost(runtime, environment);
  requireSource(executionHost === null || archiveCacheDirectory, 'Managed source execution requires its archive cache.');
  // Runtime configuration contains source credentials only. Node loader and
  // process options remain controlled by the app's supervised runner.
  requireSource(!Object.keys(environment).some(key => ['NODE_OPTIONS', 'NODE_PATH', 'PATH', 'HOME', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES'].includes(key)),
    'Source environment contains process configuration.');
  requireSource(!Object.keys(environment).some(key => key.includes('OIDC')), 'Stored OIDC credentials are not accepted.');
  requireSource(typeof environment.CRON_SECRET === 'string' && environment.CRON_SECRET.length >= 32,
    'Source worker authentication is required.');
  for (const entry of runtime.entrypoints) {
    requireSource(entry.requiredEnvironment.every(key => typeof environment[key] === 'string' && environment[key].length > 0),
      'Source environment is missing a declared value.');
  }
  const switches = ['MATTER_DELIVERY_ENABLED', 'MATTER_PHOTO_READ_ENABLED', 'MATTER_PHOTO_GRADE_ENABLED', 'MATTER_GPS_ENABLED', 'MATTER_GPS_PUBLICATION_ENABLED'];
  requireSource(switches.every(key => environment[key] === undefined || ['0', '1'].includes(environment[key])), 'Invalid source switch value.');
  let gatewayCredential = null;
  if (config.gatewayCredential !== null && config.gatewayCredential !== undefined) {
    requireSource(config.gatewayCredential.environmentKey === 'AI_GATEWAY_API_KEY'
      && typeof environment.AI_GATEWAY_API_KEY === 'string' && environment.AI_GATEWAY_API_KEY.length > 0,
    'A private Gateway API key is required.');
    gatewayCredential = environment.AI_GATEWAY_API_KEY;
  }
  requireSource(environment.MATTER_PHOTO_GRADE_ENABLED !== '1' || gatewayCredential,
    'Enabled photo grading requires a qualified Gateway credential.');
  return { ...config, file, configSha256: driverAuditSourceHash(bytes), runtime,
    environmentReference: config.environment, environment, gatewayCredential, archiveCacheDirectory, dataStore, executionHost };
}

const capabilityFenceMode = 'reporting-database-capability-v1';
const twoPhaseFenceMode = 'reporting-database-capability-v2';
const hostingAdmissionFenceMode = 'reporting-hosting-admission-v1';
const originalReportingProject = 'trhhjfgfmxofxhnzocks';
const proofId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const fingerprintNames = ['documents', 'receipts', 'archive', 'reservations', 'roadCache', 'capabilities'];
const mutatorSignatures = [
  'archive_consume(uuid,uuid,bigint)', 'archive_consume(uuid,uuid,bigint,text)', 'archive_release(uuid)',
  'archive_reserve(uuid,bigint)', 'collector_cas(uuid,bigint,bigint,text,text,text,text)',
  'collector_cas_review(uuid,bigint,bigint,bigint,text,text,text,text)', 'lease_acquire(uuid,integer)',
  'lease_release(uuid,bigint)', 'qualification_cas(uuid,bigint,bigint,text,text,text,text)',
  'qualification_lease_acquire(uuid,integer)', 'qualification_lease_release(uuid,bigint)',
  'state_cas(text,bigint,text,text,text,text)',
];
const fencedFunctions = new Set([
  ...mutatorSignatures.map(name => 'matter_reporting_hosted.' + name),
  ...mutatorSignatures.map(name => 'public.matter_hosted_' + name),
  'public.matter_hosted_gps_retention_register(jsonb,jsonb,jsonb)',
  'public.matter_hosted_preview_road_cache(text,text,uuid,jsonb)',
]);
const ownerOnlyFunctions = new Set(['matter_reporting_hosted.state_cas_internal(text,bigint,text,text,text,text)',
  'matter_reporting_hosted.deny_receipt_change()', 'matter_reporting_hosted.gps_retention_watch()']);
const catalogFunctions = new Set([...fencedFunctions,
  ...['archive_capacity(bigint)', 'deny_receipt_change()', 'gps_retention_watch()', 'lease_assert(uuid,bigint)',
    'membership_lookup(uuid)', 'membership_provision(uuid,text,boolean,bigint,text,text)',
    'qualification_lease_assert(uuid,bigint)', 'session_active(uuid,uuid)', 'state_cas_internal(text,bigint,text,text,text,text)',
    'state_read(text)', 'state_receipts(text,bigint,integer)'].map(name => 'matter_reporting_hosted.' + name),
  ...['archive_capacity(bigint)', 'gps_retention_inventory(text)', 'lease_assert(uuid,bigint)', 'membership_lookup(uuid)',
    'membership_provision(uuid,text,boolean,bigint,text,text)', 'qualification_lease_assert(uuid,bigint)',
    'session_active(uuid,uuid)', 'state_read(text)', 'state_read_if_changed(text,bigint)', 'state_receipts(text,bigint,integer)']
    .map(name => 'public.matter_hosted_' + name),
]);

// Canonical function-only catalogs bind both real transitions independently of
// observation clocks, JSON key order and unrelated source metadata.
export function driverAuditReportingFunctionCatalogSha256(rows) {
  requireSource(Array.isArray(rows) && rows.length === catalogFunctions.size, 'An exact reporting function catalog is required.');
  const seen = new Set();
  const projected = rows.map(row => {
    requireSource(catalogFunctions.has(row?.identity) && !seen.has(row.identity) && row.owner === 'postgres'
      && hashPattern.test(row.definitionSha256 ?? '') && hashPattern.test(row.aclSha256 ?? '')
      && Array.isArray(row.apiExecutableRoles) && new Set(row.apiExecutableRoles).size === row.apiExecutableRoles.length
      && row.apiExecutableRoles.every(role => ['PUBLIC', 'anon', 'authenticated', 'service_role'].includes(role)),
    'Reporting function catalog identity or execution scope differs.');
    seen.add(row.identity);
    return { identity: row.identity, owner: row.owner, definitionSha256: row.definitionSha256,
      aclSha256: row.aclSha256, apiExecutableRoles: [...row.apiExecutableRoles].sort() };
  }).sort((left, right) => left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0);
  return driverAuditSourceHash(JSON.stringify(projected));
}

export function driverAuditHostingAppRpcCatalogSha256(rows) {
  const identities = new Set(['progress_read(text)', 'progress_cas(text,uuid,bigint,bigint,text,text,text,text)',
    'photo_alias_read(text)', 'photo_alias_register(text,jsonb)', 'read_egress_read()',
    'read_egress_reserve(uuid,bigint,bigint)', 'read_egress_settle(uuid,bigint,bigint)']
    .map(signature => 'public.matter_hosted_app_' + signature));
  requireSource(Array.isArray(rows) && rows.length === identities.size, 'The exact hosting app RPC catalog is required.');
  const projected = rows.map(row => {
    requireSource(identities.delete(row?.identity) && row.owner === 'postgres'
      && hashPattern.test(row.definitionSha256 ?? '') && hashPattern.test(row.aclSha256 ?? '')
      && Array.isArray(row.apiExecutableRoles) && row.apiExecutableRoles.length === 1
      && row.apiExecutableRoles[0] === 'service_role', 'The hosting app RPC execution scope differs.');
    return { identity: row.identity, owner: row.owner, definitionSha256: row.definitionSha256,
      aclSha256: row.aclSha256, apiExecutableRoles: ['service_role'] };
  }).sort((left, right) => left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0);
  return driverAuditSourceHash(JSON.stringify(projected));
}

export function driverAuditHostingAppHelperCatalogSha256(rows) {
  const identities = new Set(['compact_json(json,integer)', 'deny_alias_change()', 'egress_summary(timestamp with time zone)',
    'matches_schema(jsonb,jsonb)', 'progress_schema(boolean)', 'prune_egress(timestamp with time zone)',
    'valid_alias(text,jsonb)', 'valid_key(text)', 'valid_scalar(jsonb,text,integer)', 'validate_progress(text,text)',
    'validation_progress_schema()'].map(signature => 'matter_reporting_app.' + signature));
  requireSource(Array.isArray(rows) && rows.length === identities.size, 'The exact hosting app helper catalog is required.');
  const projected = rows.map(row => {
    requireSource(identities.delete(row?.identity) && row.owner === 'postgres'
      && hashPattern.test(row.definitionSha256 ?? '') && hashPattern.test(row.aclSha256 ?? '')
      && Array.isArray(row.apiExecutableRoles) && row.apiExecutableRoles.length === 0,
    'The hosting app helper execution scope differs.');
    return { identity: row.identity, owner: row.owner, definitionSha256: row.definitionSha256,
      aclSha256: row.aclSha256, apiExecutableRoles: [] };
  }).sort((left, right) => left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0);
  return driverAuditSourceHash(JSON.stringify(projected));
}

function sourceReceiptReference(saved, directory) {
  return typeof saved?.path === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}\.private\.json$/.test(saved.path)
    ? { ...saved, path: path.join(directory, saved.path) } : saved;
}

function sameFingerprints(left, right) {
  return fingerprintNames.every(name => hashPattern.test(left?.[name] ?? '') && left[name] === right?.[name]);
}

function retainedUncertainAttempts(value, baseline) {
  return value?.beforeCount === baseline.count && value.afterCount === baseline.count
    && value.beforeSha256 === baseline.sha256 && value.afterSha256 === baseline.sha256;
}

function embeddedPhaseReceipt(reference, expectedSha256) {
  requireSource(hashPattern.test(reference?.sha256 ?? '') && reference.sha256 === expectedSha256
    && typeof reference.dataBase64 === 'string' && reference.dataBase64.length <= 1400000,
  'The exact embedded phase receipt is required.');
  const bytes = Buffer.from(reference.dataBase64, 'base64');
  requireSource(bytes.length > 0 && bytes.length <= 1024 * 1024 && bytes.toString('base64') === reference.dataBase64
    && driverAuditSourceHash(bytes) === reference.sha256, 'Embedded phase receipt integrity differs.');
  const value = JSON.parse(bytes);
  requireSource(value && typeof value === 'object' && !Array.isArray(value), 'An embedded phase receipt object is required.');
  return value;
}

// Supabase stays writable. This closes only the reviewed old hosting budget
// admission path; it is deliberately distinct from the native mutation fence.
async function verifyHostingAdmissionFence(config, fence, release, receipts, directory, verifiedAt, expires, nowMs) {
  const blockedAt = Date.parse(fence.admissionBlockedAt), checkedAt = Date.parse(fence.checkedAt);
  const baseline = receipts.backup.uncertainAttemptsBaseline;
  const guardIdentity = 'matter_reporting_hosted.state_cas_internal(text,bigint,text,text,text,text)';
  const exact = (actual, expected) => Array.isArray(actual) && actual.length === expected.length
    && new Set(actual).size === actual.length && expected.every(item => actual.includes(item));
  requireSource(config.dataStore === 'supabase' && config.executionHost === 'sidi'
    && fence.sourceProjectRef === originalReportingProject && proofId(fence.id)
    && fence.writersStopped === false && fence.processesStopped !== true && fence.oldHostingAdmissionsFenced === true
    && fence.sharedReportingRpcWritesUsable === true
    && ['legacyRuntimeSha256', 'legacyEntrypointsSha256', 'hostingAdmissionReceiptSha256', 'hostingAdmissionGraphSha256',
      'appRpcCatalogSha256', 'appHelperCatalogSha256',
      'hostingAdmissionSqlSha256', 'hostingGuardDefinitionSha256'].every(name => hashPattern.test(fence[name] ?? ''))
    && Number.isFinite(blockedAt) && Number.isFinite(checkedAt) && blockedAt <= checkedAt && checkedAt <= verifiedAt
    && nowMs - checkedAt <= 30 * minuteMs && expires <= blockedAt + 30 * minuteMs
    && Date.parse(fence.validUntil) >= expires && Date.parse(fence.validUntil) <= blockedAt + 30 * minuteMs
    && fence.initialCursor === release.initialCursor && Date.parse(release.initialCursor) <= blockedAt,
  'The Supabase hosting admission fence scope or fresh window differs.');
  requireSource(Number.isSafeInteger(baseline?.count) && baseline.count >= 0 && hashPattern.test(baseline.sha256 ?? '')
    && hashPattern.test(baseline.subsetSha256 ?? '')
    && proofId(baseline.snapshotId) && hashPattern.test(baseline.sourceSnapshotSha256 ?? '')
    && hashPattern.test(baseline.restoreVerificationSha256 ?? ''), 'The restored hosting uncertain-attempt baseline is required.');
  const proofs = {}, ids = new Set([fence.id]), hashes = new Set(), paths = new Set();
  for (const [name, kind] of [['capabilityAudit', 'reporting-hosting-admission-audit'], ['drainAudit', 'reporting-hosting-drain-audit'],
    ['quietAudit', 'reporting-hosting-quiet-window'], ['checkpoint', 'reporting-final-checkpoint']]) {
    const ref = sourceReceiptReference(fence[name], directory);
    requireSource(proofId(ref?.id) && !ids.has(ref.id) && !hashes.has(ref.sha256) && !paths.has(ref.path),
      'Independent pinned hosting admission proofs are required.');
    ids.add(ref.id); hashes.add(ref.sha256); paths.add(ref.path);
    const proof = await readPinnedJson(ref, 'hosting ' + name), at = Date.parse(proof.checkedAt);
    requireSource(proof.version === 1 && proof.verified === true && proof.id === ref.id && proof.kind === kind
      && ['sourceProjectRef', 'legacyRuntimeSha256', 'legacyEntrypointsSha256', 'admissionBlockedAt']
        .every(key => proof[key] === fence[key]) && Number.isFinite(at) && at >= blockedAt && at <= checkedAt,
    'Hosting admission proof identity or origin clock differs.');
    proofs[name] = proof;
  }
  const { capabilityAudit: audit, drainAudit: drain, quietAudit: quiet, checkpoint } = proofs;
  const graph = embeddedPhaseReceipt(audit.admissionGraph, fence.hostingAdmissionGraphSha256);
  const handlerModules = ['collector', 'index', 'morning-gps', 'private-validation', 'qualify-publication', 'qualify']
    .map(name => 'source/api/' + name + '.mjs');
  const direct = [
    ...['/api/collector', '/api/collector?task=auto', '/api/collector?verify=1', '/api/collector?verify=photo']
      .map(route => ['source/api/collector.mjs', 'GET', route, 'worker-or-reader-budget-before-operation']),
    ['source/api/qualify.mjs', 'POST', '/api/qualify', 'worker-budget-before-qualification'],
    ['source/api/qualify-publication.mjs', 'POST', '/api/qualify-publication', 'permanently-closed-503'],
    ...['delivery-identities', 'fresh-run', 'api-refresh', 'reviews/migrate'].map(name =>
      ['source/api/index.mjs', 'POST', '/api/reporting/' + name, 'reader-budget-before-service-initialization']),
    ['source/api/index.mjs', 'POST', '/api/reporting/reviews', 'intentionally-preserved-human-review-write'],
  ].map(row => JSON.stringify(row));
  const local = graph.localFixture;
  requireSource(graph.version === 1 && graph.kind === 'legacy-hosting-admission-review' && graph.verified === true
    && ['sourceProjectRef', 'legacyRuntimeSha256', 'legacyEntrypointsSha256'].every(key => graph[key] === fence[key])
    && graph.coveredEntrypoints === 13 && graph.maximumRuntimeMs === 300000 && graph.graceMs === 60000
    && graph.allProviderNetworkRequiresCommittedAdmission === true && graph.paidModelCallsAdditionallyRequireUniquePaidAttempt === true
    && graph.gradeResultDurableBeforePaidSettlement === true && graph.sharedHumanReviewWritesRemainAllowed === true
    && graph.actualWorkDrainedByThisReview === false && graph.cronProcessesStopped === false && graph.allDatabaseWritesFenced === false
    && graph.paidLedgerFrozen === false && graph.productionSqlExecuted === false && graph.sourceMutations === 0
    && Array.isArray(graph.entrypoints) && graph.entrypoints.length === 13
    && JSON.stringify(graph.entrypoints) === JSON.stringify(config.runtime?.entrypoints)
    && Array.isArray(graph.requestHandlers) && exact(graph.requestHandlers.map(row => row.module), handlerModules)
    && graph.requestHandlers.every(row => row.exportName === 'default' && row.maxDurationSeconds === 300)
    && Array.isArray(graph.directPaths) && exact(graph.directPaths.map(row => JSON.stringify([row.module, row.method, row.path, row.admission])), direct)
    && Array.isArray(graph.originalFiles) && graph.originalFiles.length === 131
    && new Set(graph.originalFiles.map(row => row.path)).size === 131
    && graph.originalFiles.every(row => safeRelativePath(row.path) && row.path.startsWith('source/')
      && Number.isSafeInteger(row.bytes) && row.bytes >= 0 && row.bytes <= 16 * 1024 ** 2 && hashPattern.test(row.sha256 ?? ''))
    && hashPattern.test(local?.fixtureSha256 ?? '') && hashPattern.test(local.logSha256 ?? '')
    && Number.isSafeInteger(local.groups) && local.groups >= 5 && local.scheduleCases === 13 && local.manualAndPreviewCases === 11
    && local.sourceCalls === 0 && local.providerCalls === 0 && local.actualDatabaseCalls === 0,
  'The complete original hosting admission graph and preserved human-write scope are required.');
  const origin = embeddedPhaseReceipt(audit.hostingAdmissionReceipt, fence.hostingAdmissionReceiptSha256);
  const appCatalogSha256 = driverAuditHostingAppRpcCatalogSha256(origin.appRpcFunctions);
  requireSource([fence.appRpcCatalogSha256, audit.appRpcCatalogSha256, origin.appRpcCatalogSha256,
    origin.beforeAppRpcCatalogSha256, origin.afterAppRpcCatalogSha256].every(value => value === appCatalogSha256),
  'The independently pinned hosting app RPC catalog changed.');
  const appHelperCatalogSha256 = driverAuditHostingAppHelperCatalogSha256(origin.appHelperFunctions);
  requireSource([fence.appHelperCatalogSha256, audit.appHelperCatalogSha256, origin.appHelperCatalogSha256,
    origin.beforeAppHelperCatalogSha256, origin.afterAppHelperCatalogSha256].every(value => value === appHelperCatalogSha256),
  'The independently pinned hosting app helper catalog changed.');
  requireSource(hashPattern.test(origin.afterHostingControlSha256 ?? '')
    && audit.hostingControlSha256 === origin.afterHostingControlSha256,
  'The actual hosting control observation differs from its committed origin.');
  const beforeCommit = Date.parse(origin.commitBeforeAt), afterCommit = Date.parse(origin.commitAfterAt);
  const beforeObservation = Date.parse(origin.beforeObservationAt), afterObservation = Date.parse(origin.afterObservationAt);
  requireSource(origin.version === 1 && origin.verified === true && origin.kind === 'reporting-hosting-admission-origin-v1'
    && origin.sourceProjectRef === fence.sourceProjectRef && proofId(origin.executionId)
    && /^[1-9]\d{0,19}$/.test(origin.transactionId ?? '') && Number.isSafeInteger(origin.backendPid) && origin.backendPid > 0
    && origin.sqlSha256 === fence.hostingAdmissionSqlSha256 && origin.guardFunctionIdentity === guardIdentity
    && origin.hostingGuardDefinitionSha256 === fence.hostingGuardDefinitionSha256
    && ['legacyRuntimeSha256', 'legacyEntrypointsSha256', 'admissionBlockedAt'].every(key => origin[key] === fence[key])
    && origin.admissionBlockedAt === origin.commitBeforeAt && beforeCommit === blockedAt
    && Number.isFinite(beforeObservation) && Number.isFinite(afterCommit) && Number.isFinite(afterObservation)
    && beforeObservation <= beforeCommit && beforeCommit <= afterCommit && afterCommit - beforeCommit <= 180_000
    && afterObservation >= afterCommit && afterObservation <= Date.parse(audit.checkedAt)
    && hashPattern.test(origin.beforeObservationSha256 ?? '') && hashPattern.test(origin.afterObservationSha256 ?? '')
    && origin.beforeObservationSha256 !== origin.afterObservationSha256
    && origin.applied === true && origin.alreadyClosed === false && origin.reapplied === false
    && origin.oldHostingAdmissionsFenced === true && origin.sharedReportingRpcWritesUsable === true
    && origin.paidGradingPolicyUnchanged === true && origin.originalRolesSchemasRelationsAndGallaboxPreserved === true
    && origin.hostingBudgetPolicyCount === 11 && exact(origin.cronJobsDisabled, [4, 5]),
  'The exact one-time hosting admission SQL origin is required.');
  requireSource(exact(audit.apiRoles, ['PUBLIC', 'anon', 'authenticated', 'service_role'])
    && exact(audit.ownerBypassRoles, ['postgres', 'supabase_admin']) && hashPattern.test(audit.roleMembershipSha256 ?? '')
    && audit.serviceRoleCannotAssumeOwner === true && audit.rawStorageAndGatewayRevoked === false
    && audit.oldHostingAdmissionsFenced === true && audit.sharedReportingRpcWritesUsable === true
    && audit.paidGradingPolicyUnchanged === true && hashPattern.test(audit.unrelatedBeforeSha256 ?? '')
    && audit.unrelatedBeforeSha256 === audit.unrelatedAfterSha256, 'Hosting admission permissions or unrelated scope differ.');
  const afterCatalog = driverAuditReportingFunctionCatalogSha256(audit.functions);
  const beforeCatalog = driverAuditReportingFunctionCatalogSha256(audit.functions.map(row => ({ ...row,
    definitionSha256: row.beforeDefinitionSha256, aclSha256: row.beforeAclSha256, apiExecutableRoles: row.beforeApiExecutableRoles })));
  requireSource(beforeCatalog === audit.baselineCatalogSha256 && beforeCatalog === origin.beforeCatalogSha256
    && afterCatalog === origin.afterCatalogSha256 && afterCatalog === driverAuditReportingFunctionCatalogSha256(origin.functions)
    && audit.functions.every(row => row.aclSha256 === row.beforeAclSha256
      && exact(row.apiExecutableRoles, row.beforeApiExecutableRoles)
      && (!ownerOnlyFunctions.has(row.identity) || row.apiExecutableRoles.length === 0)
      && (row.identity === guardIdentity
        ? row.beforeDefinitionSha256 === origin.originalInternalDefinitionSha256
          && row.definitionSha256 === fence.hostingGuardDefinitionSha256 && row.definitionSha256 !== row.beforeDefinitionSha256
        : row.definitionSha256 === row.beforeDefinitionSha256))
    && Array.isArray(audit.sqlCron) && exact(audit.sqlCron.map(row => row.id), [4, 5])
    && audit.sqlCron.every(row => row.active === false && row.owner === 'postgres'
      && hashPattern.test(row.beforeCommandSha256 ?? '') && row.commandSha256 === row.beforeCommandSha256),
  'The hosting admission catalog must preserve every shared RPC permission and unrelated definition.');
  const retained = value => value?.scope === 'baseline-subset'
    && retainedUncertainAttempts(value, { ...baseline, sha256: baseline.subsetSha256 })
    && ['beforeTotalCount', 'afterTotalCount'].every(name => Number.isSafeInteger(value[name]) && value[name] >= baseline.count);
  const drainAt = Date.parse(drain.checkedAt);
  requireSource(drainAt >= afterCommit + 360_000 && ['activeLeases', 'activeReportingTransactions', 'activeSqlCronRuns',
    'activeProviderWork', 'privilegedReportingWriters', 'possibleReportingHttpQueue'].every(name => drain[name] === 0)
    && drain.admissionGraphSha256 === fence.hostingAdmissionGraphSha256
    && drain.hostingAdmissionReceiptSha256 === fence.hostingAdmissionReceiptSha256
    && drain.hostingControlSha256 === audit.hostingControlSha256 && hashPattern.test(drain.ownerAuditSha256 ?? '')
    && retained(drain.uncertainAttempts), 'Hosting admission requires a full provider drain and preserved uncertain subset.');
  requireSource(Array.isArray(quiet.samples) && quiet.samples.length === 2, 'Independent hosting quiet samples are required.');
  const [start, end] = quiet.samples, from = Date.parse(start?.at), to = Date.parse(end?.at);
  const sameHosting = (left, right) => ['hostingLedgers', 'admissionGraph', 'providerWork', 'leases']
    .every(name => hashPattern.test(left?.[name] ?? '') && left[name] === right?.[name]);
  requireSource(proofId(start?.id) && proofId(end?.id) && start.id !== end.id
    && hashPattern.test(start.sha256 ?? '') && hashPattern.test(end.sha256 ?? '') && start.sha256 !== end.sha256
    && Number.isFinite(from) && Number.isFinite(to) && from >= drainAt && to - from >= 5 * minuteMs
    && to - from <= 30 * minuteMs && to <= Date.parse(quiet.checkedAt)
    && to <= checkedAt && sameHosting(start.fingerprints, end.fingerprints)
    && quiet.admissionGraphSha256 === fence.hostingAdmissionGraphSha256
    && quiet.hostingAdmissionReceiptSha256 === fence.hostingAdmissionReceiptSha256
    && quiet.drainAuditSha256 === fence.drainAudit.sha256
    && end.fingerprints.admissionGraph === audit.hostingControlSha256,
  'Hosting admission needs a quiet old-host work graph after the drain.');
  const capture = Date.parse(checkpoint.capturedAt), readback = checkpoint.sourceReadback;
  requireSource(capture >= to && nowMs - capture <= 30 * minuteMs && capture <= Date.parse(checkpoint.checkedAt)
    && checkpoint.snapshotId === baseline.snapshotId && checkpoint.sourceSnapshotSha256 === baseline.sourceSnapshotSha256
    && checkpoint.restoreVerificationSha256 === baseline.restoreVerificationSha256
    && checkpoint.backupReceiptSha256 === release.backup.sha256 && checkpoint.parityReceiptSha256 === release.parity.sha256
    && checkpoint.initialCursor === release.initialCursor && retained(checkpoint.uncertainAttempts)
    && sameHosting(checkpoint.hostingFingerprints, end.fingerprints)
    && Number.isFinite(Date.parse(readback?.checkedAt)) && Date.parse(readback.checkedAt) >= capture
    && Date.parse(readback.checkedAt) <= Date.parse(checkpoint.checkedAt)
    && Number.isSafeInteger(checkpoint.collectorRevision) && checkpoint.collectorRevision > 0
    && Number.isSafeInteger(checkpoint.reviewRevision) && checkpoint.reviewRevision >= 0
    && ['collectorRevision', 'reviewRevision', 'collectorBodySha256', 'reviewBodySha256'].every(key =>
      checkpoint[key] === readback[key] && checkpoint[key] === receipts.parity[key])
    && ['collectorBodySha256', 'reviewBodySha256'].every(key => hashPattern.test(checkpoint[key] ?? '')),
  'The hosting checkpoint needs the fresh restored backup and exact latest shared source heads.');
  requireSource(receipts.parity.kind === 'supabase-sidi-source-parity-v1' && receipts.parity.dataStore === 'supabase'
    && receipts.parity.configSha256 === config.configSha256 && receipts.parity.runtimeManifestSha256 === config.manifestSha256
    && receipts.parity.environmentSha256 === config.environmentReference.sha256
    && hashPattern.test(receipts.parity.hostQualification?.fixtureSha256 ?? '')
    && hashPattern.test(receipts.parity.hostQualification?.receiptSha256 ?? ''), 'The exact Supabase source parity is required.');
  const credentials = receipts.credentials, evidenceReference = sourceReceiptReference(credentials.evidence, directory);
  requireSource(credentials.environmentSha256 === config.environmentReference.sha256
    && evidenceReference?.sha256 === credentials.evidenceSha256, 'The hosting credential environment differs.');
  const evidence = await readPinnedJson(evidenceReference, 'hosting credential evidence');
  requireSource(evidence.version === 1 && evidence.verified === true && evidence.environmentSha256 === credentials.environmentSha256,
    'The exact qualified Supabase credential evidence is required.');
}

function verifyTwoPhaseOrigins(capabilities, fence, baseline, finalDrain) {
  const phase1 = embeddedPhaseReceipt(capabilities.phase1Receipt, fence.phase1ReceiptSha256);
  const phase2 = embeddedPhaseReceipt(capabilities.phase2Receipt, fence.phase2ReceiptSha256);
  const kinds = ['provider-admission-fence-phase1', 'reporting-data-write-fence-phase2'];
  for (const [index, phase] of [phase1, phase2].entries()) {
    const before = Date.parse(phase.commitBeforeAt), after = Date.parse(phase.commitAfterAt);
    const observedBefore = Date.parse(phase.beforeObservationAt), observedAfter = Date.parse(phase.afterObservationAt);
    requireSource(phase.version === 1 && phase.verified === true && phase.kind === kinds[index]
      && phase.sourceProjectRef === fence.sourceProjectRef && proofId(phase.executionId)
      && phase.legacyRuntimeSha256 === fence.legacyRuntimeSha256 && phase.legacyEntrypointsSha256 === fence.legacyEntrypointsSha256
      && hashPattern.test(phase.sqlSha256 ?? '') && /^[1-9][0-9]{0,30}$/.test(phase.transactionId ?? '')
      && Number.isSafeInteger(phase.backendPid) && phase.backendPid > 0
      && phase.applied === true && phase.alreadyClosed === false && phase.reapplied === false
      && [before, after, observedBefore, observedAfter].every(Number.isFinite)
      && observedBefore <= before && before <= after && after - before <= 3 * minuteMs
      && after <= observedAfter && observedAfter <= Date.parse(capabilities.checkedAt)
      && hashPattern.test(phase.beforeObservationSha256 ?? '') && hashPattern.test(phase.afterObservationSha256 ?? '')
      && phase.beforeObservationSha256 !== phase.afterObservationSha256
      && hashPattern.test(phase.beforeCatalogSha256 ?? '') && hashPattern.test(phase.afterCatalogSha256 ?? '')
      && phase.beforeCatalogSha256 !== phase.afterCatalogSha256,
    'The real one-time phase transition or commit interval differs.');
  }
  const original = capabilities.functions.map(row => ({ identity: row.identity, owner: row.owner,
    definitionSha256: row.beforeDefinitionSha256, aclSha256: row.beforeAclSha256, apiExecutableRoles: row.beforeApiExecutableRoles }));
  const internal = original.find(row => row.identity.startsWith('matter_reporting_hosted.state_cas_internal('));
  requireSource(phase1.executionId !== phase2.executionId && phase1.transactionId !== phase2.transactionId
    && fence.phase1ReceiptSha256 !== fence.phase2ReceiptSha256
    && phase1.admissionBlockedAt === fence.admissionBlockedAt && phase1.commitAfterAt === fence.admissionBlockedAt
    && phase1.baselineCatalogSha256 === capabilities.baselineCatalogSha256
    && phase1.beforeCatalogSha256 === driverAuditReportingFunctionCatalogSha256(original)
    && hashPattern.test(phase1.internalDefinitionSha256 ?? '') && phase1.internalDefinitionSha256 !== internal.definitionSha256
    && phase1.afterCatalogSha256 === driverAuditReportingFunctionCatalogSha256(phase1.functions)
    && phase1.providerAdmissionsBlocked === true && phase1.downstreamSettlementsPreserved === true
    && phase1.all11ProviderBudgetPoliciesGuarded === true && phase1.originalRoleSchemaRoadAndGallaboxControlsPreserved === true
    && Array.isArray(phase1.cronJobsDisabled)
    && phase1.cronJobsDisabled.length === 2 && [4, 5].every(id => phase1.cronJobsDisabled.includes(id)),
  'The original phase1 admission identity or guarded catalog differs.');
  for (const row of phase1.functions) {
    const old = original.find(item => item.identity === row.identity);
    requireSource(row.definitionSha256 === (row.identity === internal.identity ? phase1.internalDefinitionSha256 : old.definitionSha256)
      && row.aclSha256 === old.aclSha256 && JSON.stringify([...row.apiExecutableRoles].sort()) === JSON.stringify([...old.apiExecutableRoles].sort()),
    'The phase1 catalog changes more than the reviewed admission guard.');
  }
  const drain = phase2.prePhase2Drain, beforeClosure = Date.parse(phase2.commitBeforeAt);
  requireSource(phase2.phase1ReceiptSha256 === fence.phase1ReceiptSha256 && phase2.phase1ExecutionId === phase1.executionId
    && phase2.phase1SQLSha256 === phase1.sqlSha256 && phase2.admissionBlockedAt === fence.admissionBlockedAt
    && phase2.dataWritesBlockedAt === fence.dataWritesBlockedAt && phase2.commitBeforeAt === fence.dataWritesBlockedAt
    && phase2.beforeCatalogSha256 === phase1.afterCatalogSha256
    && phase2.afterCatalogSha256 === driverAuditReportingFunctionCatalogSha256(capabilities.functions)
    && phase2.originalInternalDefinitionSha256 === internal.definitionSha256 && phase2.originalDefinitionRestored === true
    && phase2.reportingFunctions === catalogFunctions.size && phase2.revokedMutators === fencedFunctions.size
    && proofId(drain?.id) && hashPattern.test(drain.sha256 ?? '')
    && drain.sha256 === phase2.beforeObservationSha256 && drain.checkedAt === phase2.beforeObservationAt
    && Date.parse(drain.checkedAt) >= Date.parse(fence.admissionBlockedAt) + 6 * minuteMs
    && Date.parse(drain.checkedAt) <= beforeClosure
    && ['activeLeases', 'activeReportingTransactions', 'activeSqlCronRuns', 'activeProviderWork',
      'privilegedReportingWriters', 'possibleReportingHttpQueue'].every(name => drain[name] === 0)
    && hashPattern.test(drain.admissionGraphSha256 ?? '') && drain.admissionGraphSha256 === finalDrain.admissionGraphSha256
    && hashPattern.test(drain.ownerAuditSha256 ?? '')
    && retainedUncertainAttempts(drain.uncertainAttempts, baseline),
  'The phase2 closure requires the original admission, real pre-commit drain and whole uncertain ledger.');
  return { phase1, phase2 };
}

const projectionFields = ['version', 'mode', 'sourceProjectRef', 'sourceReleaseSha256', 'sourceFenceSha256', 'capabilityAuditSha256',
  'legacyRuntimeSha256', 'legacyEntrypointsSha256',
  'phase1ExecutionId', 'phase1ReceiptSha256', 'phase1SQLSha256', 'phase2ExecutionId', 'phase2ReceiptSha256', 'phase2SQLSha256',
  'transactionId', 'admissionBlockedAt', 'dataWritesBlockedAt', 'commitObservedAt', 'prePhase2DrainAt', 'beforeCatalogSha256',
  'afterCatalogSha256', 'initialCursor', 'checkpointSha256', 'backupReceiptSha256', 'parityReceiptSha256', 'backupAt', 'validUntil'];
export function validateDriverAuditSourceFenceProjection(value, nowMs = Date.now()) {
  const lower = Date.parse(value?.dataWritesBlockedAt), upper = Date.parse(value?.commitObservedAt);
  const admission = Date.parse(value?.admissionBlockedAt), drain = Date.parse(value?.prePhase2DrainAt);
  const backup = Date.parse(value?.backupAt), expires = Date.parse(value?.validUntil);
  requireSource(value?.version === 2 && value.mode === twoPhaseFenceMode && value.sourceProjectRef === originalReportingProject
    && Object.keys(value).length === projectionFields.length && projectionFields.every(name => Object.hasOwn(value, name))
    && projectionFields.filter(name => name.endsWith('Sha256')).every(name => hashPattern.test(value[name] ?? ''))
    && proofId(value.phase1ExecutionId) && proofId(value.phase2ExecutionId) && value.phase1ExecutionId !== value.phase2ExecutionId
    && value.phase1ReceiptSha256 !== value.phase2ReceiptSha256 && value.beforeCatalogSha256 !== value.afterCatalogSha256
    && /^[1-9][0-9]{0,30}$/.test(value.transactionId ?? '') && Number.isFinite(nowMs)
    && [lower, upper, admission, drain, backup, expires].every(Number.isFinite)
    && admission + 6 * minuteMs <= drain && drain <= lower && lower <= upper && upper - lower <= 3 * minuteMs
    && backup >= upper + 5 * minuteMs && backup <= nowMs && nowMs - backup <= 30 * minuteMs
    && nowMs >= upper && expires > nowMs && expires <= lower + 30 * minuteMs
    && Number.isFinite(Date.parse(value.initialCursor)) && Date.parse(value.initialCursor) % minuteMs === 0
    && Date.parse(value.initialCursor) <= admission,
  'A fresh validated two-phase source fence projection is required.');
  return driverAuditSourceHash(JSON.stringify(value));
}

// This mode proves closure of the audited legacy reporting admissions. It does
// not claim cron processes stopped or revoke shared raw Storage/Gateway keys.
async function verifyCapabilityFence(config, fence, release, backup, directory, verifiedAt, expires, nowMs, sourceFenceSha256) {
  const twoPhase = fence.mode === twoPhaseFenceMode;
  const blockedAt = Date.parse(fence.admissionBlockedAt), checkedAt = Date.parse(fence.checkedAt);
  const baseline = backup?.uncertainAttemptsBaseline;
  requireSource(Number.isSafeInteger(baseline?.count) && baseline.count >= 0 && hashPattern.test(baseline.sha256 ?? '')
    && proofId(baseline.snapshotId) && hashPattern.test(baseline.sourceSnapshotSha256 ?? '')
    && hashPattern.test(baseline.restoreVerificationSha256 ?? ''),
  'The independently pinned restored backup uncertain-attempt baseline is required.');
  requireSource(config.dataStore === 'mongo' && config.environment?.DRIVER_AUDIT_DATA_STORE === 'mongo'
    && fence.writersStopped === false && fence.processesStopped !== true
    && fence.sourceProjectRef === originalReportingProject && proofId(fence.id)
    && hashPattern.test(fence.legacyRuntimeSha256 ?? '') && hashPattern.test(fence.legacyEntrypointsSha256 ?? '')
    && Number.isFinite(blockedAt) && Number.isFinite(checkedAt) && blockedAt <= checkedAt && checkedAt <= verifiedAt
    && nowMs - checkedAt <= 30 * minuteMs && fence.initialCursor === release.initialCursor
    && Date.parse(fence.initialCursor) <= blockedAt && Date.parse(fence.validUntil) >= expires,
  'The native database capability fence is incomplete or not fresh.');
  const proofs = {}, ids = new Set([fence.id]), hashes = new Set(), paths = new Set();
  for (const [name, kind] of [['capabilityAudit', 'reporting-capability-audit'], ['drainAudit', 'reporting-drain-audit'],
    ['quietAudit', 'reporting-quiet-window'], ['checkpoint', 'reporting-final-checkpoint']]) {
    const reference = sourceReceiptReference(fence[name], directory);
    requireSource(proofId(reference?.id) && !ids.has(reference.id) && !hashes.has(reference.sha256)
      && !paths.has(reference.path), 'Independent pinned capability fence proofs are required.');
    ids.add(reference.id); hashes.add(reference.sha256); paths.add(reference.path);
    const value = await readPinnedJson(reference, 'capability fence ' + name);
    const at = Date.parse(value.checkedAt);
    requireSource(value.version === 1 && value.verified === true && value.id === reference.id && value.kind === kind
      && value.sourceProjectRef === fence.sourceProjectRef && value.legacyRuntimeSha256 === fence.legacyRuntimeSha256
      && value.legacyEntrypointsSha256 === fence.legacyEntrypointsSha256 && value.admissionBlockedAt === fence.admissionBlockedAt
      && (!twoPhase || value.dataWritesBlockedAt === fence.dataWritesBlockedAt)
      && Number.isFinite(at) && at >= blockedAt && at <= checkedAt, 'Capability fence proof identity or clock differs.');
    proofs[name] = value;
  }
  const { capabilityAudit: capabilities, drainAudit: drain, quietAudit: quiet, checkpoint } = proofs;
  const roles = ['PUBLIC', 'anon', 'authenticated', 'service_role'];
  const exact = (actual, expected) => Array.isArray(actual) && actual.length === expected.length
    && new Set(actual).size === actual.length && expected.every(value => actual.includes(value));
  requireSource(hashPattern.test(capabilities.baselineCatalogSha256 ?? '') && exact(capabilities.apiRoles, roles)
    && exact(capabilities.ownerBypassRoles, ['postgres', 'supabase_admin'])
    && hashPattern.test(capabilities.roleMembershipSha256 ?? '') && capabilities.serviceRoleCannotAssumeOwner === true
    && capabilities.rawStorageAndGatewayRevoked === false
    && hashPattern.test(capabilities.unrelatedBeforeSha256 ?? '')
    && capabilities.unrelatedAfterSha256 === capabilities.unrelatedBeforeSha256,
  'Capability fence role scope or preserved unrelated access differs.');
  const seen = new Set();
  requireSource(Array.isArray(capabilities.functions) && capabilities.functions.length === catalogFunctions.size,
    'The capability fence needs the exact reporting function catalog.');
  for (const row of capabilities.functions) {
    requireSource(catalogFunctions.has(row?.identity) && !seen.has(row.identity) && row.owner === 'postgres'
      && hashPattern.test(row.beforeDefinitionSha256 ?? '') && row.definitionSha256 === row.beforeDefinitionSha256
      && hashPattern.test(row.beforeAclSha256 ?? '') && hashPattern.test(row.aclSha256 ?? '')
      && Array.isArray(row.beforeApiExecutableRoles) && new Set(row.beforeApiExecutableRoles).size === row.beforeApiExecutableRoles.length
      && row.beforeApiExecutableRoles.every(role => roles.includes(role))
      && Array.isArray(row.apiExecutableRoles) && new Set(row.apiExecutableRoles).size === row.apiExecutableRoles.length
      && row.apiExecutableRoles.every(role => roles.includes(role))
      && (!(fencedFunctions.has(row.identity) || ownerOnlyFunctions.has(row.identity)) || row.apiExecutableRoles.length === 0)
      && (fencedFunctions.has(row.identity) || row.aclSha256 === row.beforeAclSha256
        && exact(row.apiExecutableRoles, row.beforeApiExecutableRoles)),
    'Capability fence function definitions, effective execution or preserved catalog differ.');
    seen.add(row.identity);
  }
  const road = capabilities.roadCache;
  requireSource(road?.identity === 'matter_preview_cache.road_geometry' && exact(road.apiWritableRoles, [])
    && road.selectPreserved === true && hashPattern.test(road.beforeAclSha256 ?? '') && hashPattern.test(road.aclSha256 ?? '')
    && Array.isArray(capabilities.sqlCron) && capabilities.sqlCron.length === 2
    && exact(capabilities.sqlCron.map(job => job.id), [4, 5]) && capabilities.sqlCron.every(job => job.active === false
      && job.owner === 'postgres' && hashPattern.test(job.beforeCommandSha256 ?? '') && job.commandSha256 === job.beforeCommandSha256),
  'Capability fence direct reporting writes or owner SQL cron remain available.');
  requireSource(['activeLeases', 'activeReportingTransactions', 'activeSqlCronRuns', 'activeProviderWork', 'privilegedReportingWriters']
    .every(name => drain[name] === 0) && hashPattern.test(drain.admissionGraphSha256 ?? '')
    && hashPattern.test(drain.ownerAuditSha256 ?? '') && retainedUncertainAttempts(drain.uncertainAttempts, baseline),
  'The capability fence needs drained work and preserved uncertain attempts.');
  const origins = twoPhase ? verifyTwoPhaseOrigins(capabilities, fence, baseline, drain) : undefined;
  const quietAfter = origins ? Date.parse(origins.phase2.commitAfterAt) : blockedAt;
  if (twoPhase) requireSource(Date.parse(fence.validUntil) <= Date.parse(fence.dataWritesBlockedAt) + 30 * minuteMs
    && expires <= Date.parse(fence.dataWritesBlockedAt) + 30 * minuteMs, 'The phase2 full-closure window cannot be refreshed.');
  requireSource(Array.isArray(quiet.samples) && quiet.samples.length === 2, 'Independent quiet source samples are required.');
  requireSource(quiet.samples.every(value => value && typeof value === 'object'), 'Independent quiet source samples are required.');
  const [start, end] = quiet.samples, from = Date.parse(start.at), to = Date.parse(end.at);
  requireSource(proofId(start.id) && proofId(end.id) && start.id !== end.id
    && hashPattern.test(start.sha256 ?? '') && hashPattern.test(end.sha256 ?? '') && start.sha256 !== end.sha256
    && Number.isFinite(from) && Number.isFinite(to) && from >= quietAfter && to - from >= 5 * minuteMs
    && to - from <= 30 * minuteMs && nowMs - to <= 30 * minuteMs
    && sameFingerprints(start.fingerprints, end.fingerprints)
    && capabilities.capabilitySha256 === end.fingerprints.capabilities
    && [capabilities, drain, quiet].every(value => Date.parse(value.checkedAt) >= to),
  'The capability fence needs fresh unchanged reporting evidence across a bounded quiet window.');
  const capturedAt = Date.parse(checkpoint.capturedAt);
  requireSource(checkpoint.snapshotId === baseline.snapshotId && checkpoint.sourceSnapshotSha256 === baseline.sourceSnapshotSha256
    && checkpoint.restoreVerificationSha256 === baseline.restoreVerificationSha256
    && Number.isFinite(capturedAt) && capturedAt >= Date.parse(drain.checkedAt) && nowMs - capturedAt <= 30 * minuteMs
    && (!twoPhase || capturedAt >= to && capturedAt >= quietAfter)
    && capturedAt <= Date.parse(checkpoint.checkedAt) && checkpoint.initialCursor === release.initialCursor
    && Number.isSafeInteger(checkpoint.collectorRevision) && checkpoint.collectorRevision > 0
    && Number.isSafeInteger(checkpoint.reviewRevision) && checkpoint.reviewRevision >= 0
    && checkpoint.backupReceiptSha256 === release.backup.sha256 && checkpoint.parityReceiptSha256 === release.parity.sha256
    && sameFingerprints(checkpoint.fingerprints, end.fingerprints) && retainedUncertainAttempts(checkpoint.uncertainAttempts, baseline),
  'The final capability fence checkpoint or retained uncertain attempts differ.');
  if (origins) return { version: 2, mode: twoPhaseFenceMode, sourceProjectRef: fence.sourceProjectRef, sourceFenceSha256,
    legacyRuntimeSha256: fence.legacyRuntimeSha256, legacyEntrypointsSha256: fence.legacyEntrypointsSha256,
    capabilityAuditSha256: fence.capabilityAudit.sha256, phase1ExecutionId: origins.phase1.executionId,
    phase1ReceiptSha256: fence.phase1ReceiptSha256, phase1SQLSha256: origins.phase1.sqlSha256,
    phase2ExecutionId: origins.phase2.executionId, phase2ReceiptSha256: fence.phase2ReceiptSha256,
    phase2SQLSha256: origins.phase2.sqlSha256, transactionId: origins.phase2.transactionId,
    admissionBlockedAt: fence.admissionBlockedAt, dataWritesBlockedAt: fence.dataWritesBlockedAt,
    commitObservedAt: origins.phase2.commitAfterAt, prePhase2DrainAt: origins.phase2.prePhase2Drain.checkedAt,
    beforeCatalogSha256: origins.phase2.beforeCatalogSha256, afterCatalogSha256: origins.phase2.afterCatalogSha256,
    initialCursor: release.initialCursor, checkpointSha256: fence.checkpoint.sha256, backupReceiptSha256: release.backup.sha256,
    parityReceiptSha256: release.parity.sha256, backupAt: checkpoint.capturedAt, validUntil: release.validUntil };
}

export async function verifyDriverAuditSourceRelease(config, reference, now = new Date()) {
  const release = await readPinnedJson(reference, 'source release receipt');
  const verifiedAt = Date.parse(release.verifiedAt);
  const expires = Date.parse(release.validUntil);
  requireSource(release.version === 1 && release.verified === true && release.configSha256 === config.configSha256
    && release.runtimeManifestSha256 === config.manifestSha256 && release.environmentSha256 === config.environmentReference.sha256
    && release.nodeVersion === config.nodeVersion && typeof release.initialCursor === 'string'
    && Number.isFinite(Date.parse(release.initialCursor)) && Date.parse(release.initialCursor) % minuteMs === 0
    && Date.parse(release.initialCursor) <= verifiedAt,
  'Source release receipt does not match the qualified configuration.');
  requireSource(Number.isFinite(verifiedAt) && Number.isFinite(expires) && expires > verifiedAt && expires - verifiedAt <= 30 * minuteMs
    && now.getTime() >= verifiedAt && now.getTime() < expires, 'Source release fence is expired or not fresh.');
  const receipts = {};
  let validatedFence;
  for (const kind of ['backup', 'parity', 'credentials', 'sourceFence']) {
    const saved = release[kind];
    const receiptReference = sourceReceiptReference(saved, path.dirname(reference.path));
    const receipt = await readPinnedJson(receiptReference, kind + ' receipt');
    requireSource(receipt.version === 1 && receipt.verified === true, `The ${kind} receipt is not verified.`);
    receipts[kind] = receipt;
    if (kind === 'sourceFence') {
      requireSource(config.dataStore !== 'supabase' || config.executionHost !== 'sidi' || receipt.mode === hostingAdmissionFenceMode,
        'Sidi Supabase execution requires its exact hosting admission fence.');
      if (receipt.mode === hostingAdmissionFenceMode) {
        await verifyHostingAdmissionFence(config, receipt, release, receipts, path.dirname(receiptReference.path), verifiedAt, expires, now.getTime());
      } else if ([capabilityFenceMode, twoPhaseFenceMode].includes(receipt.mode)) {
        validatedFence = await verifyCapabilityFence(config, receipt, release, receipts.backup,
          path.dirname(receiptReference.path), verifiedAt, expires, now.getTime(), receiptReference.sha256);
      } else {
        requireSource(receipt.writersStopped === true && receipt.leasesDrained === true
          && receipt.initialCursor === release.initialCursor && Date.parse(receipt.validUntil) >= expires,
        'The source fence does not match the stopped and drained writers.');
      }
    }
  }
  if (validatedFence) {
    validatedFence = { ...validatedFence, sourceReleaseSha256: reference.sha256 };
    validateDriverAuditSourceFenceProjection(validatedFence, now.getTime());
    return { release, sha256: reference.sha256, validatedFence: Object.freeze(validatedFence) };
  }
  return { release, sha256: reference.sha256 };
}

export async function invokeDriverAuditSourceHandler(handler, { entrypoint, environment, gatewayCredential }) {
  requireSource(typeof handler === 'function' && typeof environment.CRON_SECRET === 'string'
    && environment.CRON_SECRET.length >= 32, 'Source handler configuration is invalid.');
  const headers = {
    authorization: 'Bearer ' + environment.CRON_SECRET,
    'user-agent': 'vercel-cron/1.0',
    'x-vercel-cron-schedule': entrypoint.schedule,
  };
  if (gatewayCredential) {
    requireSource(typeof gatewayCredential === 'string' && gatewayCredential.length <= 12000
      && !/[\x00-\x20\x7f]/.test(gatewayCredential), 'Source Gateway credential is invalid.');
    headers['x-vercel-oidc-token'] = gatewayCredential;
  }
  const request = { method: entrypoint.method, url: entrypoint.path, headers };
  let statusCode = 200;
  let ended = false;
  const chunks = [];
  let length = 0;
  const response = {
    headersSent: false,
    writeHead(code) { statusCode = code; this.headersSent = true; return this; },
    end(body = '') {
      requireSource(!ended, 'Source handler ended twice.');
      ended = true;
      const bytes = Buffer.from(body);
      length += bytes.length;
      requireSource(length <= 1024 * 1024, 'Source handler response exceeded its limit.');
      chunks.push(bytes);
    },
    destroy() { throw new Error('Source handler response was interrupted.'); },
  };
  await handler(request, response);
  requireSource(ended && statusCode >= 200 && statusCode < 300, 'Source handler failed.');
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Source handler response is invalid.'); }
  const safeStatuses = new Set(['disabled', 'not-due', 'complete', 'needs-inspection', 'budget-exhausted', 'unavailable', 'deferred', 'needs_recovery']);
  requireSource(safeStatuses.has(body?.status), 'Source handler status is invalid.');
  const result = { httpStatus: statusCode, status: body.status };
  for (const key of ['collected', 'failed', 'completed', 'pending', 'completedWindows', 'pendingWindows', 'failedWindows', 'sourceRevision', 'revision']) {
    if (Number.isSafeInteger(body[key]) && body[key] >= 0) result[key] = body[key];
  }
  const reasons = ['collector-lease-busy', 'publication-contended', 'source-paused', 'source-changed', 'source_backoff',
    'outside_delivery_hours', 'no-work-completed', 'byte-limit'];
  if (reasons.includes(body.reason)) result.reason = body.reason;
  if (['retained', 'settled'].includes(body.budgetSettlement)) result.budgetSettlement = body.budgetSettlement;
  return result;
}

export function runDriverAuditSourceChild(config, entrypoint, { probe = false, signal, onAdmission = async () => {} } = {}) {
  const script = fileURLToPath(new URL('../scripts/driverAuditSource.js', import.meta.url));
  return new Promise((resolve, reject) => {
    // Do not inherit app secrets, NODE_OPTIONS or the operator's environment.
    const env = Object.fromEntries(['HOME', 'LANG', 'LC_ALL', 'TZ'].filter(key => process.env[key] !== undefined)
      .map(key => [key, process.env[key]]));
    if (config.executionHost === 'off-host') env[DRIVER_AUDIT_SOURCE_EXECUTION_HOST_ENV] = 'off-host';
    const child = fork(script, ['--config', config.file, '--child'], {
      cwd: config.runtimeRoot, env, execArgv: ['--max-old-space-size=3072'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let result;
    let timedOut = false;
    let dispatched = false;
    let admitted = probe;
    let cancelled = false;
    let admissionError;
    let timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 30_000);
    const abort = () => {
      if (!admitted) { cancelled = true; child.kill('SIGTERM'); }
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', () => reject(new Error('Source child could not start.')));
    child.on('message', value => {
      if (value?.version === 1 && value.ready === true && !dispatched) {
        if (cancelled) return;
        dispatched = true;
        if (!probe) clearTimeout(timer);
        child.send({ version: 1, configSha256: config.configSha256, id: entrypoint.id, probe }, error => {
          if (error) child.kill('SIGKILL');
        });
      }
      if (value?.version === 1 && value.admitted === true && !cancelled) {
        admitted = true;
        timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, entrypoint.maxDurationSeconds * 1000);
        Promise.resolve(onAdmission()).then(() => {
          if (child.connected) child.send({ version: 1, run: true });
        }).catch(error => { admissionError = error; child.kill('SIGKILL'); });
      }
      if (value?.version === 1 && value.ok === true && value.id === entrypoint.id
        && Number.isInteger(value.result?.httpStatus) && typeof value.result?.status === 'string') result = value.result;
    });
    child.once('exit', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (cancelled) reject(Object.assign(new Error('Source admission cancelled.'), { code: 'AUDIT_ADMISSION_CANCELLED' }));
      else if (admissionError) reject(admissionError);
      else if (timedOut) reject(new Error('Source child exceeded its execution time.'));
      else if (code !== 0 || !result) reject(new Error('Source child execution failed.'));
      else resolve(result);
    });
    if (signal?.aborted) abort();
  });
}

export async function createDriverAuditSourceScheduler({ entrypoints, stateFile, configSha256, initialCursor, invoke }) {
  requireSource(hashPattern.test(configSha256 ?? '') && typeof invoke === 'function', 'Invalid source scheduler configuration.');
  let state;
  try { state = JSON.parse(await readPrivateDriverAuditSource(stateFile)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) % minuteMs === 0;
  if (state) {
    requireSource(state.version === 1 && state.configSha256 === configSha256 && validTime(state.lastScanAt)
      && state.jobs && typeof state.jobs === 'object' && !Array.isArray(state.jobs), 'Saved source schedule state differs from its configuration.');
    if (initialCursor !== undefined) {
      requireSource(validTime(initialCursor), 'A fenced initial source schedule cursor is required.');
      if (Date.parse(initialCursor) > Date.parse(state.lastScanAt)) {
        state.lastScanAt = initialCursor;
        state.pending = (state.pending ?? []).filter(item => Date.parse(item.scheduledAt) > Date.parse(initialCursor));
      }
    }
  } else {
    requireSource(validTime(initialCursor), 'A fenced initial source schedule cursor is required.');
    state = { version: 1, configSha256, lastScanAt: initialCursor, missedMinutes: 0, jobs: {}, pending: [] };
  }
  state.pending ??= [];
  const knownIds = new Set(entrypoints.map(entry => entry.id));
  requireSource(Array.isArray(state.pending) && state.pending.every(item => knownIds.has(item.id) && validTime(item.scheduledAt)),
    'Saved pending source schedule is invalid.');
  requireSource(new Set(state.pending.map(item => item.id + ':' + item.scheduledAt)).size === state.pending.length,
    'Saved pending source schedule has duplicate claims.');
  for (const [id, job] of Object.entries(state.jobs)) {
    if (job.status === 'running') {
      job.status = 'interrupted';
      state.pending = state.pending.filter(item => item.scheduledAt !== job.scheduledAt || item.id !== id);
    }
  }
  await writeDriverAuditSourceState(stateFile, state);
  let active;
  let stopped = false;
  let persistenceError;
  let queue = Promise.resolve();
  const cancellation = new AbortController();
  const enqueue = operation => {
    const result = queue.then(() => {
      if (persistenceError) throw persistenceError;
      return operation();
    });
    queue = result.catch(error => { persistenceError = error; stopped = true; });
    return result;
  };
  const save = () => writeDriverAuditSourceState(stateFile, state);
  async function dispatch() {
    while (!stopped && state.pending.length > 0) {
      const claim = state.pending[0];
      const entry = entrypoints.find(item => item.id === claim.id);
      await enqueue(async () => {
        state.jobs[claim.id] = { scheduledAt: claim.scheduledAt, status: 'waiting' };
        await save();
      });
      let outcome;
      let admitted = false;
      try {
        outcome = await invoke(entry, { scheduledAt: claim.scheduledAt, signal: cancellation.signal,
          onAdmission: () => enqueue(async () => {
            state.jobs[claim.id] = { scheduledAt: claim.scheduledAt, status: 'running' };
            state.pending.shift();
            await save();
            admitted = true;
          }) });
      } catch (error) {
        if (error.code === 'AUDIT_ADMISSION_CANCELLED' && stopped) break;
        outcome = { status: 'failed' };
      }
      await enqueue(async () => {
        state.jobs[claim.id] = { scheduledAt: claim.scheduledAt, ...outcome };
        if (!admitted) state.pending.shift();
        await save();
      });
    }
  }
  const kick = () => {
    if (active || stopped || state.pending.length === 0) return;
    active = dispatch().catch(error => { persistenceError = error; stopped = true; }).finally(() => { active = null; });
  };
  return {
    stop() { stopped = true; cancellation.abort(); },
    async drain() {
      await active;
      await queue;
      if (persistenceError) throw persistenceError;
    },
    snapshot() { return structuredClone(state); },
    async tick(now = new Date()) {
      await enqueue(async () => {
        if (stopped) return;
        const current = Math.floor(now.getTime() / minuteMs) * minuteMs;
        const previous = Date.parse(state.lastScanAt);
        requireSource(Number.isFinite(current) && current >= previous, 'Source schedule clock moved backwards.');
        if (current === previous) return;
        state.missedMinutes = (state.missedMinutes ?? 0) + Math.max(0, (current - previous) / minuteMs - 1);
        state.lastScanAt = new Date(current).toISOString();
        for (const entry of entrypoints) {
          if (!sourceScheduleMatches(entry.schedule, new Date(current))) continue;
          state.pending.push({ id: entry.id, scheduledAt: state.lastScanAt });
        }
        await save();
      });
      kick();
    },
  };
}
