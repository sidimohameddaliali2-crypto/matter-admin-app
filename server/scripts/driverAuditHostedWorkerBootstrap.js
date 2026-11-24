import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { createHostedRpc } from '../vendor/driver-audits/integration/cloud/rpc.mjs';
import { createCloudState } from '../vendor/driver-audits/integration/cloud/cloud-state.mjs';
import { createSupabaseArchiveTransport } from '../vendor/driver-audits/integration/hosted/supabase-archive.mjs';
import { createDriverAuditSupabaseTransfer } from '../services/driverAuditSupabaseTransfer.js';
import { createDriverAuditReadCache } from '../services/driverAuditReadCache.js';
import { createDriverAuditSupabaseAppBackend } from '../services/driverAuditSupabaseAppBackend.js';
import { restoreDriverAuditHostedCache, sealDriverAuditHostedCache } from '../services/driverAuditHostedCache.js';
import { readPrivateDriverAuditSource } from '../services/driverAuditSource.js';
import { validateDriverAuditSupabaseWorkerSlotStatus } from '../services/driverAuditSyncStatus.js';

const MiB = 1024 ** 2;
const limit = 2 * MiB;
const magic = Buffer.from('MDRBH1\n');
const sha = value => createHash('sha256').update(value).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const exact = (value, fields) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const check = condition => { if (!condition) throw Error('The private hosted report worker inputs differ'); };
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;

function envelopeKey(secret, salt, identity) {
  check(typeof secret === 'string' && secret.length >= 40 && secret.length <= 16384 && !/[\r\n]/.test(secret)
    || Buffer.isBuffer(secret) && secret.length === 32);
  return Buffer.from(hkdfSync('sha256', secret, salt, Buffer.from(identity), 32));
}

function seal(value, secret, identity, maximum) {
  const body = Buffer.from(JSON.stringify(value)), salt = randomBytes(32), nonce = randomBytes(12);
  check(body.length > 0 && body.length <= maximum);
  const key = envelopeKey(secret, salt, identity);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(identity));
    const encrypted = Buffer.concat([cipher.update(body), cipher.final()]);
    return Buffer.concat([magic, salt, nonce, cipher.getAuthTag(), encrypted]);
  } finally { key.fill(0); body.fill(0); }
}

function unseal(bytes, secret, identity, maximum) {
  const offset = magic.length;
  check(Buffer.isBuffer(bytes) && bytes.length > offset + 60 && bytes.length <= maximum + offset + 60
    && bytes.subarray(0, offset).equals(magic));
  const key = envelopeKey(secret, bytes.subarray(offset, offset + 32), identity);
  let clear;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(offset + 32, offset + 44));
    decipher.setAAD(Buffer.from(identity));
    decipher.setAuthTag(bytes.subarray(offset + 44, offset + 60));
    clear = Buffer.concat([decipher.update(bytes.subarray(offset + 60)), decipher.final()]);
    return JSON.parse(clear.toString('utf8'));
  } finally { key.fill(0); clear?.fill(0); }
}

const bootstrapIdentity = releaseSha => 'driver-report-hosted-bootstrap-v1:' + releaseSha;
const absolute = name => typeof name === 'string' && path.isAbsolute(name) && path.resolve(name) === name;

function manifestFor(value, releaseSha, root) {
  check(exact(value, ['version', 'kind', 'releaseSha', 'root', 'source', 'fixture', 'preflight', 'files'])
    && value.version === 1 && value.kind === 'driver-report-hosted-bootstrap-v1' && value.releaseSha === releaseSha
    && commit(releaseSha) && absolute(root) && value.root === root
    && typeof value.source === 'string' && /^collector\/[a-f0-9]{64}\/source\.json$/.test(value.source)
    && exact(value.fixture, ['path', 'sha256']) && value.fixture.path === 'source-replay.private.json.gz' && hex(value.fixture.sha256)
    && exact(value.preflight, ['syncSha256', 'sourceConfigSha256', 'activationSha256', 'pinsSha256'])
    && Object.values(value.preflight).every(hex)
    && Array.isArray(value.files) && value.files.length > 0 && value.files.length <= 4096);
  const allowed = new Set(['sync.json', 'validation-journals.private.json', 'hosted-release-pins.private.json',
    'hosted-environment-activation.private.json', 'source-replay.private.json.gz',
    ...['repository', 'environment', 'branches', 'secrets'].map(name => 'provisioning/' + name + '.private.json')]);
  const sourceRoot = path.dirname(value.source) + '/';
  const sourceEnvironment = sourceRoot + 'environment.private.json';
  const known = new Map();
  let total = 0;
  for (const entry of value.files) {
    const embedded = Object.hasOwn(entry ?? {}, 'embedded');
    check(exact(entry, ['path', 'bytes', 'sha256', 'chunks', ...(embedded ? ['embedded'] : [])])
      && typeof entry.path === 'string'
      && entry.path.length <= 512 && entry.path.split('/').every(part => /^[A-Za-z0-9_.-]+$/.test(part)
        && part !== '.' && part !== '..')
      && (allowed.has(entry.path) || entry.path.startsWith('baseline/') || entry.path.startsWith('builder/')
        || entry.path.startsWith(sourceRoot)) && !known.has(entry.path) && hex(entry.sha256)
      && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && entry.bytes <= 128 * MiB
      && Array.isArray(entry.chunks) && entry.chunks.length <= 32);
    let length = 0;
    if (embedded) {
      check((allowed.has(entry.path) || entry.path === value.source || entry.path === sourceEnvironment)
        && entry.chunks.length === 0 && typeof entry.embedded === 'string' && entry.embedded.length <= MiB);
      const body = Buffer.from(entry.embedded, 'base64');
      check(body.toString('base64') === entry.embedded && sha(body) === entry.sha256);
      length = body.length;
      body.fill(0);
    } else check(entry.path !== sourceEnvironment);
    for (const chunk of entry.chunks) {
      check(exact(chunk, ['key', 'bytes']) && typeof chunk.key === 'string' && /^[a-f0-9]{64}\.gz$/.test(chunk.key)
        && positive(chunk.bytes) && chunk.bytes <= 8 * MiB);
      length += chunk.bytes;
    }
    check(length === entry.bytes && (total += length) <= 256 * MiB);
    known.set(entry.path, entry);
  }
  check([...allowed, sourceEnvironment].every(name => known.has(name))
    && known.get(value.source)?.sha256 === value.preflight.sourceConfigSha256
    && known.get('sync.json').sha256 === value.preflight.syncSha256
    && known.get('hosted-release-pins.private.json').sha256 === value.preflight.pinsSha256
    && known.get('hosted-environment-activation.private.json').sha256 === value.preflight.activationSha256
    && known.get(value.fixture.path).sha256 === value.fixture.sha256);
  return value;
}

export function sealDriverAuditHostedWorkerBootstrap(manifest, secret) {
  manifestFor(manifest, manifest?.releaseSha, manifest?.root);
  return seal(manifest, secret, bootstrapIdentity(manifest.releaseSha), limit);
}

export function decodeDriverAuditHostedWorkerBootstrap(bytes, { root, releaseSha, supabaseSecret }) {
  check(commit(releaseSha) && absolute(root));
  return manifestFor(unseal(bytes, supabaseSecret, bootstrapIdentity(releaseSha), limit), releaseSha, root);
}

async function privateDirectory(name) {
  check(absolute(name));
  try { await fs.mkdir(name, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await fs.lstat(name);
  check(info.isDirectory() && info.uid === process.getuid() && (info.mode & 0o777) === 0o700
    && await fs.realpath(name) === name);
}

async function collect(archive, key, maximum, signal) {
  const chunks = [];
  let size = 0;
  for await (const bit of await archive.readObject(key, { maxBytes: maximum, signal })) {
    check(bit instanceof Uint8Array && (size += bit.byteLength) <= maximum);
    chunks.push(Buffer.from(bit));
  }
  const bytes = Buffer.concat(chunks, size);
  check(size > 0 && sha(bytes) === key.slice(0, 64));
  return bytes;
}

async function materialize(root, manifest, archive, signal) {
  for (const entry of manifest.files) {
    signal?.throwIfAborted();
    const parts = entry.path.split('/'), basename = parts.pop();
    let directory = root;
    for (const part of parts) { directory = path.join(directory, part); await privateDirectory(directory); }
    const file = await fs.open(path.join(directory, basename), 'wx', 0o600), digest = createHash('sha256');
    try {
      if (entry.embedded) {
        const bytes = Buffer.from(entry.embedded, 'base64');
        try { digest.update(bytes); await file.writeFile(bytes); }
        finally { bytes.fill(0); }
      }
      for (const chunk of entry.chunks) {
        const bytes = await collect(archive, chunk.key, chunk.bytes, signal);
        check(bytes.length === chunk.bytes);
        digest.update(bytes);
        await file.writeFile(bytes);
      }
      check(digest.digest('hex') === entry.sha256);
      await file.sync();
    } finally { await file.close(); }
  }
}

async function optionalPrivate(file, maximum) {
  try { return await readPrivateDriverAuditSource(file, maximum); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function createHostedProofState(state, binding) {
  const documentKey = kind => 'app-sidi-report-worker-' + kind + '-v1-' + binding.bootstrapSha256;
  async function read(kind, maximum) {
    const row = await state.read(documentKey(kind));
    if (row.body === null) return { row, value: null };
    check(Buffer.byteLength(row.body) <= maximum);
    const saved = JSON.parse(row.body);
    check(exact(saved, ['version', 'binding', 'value']) && saved.version === 1
      && exact(saved.binding, Object.keys(binding))
      && Object.entries(binding).every(([key, value]) => saved.binding[key] === value));
    return { row, value: saved.value };
  }
  async function write(kind, value, { maximum, once = false }) {
    const prior = await read(kind, maximum);
    const body = JSON.stringify({ version: 1, binding, value });
    check(Buffer.byteLength(body) <= maximum);
    if (prior.row.body === body || once && prior.value !== null) return prior.value;
    const event = JSON.stringify({ kind: 'driver-report-hosted-' + kind, bodySha256: sha(body) });
    const request = JSON.stringify({ expectedRevision: prior.row.revision, bodySha256: sha(body) });
    const key = documentKey(kind);
    const eventId = 'hosted-worker-' + sha(JSON.stringify([key, request]));
    let failure;
    try { await state.compareAndSwap({ key, expectedRevision: prior.row.revision, eventId, body, event, request }); }
    catch (error) { failure = error; }
    const actual = await state.read(key);
    if (actual.revision !== prior.row.revision + 1 || actual.body !== body) throw failure ?? Error('Hosted proof readback differs');
    return value;
  }
  return { read, write };
}

function verifiedEnrollment(value, preflight, qualification) {
  check(exact(value, ['version', 'kind', 'armedAt', 'syncSha256', 'sourceSha256', 'qualificationSha256',
    'appAcceptanceSha256', 'writerFenceSha256', 'appReleaseSha', 'servingHeadRevision', 'servingHeadBodySha256'])
    && value.version === 1 && value.kind === 'driver-report-hosted-enrollment-v1'
    && iso(value.armedAt) && Date.parse(value.armedAt) <= Date.now() && value.armedAt >= qualification?.qualifiedAt
    && value.syncSha256 === preflight.syncSha256 && value.sourceSha256 === preflight.sourceConfigSha256
    && value.qualificationSha256 === sha(JSON.stringify(qualification))
    && hex(value.appAcceptanceSha256) && hex(value.writerFenceSha256) && commit(value.appReleaseSha)
    && positive(value.servingHeadRevision) && hex(value.servingHeadBodySha256));
  return { version: 1, syncSha256: value.syncSha256, sourceSha256: value.sourceSha256, armedAt: value.armedAt };
}

async function archiveCheckpoint(file, options) {
  const directory = path.dirname(file);
  await privateDirectory(directory);
  const temp = path.join(directory, '.cache-' + randomUUID());
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    try {
      await sealDriverAuditHostedCache({ ...options, write: bytes => handle.writeFile(bytes) });
      await handle.sync();
    } finally { await handle.close(); }
    await fs.rename(temp, file);
    const parent = await fs.open(directory, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  } finally { await fs.rm(temp, { force: true }); }
}

export async function openDriverAuditHostedWorkerBootstrap({ root, bootstrapSha256, releaseSha, supabaseSecret,
  cacheKey, signal, mode, cacheBundle = process.env.DRIVER_AUDIT_WORKER_CACHE_BUNDLE } = {}) {
  check(absolute(root) && hex(bootstrapSha256) && commit(releaseSha)
    && typeof supabaseSecret === 'string' && supabaseSecret.length >= 40 && !/[\r\n]/.test(supabaseSecret)
    && Buffer.isBuffer(cacheKey) && cacheKey.length === 32 && ['--qualify', '--once'].includes(mode)
    && (cacheBundle === undefined || absolute(cacheBundle) && cacheBundle === path.join(path.dirname(root), 'driver-report-worker-cache-v1/archive.aes')));
  await privateDirectory(root);
  check((await fs.readdir(root)).length === 0);
  const work = path.join(root, 'work'), cacheDirectory = path.join(work, 'archive-cache');
  await privateDirectory(work);
  await privateDirectory(cacheDirectory);
  const controlledFetch = (url, options) => fetch(url, { ...options,
    signal: signal && options?.signal ? AbortSignal.any([signal, options.signal]) : signal ?? options?.signal });
  const controlRpc = createHostedRpc({ secret: supabaseSecret, fetchImpl: controlledFetch, maxResponseBytes: 16 * 1024 });
  const transfer = createDriverAuditSupabaseTransfer({ controlRpc, fetchImpl: controlledFetch });
  const raw = createSupabaseArchiveTransport({ secret: supabaseSecret, drainAcknowledgements: true,
    fetchImpl: (url, options, maxResponseBytes) => transfer.wrapFetch({ maxResponseBytes })(url, options) });
  const archive = createDriverAuditReadCache({ archive: raw, cacheDirectory });
  const cacheOptions = { cacheDirectory, releaseSha, namespace: bootstrapSha256, key: cacheKey, signal };
  await archive.assertPrivate();
  if (cacheBundle) {
    const info = await fs.lstat(cacheBundle).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (info) {
      check(info.isFile() && info.uid === process.getuid() && (info.mode & 0o777) === 0o600 && info.nlink === 1
        && await fs.realpath(cacheBundle) === cacheBundle);
      await restoreDriverAuditHostedCache({ ...cacheOptions, stream: createReadStream(cacheBundle) });
    }
  }
  const input = await collect(archive, bootstrapSha256 + '.gz', limit + 1024, signal);
  const manifest = decodeDriverAuditHostedWorkerBootstrap(input, { root, releaseSha, supabaseSecret });
  await materialize(root, manifest, archive, signal);
  const sourceFile = path.join(root, manifest.source), syncFile = path.join(root, 'sync.json');
  const source = JSON.parse(await readPrivateDriverAuditSource(sourceFile, MiB));
  const preflightInput = { root, ...manifest.preflight };
  check(source?.environment?.path === path.join(path.dirname(sourceFile), 'environment.private.json'));
  const environment = JSON.parse(await readPrivateDriverAuditSource(source.environment.path, MiB));
  check(environment.MATTER_SUPABASE_SECRET === supabaseSecret && environment.DRIVER_AUDIT_EXECUTION_HOST === 'off-host'
    && environment.MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY === cacheDirectory && environment.DRIVER_AUDIT_PHOTO_RECOVERY_STORE === 'supabase');
  const backend = await createDriverAuditSupabaseAppBackend({ env: { ...environment, DRIVER_AUDIT_SUPABASE_SECRET: supabaseSecret },
    fetchImpl: controlledFetch });
  const state = createCloudState({ rpc: backend.rpcForResponseLimit(512 * 1024) });
  const proofs = createHostedProofState(state, { releaseSha, bootstrapSha256 });
  const readQualification = async () => (await proofs.read('qualification', 32 * 1024)).value;
  if (mode === '--once') {
    const qualification = await readQualification();
    const { value } = await proofs.read('enrollment', 16 * 1024);
    const launch = verifiedEnrollment(value, preflightInput, qualification);
    const head = await state.read('app-sidi-report-head');
    check(head.revision >= value.servingHeadRevision && head.body !== null
      && (head.revision > value.servingHeadRevision || sha(head.body) === value.servingHeadBodySha256)
      && hex(JSON.parse(head.body).lightView?.sha256));
    await fs.writeFile(path.join(root, 'launch-verified.private.json'), JSON.stringify(launch), { flag: 'wx', mode: 0o600 });
  }
  const heartbeatFile = path.join(root, 'sync-status.private.json');
  const cursorFile = path.join(cacheDirectory, '.collector-state-read-v1.json');
  const checkpointIdentity = 'driver-report-hosted-checkpoint-v1:' + releaseSha + ':' + bootstrapSha256;
  function checkpointScope({ qualification, enrollment }) {
    check(qualification?.verified === true && qualification.releaseSha === releaseSha
      && qualification.bootstrapSha256 === bootstrapSha256 && enrollment?.syncSha256 === preflightInput.syncSha256
      && enrollment?.sourceSha256 === preflightInput.sourceConfigSha256);
    return sha(JSON.stringify([qualification, enrollment]));
  }
  function validateCheckpoint(saved, scope) {
    check(exact(saved, ['scope', 'heartbeat', 'cursor']) && saved.scope === scope
      && (saved.heartbeat === null || typeof saved.heartbeat === 'string' && Buffer.byteLength(saved.heartbeat) <= 65536)
      && (saved.cursor === null || typeof saved.cursor === 'string' && Buffer.byteLength(saved.cursor) <= 2048));
    const heartbeat = saved.heartbeat && JSON.parse(saved.heartbeat);
    if (heartbeat?.pendingWorkerStatus) validateDriverAuditSupabaseWorkerSlotStatus(heartbeat.pendingWorkerStatus);
    return saved;
  }
  return {
    syncFile, sourceFile, preflightInput, fixtureSha256: manifest.fixture.sha256,
    fixturePath: path.join(root, manifest.fixture.path),
    readArchive: (key, options) => backend.archive.readObject(key, options),
    readTransferUsage: backend.readTransferUsage,
    readQualification,
    async writeQualification(value) {
      check(mode === '--qualify' && value?.verified === true && value.releaseSha === releaseSha && value.bootstrapSha256 === bootstrapSha256
        && value.syncSha256 === preflightInput.syncSha256 && value.sourceConfigSha256 === preflightInput.sourceConfigSha256
        && value.fixtureSha256 === manifest.fixture.sha256 && value.platform === 'linux' && iso(value.qualifiedAt));
      return proofs.write('qualification', value, { maximum: 32 * 1024, once: true });
    },
    async restoreCheckpoint(binding) {
      const scope = checkpointScope(binding);
      const { value } = await proofs.read('checkpoint', 128 * 1024);
      if (value === null) {
        const prior = await state.read('app-sidi-report-worker-claim');
        const claim = prior.body && JSON.parse(prior.body);
        check(!claim || claim.syncConfigSha256 !== binding.enrollment.syncSha256
          || claim.sourceConfigSha256 !== binding.enrollment.sourceSha256
          || iso(claim.scheduledAt) && claim.scheduledAt < binding.enrollment.armedAt);
        await proofs.write('checkpoint', seal({ scope, heartbeat: null, cursor: null }, cacheKey, checkpointIdentity,
          70 * 1024).toString('base64'), { maximum: 128 * 1024, once: true });
        return;
      }
      check(typeof value === 'string');
      const bytes = Buffer.from(value, 'base64');
      check(bytes.toString('base64') === value);
      const saved = validateCheckpoint(unseal(bytes, cacheKey, checkpointIdentity, 70 * 1024), scope);
      if (saved.heartbeat) await fs.writeFile(heartbeatFile, saved.heartbeat, { flag: 'wx', mode: 0o600 });
      if (saved.cursor) await fs.writeFile(cursorFile, saved.cursor, { flag: 'wx', mode: 0o600 });
    },
    async writeCheckpoint(binding) {
      const scope = checkpointScope(binding);
      const heartbeat = await optionalPrivate(heartbeatFile, 65536), cursor = await optionalPrivate(cursorFile, 2048);
      const saved = validateCheckpoint({ scope, heartbeat: heartbeat?.toString() ?? null, cursor: cursor?.toString() ?? null }, scope);
      const before = await proofs.read('checkpoint', 128 * 1024);
      if (typeof before.value !== 'string'
        || JSON.stringify(unseal(Buffer.from(before.value, 'base64'), cacheKey, checkpointIdentity, 70 * 1024)) !== JSON.stringify(saved)) {
        await proofs.write('checkpoint', seal(saved, cacheKey, checkpointIdentity, 70 * 1024).toString('base64'), { maximum: 128 * 1024 });
      }
      if (cacheBundle) {
        await archiveCheckpoint(cacheBundle, cacheOptions);
        return { cacheSaved: true };
      }
      return { cacheSaved: false };
    },
    async close() { /* Job owns its disposable, owner-private working directory. */ },
  };
}
