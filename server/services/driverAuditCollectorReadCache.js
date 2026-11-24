import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const key = 'collector-state';
const conditional = 'matter_hosted_state_read_if_changed';
const pointerName = '.collector-state-read-v1.json';
const pointerKind = 'supabase-collector-state-read-cache-v1';
const maximumBytes = 512 * 1024 ** 2, maximumFiles = 8192, maximumObject = 16 * 1024 ** 2;
const reserveBytes = 1024 ** 3, pointerLimit = 2048, maximumResponse = 80 * 1024 ** 2;
const objectName = /^[a-f0-9]{64}\.gz$/;
const temporaryName = /^\.(?:source-archive|collector-state-read)-[a-f0-9-]{36}\.tmp$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const own = info => info.uid === BigInt(process.getuid()) && !(Number(info.mode) & 0o077);
const privateFile = info => info.isFile() && own(info) && info.nlink === 1n;
const signature = info => [info.dev, info.ino, info.uid, info.gid, info.mode, info.nlink,
  info.size, info.mtimeNs, info.ctimeNs].map(String).join(':');
const directorySignature = info => [info.dev, info.ino, info.uid, info.gid, info.mode].map(String).join(':');
const allocated = info => Math.max(Number(info.size), Number(info.blocks) * 512);
const missing = error => { if (error.code !== 'ENOENT') throw error; return null; };
const need = (condition, message = 'Invalid collector state response') => { if (!condition) throw Error(message); };
const revision = value => Number.isSafeInteger(value) && value >= 0;
const jsonObject = value => {
  try { const parsed = JSON.parse(value); return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed); }
  catch { return false; }
};
function exact(args, fields) {
  try {
    if (!args || ![Object.prototype, null].includes(Object.getPrototypeOf(args))) return false;
    const descriptors = Object.getOwnPropertyDescriptors(args);
    return Reflect.ownKeys(descriptors).length === fields.length
      && fields.every(name => Object.hasOwn(descriptors, name) && Object.hasOwn(descriptors[name], 'value'));
  } catch { return false; }
}
async function freeBytes(directory) {
  const info = await fs.statfs(directory); return info.bavail * info.bsize;
}

function diskCache(directory, availableBytes, projectRef) {
  const pointer = path.join(directory, pointerName), lockFile = path.join(directory, '.archive-cache-write.sqlite');
  async function spaceFor(bytes) {
    const available = await availableBytes(directory);
    return Number.isSafeInteger(available) && available >= reserveBytes + bytes;
  }
  async function directoryState() {
    const info = await fs.lstat(directory, { bigint: true });
    need(info.isDirectory() && own(info) && await fs.realpath(directory) === directory, 'Collector cache is unavailable');
    return directorySignature(info);
  }
  async function readPrivate(file, maximum, sync = false) {
    const before = await fs.lstat(file, { bigint: true }).catch(missing);
    if (!before) return { status: 'missing' };
    if (!privateFile(before) || await fs.realpath(file) !== file) return { status: 'unsafe' };
    // A corrupt oversized disposable file can be replaced, but is never read.
    if (before.size > BigInt(maximum)) return { status: 'private', bytes: null, signature: signature(before) };
    const opened = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      need(signature(await opened.stat({ bigint: true })) === signature(before), 'Collector cache changed');
      const bytes = Buffer.alloc(Number(before.size));
      for (let offset = 0; offset < bytes.length;) {
        const result = await opened.read(bytes, offset, bytes.length - offset, offset);
        need(result.bytesRead > 0, 'Collector cache changed'); offset += result.bytesRead;
      }
      need((await opened.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead === 0, 'Collector cache changed');
      if (sync) await opened.sync();
      need(signature(await opened.stat({ bigint: true })) === signature(before)
        && signature(await fs.lstat(file, { bigint: true })) === signature(before)
        && await fs.realpath(file) === file, 'Collector cache changed');
      return { status: 'private', bytes, signature: signature(before) };
    } finally { await opened.close(); }
  }
  function parsePointer(saved) {
    if (saved.status !== 'private' || !Buffer.isBuffer(saved.bytes)) return null;
    try {
      const value = JSON.parse(saved.bytes);
      if (saved.bytes.toString('utf8') !== JSON.stringify(value)
          || !exact(value, ['version', 'kind', 'projectRef', 'key', 'revision', 'sha256', 'bytes'])
          || value.version !== 1 || value.kind !== pointerKind || value.projectRef !== projectRef || value.key !== key
          || !revision(value.revision) || value.revision === 0 || !/^[a-f0-9]{64}$/.test(value.sha256)
          || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > maximumObject) return null;
      return value;
    } catch { return null; }
  }
  async function read() {
    try {
      const originalDirectory = await directoryState(), saved = await readPrivate(pointer, pointerLimit), value = parsePointer(saved);
      if (!value) return null;
      const body = await readPrivate(path.join(directory, value.sha256 + '.gz'), maximumObject);
      if (body.status !== 'private' || !Buffer.isBuffer(body.bytes) || body.bytes.length !== value.bytes
          || hash(body.bytes) !== value.sha256 || !jsonObject(body.bytes.toString('utf8'))
          || !Buffer.from(body.bytes.toString('utf8'), 'utf8').equals(body.bytes)
          || await directoryState() !== originalDirectory) return null;
      return { revision: value.revision, body_text: body.bytes.toString('utf8') };
    } catch { return null; }
  }

  async function lock() {
    // Use the SAME SQLite OS exclusion as the immutable archive cache. A short
    // transaction needs no PID receipt; finally always releases it on FS failure.
    const originalDirectory = await directoryState();
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      const info = await fs.lstat(lockFile + suffix, { bigint: true }).catch(missing);
      if (info && (!privateFile(info) || info.size > 65536n || await fs.realpath(lockFile + suffix) !== lockFile + suffix)) return null;
    }
    try { const file = await fs.open(lockFile, 'wx', 0o600); await file.close(); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const before = await fs.lstat(lockFile, { bigint: true });
    if (!privateFile(before)) return null;
    let db, active = false;
    try {
      db = new DatabaseSync(lockFile); db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;'); active = true;
      const after = await fs.lstat(lockFile, { bigint: true });
      need(privateFile(after) && after.dev === before.dev && after.ino === before.ino
        && await fs.realpath(lockFile) === lockFile && await directoryState() === originalDirectory, 'Collector cache changed');
      return { async release() { try { db.exec('ROLLBACK'); } finally { db.close(); } } };
    } catch {
      try { if (active) db.exec('ROLLBACK'); } finally { db?.close(); }
      return null;
    }
  }
  async function inventory() {
    const objects = new Map(); let bytes = 0, seen = 0, cleaned = 0;
    const entries = await fs.opendir(directory);
    for await (const entry of entries) {
      if (++seen > maximumFiles + 128) return null;
      const file = path.join(directory, entry.name), info = await fs.lstat(file, { bigint: true }).catch(missing);
      if (!info) continue;
      if (info.isDirectory()) return null;
      if (temporaryName.test(entry.name) && privateFile(info)) {
        if (++cleaned > 32) return null;
        await fs.unlink(file); continue;
      }
      bytes += allocated(info);
      if (objectName.test(entry.name)) objects.set(entry.name, { bytes: allocated(info), time: Number(info.mtimeMs), owned: privateFile(info) });
    }
    return { objects, bytes };
  }
  async function temporary(bytes, prefix) {
    const file = path.join(directory, '.' + prefix + '-' + randomUUID() + '.tmp');
    const opened = await fs.open(file, 'wx', 0o600);
    try {
      const initial = await opened.stat({ bigint: true }); need(privateFile(initial), 'Collector cache is unavailable');
      await opened.writeFile(bytes); await opened.sync();
      const saved = await opened.stat({ bigint: true }), actual = await fs.lstat(file, { bigint: true });
      need(privateFile(saved) && saved.size === BigInt(bytes.length) && signature(saved) === signature(actual)
        && saved.dev === initial.dev && saved.ino === initial.ino && await fs.realpath(file) === file, 'Collector cache changed');
      return { file, bytes: allocated(saved), signature: signature(saved) };
    } catch (error) { await fs.rm(file, { force: true }).catch(() => {}); throw error; }
    finally { await opened.close(); }
  }
  async function unchangedFile(file, expected) {
    const actual = await fs.lstat(file, { bigint: true }).catch(missing);
    return expected === null ? actual === null : actual && privateFile(actual) && signature(actual) === expected;
  }
  async function remember(value) {
    if (Buffer.byteLength(value.body_text, 'utf8') > maximumObject) return;
    const body = Buffer.from(value.body_text, 'utf8');
    if (!body.length || body.length > maximumObject || body.toString('utf8') !== value.body_text) return;
    const held = await lock(); if (!held) return;
    let bodyTemp, pointerTemp;
    try {
      const originalDirectory = await directoryState(), saved = await readPrivate(pointer, pointerLimit), prior = parsePointer(saved);
      if (saved.status === 'unsafe' || prior && prior.revision > value.revision) return;
      if (prior && prior.revision === value.revision && prior.sha256 !== hash(body)) return;
      const digest = hash(body), target = path.join(directory, digest + '.gz');
      const old = await readPrivate(target, maximumObject);
      if (old.status === 'unsafe') return;
      const bodyPresent = old.status === 'private' && Buffer.isBuffer(old.bytes) && old.bytes.equals(body);
      const record = Buffer.from(JSON.stringify({ version: 1, kind: pointerKind, projectRef, key,
        revision: value.revision, sha256: digest, bytes: body.length }));
      if (record.length > pointerLimit) return;
      const physical = await inventory(); if (!physical) return;
      const blockSize = (await fs.statfs(directory)).bsize;
      need(Number.isSafeInteger(blockSize) && blockSize > 0 && blockSize <= maximumObject, 'Collector cache is unavailable');
      const block = Math.max(4096, blockSize), rounded = bytes => Math.ceil(bytes / block) * block;
      const needed = (bodyPresent ? 0 : rounded(body.length)) + rounded(record.length);
      if (!await spaceFor(needed)) return;
      const number = physical.objects.size + (physical.objects.has(digest + '.gz') ? 0 : 1);
      let count = number, total = physical.bytes;
      for (const [name, entry] of [...physical.objects].sort(([, a], [, b]) => a.time - b.time)) {
        if (total + needed <= maximumBytes && count <= maximumFiles) break;
        if (name === digest + '.gz' || !entry.owned) continue;
        const file = path.join(directory, name), info = await fs.lstat(file, { bigint: true }).catch(missing);
        if (!info || !privateFile(info)) return;
        await fs.unlink(file); total -= entry.bytes; count--;
      }
      if (total + needed > maximumBytes || count > maximumFiles
          || !await spaceFor(needed) || await directoryState() !== originalDirectory) return;
      let additionalBodyBytes = 0;
      if (!bodyPresent) {
        bodyTemp = await temporary(body, 'source-archive');
        if (total + bodyTemp.bytes + rounded(record.length) > maximumBytes
            || !await unchangedFile(target, old.status === 'missing' ? null : old.signature)
            || !await unchangedFile(bodyTemp.file, bodyTemp.signature)) return;
        additionalBodyBytes = bodyTemp.bytes;
        await fs.rename(bodyTemp.file, target); bodyTemp = null;
      }
      const durable = await readPrivate(target, maximumObject, true);
      if (durable.status !== 'private' || !Buffer.isBuffer(durable.bytes) || !durable.bytes.equals(body)) return;
      pointerTemp = await temporary(record, 'collector-state-read');
      if (total + additionalBodyBytes + pointerTemp.bytes > maximumBytes || await directoryState() !== originalDirectory
          || !await unchangedFile(pointer, saved.status === 'missing' ? null : saved.signature)
          || !await unchangedFile(target, durable.signature)
          || !await unchangedFile(pointerTemp.file, pointerTemp.signature)) return;
      await fs.rename(pointerTemp.file, pointer); pointerTemp = null;
      const directoryHandle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { need(directorySignature(await directoryHandle.stat({ bigint: true })) === originalDirectory); await directoryHandle.sync(); }
      finally { await directoryHandle.close(); }
    } finally {
      try { for (const temp of [bodyTemp, pointerTemp]) if (temp) await fs.rm(temp.file, { force: true }); }
      finally { await held.release(); }
    }
  }
  return { read, remember };
}

function state(value, limit) {
  need(value && revision(value.revision) && (value.revision === 0 ? value.body_text === null : typeof value.body_text === 'string' && jsonObject(value.body_text)));
  const result = { revision: value.revision, body_text: value.body_text };
  need(Buffer.byteLength(JSON.stringify(result)) <= limit, 'Collector state exceeds its response limit'); return result;
}
function casSubmission(name, args) {
  try {
    if (!args || !['matter_hosted_collector_cas', 'matter_hosted_collector_cas_review', 'matter_hosted_state_cas'].includes(name)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(args);
    if (name === 'matter_hosted_state_cas' && descriptors.p_key?.value !== key
        || !['p_expected', 'p_body_text', 'p_event_text'].every(field => Object.hasOwn(descriptors[field] || {}, 'value'))) return null;
    const { p_expected: { value: expected }, p_body_text: { value: body }, p_event_text: { value: event } } = descriptors;
    if (!revision(expected) || expected === Number.MAX_SAFE_INTEGER || typeof body !== 'string'
        || !jsonObject(body) || typeof event !== 'string') return null;
    return { revision: expected + 1, body_text: body, event_text: event };
  } catch { return null; }
}

// The immutable body uses the existing shared SHA.gz cache format and mutex.
// Its single pointer is disposable metadata, never an authority or stale fallback.
export function createDriverAuditCollectorReadCache({ cacheDirectory, cacheFreeBytes = freeBytes,
  projectRef = 'trhhjfgfmxofxhnzocks' } = {}) {
  need(typeof cacheDirectory === 'string' && path.isAbsolute(cacheDirectory) && path.resolve(cacheDirectory) === cacheDirectory
    && typeof cacheFreeBytes === 'function' && typeof projectRef === 'string'
    && /^[a-z0-9]{20}$/.test(projectRef), 'A bounded private collector cache is required');
  const cache = diskCache(cacheDirectory, cacheFreeBytes, projectRef);
  const remember = value => cache.remember(value).catch(() => {});
  return {
    wrapRpc(rpc, { maxResponseBytes = 70 * 1024 ** 2 } = {}) {
      need(typeof rpc === 'function' && Number.isSafeInteger(maxResponseBytes) && maxResponseBytes > 0
        && maxResponseBytes <= maximumResponse, 'A bounded collector RPC is required');
      return async function collectorRpc(name, args, ...rest) {
        if (name === 'matter_hosted_state_read' && exact(args, ['p_key']) && args.p_key === key) {
          const cached = await cache.read(), previous = cached?.revision ?? 0;
          const current = await rpc(conditional, { p_key: key, p_revision: previous }, ...rest);
          need(current && revision(current.revision) && typeof current.unchanged === 'boolean');
          let result;
          if (current.unchanged) {
            need(current.revision === previous && current.body_text === null);
            result = cached ? state(cached, maxResponseBytes) : state(await rpc(name, args, ...rest), maxResponseBytes);
          } else {
            need(current.revision > previous); result = state(current, maxResponseBytes);
          }
          if (!current.unchanged || !cached) if (result.body_text !== null) await remember(result);
          return result;
        }
        const submission = casSubmission(name, args), result = await rpc(name, args, ...rest);
        if (submission && result?.revision === submission.revision && result.body_text === submission.body_text
            && result.event_text === submission.event_text && typeof result.replayed === 'boolean'
            && result.body_sha256 === hash(submission.body_text)) await remember(submission);
        else if (name === conditional && exact(args, ['p_key', 'p_revision']) && args.p_key === key
            && revision(args.p_revision) && result?.unchanged === false && result.revision > args.p_revision) {
          try { await remember(state(result, maxResponseBytes)); } catch { /* Cache admission never changes a completed RPC. */ }
        }
        return result;
      };
    },
  };
}
