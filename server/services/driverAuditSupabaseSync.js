import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { getBusinessDayBounds } from '../utils/businessDate.js';
import { createDriverAuditSupabaseAppBackend } from './driverAuditSupabaseAppBackend.js';
import { createDriverAuditSupabaseReplica, verifyDriverAuditSupabaseServingPackage } from './driverAuditSupabaseReplica.js';
import { writeDriverAuditSourceState } from './driverAuditSource.js';
import { withDriverAuditHeavyWork } from './driverAuditHeavyWork.js';
import { saveDriverAuditBuildRecipe } from './driverAuditBuildRecipe.js';
import { describeDriverAuditSyncFailure, runDriverAuditSyncTick, savedAuditTransferBlock } from './driverAuditSync.js';
import { acquireWorkerLock } from '../vendor/driver-audits/integration/hosted/worker-lock.mjs';
import { createCloudState } from '../vendor/driver-audits/integration/cloud/cloud-state.mjs';
import { createBudgetedAuditArchive, createBudgetedAuditState } from '../vendor/driver-audits/integration/cloud/driver-audit-archive.mjs';
import { prepareDirectAuditBundle, privateAuditWrite, verifyAuditBuilder } from '../vendor/driver-audits/integration/cloud/driver-audit-handoff.mjs';
import { checkVerifiedAuditPackageTransfer } from '../vendor/driver-audits/integration/cloud/remote-preview-package.mjs';

const minute = 60_000;
const idleHeartbeatInterval = 5 * minute;
const mainCheckOffset = (10 * 60 + 30) * minute;
const noonCheckOffset = 12 * 60 * minute;
const packageLimit = 128 * 1024 ** 2;
const chunkLimit = 8 * 1024 ** 2;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const check = (condition, message) => { if (!condition) throw Error(message); };
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const inside = (root, target) => path.isAbsolute(target || '') && target === path.resolve(target)
  && target.startsWith(root + path.sep);

function reportSchedule(now) {
  const { startOfDay, endOfDayExclusive } = getBusinessDayBounds(now);
  const main = startOfDay.getTime() + mainCheckOffset;
  const noon = startOfDay.getTime() + noonCheckOffset;
  if (now < main) return { dueAt: null, nextAt: main };
  if (now < noon) return { dueAt: main, nextAt: noon };
  return { dueAt: noon, nextAt: endOfDayExclusive.getTime() + mainCheckOffset };
}

async function privateDirectory(directory) {
  check(path.isAbsolute(directory || '') && path.resolve(directory) === directory, 'An absolute private sync directory is required');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  check(info.isDirectory() && info.uid === process.getuid() && !(info.mode & 0o077)
    && await fs.realpath(directory) === directory, 'Sync directories must be owner-private real paths');
}

async function privateBytes(file, maximum = 16 * 1024 ** 2) {
  check(path.isAbsolute(file || '') && path.resolve(file) === file, 'An absolute private sync file is required');
  const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    check(before.isFile() && before.uid === process.getuid() && !(before.mode & 0o077)
      && before.size > 0 && before.size <= maximum && await fs.realpath(file) === file,
    'Sync inputs must be bounded owner-private regular files');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      check(bytesRead > 0, 'Private sync input changed while reading'); offset += bytesRead;
    }
    const after = await handle.stat();
    check(after.isFile() && after.uid === before.uid && after.mode === before.mode && after.size === before.size
      && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs,
    'Private sync input changed while reading');
    return bytes;
  } finally { await handle.close(); }
}

async function privateJson(file, maximum) { return JSON.parse(await privateBytes(file, maximum)); }
async function optionalJson(file, maximum) {
  try { return await privateJson(file, maximum); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function checkedConfiguration({ config, file }) {
  check(config?.version === 1 && path.isAbsolute(config.root || '') && path.resolve(config.root) === config.root
    && file === path.join(config.root, 'sync.json') && config.baselineRoot === path.join(config.root, 'baseline')
    && config.codeRoot === path.join(config.root, 'builder') && hex(config.builderSha256)
    && config.rendererBuild?.path === path.join(config.baselineRoot, 'build.private.json') && hex(config.rendererBuild.sha256)
    && config.journals?.path === path.join(config.root, 'validation-journals.private.json') && hex(config.journals.sha256),
  'Invalid staged Sidi Supabase sync configuration');
  for (const directory of [config.root, config.baselineRoot, config.codeRoot]) await privateDirectory(directory);
  const bytes = await privateBytes(file, 1024 * 1024);
  check(isDeepStrictEqual(JSON.parse(bytes), config), 'Staged Sidi Supabase sync configuration changed');
  await verifyAuditBuilder(config.codeRoot, config.builderSha256);
  for (const ref of [config.rendererBuild, config.journals]) {
    check(sha(await privateBytes(ref.path)) === ref.sha256, 'Pinned Sidi audit builder input changed');
  }
  const baseline = await privateBytes(path.join(config.baselineRoot, 'files.private.json'));
  check(Object.keys(JSON.parse(baseline)).length > 0, 'The original Sidi audit baseline is required');
  return { configSha256: sha(bytes), baselineManifestSha256: sha(baseline) };
}

function seedPointer(seed, root) {
  check(seed?.version === 1 && ['bootstrap', 'sync'].includes(seed.mode) && inside(root, seed.bundleRoot)
    && positive(seed.collectorRevision) && hex(seed.sourceBasis) && hex(seed.manifestSha256)
    && seed.pointer?.version === 1 && hex(seed.pointer.generation) && hex(seed.pointer.reportHash),
  'An exact original private audit seed is required');
  return {
    version: 1, generation: seed.pointer.generation, reportHash: seed.pointer.reportHash,
    descriptor: seed.pointer.descriptor,
    servingPackage: { version: 1, dataStore: 'supabase', collectorRevision: seed.collectorRevision,
      sourceBasis: seed.sourceBasis, manifestSha256: seed.manifestSha256 },
    visibleCutoffAt: seed.visibleCutoffAt, closureReceipt: seed.closureReceipt, restore: seed.restore,
    previous: seed.pointer.previous ?? null,
  };
}

// These are the existing Workspace compact-builder limits. Keep this small
// filesystem guard independent of the legacy replica/retirement dependencies.
function requireBuildSpace(bytes, { compact, inProgress = false }) {
  const requiredBytes = compact ? (inProgress ? 256 : 1024) * 1024 ** 2 : 2560 * 1024 ** 2;
  if (!Number.isSafeInteger(bytes) || bytes < requiredBytes) throw Object.assign(Error('Audit disk reserve unavailable'), {
    code: 'AUDIT_CAPACITY', capacity: { kind: 'build-disk', availableBytes: Number.isSafeInteger(bytes) ? bytes : null, requiredBytes },
  });
}

// The injectable backend is a testable service boundary, never a CLI/env hook.
// The public runner below always opens the explicitly selected Sidi backend.
export async function createDriverAuditSupabaseSync({ config, file, backend, collectSource, signal, clock = Date.now } = {}) {
  config = structuredClone(config);
  const pins = await checkedConfiguration({ config, file });
  const { root, baselineRoot, codeRoot, builderSha256, rendererBuild, journals } = config;
  const work = path.join(root, 'work'), cache = path.join(work, 'archive-cache');
  const executionHost = backend?.executionHost;
  check(backend?.kind === 'supabase' && ['sidi', 'off-host'].includes(executionHost) && backend.executionAdmission === 'fixed-host-v1'
    && backend.transferAccounting === 'supabase-http-bytes-v1' && backend.archive?.managedReadCache === true
    && backend.archiveCacheDirectory === cache && typeof backend.rpc === 'function'
    && typeof backend.rpcForResponseLimit === 'function' && typeof backend.readTransferUsage === 'function'
    && typeof backend.archiveReadBudget?.reserve === 'function' && typeof backend.archiveReadBudget?.settle === 'function'
    && typeof clock === 'function', 'The qualified Sidi Supabase backend and managed cache are required');
  check(collectSource === undefined || executionHost === 'off-host' && typeof collectSource === 'function',
    'Managed source checks require the off-host worker');
  signal?.throwIfAborted();
  for (const directory of [work, cache, path.join(root, 'archive-receipts')]) await privateDirectory(directory);
  const lock = await acquireWorkerLock(path.join(path.dirname(root), 'sync-worker.lock'));
  try {
    await backend.archive.assertPrivate();
    signal?.throwIfAborted();
    const load = name => import(pathToFileURL(path.join(codeRoot, name)).href);
    const [{ automaticReleaseBasis, createAutomaticRelease }, { createAutomaticReleaseSource, supportsManagedArchiveCache },
      { buildAutomaticRelease, compactDirectBuildVersion }, { validateAutomaticCandidate }] = await Promise.all([
      load('integration/cloud/automatic-release.mjs'), load('integration/cloud/automatic-release-source.mjs'),
      load('integration/cloud/automatic-release-build.mjs'), load('scripts/run-automatic-report.mjs'),
    ]);
    check(supportsManagedArchiveCache === true && [automaticReleaseBasis, createAutomaticRelease,
      createAutomaticReleaseSource, buildAutomaticRelease, validateAutomaticCandidate].every(fn => typeof fn === 'function'),
    'The pinned managed Sidi audit builder is required');
    // Pointer and capacity responses are small. The larger evidence and review
    // reads below have separate bounds so this check can keep serving on a tight day.
    const controlRpc = backend.rpcForResponseLimit(768 * 1024);
    const state = createCloudState({ rpc: controlRpc }), remote = backend.archive;
    const replica = createDriverAuditSupabaseReplica({ state, archive: remote });
    const budgetOverride = backend.archiveReadBudget;
    const archive = createBudgetedAuditArchive({ rpc: controlRpc, state, remote,
      receiptRoot: path.join(root, 'archive-receipts'), budgetOverride });
    const boundedState = responseLimit => createBudgetedAuditState({
      state: createCloudState({ rpc: backend.rpcForResponseLimit(responseLimit) }), budgetState: state, responseLimit, budgetOverride,
    });
    const sourceState = boundedState(2 * 1024 ** 2), reviewState = boundedState(8 * 1024 ** 2);
    const receiptState = createCloudState({ rpc: backend.rpcForResponseLimit(2 * 1024 ** 2) });
    const loadSource = createAutomaticReleaseSource({ stateStore: sourceState, cacheRoot: cache, localRoots: [baselineRoot],
      skipCacheWrite: true, archiveTransport: { readObject: archive.readBounded, managedReadCache: true } });
    const recipe = { builderSha256, rendererSha256: rendererBuild.sha256, journalsSha256: journals.sha256,
      baselineManifestSha256: pins.baselineManifestSha256 };
    let pinned, closed = false;
    const heartbeat = path.join(root, 'sync-status.private.json');
    const readHeartbeat = () => optionalJson(heartbeat, 64 * 1024);
    const freeBytes = async directory => { const disk = await fs.statfs(directory); return disk.bavail * disk.bsize; };
    const transferBlockFile = path.join(work, 'transfer-block.private.json');
    const transferPolicy = { version: 1, maxBytes: packageLimit, builderSha256,
      rendererSha256: rendererBuild.sha256, journalsSha256: journals.sha256 };
    const current = () => optionalJson(path.join(work, 'current.private.json'));

    async function originalCollectorReceipt(collectorRevision, sourceBasis, visibleCutoffAt) {
      const [receipt] = await receiptState.receipts('collector-state', { after: collectorRevision - 1 });
      check(receipt?.revision === collectorRevision,
        'The original collector receipt revision does not match the package');
      const publication = JSON.parse(receipt.body_text);
      check(automaticReleaseBasis(publication) === sourceBasis,
      'The original collector receipt does not match the package source basis');
      check(iso(publication.head.source?.observedAt) === iso(visibleCutoffAt),
        'The original collector source cutoff does not match the package');
      return receipt;
    }

    function writeHeartbeat(value, now, nextAt) {
      return writeDriverAuditSourceState(heartbeat, { capacity: null, ...value, version: 1, dataStore: 'supabase', executionHost,
        replicaGcStatus: 'disabled-supabase',
        heartbeatAt: new Date(now).toISOString(), nextCheckAt: new Date(nextAt).toISOString() });
    }

    async function status(value) {
      const active = await replica.head();
      const prior = await readHeartbeat(), now = clock();
      await writeHeartbeat({ lastScheduledAt: prior?.lastScheduledAt ?? null, ...value,
        activeGeneration: active?.generation ?? null, checkedAt: new Date(now).toISOString() }, now, reportSchedule(now).nextAt);
    }

    const builder = createAutomaticRelease({ root: work, baselineRoot, pinnedDirectSync: true, loadSource: async () => pinned,
      async build(options) {
        signal?.throwIfAborted();
        const [output, baseline] = await Promise.all([fs.stat(options.output), fs.stat(options.baselineRoot)]);
        const compact = compactDirectBuildVersion === 1 && output.dev === baseline.dev;
        requireBuildSpace(await freeBytes(work), { compact });
        await saveDriverAuditBuildRecipe(options.output, recipe);
        return buildAutomaticRelease({ ...options, rendererBuild, archiveBackedBaseline: true,
          checkSpace: async () => requireBuildSpace(await freeBytes(work), { compact, inProgress: true }) });
      },
      async validate(candidate) {
        const validation = await validateAutomaticCandidate(candidate, { journals });
        if (!validation.ok) return validation;
        try { checkVerifiedAuditPackageTransfer({ privateRoot: candidate.privateRoot, maxBytes: packageLimit, validation }); }
        catch (error) {
          if (error.code === 'AUDIT_CAPACITY' && error.capacity?.kind === 'import-transfer') {
            const prior = await current();
            await privateAuditWrite(transferBlockFile, JSON.stringify({ ...transferPolicy, sourceBasis: candidate.sourceBasis ?? candidate.basis,
              baselineManifestSha256: prior?.manifestSha256 ?? pins.baselineManifestSha256,
              candidateManifestSha256: validation.manifestSha256, capacity: error.capacity }));
          }
          throw error;
        }
        return validation;
      },
    });

    async function unchangedInputs() {
      check(!closed, 'The Sidi audit sync has closed');
      signal?.throwIfAborted();
      check(sha(await privateBytes(file, 1024 * 1024)) === pins.configSha256, 'Pinned Sidi sync configuration changed');
      await verifyAuditBuilder(codeRoot, builderSha256);
      for (const ref of [rendererBuild, journals]) {
        check(sha(await privateBytes(ref.path)) === ref.sha256, 'Pinned Sidi audit builder input changed');
      }
      check(sha(await privateBytes(path.join(baselineRoot, 'files.private.json'))) === pins.baselineManifestSha256,
        'Pinned Sidi audit baseline manifest changed');
    }

    const underAdmission = async operation => {
      await unchangedInputs();
      const heavyRoot = executionHost === 'off-host' ? path.join(root, 'driver-audit-heavy-work')
        : path.resolve(root, '../../driver-audit-heavy-work');
      const result = await withDriverAuditHeavyWork({ root: heavyRoot, owner: 'sync', signal,
        async onWaiting() {
          const prior = await readHeartbeat();
          await status({ status: 'pending', pending: true, errorCode: null, admission: 'waiting',
            latestCaptureAt: prior?.latestCaptureAt ?? null, visibleCutoffAt: prior?.visibleCutoffAt ?? null });
        } }, async () => { await unchangedInputs(); return operation(); });
      signal?.throwIfAborted();
      return result;
    };

    async function seed() {
      return underAdmission(async () => {
        const seed = await privateJson(path.join(root, 'seed.json'), 1024 * 1024), head = seedPointer(seed, root);
        await privateDirectory(seed.bundleRoot);
        const local = { async readObject(key, { maxBytes }) {
          check(/^[a-f0-9]{64}\.gz$/.test(key) && positive(maxBytes) && maxBytes <= chunkLimit, 'Invalid private seed object request');
          return [await privateBytes(path.join(seed.bundleRoot, key), maxBytes)];
        } };
        const packages = [];
        for (const selected of [head, head.previous].filter(Boolean)) {
          packages.push({ head: selected, proof: await verifyDriverAuditSupabaseServingPackage({ head: selected, archive: local }) });
        }
        // This reads already retained originals, never delivery/GPS providers or
        // a model. A valid rendered package cannot relabel its collector origin.
        for (const { head: selected } of packages) {
          await originalCollectorReceipt(selected.servingPackage.collectorRevision, selected.servingPackage.sourceBasis,
            selected.visibleCutoffAt);
        }
        const objects = new Map();
        for (const { head: selected, proof } of packages) for (const ref of [selected.descriptor, ...Object.values(proof.descriptor.files)]) {
          for (const chunk of ref.chunks) {
            const key = chunk.sha256 + '.gz';
            check(!objects.has(key) || objects.get(key) === chunk.size, 'Conflicting original seed object sizes');
            objects.set(key, chunk.size);
          }
        }
        const expected = await replica.head();
        if (expected) check(expected.servingPackage.collectorRevision === head.servingPackage.collectorRevision
          && expected.servingPackage.sourceBasis === head.servingPackage.sourceBasis
          && expected.servingPackage.manifestSha256 === head.servingPackage.manifestSha256
          && expected.descriptor.sha256 === head.descriptor.sha256 && expected.generation === head.generation
          && expected.reportHash === head.reportHash, 'An existing Supabase report cannot be replaced by the bootstrap seed');
        for (const [key, size] of objects) {
          signal?.throwIfAborted();
          await archive.verify(key, size, () => privateBytes(path.join(seed.bundleRoot, key), size));
        }
        signal?.throwIfAborted();
        await unchangedInputs();
        const result = await replica.activate({ expected, head: expected ? { ...head, previous: null } : head });
        await status({ status: 'pending', pending: true, errorCode: null, latestCaptureAt: null,
          visibleCutoffAt: result.head.visibleCutoffAt });
        return result;
      });
    }

    async function tick({ scheduledAt = null } = {}) {
      try {
        const sync = () => runDriverAuditSyncTick({
          async readSource() {
            signal?.throwIfAborted();
            pinned = await loadSource();
            return { revision: pinned.savedState.revision, basis: automaticReleaseBasis(pinned.publication),
              observedAt: iso(pinned.publication.head.source?.observedAt) };
          },
          readHead: () => replica.head(), getCandidate: current,
          async build(latest) {
            const prior = await current(), block = await optionalJson(transferBlockFile);
            const capacity = savedAuditTransferBlock(block, { sourceBasis: latest.basis,
              baselineManifestSha256: prior?.manifestSha256 ?? pins.baselineManifestSha256, policy: transferPolicy });
            if (capacity) throw Object.assign(Error('Saved audit evidence exceeds the transfer bound'), { code: 'AUDIT_CAPACITY', capacity });
            signal?.throwIfAborted();
            return builder.tick();
          },
          async apply(candidate) {
            check(positive(candidate?.collectorRevision) && hex(candidate.sourceBasis) && hex(candidate.manifestSha256)
              && inside(path.join(work, 'attempts'), candidate.privateRoot), 'Invalid pinned Sidi audit candidate');
            const manifestBytes = await privateBytes(path.join(candidate.privateRoot, 'files.private.json'));
            check(sha(manifestBytes) === candidate.manifestSha256,
              'Pinned Sidi audit candidate manifest changed');
            const publicationBytes = await privateBytes(path.join(candidate.privateRoot, 'publication.private.json'));
            check(sha(publicationBytes) === JSON.parse(manifestBytes)['publication.private.json'],
              'Pinned Sidi audit publication changed');
            const sourceCutoffAt = iso(JSON.parse(publicationBytes).head?.source?.observedAt);
            await originalCollectorReceipt(candidate.collectorRevision, candidate.sourceBasis, sourceCutoffAt);
            const prepared = await prepareDirectAuditBundle({ privateRoot: candidate.privateRoot,
              bundleRoot: path.join(path.dirname(candidate.privateRoot), 'audit-objects'),
              validation: { ok: true, manifestSha256: candidate.manifestSha256 }, archive, reviewState,
              collectorRevision: candidate.collectorRevision, sourceBasis: candidate.sourceBasis, mode: 'sync',
              metadataRoot: path.join(work, 'metadata') });
            prepared.closureReceipt.collectorRevision = candidate.collectorRevision;
            check(prepared.visibleCutoffAt === sourceCutoffAt, 'Prepared Sidi audit source cutoff changed');
            await privateAuditWrite(path.join(path.dirname(candidate.privateRoot), 'supabase-seed.private.json'), JSON.stringify(prepared));
            signal?.throwIfAborted();
            const currentSource = await sourceState.read('collector-state');
            check(currentSource.revision >= candidate.collectorRevision, 'The original collector source moved backwards');
            await unchangedInputs();
            const expected = await replica.head();
            await replica.activate({ expected, head: seedPointer(prepared, root) });
          },
          status, preferLatestEvidence: scheduledAt !== null,
        });
        return await underAdmission(async () => {
          if (scheduledAt !== null) {
            const prior = await readHeartbeat(), now = clock();
            // Record the slot before any source work. A held worker waiting
            // for admission cannot consume the slot by starting and stopping.
            await writeHeartbeat({ ...prior, status: 'pending', pending: true, admission: 'running', errorCode: null, capacity: null,
              lastScheduledAt: new Date(scheduledAt).toISOString() }, now, reportSchedule(now).nextAt);
          }
          return sync();
        });
      } catch (error) {
        const active = await replica.head().catch(() => null), prior = await readHeartbeat().catch(() => null);
        await status({ ...describeDriverAuditSyncFailure(error), pending: true,
          latestCaptureAt: prior?.latestCaptureAt ?? null, visibleCutoffAt: active?.visibleCutoffAt ?? null }).catch(() => {});
        throw error;
      }
    }

    async function scheduledTick() {
      check(!closed, 'The Sidi audit sync has closed');
      signal?.throwIfAborted();
      const { dueAt, nextAt } = reportSchedule(clock());
      const saved = await readHeartbeat() ?? { status: 'pending', pending: true };
      // Catch up at most the latest elapsed slot for this Dubai day.
      if (dueAt !== null && dueAt > (Date.parse(saved.lastScheduledAt) || -Infinity)) {
        try {
          if (executionHost === 'off-host') {
            check(collectSource, 'The off-host source checker is required');
            await unchangedInputs();
            await collectSource({ dueAt, signal, async onAdmission() {
              signal?.throwIfAborted();
              await writeHeartbeat({ ...saved, status: 'checking', pending: true, errorCode: null,
                lastScheduledAt: new Date(dueAt).toISOString() }, clock(), nextAt);
            } });
          }
          await tick({ scheduledAt: dueAt });
        }
        catch (error) {
          signal?.throwIfAborted();
          const prior = await readHeartbeat() ?? saved;
          await writeHeartbeat({ ...prior, ...describeDriverAuditSyncFailure(error), pending: true,
            lastScheduledAt: new Date(dueAt).toISOString() }, clock(), nextAt);
          throw error;
        }
      } else {
        // An idle heartbeat neither reads Supabase nor advances evidence clocks.
        // Any persisted admission belongs to a previous process, not this idle one.
        delete saved.admission;
        if (saved.status === 'checking') Object.assign(saved, { status: 'pending', pending: true });
        await writeHeartbeat(saved, clock(), nextAt);
      }
      return Math.min(nextAt, clock() + idleHeartbeatInterval);
    }

    return Object.freeze({ seed, tick, scheduledTick,
      async check() { return underAdmission(async () => {
        const active = await replica.head();
        check(active, 'A verified Supabase audit seed is required');
        return { status: 'checked', dataStore: 'supabase', executionHost, activeGeneration: active.generation,
          collectorRevision: active.servingPackage.collectorRevision, replicaGcStatus: 'disabled-supabase' };
      }); },
      async close() { if (!closed) { closed = true; await lock.release(); } },
    });
  } catch (error) { await lock.release(); throw error; }
}

export async function runDriverAuditSupabaseSync({ config, file, mode, collectSource, env = process.env } = {}) {
  const executionHost = env.DRIVER_AUDIT_EXECUTION_HOST;
  check(['sidi', 'off-host'].includes(executionHost) && (env.DRIVER_AUDIT_DATA_STORE || 'supabase') === 'supabase'
    && env.DRIVER_AUDIT_IMPORT_ENABLED === '0'
    && (env.DRIVER_AUDIT_ENABLED === '1' || mode === '--seed-only' && env.DRIVER_AUDIT_ENABLED === '0')
    && [undefined, '--check', '--seed-only'].includes(mode)
    && (executionHost !== 'off-host' || mode !== undefined || typeof collectSource === 'function'),
  'Explicit managed Supabase sync with import disabled is required');
  const stop = new AbortController();
  const onStop = () => { if (!stop.signal.aborted) stop.abort(Error('Sidi audit sync stopped')); };
  for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(name, onStop);
  let worker;
  try {
    await checkedConfiguration({ config, file });
    const cache = path.join(config.root, 'work', 'archive-cache'); await privateDirectory(cache);
    stop.signal.throwIfAborted();
    const backend = await createDriverAuditSupabaseAppBackend({ env: { ...env, MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY: cache } });
    worker = await createDriverAuditSupabaseSync({ config, file, backend, collectSource, signal: stop.signal });
    if (mode === '--check' || mode === '--seed-only') {
      const result = await (mode === '--check' ? worker.check() : worker.seed());
      console.info(JSON.stringify({ status: result.status, dataStore: 'supabase', executionHost,
        activeGeneration: result.activeGeneration ?? result.head?.generation ?? null }));
      return result;
    }
    if (executionHost === 'off-host') await worker.check();
    while (!stop.signal.aborted) {
      const now = Date.now();
      let wakeAt = Math.min(reportSchedule(now).nextAt, now + idleHeartbeatInterval);
      try { wakeAt = await worker.scheduledTick(); }
      catch (error) {
        if (stop.signal.aborted) break;
        console.error('Driver Reports retained the last verified report. See private sync status.');
      }
      if (stop.signal.aborted) break;
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); stop.signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, Math.max(0, wakeAt - Date.now()));
        stop.signal.addEventListener('abort', done, { once: true });
        if (stop.signal.aborted) done();
      });
    }
  } finally {
    try { await worker?.close(); }
    finally { for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.removeListener(name, onStop); }
  }
}
