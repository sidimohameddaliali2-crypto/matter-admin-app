import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const implementation = await import('./driverAuditHostedCache.js').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const releaseSha = 'a'.repeat(40), namespace = 'driver-reports-worker-v1';
const plentiful = async () => 4 * 1024 ** 3;
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hosted-cache-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), target = path.join(root, 'target');
  for (const directory of [source, target]) await fs.mkdir(directory, { mode: 0o700 });
  const key = randomBytes(32), values = [gzipSync(Buffer.from('private immutable evidence')), Buffer.from('{"saved":"original"}')];
  const names = values.map((value, i) => sha(value) + (i ? '.json' : '.gz'));
  for (const [i, name] of names.entries()) await fs.writeFile(path.join(source, name), values[i], { mode: 0o600 });
  await fs.writeFile(path.join(source, '.collector-state-read-v1.json'), 'mutable-private-pointer', { mode: 0o600 });
  return { root, source, target, key, values, names,
    seal: async options => {
      const chunks = [];
      const result = await implementation.sealDriverAuditHostedCache({ cacheDirectory: source, releaseSha, namespace, key,
        write: async chunk => chunks.push(Buffer.from(chunk)), ...options });
      return { result, bytes: Buffer.concat(chunks) };
    },
    restore: (bytes, options) => implementation.restoreDriverAuditHostedCache({ cacheDirectory: target, releaseSha, namespace, key,
      stream: (async function* () { for (let at = 0; at < bytes.length; at += 101) yield bytes.subarray(at, at + 101); })(),
      freeBytes: plentiful, ...options }),
  };
}

test('authenticated hosted cache roundtrip preserves immutable gz/json and excludes mutable controls', async t => {
  assert.equal(typeof implementation.sealDriverAuditHostedCache, 'function');
  const f = await fixture(t), { result, bytes } = await f.seal();
  assert.equal(result.objectCount, 2); assert.equal(result.objectBytes, f.values.reduce((n, value) => n + value.length, 0));
  assert.equal(bytes.includes(f.key), false);
  for (const text of ['private immutable evidence', 'mutable-private-pointer', f.source, namespace]) assert.equal(bytes.includes(Buffer.from(text)), false);
  const restored = await f.restore(bytes);
  assert.equal(restored.restored, 2);
  for (const [i, name] of f.names.entries()) {
    assert.deepEqual(await fs.readFile(path.join(f.target, name)), f.values[i]);
    assert.equal((await fs.stat(path.join(f.target, name))).mode & 0o777, 0o600);
  }
  assert(!((await fs.readdir(f.target)).includes('.collector-state-read-v1.json')));
  const before = await fs.stat(path.join(f.target, f.names[0]));
  assert.equal((await f.restore(bytes)).reused, 2);
  const after = await fs.stat(path.join(f.target, f.names[0]));
  assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs);
});

test('every seal has fresh nonce/session and wrong release, namespace or key cannot admit a file', async t => {
  const f = await fixture(t), one = await f.seal(), two = await f.seal();
  assert.notDeepEqual(one.bytes, two.bytes); assert.notEqual(one.result.sessionId, two.result.sessionId);
  for (const options of [{ releaseSha: 'b'.repeat(40) }, { namespace: 'another-worker' }, { key: randomBytes(32) }]) {
    await assert.rejects(f.restore(one.bytes, options));
    assert((await fs.readdir(f.target)).every(name => name.startsWith('.archive-cache-write')));
  }
});

test('truncated, modified or trailing ciphertext never promotes even an earlier authenticated object', async t => {
  const f = await fixture(t), { bytes } = await f.seal();
  const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
  for (const bad of [bytes.subarray(0, bytes.length - 1), changed, Buffer.concat([bytes, Buffer.from('extra')])]) {
    await assert.rejects(f.restore(bad));
    for (const name of f.names) await assert.rejects(fs.stat(path.join(f.target, name)), { code: 'ENOENT' });
  }
  assert((await fs.readdir(f.root)).every(name => ['source', 'target'].includes(name)));
});

test('existing conflicting or unsafe cache files are preserved and never overwritten', async t => {
  const f = await fixture(t), { bytes } = await f.seal();
  const file = path.join(f.target, f.names[0]);
  await fs.writeFile(file, 'foreign bytes', { mode: 0o600 });
  await assert.rejects(f.restore(bytes));
  assert.equal(await fs.readFile(file, 'utf8'), 'foreign bytes');
  await fs.unlink(file); await fs.symlink(path.join(f.source, f.names[0]), file);
  await assert.rejects(f.restore(bytes)); assert((await fs.lstat(file)).isSymbolicLink());
  assert.deepEqual(await fs.readFile(path.join(f.source, f.names[0])), f.values[0]);
});

test('cache restore enforces the existing free-space reserve without eviction or partial admission', async t => {
  const f = await fixture(t), { bytes } = await f.seal();
  await assert.rejects(f.restore(bytes, { freeBytes: async () => 1024 ** 3 }));
  for (const name of f.names) await assert.rejects(fs.stat(path.join(f.target, name)), { code: 'ENOENT' });
  await assert.rejects(f.restore(bytes, { freeBytes: async () => NaN }));
});

test('a restore interrupted after one immutable admission preserves it and retries without replacement', async t => {
  const f = await fixture(t), { bytes } = await f.seal(), stop = new AbortController(), link = fs.link;
  let reached = false;
  fs.link = async (from, to) => {
    const result = await link(from, to);
    if (!reached && f.names.some(name => String(to).endsWith('/' + name))) { reached = true; stop.abort(Error('Interrupted after immutable admission')); }
    return result;
  };
  try { await assert.rejects(f.restore(bytes, { signal: stop.signal })); } finally { fs.link = link; }
  assert(reached);
  const present = [];
  for (const name of f.names) { const stat = await fs.stat(path.join(f.target, name)).catch(() => null); if (stat) present.push({ name, ino: stat.ino }); }
  assert.equal(present.length, 1);
  const result = await f.restore(bytes); assert.equal(result.reused, 1); assert.equal(result.restored, 1);
  assert.equal((await fs.stat(path.join(f.target, present[0].name))).ino, present[0].ino);
});

test('unsafe cache roots and symlinked SQLite exclusion are refused before outside writes', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside.sqlite');
  await fs.writeFile(outside, 'do not open', { mode: 0o600 });
  await fs.symlink(outside, path.join(f.source, '.archive-cache-write.sqlite'));
  await assert.rejects(f.seal()); assert.equal(await fs.readFile(outside, 'utf8'), 'do not open');
  await fs.unlink(path.join(f.source, '.archive-cache-write.sqlite'));
  await fs.chmod(f.source, 0o755); await assert.rejects(f.seal());
});

test('oversized or corrupt immutable source entries fail before a usable backup can be returned', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.source, f.names[0]), 'changed original cache');
  await assert.rejects(f.seal());
  await fs.writeFile(path.join(f.source, f.names[0]), f.values[0]);
  const large = path.join(f.source, 'c'.repeat(64) + '.gz');
  await fs.writeFile(large, '', { mode: 0o600 }); await fs.truncate(large, 16 * 1024 ** 2 + 1);
  await assert.rejects(f.seal());
});

test('empty caches still have an authenticated scope binding, and malformed oversized plans stop before staging', async t => {
  const f = await fixture(t);
  for (const name of f.names) await fs.unlink(path.join(f.source, name));
  const empty = await f.seal(); assert.equal(empty.result.objectCount, 0);
  assert.equal((await f.restore(empty.bytes)).objectCount, 0);
  const length = empty.bytes.readUInt32BE(), header = JSON.parse(empty.bytes.subarray(4, 4 + length));
  header.plan.objectBytes = 512 * 1024 ** 2 + 4097;
  const body = Buffer.from(JSON.stringify(header)), size = Buffer.alloc(4); size.writeUInt32BE(body.length);
  await assert.rejects(f.restore(Buffer.concat([size, body, empty.bytes.subarray(4 + length)])));
  assert.deepEqual((await fs.readdir(f.root)).sort(), ['source', 'target']);
});

test('the total 512 MiB cache bound includes protected unknown files without pruning them', async t => {
  const f = await fixture(t), { bytes } = await f.seal(), retained = path.join(f.target, 'protected-control.bin');
  const file = await fs.open(retained, 'wx', 0o600);
  try { await file.truncate(512 * 1024 ** 2 - 1024); } finally { await file.close(); }
  await assert.rejects(f.restore(bytes));
  assert.equal((await fs.stat(retained)).size, 512 * 1024 ** 2 - 1024);
  for (const name of f.names) await assert.rejects(fs.stat(path.join(f.target, name)), { code: 'ENOENT' });
});

test('source drift after encryption and reused target drift before completion both fail closed', async t => {
  const f = await fixture(t); let changed = false, writes = 0;
  await assert.rejects(f.seal({ write: async bytes => {
    if (++writes === 5) { changed = true; await fs.appendFile(path.join(f.source, f.names[0]), 'changed'); }
  } }));
  assert(changed);
  await fs.writeFile(path.join(f.source, f.names[0]), f.values[0]);
  const { bytes } = await f.seal();
  await fs.copyFile(path.join(f.source, f.names[0]), path.join(f.target, f.names[0]));
  const link = fs.link; let reached = false;
  fs.link = async (from, to) => {
    const result = await link(from, to);
    if (!reached) { reached = true; await fs.writeFile(path.join(f.target, f.names[0]), 'foreign changed reused bytes'); }
    return result;
  };
  try { await assert.rejects(f.restore(bytes)); } finally { fs.link = link; }
  assert(reached); assert.equal(await fs.readFile(path.join(f.target, f.names[0]), 'utf8'), 'foreign changed reused bytes');
});

test('malformed header and cancelled staging close input and release the real cache mutex', async t => {
  const f = await fixture(t); let closed = false;
  const stream = (async function* () { try { yield Buffer.from([0, 0, 32, 0]); } finally { closed = true; } })();
  await assert.rejects(f.restore(Buffer.alloc(0), { stream })); assert(closed);
  const { bytes } = await f.seal(), stop = new AbortController(), open = fs.open;
  let reached = false;
  fs.open = async function (name, ...args) {
    const file = await open(name, ...args);
    if (!reached && String(name).includes('.hosted-cache-restore-') && f.names.some(key => String(name).endsWith('/' + key))) {
      reached = true; stop.abort(Error('Stop authenticated staging'));
    }
    return file;
  };
  try { await assert.rejects(f.restore(bytes, { signal: stop.signal })); } finally { fs.open = open; }
  assert(reached);
  for (const name of f.names) await assert.rejects(fs.stat(path.join(f.target, name)), { code: 'ENOENT' });
  assert.equal((await f.restore(bytes)).restored, 2, 'The original shared SQLite exclusion is released');
});
