import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { acquireWorkerLock } from '../vendor/driver-audits/integration/hosted/worker-lock.mjs';

const maxCacheBytes = 512 * 1024 ** 2;
const maxCacheFiles = 8192;
const maxObjectBytes = 16 * 1024 ** 2;
const maxNativeBytes = 64 * 1024 ** 2;
const buildReserve = 1024 ** 3;
const cacheKey = /^[a-f0-9]{64}\.gz$/;
const objectKey = /^[a-f0-9]{64}\.(?:gz|json)$/;
const abandonedTemp = /^\.source-archive-[a-f0-9-]{36}\.tmp$/;
const privateOwner = info => info.uid === process.getuid() && !(info.mode & 0o077);
const allocated = info => Math.max(info.size, info.blocks * 512);
const digest = data => createHash('sha256').update(data).digest('hex');
const missing = error => { if (error.code !== 'ENOENT') throw error; return null; };

async function diskFreeBytes(directory) {
  const info = await fs.statfs(directory);
  return info.bavail * info.bsize;
}

// Compatible with the source/builder SHA.gz cache. These files are disposable
// copies; native evidence and caller transactions never pass through this writer.
export function openArchiveReadCache(directory, freeBytes = diskFreeBytes) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.resolve(directory) !== directory) {
    throw Error('An absolute normalized report cache directory is required');
  }
  let pendingWrite = Promise.resolve();

  async function privateDirectory() {
    const info = await fs.lstat(directory);
    return info.isDirectory() && privateOwner(info) && await fs.realpath(directory) === directory;
  }

  async function read(key) {
    if (!cacheKey.test(key)) return null;
    try {
      if (!await privateDirectory()) return null;
      const file = await fs.open(path.join(directory, key), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await file.stat();
        if (!info.isFile() || !privateOwner(info) || info.size < 1 || info.size > maxObjectBytes) return null;
        const data = Buffer.alloc(info.size);
        let offset = 0;
        while (offset < data.length) {
          const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
          if (!bytesRead) return null;
          offset += bytesRead;
        }
        if (digest(data) + '.gz' !== key) return null;
        const now = new Date();
        await file.utimes(now, now).catch(() => {});
        return data;
      } finally { await file.close(); }
    } catch { return null; }
  }

  async function writeLock() {
    const file = path.join(directory, '.archive-cache-write');
    // Refuse to open somebody else's file or follow a pre-existing symlink.
    for (const suffix of ['', '.sqlite', '.sqlite-journal', '.sqlite-wal', '.sqlite-shm']) {
      const info = await fs.lstat(file + suffix).catch(missing);
      if (info && (!info.isFile() || !privateOwner(info))) return null;
    }
    try {
      const sqlite = await fs.open(file + '.sqlite', 'wx', 0o600);
      await sqlite.close();
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    // The OS lock is released on process death. Contention skips this cache
    // write; it never waits for the source/builder heavy-work admission lock.
    return acquireWorkerLock(file).catch(() => null);
  }

  async function scan() {
    const entries = new Map();
    let totalBytes = 0;
    for (const name of await fs.readdir(directory)) {
      const filename = path.join(directory, name);
      const info = await fs.lstat(filename).catch(missing);
      if (!info) continue;
      // Unknown files count against the byte bound but are never removed.
      // An unknown directory prevents a bounded write without traversing it.
      if (info.isDirectory()) return null;
      if (abandonedTemp.test(name) && info.isFile() && privateOwner(info)) {
        await fs.unlink(filename);
        continue;
      }
      totalBytes += allocated(info);
      if (cacheKey.test(name)) {
        entries.set(name, { bytes: allocated(info), modified: info.mtimeMs,
          owned: info.isFile() && privateOwner(info) });
      }
    }
    return { entries, totalBytes };
  }

  async function store(key, data) {
    if (!await privateDirectory()) return;
    const neededBytes = Math.ceil(data.length / 4096) * 4096;
    if (await freeBytes(directory) < buildReserve + neededBytes) return;
    const target = path.join(directory, key);
    const original = await fs.lstat(target).catch(missing);
    if (original && (!original.isFile() || !privateOwner(original))) return;
    const lock = await writeLock();
    if (!lock) return;
    try {
      if (!await privateDirectory()) return;
      const inventory = await scan();
      if (!inventory) return;
      const { entries } = inventory;
      let { totalBytes } = inventory;
      // Recheck under the shared lock; another process may have added files.
      if (await freeBytes(directory) < buildReserve + neededBytes) return;
      const prior = await fs.lstat(target).catch(missing);
      if (prior && (!prior.isFile() || !privateOwner(prior))) return;
      if (prior) {
        await fs.unlink(target);
        totalBytes -= entries.get(key)?.bytes ?? allocated(prior);
        entries.delete(key);
      }
      const ordered = [...entries].sort(([, a], [, b]) => a.modified - b.modified);
      for (const [name, entry] of ordered) {
        if (totalBytes + neededBytes <= maxCacheBytes && entries.size < maxCacheFiles) break;
        if (!entry.owned) continue;
        await fs.unlink(path.join(directory, name));
        entries.delete(name);
        totalBytes -= entry.bytes;
      }
      if (totalBytes + neededBytes > maxCacheBytes || entries.size >= maxCacheFiles) return;
      const temp = path.join(directory, '.source-archive-' + randomUUID() + '.tmp');
      try {
        await fs.writeFile(temp, data, { flag: 'wx', mode: 0o600 });
        const info = await fs.lstat(temp);
        if (totalBytes + allocated(info) > maxCacheBytes) return;
        await fs.rename(temp, target);
      } finally { await fs.rm(temp, { force: true }); }
    } finally { await lock.release(); }
  }

  return {
    read,
    remember(key, data) {
      if (!cacheKey.test(key) || !Buffer.isBuffer(data) || data.length < 1
          || data.length > maxObjectBytes || digest(data) + '.gz' !== key) return Promise.resolve();
      const copy = Buffer.from(data);
      const write = pendingWrite.then(() => store(key, copy));
      pendingWrite = write.catch(() => {});
      return pendingWrite;
    },
  };
}

function readAllowance(maximum) {
  let active = 0;
  const waiting = [];
  async function acquire(signal) {
    signal?.throwIfAborted();
    if (active < maximum) { active++; return; }
    await new Promise((resolve, reject) => {
      const entry = { resolve: () => { signal?.removeEventListener('abort', aborted); resolve(); } };
      const aborted = () => {
        const position = waiting.indexOf(entry);
        if (position >= 0) waiting.splice(position, 1);
        reject(signal.reason);
      };
      signal?.addEventListener('abort', aborted, { once: true });
      waiting.push(entry);
    });
  }
  return async (operation, signal) => {
    await acquire(signal);
    try { signal?.throwIfAborted(); return await operation(); }
    finally {
      const next = waiting.shift();
      if (next) next.resolve();
      else active--;
    }
  };
}

// Only committed immutable object reads are cached. In particular putBytes,
// readBytes, capacity writes, and session-bearing reads retain native semantics.
export function createDriverAuditReadCache({ archive, cacheDirectory, cacheFreeBytes,
  maxConcurrentReads = 4, cacheEnabled = true } = {}) {
  if (typeof archive?.readObject !== 'function' || !Number.isSafeInteger(maxConcurrentReads)
      || maxConcurrentReads < 1 || maxConcurrentReads > 16) throw Error('A bounded native archive reader is required');
  const cache = cacheEnabled && cacheDirectory ? openArchiveReadCache(cacheDirectory, cacheFreeBytes) : null;
  const allowed = readAllowance(maxConcurrentReads);
  const pending = new Map();

  async function load(key, options, maxBytes) {
    const { signal } = options;
    return allowed(async () => {
      const cacheable = cache && cacheKey.test(key) && !options.session;
      const cached = cacheable ? await cache.read(key) : null;
      signal?.throwIfAborted();
      if (cached) {
        if (cached.length > maxBytes) throw Error('Native archive object exceeds its size limit');
        return cached;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of await archive.readObject(key, options)) {
        signal?.throwIfAborted();
        if (!(chunk instanceof Uint8Array)) throw Error('Native archive object integrity failure');
        size += chunk.length;
        if (size > maxBytes) throw Error('Native archive object exceeds its size limit');
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks, size);
      if (digest(bytes) !== key.slice(0, 64)) throw Error('Native archive object integrity failure');
      signal?.throwIfAborted();
      if (cacheable) await cache.remember(key, bytes);
      signal?.throwIfAborted();
      return bytes;
    }, signal);
  }

  return {
    ...archive,
    managedReadCache: true,
    async readObject(key, options = {}) {
      if (!objectKey.test(key)) throw Error('Invalid native archive object key');
      const maxBytes = options.maxBytes === undefined ? maxObjectBytes : options.maxBytes;
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > maxNativeBytes) {
        throw Error('Native archive object exceeds its size limit');
      }
      options.signal?.throwIfAborted();
      // Independent cancellation and transactions must not join another call.
      const shareable = !options.signal && !options.session
        && Object.keys(options).every(name => name === 'maxBytes');
      if (!shareable) return [Buffer.from(await load(key, options, maxBytes))];
      const request = key + ':' + maxBytes;
      let promise = pending.get(request);
      if (!promise) {
        promise = load(key, options, maxBytes);
        pending.set(request, promise);
      }
      try { return [Buffer.from(await promise)]; }
      finally { if (pending.get(request) === promise) pending.delete(request); }
    },
  };
}
