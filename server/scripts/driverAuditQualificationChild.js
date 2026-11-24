import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import fs from 'node:fs/promises';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';
import { getHeapStatistics } from 'node:v8';
import { DRIVER_AUDIT_SOURCE_CACHE_ENV, driverAuditSourceHash as sha256, invokeDriverAuditSourceHandler } from '../services/driverAuditSource.js';
import { createDriverAuditFixedHostBudgetFactory } from '../services/driverAuditFixedHostBudget.js';
import { createDriverAuditReadCache } from '../services/driverAuditReadCache.js';
import { createDriverAuditPollProgress, validateDriverAuditPollProgressWrite } from '../services/driverAuditPollProgress.js';

const MiB = 1024 * 1024;
const OriginalDate = Date;
const archiveKey = /^[a-f0-9]{64}\.gz$/;
let lastPhase = null;
const fakeEnvironment = {
  CRON_SECRET: 'isolated-saved-collector-replay-only',
  MATTER_SUPABASE_SECRET: 'isolated-saved-state-no-real-key',
  MATTER_DELIVERY_API_KEY: 'isolated-source-never-called',
  MATTER_DELIVERY_ENABLED: '1',
  MATTER_PHOTO_READ_ENABLED: '1',
  MATTER_PHOTO_GRADE_ENABLED: '1',
  MATTER_GPS_ENABLED: '1',
  MATTER_GPS_PUBLICATION_ENABLED: '1',
};

const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const load = file => import(pathToFileURL(file).href);
const readState = async file => new Map((await json(file)).rows.map(({ key, revision, body }) => [key, { revision, body }]));

function blockNetwork() {
  let attempts = 0;
  const deny = () => { attempts++; throw new Error('Qualification network or subprocess attempt.'); };
  globalThis.fetch = deny;
  if (globalThis.WebSocket) globalThis.WebSocket = deny;
  if (globalThis.EventSource) globalThis.EventSource = deny;
  for (const [target, operations] of [
    [http, ['request', 'get', 'createServer']], [https, ['request', 'get', 'createServer']],
    [http2, ['connect', 'createServer', 'createSecureServer']], [net, ['connect', 'createConnection', 'createServer']],
    [tls, ['connect', 'createServer']], [dgram, ['createSocket']],
    [dns, ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'reverse']],
    [dns.promises, ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'reverse']],
    [childProcess, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']],
  ]) for (const operation of operations) target[operation] = deny;
  syncBuiltinESMExports();
  return () => attempts;
}

async function checkArchiveFile(file, key, maxBytes) {
  const stat = await fs.lstat(file);
  assert(stat.isFile() && stat.uid === process.getuid() && !(stat.mode & 0o077)
    && stat.size > 0 && stat.size <= maxBytes && await fs.realpath(file) === file, 'Unsafe qualification archive object.');
  const bytes = await fs.readFile(file);
  assert.equal(sha256(bytes) + '.gz', key, 'Qualification archive object changed.');
  return bytes;
}

function createLocalTransport(roots, fallback) {
  return async (key, maxBytes = 16 * MiB) => {
    assert(archiveKey.test(key) && Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 256 * MiB, 'Invalid qualification archive key.');
    for (const [root, baseline] of roots) {
      const file = path.join(root, baseline ? 'archive-' + key.slice(0, -3) + '.private.bin' : key);
      const bytes = await checkArchiveFile(file, key, maxBytes).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (bytes) return bytes;
    }
    if (fallback) return checkArchiveFile(await fallback(key, maxBytes), key, maxBytes);
    throw Object.assign(new Error('Saved archive object unavailable.'), { code: 'ENOENT' });
  };
}

function createReplayState(state, day, time, capture, { appReplay, nativePollProgress }) {
  const prior = state.get('collector-state');
  const publication = JSON.parse(prior.body);
  const recentDays = Array.from({ length: 3 }, (_, offset) =>
    new OriginalDate(Date.parse(day + 'T00:00:00Z') - offset * 86_400_000).toISOString().slice(0, 10));
  const attempts = Object.fromEntries(recentDays.map(key => [key, time]));
  publication.schedule = { ...publication.schedule,
    pending: [{ day, runId: capture.runId, final: false, fresh: false, sourceStarted: true, attempts: 0, nextAttempt: 0 }],
    lastDay: day, sourceAttempts: { ...publication.schedule?.sourceAttempts, ...attempts },
    lastAttempts: { ...publication.schedule?.lastAttempts, ...attempts } };
  if (nativePollProgress) {
    state.set('native-progress:delivery', { revision: 0, body: JSON.stringify({ version: 1,
      kind: 'native-delivery-poll-progress', schedule: publication.schedule,
      photoCursor: publication.photoCursor ?? 0, photoSourceHalt: publication.photoSourceHalt ?? null,
      lastPoll: null, lastSuccessfulPollAt: null, lastDataChangeAt: null }) });
  } else state.set('collector-state', { ...prior, body: JSON.stringify(publication) });
  if (!appReplay) {
    const budget = state.get('worker-budget');
    const document = JSON.parse(budget.body);
    const period = new OriginalDate(time).toISOString().slice(0, 7);
    document.latestPeriod = period;
    document.periods = { [period]: { usedMicros: 0, admissions: 0, settlements: 0 } };
    document.active = {};
    state.set('worker-budget', { ...budget, body: JSON.stringify(document) });
  }
  return publication;
}

function createReplayTransport(state, time, readObject, { failPublication, reject, appReplay, nativePollProgress, sidiReplay }) {
  const writes = new Map();
  const reservations = new Map();
  const archiveReads = { requests: 0, bytes: 0 };
  let lease = null;
  let failedOnce = false;
  let failureKind = null;
  const store = key => state.get(key) ?? { revision: 0, body: null };
  const ownsLease = args => lease && lease.owner === args.p_owner && lease.token === args.p_token;
  const commit = (key, args) => {
    const revision = store(key).revision;
    assert.equal(args.p_expected, revision, 'Fixture state revision changed.');
    const event = JSON.parse(args.p_event_text);
    const failurePoint = nativePollProgress
      ? key.startsWith('native-progress:') && event.phase === 'settled'
      : key === 'collector-state' && event.kind === 'report-publication';
    if (failPublication && !failedOnce && failurePoint) {
      failedOnce = true;
      failureKind = nativePollProgress ? 'progress' : 'publication';
      throw new Error('Isolated publication failure.');
    }
    state.set(key, { revision: revision + 1, body: args.p_body_text });
    return { revision: revision + 1, replayed: false, body_text: args.p_body_text,
      event_text: args.p_event_text, body_sha256: sha256(args.p_body_text) };
  };
  const rpc = (name, args) => {
    switch (name) {
      case 'matter_hosted_state_read': {
        const { revision, body } = store(args.p_key);
        return { revision, body_text: body };
      }
      case 'matter_hosted_state_cas':
        assert(!args.p_key.startsWith('native-progress:'), 'Progress requires its collector lease.');
        return commit(args.p_key, args);
      case 'matter_hosted_native_progress_cas':
        validateDriverAuditPollProgressWrite(args);
        assert(ownsLease(args), 'Fixture collector lease changed.');
        return commit(args.p_key, args);
      case 'matter_hosted_collector_cas':
      case 'matter_hosted_collector_cas_review':
        assert(ownsLease(args), 'Fixture collector lease changed.');
        if (name.endsWith('_review')) assert.equal(args.p_expected_review_revision, store('review-journal').revision);
        return commit('collector-state', args);
      case 'matter_hosted_lease_acquire':
        assert.equal(lease, null);
        lease = { owner: args.p_owner, token: '1' };
        return { token: lease.token, expiresAt: new OriginalDate(time + args.p_ttl * 1000).toISOString() };
      case 'matter_hosted_lease_assert': return !!ownsLease(args);
      case 'matter_hosted_lease_release':
        assert(ownsLease(args));
        lease = null;
        return true;
      case 'matter_hosted_archive_capacity':
        return { used_bytes: 0, requested_bytes: args.p_requested_bytes, limit_bytes: 60_000_000_000, allowed: true };
      case 'matter_hosted_archive_reserve': {
        const receipt = { id: args.p_id, reserved_bytes: args.p_reserved_bytes, consumed_bytes: 0, released: false };
        reservations.set(receipt.id, receipt);
        return receipt;
      }
      case 'matter_hosted_archive_consume': {
        const receipt = reservations.get(args.p_id);
        receipt.consumed_bytes += args.p_bytes;
        assert(receipt.consumed_bytes <= receipt.reserved_bytes && !receipt.released);
        return receipt;
      }
      case 'matter_hosted_archive_release': {
        const receipt = reservations.get(args.p_id);
        receipt.released = true;
        return receipt;
      }
      default: return reject();
    }
  };
  const read = (key, limit) => writes.get(key) ?? readObject(key, limit);
  const nativeBackend = {
    kind: sidiReplay ? 'supabase' : 'mongo', rpc: async (name, args) => rpc(name, args),
    ...(sidiReplay ? { executionHost: 'sidi', executionAdmission: 'fixed-host-v1',
      transferAccounting: 'supabase-http-bytes-v1', archiveReadBudget: createDriverAuditFixedHostBudgetFactory()(),
      async readTransferUsage() { return { version: 1, basis: 'supabase-http-bytes-v1',
        month: { period: new OriginalDate(time).toISOString().slice(0, 7), usedBytes: 0, reservedBytes: 0, limitBytes: 8 * 1024 ** 3 },
        day: { period: new OriginalDate(time).toISOString().slice(0, 10), usedBytes: 0, reservedBytes: 0, limitBytes: 512 * MiB },
        activeReservations: 0, uncertainReservations: 0 }; } } : {}),
    pollProgress: createDriverAuditPollProgress({ rpc: async (name, args) => rpc(name, args) }),
    createExecutionBudget: createDriverAuditFixedHostBudgetFactory(),
    archive: {
      async assertPrivate() { return { public: false }; },
      async readObject(key, { maxBytes = 16 * MiB } = {}) {
        assert(archiveKey.test(key) && Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 16 * MiB);
        const body = await read(key, maxBytes);
        assert(body.length <= maxBytes);
        archiveReads.requests++;
        archiveReads.bytes += body.length;
        return [body];
      },
      async putVerifiedObject(key, bytes) {
        assert(Buffer.isBuffer(bytes) && bytes.length <= 16 * MiB && sha256(bytes) + '.gz' === key);
        writes.set(key, Buffer.from(bytes));
        return { key, bytes: bytes.length, sha256: sha256(bytes), verified: true };
      },
    },
  };
  globalThis.fetch = async (input, options = {}) => {
    if (appReplay) return reject();
    const url = new URL(input);
    if (url.origin !== 'https://trhhjfgfmxofxhnzocks.supabase.co' || url.search) return reject();
    if (url.pathname.startsWith('/rest/v1/rpc/') && options.method === 'POST') {
      try { return Response.json(rpc(url.pathname.split('/').at(-1), JSON.parse(options.body))); }
      catch { return Response.json({ code: 'fixture_rejection' }, { status: 503 }); }
    }
    if (url.pathname === '/storage/v1/bucket/matter-report-archive' && options.method === 'GET')
      return Response.json({ id: 'matter-report-archive', public: false });
    const match = /^\/storage\/v1\/object\/(?:authenticated\/)?matter-report-archive\/([a-f0-9]{64}\.gz)$/.exec(url.pathname);
    if (match && options.method === 'GET') {
      const body = await read(match[1]);
      archiveReads.requests++;
      archiveReads.bytes += body.length;
      return new Response(body);
    }
    if (match && options.method === 'POST') {
      const bytes = Buffer.from(options.body);
      assert.equal(sha256(bytes) + '.gz', match[1]);
      writes.set(match[1], bytes);
      return Response.json({});
    }
    return reject();
  };
  return { read, writes, store, archiveReads, nativeBackend, leaseReleased: () => lease === null, failedOnce: () => failedOnce,
    failureKind: () => failureKind,
    reservationsReleased: () => [...reservations.values()].every(item => item.released) };
}

async function replaySource({ root, runtimeRoot, entrypoint, stateFile, objectsRoot, expected, failPublication,
  archiveCacheDirectory, nativeReplay = false, nativePollProgress = false, sidiReplay = false }) {
  assert.equal(typeof nativeReplay, 'boolean');
  assert.equal(typeof nativePollProgress, 'boolean');
  assert.equal(typeof sidiReplay, 'boolean');
  assert(!(nativeReplay && sidiReplay), 'Replay must keep a single truthful data store.');
  const appReplay = nativeReplay || sidiReplay;
  assert(!nativePollProgress || appReplay, 'Bounded progress requires the app backend capability.');
  const state = await readState(stateFile);
  const executionLedgers = () => [...state].filter(([key]) => /^(?:worker|reader)-budget(?:-|$)/.test(key));
  const preservedExecutionLedgers = structuredClone(executionLedgers());
  const prior = JSON.parse(state.get('collector-state').body);
  const { day, observedAt } = prior.head.source;
  const time = Date.parse(observedAt);
  const capture = JSON.parse(state.get('capture:' + prior.lastCapture.runId).body);
  const readObject = createLocalTransport([[objectsRoot, false]]);
  const originalCapture = JSON.parse(await readObject(capture.ref.key));
  assert.equal(originalCapture.snapshot.rows.length, expected.sourceRows);
  const originalPublication = structuredClone(state.get('collector-state'));
  createReplayState(state, day, time, capture, { appReplay, nativePollProgress });
  assert(archiveCacheDirectory === undefined || archiveCacheDirectory === path.join(path.dirname(root), 'source-archive-cache'));
  const environment = { ...fakeEnvironment, ...(nativeReplay ? { DRIVER_AUDIT_DATA_STORE: 'mongo' } : {}),
    ...(sidiReplay ? { DRIVER_AUDIT_DATA_STORE: 'supabase', DRIVER_AUDIT_EXECUTION_HOST: 'sidi' } : {}),
    ...(archiveCacheDirectory === undefined ? {} : { [DRIVER_AUDIT_SOURCE_CACHE_ENV]: archiveCacheDirectory }) };
  Object.assign(process.env, environment);
  globalThis.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [time])); }
    static now() { return time; }
  };
  let forbidden = 0;
  const fixture = createReplayTransport(state, time, readObject, { failPublication, appReplay, sidiReplay, nativePollProgress, reject() {
    forbidden++;
    throw new Error('Request outside saved collector fixture.');
  } });
  if (appReplay) {
    fixture.nativeBackend.archive = createDriverAuditReadCache({ archive: fixture.nativeBackend.archive,
      cacheDirectory: archiveCacheDirectory });
    assert.equal(fixture.nativeBackend.archive.managedReadCache, true);
    globalThis[Symbol.for('matter.driver-audit.native-backend')] = fixture.nativeBackend;
  }
  const handler = (await load(path.join(runtimeRoot, entrypoint.module))).default;
  const invoke = () => invokeDriverAuditSourceHandler(handler, { entrypoint, environment });
  let firstArchiveReads;
  if (failPublication) {
    const failed = await invoke();
    firstArchiveReads = { ...fixture.archiveReads };
    assert.equal(failed.status, 'needs-inspection');
    assert.equal(failed.failed, 1);
    const afterFailure = fixture.store('collector-state');
    const publication = JSON.parse(afterFailure.body);
    assert.deepEqual(publication.head, prior.head);
    assert.equal(fixture.leaseReleased(), true);
    assert.equal(fixture.failedOnce(), true);
    const progress = nativePollProgress ? fixture.store('native-progress:delivery') : null;
    const recovery = progress?.body ? JSON.parse(progress.body) : publication;
    const pending = recovery.schedule.pending.find(item => item.runId === capture.runId);
    assert(pending);
    pending.nextAttempt = 0;
    state.set(progress?.body ? 'native-progress:delivery' : 'collector-state',
      { ...(progress?.body ? progress : afterFailure), body: JSON.stringify(recovery) });
  }
  const result = await invoke();
  firstArchiveReads ??= { ...fixture.archiveReads };
  const handlerPeakRssBytes = process.resourceUsage().maxRSS * 1024;
  assert.equal(result.httpStatus, 200);
  assert.equal(result.status, 'complete');
  assert.equal(result.collected, 1);
  assert.equal(result.failed, 0);
  assert.equal(fixture.leaseReleased(), true);
  if (!failPublication) assert.equal(fixture.reservationsReleased(), true);
  const published = fixture.store('collector-state');
  const duplicate = await invoke();
  assert.equal(duplicate.status, 'not-due');
  assert.deepEqual(fixture.store('collector-state'), published);
  assert.deepEqual([...fixture.writes.keys()].sort(), nativePollProgress ? [] : expected.writeKeys);
  if (nativePollProgress) assert.deepEqual(published, originalPublication,
    'An identical saved capture must preserve the exact original collector publication.');

  const { createCloudRepository } = await load(path.join(runtimeRoot, 'source/integration/cloud/repository.mjs'));
  const { createCloudPublication } = await load(path.join(runtimeRoot, 'source/integration/cloud/publication.mjs'));
  const transport = { readObject: async key => [await fixture.read(key)], putVerifiedObject() { throw new Error('Readback writes forbidden.'); } };
  const repository = createCloudRepository({ stateStore: { read: async key => fixture.store(key) }, transport, key: 'collector-state' });
  const current = await createCloudPublication({ repository, transport,
    collectorState: { compareAndSwap() { throw new Error('Readback writes forbidden.'); } },
  }).loadCurrent();
  const rows = current.app.queries.reporting_validated_deliveries.rows;
  const retainedSignature = sha256(JSON.stringify(rows.map(({ key, assessmentHash, photo, findings, delivery }) =>
    ({ key, assessmentHash, photo, findings, delivery }))));
  assert.deepEqual({ records: rows.length, history: current.historyCount, reportHash: current.head.reportHash,
    acceptedGrades: rows.filter(row => row.photo?.grade != null && row.photo.grade !== '').length,
    generation: current.head.manifest.sha256, retainedSignature },
  Object.fromEntries(['records', 'history', 'reportHash', 'acceptedGrades', 'generation', 'retainedSignature'].map(key => [key, expected[key]])));
  assert.equal(forbidden, 0);
  if (appReplay) assert.deepEqual(executionLedgers(), preservedExecutionLedgers, 'App execution changed a preserved hosting ledger.');
  const saved = { revision: published.revision, body: published.body };
  await fs.writeFile(path.join(root, 'replayed-source.private.json'), JSON.stringify(saved), { flag: 'wx', mode: 0o600 });
  for (const [key, bytes] of fixture.writes) await fs.writeFile(path.join(root, key), bytes, { flag: 'wx', mode: 0o600 });
  return { status: 'verified', reportHash: current.head.reportHash, generation: current.head.manifest.sha256, records: rows.length,
    history: current.historyCount, acceptedGrades: expected.acceptedGrades, sourceRows: expected.sourceRows,
    outputObjects: fixture.writes.size, handlerPeakRssBytes, failureRetry: !!failPublication, archiveReads: firstArchiveReads,
    ...(nativeReplay ? { executionAdmission: 'fixed-host-v1', executionLedgersPreserved: true,
      nativeManagedArchiveCache: true, nativeArchiveCacheEnabled: archiveCacheDirectory !== undefined } : {}),
    ...(sidiReplay ? { dataStore: 'supabase', executionHost: 'sidi', executionAdmission: 'fixed-host-v1',
      executionLedgersPreserved: true, transferAccounting: 'supabase-http-bytes-v1',
      managedArchiveCache: true, archiveCacheEnabled: archiveCacheDirectory !== undefined } : {}),
    ...(nativePollProgress ? { ...(sidiReplay ? { pollProgressDuplicateFree: true } : { nativeNoChangeDuplicateFree: true }),
      failureKind: fixture.failureKind() } : {}) };
}

function archiveFromParent(key, maxBytes) {
  return new Promise((resolve, reject) => {
    const receive = message => {
      if (message?.kind !== 'archive' || message.key !== key) return;
      process.off('message', receive);
      if (message.file) resolve(message.file);
      else reject(Object.assign(new Error('Qualification archive read unavailable.'), { code: message.code }));
    };
    process.on('message', receive);
    process.send({ kind: 'read-archive', key, maxBytes });
  });
}

async function replayBuilder({ root, objectsRoot, sourceRoot, builder, diskReserve, nativeReplay = false, sidiReplay = false, archiveCacheDirectory }) {
  assert.equal(typeof nativeReplay, 'boolean');
  assert.equal(typeof sidiReplay, 'boolean');
  assert(!(nativeReplay && sidiReplay), 'Replay must keep a single truthful data store.');
  const appReplay = nativeReplay || sidiReplay;
  assert(archiveCacheDirectory === undefined || archiveCacheDirectory === path.join(path.dirname(root), 'source-archive-cache'));
  const read = createLocalTransport([[sourceRoot, false], [objectsRoot, false],
    [builder.cacheRoot, false], [builder.archiveBaseline, true], [builder.initialBaseline, true]], archiveFromParent);
  const original = { readObject: async (key, { maxBytes } = {}) => Readable.from([await read(key, maxBytes)]) };
  const transport = appReplay ? createDriverAuditReadCache({ archive: original, cacheDirectory: archiveCacheDirectory }) : original;
  const [{ automaticReleaseBasis }, { createCloudRepository }, { buildAutomaticRelease, compactDirectBuildVersion }, { validateAutomaticCandidate }] =
    await Promise.all(['integration/cloud/automatic-release.mjs', 'integration/cloud/repository.mjs',
      'integration/cloud/automatic-release-build.mjs', 'scripts/run-automatic-report.mjs'].map(file => load(path.join(builder.codeRoot, file))));
  const savedState = await json(path.join(sourceRoot, 'replayed-source.private.json'));
  const stateStore = { read: async () => savedState };
  let source;
  if (appReplay) {
    const { createAutomaticReleaseSource, supportsManagedArchiveCache } =
      await load(path.join(builder.codeRoot, 'integration/cloud/automatic-release-source.mjs'));
    assert.equal(supportsManagedArchiveCache, true, 'The builder must delegate native cache ownership.');
    assert.equal(transport.managedReadCache, true);
    source = await createAutomaticReleaseSource({ stateStore, archiveTransport: transport,
      cacheRoot: archiveCacheDirectory ?? builder.cacheRoot, skipCacheWrite: true })();
  } else {
    const repository = await createCloudRepository({ stateStore, transport, key: 'collector-state' }).pin();
    source = { savedState, publication: repository.publication, repository, transport };
  }
  const checkSpace = async (minimum = diskReserve.inProgress) => {
    const disk = await fs.statfs(root);
    if (disk.bavail * disk.bsize < minimum) throw Object.assign(new Error('Qualification workspace reserve unavailable.'), { code: 'AUDIT_CAPACITY' });
  };
  await checkSpace(diskReserve.start);
  const output = path.join(root, 'candidate');
  await fs.mkdir(output, { mode: 0o700 });
  const candidate = await buildAutomaticRelease({ source, basis: automaticReleaseBasis(source.publication), output,
    baselineRoot: builder.baselineRoot, rendererBuild: builder.rendererBuild, archiveBackedBaseline: true, checkSpace: () => checkSpace() });
  assert.equal(compactDirectBuildVersion ?? null, builder.compactDirectBuildVersion);
  const validation = await validateAutomaticCandidate(candidate, { journals: builder.journals });
  assert.equal(validation.ok, true);
  return { status: 'verified', builderSha256: builder.builderSha256, baselineManifestSha256: builder.baselineManifestSha256,
    candidateManifestSha256: validation.manifestSha256,
    ...(nativeReplay ? { nativeManagedArchiveCache: true, nativeArchiveCacheEnabled: archiveCacheDirectory !== undefined } : {}),
    ...(sidiReplay ? { dataStore: 'supabase', executionHost: 'sidi', managedArchiveCache: true,
      archiveCacheEnabled: archiveCacheDirectory !== undefined } : {}) };
}

async function main() {
  assert(process.send && process.permission && !process.permission.has('child'), 'Qualification process isolation required.');
  process.once('disconnect', () => process.exit(1));
  const started = performance.now();
  const networkAttempts = blockNetwork();
  console.info = value => {
    try {
      const event = JSON.parse(value);
      if (event.event === 'worker-phase' && /^[a-z-]{1,64}$/.test(event.phase ?? '')) lastPhase = event.phase;
    } catch {}
  };
  const input = await json(process.argv[2]);
  const result = process.argv[3] === 'source' ? await replaySource(input) : await replayBuilder(input);
  assert.equal(networkAttempts(), 0);
  process.send({ kind: 'result', result: { ...result, nodeVersion: process.version, platform: process.platform,
    rssBytes: process.memoryUsage().rss, peakRssBytes: process.resourceUsage().maxRSS * 1024,
    heapLimitBytes: getHeapStatistics().heap_size_limit, elapsedMs: Math.ceil(performance.now() - started), networkAttempts: 0 } });
}

main().catch(error => {
  const code = error.code === 'AUDIT_CAPACITY' ? 'disk' : error.code === 'AUDIT_BUDGET' ? 'budget' : 'replay';
  const failureLine = /driverAuditQualificationChild\.js:(\d+):\d+/.exec(error.stack ?? '')?.[1];
  process.send?.({ kind: 'failed', code, line: failureLine ? Number(failureLine) : null, phase: lastPhase });
  process.exitCode = 1;
  process.disconnect?.();
});
