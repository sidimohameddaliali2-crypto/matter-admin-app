import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDriverAuditCollectorReadCache } from './driverAuditCollectorReadCache.js';
import { acquireWorkerLock } from '../vendor/driver-audits/integration/hosted/worker-lock.mjs';
import { openArchiveReadCache } from './driverAuditReadCache.js';

const execute = promisify(execFile), sha = value => createHash('sha256').update(value).digest('hex');
const body = '{"version":1,"fictionalEvidence":"original \\n bytes and دبي","history":[1,2]}';
const readName = 'matter_hosted_state_read', conditionalName = 'matter_hosted_state_read_if_changed';
const cachePointer = '.collector-state-read-v1.json';
const enough = async () => 2 * 1024 ** 3;
async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'audit-collector-cache-')));
  const cacheDirectory = path.join(root, 'archive-cache'); await fs.mkdir(cacheDirectory, { mode: 0o700 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let current = { revision: 7, body_text: body }; const calls = [];
  const rpc = async (name, args) => {
    calls.push({ name, args: structuredClone(args) });
    if (name === conditionalName) return current.revision === args.p_revision
      ? { revision: current.revision, body_text: null, unchanged: true }
      : { ...current, unchanged: false };
    if (name === readName) return { ...current };
    return { fictional: 'passthrough' };
  };
  const setup = { cacheDirectory, cacheFreeBytes: enough, ...options };
  const api = createDriverAuditCollectorReadCache(setup), wrapped = api.wrapRpc(rpc);
  return { root, ...setup, calls, rpc, api, wrapped, pointer: path.join(cacheDirectory, cachePointer),
    read: () => wrapped(readName, { p_key: 'collector-state' }),
    set: value => { current = value; }, current: () => current };
}

test('every head read checks the current server revision and reuses exact original bytes after the first body', async t => {
  const f = await fixture(t); assert.deepEqual(await f.read(), { revision: 7, body_text: body });
  assert.deepEqual(await f.read(), { revision: 7, body_text: body });
  assert.deepEqual(f.calls, [0, 7].map(p_revision => ({ name: conditionalName, args: { p_key: 'collector-state', p_revision } })));
  assert.equal((await fs.stat(f.pointer)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(f.cacheDirectory, sha(body) + '.gz'))).mode & 0o777, 0o600);
  f.set({ revision: 8, body_text: body.replace('[1,2]', '[1,2,3]') });
  assert.deepEqual(await f.read(), f.current()); assert.equal(f.calls.at(-1).args.p_revision, 7);
  assert.deepEqual(await f.read(), f.current()); assert.equal(f.calls.at(-1).args.p_revision, 8);
});

test('a fresh process reuses the saved body while still making a conditional RPC', async t => {
  const f = await fixture(t); await f.read();
  const program = `import {createDriverAuditCollectorReadCache} from ${JSON.stringify(new URL('./driverAuditCollectorReadCache.js', import.meta.url).href)};
    let count=0;const rpc=createDriverAuditCollectorReadCache({cacheDirectory:process.argv[1]}).wrapRpc(async(name,args)=>{
      if(name!=='matter_hosted_state_read_if_changed'||args.p_key!=='collector-state'||args.p_revision!==7)throw Error('Repeated full head download');
      count++;return{revision:7,body_text:null,unchanged:true};});
    const value=await rpc('matter_hosted_state_read',{p_key:'collector-state'});process.stdout.write(JSON.stringify({value,count}));`;
  const result = await execute(process.execPath, ['--input-type=module', '-e', program, f.cacheDirectory]);
  assert.deepEqual(JSON.parse(result.stdout), { value: { revision: 7, body_text: body }, count: 1 });
});

test('corrupt, missing or evicted cache never substitutes old bytes for a fresh full read', async t => {
  const f = await fixture(t); await f.read();
  for (const damage of [
    () => fs.writeFile(path.join(f.cacheDirectory, sha(body) + '.gz'), 'broken'),
    () => fs.writeFile(path.join(f.cacheDirectory, sha(body) + '.gz'), ''),
    () => fs.rm(path.join(f.cacheDirectory, sha(body) + '.gz')),
    () => fs.writeFile(f.pointer, '{broken'),
    () => fs.writeFile(f.pointer, ''),
    () => fs.writeFile(f.pointer, 'x'.repeat(2049)),
  ]) {
    await damage(); const calls = f.calls.length; assert.deepEqual(await f.read(), f.current());
    assert.equal(f.calls[calls].args.p_revision, 0);
    assert.deepEqual(await f.read(), f.current()); assert.equal(f.calls.at(-1).args.p_revision, 7);
  }
});

test('a network, auth or cancellation error is returned even when verified cached bytes exist', async t => {
  const f = await fixture(t); await f.read();
  for (const error of [Object.assign(Error('fictional auth failure'), { status: 401 }), new DOMException('fictional cancellation', 'AbortError')]) {
    let calls = 0;
    const wrapped = f.api.wrapRpc(async name => { calls++; assert.equal(name, conditionalName); throw error; });
    await assert.rejects(wrapped(readName, { p_key: 'collector-state' }), value => value === error);
    assert.equal(calls, 1);
  }
});

test('other keys, paid budgets and non-exact request shapes pass through without cache changes', async t => {
  const f = await fixture(t); const value = { untouched: true }; let last;
  const wrapped = f.api.wrapRpc(async (...args) => { last = args; return value; });
  for (const [name, args] of [[readName, { p_key: 'photo-grading-budget' }], [readName, { p_key: 'worker-budget' }],
    [readName, { p_key: 'collector-state', extra: true }], ['matter_hosted_state_cas', { p_key: 'review-journal' }]]) {
    assert.equal(await wrapped(name, args), value); assert.equal(last[0], name); assert.equal(last[1], args);
  }
  assert.deepEqual(await fs.readdir(f.cacheDirectory), []);
});

test('collector CAS warms only the exact acknowledged submitted body; cache failure cannot fail its committed receipt', async t => {
  const f = await fixture(t), next = '{"version":1,"genuine":"fictional change"}', event = '{"kind":"collector"}';
  const args = { p_expected: 10, p_body_text: next, p_event_text: event };
  const receipt = { revision: 11, body_text: next, body_sha256: sha(next), event_text: event, replayed: false };
  const wrapped = f.api.wrapRpc(async name => name === 'matter_hosted_collector_cas_review' ? receipt
    : { revision: 11, body_text: null, unchanged: true });
  assert.equal(await wrapped('matter_hosted_collector_cas_review', args), receipt);
  assert.deepEqual(await wrapped(readName, { p_key: 'collector-state' }), { revision: 11, body_text: next });
  const unavailable = createDriverAuditCollectorReadCache({ cacheDirectory: path.join(f.root, 'absent') }).wrapRpc(async () => receipt);
  assert.equal(await unavailable('matter_hosted_collector_cas', args), receipt);
  await fs.rm(f.pointer);
  for (const mismatch of [{ ...receipt, body_text: body }, { ...receipt, body_sha256: 'a'.repeat(64) },
    { ...receipt, revision: 12 }, { ...receipt, event_text: '{"kind":"different"}' }]) {
    assert.equal(await f.api.wrapRpc(async () => mismatch)('matter_hosted_collector_cas', args), mismatch);
    await assert.rejects(fs.stat(f.pointer), { code: 'ENOENT' });
  }
});

test('a slower earlier response cannot overwrite a newer cross-wrapper cache revision', async t => {
  const f = await fixture(t); let resolve;
  const slow = f.api.wrapRpc(() => new Promise(done => { resolve = done; }));
  const pending = slow(readName, { p_key: 'collector-state' });
  while (!resolve) await new Promise(done => setImmediate(done));
  f.set({ revision: 8, body_text: body.replace('[1,2]', '[1,2,3]') }); await f.read();
  resolve({ revision: 7, body_text: body, unchanged: false });
  assert.deepEqual(await pending, { revision: 7, body_text: body });
  assert.deepEqual(await f.read(), f.current()); assert.equal(f.calls.at(-1).args.p_revision, 8);
});

test('unchanged responses must match their verified cached revision and contain no replacement body', async t => {
  const f = await fixture(t); await f.read();
  for (const result of [{ revision: 8, body_text: null, unchanged: true }, { revision: 7, body_text: body, unchanged: true },
    { revision: 7, body_text: null }, { revision: 6, body_text: body, unchanged: false }]) {
    await assert.rejects(f.api.wrapRpc(async () => result)(readName, { p_key: 'collector-state' }));
  }
});

test('an absent server head is checked with a fresh full read and is never permanently cached', async t => {
  const f = await fixture(t); f.set({ revision: 0, body_text: null });
  assert.deepEqual(await f.read(), f.current());
  assert.deepEqual(f.calls.map(row => row.name), [conditionalName, readName]);
  await assert.rejects(fs.stat(f.pointer), { code: 'ENOENT' });
});

test('response limits include JSON escaping and apply to reused disk bodies', async t => {
  const f = await fixture(t); await f.read();
  const maximum = Buffer.byteLength(JSON.stringify({ revision: 7, body_text: body })) - 1;
  await assert.rejects(f.api.wrapRpc(f.rpc, { maxResponseBytes: maximum })(readName, { p_key: 'collector-state' }), /limit/);
});

test('existing shared archive cache reads the same body file and its OS lock prevents a second writer', async t => {
  const f = await fixture(t);
  // The real managed archive writer explicitly creates this file privately
  // before acquiring its shared OS lock; the generic worker helper does not.
  await fs.writeFile(path.join(f.cacheDirectory, '.archive-cache-write.sqlite'), '', { mode: 0o600 });
  const held = await acquireWorkerLock(path.join(f.cacheDirectory, '.archive-cache-write'));
  try { assert.deepEqual(await f.read(), f.current()); await assert.rejects(fs.stat(f.pointer), { code: 'ENOENT' }); }
  finally { await held.release(); }
  await f.read();
  assert.deepEqual(await openArchiveReadCache(f.cacheDirectory, enough).read(sha(body) + '.gz'), Buffer.from(body));
  const independent = Buffer.from('fictional immutable archive object');
  await openArchiveReadCache(f.cacheDirectory, enough).remember(sha(independent) + '.gz', independent);
  assert.deepEqual(await f.read(), f.current()); assert.equal(f.calls.at(-1).args.p_revision, 7);
});

test('unprivate, linked and foreign cache metadata is never admitted as a source revision', async t => {
  for (const damage of ['pointer-mode', 'body-mode', 'pointer-link', 'body-link', 'foreign', 'duplicate']) {
    const f = await fixture(t); await f.read(); const object = path.join(f.cacheDirectory, sha(body) + '.gz');
    const protectedFile = path.join(f.root, 'original-evidence'); await fs.writeFile(protectedFile, body, { mode: 0o600 });
    if (damage === 'pointer-mode') await fs.chmod(f.pointer, 0o644);
    if (damage === 'body-mode') await fs.chmod(object, 0o644);
    if (damage === 'pointer-link' || damage === 'body-link') {
      const file = damage === 'pointer-link' ? f.pointer : object; await fs.unlink(file); await fs.symlink(protectedFile, file);
    }
    if (damage === 'foreign') { const value = JSON.parse(await fs.readFile(f.pointer)); value.projectRef = 'a'.repeat(20); await fs.writeFile(f.pointer, JSON.stringify(value)); }
    if (damage === 'duplicate') await fs.writeFile(f.pointer, (await fs.readFile(f.pointer, 'utf8')).replace('{', '{"revision":999,'));
    const index = f.calls.length; assert.deepEqual(await f.read(), f.current());
    assert.equal(f.calls[index].args.p_revision, 0, damage);
    assert.equal(await fs.readFile(protectedFile, 'utf8'), body);
  }
});

test('opened pointer permission drift is rejected before any cached revision is sent', async t => {
  const f = await fixture(t); await f.read(); const original = fs.open; let injected = false;
  fs.open = async function (file, ...args) {
    const handle = await original.call(this, file, ...args);
    if (file === f.pointer && !injected) {
      injected = true; const stat = handle.stat.bind(handle); let calls = 0;
      handle.stat = async (...options) => { const value = await stat(...options); if (++calls === 1) await fs.chmod(file, 0o644); return value; };
    }
    return handle;
  };
  try { const index = f.calls.length; assert.deepEqual(await f.read(), f.current()); assert.equal(f.calls[index].args.p_revision, 0); }
  finally { fs.open = original; }
  assert(injected);
});

test('a replaced cache directory during a body read cannot produce a cached authoritative answer', async t => {
  const f = await fixture(t); await f.read(); const original = fs.open; let injected = false;
  fs.open = async function (file, ...args) {
    const handle = await original.call(this, file, ...args);
    if (file === path.join(f.cacheDirectory, sha(body) + '.gz') && !injected) {
      injected = true; await fs.rename(f.cacheDirectory, path.join(f.root, 'previous-cache'));
      await fs.mkdir(f.cacheDirectory, { mode: 0o700 });
    }
    return handle;
  };
  try { const index = f.calls.length; assert.deepEqual(await f.read(), f.current()); assert.equal(f.calls[index].args.p_revision, 0); }
  finally { fs.open = original; }
  assert(injected); assert.equal(await fs.readFile(path.join(f.root, 'previous-cache', sha(body) + '.gz'), 'utf8'), body);
});

test('the one-GiB free floor skips cache admission while existing verified reads remain available', async t => {
  const f = await fixture(t, { cacheFreeBytes: async () => 1024 ** 3 }); await f.read();
  await assert.rejects(fs.stat(f.pointer), { code: 'ENOENT' });
  assert.equal((await fs.readdir(f.cacheDirectory)).filter(name => /^[a-f0-9]{64}\.gz$/.test(name)).length, 0);
  const warm = await fixture(t); await warm.read();
  const read = createDriverAuditCollectorReadCache({ cacheDirectory: warm.cacheDirectory, cacheFreeBytes: async () => 0 }).wrapRpc(warm.rpc);
  assert.deepEqual(await read(readName, { p_key: 'collector-state' }), warm.current()); assert.equal(warm.calls.at(-1).args.p_revision, 7);
});

test('the shared byte bound counts unknown files without deleting original evidence', async t => {
  const f = await fixture(t), file = path.join(f.cacheDirectory, 'unknown-retained-file');
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile('preserved original'); await handle.truncate(512 * 1024 ** 2); } finally { await handle.close(); }
  assert.deepEqual(await f.read(), f.current()); await assert.rejects(fs.stat(f.pointer), { code: 'ENOENT' });
  assert.equal((await fs.stat(file)).size, 512 * 1024 ** 2);
  const check = await fs.open(file, 'r'); const bytes = Buffer.alloc(18);
  try { await check.read(bytes, 0, bytes.length, 0); assert.equal(bytes.toString(), 'preserved original'); } finally { await check.close(); }
});

test('8192 shared object slots are respected by evicting only disposable hash copies', async t => {
  const f = await fixture(t); const keys = Array.from({ length: 8192 }, (_, index) => sha('fictional-slot-' + index) + '.gz');
  for (let offset = 0; offset < keys.length; offset += 64) await Promise.all(keys.slice(offset, offset + 64)
    .map(name => fs.writeFile(path.join(f.cacheDirectory, name), '', { mode: 0o600 })));
  await f.read(); const names = await fs.readdir(f.cacheDirectory);
  assert.equal(names.filter(name => /^[a-f0-9]{64}\.gz$/.test(name)).length, 8192);
  assert(names.includes(sha(body) + '.gz')); assert(names.includes(cachePointer));
});

test('oversized current heads remain fresh RPC results without exceeding the sixteen-MiB cache object cap', async t => {
  const f = await fixture(t); f.set({ revision: 8, body_text: JSON.stringify({ version: 1, fictional: 'x'.repeat(16 * 1024 ** 2) }) });
  assert.deepEqual(await f.read(), f.current()); await assert.rejects(fs.stat(f.pointer), { code: 'ENOENT' });
  assert.equal((await fs.readdir(f.cacheDirectory)).filter(name => /^[a-f0-9]{64}\.gz$/.test(name)).length, 0);
});

test('abandoned cache temporaries have bounded cleanup and are never treated as original evidence', async t => {
  const f = await fixture(t), names = Array.from({ length: 40 }, (_, index) => '.collector-state-read-'
    + ('00000000-0000-0000-0000-' + String(index).padStart(12, '0')) + '.tmp');
  for (const name of names) await fs.writeFile(path.join(f.cacheDirectory, name), 'fictional abandoned metadata', { mode: 0o600 });
  await f.read(); assert.equal((await fs.readdir(f.cacheDirectory)).filter(name => names.includes(name)).length, 8);
  await assert.rejects(fs.stat(f.pointer), { code: 'ENOENT' });
  await f.read(); assert.equal((await fs.readdir(f.cacheDirectory)).filter(name => names.includes(name)).length, 0);
  assert.deepEqual(await f.read(), f.current()); assert.equal(f.calls.at(-1).args.p_revision, 7);
});

test('a post-commit pointer write failure leaves the real CAS receipt successful and releases the cache lock', async t => {
  const f = await fixture(t), event = '{"kind":"collector"}', receipt = {
    revision: 8, body_text: body, body_sha256: sha(body), event_text: event, replayed: false,
  }, original = fs.rename;
  fs.rename = async function (from, to) { if (to === f.pointer) throw Error('fictional pointer I/O failure'); return original.call(this, from, to); };
  try { const wrapped = f.api.wrapRpc(async () => receipt);
    assert.equal(await wrapped('matter_hosted_collector_cas', { p_expected: 7, p_body_text: body, p_event_text: event }), receipt); }
  finally { fs.rename = original; }
  const held = await acquireWorkerLock(path.join(f.cacheDirectory, '.archive-cache-write')); await held.release();
  assert(!(await fs.readdir(f.cacheDirectory)).some(name => name.endsWith('.tmp')));
});

test('direct conditional reads may warm the same persistent cache without changing their RPC result', async t => {
  const f = await fixture(t); const args = { p_key: 'collector-state', p_revision: 0 };
  assert.deepEqual(await f.wrapped(conditionalName, args), { ...f.current(), unchanged: false });
  assert.deepEqual(await f.read(), f.current()); assert.equal(f.calls.at(-1).args.p_revision, 7);
});

test('unrelated getter-backed arguments are forwarded without reading or rewriting them', async t => {
  const f = await fixture(t), args = {}; let getters = 0;
  Object.defineProperty(args, 'p_key', { enumerable: true, get() { getters++; return 'collector-state'; } });
  const value = { forwarded: true }, wrapped = f.api.wrapRpc(async (name, actual) => { assert.equal(actual, args); return value; });
  assert.equal(await wrapped(readName, args), value); assert.equal(getters, 0);
});

test('a late response in another OS process cannot replace a newer saved head', async t => {
  const f = await fixture(t);
  const program = `import {createDriverAuditCollectorReadCache} from ${JSON.stringify(new URL('./driverAuditCollectorReadCache.js', import.meta.url).href)};
    const rpc=createDriverAuditCollectorReadCache({cacheDirectory:process.argv[1]}).wrapRpc(async(name,args)=>{
      if(name!=='matter_hosted_state_read_if_changed'||args.p_revision!==0)throw Error('Unexpected fixture state');
      process.stdout.write('ready\\n');await new Promise(resolve=>process.stdin.once('data',resolve));
      return{revision:7,body_text:process.argv[2],unchanged:false};});
    const result=await rpc('matter_hosted_state_read',{p_key:'collector-state'});process.stdout.write(JSON.stringify(result));`;
  const job = execute(process.execPath, ['--input-type=module', '-e', program, f.cacheDirectory, body], { timeout: 10000 });
  t.after(() => job.child.kill('SIGKILL'));
  await new Promise((resolve, reject) => {
    job.child.stdout.on('data', value => { if (value.toString().includes('ready\n')) resolve(); });
    job.catch(reject);
  });
  f.set({ revision: 8, body_text: body.replace('[1,2]', '[1,2,3]') }); await f.read();
  job.child.stdin.end('finish\n'); const completed = await job;
  assert.deepEqual(JSON.parse(completed.stdout.split('\n')[1]), { revision: 7, body_text: body });
  assert.deepEqual(await f.read(), f.current()); assert.equal(f.calls.at(-1).args.p_revision, 8);
});

test('cache body and pointer admission share the full physical byte limit with existing archive copies', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 32; index++) {
    const file = await fs.open(path.join(f.cacheDirectory, sha('sparse-copy-' + index) + '.gz'), 'wx', 0o600);
    try { await file.truncate(16 * 1024 ** 2); } finally { await file.close(); }
  }
  await f.read(); let bytes = 0;
  for (const name of await fs.readdir(f.cacheDirectory)) { const info = await fs.lstat(path.join(f.cacheDirectory, name)); bytes += Math.max(info.size, info.blocks * 512); }
  assert(bytes <= 512 * 1024 ** 2); assert.deepEqual(await f.read(), f.current());
  assert.equal(f.calls.at(-1).args.p_revision, 7);
});

test('a cache body made unprivate at promotion is never advertised by a new pointer', async t => {
  const f = await fixture(t), original = fs.rename; let injected = false;
  fs.rename = async function (from, to) {
    if (to === path.join(f.cacheDirectory, sha(body) + '.gz')) { injected = true; await fs.chmod(from, 0o644); }
    return original.call(this, from, to);
  };
  try { assert.deepEqual(await f.read(), f.current()); }
  finally { fs.rename = original; }
  assert(injected); await assert.rejects(fs.stat(f.pointer), { code: 'ENOENT' });
  const held = await acquireWorkerLock(path.join(f.cacheDirectory, '.archive-cache-write')); await held.release();
});

test('unknown or nonnumeric free-space evidence cannot authorize a cache write', async t => {
  for (const available of [NaN, Infinity, undefined, '2147483648']) {
    const f = await fixture(t, { cacheFreeBytes: async () => available });
    assert.deepEqual(await f.read(), f.current()); await assert.rejects(fs.stat(f.pointer), { code: 'ENOENT' });
    assert.equal((await fs.readdir(f.cacheDirectory)).filter(name => /^[a-f0-9]{64}\.gz$/.test(name)).length, 0);
  }
});
