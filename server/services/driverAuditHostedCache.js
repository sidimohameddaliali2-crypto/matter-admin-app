import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { encryptTransfer, decryptTransfer, transferPlan } from './driverAuditTransferCodec.js';

const kind = 'driver-report-hosted-immutable-cache-v1';
const maximumBytes = 512 * 1024 ** 2, maximumFiles = 8192, maximumObject = 16 * 1024 ** 2;
const reserveBytes = 1024 ** 3, maximumInventory = 2 * 1024 ** 2, bindingName = 'hosted-cache-binding.private.json';
const objectName = /^[a-f0-9]{64}\.(?:gz|json)$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const need = value => { if (!value) throw Error('Hosted immutable cache validation stopped'); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const identity = info => [info.dev, info.ino, info.uid, info.gid, info.mode].map(String).join(':');
const signature = info => [identity(info), info.nlink, info.size, info.mtimeNs, info.ctimeNs].map(String).join(':');
const privateFile = info => info.isFile() && info.uid === BigInt(process.getuid()) && info.nlink === 1n
  && [0o400, 0o600].includes(Number(info.mode) & 0o7777);
const allocation = info => Math.max(Number(info.size), Number(info.blocks) * 512);
const missing = error => { if (error.code !== 'ENOENT') throw error; return null; };
const freeDisk = async directory => { const info = await fs.statfs(directory); return info.bavail * info.bsize; };

function scopeFor(releaseSha, namespace) {
  need(typeof releaseSha === 'string' && /^[a-f0-9]{40}$/.test(releaseSha)
    && typeof namespace === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(namespace));
  return hash(JSON.stringify([kind, releaseSha, namespace]));
}

async function directory(name) {
  need(typeof name === 'string' && path.isAbsolute(name) && path.resolve(name) === name);
  const info = await fs.lstat(name, { bigint: true });
  need(info.isDirectory() && info.uid === BigInt(process.getuid()) && (Number(info.mode) & 0o7777) === 0o700
    && await fs.realpath(name) === name);
  return info;
}

async function cacheRoot(name) {
  const parentName = path.dirname(name), parentInfo = await directory(parentName), info = await directory(name);
  const parent = await fs.open(parentName, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let handle;
  try {
    handle = await fs.open(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const base = process.platform === 'linux' ? '/proc/self/fd/' + handle.fd : name;
    const parentBase = process.platform === 'linux' ? '/proc/self/fd/' + parent.fd : parentName;
    const recheck = async () => need(identity(await handle.stat({ bigint: true })) === identity(info)
      && identity(await directory(name)) === identity(info)
      && identity(await parent.stat({ bigint: true })) === identity(parentInfo)
      && identity(await directory(parentName)) === identity(parentInfo));
    await recheck();
    return { name, base, parentBase, recheck, async sync() { await handle.sync(); await parent.sync(); },
      async close() { await handle.close(); await parent.close(); } };
  } catch (error) { await handle?.close(); await parent.close(); throw error; }
}

async function readFile(file, maximum, optional = false) {
  const before = await fs.lstat(file, { bigint: true }).catch(missing);
  if (!before) { need(optional); return null; }
  need(privateFile(before) && before.size > 0n && before.size <= BigInt(maximum));
  const opened = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    need(signature(await opened.stat({ bigint: true })) === signature(before));
    const bytes = Buffer.alloc(Number(before.size));
    for (let at = 0; at < bytes.length;) {
      const { bytesRead } = await opened.read(bytes, at, bytes.length - at, at);
      need(bytesRead > 0); at += bytesRead;
    }
    need((await opened.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead === 0
      && signature(await opened.stat({ bigint: true })) === signature(before)
      && signature(await fs.lstat(file, { bigint: true })) === signature(before));
    return { bytes, signature: signature(before), sha256: hash(bytes) };
  } finally { await opened.close(); }
}

async function inventory(root) {
  await root.recheck();
  const names = await fs.readdir(root.base); need(names.length <= maximumFiles + 128);
  const objects = []; let physicalBytes = 0, objectBytes = 0;
  for (const name of names.sort()) {
    const info = await fs.lstat(path.join(root.base, name), { bigint: true });
    need(privateFile(info));
    physicalBytes += allocation(info); need(physicalBytes <= maximumBytes);
    if (!objectName.test(name)) continue; // Never export mutable pointers, locks, credentials or temporary files.
    need(info.size > 0n && info.size <= BigInt(maximumObject) && objects.length < maximumFiles);
    objectBytes += Number(info.size); need(objectBytes <= maximumBytes);
    objects.push({ key: name, bytes: Number(info.size), signature: signature(info) });
  }
  await root.recheck();
  return { objects, objectBytes, physicalBytes };
}

async function lock(root) {
  const name = '.archive-cache-write', file = path.join(root.base, name + '.sqlite');
  await root.recheck();
  for (const suffix of ['', '.sqlite', '.sqlite-journal', '.sqlite-wal', '.sqlite-shm']) {
    const info = await fs.lstat(path.join(root.base, name + suffix), { bigint: true }).catch(missing);
    need(!info || privateFile(info) && info.size <= 1024n * 1024n);
  }
  try { const opened = await fs.open(file, 'wx', 0o600); await opened.close(); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const before = await fs.lstat(file, { bigint: true }); need(privateFile(before));
  let db, held = false;
  try {
    db = new DatabaseSync(file); db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;'); held = true;
    const after = await fs.lstat(file, { bigint: true });
    need(privateFile(after) && identity(after) === identity(before)); await root.recheck();
    return { async release() { try { db.exec('ROLLBACK'); } finally { db.close(); } } };
  } catch (error) { try { if (held) db.exec('ROLLBACK'); } finally { db?.close(); } throw error; }
}

async function withCache(options, operation) {
  const { cacheDirectory, releaseSha, namespace, key, signal } = options;
  const scopeSha256 = scopeFor(releaseSha, namespace);
  need(Buffer.isBuffer(key) && key.length === 32); signal?.throwIfAborted();
  const privateKey = Buffer.from(key); let root, exclusion, value, failure;
  try {
    root = await cacheRoot(cacheDirectory); exclusion = await lock(root);
    value = await operation({ root, key: privateKey, scopeSha256 });
  } catch (error) { failure = error; }
  finally {
    try { await exclusion?.release(); } catch (error) { failure ??= error; }
    try { await root?.recheck(); } catch (error) { failure ??= error; }
    try { await root?.close(); } catch (error) { failure ??= error; }
    privateKey.fill(0);
    if (signal?.aborted) failure ??= signal.reason;
  }
  if (failure) throw failure;
  return value;
}

// write receives bytes for a public encrypted artifact, never an encryption key,
// local path, mutable pointer or credential. The caller owns durable transport.
export async function sealDriverAuditHostedCache(options) {
  need(typeof options?.write === 'function');
  return withCache(options, async ({ root, key, scopeSha256 }) => {
    const { objects, objectBytes } = await inventory(root), sessionId = randomUUID(), baseNonce = randomBytes(8);
    const rows = objects.map(({ key, bytes }) => ({ key, bytes }));
    const binding = Buffer.from(JSON.stringify({ version: 1, kind, releaseSha: options.releaseSha, namespace: options.namespace,
      scopeSha256, sessionId, objectCount: rows.length, objectBytes, objectsSha256: hash(JSON.stringify(rows)) }));
    need(binding.length <= 4096);
    const bindingKey = hash(binding) + '.json'; need(!rows.some(row => row.key === bindingKey));
    const raw = Buffer.from([{ key: bindingKey, bytes: binding.length, kind: 'input', name: bindingName }, ...rows]
      .map(row => JSON.stringify(row)).join('\n') + '\n');
    need(raw.length <= maximumInventory);
    const plan = transferPlan(raw), context = { sessionId, targetDatabase: 'hosted-cache-' + scopeSha256, inventorySha256: plan.inventorySha256 };
    const header = Buffer.from(JSON.stringify({ version: 1, kind, scopeSha256, sessionId, baseNonce: baseNonce.toString('base64'), plan }));
    need(header.length <= 4096);
    const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
    const digest = createHash('sha256'); let emitted = 0;
    const write = async bytes => { options.signal?.throwIfAborted(); digest.update(bytes); emitted += bytes.length;
      await options.write(bytes); options.signal?.throwIfAborted(); };
    await write(length); await write(header);
    const byKey = new Map(objects.map(row => [row.key, row]));
    for await (const frame of encryptTransfer({ inventory: raw, key, baseNonce, context, async readObject(row) {
      if (row.kind === 'input') { need(row.key === bindingKey); return binding; }
      await root.recheck();
      const saved = await readFile(path.join(root.base, row.key), maximumObject);
      need(saved.signature === byKey.get(row.key)?.signature && saved.sha256 + path.extname(row.key) === row.key);
      return saved.bytes;
    } })) await write(frame);
    const after = await inventory(root); need(JSON.stringify(after.objects) === JSON.stringify(objects));
    return { version: 1, kind, scopeSha256, sessionId, objectCount: rows.length, objectBytes,
      bundleBytes: emitted, bundleSha256: digest.digest('hex') };
  });
}

async function headerAndStream(stream, signal) {
  need(stream && typeof stream[Symbol.asyncIterator] === 'function');
  const iterator = stream[Symbol.asyncIterator](); let buffer = Buffer.alloc(0), read = 0;
  const exactBytes = async size => {
    while (buffer.length < size) {
      signal?.throwIfAborted(); const next = await iterator.next(); need(!next.done && next.value instanceof Uint8Array);
      need(next.value.length <= 64 * 1024 ** 2 + 32 && (read += next.value.length) <= maximumBytes + maximumInventory + 65536);
      buffer = Buffer.concat([buffer, next.value]);
    }
    const value = buffer.subarray(0, size); buffer = buffer.subarray(size); return value;
  };
  try {
    const length = (await exactBytes(4)).readUInt32BE(); need(length > 0 && length <= 4096);
    const bytes = await exactBytes(length); let header;
    try { header = JSON.parse(bytes.toString('utf8')); } catch { throw Error('Invalid hosted cache header'); }
    need(Buffer.from(JSON.stringify(header)).equals(bytes));
    return { header, stream: (async function* () {
      if (buffer.length) yield buffer;
      for (;;) { signal?.throwIfAborted(); const next = await iterator.next(); if (next.done) return;
        need(next.value instanceof Uint8Array && next.value.length <= 64 * 1024 ** 2 + 32
          && (read += next.value.length) <= maximumBytes + maximumInventory + 65536); yield next.value; }
    })(), async close() { await iterator.return?.(); } };
  } catch (error) {
    try { await iterator.return?.(); } catch { /* Preserve the original invalid transport cause. */ }
    throw error;
  }
}

// All frames and the authenticated scope binding must complete before any new
// file is linked into the cache. Existing files are hash-checked and never replaced.
export async function restoreDriverAuditHostedCache(options) {
  return withCache(options, async ({ root, key, scopeSha256 }) => {
    let transport, staging, stageInfo, stageHandle, failure, value;
    const staged = [], received = [];
    try {
      transport = await headerAndStream(options.stream, options.signal);
      const { header } = transport;
      need(exact(header, ['version', 'kind', 'scopeSha256', 'sessionId', 'baseNonce', 'plan']) && header.version === 1
        && header.kind === kind && header.scopeSha256 === scopeSha256
        && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(header.sessionId)
        && typeof header.baseNonce === 'string' && Buffer.from(header.baseNonce, 'base64').length === 8
        && Buffer.from(header.baseNonce, 'base64').toString('base64') === header.baseNonce);
      const { plan } = header;
      need(exact(plan, ['version', 'inventorySha256', 'inventoryBytes', 'objectCount', 'objectBytes', 'cipherBytes']) && plan.version === 1
        && hex(plan.inventorySha256) && Number.isSafeInteger(plan.inventoryBytes) && plan.inventoryBytes > 0 && plan.inventoryBytes <= maximumInventory
        && Number.isSafeInteger(plan.objectCount) && plan.objectCount >= 1 && plan.objectCount <= maximumFiles + 1
        && Number.isSafeInteger(plan.objectBytes) && plan.objectBytes > 0 && plan.objectBytes <= maximumBytes + 4096
        && Number.isSafeInteger(plan.cipherBytes) && plan.cipherBytes > 0 && plan.cipherBytes <= maximumBytes + maximumInventory + 65536);
      const original = await inventory(root), existing = new Map(original.objects.map(row => [row.key, row]));
      staging = path.join(root.parentBase, '.hosted-cache-restore-' + randomUUID() + '.tmp');
      await root.recheck(); await fs.mkdir(staging, { mode: 0o700 });
      stageInfo = await fs.lstat(staging, { bigint: true });
      need(stageInfo.isDirectory() && stageInfo.uid === BigInt(process.getuid()) && (Number(stageInfo.mode) & 0o7777) === 0o700);
      stageHandle = await fs.open(staging, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const stageBase = process.platform === 'linux' ? '/proc/self/fd/' + stageHandle.fd : staging;
      const checkStage = async () => { await root.recheck(); need(identity(await stageHandle.stat({ bigint: true })) === identity(stageInfo)
        && identity(await fs.lstat(staging, { bigint: true })) === identity(stageInfo)); };
      let binding, newPhysical = 0, total = 0, reused = 0;
      const space = async needed => {
        const free = await (options.freeBytes ?? freeDisk)(root.name);
        need(Number.isSafeInteger(free) && free >= reserveBytes + needed);
      };
      const context = { sessionId: header.sessionId, targetDatabase: 'hosted-cache-' + scopeSha256, inventorySha256: plan.inventorySha256 };
      await decryptTransfer({ stream: transport.stream, key, baseNonce: Buffer.from(header.baseNonce, 'base64'), context, plan, signal: options.signal,
        async receive(row, bytes) {
          await checkStage();
          if (!binding) {
            need(row.kind === 'input' && row.name === bindingName && bytes.length <= 4096);
            binding = JSON.parse(bytes.toString('utf8'));
            need(exact(binding, ['version', 'kind', 'releaseSha', 'namespace', 'scopeSha256', 'sessionId', 'objectCount', 'objectBytes', 'objectsSha256'])
              && binding.version === 1 && binding.kind === kind && binding.releaseSha === options.releaseSha && binding.namespace === options.namespace
              && binding.scopeSha256 === scopeSha256 && binding.sessionId === header.sessionId
              && Number.isSafeInteger(binding.objectCount) && binding.objectCount >= 0 && binding.objectCount <= maximumFiles
              && Number.isSafeInteger(binding.objectBytes) && binding.objectBytes >= 0 && binding.objectBytes <= maximumBytes && hex(binding.objectsSha256));
            return;
          }
          need(row.kind === undefined && exact(row, ['key', 'bytes']) && objectName.test(row.key) && bytes.length <= maximumObject);
          received.push(row); total += bytes.length; need(received.length <= maximumFiles && total <= maximumBytes);
          const current = await readFile(path.join(root.base, row.key), maximumObject, true);
          if (current) { need(current.sha256 === row.key.slice(0, 64) && current.bytes.equals(bytes)); reused++; return; }
          need(!existing.has(row.key));
          const needed = Math.ceil(bytes.length / 4096) * 4096;
          need(original.physicalBytes + newPhysical + needed <= maximumBytes
            && original.objects.length + staged.length + 1 <= maximumFiles);
          await space(needed); await checkStage();
          const file = await fs.open(path.join(stageBase, row.key), 'wx', 0o600);
          try {
            await file.writeFile(bytes); await file.sync();
            const stat = await file.stat({ bigint: true }); need(privateFile(stat));
            newPhysical += allocation(stat); need(original.physicalBytes + newPhysical <= maximumBytes);
          }
          finally { await file.close(); }
          staged.push(row); await checkStage();
        } });
      need(binding && binding.objectCount === received.length && binding.objectBytes === total
        && binding.objectsSha256 === hash(JSON.stringify(received)));
      await checkStage();
      const fresh = await inventory(root);
      need(JSON.stringify(fresh.objects) === JSON.stringify(original.objects) && fresh.physicalBytes + newPhysical <= maximumBytes);
      await space(0);
      for (const row of staged) {
        options.signal?.throwIfAborted(); await checkStage();
        const source = path.join(stageBase, row.key), target = path.join(root.base, row.key);
        const saved = await readFile(source, maximumObject); need(saved.sha256 === row.key.slice(0, 64) && saved.bytes.length === row.bytes);
        await fs.link(source, target); await fs.unlink(source);
        const admitted = await readFile(target, maximumObject); need(admitted.sha256 === row.key.slice(0, 64) && admitted.bytes.length === row.bytes);
        options.signal?.throwIfAborted();
      }
      await checkStage();
      for (const row of received) {
        options.signal?.throwIfAborted();
        const final = await readFile(path.join(root.base, row.key), maximumObject);
        need(final.sha256 === row.key.slice(0, 64) && final.bytes.length === row.bytes);
      }
      const finalInventory = await inventory(root);
      need(finalInventory.physicalBytes <= maximumBytes && finalInventory.objects.length <= maximumFiles);
      await root.sync(); await root.recheck();
      value = { version: 1, kind, scopeSha256, sessionId: header.sessionId, authenticated: true,
        objectCount: received.length, objectBytes: total, restored: staged.length, reused };
    } catch (error) { failure = error; }
    finally {
      try {
        if (staging && stageInfo) {
          need(identity(await fs.lstat(staging, { bigint: true })) === identity(stageInfo));
          await fs.rm(staging, { recursive: true });
        }
      } catch (error) { failure ??= error; }
      try { await stageHandle?.close(); } catch (error) { failure ??= error; }
      try { await transport?.close(); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
    return value;
  });
}
