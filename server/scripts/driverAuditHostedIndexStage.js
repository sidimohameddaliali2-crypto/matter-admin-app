import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createDriverAuditLightArchive, isDriverAuditLightReference } from '../services/driverAuditLightArchive.js';
import { createDriverAuditSupabaseAppBackend } from '../services/driverAuditSupabaseAppBackend.js';
import { createDriverAuditSupabaseReplica, driverAuditSupabaseReportHeadKey, verifyDriverAuditSupabaseServingPackage }
  from '../services/driverAuditSupabaseReplica.js';
import { createBudgetedAuditArchive } from '../vendor/driver-audits/integration/cloud/driver-audit-archive.mjs';
import { createCloudState } from '../vendor/driver-audits/integration/cloud/cloud-state.mjs';
import { maximumDriverAuditHostedIndexBundleBytes, openDriverAuditHostedIndexBundle } from './driverAuditHostedIndexBundle.js';

const MiB = 1024 ** 2;
const dayMs = 24 * 60 * 60 * 1000;
const maximumReceipt = MiB;
const key = driverAuditSupabaseReportHeadKey;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const revision = value => Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (condition, message) => { if (!condition) throw Error(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(name => Object.hasOwn(value, name));
const anchorMatches = (row, pinnedRevision, pinnedHash) => row?.revision === pinnedRevision && typeof row.body === 'string' && sha(row.body) === pinnedHash;
const privateOwner = stat => stat.uid === BigInt(process.getuid()) && !(Number(stat.mode) & 0o077);
const signature = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');

function json(bytes, maximum) {
  check(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= maximum
    && Buffer.from(bytes.toString('utf8')).equals(bytes), 'Invalid private index JSON');
  try { return JSON.parse(bytes); } catch { throw Error('Invalid private index JSON'); }
}

async function directory(name, { create = false } = {}) {
  check(typeof name === 'string' && path.isAbsolute(name) && path.resolve(name) === name, 'A canonical private directory is required');
  if (create) await fs.mkdir(name, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const stat = await fs.lstat(name, { bigint: true });
  check(stat.isDirectory() && privateOwner(stat) && await fs.realpath(name) === name, 'A canonical private directory is required');
}

async function privateBytes(name, maximum, { optional = false } = {}) {
  await directory(path.dirname(name));
  let stat;
  try { stat = await fs.lstat(name, { bigint: true }); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  check(stat.isFile() && privateOwner(stat) && stat.nlink === 1n && stat.size > 0n && stat.size <= BigInt(maximum)
    && await fs.realpath(name) === name, 'An exact private file is required');
  const file = await fs.open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    check(signature(await file.stat({ bigint: true })) === signature(stat), 'The private file changed');
    const bytes = Buffer.alloc(Number(stat.size));
    for (let offset = 0; offset < bytes.length;) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      check(bytesRead > 0, 'The private file changed');
      offset += bytesRead;
    }
    check(signature(await file.stat({ bigint: true })) === signature(stat)
      && signature(await fs.lstat(name, { bigint: true })) === signature(stat), 'The private file changed');
    return bytes;
  } finally { await file.close(); }
}

async function savedReceipt(file, { optional = false } = {}) {
  const bytes = await privateBytes(file, maximumReceipt, { optional });
  return bytes && json(bytes, maximumReceipt);
}

async function retainReceipt(name, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  check(bytes.length <= maximumReceipt, 'The private receipt exceeds its bound');
  const prior = await privateBytes(name, maximumReceipt, { optional: true });
  if (prior) {
    check(prior.equals(bytes), 'Previously recorded private release evidence differs');
    return;
  }
  const temporary = name + '.' + randomUUID() + '.tmp';
  const file = await fs.open(temporary, 'wx', 0o600);
  try {
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await fs.link(temporary, name);
  } finally { await fs.unlink(temporary); }
  const parent = await fs.open(path.dirname(name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
}

async function validateContents(contents, releaseSha) {
  check(exact(contents, ['candidate', 'stagedIndex', 'proof', 'objects']), 'An authenticated index bundle is required');
  const proof = json(contents.proof, 16 * 1024), candidate = json(contents.candidate, 256 * 1024);
  const index = json(contents.stagedIndex, 128 * 1024), from = Date.parse(proof?.notBefore);
  check(exact(proof, ['version', 'kind', 'notBefore', 'expectedOldSha', 'expectedHead', 'collector', 'journals', 'paritySha256', 'uploads'])
    && proof.version === 1 && proof.kind === 'driver-audit-hosted-index-cutover'
    && Number.isFinite(from) && from % dayMs === 0 && new Date(from).toISOString() === proof.notBefore
    && commit(proof.expectedOldSha) && proof.expectedOldSha !== releaseSha && digest(proof.paritySha256)
    && exact(proof.expectedHead, ['sourceRevision', 'sourceBodySha256']) && revision(proof.expectedHead.sourceRevision)
    && digest(proof.expectedHead.sourceBodySha256)
    && exact(proof.collector, ['revision', 'bodySha256', 'eventId']) && revision(proof.collector.revision)
    && digest(proof.collector.bodySha256) && typeof proof.collector.eventId === 'string'
    && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,159}$/.test(proof.collector.eventId)
    && Array.isArray(proof.journals) && proof.journals.length === 7
    && new Set(proof.journals.map(row => row?.key)).size === 7
    && proof.journals.every(row => exact(row, ['key', 'revision', 'bodySha256'])
      && typeof row.key === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(row.key)
      && row.key !== key && row.key !== 'collector-state' && revision(row.revision) && digest(row.bodySha256)),
  'Invalid cutover evidence');
  const uploads = proof.uploads;
  check(exact(uploads, ['endpoint', 'bucket', 'region']) && typeof uploads.region === 'string'
    && /^[a-z][a-z0-9-]{1,19}$/.test(uploads.region) && typeof uploads.endpoint === 'string'
    && [uploads.region + '.digitaloceanspaces.com', 'https://' + uploads.region + '.digitaloceanspaces.com',
      'https://' + uploads.region + '.digitaloceanspaces.com/'].includes(uploads.endpoint)
    && typeof uploads.bucket === 'string' && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(uploads.bucket),
  'Invalid original photo upload configuration');
  check(candidate?.version === 1 && digest(candidate.generation) && digest(candidate.reportHash) && digest(candidate.descriptor?.sha256)
    && candidate.servingPackage?.dataStore === 'supabase' && candidate.servingPackage.collectorRevision === proof.collector.revision
    && candidate.closureReceipt?.checks?.archive === true && candidate.closureReceipt.checks.photos === true
    && candidate.closureReceipt.checks.reviewHistory === true && candidate.restore?.verified === true
    && isDriverAuditLightReference(candidate.lightView) && !Object.hasOwn(candidate, 'sourceRevision')
    && !Object.hasOwn(candidate, 'sourceBodySha256'), 'Invalid candidate for the exact collector evidence');
  check(index?.version === 1 && index.published === false && index.activated === false
    && index.originalGpsPhotosReviewsRemainInExistingArchive === true && index.independentParitySha256 === proof.paritySha256
    && index.collectorRevision === proof.collector.revision && index.originalDescriptorSha256 === candidate.descriptor.sha256
    && isDeepStrictEqual(index.lightView, candidate.lightView) && Array.isArray(index.archives)
    && index.archives.length === index.objectCount && index.objectCount > 0 && index.objectCount <= 1024
    && contents.objects instanceof Map && contents.objects.size === index.objectCount, 'Invalid index inventory');
  const seen = new Set();
  let bytes = 0;
  for (const entry of index.archives) {
    check(exact(entry, ['key', 'bytes']) && typeof entry.key === 'string' && /^[a-f0-9]{64}\.gz$/.test(entry.key)
      && Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && entry.bytes <= 2 * MiB && !seen.has(entry.key), 'Invalid index inventory');
    const body = contents.objects.get(entry.key);
    check(Buffer.isBuffer(body) && body.length === entry.bytes && sha(body) === entry.key.slice(0, 64), 'An index object differs');
    seen.add(entry.key);
    bytes += entry.bytes;
  }
  check(bytes === index.objectBytes && bytes <= 32 * MiB, 'Invalid index inventory size');
  const offline = createDriverAuditLightArchive({ archive: { async readObject(name, { maxBytes }) {
    const body = contents.objects.get(name);
    check(body && body.length === maxBytes, 'The bundle is missing its report index');
    return [body];
  } } });
  const direct = await offline.index(candidate);
  const savedKeys = [];
  for (const date of direct.days) {
    const day = await offline.directory(candidate, date.day);
    for (const recordKey of day.keys) savedKeys.push(recordKey);
  }
  await offline.verify(candidate, savedKeys);
  return { proof, candidate, index, from, objects: contents.objects };
}

// The injectable clock and backend are only fixture boundaries. The CLI uses
// the real time, metered Supabase backend and authenticated private input.
export async function runDriverAuditHostedIndexStage({ mode, root, contents, releaseSha, bundleSha256, env = process.env,
  backend, signal, clock = Date.now } = {}) {
  check(['check', 'stage', 'select'].includes(mode) && commit(releaseSha) && digest(bundleSha256)
    && typeof clock === 'function', 'Invalid hosted index stage request');
  await directory(root);
  const { proof, candidate, index, from, objects } = await validateContents(contents, releaseSha);
  const status = (name, selected = false) => ({ status: name, objects: index.objectCount, selected, staffAppSwitched: false });
  if (mode === 'check') return status('hosted-index-checked');

  const window = () => {
    signal?.throwIfAborted();
    const now = clock();
    check(Number.isFinite(now) && now >= from && now < from + dayMs, 'The one-time Dubai reset window is closed');
  };
  window();
  const stageFile = path.join(root, 'stage.private.json');
  const selectionFile = path.join(root, 'selection.private.json');
  const intentFile = path.join(root, 'selection-intent.private.json');
  const binding = { version: 1, bundleSha256, proofSha256: sha(contents.proof), releaseSha };
  const stage = await savedReceipt(stageFile, { optional: true });
  if (mode === 'select' || stage) {
    check(stage?.kind === 'hosted-index-stage' && Object.entries(binding).every(([name, value]) => stage[name] === value)
      && stage.verifiedObjects === index.objectCount && stage.verifiedBytes === index.objectBytes
      && anchorMatches(stage.headBefore, proof.expectedHead.sourceRevision, proof.expectedHead.sourceBodySha256),
    'The authenticated index stage receipt is required');
  }
  const cacheDirectory = path.join(root, 'archive-cache'), receiptRoot = path.join(root, 'archive-receipts');
  await directory(cacheDirectory, { create: true });
  await directory(receiptRoot, { create: true });
  if (!backend) backend = await createDriverAuditSupabaseAppBackend({ env: {
    DRIVER_AUDIT_EXECUTION_HOST: 'off-host', DRIVER_AUDIT_DATA_STORE: 'supabase', DRIVER_AUDIT_PHOTO_RECOVERY_STORE: 'supabase',
    DRIVER_AUDIT_SUPABASE_SECRET: env.DRIVER_AUDIT_WORKER_SUPABASE_SECRET, MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY: cacheDirectory,
    SPACES_ENDPOINT: proof.uploads.endpoint, SPACES_BUCKET: proof.uploads.bucket, SPACES_REGION: proof.uploads.region,
  }, fetchImpl: (url, options) => fetch(url, { ...options,
    signal: signal && options?.signal ? AbortSignal.any([signal, options.signal]) : signal ?? options?.signal }) });
  const usage = await backend.readTransferUsage();
  window();
  const room = row => row.limitBytes - row.usedBytes - row.reservedBytes;
  const allowance = Math.min(room(usage.day), room(usage.month));
  // Reserve room for both directions, fixed request accounting and the final
  // state readback. All actual remote requests use ordinary admission below.
  const stageBytes = index.objectBytes * 2 + index.objectCount * 64 * 1024 + 4 * MiB;
  check(usage.day.period === proof.notBefore.slice(0, 10) && usage.month.period === proof.notBefore.slice(0, 7)
    && Number.isSafeInteger(allowance) && allowance >= (mode === 'stage' && !stage ? stageBytes : 2 * MiB),
  'The ordinary Supabase transfer allowance cannot admit the cutover');
  check((await backend.archive.assertPrivate()).public === false, 'The original archive must be private');
  const controlRpc = backend.rpcForResponseLimit(768 * 1024);
  const state = createCloudState({ rpc: controlRpc }), data = createCloudState({ rpc: backend.rpcForResponseLimit(2 * MiB) });
  const objectsArchive = createBudgetedAuditArchive({ rpc: controlRpc, state, remote: backend.archive, receiptRoot,
    budgetOverride: backend.archiveReadBudget });

  const checkEvidence = async ({ receipt = false } = {}) => {
    window();
    check(anchorMatches(await data.read('collector-state'), proof.collector.revision, proof.collector.bodySha256),
      'The canonical collector advanced');
    if (receipt) {
      const [saved] = await data.receipts('collector-state', { after: proof.collector.revision - 1 });
      check(saved?.revision === proof.collector.revision && saved.event_id === proof.collector.eventId
        && saved.body_sha256 === proof.collector.bodySha256, 'The original collector receipt differs');
    }
    for (const journal of proof.journals) {
      check(anchorMatches(await data.read(journal.key), journal.revision, journal.bodySha256), 'An original review journal advanced');
    }
    window();
  };
  const checkOldHead = ({ revision: actual, body }) => {
    check(anchorMatches({ revision: actual, body }, proof.expectedHead.sourceRevision, proof.expectedHead.sourceBodySha256),
      'The existing serving pointer changed');
    const old = json(Buffer.from(body), 256 * 1024), previous = candidate.previous;
    check(previous && previous.generation === old.generation && previous.reportHash === old.reportHash
      && previous.descriptor?.sha256 === old.descriptor?.sha256 && isDeepStrictEqual(previous.servingPackage, old.servingPackage),
    'The exact prior serving package is missing');
  };
  const confirmOld = async () => {
    const before = await state.read(key);
    checkOldHead(before);
    return before;
  };
  await checkEvidence({ receipt: true });

  if (mode === 'stage') {
    const headBefore = await confirmOld();
    for (let offset = 0; offset < index.objectCount; offset += 8) {
      window();
      const batch = await Promise.allSettled(index.archives.slice(offset, offset + 8).map(({ key: objectKey, bytes }) =>
        objectsArchive.verify(objectKey, bytes, async () => objects.get(objectKey))));
      const rejected = batch.find(result => result.status === 'rejected');
      if (rejected) throw rejected.reason;
    }
    await checkEvidence();
    await confirmOld();
    await retainReceipt(stageFile, { ...binding, kind: 'hosted-index-stage', headBefore,
      verifiedObjects: index.objectCount, verifiedBytes: index.objectBytes });
    return status('hosted-index-staged');
  }

  checkOldHead(stage.headBefore);
  const actual = await state.read(key);
  let intent = await savedReceipt(intentFile, { optional: true });
  if (intent) {
    check(intent.kind === 'hosted-index-selection-intent' && Object.entries(binding).every(([name, value]) => intent[name] === value)
      && intent.expectedRevision === proof.expectedHead.sourceRevision && digest(intent.nextBodySha256)
      && /^sidi-preview-[a-f0-9]{64}$/.test(intent.eventId), 'The private selection intent differs');
  }
  const guardedState = { ...state, async compareAndSwap(operation) {
    const next = { ...binding, kind: 'hosted-index-selection-intent', expectedRevision: operation.expectedRevision,
      nextBodySha256: sha(operation.body), eventId: operation.eventId };
    check(operation.key === key && next.expectedRevision === proof.expectedHead.sourceRevision
      && (!intent || isDeepStrictEqual(next, intent)), 'The selection no longer matches the reviewed intent');
    await checkEvidence();
    await confirmOld();
    await retainReceipt(intentFile, next);
    intent = next;
    window();
    return state.compareAndSwap(operation);
  } };
  const replica = createDriverAuditSupabaseReplica({ state: guardedState, archive: backend.archive });
  const { previous, publishedAt, ...target } = candidate;
  let selected;
  if (intent && anchorMatches(actual, intent.expectedRevision + 1, intent.nextBodySha256)) {
    const [receipt] = await state.receipts(key, { after: intent.expectedRevision });
    check(receipt?.revision === actual.revision && receipt.body_text === actual.body && receipt.event_id === intent.eventId,
      'The retained selection was not confirmed');
    selected = await replica.head();
    check(selected.sourceRevision === actual.revision && selected.sourceBodySha256 === intent.nextBodySha256,
      'The retained selection advanced');
    await verifyDriverAuditSupabaseServingPackage({ head: selected, archive: backend.archive });
  } else {
    checkOldHead(actual);
    ({ head: selected } = await replica.activate({ expected: proof.expectedHead, head: target }));
  }
  check(intent && selected.sourceRevision === proof.expectedHead.sourceRevision + 1
    && selected.sourceBodySha256 === intent.nextBodySha256 && selected.generation === target.generation
    && selected.reportHash === target.reportHash && selected.descriptor.sha256 === target.descriptor.sha256
    && isDeepStrictEqual(selected.lightView, target.lightView)
    && selected.previous?.sourceRevision === proof.expectedHead.sourceRevision
    && selected.previous.sourceBodySha256 === proof.expectedHead.sourceBodySha256,
  'The selected index did not preserve the exact prior report');
  await checkEvidence();
  check(anchorMatches(await state.read(key), selected.sourceRevision, selected.sourceBodySha256), 'The selected index advanced');
  window();
  await retainReceipt(selectionFile, { ...binding, kind: 'hosted-index-selected', selectedRevision: selected.sourceRevision,
    headBefore: stage.headBefore, request: { version: 1, expectedOldSha: proof.expectedOldSha, selectedSha: releaseSha,
      reportHeadSha256: selected.sourceBodySha256, generation: selected.generation } });
  return status('hosted-index-selected', true);
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, rootFlag, root, bundleFlag, bundleFile, hashFlag, bundleSha256, releaseFlag, releaseSha] = process.argv.slice(2);
    check(process.argv.length === 11 && ['--check', '--stage', '--select'].includes(mode) && rootFlag === '--root'
      && bundleFlag === '--bundle' && hashFlag === '--bundle-sha' && releaseFlag === '--release-sha'
      && digest(bundleSha256) && commit(releaseSha), 'Invalid hosted index CLI inputs');
    const bundle = await privateBytes(bundleFile, maximumDriverAuditHostedIndexBundleBytes);
    check(sha(bundle) === bundleSha256, 'The hosted index bundle digest differs');
    const secret = process.env.DRIVER_AUDIT_WORKER_CACHE_KEY ?? '';
    const material = Buffer.from(secret, 'base64');
    check(material.length === 32 && material.toString('base64') === secret, 'The private key is required');
    const stop = new AbortController();
    const cancel = () => stop.abort(Error('The private index stage was interrupted'));
    process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
    try {
      const contents = await openDriverAuditHostedIndexBundle({ bundle, key: material, releaseSha, signal: stop.signal });
      console.log(JSON.stringify(await runDriverAuditHostedIndexStage({ mode: mode.slice(2), root, contents,
        releaseSha, bundleSha256, signal: stop.signal })));
    } finally { material.fill(0); }
  } catch { console.error('The hosted index stage stopped. Check the private index inputs, release evidence and transfer allowance.'); process.exitCode = 1; }
}
