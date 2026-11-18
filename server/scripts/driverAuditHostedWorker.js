import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { driverAuditHostedWorkerPlan, preflightDriverAuditHostedBootstrap } from './driverAuditHostedBootstrap.js';
import { runDriverAuditQualificationChild, stageDriverAuditQualification,
  validateDriverAuditSourceTransferUsage } from './driverAuditSourceQualify.js';
import { driverAuditSourceHash, readDriverAuditSourceConfig, readPrivateDriverAuditSource,
  requirePrivateDriverAuditSourceDirectory, writeDriverAuditSourceState } from '../services/driverAuditSource.js';
import { driverAuditHostedSlotSkippedExitCode } from '../services/driverAuditHostedSlots.js';

const repo = 'sidimohameddaliali2-crypto/matter-admin-app';
const nodeVersion = 'v24.22.1';
const qualificationKind = 'driver-report-hosted-linux-qualification-v1';
const MiB = 1024 ** 2;
const memorySafetyReserve = 512 * MiB;
const priorSourcePeak = 4_086_464_512;
const replayDiskReserve = 256 * MiB;
const archiveDownloadLimit = 192 * MiB;
const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const check = condition => { if (!condition) throw Error('The hosted report worker is held.'); };
const workerScript = fileURLToPath(new URL('driverAuditOffHostWorker.js', import.meta.url));
const scopedFixtureTests = ['driverAuditDeliveryChanges', 'driverAuditDeliveryCaseProjection',
  'driverAuditDeliveryView', 'driverAuditSupabaseReplica', 'driverAuditSupabaseSync', 'driverAuditOffHostWorker', 'driverAuditLightReader']
  .map(name => fileURLToPath(new URL('../services/' + name + '.test.js', import.meta.url)));

export function hostedDriverAuditWorkerSettings(env, operation, runtime = process, now = Date.now()) {
  const releaseSha = env.DRIVER_AUDIT_WORKER_RELEASE_SHA, bootstrapSha256 = env.DRIVER_AUDIT_WORKER_BOOTSTRAP_SHA256;
  check(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === repo && env.GITHUB_REF === 'refs/heads/main'
    && commit(env.GITHUB_SHA) && commit(releaseSha) && releaseSha === env.DRIVER_AUDIT_WORKER_CHECKOUT_SHA && digest(bootstrapSha256)
    && runtime.platform === 'linux' && runtime.version === nodeVersion);
  check(env.GITHUB_EVENT_NAME === 'workflow_dispatch'
    ? operation === '--qualify' || operation === '--once' && env.DRIVER_AUDIT_WORKER_ARMED === '1'
    : env.GITHUB_EVENT_NAME === 'schedule' && operation === '--scheduled' && env.DRIVER_AUDIT_WORKER_ARMED === '1');
  let expectedScheduledAt;
  if (operation === '--scheduled') {
    const slot = driverAuditHostedWorkerPlan().schedules.find(({ cron }) => cron === env.DRIVER_AUDIT_WORKER_EVENT_SCHEDULE);
    const createdAt = env.DRIVER_AUDIT_WORKER_RUN_CREATED_AT;
    check(slot && iso(createdAt) && Number.isFinite(now) && Date.parse(createdAt) <= now);
    expectedScheduledAt = `${createdAt.slice(0, 10)}T${slot.utc}:00.000Z`;
  }
  const cacheKeyText = env.DRIVER_AUDIT_WORKER_CACHE_KEY, supabaseSecret = env.DRIVER_AUDIT_WORKER_SUPABASE_SECRET;
  check(typeof cacheKeyText === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(cacheKeyText)
    && typeof supabaseSecret === 'string' && supabaseSecret.length > 24 && supabaseSecret.length <= 4096 && !/[\r\n\0]/.test(supabaseSecret));
  const cacheKey = Buffer.from(cacheKeyText, 'base64');
  check(cacheKey.length === 32 && cacheKey.toString('base64') === cacheKeyText && cacheKey.some(byte => byte !== 0));
  return { releaseSha, bootstrapSha256, supabaseSecret, cacheKey, expectedScheduledAt };
}

export function requireHostedDriverAuditQualification(receipt, binding, now = Date.now()) {
  check(receipt?.version === 1 && receipt.kind === qualificationKind && receipt.verified === true && receipt.platform === 'linux'
    && commit(receipt.releaseSha) && ['bootstrapSha256', 'sourceConfigSha256', 'syncSha256', 'pinsSha256', 'activationSha256',
      'fixtureSha256'].every(key => digest(receipt[key]))
    && receipt.nodeVersion === nodeVersion && Object.entries(binding).every(([key, value]) => receipt[key] === value)
    && iso(receipt.qualifiedAt) && Date.parse(receipt.qualifiedAt) <= now && digest(receipt.builderCandidateManifestSha256)
    && receipt.deliveryScopeFixtureVerified === true);
  const measured = receipt.measurements;
  for (const reads of [measured?.coldArchiveReads, measured?.warmArchiveReads])
    check(integer(reads?.requests) && integer(reads?.bytes));
  check(measured.warmArchiveReads.requests < measured.coldArchiveReads.requests
    && measured.warmArchiveReads.bytes < measured.coldArchiveReads.bytes
    && integer(measured.sourcePeakBytes) && measured.sourcePeakBytes > 0
    && integer(measured.builderPeakBytes) && measured.builderPeakBytes > 0
    && integer(measured.memoryAvailableWithBuilderBytes)
    && measured.memoryAvailableWithBuilderBytes >= measured.sourcePeakBytes + memorySafetyReserve
    && integer(measured.fixtureArchiveBytes) && measured.fixtureArchiveBytes > 0 && measured.fixtureArchiveBytes <= 112 * MiB
    && integer(measured.builderArchiveBytes) && measured.builderArchiveBytes <= archiveDownloadLimit);
  const before = validateDriverAuditSourceTransferUsage(receipt.transferUsage?.before);
  const after = validateDriverAuditSourceTransferUsage(receipt.transferUsage?.after);
  check(['month', 'day'].every(name => after[name].period > before[name].period
    || after[name].period === before[name].period && after[name].usedBytes >= before[name].usedBytes));
  return receipt;
}

export function requireHostedDriverAuditEnrollment(value, binding, qualification, now = Date.now()) {
  check(value?.version === 1 && value.syncSha256 === binding.syncSha256
    && value.sourceSha256 === binding.sourceConfigSha256 && iso(value.armedAt)
    && Date.parse(value.armedAt) <= now && value.armedAt >= qualification.qualifiedAt);
  return value;
}

async function linuxMemoryAvailable() {
  const match = /^MemAvailable:\s+([0-9]+)\s+kB$/m.exec(await fs.readFile('/proc/meminfo', 'utf8'));
  const bytes = Number(match?.[1]) * 1024;
  check(integer(bytes) && bytes > 0);
  return bytes;
}

async function freeDisk(root) {
  const value = await fs.statfs(root);
  return value.bavail * value.bsize;
}

export function hostedDriverAuditFixtureArchive({ root, fixturePath, fixtureSha256, readArchive }) {
  check(fixturePath === path.join(root, 'source-replay.private.json.gz') && digest(fixtureSha256));
  return {
    async readObject(key, options) {
      if (key !== `${fixtureSha256}.gz`) return readArchive(key, options);
      options?.signal?.throwIfAborted();
      const bytes = await readPrivateDriverAuditSource(fixturePath, MiB);
      check(bytes.length > 0 && driverAuditSourceHash(bytes) === fixtureSha256);
      return [bytes];
    },
  };
}

export async function allowEncryptedCacheSave(env, bundle, checkpoint) {
  if (checkpoint?.cacheSaved !== true) return;
  await requirePrivateDriverAuditSourceDirectory(path.dirname(bundle));
  const file = await fs.open(bundle, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    check(stat.isFile() && stat.uid === process.getuid() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600
      && await fs.realpath(bundle) === bundle);
    const size = Buffer.alloc(4);
    check((await file.read(size, 0, size.length, 0)).bytesRead === size.length);
    const headerLength = size.readUInt32BE();
    check(headerLength > 0 && headerLength <= 4096);
    const bytes = Buffer.alloc(headerLength);
    check((await file.read(bytes, 0, bytes.length, 4)).bytesRead === bytes.length);
    const { version, kind, plan } = JSON.parse(bytes.toString('utf8'));
    check(version === 1 && kind === 'driver-report-hosted-immutable-cache-v1' && integer(plan?.cipherBytes)
      && plan.cipherBytes > 0 && plan.cipherBytes <= 514 * MiB + 65536
      && stat.size === 4 + headerLength + plan.cipherBytes && path.isAbsolute(env.GITHUB_OUTPUT ?? ''));
    await fs.appendFile(env.GITHUB_OUTPUT, 'encrypted-cache-ready=1\n');
  } finally { await file.close(); }
}

function runPrivateChild(args, root, signal, { environment = {}, toleratedExitCode = 0 } = {}) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root, env: { HOME: root, LANG: 'C', TZ: 'UTC', ...environment }, stdio: 'ignore',
    });
    let killTimer;
    const stop = () => {
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 20_000);
      killTimer.unref();
    };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    child.on('error', reject);
    child.on('close', (code, stopped) => {
      clearTimeout(killTimer);
      signal.removeEventListener('abort', stop);
      if ((code === 0 || code === toleratedExitCode) && !stopped && !signal.aborted) resolve(code);
      else reject(Error('The pinned report worker did not finish.'));
    });
  });
}

function runWorker({ root, syncFile, sourceFile }, mode, signal, expectedScheduledAt) {
  const args = [workerScript, '--config', syncFile, '--source', sourceFile, mode];
  if (!expectedScheduledAt) return runPrivateChild(args, root, signal);
  return runPrivateChild([...args, '--scheduled-at', expectedScheduledAt], root, signal,
    { toleratedExitCode: driverAuditHostedSlotSkippedExitCode });
}

async function replayChild({ phase, input, directory, signal, readRoots, archiveCacheDirectory, mode = 'source', readArchive }) {
  signal.throwIfAborted();
  const root = path.join(directory, phase), inputFile = path.join(root, 'input.private.json');
  await fs.mkdir(root, { mode: 0o700 });
  await writeDriverAuditSourceState(inputFile, { root, archiveCacheDirectory, sidiReplay: true, ...input });
  const child = runDriverAuditQualificationChild({ mode, root, inputFile, archiveCacheDirectory, readRoots, readArchive,
    executable: process.execPath, args: ['--max-old-space-size=3072'],
    timeoutMs: mode === 'source' ? input.entrypoint.maxDurationSeconds * 1000 : 35 * 60_000, signal });
  try {
    const result = await child.result;
    check(result?.status === 'verified' && result.platform === 'linux' && result.nodeVersion === nodeVersion
      && result.networkAttempts === 0 && integer(result.peakRssBytes) && result.peakRssBytes > 0
      && result.managedArchiveCache === true && result.archiveCacheEnabled === true);
    return { root, pid: child.pid, result, stop: child.stop };
  } catch (error) { await child.stop(); throw error; }
}

async function qualifyWorker(context, configuration, binding, signal) {
  const { root, sync, source } = configuration;
  check(await linuxMemoryAvailable() >= priorSourcePeak + memorySafetyReserve);
  await runPrivateChild(['--test', ...scopedFixtureTests], root, signal, {
    environment: { DRIVER_AUDIT_FIXTURE_BUILDER_ROOT: sync.codeRoot, DRIVER_AUDIT_FIXTURE_BUILDER_SHA256: sync.builderSha256 },
  });
  const before = validateDriverAuditSourceTransferUsage(await context.readTransferUsage());
  await runWorker(configuration, '--check', signal);
  const directory = await fs.mkdtemp(path.join(root, 'qualification-'));
  try {
    const archiveCacheDirectory = path.join(directory, 'source-archive-cache');
    await fs.mkdir(archiveCacheDirectory, { mode: 0o700 });
    const archive = hostedDriverAuditFixtureArchive({ root, fixturePath: context.fixturePath,
      fixtureSha256: binding.fixtureSha256, readArchive: context.readArchive });
    const saved = await stageDriverAuditQualification({ root: directory, fixtureSha256: binding.fixtureSha256,
      runtimeManifestSha256: source.manifestSha256, archive, signal });
    const entrypoint = source.runtime.entrypoints.find(entry => entry.path === '/api/collector?task=delivery');
    check(entrypoint && source.runtime.files.some(file => file.path === 'source/integration/cloud/native-poll-progress.mjs'));
    const runSource = (phase, failPublication) => replayChild({ phase, directory, signal, archiveCacheDirectory,
      readRoots: [directory, source.runtimeRoot], input: { ...saved, runtimeRoot: source.runtimeRoot, entrypoint,
        nativePollProgress: true, failPublication } });
    const cold = await runSource('source-cold', true);
    await cold.stop();
    check(cold.result.failureRetry === true && cold.result.pollProgressDuplicateFree === true
      && cold.result.executionLedgersPreserved === true && cold.result.outputObjects === 0);
    const { compactDirectBuildVersion } = await import(pathToFileURL(path.join(sync.codeRoot,
      'integration/cloud/automatic-release-build.mjs')).href);
    const compact = compactDirectBuildVersion === 1;
    const diskReserve = { start: (compact ? 1024 : 2560) * MiB, inProgress: (compact ? 256 : 2560) * MiB };
    check(await freeDisk(directory) >= diskReserve.start);
    const builder = { codeRoot: sync.codeRoot, builderSha256: sync.builderSha256, rendererBuild: sync.rendererBuild,
      journals: sync.journals, baselineRoot: sync.baselineRoot, archiveBaseline: sync.baselineRoot,
      initialBaseline: sync.baselineRoot, cacheRoot: path.join(root, 'work', 'archive-cache'),
      baselineManifestSha256: driverAuditSourceHash(await readPrivateDriverAuditSource(path.join(sync.baselineRoot, 'files.private.json'))),
      compactDirectBuildVersion: compactDirectBuildVersion ?? null };
    let downloaded = 0;
    const builderFiles = new Map();
    const readArchive = async (key, limit) => {
      signal.throwIfAborted();
      check(/^[a-f0-9]{64}\.gz$/.test(key ?? '') && integer(limit) && limit > 0);
      if (builderFiles.has(key)) return builderFiles.get(key);
      const maximum = Math.min(limit, 8 * MiB, archiveDownloadLimit - downloaded);
      check(maximum > 0 && builderFiles.size < 4096 && await freeDisk(directory) >= replayDiskReserve + maximum);
      const parts = []; let bytes = 0;
      for await (const chunk of await context.readArchive(key, { maxBytes: maximum, signal })) {
        bytes += chunk.length; check(bytes <= maximum); parts.push(chunk);
      }
      const data = Buffer.concat(parts, bytes);
      check(bytes > 0 && `${driverAuditSourceHash(data)}.gz` === key);
      const file = path.join(directory, 'builder', key);
      await fs.writeFile(file, data, { mode: 0o600, flag: 'wx' });
      downloaded += bytes;
      builderFiles.set(key, file);
      return file;
    };
    const built = await replayChild({ phase: 'builder', mode: 'builder', directory, signal, archiveCacheDirectory, readArchive,
      readRoots: [directory, sync.codeRoot, sync.baselineRoot, builder.cacheRoot, sync.journals.path],
      input: { objectsRoot: saved.objectsRoot, sourceRoot: cold.root, builder, diskReserve } });
    try {
      const memoryAvailableWithBuilderBytes = await linuxMemoryAvailable();
      check(memoryAvailableWithBuilderBytes >= cold.result.peakRssBytes + memorySafetyReserve);
      const warm = await runSource('source-warm', false);
      await warm.stop();
      check(warm.result.pollProgressDuplicateFree === true && warm.result.executionLedgersPreserved === true
        && warm.result.outputObjects === 0 && warm.result.reportHash === cold.result.reportHash
        && warm.result.generation === cold.result.generation);
      await fs.access(`/proc/${built.pid}/stat`);
      const receipt = { version: 1, kind: qualificationKind, verified: true, platform: 'linux', ...binding,
        qualifiedAt: new Date().toISOString(), builderCandidateManifestSha256: built.result.candidateManifestSha256,
        deliveryScopeFixtureVerified: true,
        measurements: { coldArchiveReads: cold.result.archiveReads, warmArchiveReads: warm.result.archiveReads,
          sourcePeakBytes: Math.max(cold.result.peakRssBytes, warm.result.peakRssBytes), builderPeakBytes: built.result.peakRssBytes,
          memoryAvailableWithBuilderBytes, fixtureArchiveBytes: saved.objectBytes, builderArchiveBytes: downloaded },
        transferUsage: { before, after: validateDriverAuditSourceTransferUsage(await context.readTransferUsage()) } };
      await context.writeQualification(requireHostedDriverAuditQualification(receipt, binding));
    } finally { await built.stop(); }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

async function main(args, env = process.env) {
  check(args.length === 1);
  const [operation] = args, settings = hostedDriverAuditWorkerSettings(env, operation);
  const mode = operation === '--scheduled' ? '--once' : operation;
  const { openDriverAuditHostedWorkerBootstrap } = await import('./driverAuditHostedWorkerBootstrap.js');
  const previousUmask = process.umask(0o077), stopped = new AbortController();
  const cancel = () => stopped.abort(Error('Hosted report worker interrupted.'));
  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'];
  for (const name of signals) process.on(name, cancel);
  const signal = stopped.signal;
  let workspace, context;
  try {
    check(path.isAbsolute(env.RUNNER_TEMP ?? '') && await fs.realpath(env.RUNNER_TEMP) === env.RUNNER_TEMP);
    const cacheBundle = path.join(env.RUNNER_TEMP, 'driver-report-worker-cache-v1', 'archive.aes');
    check(env.DRIVER_AUDIT_WORKER_CACHE_BUNDLE === cacheBundle);
    if (mode === '--once') await requirePrivateDriverAuditSourceDirectory(path.dirname(cacheBundle));
    const root = path.join(env.RUNNER_TEMP, 'driver-reports-worker');
    await fs.mkdir(root, { mode: 0o700 });
    workspace = root;
    await requirePrivateDriverAuditSourceDirectory(root);
    context = await openDriverAuditHostedWorkerBootstrap({ root, ...settings, signal, mode });
    const { preflightInput, syncFile, sourceFile, fixtureSha256 } = context;
    const verified = await preflightDriverAuditHostedBootstrap(preflightInput);
    const sync = JSON.parse(await readPrivateDriverAuditSource(syncFile, MiB));
    const source = await readDriverAuditSourceConfig(sourceFile);
    check(preflightInput.root === root && syncFile === path.join(root, 'sync.json')
      && sourceFile === path.join(root, 'collector', verified.sourceManifestSha256, 'source.json')
      && source.configSha256 === preflightInput.sourceConfigSha256 && sync.lightReader === true && sync.incrementalDeliveries === true
      && verified.hostedSlotClaimsConfigured === true && verified.photoRecoveryStore === 'supabase'
      && source.environment.MATTER_SUPABASE_SECRET === settings.supabaseSecret && digest(fixtureSha256));
    const configuration = { root, syncFile, sourceFile, sync, source };
    const { syncSha256, sourceConfigSha256, pinsSha256, activationSha256 } = preflightInput;
    const binding = { releaseSha: settings.releaseSha, bootstrapSha256: settings.bootstrapSha256, nodeVersion,
      fixtureSha256, syncSha256, sourceConfigSha256, pinsSha256, activationSha256 };
    if (mode === '--qualify') {
      await qualifyWorker(context, configuration, binding, signal);
      console.info('Hosted report worker Linux qualification verified.');
      return;
    }
    const qualification = requireHostedDriverAuditQualification(await context.readQualification(), binding);
    const enrollment = requireHostedDriverAuditEnrollment(JSON.parse(await readPrivateDriverAuditSource(
      path.join(root, 'launch-verified.private.json'), 32 * 1024)), binding, qualification);
    await context.restoreCheckpoint({ qualification, enrollment });
    let exitCode;
    try { exitCode = await runWorker(configuration, '--once', signal, settings.expectedScheduledAt); }
    finally { await allowEncryptedCacheSave(env, cacheBundle, await context.writeCheckpoint({ qualification, enrollment })); }
    if (exitCode === driverAuditHostedSlotSkippedExitCode) {
      console.error(`Hosted report worker skipped the ${settings.expectedScheduledAt} scheduled slot.`);
      process.exitCode = exitCode;
    } else {
      console.info(settings.expectedScheduledAt ? `Hosted report worker completed its ${settings.expectedScheduledAt} slot check.`
        : 'Hosted report worker completed its eligible-slot check.');
    }
  } finally {
    settings.cacheKey.fill(0);
    try { await context?.close(); }
    finally {
      if (workspace) await fs.rm(workspace, { recursive: true, force: true });
      for (const name of signals) process.removeListener(name, cancel);
      process.umask(previousUmask);
    }
  }
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => {
    console.error('The hosted report worker is held. Check the private bootstrap, qualification and recovery receipts.');
    process.exitCode = 1;
  });
}
