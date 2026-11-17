import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { runDriverAuditSupabaseLogCompaction, inspectDriverAuditLogDescriptors } from './driver-audit-supabase-log-compact.mjs';
import { acquireWorkerLock } from '../../server/vendor/driver-audits/integration/hosted/worker-lock.mjs';
import { openTransferSecrets, sealTransferSecrets } from '../../server/services/driverAuditTransferCodec.js';
import { driverAuditSupabaseControlStoppedReceipt } from './driver-audit-native-handoff.mjs';
const APP = '701655794e1711b4d8c737e929360ecfe5d2f0ca', names = ['matter-delivery-api-out-0.log', 'server-error.log', 'server-out.log'];
const sha = b => createHash('sha256').update(b).digest('hex'), encode = v => Buffer.from(JSON.stringify(v));
const stats = s => Object.fromEntries(['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'blocks', 'mtimeNs', 'ctimeNs'].map(k => [k, String(s[k])]));
const keys = generateKeyPairSync('rsa', { modulusLength: 3072 }), publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' });
async function fixture(t, { random = false, mixed = false } = {}) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'closed-log-'))); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const appRoot = path.join(home, 'matter-delivery-tracker'), server = path.join(appRoot, 'server'), logs = path.join(home, '.pm2/logs');
  const plans = path.join(server, '.private/driver-report-log-archives'), lockRoot = path.join(server, '.private/driver-report-supabase-handoff');
  for (const folder of [logs, plans, lockRoot]) await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  await fs.chmod(server, 0o775); // Existing tracked app directory is not a source log parent.
  const original = new Map(), scopeFiles = [], rows = [];
  for (const [index, name] of names.entries()) {
    const body = random || mixed && index === 0 ? randomBytes(128 * 1024) : Buffer.from(('original retained log ' + index + '\n').repeat(2000));
    const file = path.join(logs, name); await fs.writeFile(file, body, { mode: 0o600 }); await fs.chmod(file, 0o664);
    const st = stats(await fs.stat(file, { bigint: true })); original.set(name, body); scopeFiles.push({ name, ino: st.ino, size: st.size });
    rows.push({ name, path: file, type: 'regular', before: st, after: st });
  }
  const active = path.join(logs, 'current-api.log'); await fs.writeFile(active, 'current business log', { mode: 0o600 });
  const pm2 = [
    { name: 'matter-delivery-api', pm_id: 1, pid: 123, pm2_env: { status: 'online', pm_cwd: appRoot, pm_exec_path: '/usr/bin/npm',
      args: ['start', '--prefix', 'server'], restart_time: 4, unstable_restarts: 0, pm_uptime: 12345,
      pm_out_log_path: active, pm_err_log_path: path.join(logs, 'current-api-error.log') } },
    { name: 'matter-driver-audit-sync', pm_id: 2, pid: 0, pm2_env: { status: 'stopped', pm_cwd: server,
      pm_exec_path: path.join(server, 'scripts/driverAuditSync.js'), args: ['--config', path.join(server, '.private/driver-audits', 'b'.repeat(64), 'sync.json')],
      restart_time: 2, unstable_restarts: 0, pm_uptime: 5678, pm_out_log_path: path.join(logs, 'sync-out.log'), pm_err_log_path: path.join(logs, 'sync-error.log') } },
  ];
  const plan = { version: 1, kind: 'supabase-pm2-log-archive-plan-v1', applicationCommit: APP, logRoot: logs, files: rows,
    processes: [{ role: 'business-api', id: 1, pid: 123, status: 'online' }] }, rawPlan = encode(plan), planSha256 = sha(rawPlan);
  await fs.writeFile(path.join(plans, planSha256 + '.private.json'), rawPlan, { mode: 0o600 });
  let audits = 0; const calls = [];
  const adapters = { homeRoot: home, platform: 'linux', scope: { planSha256, uid: process.getuid(), gid: process.getgid(), files: scopeFiles },
    async exec(file, args) { calls.push({ file, args }); if (file === 'git') return { stdout: args[0] === 'rev-parse' ? APP + '\n' : '' };
      assert.equal(file, 'pm2'); assert.deepEqual(args, ['jlist']); return { stdout: JSON.stringify(pm2) }; },
    async load(name) { if (name.includes('worker-lock')) return { acquireWorkerLock }; assert.equal(name, 'services/driverAuditTransferCodec.js'); return { sealTransferSecrets }; },
    async inspectDescriptors(context) { audits++; return { version: 1, checkedAt: new Date().toISOString(), selectedIdentities: [...context.identities].sort(),
      otherSelectedDescriptors: 0, globalRootDescriptorCoverageClaimed: false, scope: 'fictional fixture census', ownReadFds: context.ownedReadFds.size }; },
  };
  const run = changes => runDriverAuditSupabaseLogCompaction({ operation: 'archive-closed-logs', appRoot, expectedSha: APP,
    recipientPublicKey: publicPem, planSha256, ...changes }, adapters);
  return { home, appRoot, server, logs, plans, lockRoot, active, original, pm2, adapters, run, calls, rows, planSha256,
    recovery: path.join(plans, planSha256 + '.recovery'), rawPlan, audits: () => audits };
}
function opened(result) { const env = openTransferSecrets(keys.privateKey, result.capsule), zipped = Buffer.from(env.metadataGzipBase64, 'base64');
  assert.equal(sha(zipped), env.metadataGzipSha256); const raw = gunzipSync(zipped, { maxOutputLength: 384 * 1024 }); assert.equal(sha(raw), result.metadataSha256); return JSON.parse(raw); }
async function rawEntries(f) { const root = path.join(f.recovery, 'raw'); const out = [];
  for (const folder of await fs.readdir(root)) { const file = path.join(root, folder, 'original.log'); try { out.push({ file, body: await fs.readFile(file) }); } catch (e) { if (e.code !== 'ENOENT') throw e; } } return out; }

test('only three exact legacy logs retire privately and receive byte-verified gzip receipts before raw release', { timeout: 15000 }, async t => {
  const f = await fixture(t), beforeProcesses = structuredClone(f.pm2), result = await f.run(), value = opened(result);
  assert.equal(result.status, 'supabase-closed-logs-archived'); assert.equal(result.archivedLogs, 3); assert.equal(value.receipts.length, 3);
  assert(value.fullHostPlanBytesExported); assert(Buffer.from(value.fullHostPlan.dataBase64, 'base64').equals(f.rawPlan));
  for (const receipt of value.receipts) {
    const expected = f.original.get(receipt.name), zipped = await fs.readFile(receipt.gzipPath);
    assert(gunzipSync(zipped).equals(expected)); assert.equal(sha(zipped), receipt.gzipSha256); assert.equal(sha(expected), receipt.rawSha256);
    assert.equal((await fs.stat(receipt.gzipPath)).mode & 0o7777, 0o600); await assert.rejects(fs.access(path.join(f.logs, receipt.name)), { code: 'ENOENT' });
    const ready = JSON.parse(await fs.readFile(path.join(f.recovery, receipt.name + '.unlink-ready.private.json')));
    assert.equal(ready.ownRawDescriptorClosed, true); assert.equal(ready.descriptorCensus.otherSelectedDescriptors, 0);
  }
  assert.equal((await rawEntries(f)).length, 0); assert.deepEqual(f.pm2, beforeProcesses); assert.equal(await fs.readFile(f.active, 'utf8'), 'current business log');
  assert.equal(value.kernelNoReplaceOrInodeCasClaimed, false); assert.equal(value.globalRootDescriptorCoverageClaimed, false);
  assert.equal(value.seedReadyClaimed, false); assert(f.audits() > 6); assert(f.calls.every(c => c.file === 'git' || c.file === 'pm2' && c.args[0] === 'jlist'));
  const again = opened(await f.run()); assert.equal(again.originalIntentCreatedAt, value.originalIntentCreatedAt);
  assert.deepEqual(again.receipts, value.receipts);
});

test('combined PM2 mappings, inode aliases and restart drift stop before retirement', async t => {
  for (const kind of ['combined', 'alias', 'restart']) {
    const f = await fixture(t);
    if (kind === 'combined') f.pm2[0].pm2_env.pm_log_path = path.join(f.logs, names[0]);
    if (kind === 'alias') { const alias = path.join(f.logs, 'alias.log'); await fs.symlink(path.join(f.logs, names[0]), alias); f.pm2[0].pm2_env.pm_out_log_path = alias; }
    if (kind === 'restart') { const exec = f.adapters.exec; let count = 0; f.adapters.exec = async (...args) => { if (args[0] === 'pm2' && ++count > 1) f.pm2[0].pm2_env.restart_time++; return exec(...args); }; }
    await assert.rejects(f.run());
    for (const [name, body] of f.original) assert((await fs.readFile(path.join(f.logs, name))).equals(body));
  }
});

test('unreadable descriptor coverage and changed or linked originals cannot enter gzip or raw unlink', async t => {
  for (const kind of ['unknown-fd', 'hardlink', 'append']) {
    const f = await fixture(t);
    if (kind === 'unknown-fd') f.adapters.inspectDescriptors = async () => { throw Object.assign(Error('Unknown owner FD'), { code: 'PROC_FDS_UNKNOWN' }); };
    if (kind === 'hardlink') await fs.link(path.join(f.logs, names[0]), path.join(f.logs, 'second-name.log'));
    if (kind === 'append') await fs.appendFile(path.join(f.logs, names[0]), 'new original data');
    await assert.rejects(f.run()); assert((await fs.stat(path.join(f.logs, names[0]))).isFile());
    await assert.rejects(fs.access(path.join(f.recovery, names[0] + '.verified.private.json')), { code: 'ENOENT' });
  }
});

test('interrupt after rename retains exact private raw and resumes the same intent without moving a new original', { timeout: 15000 }, async t => {
  const f = await fixture(t), controller = new AbortController(); f.adapters.signal = controller.signal;
  f.adapters.onPhase = async phase => { if (phase === 'after-rename') controller.abort(Error('fixture cancel')); };
  await assert.rejects(f.run()); const retained = await rawEntries(f); assert.equal(retained.length, 1); assert(retained[0].body.equals(f.original.get(names[0])));
  const intent = await fs.readFile(path.join(f.recovery, 'intent.private.json'));
  delete f.adapters.signal; delete f.adapters.onPhase; const result = opened(await f.run());
  assert.equal(result.intentSha256, sha(intent)); assert.equal(result.receipts.length, 3); assert((await fs.readFile(path.join(f.recovery, 'intent.private.json'))).equals(intent));
});

test('interruption after verified receipt preserves raw plus verified gzip and reuses their exact receipt on retry', { timeout: 15000 }, async t => {
  const f = await fixture(t), controller = new AbortController(); f.adapters.signal = controller.signal;
  f.adapters.onPhase = async phase => { if (phase === 'verified-receipt') controller.abort(Error('fixture cancel')); };
  await assert.rejects(f.run()); const before = await fs.readFile(path.join(f.recovery, names[0] + '.verified.private.json'));
  assert.equal((await rawEntries(f)).length, 1); delete f.adapters.signal; delete f.adapters.onPhase;
  const result = opened(await f.run()); assert.equal(result.receipts.length, 3);
  assert((await fs.readFile(path.join(f.recovery, names[0] + '.verified.private.json'))).equals(before));
});

test('crash after raw unlink recovers only with the original durable verified and unlink-ready records', { timeout: 15000 }, async t => {
  const f = await fixture(t), controller = new AbortController(); f.adapters.signal = controller.signal;
  f.adapters.onPhase = async phase => { if (phase === 'after-raw-unlink') controller.abort(Error('fixture cancel')); };
  await assert.rejects(f.run()); assert.equal((await rawEntries(f)).length, 0);
  await assert.rejects(fs.access(path.join(f.logs, names[0])), { code: 'ENOENT' }); delete f.adapters.signal; delete f.adapters.onPhase;
  assert.equal((await f.run()).archivedLogs, 3);
});

test('an independently recreated published file is retained and stops retry without a second move', async t => {
  const f = await fixture(t), controller = new AbortController(); f.adapters.signal = controller.signal;
  f.adapters.onPhase = async p => { if (p === 'after-rename') controller.abort(); }; await assert.rejects(f.run());
  const independent = Buffer.from('new unrelated business output'); await fs.writeFile(path.join(f.logs, names[0]), independent);
  delete f.adapters.signal; delete f.adapters.onPhase; await assert.rejects(f.run());
  assert((await fs.readFile(path.join(f.logs, names[0]))).equals(independent)); assert.equal((await rawEntries(f)).length, 1);
});

test('gzip budget or corrupted verified output keeps the original recoverable and performs no raw release', { timeout: 15000 }, async t => {
  const f = await fixture(t, { random: true }); f.adapters.outputBudget = 32 * 1024; await assert.rejects(f.run());
  assert.equal((await rawEntries(f)).length, 1); await assert.rejects(fs.access(path.join(f.recovery, names[0] + '.verified.private.json')), { code: 'ENOENT' });
  const g = await fixture(t), controller = new AbortController(); g.adapters.signal = controller.signal;
  g.adapters.onPhase = async p => { if (p === 'verified-receipt') controller.abort(); }; await assert.rejects(g.run());
  const receipt = JSON.parse(await fs.readFile(path.join(g.recovery, names[0] + '.verified.private.json'))); await fs.appendFile(receipt.gzipPath, 'independent edit');
  delete g.adapters.signal; delete g.adapters.onPhase; await assert.rejects(g.run()); assert.equal((await rawEntries(g)).length, 1);
});

test('extra paths wrong plan and group-writable source parents fail without touching any log bytes', async t => {
  const f = await fixture(t);
  for (const extra of [{ paths: ['/etc'] }, { planSha256: 'a'.repeat(64) }, { operation: 'truncate-logs' }]) await assert.rejects(f.run(extra));
  await fs.chmod(f.logs, 0o775); await assert.rejects(f.run());
  for (const [name, body] of f.original) assert((await fs.readFile(path.join(f.logs, name))).equals(body));
});

async function procFixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'proc-log-'))); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const raw = path.join(root, 'raw.log'); await fs.writeFile(raw, 'original'); const s = await fs.stat(raw, { bigint: true }), identity = String(s.dev) + ':' + String(s.ino);
  const add = async (pid, uid, groups, fd) => {
    const folder = path.join(root, String(pid)); await fs.mkdir(path.join(folder, 'fd'), { recursive: true }); await fs.mkdir(path.join(folder, 'fdinfo'));
    await fs.writeFile(path.join(folder, 'status'), 'Uid:\t' + [uid, uid, uid, uid].join('\t') + '\nGid:\t' + [groups[0] ?? 0, groups[0] ?? 0, groups[0] ?? 0, groups[0] ?? 0].join('\t') + '\nGroups:\t' + groups.join(' ') + '\n');
    if (fd !== undefined) { await fs.symlink(raw, path.join(folder, 'fd', String(fd))); await fs.writeFile(path.join(folder, 'fdinfo', String(fd)), 'flags:\t0100000\n'); }
  };
  return { root, raw, identity, add, run: extra => inspectDriverAuditLogDescriptors({ procRoot: root, uid: process.getuid(), gid: process.getgid(), identities: new Set([identity]), ...extra }) };
}

test('descriptor census rejects read-only readers and foreign non-root members of the selected group', async t => {
  const f = await procFixture(t); await f.add(70001, process.getuid(), [process.getgid()], 3); await assert.rejects(f.run(), e => e.code === 'RAW_DESCRIPTOR_OPEN');
  const g = await procFixture(t); await g.add(70002, 88888, [process.getgid()], 4); await assert.rejects(g.run(), e => e.code === 'RAW_DESCRIPTOR_OPEN');
});
test('descriptor census permits only explicitly registered own read FDs and labels privileged-root exclusion', async t => {
  const f = await procFixture(t); await f.add(process.pid, process.getuid(), [process.getgid()], 17); await f.add(70003, 0, []);
  const result = await f.run({ ownedReadFds: new Map([[17, f.identity]]) }); assert.equal(result.otherSelectedDescriptors, 0);
  assert.equal(result.globalRootDescriptorCoverageClaimed, false); assert(result.excludedPrivilegedRootPids.includes(70003));
  await fs.writeFile(path.join(f.root, String(process.pid), 'fdinfo/17'), 'flags:\t0100002\n'); await assert.rejects(f.run({ ownedReadFds: new Map([[17, f.identity]]) }));
});

for (const leaf of ['intent.private.json', 'original-plan.private.json', 'entry.private.json']) {
  test('interrupted atomic metadata admission for ' + leaf + ' preserves originals and resumes without an invented origin', async t => {
    const f = await fixture(t), rename = fs.rename; let injected = false;
    fs.rename = async (from, to) => {
      if (!injected && String(to).endsWith('/' + leaf)) { injected = true; throw Object.assign(Error('fictional metadata finalize interruption'), { code: 'EIO' }); }
      return rename(from, to);
    };
    try { await assert.rejects(f.run()); } finally { fs.rename = rename; }
    assert(injected);
    for (const [name, body] of f.original) assert((await fs.readFile(path.join(f.logs, name))).equals(body));
    const intent = leaf !== 'intent.private.json' ? await fs.readFile(path.join(f.recovery, 'intent.private.json')) : null;
    assert.equal((await f.run()).archivedLogs, 3);
    if (intent) assert((await fs.readFile(path.join(f.recovery, 'intent.private.json'))).equals(intent));
  });
}

test('lost gzip finalize acknowledgement reuses verified output under the same aggregate budget', async t => {
  const baseline = await fixture(t, { mixed: true }); baseline.adapters.outputBudget = 200000;
  assert.equal((await baseline.run()).archivedLogs, 3);
  const f = await fixture(t, { mixed: true }); f.adapters.outputBudget = 200000;
  const rename = fs.rename; let injected = false, finalPath;
  fs.rename = async (from, to) => { const result = await rename(from, to);
    if (!injected && String(to).endsWith('/payload.gz')) { injected = true; finalPath = String(to); throw Object.assign(Error('fictional lost finalize ACK'), { code: 'EIO' }); }
    return result;
  };
  try { await assert.rejects(f.run()); } finally { fs.rename = rename; }
  assert(injected); const before = await fs.readFile(finalPath), retained = await rawEntries(f);
  assert.equal(retained.length, 1); assert(retained[0].body.equals(f.original.get(names[0])));
  const originalIntent = await fs.readFile(path.join(f.recovery, 'intent.private.json'));
  const result = opened(await f.run()), receipt = result.receipts.find(r => r.name === names[0]);
  assert.equal(receipt.gzipPath, finalPath); assert((await fs.readFile(finalPath)).equals(before));
  assert.equal(result.intentSha256, sha(originalIntent));
  assert.equal((await fs.readdir(path.join(f.recovery, 'archives'))).filter(n => n.startsWith(names[0] + '.gzip-')).length, 1);
});

test('gzip failure keeps its private first cause and propagates a cipher through the real bridge validator', async t => {
  const f = await fixture(t, { random: true }); f.adapters.outputBudget = 32 * 1024;
  let failure; try { await f.run(); } catch (e) { failure = e; }
  assert(failure); const accepted = driverAuditSupabaseControlStoppedReceipt(failure.supabaseControlStopped, APP, failure.phase);
  assert(accepted); const detail = opened(accepted);
  assert.equal(detail.code, 'GZIP_BUDGET'); assert.equal(accepted.operatorPhase, 'log-compaction-gzip');
  assert.equal((await rawEntries(f)).length, 1);
});

test('unknown status despite root-owned proc directory and unreadable same-UID descriptors reject before any retirement', async t => {
  for (const kind of ['unknown-status', 'same-uid-fd']) {
    const f = await fixture(t), proc = await procFixture(t); await proc.add(70004, process.getuid(), [process.getgid()]);
    const open = fs.open, readdir = fs.readdir, lstat = fs.lstat, stat = fs.stat; let injected = false;
    f.adapters.inspectDescriptors = ctx => inspectDriverAuditLogDescriptors({ ...ctx, procRoot: proc.root });
    fs.open = async (file, ...args) => {
      if (kind === 'unknown-status' && String(file) === path.join(proc.root, '70004/status')) { injected = true; throw Object.assign(Error('fictional denied status'), { code: 'EACCES' }); }
      return open(file, ...args);
    };
    fs.lstat = async (file, ...args) => { const s = await lstat(file, ...args);
      if (String(file) === path.join(proc.root, '70004')) return new Proxy(s, { get(target, prop) { return prop === 'uid' ? 0n : Reflect.get(target, prop); } });
      return s;
    };
    fs.stat = async (file, ...args) => { const s = await stat(file, ...args);
      if (String(file) === path.join(proc.root, '70004')) return new Proxy(s, { get(target, prop) { return prop === 'uid' ? 0n : Reflect.get(target, prop); } });
      return s;
    };
    fs.readdir = async (file, ...args) => {
      if (kind === 'same-uid-fd' && String(file) === path.join(proc.root, '70004/fd')) { injected = true; throw Object.assign(Error('fictional denied descriptors'), { code: 'EACCES' }); }
      return readdir(file, ...args);
    };
    let failure; try { await f.run(); } catch (e) { failure = e; }
    finally { fs.open = open; fs.readdir = readdir; fs.lstat = lstat; fs.stat = stat; }
    assert(injected); assert(failure); assert.equal(opened(failure.supabaseControlStopped).code, kind === 'unknown-status' ? 'PROC_STATUS_UNKNOWN' : 'PROC_FDS_UNKNOWN');
    await assert.rejects(fs.access(f.recovery), { code: 'ENOENT' });
    for (const [name, body] of f.original) assert((await fs.readFile(path.join(f.logs, name))).equals(body));
  }
});

test('corrupt finalized gzip or missing attempt origin is preserved with the raw log and never causes a replacement gzip', async t => {
  for (const kind of ['corrupt-final', 'missing-origin']) {
    const f = await fixture(t), rename = fs.rename; let finalPath;
    fs.rename = async (from, to) => { const value = await rename(from, to);
      if (!finalPath && String(to).endsWith('/payload.gz')) { finalPath = String(to); throw Object.assign(Error('fictional lost finalize ACK'), { code: 'EIO' }); }
      return value;
    };
    try { await assert.rejects(f.run()); } finally { fs.rename = rename; }
    assert(finalPath); const raw = (await rawEntries(f))[0];
    if (kind === 'corrupt-final') await fs.appendFile(finalPath, 'independent corrupt bytes');
    else await fs.rename(path.join(path.dirname(finalPath), 'attempt.private.json'), path.join(f.home, 'preserved-attempt.private.json'));
    const before = await fs.readFile(finalPath); await assert.rejects(f.run());
    assert((await fs.readFile(finalPath)).equals(before)); assert((await fs.readFile(raw.file)).equals(f.original.get(names[0])));
    assert.equal((await fs.readdir(path.join(f.recovery, 'archives'))).length, 1);
    await assert.rejects(fs.access(path.join(f.recovery, names[0] + '.verified.private.json')), { code: 'ENOENT' });
  }
});

test('a raw inode without original entry metadata or an unknown recovery entry stops without reading or releasing it', async t => {
  for (const kind of ['missing-origin', 'unknown-entry']) {
    const f = await fixture(t), controller = new AbortController(); f.adapters.signal = controller.signal;
    f.adapters.onPhase = async phase => { if (phase === 'after-rename') controller.abort(); };
    await assert.rejects(f.run()); delete f.adapters.signal; delete f.adapters.onPhase;
    const raw = (await rawEntries(f))[0];
    if (kind === 'missing-origin') await fs.rename(path.join(path.dirname(raw.file), 'entry.private.json'), path.join(f.home, 'preserved-entry.private.json'));
    else await fs.mkdir(path.join(f.recovery, 'raw', 'unrelated-owner-entry'), { mode: 0o700 });
    await assert.rejects(f.run()); assert((await fs.readFile(raw.file)).equals(f.original.get(names[0])));
    await assert.rejects(fs.access(path.join(f.recovery, names[0] + '.verified.private.json')), { code: 'ENOENT' });
  }
});

test('a close failure is recorded separately and cannot replace an already sealed raw-processing failure', async t => {
  const f = await fixture(t, { random: true }); f.adapters.outputBudget = 32 * 1024;
  const open = fs.open; let injected = false;
  fs.open = async (file, ...args) => { const fd = await open(file, ...args);
    if (!injected && String(file) === path.join(f.logs, names[0])) {
      injected = true; const close = fd.close.bind(fd); fd.close = async () => { await close(); throw Object.assign(Error('fictional descriptor close failure'), { code: 'EIO' }); };
    }
    return fd;
  };
  let failure; try { await f.run(); } catch (e) { failure = e; } finally { fs.open = open; }
  assert(injected); assert.equal(failure.phase, 'log-compaction-gzip'); assert.equal(failure.cleanupFailed, true);
  const receipt = driverAuditSupabaseControlStoppedReceipt(failure.supabaseControlStopped, APP, failure.phase);
  assert(receipt); assert.equal(opened(receipt).code, 'GZIP_BUDGET'); assert.equal((await rawEntries(f)).length, 1);
});

test('loss of acknowledgement on retirement or the verified receipt resumes the exact existing bytes and clocks', async t => {
  for (const point of ['original.log', names[0] + '.verified.private.json']) {
    const f = await fixture(t), rename = fs.rename; let injected = false;
    fs.rename = async (from, to) => { const result = await rename(from, to);
      if (!injected && String(to).endsWith('/' + point)) { injected = true; throw Object.assign(Error('fictional lost metadata ACK'), { code: 'EIO' }); }
      return result;
    };
    try { await assert.rejects(f.run()); } finally { fs.rename = rename; }
    assert(injected); const beforeIntent = await fs.readFile(path.join(f.recovery, 'intent.private.json'));
    const receiptPath = path.join(f.recovery, names[0] + '.verified.private.json');
    const beforeReceipt = point !== 'original.log' ? await fs.readFile(receiptPath) : null;
    const metadata = opened(await f.run()); assert.equal(metadata.intentSha256, sha(beforeIntent));
    if (beforeReceipt) assert((await fs.readFile(receiptPath)).equals(beforeReceipt));
    assert.equal((await fs.readdir(path.join(f.recovery, 'raw'))).filter(n => n.startsWith(names[0] + '.raw-')).length, 1);
    assert(gunzipSync(await fs.readFile(metadata.receipts[0].gzipPath)).equals(f.original.get(names[0])));
  }
});

test('real TERM INT and HUP stop after private retirement without terminating the holder or losing the raw bytes', { timeout: 20000 }, async () => {
  const url = file => pathToFileURL(path.resolve(file)).href;
  const script = `
    import fs from 'node:fs/promises'; import path from 'node:path'; import os from 'node:os';
    import assert from 'node:assert/strict';
    import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
    import { runDriverAuditSupabaseLogCompaction } from ${JSON.stringify(url('.github/scripts/driver-audit-supabase-log-compact.mjs'))};
    import { acquireWorkerLock } from ${JSON.stringify(url('server/vendor/driver-audits/integration/hosted/worker-lock.mjs'))};
    import { sealTransferSecrets } from ${JSON.stringify(url('server/services/driverAuditTransferCodec.js'))};
    const APP=${JSON.stringify(APP)}, names=${JSON.stringify(names)};
    const sha=b=>createHash('sha256').update(b).digest('hex'),encode=v=>Buffer.from(JSON.stringify(v));
    const stats=${stats.toString()},keys=generateKeyPairSync('rsa',{modulusLength:3072}),publicPem=keys.publicKey.export({type:'spki',format:'pem'});
    const fixture=${fixture.toString()},rawEntries=${rawEntries.toString()};
    for(const event of ['SIGTERM','SIGINT','SIGHUP']) {
      const cleanups=[],f=await fixture({after:callback=>cleanups.push(callback)});let reached=false;
      f.adapters.onPhase=async phase=>{if(phase==='after-rename'){reached=true;process.kill(process.pid,event);await new Promise(resolve=>setImmediate(resolve));}};
      try { await assert.rejects(f.run());assert(reached);const raw=await rawEntries(f);
        assert.equal(raw.length,1);assert(raw[0].body.equals(f.original.get(names[0])));
        const lease=await acquireWorkerLock(path.join(f.lockRoot,'operator.lock'));await lease.release();
        assert.equal(process.listenerCount(event),0);
      } finally {for(const cleanup of cleanups.reverse())await cleanup();}
    }
    process.stdout.write(JSON.stringify({signalsObserved:3,originalBytesPreserved:true,operatorLockReleased:true}));
  `;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { timeout: 18000, maxBuffer: 65536 });
  assert.deepEqual(JSON.parse(result.stdout), { signalsObserved: 3, originalBytesPreserved: true, operatorLockReleased: true }); assert.equal(result.stderr, '');
});

test('a complete temporary gzip is reused after interruption before finalize without a second compression', async t => {
  const f = await fixture(t, { mixed: true }), controller = new AbortController(); f.adapters.outputBudget = 200000; f.adapters.signal = controller.signal;
  let reached = false; f.adapters.onPhase = async phase => { if (!reached && phase === 'before-gzip-finalize') { reached = true; controller.abort(); } };
  await assert.rejects(f.run()); assert(reached); const folders = await fs.readdir(path.join(f.recovery, 'archives'));
  assert.equal(folders.length, 1); const folder = path.join(f.recovery, 'archives', folders[0]), before = await fs.readFile(path.join(folder, 'payload.partial'));
  assert(gunzipSync(before).equals(f.original.get(names[0]))); delete f.adapters.signal; delete f.adapters.onPhase;
  const metadata = opened(await f.run()); assert.equal(path.dirname(metadata.receipts[0].gzipPath), folder);
  assert((await fs.readFile(metadata.receipts[0].gzipPath)).equals(before));
  assert.equal((await fs.readdir(path.join(f.recovery, 'archives'))).filter(n => n.startsWith(names[0] + '.gzip-')).length, 1);
});

test('a substituted self-consistent gzip receipt must fail against the actual retained raw bytes on retry', async t => {
  const f = await fixture(t), controller = new AbortController(); f.adapters.signal = controller.signal;
  f.adapters.onPhase = async phase => { if (phase === 'verified-receipt') controller.abort(); }; await assert.rejects(f.run());
  delete f.adapters.signal; delete f.adapters.onPhase; const file = path.join(f.recovery, names[0] + '.verified.private.json');
  const receipt = JSON.parse(await fs.readFile(file)), different = Buffer.alloc(f.original.get(names[0]).length, 90), zipped = gzipSync(different);
  await fs.writeFile(receipt.gzipPath, zipped); Object.assign(receipt, { gzipStat: stats(await fs.stat(receipt.gzipPath, { bigint: true })),
    rawSha256: sha(different), rawBytes: different.length, gzipSha256: sha(zipped), gzipBytes: zipped.length });
  await fs.writeFile(file, encode(receipt)); await assert.rejects(f.run()); const raw = await rawEntries(f);
  assert.equal(raw.length, 1); assert(raw[0].body.equals(f.original.get(names[0])));
});

test('missing-raw retries reject changed release-intent and released records instead of trusting their existence', async t => {
  const cases = ['ready-shape', 'ready-intent', 'ready-census-sha', 'ready-process-sha', 'released-shape', 'released-receipt', 'original-stat-chain'];
  for (const kind of cases) {
    const f = await fixture(t); assert.equal((await f.run()).archivedLogs, 3);
    const ready = kind.startsWith('ready'), file = path.join(f.recovery, names[0] + (ready ? '.unlink-ready.private.json' : '.released.private.json'));
    let value = JSON.parse(await fs.readFile(file));
    if (kind.endsWith('shape')) value = { version: 1, unexpected: true };
    if (kind === 'ready-intent') value.intentSha256 = 'a'.repeat(64);
    if (kind === 'ready-census-sha') value.descriptorCensusSha256 = 'b'.repeat(64);
    if (kind === 'ready-process-sha') value.originalProcessesSha256 = 'c'.repeat(64);
    if (kind === 'released-receipt') value.verifiedReceiptSha256 = 'd'.repeat(64);
    if (kind === 'original-stat-chain') {
      const receiptPath = path.join(f.recovery, names[0] + '.verified.private.json'), receipt = JSON.parse(await fs.readFile(receiptPath));
      receipt.retiredRawStat.size = String(BigInt(receipt.retiredRawStat.size) + 1n); const receiptRaw = encode(receipt); await fs.writeFile(receiptPath, receiptRaw);
      const retirementPath = path.join(receipt.rawEntry, 'retired.private.json'), retirement = JSON.parse(await fs.readFile(retirementPath));
      retirement.rawStat = receipt.retiredRawStat; await fs.writeFile(retirementPath, encode(retirement));
      const readyPath = path.join(f.recovery, names[0] + '.unlink-ready.private.json'), readyValue = JSON.parse(await fs.readFile(readyPath));
      readyValue.rawStat = receipt.retiredRawStat; readyValue.verifiedReceiptSha256 = sha(receiptRaw); await fs.writeFile(readyPath, encode(readyValue));
      value.verifiedReceiptSha256 = sha(receiptRaw);
    }
    const changed = encode(value); await fs.writeFile(file, changed); await assert.rejects(f.run()); assert((await fs.readFile(file)).equals(changed));
  }
});

test('operator mutex files reject outside symlinks hardlinks and unsafe modes before SQLite or any log retirement', async t => {
  for (const kind of ['symlink', 'hardlink', 'writable']) {
    const f = await fixture(t), { DatabaseSync } = await import('node:sqlite'), outside = path.join(f.home, 'independent-private.sqlite');
    const db = new DatabaseSync(outside); db.exec('CREATE TABLE preserved (value TEXT); INSERT INTO preserved VALUES (\'independent data\');'); db.close();
    await fs.chmod(outside, 0o600); const before = await fs.readFile(outside), lock = path.join(f.lockRoot, 'operator.lock.sqlite');
    if (kind === 'symlink') await fs.symlink(outside, lock);
    if (kind === 'hardlink') await fs.link(outside, lock);
    if (kind === 'writable') { await fs.copyFile(outside, lock); await fs.chmod(lock, 0o664); }
    await assert.rejects(f.run()); assert((await fs.readFile(outside)).equals(before));
    for (const [name, body] of f.original) assert((await fs.readFile(path.join(f.logs, name))).equals(body));
    await assert.rejects(fs.access(f.recovery), { code: 'ENOENT' });
  }
});

test('interrupted streaming scratch retries under the same budget while independent or unbound scratch remains untouched', async t => {
  for (const kind of ['retry', 'independent-edit', 'unbound']) {
    const f = await fixture(t, { mixed: true }), controller = new AbortController(); f.adapters.outputBudget = 200000; f.adapters.signal = controller.signal;
    const open = fs.open; let interrupted = false, partialPath;
    fs.open = async (file, ...args) => { const fd = await open(file, ...args);
      if (!partialPath && String(file).endsWith('/payload.partial')) { partialPath = String(file); const write = fd.write.bind(fd); let bytes = 0;
        fd.write = async (...values) => { const result = await write(...values); bytes += result.bytesWritten;
          if (!interrupted && bytes >= 65536) { interrupted = true; controller.abort(); } return result; };
      } return fd;
    };
    try { await assert.rejects(f.run()); } finally { fs.open = open; }
    assert(interrupted); assert(partialPath);
    const partial = await fs.readFile(partialPath); assert.throws(() => gunzipSync(partial));
    const journalPath = path.join(path.dirname(partialPath), 'interrupted.private.json'), journal = await fs.readFile(journalPath);
    assert.equal(JSON.parse(journal).partialSha256, sha(partial)); delete f.adapters.signal;
    if (kind === 'independent-edit') await fs.appendFile(partialPath, 'independent derived data');
    if (kind === 'unbound') await fs.rename(journalPath, path.join(f.home, 'preserved-interruption.private.json'));
    if (kind === 'retry') {
      const metadata = opened(await f.run()); assert.equal(metadata.receipts.length, 3);
      assert((await fs.readFile(journalPath)).equals(journal)); await assert.rejects(fs.access(partialPath), { code: 'ENOENT' });
      for (const receipt of metadata.receipts) assert(gunzipSync(await fs.readFile(receipt.gzipPath)).equals(f.original.get(receipt.name)));
    } else {
      const before = await fs.readFile(partialPath); await assert.rejects(f.run()); assert((await fs.readFile(partialPath)).equals(before));
      assert((await rawEntries(f))[0].body.equals(f.original.get(names[0])));
    }
  }
});
