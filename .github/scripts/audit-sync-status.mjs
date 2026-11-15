import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createGunzip, createGzip, gunzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const name = 'matter-driver-audit-sync';
const sha = /^[a-f0-9]{40}$/;
const manifest = /^[a-f0-9]{64}$/;
const attempt = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const heartbeatStates = ['pending', 'checking', 'ready', 'failed', 'budget-deferred', 'capacity-blocked'];
const buildStates = ['building', 'validating', 'ready', 'unchanged', 'superseded', 'retry-pending'];
const tracked = ['combined-reviews.private.json', 'verified-gps-windows.private.json', 'gps-refresh-receipt.private.json',
  'automatic-build.private.json', 'automatic-preservation.private.json', 'automatic-validation.private.json',
  'accepted.private.json', 'direct-seed.private.json'];
const attemptDirectories = ['saved-current', 'server-data', 'audit-objects'];

const missing = error => { if (error.code === 'ENOENT') return null; throw error; };
const stat = file => fs.lstat(file).catch(missing);
const number = value => Number.isFinite(value) && value >= 0 ? value : null;
const iso = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
  ? new Date(value).toISOString() : null;
const allowed = (value, list) => list.includes(value) ? value : null;
const byteCount = value => Number.isSafeInteger(value) && value >= 0;

export async function reclaimReportingMetadata(work) {
  const directory = path.join(work, 'metadata');
  const freeBytes = async () => {
    const disk = await fs.statfs(work);
    return disk.bavail * disk.bsize;
  };
  const beforeBytes = await freeBytes();
  const startFloor = 1024 * 1024 * 1024;
  let removed = 0;
  if (beforeBytes >= startFloor) return { removed, beforeBytes, afterBytes: beforeBytes };
  const info = await stat(directory);
  if (!info) return { removed, beforeBytes, afterBytes: beforeBytes };
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) ||
      await fs.realpath(directory) !== directory) throw Error('Expected the owned private reporting metadata cache');
  const target = startFloor + 32 * 1024 * 1024;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.gz$/.test(entry.name)) continue;
    const file = path.join(directory, entry.name);
    const saved = await stat(file);
    if (!saved?.isFile() || saved.uid !== process.getuid() || (saved.mode & 0o077) ||
        saved.nlink !== 1 || saved.size < 1 || saved.size > 8 * 1024 * 1024) continue;
    const bytes = await readTail(file, 8 * 1024 * 1024, true, true);
    if (!bytes || createHash('sha256').update(bytes).digest('hex') + '.gz' !== entry.name) continue;
    await fs.unlink(file);
    removed++;
    if (await freeBytes() >= target) break;
  }
  return { removed, beforeBytes, afterBytes: await freeBytes() };
}

export async function reclaimArchivedAuditCopies(data, receipts, files, apply) {
  // Build output may have a normal directory mode, inside its owned private attempt.
  // The selected files and the independent receipt directory are still owner-only.
  const parent = path.dirname(data);
  const container = await stat(parent);
  if (!container?.isDirectory() || container.uid !== process.getuid() || (container.mode & 0o077) ||
      await fs.realpath(parent) !== parent) throw Error('Expected an owned private audit attempt');
  for (const directory of [data, receipts]) {
    const receiptDirectory = directory === receipts;
    const info = await stat(directory);
    const checks = { exists: !!info, directory: !!info?.isDirectory(), owned: info?.uid === process.getuid(),
      mode: !!info && (!receiptDirectory || !(info.mode & 0o077)),
      exactPath: !!info && await fs.realpath(directory) === directory };
    if (Object.values(checks).some(value => !value)) {
      console.log(JSON.stringify({ archivedCopyDirectory: receiptDirectory ? 'receipts' : 'generated', checks }));
      throw Error('Expected an owned private audit directory');
    }
  }
  const matches = [];
  const counts = { absent: 0, shared: 0, fileMode: 0, missingReceipt: 0, mismatchedReceipt: 0 };
  for (const [name, hash] of Object.entries(files)) {
    if (!manifest.test(hash) || name !== 'archive-' + hash + '.private.bin') continue;
    const file = path.join(data, name);
    const info = await stat(file);
    if (!info?.isFile()) { counts.absent++; continue; }
    if (info.nlink !== 1) { counts.shared++; continue; }
    if (info.uid !== process.getuid() || (info.mode & 0o077) ||
        info.size < 1 || info.size > 8 * 1024 * 1024 || !info.blocks) { counts.fileMode++; continue; }
    const key = hash + '.gz';
    const receipt = await json(path.join(receipts, key + '.json'));
    if (!receipt) { counts.missingReceipt++; continue; }
    if (receipt.target !== 'matter-report-archive' || receipt.key !== key || receipt.sha256 !== hash ||
        receipt.bytes !== info.size || receipt.verified !== true) { counts.mismatchedReceipt++; continue; }
    const bytes = await readTail(file, 8 * 1024 * 1024, true, true);
    if (!bytes || bytes.length !== info.size || digest(bytes) !== hash) throw Error('Superseded audit copy hash mismatch');
    matches.push({ file, allocatedBytes: info.blocks * 512 });
  }
  if (apply) for (const { file } of matches) await fs.unlink(file);
  return { copies: matches.length, allocatedBytes: matches.reduce((total, item) => total + item.allocatedBytes, 0), counts };
}

export async function offloadReportingBackup({ backup, maxChunkBytes = 8 * 1024 * 1024, expectedBytes, verify, save }) {
  if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 1 || maxChunkBytes > 8 * 1024 * 1024) {
    throw Error('Invalid archive chunk size');
  }
  const handle = await fs.open(backup, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) ||
        info.nlink !== 1 || info.size < 1 ||
        (expectedBytes === undefined ? info.size > 700 * 1024 * 1024 : info.size !== expectedBytes)) {
      throw Error('Unverified retained reporting backup');
    }
    const hash = createHash('sha256');
    const chunks = [];
    for (let offset = 0; offset < info.size; offset += maxChunkBytes) {
      const size = Math.min(maxChunkBytes, info.size - offset);
      const bytes = Buffer.alloc(size);
      const { bytesRead } = await handle.read(bytes, 0, size, offset);
      if (bytesRead !== size) throw Error('The retained reporting backup changed');
      hash.update(bytes);
      const sha256 = digest(bytes);
      const key = sha256 + '.gz';
      const receipt = await verify(key, size, async () => bytes);
      if (receipt?.verified !== true || receipt.key !== key || receipt.sha256 !== sha256) throw Error('Unverified reporting archive chunk');
      chunks.push({ offset, size, sha256, key });
    }
    const current = await stat(backup);
    if (!current || current.dev !== info.dev || current.ino !== info.ino || current.size !== info.size ||
        current.mtimeMs !== info.mtimeMs || current.ctimeMs !== info.ctimeMs) throw Error('The retained reporting backup changed');
    await save({ version: 1, size: info.size, sha256: hash.digest('hex'), chunks });
    await fs.unlink(backup);
    return { bytes: info.size, chunks: chunks.length };
  } finally {
    await handle.close();
  }
}

const scratchNames = new Set(['combined-reviews.private.json', 'verified-gps-windows.private.json',
  'gps-refresh-receipt.private.json', 'automatic-validation.private.json']);
const maximumScratchBytes = 256 * 1024 * 1024;

async function ownsDirectory(directory, privateOnly = true) {
  const info = await stat(directory);
  return !!info?.isDirectory() && info.uid === process.getuid() &&
    (!privateOnly || !(info.mode & 0o077)) && await fs.realpath(directory) === directory;
}

export async function compactRotatedReportingLogs({directory, active, apply}) {
  if (!await ownsDirectory(directory,false)) throw Error('Expected the existing supervisor log directory');
  const candidates = [];
  let allocatedBytes = 0, packedBytes = 0, files = 0;
  const aged = Date.now() - 2*60*60*1000;
  const matches = /^(?:matter-driver-audit-sync|matter-delivery-api)-(?:out|error)[-_.]+\d{4}-\d{2}-\d{2}[-_0-9T:.]*\.log$/;
  for (const filename of await fs.readdir(directory)) {
    if (!matches.test(filename)) continue;
    const file = path.join(directory,filename), info = await stat(file);
    if (active.has(file) || !info?.isFile() || info.uid!==process.getuid() || (info.mode & 0o022) ||
        info.nlink!==1 || info.mtimeMs>=aged || info.size<16*1024 || info.size>512*1024*1024 ||
        await stat(file+'.verified.gz')) continue;
    candidates.push({file,info});
  }
  for (const {file,info} of candidates.sort((left,right)=>right.info.blocks-left.info.blocks)) {
    if (allocatedBytes>=400*1024*1024) break;
    if (apply) {
      const temporary = file+'.temporary-'+randomUUID(), destination = file+'.verified.gz';
      const original = createHash('sha256'), recovered = createHash('sha256');
      let originalBytes=0, recoveredBytes=0;
      try {
        await pipeline(createReadStream(file,{flags:constants.O_RDONLY|constants.O_NOFOLLOW}), async function* (stream) {
          for await (const chunk of stream) {
            original.update(chunk);
            originalBytes+=chunk.length;
            yield chunk;
          }
        }, createGzip({level:3}), createWriteStream(temporary,{flags:'wx',mode:0o600}));
        const copy = await fs.stat(temporary);
        if (copy.blocks>=info.blocks) continue;
        await pipeline(createReadStream(temporary),createGunzip(),async stream=>{
          for await (const chunk of stream) {
            recovered.update(chunk);
            recoveredBytes+=chunk.length;
          }
        });
        const latest = await stat(file);
        if (originalBytes!==info.size || recoveredBytes!==originalBytes || original.digest('hex')!==recovered.digest('hex') ||
            latest?.ino!==info.ino || latest.dev!==info.dev || latest.size!==info.size ||
            latest.mtimeMs!==info.mtimeMs || latest.ctimeMs!==info.ctimeMs || latest.nlink!==1) {
          throw Error('Closed supervisor log changed during compression');
        }
        const handle = await fs.open(temporary,constants.O_RDONLY|constants.O_NOFOLLOW);
        try { await handle.sync(); } finally { await handle.close(); }
        await fs.link(temporary,destination);
        const folder = await fs.open(directory,constants.O_RDONLY|constants.O_DIRECTORY);
        try {
          await folder.sync();
          await fs.unlink(file);
          await folder.sync();
        } finally { await folder.close(); }
        packedBytes+=copy.blocks*512;
      } finally {
        await fs.unlink(temporary).catch(missing);
      }
    }
    allocatedBytes+=info.blocks*512;
    files++;
  }
  return {files,allocatedBytes,packedBytes};
}

export async function linkIdenticalBaselineArchive({ baseline, current, baselineFiles, activeFiles, apply }) {
  if (baseline === current || !await ownsDirectory(baseline, false) ||
      !await ownsDirectory(path.dirname(baseline)) || !await ownsDirectory(current, false) ||
      !await ownsDirectory(path.dirname(current))) throw Error('Expected two verified local archive directories');
  const matches = [];
  let allocatedBytes = 0;
  for (const [name, hash] of Object.entries(baselineFiles)) {
    if (!manifest.test(hash) || name !== 'archive-' + hash + '.private.bin' || activeFiles[name] !== hash) continue;
    const source = path.join(current, name), target = path.join(baseline, name);
    const [from, to] = await Promise.all([stat(source),stat(target)]);
    if (!from?.isFile() || !to?.isFile() || from.uid !== process.getuid() || to.uid !== from.uid ||
        from.dev !== to.dev || from.ino === to.ino || from.mode !== to.mode || (to.mode & 0o022) ||
        to.nlink !== 1 || !to.blocks || from.size !== to.size || to.size < 1 || to.size > 32 * 1024 * 1024) continue;
    const [original, duplicate] = await Promise.all([
      readTail(source, from.size, false, true), readTail(target, to.size, false, true),
    ]);
    if (!original || original.length !== from.size || digest(original) !== hash || !duplicate?.equals(original)) {
      throw Error('Staged baseline archive hash mismatch');
    }
    matches.push({source,target,from,to});
    allocatedBytes += to.blocks * 512;
  }
  if (apply) for (const {source,target,from,to} of matches) {
    const temporary = path.join(baseline, '.shared-' + randomUUID());
    await fs.link(source, temporary);
    try {
      const [linked, previous] = await Promise.all([stat(temporary),stat(target)]);
      if (linked?.ino !== from.ino || linked.dev !== from.dev || linked.size !== from.size || linked.mtimeMs !== from.mtimeMs ||
          previous?.ino !== to.ino || previous.dev !== to.dev || previous.size !== to.size || previous.mtimeMs !== to.mtimeMs ||
          previous.nlink !== 1) throw Error('Staged baseline archive changed before relinking');
      await fs.rename(temporary, target);
    } finally {
      await fs.unlink(temporary).catch(missing);
    }
  }
  return { linked: matches.length, allocatedBytes };
}

async function verifiedArchiveChunk(receipts, sha256, size) {
  if (!manifest.test(sha256) || !Number.isSafeInteger(size) || size < 1 || size > 8 * 1024 * 1024) return false;
  const key = sha256 + '.gz';
  const saved = await json(path.join(receipts, key + '.json'));
  return saved?.target === 'matter-report-archive' && saved.key === key && saved.sha256 === sha256 &&
    saved.bytes === size && saved.verified === true;
}

// The caller holds the worker and replica writer locks. Only files in the
// previous published package are eligible, with its manifest and source kept.
export async function reclaimPreviousRuntimeCopies({ directory, receipts, files, manifestFiles, readFile, apply }) {
  if (!await ownsDirectory(directory, false) || !await ownsDirectory(path.dirname(directory)) ||
      !await ownsDirectory(receipts)) throw Error('Expected a private previous runtime directory');
  const matches = [];
  let allocatedBytes = 0;
  for (const [name, reference] of Object.entries(files)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,239}$/.test(name) || name === 'files.private.json' ||
        reference?.domain !== 'previewRuntime' || reference.path !== name ||
        !manifest.test(reference.sha256) || manifestFiles[name] !== reference.sha256 ||
        !Number.isSafeInteger(reference.size) || reference.size < 1 || reference.size > 64 * 1024 * 1024 ||
        !Array.isArray(reference.chunks) || !reference.chunks.length) continue;
    const file = path.join(directory, name), info = await stat(file);
    if (!info?.isFile() || info.uid !== process.getuid() || (info.mode & 0o022) ||
        info.nlink !== 1 || !info.blocks || info.size !== reference.size) continue;
    const verified = await Promise.all(reference.chunks.map(chunk => verifiedArchiveChunk(receipts, chunk.sha256, chunk.size)));
    if (!verified.every(Boolean)) continue;
    const body = await readTail(file, reference.size, false, true);
    if (!body || body.length !== reference.size || digest(body) !== reference.sha256) throw Error('Local reporting runtime hash mismatch');
    const saved = await readFile(reference);
    if (!Buffer.isBuffer(saved) || !saved.equals(body)) throw Error('Reporting runtime replica readback mismatch');
    matches.push(file);
    allocatedBytes += info.blocks * 512;
  }
  if (apply) for (const file of matches) await fs.unlink(file);
  return { removed: matches.length, allocatedBytes };
}

export async function reclaimReplicatedBundle({ bundle, receipts, references, skip, replicaRead, apply }) {
  if (!await ownsDirectory(bundle, false) || !await ownsDirectory(path.dirname(bundle)) ||
      !await ownsDirectory(receipts)) throw Error('Expected a private staged reporting cache');
  const objects = new Map();
  for (const ref of references) {
    let offset = 0;
    for (const chunk of ref.chunks) {
      const {sha256, size} = chunk;
      if (!manifest.test(sha256) || !Number.isSafeInteger(size) || size < 1 || size > 8 * 1024 * 1024 ||
          chunk.offset !== offset) throw Error('Invalid reporting replica archive reference');
      const key = sha256 + '.gz';
      if (objects.has(key) && objects.get(key) !== size) throw Error('Conflicting audit replica chunk lengths');
      objects.set(key, size);
      offset += size;
    }
    if (offset !== ref.size) throw Error('Invalid reporting replica archive length');
  }
  const matches = [];
  let allocatedBytes = 0;
  for (const [key, size] of objects) {
    if (skip.has(key)) continue;
    const file = path.join(bundle, key), info = await stat(file);
    if (!info?.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) || info.nlink !== 1 || info.size !== size) continue;
    const sha256 = key.slice(0, -3);
    if (!await verifiedArchiveChunk(receipts, sha256, size)) continue;
    const local = await readTail(file, size, true, true);
    if (!local || digest(local) !== sha256) throw Error('Local reporting bundle hash mismatch');
    const parts = [];
    let n = 0;
    for await (const part of await replicaRead(key, {maxBytes: size})) {
      n += part.length;
      if (n > size) throw Error('Reporting replica readback mismatch');
      parts.push(part);
    }
    if (n !== size || !Buffer.concat(parts).equals(local)) throw Error('Reporting replica readback mismatch');
    matches.push(file);
    allocatedBytes += info.blocks * 512;
  }
  if (apply) for (const file of matches) await fs.unlink(file);
  return { removed: matches.length, allocatedBytes };
}

export async function planRetiredReportingScratch(work, protectedRoots, latestAttempt) {
  const attempts = path.join(work, 'attempts');
  if (!await ownsDirectory(attempts)) throw Error('Expected private audit attempts');
  const candidates = [];
  async function add(id, name, size, expectedSha256) {
    const relative = path.join(id, name);
    const info = await stat(path.join(attempts, relative));
    if (!info?.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) ||
        info.nlink !== 1 || info.size < 512 * 1024 || info.size > size || !info.blocks) return;
    candidates.push({ relative, size: info.size, blocks: info.blocks, expectedSha256 });
  }
  for (const child of await fs.readdir(attempts, { withFileTypes: true })) {
    const id = child.name;
    if (!child.isDirectory() || !attempt.test(id) || id === latestAttempt) continue;
    const directory = path.join(attempts, id);
    if (protectedRoots.some(root => root === directory || root.startsWith(directory + '/')) ||
        !await ownsDirectory(directory)) continue;
    const [proof, accepted, seed] = await Promise.all([
      json(path.join(directory, 'abandoned-workspace.private.json')),
      stat(path.join(directory, 'accepted.private.json')),
      stat(path.join(directory, 'direct-seed.private.json')),
    ]);
    if (proof?.version !== 1 || proof.kind !== 'abandoned' || proof.status !== 'retired' || accepted || seed) continue;
    for (const name of scratchNames) {
      await add(id, name, maximumScratchBytes);
      await add(id, name + '.retained.gz', maximumScratchBytes);
    }
    const data = path.join(directory, 'server-data');
    if (!manifest.test(proof.manifestSha256) || !await ownsDirectory(data, false)) continue;
    const source = await readTail(path.join(data, 'files.private.json'), 16 * 1024 * 1024, true, true);
    if (!source || digest(source) !== proof.manifestSha256) continue;
    for (const [file, sha256] of Object.entries(JSON.parse(source.toString('utf8')))) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,239}$/.test(file) || !manifest.test(sha256)) continue;
      await add(id, 'server-data/' + file, maximumScratchBytes, sha256);
    }
  }
  const files = [];
  let bytes = 0, allocatedBytes = 0;
  for (const file of candidates.sort((a, b) => b.blocks - a.blocks || a.relative.localeCompare(b.relative))) {
    if (bytes + file.size > maximumScratchBytes) continue;
    files.push(file);
    bytes += file.size;
    allocatedBytes += file.blocks * 512;
  }
  return { attempts, files, bytes, allocatedBytes };
}

async function readRetentionInputs(appRoot) {
  const server = path.join(appRoot, 'server');
  await import(pathToFileURL(path.join(server, 'loadEnv.js')).href);
  const require = createRequire(path.join(server, 'package.json'));
  const mongoose = require('mongoose');
  const connection = mongoose.createConnection(process.env.MONGODB_URI, {
    autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 5000,
  });
  try {
    await connection.asPromise();
    const control = connection.db.collection('driverAuditControl');
    const [entry, stage, capacity] = await Promise.all([
      control.findOne({ _id: 'head' }, { projection: { head: 1 } }),
      control.findOne({ _id: 'direct-stage' }, { projection: { _id: 1 } }),
      control.findOne({ _id: 'capacity' }, { projection: { limit: 1, used: 1 } }),
    ]);
    const head = entry?.head;
    if (![head?.generation, head?.previous?.generation].every(value => manifest.test(value)) ||
        !byteCount(capacity?.limit) || !byteCount(capacity?.used) || capacity.used > capacity.limit) {
      throw Error('The retained audit release identity is unavailable');
    }
    return { generation: head.generation, previousGeneration: head.previous.generation,
      revision: number(head.directImport?.collectorRevision), previousRevision: number(head.previous.directImport?.collectorRevision),
      importedAt: iso(head.importedAt instanceof Date ? head.importedAt.toISOString() : head.importedAt),
      stagePending: !!stage, capacityBytes: capacity.limit, usedBytes: capacity.used };
  } finally { await connection.close(); }
}

function capacityFailure(saved) {
  if (saved?.status !== 'capacity-blocked' || saved.errorCode !== 'AUDIT_CAPACITY') return null;
  const { kind, availableBytes, requiredBytes } = saved.capacity ?? {};
  if (kind === 'build-disk' && availableBytes === null && requiredBytes === null) return { kind, availableBytes, requiredBytes };
  if (!allowed(kind, ['build-disk', 'replica-storage', 'import-transfer']) || !byteCount(requiredBytes)
    || requiredBytes === 0 || (availableBytes === null ? kind !== 'build-disk' : !byteCount(availableBytes) || availableBytes >= requiredBytes)) return null;
  return { kind, availableBytes, requiredBytes };
}

async function readTail(file, maximumBytes, privateOnly = false, binary = false) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(missing);
  if (!handle) return null;
  try {
    const info = await handle.stat();
    if (!info.isFile() || privateOnly && (info.mode & 0o077 || info.size > maximumBytes)) return null;
    const length = Math.min(info.size, maximumBytes), bytes = Buffer.alloc(length);
    const { bytesRead } = await handle.read(bytes, 0, length, info.size - length);
    const result = bytes.subarray(0, bytesRead);
    return binary ? result : result.toString('utf8');
  } finally {
    await handle.close();
  }
}

async function json(file, limit = 256 * 1024) {
  const source = await readTail(file, limit, true);
  try { return source ? JSON.parse(source) : null; }
  catch { return null; }
}

async function summarizeDirectory(directory) {
  if (!(await stat(directory))?.isDirectory()) return null;
  const limit = 8192;
  let entries = 0, files = 0, bytes = 0, allocatedBytes = 0, latest = 0;
  for await (const entry of await fs.opendir(directory)) {
    if (entries === limit) break;
    entries++;
    if (!entry.isFile()) continue;
    const info = await stat(path.join(directory, entry.name));
    if (!info?.isFile()) continue;
    files++;
    bytes += info.size;
    allocatedBytes += info.blocks * 512;
    latest = Math.max(latest, info.mtimeMs);
  }
  return { files, bytes, allocatedBytes, latestWriteAt: latest ? new Date(latest).toISOString() : null, bounded: entries === limit };
}

async function summarizeAttemptDirectories(directory) {
  return Object.fromEntries(await Promise.all(attemptDirectories.map(async key => [key, await summarizeDirectory(path.join(directory, key))])));
}

async function summarizeAttempts(work, current, saved, progress) {
  const root = path.join(work, 'attempts');
  if (!(await stat(root))?.isDirectory() || await fs.realpath(root) !== root) return null;
  const keep = new Set([current?.privateRoot, current?.previous?.privateRoot, current?.baselineRoot]
    .filter(value => typeof value === 'string').map(value => path.dirname(value)));
  const found = [];
  let scanned = 0, scanBounded = false;
  for await (const entry of await fs.opendir(root)) {
    if (scanned === 4096) { scanBounded = true; break; }
    scanned++;
    if (!entry.isDirectory() || !attempt.test(entry.name)) continue;
    const directory = path.join(root, entry.name), info = await stat(directory);
    if (!info?.isDirectory()) continue;
    const children = await fs.opendir(directory).catch(missing);
    if (!children) continue;
    let nonempty;
    try { nonempty = !!await children.read(); }
    finally { await children.close(); }
    found.push({ id: entry.name, directory, nonempty, modified: info.mtimeMs });
  }
  const selected = found.sort((a, b) => Number(b.nonempty) - Number(a.nonempty) || b.modified - a.modified).slice(0, 64);
  const summaries = [];
  for (const { id, directory, nonempty, modified } of selected) {
    const [accepted, seed, proof, abandoned, legacy, direct, directories] = await Promise.all([
      json(path.join(directory, 'accepted.private.json')),
      json(path.join(directory, 'direct-seed.private.json')),
      json(path.join(directory, 'retired-workspace.private.json')),
      json(path.join(directory, 'abandoned-workspace.private.json')),
      json(path.join(directory, 'compacted-files.private.json')),
      summarizeDirectory(directory),
      summarizeAttemptDirectories(directory),
    ]);
    const protectedByPointer = keep.has(directory);
    const protectedByHeartbeat = manifest.test(saved?.activeGeneration) && seed?.pointer?.generation === saved.activeGeneration;
    const inUse = ['building', 'validating'].includes(progress?.status) && progress.id === id;
    summaries.push({ id, nonempty, modifiedAt: new Date(modified).toISOString(), accepted: !!accepted, seed: !!seed,
      prepared: proof?.status === 'prepared', retired: proof?.status === 'retired', legacyCompacted: legacy?.complete === true,
      abandonedPrepared: abandoned?.status === 'prepared', abandonedRetired: abandoned?.status === 'retired',
      abandonedScope: ['copies-only', 'source-and-rebuild'].includes(abandoned?.scope) ? abandoned.scope : null,
      protected: protectedByPointer || protectedByHeartbeat || inUse, protectedByPointer, protectedByHeartbeat, inUse,
      collectorRevision: number(accepted?.collectorRevision ?? seed?.collectorRevision), direct, directories });
  }
  return { observed: found.length, nonempty: found.filter(item => item.nonempty).length, omitted: found.length - selected.length,
    scanBounded, summaries };
}

async function summarizeLogs(pm2Home) {
  const counts = { refreshPaused: 0, startupFailed: 0, memoryLimit: 0, retirementDeferred: 0, lastRetirementDeferredAttempts: null, lastAbandonedRetirement: null, lastArchiveCopyRetirement: null, other: 0 };
  const file = path.join(pm2Home, 'logs', name + '-error.log');
  const log = await readTail(file, 32 * 1024).catch(() => null);
  for (const line of (log || '').split(/\r?\n/).filter(Boolean).slice(-40)) {
    const deferred = /\{"event":"audit-workspace-retirement-deferred","attempts":([1-9]\d{0,4})\}$/.exec(line);
    const abandoned = /\{"event":"audit-workspace-abandoned-retired","attempts":([1-9]\d{0,4}),"files":([1-9]\d{0,8}),"bytes":(\d{1,15}),"allocatedBytes":(\d{1,15}),"freeDiskDeltaBytes":(-?\d{1,15})\}$/.exec(line);
    const copies = /\{"event":"audit-workspace-archive-copies-retired","files":([1-9]\d{0,8}),"bytes":(\d{1,15}),"allocatedBytes":(\d{1,15}),"freeDiskDeltaBytes":(-?\d{1,15})\}$/.exec(line);
    if (line.includes('Driver audit sync paused this refresh.')) counts.refreshPaused++;
    else if (line.includes('Driver audit sync could not start.')) counts.startupFailed++;
    else if (/heap out of memory|Reached heap limit/.test(line)) counts.memoryLimit++;
    else if (deferred) { counts.retirementDeferred++; counts.lastRetirementDeferredAttempts = Number(deferred[1]); }
    else if (abandoned) {
      const [attempts, files, bytes, allocatedBytes, freeDiskDeltaBytes] = abandoned.slice(1).map(Number);
      counts.lastAbandonedRetirement = { attempts, files, bytes, allocatedBytes, freeDiskDeltaBytes };
    }
    else if (copies) {
      const [files, bytes, allocatedBytes, freeDiskDeltaBytes] = copies.slice(1).map(Number);
      counts.lastArchiveCopyRetirement = { files, bytes, allocatedBytes, freeDiskDeltaBytes };
    }
    else counts.other++;
  }
  return counts;
}

function syncRoot(appRoot, entry) {
  const server = path.join(appRoot, 'server'), base = path.join(server, '.private/driver-audits');
  const pm = entry.pm2_env;
  const file = pm?.args?.[1];
  const root = typeof file === 'string' ? path.dirname(file) : '';
  if (entry.name !== name || pm?.pm_cwd !== server || pm.pm_exec_path !== path.join(server, 'scripts/driverAuditSync.js')
    || !Array.isArray(pm.args) || pm.args.length !== 2 || pm.args[0] !== '--config'
    || path.dirname(root) !== base || !manifest.test(path.basename(root)) || file !== path.join(root, 'sync.json')) {
    throw Error('The registered process does not match the reviewed audit worker');
  }
  return root;
}

export async function readAuditSyncStatus({ appRoot, pm2Home, entry }) {
  const disk = await fs.statfs(appRoot);
  const memory = await fs.readFile('/proc/meminfo', 'utf8').catch(() => '');
  const available = /^MemAvailable:\s+(\d+) kB$/m.exec(memory);
  const host = { freeMemoryBytes: available ? Number(available[1]) * 1024 : os.freemem(), freeDiskBytes: disk.bavail * disk.bsize };
  if (!entry) return { host, worker: { registered: false }, logs: await summarizeLogs(pm2Home) };

  const root = syncRoot(appRoot, entry);
  if (await fs.realpath(root) !== root || !(await stat(root))?.isDirectory()) throw Error('The audit workspace is unavailable');
  const pm = entry.pm2_env, work = path.join(root, 'work');
  const workDisk = await fs.statfs(work).catch(missing);
  host.workFreeDiskBytes = workDisk ? workDisk.bavail * workDisk.bsize : null;
  const current = await json(path.join(work, 'current.private.json'));
  const progress = await json(path.join(work, 'status.private.json'));
  const saved = await json(path.join(root, 'sync-status.private.json'));
  const attemptId = [progress?.id, progress?.attempt?.id, typeof current?.privateRoot === 'string'
    ? path.basename(path.dirname(current.privateRoot)) : null].find(value => typeof value === 'string' && attempt.test(value));
  const directory = attemptId ? path.join(work, 'attempts', attemptId) : null;
  const files = {};
  let directories = {};
  if (directory && (await stat(directory))?.isDirectory() && await fs.realpath(directory) === directory) {
    for (const file of tracked) {
      const info = await stat(path.join(directory, file));
      if (info?.isFile()) files[file] = { bytes: info.size, modifiedAt: info.mtime.toISOString() };
    }
    directories = await summarizeAttemptDirectories(directory);
  }
  const started = number(pm.pm_uptime);
  return {
    host,
    worker: { registered: true, status: allowed(pm.status, ['online', 'stopped', 'errored', 'launching', 'stopping', 'waiting restart']),
      pid: number(entry.pid), restarts: number(pm.restart_time), elapsedMs: started ? Math.max(0, Date.now() - started) : null,
      rssBytes: number(entry.monit?.memory), cpuPercent: number(entry.monit?.cpu) },
    heartbeat: saved && { status: allowed(saved.status, heartbeatStates), errorCode: allowed(saved.errorCode, ['AUDIT_BUDGET', 'AUDIT_CAPACITY', 'SYNC_FAILED']),
      capacity: capacityFailure(saved),
      replicaGcStatus: allowed(saved.replicaGcStatus, ['off', 'qualified', 'proof-required', 'proof-stale']),
      checkedAt: iso(saved.checkedAt), nextCheckAt: iso(saved.nextCheckAt), latestCaptureAt: iso(saved.latestCaptureAt), visibleCutoffAt: iso(saved.visibleCutoffAt) },
    build: { status: allowed(progress?.status, buildStates), startedAt: iso(progress?.startedAt ?? progress?.attempt?.startedAt),
      checkedAt: iso(progress?.checkedAt), candidateVerifiedAt: iso(current?.verifiedAt), files, directories },
    attempts: await summarizeAttempts(work, current, saved, progress),
    archiveCache: await summarizeDirectory(path.join(work, 'archive-cache')),
    metadataCache: await summarizeDirectory(path.join(work, 'metadata')),
    stagedBaseline: await summarizeDirectory(path.join(root, 'baseline')),
    logs: await summarizeLogs(pm2Home),
  };
}

// This payload is limited to the exact reviewed code-only export.
const candidateBuilder = '5780bdb95450558e4cc7dba91b3ed593fdd0b149648a6602b7c5ed441dec84c3';
const previousBuilder = '5ee269b38fa25a6ccb2f418822155a1255b2237a80bb0156ddb24100b47c6729';
const reviewedAppCommit = '55b3519d2ad759a4c1ac5ccd0e78cce8c7bf8f5e';
const bundleHash = 'cd3cc458e4046cead217cbeb3cbdb90014e00af111b1d0bd52681cb142026024';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const codePath = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.(?:mjs|js)$/;
const smokeSource = String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {gzip,gunzip} from 'node:zlib';
import {promisify} from 'node:util';
const [builder, expected, volume, verifier, ...rest] = process.argv.slice(2);
const { verifyAuditBuilder } = await import(pathToFileURL(verifier).href);
assert(path.isAbsolute(builder??'')&&path.isAbsolute(volume??'')&&!rest.length,'Expected builder path, SHA-256 and private scratch parent');
await verifyAuditBuilder(builder,expected);
const exportsByFile={
  'integration/cloud/automatic-release.mjs':['automaticReleaseBasis','createAutomaticRelease'],
  'integration/cloud/automatic-release-source.mjs':['createAutomaticReleaseSource'],
  'integration/cloud/automatic-release-build.mjs':['buildAutomaticRelease'],
  'scripts/run-automatic-report.mjs':['validateAutomaticCandidate'],
};
for(const [file,names] of Object.entries(exportsByFile)){
  const loaded=await import(pathToFileURL(path.join(builder,file)).href);
  for(const name of names)assert.equal(typeof loaded[name],'function');
}
const {compactDirectBuildVersion}=await import(pathToFileURL(path.join(builder,'integration/cloud/automatic-release-build.mjs')).href);
assert.equal(compactDirectBuildVersion,1);

const scratch=await fs.mkdtemp(path.join(await fs.realpath(volume),'audit-builder-smoke-'));
try{
  const db=new DatabaseSync(path.join(scratch,'lock.sqlite'));
  try{db.exec('BEGIN EXCLUSIVE; ROLLBACK;');}finally{db.close();}
  const original=Buffer.from('audit builder smoke\n'.repeat(256));
  const file=path.join(scratch,'scratch.gz');
  await fs.writeFile(file,await promisify(gzip)(original),{mode:0o600,flag:'wx'});
  await fs.link(file,file+'.linked');
  assert.equal((await fs.stat(file)).ino,(await fs.stat(file+'.linked')).ino);
  assert.deepEqual(await promisify(gunzip)(await fs.readFile(file+'.linked')),original);
  const directory=await fs.open(scratch,'r');
  try{await directory.sync();}finally{await directory.close();}
}finally{await fs.rm(scratch,{recursive:true,force:true});}
console.log(JSON.stringify({status:'checked',platform:process.platform,release:os.release(),node:process.version,builderSha256:expected}));
`;

export async function stageQualificationBuilder({ source, target, encoded, expectedBundleHash, expectedBuilder, verify }) {
  if (typeof encoded !== 'string' || encoded.length > 48000 || digest(encoded) !== expectedBundleHash) {
    throw Error('Unexpected private builder bundle');
  }
  const bundle = JSON.parse(gunzipSync(Buffer.from(encoded, 'base64'), { maxOutputLength: 128 * 1024 }));
  const manifestBytes = Buffer.from(bundle.manifest, 'base64');
  const parsed = JSON.parse(manifestBytes);
  if (bundle.version !== 1 || parsed.version !== 1 || digest(manifestBytes) !== expectedBuilder ||
      !parsed.files || !bundle.delta || !Object.hasOwn(parsed.files, 'scripts/run-automatic-report.mjs')) {
    throw Error('Unexpected replacement builder manifest');
  }
  const files = Object.entries(parsed.files);
  if (files.length > 128 || Object.keys(bundle.delta).some(name => !Object.hasOwn(parsed.files, name)) ||
      files.some(([name, hash]) => name.length >= 512 || !codePath.test(name) || !manifest.test(hash))) {
    throw Error('Unexpected replacement builder file list');
  }
  await fs.mkdir(target, { mode: 0o700 });
  for (const [name, hash] of files) {
    const sourceFile = path.join(source, name);
    const bytes = Object.hasOwn(bundle.delta, name)
      ? Buffer.from(bundle.delta[name], 'base64')
      : await fs.readFile(sourceFile);
    if (bytes.length > 8 * 1024 * 1024 || digest(bytes) !== hash) throw Error('Replacement builder file hash mismatch');
    const output = path.join(target, name);
    await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
    await fs.writeFile(output, bytes, { mode: 0o600, flag: 'wx' });
  }
  await fs.writeFile(path.join(target, 'runtime-manifest.json'), manifestBytes, { mode: 0o600, flag: 'wx' });
  await verify(target, expectedBuilder);
  return files.length;
}

async function qualifyBuilder(appRoot, entry, pm2Home, encoded) {
  if (process.platform !== 'linux' || entry?.pm2_env?.status !== 'online' ||
      !Number.isSafeInteger(entry.pid) || entry.pid < 1) throw Error('Online Linux worker required');
  const root = syncRoot(appRoot, entry);
  const info = await stat(root);
  const workerProc = '/proc/' + entry.pid;
  if (!info?.isDirectory() || info.uid !== process.getuid() || info.mode & 0o077 ||
      await fs.realpath(root) !== root || (await fs.stat(workerProc)).uid !== info.uid) {
    throw Error('Managed worker ownership required');
  }
  const work = path.join(root, 'work');
  if (await fs.realpath(work) !== work || (await fs.stat(work)).dev !== info.dev) throw Error('Build volume mismatch');
  const config = await json(path.join(root, 'sync.json'));
  const source = config?.codeRoot;
  const reviewedRoots = [path.join(root, 'builder'), path.join(root, 'builder-staged-' + previousBuilder)];
  if (config?.root !== root || !reviewedRoots.includes(source) || config.builderSha256 !== previousBuilder) {
    throw Error('Running builder pin differs from the reviewed predecessor');
  }
  const node = await fs.realpath(workerProc + '/exe');
  const verifier = path.join(appRoot, 'server/vendor/driver-audits/integration/cloud/driver-audit-handoff.mjs');
  const { verifyAuditBuilder } = await import(pathToFileURL(verifier).href);
  await verifyAuditBuilder(source, previousBuilder);

  const directory = await fs.mkdtemp(path.join(work, 'audit-linux-qualification-'));
  try {
    const code = path.join(directory, 'builder');
    const smoke = path.join(directory, 'smoke.mjs');
    const files = await stageQualificationBuilder({ source, target: code, encoded,
      expectedBundleHash: bundleHash, expectedBuilder: candidateBuilder, verify: verifyAuditBuilder });
    await fs.writeFile(smoke, smokeSource, { mode: 0o600, flag: 'wx' });
    const env = { PATH: '/usr/bin:/bin', HOME: directory, LANG: 'C' };
    const result = await exec(node, [smoke, code, candidateBuilder, directory, verifier], { env, timeout: 30000 });
    const receipt = JSON.parse(result.stdout);
    if (receipt.status !== 'checked' || receipt.platform !== 'linux' || receipt.node !== 'v22.23.4' ||
        receipt.builderSha256 !== candidateBuilder) throw Error('Unexpected Linux smoke receipt');
    const after = await exec('pm2', ['jlist'], { env: { PATH: process.env.PATH, HOME: os.homedir(), PM2_HOME: pm2Home },
      timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
    const rows = JSON.parse(after.stdout).filter(row => row.name === name);
    if (rows.length !== 1 || rows[0].pid !== entry.pid || rows[0].pm_id !== entry.pm_id ||
        rows[0].pm2_env.pm_uptime !== entry.pm2_env.pm_uptime || rows[0].pm2_env.restart_time !== entry.pm2_env.restart_time ||
        rows[0].pm2_env.status !== 'online' || syncRoot(appRoot, rows[0]) !== root ||
        (await json(path.join(root, 'sync.json')))?.builderSha256 !== previousBuilder) {
      throw Error('Managed worker changed during qualification');
    }
    const staged = path.join(root, 'builder-staged-' + candidateBuilder);
    if (await stat(staged)) await verifyAuditBuilder(staged, candidateBuilder);
    else await fs.rename(code, staged);
    await verifyAuditBuilder(staged, candidateBuilder);
    const rootHandle = await fs.open(root, 'r');
    try { await rootHandle.sync(); } finally { await rootHandle.close(); }
    const disk = await fs.statfs(work);
    const memory = await fs.readFile('/proc/meminfo', 'utf8');
    const available = /^MemAvailable:\s+(\d+) kB$/m.exec(memory);
    return { ...receipt, workerUnchanged: true, previousBuilderSha256: previousBuilder, files, staged: true,
      freeDiskBytes: disk.bavail * disk.bsize, freeMemoryBytes: available ? Number(available[1]) * 1024 : null };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  const appRoot = await fs.realpath(process.cwd());
  const expected = process.env.EXPECTED_DEPLOYED_SHA;
  const encoded = process.env.BUILDER_QUALIFICATION_BUNDLE;
  delete process.env.BUILDER_QUALIFICATION_BUNDLE;
  const git = await exec('git', ['rev-parse', 'HEAD'], { cwd: appRoot, timeout: 5000 });
  if (!sha.test(expected) || git.stdout.trim() !== expected) throw Error('Unexpected production checkout');

  const qualify = process.env.QUALIFY_BUILDER === 'true';
  const upgrade = process.env.UPGRADE_BUILDER === 'true';
  const clearCaches = process.env.CLEAR_REPORTING_BUILD_CACHES === 'true';
  const reclaimMetadata = process.env.RECLAIM_REPORTING_METADATA === 'true';
  const reclaimArchived = process.env.RECLAIM_ARCHIVED_REPORTING_WORKSPACE;
  const verifyRenderer = process.env.VERIFY_REPORTING_RENDERER === 'true';
  if (reclaimArchived && !['plan','apply','offload','scratch-plan','scratch-offload','bundle-plan','bundle-release',
    'bundle-previous-plan','bundle-previous-release','bundle-baseline-plan','bundle-baseline-release',
    'inventory','original-backup-plan','original-backup-offload','heap-plan','heap-resume',
    'log-plan','log-compact'].includes(reclaimArchived)) {
    throw Error('Invalid archive reclamation mode');
  }
  const deployAccounting = process.env.DEPLOY_REPORTING_ACCOUNTING === 'true';
  const pauseReporting = process.env.PAUSE_REPORTING_SYNC === 'true';
  const resumeReporting = process.env.RESUME_REPORTING_SYNC === 'true';
  const deployPhotoReads = process.env.DEPLOY_BOUNDED_PHOTO_READS;
  if ([qualify, upgrade, clearCaches, reclaimMetadata, reclaimArchived, verifyRenderer, deployAccounting, pauseReporting, resumeReporting, deployPhotoReads].filter(Boolean).length > 1) throw Error('Select one audit operation');

  const pm2Home = process.env.PM2_HOME || path.join(os.homedir(), '.pm2');
  const socket = await stat(path.join(pm2Home, 'rpc.sock'));
  let entry;
  if (socket?.isSocket()) {
    const daemon = Number((await readTail(path.join(pm2Home, 'pm2.pid'), 32))?.trim());
    if (!Number.isSafeInteger(daemon) || daemon < 1) throw Error('Existing process supervisor unavailable');
    process.kill(daemon, 0);
    const result = await exec('pm2', ['jlist'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
    const entries = JSON.parse(result.stdout).filter(row => row.name === name);
    if (entries.length > 1) throw Error('Multiple audit workers registered');
    [entry] = entries;
  }
  if (pauseReporting || resumeReporting) {
    if (!entry || process.platform !== 'linux' || expected !== '9699b53ac9c69758f125f129fb4e2e7588db8af0') {
      throw Error('The reviewed production reporting worker is required');
    }
    syncRoot(appRoot, entry);
    const config = { cwd: appRoot, timeout: 30_000, maxBuffer: 1024 * 1024 };
    const during = resumeReporting ? 'online' : 'stopped';
    const before = resumeReporting ? 'stopped' : 'online';
    const operation = resumeReporting ? 'resume' : 'pause';
    if (entry.pm2_env.status === before) {
      const { stdout } = await exec(process.execPath, [path.join(appRoot,'server/scripts/driverAuditDeploy.js'), 'deploy-worker-'+operation],
        { ...config, env: { ...process.env, DRIVER_AUDIT_DEPLOY_SHA: expected } });
      if (stdout.trim() !== (resumeReporting ? 'resumed' : 'paused')) throw Error('The reporting worker operation failed');
    }
    const { stdout } = await exec('pm2', ['jlist'], config);
    const workers = JSON.parse(stdout).filter(row => row.name === name);
    if (workers.length !== 1 || workers[0].pm2_env?.status !== during) throw Error('Reporting worker status could not be verified');
    if (pauseReporting) await exec('pm2', ['save'], config);
    console.log(JSON.stringify({ reportingSync: during, checkedAt: new Date().toISOString() }));
    return;
  }
  if (deployPhotoReads) {
    console.log(JSON.stringify(await deployBoundedPhotoReads(appRoot, entry, expected, deployPhotoReads)));
    return;
  }
  if (reclaimMetadata) {
    if (process.platform !== 'linux' || expected !== '9699b53ac9c69758f125f129fb4e2e7588db8af0' ||
        entry?.pm2_env?.status !== 'stopped') throw Error('The reviewed stopped reporting worker is required');
    const root = syncRoot(appRoot, entry);
    const lockModule = path.join(appRoot, 'server/vendor/driver-audits/integration/hosted/worker-lock.mjs');
    const { acquireWorkerLock } = await import(pathToFileURL(lockModule).href);
    const lock = await acquireWorkerLock(path.join(path.dirname(root), 'sync-worker.lock'));
    try {
      console.log(JSON.stringify({ reportingMetadata: await reclaimReportingMetadata(path.join(root, 'work')) }));
    } finally {
      await lock.release();
    }
    return;
  }
  if (verifyRenderer) {
    console.log(JSON.stringify(await verifyReportingRenderer(appRoot, entry, expected)));
    return;
  }
  if (reclaimArchived) {
    if (reclaimArchived.startsWith('log-')) {
      const apply = reclaimArchived==='log-compact';
      if (process.platform!=='linux' || expected!=='9699b53ac9c69758f125f129fb4e2e7588db8af0' ||
          !entry || apply && entry.pm2_env?.status!=='stopped') throw Error('The reviewed reporting worker is required');
      const work = path.join(syncRoot(appRoot,entry),'work');
      const {stdout} = await exec('pm2',['jlist'],{timeout:5000,maxBuffer:8*1024*1024});
      const active = new Set(JSON.parse(stdout).flatMap(({pm2_env:value})=>[
        value?.pm_out_log_path,value?.pm_err_log_path,value?.pm_log_path,
      ]).filter(Boolean));
      const before = await fs.statfs(work);
      const result=await compactRotatedReportingLogs({directory:path.join(pm2Home,'logs'),active,apply});
      const after=await fs.statfs(work);
      console.log(JSON.stringify({rotatedReportingLogs:true,applied:apply,...result,
        beforeBytes:before.bavail*before.bsize,afterBytes:after.bavail*after.bsize}));
      return;
    }
    if (reclaimArchived === 'inventory') {
      if (process.platform !== 'linux' || expected !== '9699b53ac9c69758f125f129fb4e2e7588db8af0' || !entry) {
        throw Error('The reviewed Linux reporting worker is required');
      }
      const root = syncRoot(appRoot, entry), work = path.join(root, 'work');
      const sizes = await Promise.all(Object.entries({
        git:path.join(appRoot, '.git'), supervisorLogs:path.join(pm2Home, 'logs'),
        reportBuilder:path.join(root, 'builder'), reportWorkspace:work,
        archivedBuildBackups:path.join(work, 'retained-audit-builds'),
        reportReceipts:path.join(root, 'archive-receipts'),
        reportMetadata:path.join(work, 'metadata'),
        packageCache:path.join(os.homedir(), '.npm', '_cacache'),
      }).map(async ([key, directory]) => {
        if (!(await stat(directory))?.isDirectory() || await fs.realpath(directory) !== directory) return [key, null];
        const {stdout} = await exec('/usr/bin/du', ['-sxB1', '--', directory], {timeout:20_000, maxBuffer:1024});
        return [key, number(Number(stdout.split(/\s+/, 1)[0]))];
      }));
      const logs = path.join(pm2Home, 'logs');
      const supervisorLogs = {reportSync:0, deliveryApi:0, rotated:0, other:0};
      for (const filename of await fs.readdir(logs).catch(() => [])) {
        if (!filename.endsWith('.log') && !filename.endsWith('.log.gz')) continue;
        const file = await stat(path.join(logs, filename));
        if (!file?.isFile() || file.nlink !== 1) continue;
        const key = filename.match(/^matter-driver-audit-sync-(?:out|error)\.log$/) ? 'reportSync' :
          filename.match(/^matter-delivery-api-(?:out|error)\.log$/) ? 'deliveryApi' :
          filename.endsWith('.log.gz') || /(?:out|error)[-_.]\d/.test(filename) ? 'rotated' : 'other';
        supervisorLogs[key] += file.blocks * 512;
      }
      console.log(JSON.stringify({reportingDiskInventory:Object.fromEntries(sizes), supervisorLogs}));
      return;
    }
    const run = reclaimArchived.startsWith('heap-') ? recoverReportingWorkerHeap :
      reclaimArchived.startsWith('original-backup-') ? offloadOriginalReportingBackup :
      reclaimArchived.startsWith('bundle-') ? reclaimActiveBundle :
      reclaimArchived.startsWith('scratch-') ? offloadRetiredScratch : reclaimRetainedBuild;
    console.log(JSON.stringify(await run(appRoot, entry, expected, reclaimArchived)));
    return;
  }
  if (clearCaches) {
    const root = syncRoot(appRoot, entry);
    const configured = await exec('npm', ['config', 'get', 'cache'], { timeout: 5000 });
    const npmCache = path.join(os.homedir(), '.npm');
    const caches = [path.join(npmCache, '_cacache'), path.join(appRoot, 'client/node_modules/.cache')];
    if (configured.stdout.trim() !== npmCache) throw Error('The npm cache differs from the reviewed location');
    const before = await fs.statfs(root);
    for (const cache of caches) {
      const info = await stat(cache);
      if (!info) continue;
      if (!info.isDirectory() || info.uid !== process.getuid() || await fs.realpath(cache) !== cache) {
        throw Error('The package cache is not an owned directory');
      }
      await fs.rm(cache, { recursive: true });
    }
    const after = await fs.statfs(root);
    console.log(JSON.stringify({ packageCachesCleared: true, beforeBytes: before.bavail * before.bsize,
      afterBytes: after.bavail * after.bsize }));
    return;
  }
  if (deployAccounting) {
    console.log(JSON.stringify(await deployReportingAccounting(appRoot, entry, expected)));
    return;
  }
  if (qualify) {
    console.log(JSON.stringify(await qualifyBuilder(appRoot, entry, pm2Home, encoded)));
  } else if (upgrade) {
    if (expected !== reviewedAppCommit || process.platform !== 'linux' || !entry) {
      throw Error('The qualified production application and registered Linux worker are required');
    }
    const root = syncRoot(appRoot, entry);
    const verifier = path.join(appRoot, 'server/vendor/driver-audits/integration/cloud/driver-audit-handoff.mjs');
    const { verifyAuditBuilder } = await import(pathToFileURL(verifier).href);
    await verifyAuditBuilder(path.join(root, 'builder-staged-' + candidateBuilder), candidateBuilder);
    const { stdout } = await exec(process.execPath,
      [path.join(appRoot, 'server/scripts/driverAuditDeploy.js'), 'audit-builder-upgrade'], {
        cwd: appRoot,
        env: { ...process.env, DRIVER_AUDIT_DEPLOY_SHA: expected,
          DRIVER_AUDIT_BUILDER_FROM: previousBuilder, DRIVER_AUDIT_BUILDER_TO: candidateBuilder },
        timeout: 19 * 60_000, maxBuffer: 65536,
      });
    const receipt = JSON.parse(stdout);
    if (receipt.status !== 'builder-started' || receipt.builderSha256 !== candidateBuilder ||
        receipt.productionAcceptancePending !== true) throw Error('Unexpected builder transition receipt');
    console.log(JSON.stringify({ status: receipt.status, builderSha256: candidateBuilder, productionAcceptancePending: true }));
  } else {
    const status = await readAuditSyncStatus({ appRoot, pm2Home, entry });
    const releases = entry ? await readRetentionInputs(appRoot) : null;
    console.log(JSON.stringify({ ...status, releases }));
  }
}

async function reclaimActiveBundle(appRoot, entry, expected, mode) {
  const apply = mode.endsWith('-release'), previous = mode.startsWith('bundle-previous-');
  const baseline = mode.startsWith('bundle-baseline-');
  if (process.platform !== 'linux' || expected !== '9699b53ac9c69758f125f129fb4e2e7588db8af0' ||
      !entry || (apply && entry.pm2_env?.status !== 'stopped')) throw Error('The reviewed reporting worker is required');
  const root = syncRoot(appRoot, entry), work = path.join(root, 'work');
  const heartbeat = await json(path.join(root, 'sync-status.private.json'));
  if (heartbeat?.replicaGcStatus !== 'qualified') throw Error('Reporting archive restore proof is required');
  const server = path.join(appRoot, 'server');
  const load = file => import(pathToFileURL(path.join(server, file)).href);
  await load('loadEnv.js');
  const [{ acceptedWorkspace },{ createDriverAuditReplica },{ withDriverAuditWriter },{ readManifestBytes },{ acquireWorkerLock }] =
    await Promise.all([
      load('services/driverAuditWorkspaceRetirement.js'), load('services/driverAuditReplica.js'),
      load('services/driverAuditWriter.js'), load('vendor/driver-audits/integration/cloud/repository.mjs'),
      load('vendor/driver-audits/integration/hosted/worker-lock.mjs'),
    ]);
  const mongoose = createRequire(path.join(server, 'package.json'))('mongoose');
  const connection = mongoose.createConnection(process.env.MONGODB_URI, {
    autoIndex: false, autoCreate: false, maxPoolSize: 2, serverSelectionTimeoutMS: 5000,
  });
  let lock;
  try {
    if (apply) lock = await acquireWorkerLock(path.join(path.dirname(root), 'sync-worker.lock'));
    await connection.asPromise();
    const {db} = connection;
    const run = async () => {
      const control = db.collection('driverAuditControl');
      const [saved, stage, capacity, pointer, progress] = await Promise.all([
        control.findOne({_id:'head'}), control.findOne({_id:'direct-stage'}),
        control.findOne({_id:'capacity'},{projection:{limit:1}}),
        json(path.join(work, 'current.private.json'),16*1024*1024),
        json(path.join(work, 'status.private.json')),
      ]);
      const head = saved?.head;
      const interrupted = ['building','validating'].includes(progress?.status);
      if (stage || !head || !progress || interrupted && !apply ||
          head.generation !== heartbeat.activeGeneration) throw Error('The stable active reporting bundle is required');
      const accepted = await acceptedWorkspace(work, pointer, head);
      if (!accepted || accepted.manifest.sha256 !== head.directImport.manifestSha256) throw Error('Active local bundle differs from MongoDB');
      const interruptedAttempt = progress.id ?? progress.attempt?.id;
      if (interrupted && (!attempt.test(interruptedAttempt) || path.basename(accepted.directory) === interruptedAttempt ||
          path.basename(path.dirname(pointer.previous?.privateRoot ?? '')) === interruptedAttempt)) {
        throw Error('An interrupted attempt would overlap a protected bundle');
      }
      if (baseline) {
        const baselineRoot = path.join(root, 'baseline');
        const [config, seed, bytes] = await Promise.all([
          json(path.join(root, 'sync.json')),
          json(path.join(root, 'seed.json')),
          readTail(path.join(baselineRoot, 'files.private.json'), 16*1024*1024, true, true),
        ]);
        if (config?.baselineRoot !== baselineRoot || !manifest.test(seed?.manifestSha256) ||
            !bytes || digest(bytes) !== seed.manifestSha256) throw Error('The original staged baseline differs from its verified seed');
        const before = await fs.statfs(work);
        const result = await linkIdenticalBaselineArchive({baseline:baselineRoot, current:accepted.manifest.root,
          baselineFiles:JSON.parse(bytes), activeFiles:accepted.manifest.files, apply});
        const after = await fs.statfs(work);
        return {baselineLinks:true, applied:apply, ...result, beforeBytes:before.bavail*before.bsize, afterBytes:after.bavail*after.bsize};
      }
      const selected = previous ? head.previous : head;
      if (!selected || previous && (!pointer.previous || pointer.baselineRoot !== pointer.previous.privateRoot ||
          pointer.previous.privateRoot === pointer.privateRoot || selected.generation === head.generation)) {
        throw Error('A separate previous reporting package is required');
      }
      const local = previous ? await acceptedWorkspace(work, pointer.previous, selected) : accepted;
      if (!local || local.manifest.sha256 !== selected.directImport.manifestSha256 ||
          previous && local.seed.collectorRevision >= accepted.seed.collectorRevision) {
        throw Error('The selected local reporting package differs from MongoDB');
      }
      const replica = createDriverAuditReplica(db,{capacityBytes:capacity?.limit});
      const descriptor = JSON.parse((await readManifestBytes(replica, selected.descriptor, {maxBytes:8*1024*1024})).toString('utf8'));
      if (descriptor.generation !== selected.generation || descriptor.reportHash !== selected.reportHash ||
          descriptor.sourceManifestSha256 !== local.manifest.sha256 || !descriptor.files) throw Error('Selected reporting descriptor differs');
      const before = await fs.statfs(work);
      const receipts = path.join(root, 'archive-receipts');
      const result = previous
        ? await reclaimPreviousRuntimeCopies({
          directory: local.accepted.privateRoot, receipts, files: descriptor.files, manifestFiles: local.manifest.files,
          readFile: ref => readManifestBytes(replica, ref, {maxBytes:64*1024*1024}), apply,
        })
        : await reclaimReplicatedBundle({
          bundle: local.seed.bundleRoot, receipts, references: Object.values(descriptor.files),
          skip: new Set(selected.descriptor.chunks.map(chunk => chunk.sha256+'.gz')),
          replicaRead: (key, options) => replica.readObject(key, options), apply,
        });
      const after = await fs.statfs(work);
      return { replicatedBundle: true, previous, applied:apply, revision:selected.directImport.collectorRevision, ...result,
        beforeBytes: before.bavail*before.bsize, afterBytes: after.bavail*after.bsize };
    };
    return apply ? await withDriverAuditWriter(db, run) : await run();
  } finally {
    try { await lock?.release(); } finally { await connection.close(); }
  }
}

async function recoverReportingWorkerHeap(appRoot, entry, expected, mode) {
  const apply = mode === 'heap-resume', mib = 1024 * 1024;
  if (process.platform !== 'linux' || expected !== '9699b53ac9c69758f125f129fb4e2e7588db8af0' ||
      !entry || (apply && entry.pm2_env?.status !== 'stopped')) throw Error('The reviewed reporting worker is required');
  const root = syncRoot(appRoot, entry);
  const settings = entry.pm2_env;
  const inherited = settings.env?.NODE_OPTIONS ?? settings.NODE_OPTIONS ?? '';
  const nodeArgs = settings.node_args;
  if (typeof inherited !== 'string' || (inherited !== '' && !/^--max-old-space-size=\d{1,5}$/.test(inherited)) ||
      (nodeArgs && (!Array.isArray(nodeArgs) || nodeArgs.length)) || settings.exec_interpreter !== process.execPath) {
    throw Error('Unrecognized reporting worker interpreter settings');
  }
  const pmEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['HOME','PATH','USER','LOGNAME','SHELL','LANG','PM2_HOME'].includes(key) || key.startsWith('LC_')));
  const command = (bin, args, env) => exec(bin, args, {cwd:appRoot, env, timeout:15_000, maxBuffer:8*1024*1024});
  const node = async options => {
    const {stdout} = await command(process.execPath, ['-e',
      'console.log(JSON.stringify({limit:require("node:v8").getHeapStatistics().heap_size_limit,constrained:process.constrainedMemory()}))',
    ], {...pmEnv,NODE_OPTIONS:options});
    return JSON.parse(stdout);
  };
  const current = await node(inherited);
  const targetMib = Math.min(4608, Math.floor(current.limit/mib) + 768);
  const options = '--max-old-space-size=' + targetMib;
  const next = await node(options);
  const memory = await fs.readFile('/proc/meminfo','utf8');
  const available = Number(/^MemAvailable:\s+(\d+) kB$/m.exec(memory)?.[1])*1024;
  const hostLimit = next.constrained > 0 ? Math.min(os.totalmem(),next.constrained) : os.totalmem();
  const needed = next.limit + 2048*mib;
  const ceiling = Number(settings.max_memory_restart ?? 0);
  const disk = await fs.statfs(path.join(root,'work'));
  const freeDiskBytes = disk.bavail*disk.bsize;
  const safe = Number.isSafeInteger(available) && next.limit > current.limit &&
    next.limit - current.limit <= 896*mib && available >= needed && hostLimit >= needed &&
    (ceiling === 0 || ceiling >= next.limit + 768*mib) && freeDiskBytes >= 1024*mib;
  const plan = {reportingHeap:true, applied:apply, safe, currentLimit:current.limit, nextLimit:next.limit,
    memoryAvailable:available, hostLimit, freeDiskBytes, existingProcessMemoryCap:ceiling};
  if (!apply) return plan;
  if (!safe) throw Error('The reviewed reporting worker has insufficient headroom');
  const pm2 = (args, env=pmEnv) => command('pm2',args,env);
  const restart = value => pm2(['restart',name,'--update-env'],{...pmEnv,NODE_OPTIONS:value});
  const before = Date.now();
  try {
    await restart(options);
    const {stdout} = await pm2(['jlist']);
    const workers = JSON.parse(stdout).filter(row=>row.name===name);
    if (workers.length!==1 || syncRoot(appRoot,workers[0])!==root || workers[0].pm2_env.status!=='online' ||
        !Number.isSafeInteger(workers[0].pid) || workers[0].pid<1) throw Error('Reporting worker did not restart');
    const environment = await fs.readFile('/proc/'+workers[0].pid+'/environ','utf8');
    if (!environment.split('\0').includes('NODE_OPTIONS='+options)) throw Error('Reporting worker did not apply the reviewed heap');
    const statusFile = path.join(root,'sync-status.private.json');
    let ready = false;
    for (let attempt=0; attempt<15; attempt++) {
      const status = await json(statusFile);
      if (Date.parse(status?.checkedAt)>=before && !status.errorCode && status.replicaGcStatus==='qualified') {
        ready = true;
        break;
      }
      await new Promise(resolve=>setTimeout(resolve,600));
    }
    if (!ready) throw Error('Reporting worker did not report fresh qualified status');
    await pm2(['save']);
    return {...plan, status:'online'};
  } catch (error) {
    await restart(inherited);
    await pm2(['save']);
    throw error;
  }
}

async function verifyReportingRenderer(appRoot, entry, expected) {
  if (process.platform !== 'linux' || expected !== '9699b53ac9c69758f125f129fb4e2e7588db8af0') {
    throw Error('The reviewed production reporting renderer is required');
  }
  syncRoot(appRoot, entry);
  const server = path.join(appRoot, 'server');
  const load = name => import(pathToFileURL(path.join(server, name)).href);
  await load('loadEnv.js');
  const [integration, coordinator] = await Promise.all([
    load('services/driverAuditIntegration.js'),
    load('vendor/driver-audits/integration/cloud/automatic-hosted-preview.mjs'),
  ]);
  const mongoose = createRequire(path.join(server, 'package.json'))('mongoose');
  const connection = mongoose.createConnection(process.env.MONGODB_URI, {
    autoIndex: false, autoCreate: false, maxPoolSize: 2, serverSelectionTimeoutMS: 5000,
  });
  try {
    await connection.asPromise();
    const control = connection.db.collection('driverAuditControl');
    const head = async () => (await control.findOne({_id:'head'}))?.head;
    const before = await head();
    let renderer;
    const reporting = integration.createDriverAuditIntegration({
      db: () => connection.db,
      authenticateStaffToken: () => { throw Error('No staff sign-in in the renderer preflight'); },
      dependencies: { createCoordinator(options) {
        renderer = coordinator.createAutomaticHostedPreview(options);
        return renderer;
      }},
    });
    const initialized = await reporting.prewarm();
    const result = renderer?.status();
    const after = await head();
    const known = new Set([
      'Imported audit object unavailable', 'Imported audit object unavailable or corrupt',
      'Preview package deferred file is absent', 'Preview head advanced during package preparation',
      'Remote preview runtime core exceeds preload limit', 'Preview package generation mismatch',
      'Review snapshot mismatch', 'Invalid private photo binding registry', 'Invalid GPS index',
      'Preview file integrity failure', 'Invalid preview generation identity',
    ]);
    return {
      rendererPreflight: initialized === true ? 'ready' : 'failed',
      sourceRevision: number(before?.directImport?.collectorRevision),
      sourceChanged: before?.generation !== after?.generation,
      loadedCurrent: !!result?.active?.generation && result.active.generation === after?.generation,
      rendererStatus: allowed(result?.status, ['ready','fallback','stale','loading']),
      failure: known.has(result?.lastError) ? result.lastError : result?.lastError ? 'other' : null,
    };
  } finally {
    await connection.close();
  }
}

async function reclaimRetainedBuild(appRoot, entry, expected, mode) {
  const apply = mode !== 'plan';
  if (process.platform !== 'linux' || expected !== '9699b53ac9c69758f125f129fb4e2e7588db8af0' ||
      !entry || (apply && entry.pm2_env?.status !== 'stopped')) throw Error('The reviewed reporting worker is required');
  const root = syncRoot(appRoot, entry);
  const work = path.join(root, 'work');
  const id = '2789d13d-6cd1-49ae-aa5a-f74a77b485db';
  const directory = path.join(work, 'attempts', id);
  const data = path.join(directory, 'server-data');
  const lockModule = path.join(appRoot, 'server/vendor/driver-audits/integration/hosted/worker-lock.mjs');
  const { acquireWorkerLock } = await import(pathToFileURL(lockModule).href);
  const lock = apply ? await acquireWorkerLock(path.join(path.dirname(root), 'sync-worker.lock')) : null;
  try {
    const [status, progress, pointer, accepted, seed, releases, backup, source] = await Promise.all([
      json(path.join(root, 'sync-status.private.json')),
      json(path.join(work, 'status.private.json')),
      json(path.join(work, 'current.private.json'), 16 * 1024 * 1024),
      json(path.join(directory, 'accepted.private.json'), 16 * 1024 * 1024),
      json(path.join(directory, 'direct-seed.private.json'), 16 * 1024 * 1024),
      readRetentionInputs(appRoot),
      stat(path.join(work, 'retained-audit-builds', id + '.tar.gz')),
      readTail(path.join(data, 'files.private.json'), 16 * 1024 * 1024, true, true),
    ]);
    const checks = {
      publishedState: !!progress && !!pointer && status?.replicaGcStatus === 'qualified',
      backup: mode !== 'offload' || (!!backup?.isFile() && backup.uid === process.getuid() && !(backup.mode & 0o077)),
      release: !releases.stagePending && releases.previousRevision > 3008,
      identity: accepted?.collectorRevision === 3008 && seed?.collectorRevision === 3008 && accepted.privateRoot === data,
      manifest: !!source && accepted?.manifestSha256 === digest(source) && seed?.manifestSha256 === accepted.manifestSha256,
      generation: manifest.test(seed?.pointer?.generation) && seed.pointer.generation !== releases.generation &&
        seed.pointer.generation !== releases.previousGeneration,
      unreferenced: !!progress && !!pointer && ![progress.id, progress.attempt?.id].includes(id) &&
        ![pointer.privateRoot, pointer.previous?.privateRoot, pointer.baselineRoot]
          .some(value => typeof value === 'string' && value.startsWith(directory + '/')),
    };
    if (Object.values(checks).some(value => !value)) {
      console.log(JSON.stringify({ retainedAuditProtection: checks }));
      throw Error('Retained audit build is protected');
    }
    const before = await fs.statfs(work);
    const result = mode === 'offload' ? await offloadRetainedBuild(root, work, id, appRoot) :
      await reclaimArchivedAuditCopies(data, path.join(root, 'archive-receipts'), JSON.parse(source.toString('utf8')), apply);
    const after = await fs.statfs(work);
    return { retainedRevision: 3008, applied: apply, ...result, beforeBytes: before.bavail * before.bsize,
      afterBytes: after.bavail * after.bsize };
  } catch (error) {
    const category = typeof error.code === 'string' && /^[A-Z_]{2,32}$/.test(error.code) ? error.code : null;
    const namedFailure = ['Expected an owned private audit directory', 'Superseded audit copy hash mismatch',
      'Retained audit build is protected'].find(message => error.message === message);
    console.log(JSON.stringify({ retainedAuditFailure: { category, namedFailure: namedFailure ?? null } }));
    throw error;
  } finally {
    await lock?.release();
  }
}

async function offloadRetainedBuild(root, work, id, appRoot) {
  if (id !== '2789d13d-6cd1-49ae-aa5a-f74a77b485db') throw Error('Unexpected reporting backup');
  const directory = path.join(work, 'retained-audit-builds');
  const info = await stat(directory);
  if (!info?.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) ||
      await fs.realpath(directory) !== directory) throw Error('Expected an owned private reporting backup directory');
  const backup = path.join(directory, id + '.tar.gz');
  const receipt = path.join(directory, id + '.private.json');
  const { archive, save } = await reportingBackupTransport(appRoot, root, 682054645);
  return offloadReportingBackup({backup, verify: archive.verify, async save(value) {
    if (value.size !== 682054645) throw Error('Unexpected retained reporting backup length');
    await save(receipt, { ...value, kind: 'retained-reporting-workspace-tar-gzip', collectorRevision: 3008 });
  }});
}

async function offloadOriginalReportingBackup(appRoot, entry, expected, mode) {
  const apply = mode === 'original-backup-offload';
  if (process.platform !== 'linux' || expected !== '9699b53ac9c69758f125f129fb4e2e7588db8af0' ||
      !entry || (apply && entry.pm2_env?.status !== 'stopped')) throw Error('The reviewed reporting worker is required');
  const collectorRevision = 2994, expectedBytes = 835257724;
  const id = '7a10b3b0-0a43-4629-b92a-e8f7c623add9';
  const root = syncRoot(appRoot, entry), work = path.join(root, 'work');
  const directory = path.join(work, 'retained-audit-builds');
  if (!await ownsDirectory(directory)) throw Error('Expected private reporting backup directory');
  const backup = path.join(directory, id + '.tar.gz');
  const receipt = path.join(directory, id + '.private.json');
  const load = file => import(pathToFileURL(path.join(appRoot, 'server', file)).href);
  const {acquireWorkerLock} = await load('vendor/driver-audits/integration/hosted/worker-lock.mjs');
  const lock = apply ? await acquireWorkerLock(path.join(path.dirname(root), 'sync-worker.lock')) : null;
  try {
    const [info, priorReceipt, retention, heartbeat] = await Promise.all([
      stat(backup), stat(receipt), readRetentionInputs(appRoot), json(path.join(root, 'sync-status.private.json')),
    ]);
    if (!info?.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) || info.nlink !== 1 ||
        info.size !== expectedBytes || priorReceipt || retention.stagePending || retention.previousRevision <= collectorRevision ||
        !Number.isSafeInteger(retention.previousRevision) || heartbeat?.replicaGcStatus !== 'qualified') {
      throw Error('The exact verified superseded report backup is required');
    }
    const before = await fs.statfs(work);
    const result = { originalBackup:true, applied:apply, collectorRevision, bytes:expectedBytes,
      beforeBytes:before.bavail*before.bsize };
    if (!apply) return result;
    const {archive,save} = await reportingBackupTransport(appRoot, root, expectedBytes + 512*1024*1024);
    const archived = await offloadReportingBackup({backup, expectedBytes, verify:archive.verify, save: value =>
      save(receipt, {...value, kind:'retained-reporting-workspace-tar-gzip', collectorRevision}),
    });
    const after = await fs.statfs(work);
    return {...result, verifiedChunks:archived.chunks, afterBytes:after.bavail*after.bsize};
  } finally {
    await lock?.release();
  }
}

async function reportingBackupTransport(appRoot, root, requiredCapacity) {
  const archiveRoot = path.join(appRoot, 'server/vendor/driver-audits/integration');
  const load = file => import(pathToFileURL(path.join(archiveRoot, file)).href);
  const [{createHostedRpc}, {createCloudState, createArchiveCapacity}, {createSupabaseArchiveTransport},
    {createBudgetedAuditArchive}, {privateAuditJson, privateAuditWrite}] = await Promise.all([
    load('cloud/rpc.mjs'), load('cloud/cloud-state.mjs'), load('hosted/supabase-archive.mjs'),
    load('cloud/driver-audit-archive.mjs'), load('cloud/driver-audit-handoff.mjs'),
  ]);
  const secret = process.env.DRIVER_AUDIT_SUPABASE_SECRET;
  const rpc = createHostedRpc({secret});
  const remote = createSupabaseArchiveTransport({secret});
  await remote.assertPrivate();
  if (!await createArchiveCapacity({rpc})({bytes: requiredCapacity})) throw Error('Existing private archive capacity unavailable');
  const archive = createBudgetedAuditArchive({
    rpc, state: createCloudState({rpc}), remote, receiptRoot: path.join(root, 'archive-receipts'),
    requestBytes: 4096 + 2 * Buffer.byteLength(secret),
    approvedNovemberRelease: true, approvedNovemberSync: true,
    approvedNovemberRecovery: true, approvedNovemberOvernight: true,
  });
  async function save(receipt, proof) {
    const serialized = JSON.stringify(proof);
    await privateAuditWrite(receipt, serialized);
    const handle = await fs.open(receipt, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await handle.sync();
      if (JSON.stringify(await privateAuditJson(receipt)) !== serialized) throw Error('Reporting backup manifest verification failed');
    } finally { await handle.close(); }
    const dirHandle = await fs.open(path.dirname(receipt), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await dirHandle.sync(); } finally { await dirHandle.close(); }
  }
  return { archive, save };
}

async function offloadRetiredScratch(appRoot, entry, expected, mode) {
  const apply = mode === 'scratch-offload';
  if (process.platform !== 'linux' || expected !== '9699b53ac9c69758f125f129fb4e2e7588db8af0' ||
      !entry || (apply && entry.pm2_env?.status !== 'stopped')) throw Error('The reviewed reporting worker is required');
  const root = syncRoot(appRoot, entry), work = path.join(root, 'work');
  if (!await ownsDirectory(work)) throw Error('Expected private audit workspace');
  const lockModule = path.join(appRoot, 'server/vendor/driver-audits/integration/hosted/worker-lock.mjs');
  const { acquireWorkerLock } = await import(pathToFileURL(lockModule).href);
  const lock = apply ? await acquireWorkerLock(path.join(path.dirname(root), 'sync-worker.lock')) : null;
  try {
    const [status, progress, pointer, releases] = await Promise.all([
      json(path.join(root, 'sync-status.private.json')),
      json(path.join(work, 'status.private.json')),
      json(path.join(work, 'current.private.json'), 16 * 1024 * 1024),
      readRetentionInputs(appRoot),
    ]);
    const protectedRoots = [pointer?.privateRoot, pointer?.previous?.privateRoot, pointer?.baselineRoot];
    if (status?.replicaGcStatus !== 'qualified' || releases.stagePending ||
        !progress || !protectedRoots.every(file => typeof file === 'string' && path.isAbsolute(file))) {
      throw Error('The active, previous and baseline reporting workspaces must be protected');
    }
    const plan = await planRetiredReportingScratch(work, protectedRoots, progress.id ?? progress.attempt?.id);
    const before = await fs.statfs(work);
    const beforeBytes = before.bavail * before.bsize;
    const summary = { retiredScratch: true, applied: apply, files: plan.files.length, allocatedBytes: plan.allocatedBytes, beforeBytes };
    if (!apply || plan.allocatedBytes < 100 * 1024 * 1024) return summary;
    if (beforeBytes < maximumScratchBytes + 256 * 1024 * 1024) throw Error('Insufficient safe temporary archive space');
    const directory = path.join(work, 'retained-audit-builds');
    if (!await ownsDirectory(directory)) throw Error('Expected private audit backup directory');
    // Read concurrently with neither the reporting worker nor another recovery.
    const files = [];
    for (const file of plan.files) {
      const bytes = await readTail(path.join(plan.attempts, file.relative), file.size, true, true);
      const sha256 = bytes && digest(bytes);
      if (!bytes || bytes.length !== file.size || (file.expectedSha256 && sha256 !== file.expectedSha256)) {
        throw Error('Retired reporting file changed');
      }
      files.push({ file: file.relative, size: file.size, sha256 });
    }
    const identity = digest(JSON.stringify(files));
    const receipt = path.join(directory, 'retired-' + identity + '.private.json');
    const temp = await fs.mkdtemp(path.join(directory, 'scratch-'));
    try {
      const inventory = path.join(temp, 'files'), backup = path.join(temp, 'reporting.tar.gz');
      await fs.writeFile(inventory, files.map(item => item.file).join('\0') + '\0', { mode: 0o600, flag: 'wx' });
      await fs.writeFile(backup, '', { mode: 0o600, flag: 'wx' });
      const tar = args => exec('/bin/tar', args, { timeout: 180000, maxBuffer: 65536 });
      await tar(['--create','--gzip','--file',backup,'--directory',plan.attempts,'--null','--verbatim-files-from','--files-from',inventory]);
      await tar(['--compare','--gzip','--file',backup,'--directory',plan.attempts]);
      const { size } = await fs.stat(backup);
      const { archive, save } = await reportingBackupTransport(appRoot, root, size + 512 * 1024 * 1024);
      const backupResult = await offloadReportingBackup({backup, verify: archive.verify,
        save: value => save(receipt, { ...value, kind: 'retired-reporting-scratch-tar-gzip', files }) });
      // Keep the exact recovery manifest after a partial local cleanup.
      for (const item of files) await fs.unlink(path.join(plan.attempts, item.file));
      const after = await fs.statfs(work);
      return { ...summary, archiveBytes: backupResult.bytes, afterBytes: after.bavail * after.bsize };
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  } finally {
    await lock?.release();
  }
}


async function deployBoundedPhotoReads(appRoot, entry, expected, target) {
  if (process.platform !== 'linux' || entry?.pm2_env?.status !== 'stopped' ||
      expected !== '904ea1c11efe9185e23aa880070bd1d0f047c735' || !sha.test(target)) {
    throw Error('The reviewed production app and paused reporting worker are required');
  }
  syncRoot(appRoot, entry);
  const command = (name, args) => exec(name, args, { cwd: appRoot, timeout: 60_000, maxBuffer: 1024 * 1024 });
  const git = args => command('git', args);
  await git(['fetch','--no-tags','origin','refs/heads/main:refs/remotes/origin/main']);
  const { stdout } = await git(['rev-parse','origin/main']);
  if (stdout.trim() !== target) throw Error('The exact approved photo read release is required');
  const runtime = 'server/vendor/driver-audits/';
  const modules = ['integration/cloud/report-service.mjs','integration/cloud/preview-runtime.mjs'];
  const manifestPath = runtime + 'runtime-manifest.json';
  const allowed = new Set([...modules.map(file=>runtime+file),manifestPath,
    '.github/scripts/audit-sync-status.mjs','.github/workflows/audit-sync-status.yml']);
  const { stdout: diff } = await git(['diff','--name-only',expected,target,'--']);
  const changed = diff.trim().split('\n');
  if (changed.length !== allowed.size || changed.some(file=>!allowed.has(file))) {
    throw Error('The bounded photo read release contains unexpected paths');
  }
  const { stdout: prior } = await git(['status','--porcelain','--untracked-files=no']);
  const { stdout: pins } = await git(['show',target+':'+manifestPath]);
  if (prior.length) throw Error('Production checkout has tracked changes');
  const files = JSON.parse(pins).files;
  for (const file of modules) {
    const { stdout: source } = await git(['show',target+':'+runtime+file]);
    if (digest(source) !== files[file]) throw Error('The photo runtime differs from its reviewed pin');
  }
  const restart = () => command('pm2',['restart','matter-delivery-api']);
  const verify = () => command(process.execPath,[path.join(appRoot,'server/scripts/customerServiceDeploy.js'),'--verify']);
  await git(['merge','--ff-only',target]);
  try {
    await restart();
    await verify();
    return { installed: target, validated: true };
  } catch (error) {
    await git(['reset','--hard',expected]);
    await restart();
    await verify();
    throw error;
  }
}

async function deployReportingAccounting(appRoot, entry, expected) {
  if (process.platform !== 'linux' || !entry || expected !== reviewedAppCommit) {
    throw Error('The reviewed Linux deployment and reporting worker are required');
  }
  const target = '904ea1c11efe9185e23aa880070bd1d0f047c735';
  const root = syncRoot(appRoot, entry);
  const progress = await json(path.join(root, 'work/status.private.json'));
  if (!progress || ['building','validating'].includes(progress.status)) {
    throw Error('Wait for the active reporting build to finish');
  }
  const runtime = 'server/vendor/driver-audits/';
  const budget = runtime + 'integration/cloud/worker-budget.mjs';
  const manifestPath = runtime + 'runtime-manifest.json';
  const allowed = new Set([
    budget, manifestPath, '.github/scripts/audit-sync-status.mjs', '.github/workflows/audit-sync-status.yml',
  ]);
  const git = args => exec('git', args, { cwd: appRoot, timeout: 30000, maxBuffer: 1024 * 1024 });
  await git(['fetch','--no-tags','origin','refs/heads/main:refs/remotes/origin/main']);
  const { stdout: diff } = await git(['diff','--name-only',expected,target,'--']);
  const changed = diff.trim().split('\n');
  if (changed.length !== allowed.size || changed.some(file => !allowed.has(file))) {
    throw Error('The reviewed release contains unexpected paths');
  }
  const {stdout: prior} = await git(['status','--porcelain','--untracked-files=no']);
  if (prior.length) throw Error('Production checkout has tracked changes');
  const {stdout: source} = await git(['show',target+':'+budget]);
  const {stdout: record} = await git(['show',target+':'+manifestPath]);
  const expectedHash = '7366a1d70fdddec4722a1c097b36c6fc9d8449e7adf157a01576e1914adb66a2';
  if (digest(source) !== expectedHash || JSON.parse(record).files['integration/cloud/worker-budget.mjs'] !== expectedHash) {
    throw Error('The accounting module differs from its reviewed runtime pin');
  }

  const deploy = path.join(appRoot, 'server/scripts/driverAuditDeploy.js');
  const command = (name, args, env = process.env) => exec(name, args, {
    cwd: appRoot, env, timeout: 60000, maxBuffer: 1024 * 1024,
  });
  const worker = (operation, commit) => command(process.execPath, [deploy, operation],
    { ...process.env, DRIVER_AUDIT_DEPLOY_SHA: commit });
  const restartApi = () => command('pm2',['restart','matter-delivery-api']);
  const verify = () => command(process.execPath, [path.join(appRoot,'server/scripts/customerServiceDeploy.js'),'--verify']);
  const pause = await worker('deploy-worker-pause',expected);
  if (pause.stdout.trim() !== 'paused') throw Error('The reporting worker could not be paused');
  let applied = false;
  try {
    await git(['merge','--ff-only',target]);
    applied = true;
    await restartApi();
    await verify();
    await worker('deploy-worker-resume',target);
    return { installed: target, reportingAccountingSha256: expectedHash, validated: true };
  } catch (error) {
    if (applied) {
      await worker('deploy-worker-pause',target);
      await git(['reset','--hard',expected]);
      await restartApi();
      await verify();
    }
    await worker('deploy-worker-resume',expected);
    throw error;
  }
}

if (process.argv[1] === '-' && process.argv[2] === '--print') {
  main().catch(() => {
    if (process.env.UPGRADE_BUILDER === 'true') {
      console.error('Could not confirm activation of the exact qualified builder on the reviewed production checkout.');
      process.exitCode = 1;
      return;
    }
    console.error(process.env.QUALIFY_BUILDER === 'true'
      ? 'Could not verify the pinned Linux builder on the reviewed production host.'
      : 'Could not read audit sync status from the reviewed production checkout.');
    process.exitCode = 1;
  });
}
