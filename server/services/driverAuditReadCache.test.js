import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createDriverAuditReadCache, openArchiveReadCache } from './driverAuditReadCache.js';
import { acquireWorkerLock } from '../vendor/driver-audits/integration/hosted/worker-lock.mjs';

const execute = promisify(execFile);
const fixture = gzipSync(Buffer.from('Fictional native archive fixture.'));
const keyOf = bytes => createHash('sha256').update(bytes).digest('hex') + '.gz';
const key = keyOf(fixture);
const enoughSpace = async () => 2 * 1024 ** 3;
const read = async (archive, request = key, options) => Buffer.concat(await archive.readObject(request, options));

async function directory(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'audit-read-cache-')));
  const cacheDirectory = path.join(root, 'archive-cache');
  await fs.mkdir(cacheDirectory, { mode: 0o700 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, cacheDirectory, cacheFreeBytes: enoughSpace };
}

test('immutable reads reuse private disk bytes without sharing mutable buffers', async t => {
  const options = await directory(t);
  let reads = 0;
  const archive = createDriverAuditReadCache({ ...options, archive: {
    async readObject() { reads++; return [Buffer.from(fixture)]; },
  } });
  const first = await read(archive);
  first.fill(0);
  assert.deepEqual(await read(archive), fixture);
  assert.equal(reads, 1);
  assert.deepEqual(await fs.readFile(path.join(options.cacheDirectory, key)), fixture);
  assert.equal((await fs.stat(path.join(options.cacheDirectory, key))).mode & 0o777, 0o600);
});

test('a new process reuses the compatible SHA.gz file without native reads', async t => {
  const options = await directory(t);
  const archive = createDriverAuditReadCache({ ...options,
    archive: { async readObject() { return [fixture]; } },
  });
  await read(archive);
  const program = `import {createDriverAuditReadCache} from ${JSON.stringify(new URL('./driverAuditReadCache.js', import.meta.url).href)};
    const archive=createDriverAuditReadCache({cacheDirectory:process.argv[1],archive:{readObject(){throw Error('Unexpected native read');}}});
    process.stdout.write(Buffer.concat(await archive.readObject(process.argv[2])).toString('base64'));`;
  const result = await execute(process.execPath, ['--input-type=module', '-e', program, options.cacheDirectory, key]);
  assert.deepEqual(Buffer.from(result.stdout, 'base64'), fixture);
});

test('existing source-format cache files are readable without native calls', async t => {
  const options = await directory(t);
  await fs.writeFile(path.join(options.cacheDirectory, key), fixture, { mode: 0o600 });
  const archive = createDriverAuditReadCache({ ...options,
    archive: { readObject() { throw Error('Unexpected native read'); } },
  });
  assert.deepEqual(await read(archive), fixture);
});

test('corrupt cache bytes recover from native originals and preserve evidence outside the cache', async t => {
  const options = await directory(t);
  const original = path.join(options.root, 'original-evidence.bin');
  await fs.writeFile(original, fixture);
  await fs.writeFile(path.join(options.cacheDirectory, key), 'corrupt', { mode: 0o600 });
  let reads = 0;
  const archive = createDriverAuditReadCache({ ...options,
    archive: { async readObject() { reads++; return [fixture]; } },
  });
  assert.deepEqual(await read(archive), fixture);
  assert.deepEqual(await read(archive), fixture);
  assert.equal(reads, 1);
  assert.deepEqual(await fs.readFile(original), fixture);
});

test('corruption and a missing native original retain the native error without another source', async t => {
  const options = await directory(t);
  await fs.writeFile(path.join(options.cacheDirectory, key), 'corrupt', { mode: 0o600 });
  const missing = Object.assign(Error('Native object unavailable'), { code: 'storage_not_found' });
  const archive = createDriverAuditReadCache({ ...options,
    archive: { async readObject() { throw missing; } },
  });
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = () => { fetches++; throw Error('No remote source permitted'); };
  try { await assert.rejects(read(archive), error => error === missing); }
  finally { globalThis.fetch = originalFetch; }
  assert.equal(fetches, 0);
  assert.equal(await fs.readFile(path.join(options.cacheDirectory, key), 'utf8'), 'corrupt');
});

test('an incorrect native hash never becomes cached evidence', async t => {
  const options = await directory(t);
  const archive = createDriverAuditReadCache({ ...options,
    archive: { async readObject() { return [Buffer.from('incorrect')]; } },
  });
  await assert.rejects(read(archive), /integrity|hash/i);
  await assert.rejects(fs.stat(path.join(options.cacheDirectory, key)), { code: 'ENOENT' });
});

test('streamed and cached reads enforce each caller byte bound', async t => {
  const options = await directory(t);
  let reads = 0;
  const archive = createDriverAuditReadCache({ ...options, archive: {
    async readObject() {
      reads++;
      return (async function* () { yield fixture.subarray(0, 10); yield fixture.subarray(10); })();
    },
  } });
  await assert.rejects(read(archive, key, { maxBytes: fixture.length - 1 }), /limit|bound/i);
  assert.deepEqual(await read(archive), fixture);
  const readsAfterFill = reads;
  await assert.rejects(read(archive, key, { maxBytes: fixture.length - 1 }), /limit|bound/i);
  assert.equal(reads, readsAfterFill);
  assert.deepEqual(await read(archive, key, { maxBytes: fixture.length }), fixture);
  for (const maxBytes of [-1, NaN, 1.5, 64 * 1024 ** 2 + 1]) {
    await assert.rejects(read(archive, key, { maxBytes }), /limit|bound/i);
  }
});

test('concurrent identical cold reads share one bounded native read', async t => {
  const options = await directory(t);
  let reads = 0;
  const archive = createDriverAuditReadCache({ ...options, archive: {
    async readObject() { reads++; await delay(15); return [Buffer.from(fixture)]; },
  } });
  const results = await Promise.all(Array.from({ length: 8 }, () => read(archive)));
  assert.equal(reads, 1);
  results[0].fill(0);
  for (const result of results.slice(1)) assert.deepEqual(result, fixture);
});

test('native misses share a bounded concurrency allowance', async t => {
  const options = await directory(t);
  let active = 0;
  let peak = 0;
  const payloads = Array.from({ length: 6 }, (_, i) => gzipSync(Buffer.from('Fictional row ' + i)));
  const archive = createDriverAuditReadCache({ ...options, maxConcurrentReads: 2, archive: {
    async readObject(request) {
      active++; peak = Math.max(peak, active);
      try { await delay(15); return [payloads.find(bytes => keyOf(bytes) === request)]; }
      finally { active--; }
    },
  } });
  const results = await Promise.all(payloads.map(bytes => read(archive, keyOf(bytes))));
  assert.equal(peak, 2);
  results.forEach((bytes, i) => assert.deepEqual(bytes, payloads[i]));
});

test('aborting one reader does not cancel another reader or allow a pre-aborted cache hit', async t => {
  const options = await directory(t);
  const controller = new AbortController();
  const cancelled = Error('Fictional read cancelled');
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const archive = createDriverAuditReadCache({ ...options, archive: {
    async readObject(request, { signal } = {}) {
      if (signal) {
        started();
        await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      return [fixture];
    },
  } });
  const first = read(archive, key, { signal: controller.signal });
  await ready;
  const second = read(archive);
  controller.abort(cancelled);
  await assert.rejects(first, error => error === cancelled);
  assert.deepEqual(await second, fixture);
  await assert.rejects(read(archive, key, { signal: controller.signal }), error => error === cancelled);
});

test('a canceled queued reader never starts a native read', async t => {
  const options = await directory(t);
  let unblock;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { unblock = resolve; });
  let reads = 0;
  const archive = createDriverAuditReadCache({ ...options, maxConcurrentReads: 1, archive: {
    async readObject() { reads++; started(); await pending; return [fixture]; },
  } });
  const first = read(archive);
  await ready;
  const controller = new AbortController();
  const cancelled = Error('Queued read cancelled');
  const queued = read(archive, key, { signal: controller.signal });
  controller.abort(cancelled);
  await assert.rejects(queued, error => error === cancelled);
  unblock();
  await first;
  assert.equal(reads, 1);
});

test('session reads stay out of the shared cache and original write methods retain their arguments', async t => {
  const options = await directory(t);
  const session = { fictional: true };
  const missing = Error('No committed object');
  const calls = [];
  const native = {
    async readObject(request, opts) { if (opts?.session === session) return [fixture]; throw missing; },
    putBytes(...args) { calls.push(args); },
    readBytes(...args) { calls.push(args); },
    putVerifiedObject(...args) { calls.push(args); },
    status() { return { fictional: true }; },
  };
  const archive = createDriverAuditReadCache({ ...options, archive: native });
  assert.deepEqual(await read(archive, key, { session }), fixture);
  await assert.rejects(read(archive), error => error === missing);
  for (const method of ['putBytes', 'readBytes', 'putVerifiedObject', 'status']) assert.equal(archive[method], native[method]);
  archive.putBytes(fixture, { session });
  archive.readBytes({ fictional: true }, { session });
  archive.putVerifiedObject(key, fixture);
  assert.equal(calls[0][1].session, session);
  assert.equal(calls[1][1].session, session);
  assert.equal(calls[2][1], fixture);
  await assert.rejects(fs.stat(path.join(options.cacheDirectory, key)), { code: 'ENOENT' });
});

test('disabled caching and JSON objects continue to use only the native archive', async t => {
  const options = await directory(t);
  let reads = 0;
  const native = { async readObject() { reads++; return [fixture]; } };
  const noDirectory = createDriverAuditReadCache({ archive: native });
  const disabled = createDriverAuditReadCache({ ...options, cacheEnabled: false, archive: native });
  const enabled = createDriverAuditReadCache({ ...options, archive: native });
  for (const archive of [noDirectory, disabled]) { await read(archive); await read(archive); }
  await read(enabled, key.replace('.gz', '.json'));
  await read(enabled, key.replace('.gz', '.json'));
  assert.equal(reads, 6);
  assert.deepEqual(await fs.readdir(options.cacheDirectory), []);
});

test('the build reserve prevents cache writes without preventing native reads', async t => {
  const options = await directory(t);
  let reads = 0;
  const archive = createDriverAuditReadCache({ ...options, cacheFreeBytes: async () => 1024 ** 3,
    archive: { async readObject() { reads++; return [fixture]; } },
  });
  assert.deepEqual(await read(archive), fixture);
  assert.deepEqual(await read(archive), fixture);
  assert.equal(reads, 2);
  assert.deepEqual(await fs.readdir(options.cacheDirectory), []);
});

test('every cache write rescans other writers and evicts only owned derived cache files', async t => {
  const options = await directory(t);
  const cache = openArchiveReadCache(options.cacheDirectory, enoughSpace);
  await cache.remember(key, fixture);
  const unmanaged = path.join(options.cacheDirectory, 'unmanaged-evidence.txt');
  await fs.writeFile(unmanaged, 'preserve', { mode: 0o600 });
  const otherKey = 'f'.repeat(64) + '.gz';
  const largeFile = await fs.open(path.join(options.cacheDirectory, otherKey), 'wx', 0o600);
  try { await largeFile.truncate(512 * 1024 ** 2); await largeFile.utimes(0, 0); }
  finally { await largeFile.close(); }
  const second = gzipSync(Buffer.from('Fictional second cache object.'));
  await cache.remember(keyOf(second), second);
  assert.deepEqual(await cache.read(keyOf(second)), second);
  await assert.rejects(fs.stat(path.join(options.cacheDirectory, otherKey)), { code: 'ENOENT' });
  assert.equal(await fs.readFile(unmanaged, 'utf8'), 'preserve');
});

test('cache lock contention skips persistence without holding up staff reads', async t => {
  const options = await directory(t);
  const lock = await acquireWorkerLock(path.join(options.cacheDirectory, '.archive-cache-write'));
  try {
    const archive = createDriverAuditReadCache({ ...options,
      archive: { async readObject() { return [fixture]; } },
    });
    const result = await Promise.race([read(archive), delay(1000).then(() => { throw Error('Cache write waited for another worker'); })]);
    assert.deepEqual(result, fixture);
    await assert.rejects(fs.stat(path.join(options.cacheDirectory, key)), { code: 'ENOENT' });
  } finally { await lock.release(); }
});

test('unsafe cache paths and foreign symlinks do not alter native evidence', async t => {
  const options = await directory(t);
  const original = path.join(options.root, 'original.bin');
  await fs.writeFile(original, 'preserve');
  const cachedFile = path.join(options.cacheDirectory, key);
  await fs.symlink(original, cachedFile);
  const archive = createDriverAuditReadCache({ ...options,
    archive: { async readObject() { return [fixture]; } },
  });
  assert.deepEqual(await read(archive), fixture);
  assert.equal(await fs.readFile(original, 'utf8'), 'preserve');
  assert.ok((await fs.lstat(cachedFile)).isSymbolicLink());
  await fs.unlink(cachedFile);
  await fs.chmod(options.cacheDirectory, 0o755);
  assert.deepEqual(await read(archive), fixture);
  await assert.rejects(fs.stat(cachedFile), { code: 'ENOENT' });
});

test('generic remember rejects hash mismatches before writing or evicting', async t => {
  const options = await directory(t);
  const cache = openArchiveReadCache(options.cacheDirectory, enoughSpace);
  await cache.remember(key, Buffer.from('wrong'));
  assert.deepEqual(await fs.readdir(options.cacheDirectory), []);
});

test('native objects above the 16 MiB cache cap retain the native read allowance without persistence', async t => {
  const options = await directory(t);
  const bytes = Buffer.alloc(16 * 1024 ** 2 + 1, 7);
  const request = keyOf(bytes);
  let reads = 0;
  const archive = createDriverAuditReadCache({ ...options,
    archive: { async readObject() { reads++; return [bytes]; } },
  });
  assert.deepEqual(await read(archive, request, { maxBytes: bytes.length }), bytes);
  assert.deepEqual(await read(archive, request, { maxBytes: 64 * 1024 ** 2 }), bytes);
  assert.equal(reads, 2);
  await assert.rejects(read(archive, request), /limit|bound/i);
  await assert.rejects(fs.stat(path.join(options.cacheDirectory, request)), { code: 'ENOENT' });
});

test('unmanaged bytes and nested directories block cache growth without deleting their contents', async t => {
  const options = await directory(t);
  const unmanaged = path.join(options.cacheDirectory, 'preserved-evidence.bin');
  const file = await fs.open(unmanaged, 'wx', 0o600);
  try { await file.truncate(512 * 1024 ** 2); }
  finally { await file.close(); }
  const cache = openArchiveReadCache(options.cacheDirectory, enoughSpace);
  await cache.remember(key, fixture);
  assert.equal((await fs.stat(unmanaged)).size, 512 * 1024 ** 2);
  await assert.rejects(fs.stat(path.join(options.cacheDirectory, key)), { code: 'ENOENT' });
  await fs.unlink(unmanaged);
  const nested = path.join(options.cacheDirectory, 'unknown-directory');
  await fs.mkdir(nested, { mode: 0o700 });
  await fs.writeFile(path.join(nested, 'original.txt'), 'preserve');
  await cache.remember(key, fixture);
  assert.equal(await fs.readFile(path.join(nested, 'original.txt'), 'utf8'), 'preserve');
  await assert.rejects(fs.stat(path.join(options.cacheDirectory, key)), { code: 'ENOENT' });
});

test('cache directories must be absolute and normalized and read concurrency stays explicitly bounded', () => {
  const archive = { readObject() { throw Error('Should not read'); } };
  for (const cacheDirectory of ['relative-cache', '/tmp/parent/../cache']) {
    assert.throws(() => createDriverAuditReadCache({ archive, cacheDirectory }), /absolute normalized/i);
  }
  for (const maxConcurrentReads of [0, -1, 17, 1.5, NaN]) {
    assert.throws(() => createDriverAuditReadCache({ archive, maxConcurrentReads }), /bounded/i);
  }
  assert.equal(createDriverAuditReadCache({ archive }).managedReadCache, true);
});
