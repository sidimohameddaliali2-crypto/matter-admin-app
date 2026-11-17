import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { openTransferSecrets, sealTransferSecrets } from '../../server/services/driverAuditTransferCodec.js';
import * as canary from './driver-audit-supabase-canary.mjs';
import { acquireWorkerLock } from '../../server/vendor/driver-audits/integration/hosted/worker-lock.mjs';

const subject = await import('./driver-audit-supabase-canary-control.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
const recipientPublicKey = publicKey.export({ type: 'spki', format: 'pem' });
const main = Buffer.from('events {}\nhttp {\n    include /etc/nginx/sites-enabled/*;\n}\n');
const site = Buffer.from(`server {
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    location / {
        try_files $uri /index.html;
    }
    location /api/ {
        proxy_pass http://127.0.0.1:5000/api/;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
`);
const hashes = { main: sha(main), site: sha(site) };
const readiness = { version: 1, preparedReceiptSha256: '1'.repeat(64), codeSha256: '2'.repeat(64), workersSha256: '3'.repeat(64),
  listenerSha256: '4'.repeat(64), businessHealthy: true, sourceAbsent: true, syncStopped: true,
  reportHealth: { service: 'driver-reports', dataStore: 'supabase', executionHost: 'sidi', ready: true,
    generation: '5'.repeat(64), reportHash: '6'.repeat(64), collectorRevision: 5463, release: '4a00becfe4954b8139df6ac3c6058c2a592484d2' } };

function detail(result) {
  const capsule = openTransferSecrets(privateKey, result.capsule);
  const bytes = gunzipSync(Buffer.from(capsule.metadataGzipBase64, 'base64'));
  assert.equal(sha(bytes), result.metadataSha256);
  return JSON.parse(bytes);
}

async function rootFixture(t) {
  const folder = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canary-root-control-')));
  t.after(() => fs.rm(folder, { recursive: true, force: true })); await fs.chmod(folder, 0o700);
  const store = '/var/lib/matter-driver-reports-canary', fds = new Map();
  const local = name => {
    const fd = /^\/proc\/self\/fd\/(\d+)\/(.+)$/.exec(name);
    return fd ? path.join(fds.get(Number(fd[1])), fd[2]) : path.join(folder, name.slice(store.length));
  };
  let fileOpens = 0;
  const owned = stat => { stat.uid = typeof stat.uid === 'bigint' ? 0n : 0; return stat; };
  const io = {
    async lstat(name, options) { return owned(await fs.lstat(local(name), options)); },
    async realpath(name) { return store + path.relative(folder, await fs.realpath(local(name))).replace(/^([^/])/, '/$1'); },
    async open(name, ...args) {
      fileOpens++; const target = local(name), handle = await fs.open(target, ...args), stat = handle.stat.bind(handle), close = handle.close.bind(handle);
      if ((await stat()).isDirectory()) fds.set(handle.fd, target);
      const fd = handle.fd; handle.stat = async options => owned(await stat(options));
      handle.close = async () => { await close(); fds.delete(fd); }; return handle;
    },
  };
  let now = Date.parse('2026-11-17T15:00:00.000Z'), lock = false, backup;
  const files = { main: { bytes: Buffer.from(main), mode: 0o644 }, site: { bytes: Buffer.from(site), mode: 0o644 } };
  const calls = [];
  const executor = { hashes, now: () => now,
    async withLock(fn) { assert(!lock); lock = true; calls.push('lock'); try { return await fn(); } finally { lock = false; } },
    async read() { return Object.fromEntries(Object.entries(files).map(([name, value]) => [name, { ...value, sha256: sha(value.bytes), signature: sha(value.bytes) }])); },
    async backup(plan, mayCreate) { assert(lock); if (!backup) { assert(mayCreate); backup = { modes: { main: files.main.mode, site: files.site.mode }, backupSha256: sha(JSON.stringify(plan)) }; } return backup; },
    async replace(name, before, bytes, mode) { assert(lock); assert.equal(sha(files[name].bytes), before.sha256); files[name] = { bytes: Buffer.from(bytes), mode }; calls.push('replace'); },
    async test() { calls.push('nginx-test'); }, async reload() { calls.push('nginx-reload'); },
  };
  const api = { filesystem: io, uid: () => 0, platform: 'linux', nodeVersion: 'v22.23.4', nodeExecutable: '/usr/bin/node',
    now: () => now, moduleSha256: 'fcb260ebc47901fb3ea817a4da8f67df91262ec125cad4ad7c03a0db2481fcb2',
    createExecutor: () => executor, createPlan: value => canary.createDriverAuditSupabaseCanaryPlan(value, { hashes }),
    diff: canary.driverAuditSupabaseCanaryDiff, execute: canary.executeDriverAuditSupabaseCanary, seal: sealTransferSecrets };
  api.createPromotion = value => subject.createDriverAuditSupabasePromotionPlan(value, { verifyCanaryPlan: api.createPlan });
  api.executePromotion = subject.executeDriverAuditSupabasePromotion;
  return { folder, local, api, executor, files, calls, io, fileOpens: () => fileOpens, advance: value => { now += value; } };
}

test('the privileged stdin contains exactly the frozen reviewed source and no mutable root import', async () => {
  assert.equal(typeof subject.driverAuditSupabaseCanarySource, 'function');
  const bytes = subject.driverAuditSupabaseCanarySource();
  assert.deepEqual(bytes, await fs.readFile(fileURLToPath(new URL('./driver-audit-supabase-canary.mjs', import.meta.url))));
  assert.equal(sha(bytes), 'fcb260ebc47901fb3ea817a4da8f67df91262ec125cad4ad7c03a0db2481fcb2');
  const input = subject.driverAuditSupabaseCanaryRootInput({ operation: 'probe', recipientPublicKey });
  assert(input.subarray(0, bytes.length).equals(bytes));
  assert(!input.toString().includes("import('/")); assert(!input.toString().includes('NODE_OPTIONS'));
});

test('a root capability probe reads only fixed configuration and never creates state or reloads', async t => {
  const f = await rootFixture(t); assert.equal(typeof subject.runDriverAuditSupabaseCanaryRoot, 'function');
  const result = await subject.runDriverAuditSupabaseCanaryRoot({ operation: 'probe', recipientPublicKey }, f.api);
  assert.equal(result.readOnly, true); assert.equal(result.privilegeVerified, true);
  assert.equal(detail(result).nodeExecutable, '/usr/bin/node');
  assert.deepEqual(f.calls, []); assert.equal(f.fileOpens(), 0); assert.deepEqual(await fs.readdir(f.folder), []);
  assert(!JSON.stringify(result).includes(main.toString()));
});

test('root planning backs up originals and seals the private selector; apply uses only the root saved plan', async t => {
  const f = await rootFixture(t);
  const planned = await subject.runDriverAuditSupabaseCanaryRoot({ operation: 'plan', recipientPublicKey, readiness }, f.api);
  const saved = detail(planned); assert.equal(saved.readinessSha256, sha(JSON.stringify(readiness)));
  assert.equal(saved.plan.ttlSeconds, 600); assert(saved.diff.includes('/etc/nginx/nginx.conf'));
  assert(!JSON.stringify(planned).includes(saved.plan.selector));
  assert.equal(f.calls.filter(value => value === 'replace').length, 0);
  const file = f.local('/var/lib/matter-driver-reports-canary/control-' + planned.planSha256 + '.json');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const enabled = await subject.runDriverAuditSupabaseCanaryRoot({ operation: 'enable', recipientPublicKey, readiness,
    planSha256: planned.planSha256 }, f.api);
  assert.equal(enabled.routingChanged, true); assert.equal(enabled.defaultRoutingChanged, false);
  assert(f.files.site.bytes.includes(Buffer.from(saved.plan.entryPath)));
  f.advance(700000);
  await subject.runDriverAuditSupabaseCanaryRoot({ operation: 'seal-entry', recipientPublicKey, planSha256: planned.planSha256 }, f.api);
  assert(!f.files.site.bytes.includes(Buffer.from(saved.plan.entryPath)));
  await subject.runDriverAuditSupabaseCanaryRoot({ operation: 'restore', recipientPublicKey, planSha256: planned.planSha256 }, f.api);
  assert.deepEqual(f.files.main.bytes, main); assert.deepEqual(f.files.site.bytes, site);
});

test('readiness, recipient, saved plan drift and arbitrary payloads cannot become root routing mutations', async t => {
  const f = await rootFixture(t), planned = await subject.runDriverAuditSupabaseCanaryRoot({ operation: 'plan', recipientPublicKey, readiness }, f.api);
  const calls = f.calls.length;
  for (const input of [
    { operation: 'enable', recipientPublicKey, planSha256: planned.planSha256, readiness: { ...readiness, workersSha256: '0'.repeat(64) } },
    { operation: 'enable', recipientPublicKey, planSha256: '../escape', readiness },
    { operation: 'restore', recipientPublicKey, planSha256: planned.planSha256, command: 'anything' },
  ]) await assert.rejects(subject.runDriverAuditSupabaseCanaryRoot(input, f.api));
  assert.equal(f.calls.length, calls);
  const file = f.local('/var/lib/matter-driver-reports-canary/control-' + planned.planSha256 + '.json');
  await fs.chmod(file, 0o644);
  await assert.rejects(subject.runDriverAuditSupabaseCanaryRoot({ operation: 'enable', recipientPublicKey, readiness, planSha256: planned.planSha256 }, f.api));
  assert.equal(f.calls.length, calls);
});

test('host control rejects arbitrary commands, paths and incomplete input before any sudo invocation', async () => {
  assert.equal(typeof subject.runDriverAuditSupabaseCanaryControl, 'function');
  let commands = 0;
  for (const input of [undefined, {}, { operation: 'shell', command: 'anything' },
    { operation: 'probe', appRoot: '/fictional', expectedSha: 'a'.repeat(40), recipientPublicKey, command: 'anything' }]) {
    await assert.rejects(subject.runDriverAuditSupabaseCanaryControl(input, { rootCommand: async () => { commands++; } }));
  }
  assert.equal(commands, 0);
});

async function hostFixture(t, { latest = false } = {}) {
  const root = await rootFixture(t), appRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canary-host-control-')));
  t.after(() => fs.rm(appRoot, { recursive: true, force: true })); await fs.chmod(appRoot, 0o700);
  const p = { base: '701655794e1711b4d8c737e929360ecfe5d2f0ca', release: readiness.reportHealth.release,
    source: sha('{"files":[]}'), builder: sha('{"files":{}}'), baseline: '8'.repeat(64), candidate: '9'.repeat(64) };
  const base = path.join(appRoot, 'server'), releaseRoot = path.join(base, '.private/driver-report-app-releases', p.release), server = path.join(releaseRoot, 'server');
  const rootId = sha(JSON.stringify(['driver-reports-supabase-sync-v1', p.release, p.source, p.builder, p.baseline, p.candidate]));
  const syncRoot = path.join(server, '.private/driver-audits', rootId), sourceRoot = path.join(server, '.private/driver-audit-source');
  const write = async (file, bytes) => { await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await fs.writeFile(file, bytes, { mode: 0o600 }); };
  for (const tree of [base, server]) for (const suffix of ['.private/driver-report-supabase-handoff', '.private/driver-audit-source', '.private/driver-audits', '.private/driver-audit-heavy-work'])
    await fs.mkdir(path.join(tree, suffix), { recursive: true, mode: 0o700 });
  const oldSync = path.join(base, '.private/driver-audits', 'c'.repeat(64), 'sync.json'); await write(oldSync, '{}');
  const sourceConfig = path.join(sourceRoot, p.source, 'source.json');
  const receipt = { version: 1, kind: 'supabase-sidi-host-staging-receipt-v1', releaseSha: p.release, releaseRoot, rootId, syncRoot,
    syncConfig: path.join(syncRoot, 'sync.json'), sourceConfig, sourceManifestSha256: p.source, builderSha256: p.builder,
    nodeExecutable: '/usr/bin/node', nodeVersion: 'v22.23.4' };
  await write(path.join(syncRoot, 'staging.private.json'), JSON.stringify(receipt)); await write(receipt.syncConfig, '{}'); await write(sourceConfig, '{}');
  await write(path.join(sourceRoot, p.source, 'runtime/manifest.private.json'), '{"files":[]}');
  await write(path.join(syncRoot, 'builder/runtime-manifest.json'), '{"files":{}}');
  const pointerFile = path.join(syncRoot, 'work/current.private.json');
  const reportHealth = latest ? { ...readiness.reportHealth, collectorRevision: 5771 } : readiness.reportHealth;
  await write(pointerFile, JSON.stringify({ version: 1, generation: reportHealth.generation,
    reportHash: reportHealth.reportHash, collectorRevision: reportHealth.collectorRevision,
    manifestSha256: sha('actual latest manifest'), sourceBasis: sha('actual latest basis') }));
  const secret = 'fictional-private-environment-value-do-not-export';
  const rows = [
    { name: 'matter-delivery-api', pm_id: 1, pid: 111, pm2_env: { status: 'online', pm_cwd: appRoot, pm_exec_path: '/usr/bin/npm',
      args: ['start', '--prefix', 'server'], pm_uptime: 123, env: { FICTIONAL_SECRET: secret } } },
    { name: 'matter-driver-audit-sync', pm_id: 2, pid: 0, pm2_env: { status: 'stopped', pm_cwd: base, pm_exec_path: path.join(base, 'scripts/driverAuditSync.js'), args: ['--config', oldSync] } },
    { name: 'matter-driver-reports-api', pm_id: 3, pid: 333, pm2_env: { status: 'online', pm_cwd: server, pm_exec_path: path.join(server, 'scripts/driverAuditHttp.js'),
      exec_interpreter: '/usr/bin/node', args: [], node_args: [], pm_uptime: 234 } },
  ];
  const sudo = [], commands = [], urls = [], held = new Set(); let afterRoot;
  const adapters = { pins: p, platform: 'linux', uid: () => 1000,
    async executable(file) { assert(['/usr/bin/sudo', '/usr/bin/node'].includes(file)); return { path: file, uid: 0, mode: 0o100755, signature: '123' }; },
    async exec(file, args) {
      commands.push([file, args]);
      if (file === 'git') {
        const target = args[1];
        if (args.includes('HEAD')) return { stdout: (target === appRoot ? p.base : p.release) + '\n' };
        if (args.includes('--show-toplevel')) return { stdout: target + '\n' };
        return { stdout: '' };
      }
      assert.equal(file, 'pm2'); assert.deepEqual(args, ['jlist']); return { stdout: JSON.stringify(rows) };
    },
    async load(name) { assert.equal(name, 'vendor/driver-audits/integration/hosted/worker-lock.mjs'); return {
      async acquireWorkerLock(file) { const lease = await acquireWorkerLock(file); held.add(file); return {
        async release() { await lease.release(); held.delete(file); } }; } }; },
    async systemFile(file) { assert.equal(file, '/usr/bin/npm'); return { realpath: '/usr/share/nodejs/npm/bin/npm-cli.js', uid: 0, mode: 0o100755, sha256: 'a'.repeat(64) }; },
    async inspectProcess(row, folder) { assert.equal(row.pid, 333); assert.equal(folder, server); },
    async listenerFor(pid) { assert.equal(pid, 333); return { address: '0100007F:138A', uid: 1000, inode: '123', family: 'tcp' }; },
    async fetch(url, options) { urls.push(url); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
      return new Response(JSON.stringify(url.endsWith('/api/health') ? { database: 'connected' } : reportHealth), { status: 200 }); },
    async rootCommand(script) {
      const match = script.toString().match(/JSON\.parse\(Buffer\.from\(("[A-Za-z0-9+/=]+"), 'base64'\)\)/); assert(match);
      const input = JSON.parse(Buffer.from(JSON.parse(match[1]), 'base64')); sudo.push(input.operation);
      if (!['probe', 'restore'].includes(input.operation)) assert(held.size > 0);
      const result = await subject.runDriverAuditSupabaseCanaryRoot(input, root.api);
      await afterRoot?.(input.operation); return JSON.stringify(result);
    },
  };
  const basic = { appRoot, expectedSha: p.base, recipientPublicKey }, preparedReceiptSha256 = sha(JSON.stringify(receipt));
  const run = (operation, extra = {}) => subject.runDriverAuditSupabaseCanaryControl({ ...basic, operation,
    ...(operation === 'probe' ? {} : { preparedReceiptSha256 }), ...extra }, adapters);
  return { root, appRoot, p, server, base, syncRoot, sourceRoot, pointerFile, adapters, sudo, urls, commands, held, secret, rows, run, reportHealth,
    afterRoot(fn) { afterRoot = fn; } };
}

async function legacyEventGitFixture(t) {
  const f = await hostFixture(t), original = f.adapters.exec;
  const git = args => new Promise((resolve, reject) => childProcess.execFile('git', args, {
    cwd: f.appRoot, env: { PATH: process.env.PATH, HOME: f.appRoot, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    timeout: 10000, maxBuffer: 1024 * 1024,
  }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })));
  const write = async (name, bytes) => { const file = path.join(f.appRoot, name); await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await fs.writeFile(file, bytes, { mode: 0o600 }); return file; };
  await write('.gitignore', 'server/.private/\n');
  for (const name of ['server/package.json', 'server/package-lock.json', 'server/vendor/driver-audits/integration/hosted/worker-lock.mjs',
    'server/routes/events.js', 'server/models/Event.js']) await write(name, '// tracked fixture: never executed\n');
  await git(['init', '--initial-branch=main', f.appRoot]);
  await git(['config', 'user.email', 'fixture@example.invalid']); await git(['config', 'user.name', 'Local fixture']);
  await git(['add', '.gitignore', 'server/package.json', 'server/package-lock.json', 'server/vendor/driver-audits/integration/hosted/worker-lock.mjs', 'server/routes/events.js', 'server/models/Event.js']);
  await git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'Local canary fixture']);
  f.p.base = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const event = await write('server/routes/Event.js', 'globalThis.__canaryUntrackedEventExecuted = true; throw Error("Untracked file must never execute");\n');
  await fs.chmod(event, 0o664);
  f.adapters.exec = (file, args, options) => file === 'git' && args[1] === f.appRoot ? git(args) : original(file, args, options);
  const run = async (operation = 'probe', extra = {}) => subject.runDriverAuditSupabaseCanaryControl({ appRoot: f.appRoot,
    expectedSha: f.p.base, recipientPublicKey, operation,
    ...(operation === 'probe' ? {} : { preparedReceiptSha256: sha(await fs.readFile(path.join(f.syncRoot, 'staging.private.json'))) }), ...extra }, f.adapters);
  return { ...f, git, event, run, original };
}

test('real Git admits only the exact legacy untracked Event file and preserves every byte and file identity without executing it', async t => {
  const f = await legacyEventGitFixture(t), before = await fs.lstat(f.event, { bigint: true }), bytes = await fs.readFile(f.event);
  assert.equal((await f.git(['status', '--porcelain', '--untracked-files=all', '--', 'server'])).stdout, '?? server/routes/Event.js\n');
  const result = await f.run(); assert.equal(result.readOnly, true); assert.deepEqual(f.sudo, ['probe']);
  const after = await fs.lstat(f.event, { bigint: true });
  for (const key of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(after[key], before[key]);
  assert.deepEqual(await fs.readFile(f.event), bytes); assert.equal(globalThis.__canaryUntrackedEventExecuted, undefined);
  assert.equal((await f.git(['rev-parse', 'HEAD'])).stdout.trim(), f.p.base);
});

test('real Git unknown files or tracked changes cannot hide behind the exact legacy Event exception', async t => {
  for (const name of ['server/routes/Other.js', 'server/routes/events.js']) {
    const f = await legacyEventGitFixture(t), before = await fs.readFile(f.event);
    await fs.writeFile(path.join(f.appRoot, name), 'independent local edit\n', { mode: 0o600 });
    await assert.rejects(f.run(), /Supabase canary control stopped at checkout/);
    assert.deepEqual(await fs.readFile(f.event), before); assert.equal(await fs.readFile(path.join(f.appRoot, name), 'utf8'), 'independent local edit\n');
    assert.equal(f.sudo.length, 0);
  }
});

test('legacy Event changes during the read-only probe stop admission and preserve the independent edit', async t => {
  const f = await legacyEventGitFixture(t); f.afterRoot(async operation => { if (operation === 'probe') await fs.appendFile(f.event, '// independent later edit\n'); });
  await assert.rejects(f.run(), /Supabase canary control stopped/);
  assert((await fs.readFile(f.event, 'utf8')).endsWith('// independent later edit\n')); assert.deepEqual(f.sudo, ['probe']);
  assert.equal(f.urls.length, 0); assert.equal(globalThis.__canaryUntrackedEventExecuted, undefined);
});

test('an initially clean base cannot acquire a newly introduced Event exception during the operation', async t => {
  const f = await legacyEventGitFixture(t), bytes = await fs.readFile(f.event); await fs.unlink(f.event);
  f.afterRoot(async operation => { if (operation === 'probe') await fs.writeFile(f.event, bytes, { mode: 0o600 }); });
  await assert.rejects(f.run(), /Supabase canary control stopped/);
  assert.deepEqual(await fs.readFile(f.event), bytes); assert.deepEqual(f.sudo, ['probe']); assert.equal(f.urls.length, 0);
});

test('a legacy Event parent directory identity change rejects while preserving the unchanged source leaf', async t => {
  const f = await legacyEventGitFixture(t), before = await fs.lstat(f.event, { bigint: true }), bytes = await fs.readFile(f.event);
  f.afterRoot(async operation => { if (operation === 'probe') await fs.chmod(path.dirname(f.event), 0o775); });
  await assert.rejects(f.run(), /Supabase canary control stopped/);
  assert.deepEqual(await fs.readFile(f.event), bytes); const after = await fs.lstat(f.event, { bigint: true });
  for (const key of ['ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(after[key], before[key]);
  assert.equal((await fs.stat(path.dirname(f.event))).mode & 0o777, 0o775); assert.deepEqual(f.sudo, ['probe']);
});

test('a legacy Event path swap at FD open fails without reading or modifying the outside file', async t => {
  const f = await legacyEventGitFixture(t), outside = path.join(f.appRoot, 'outside.private.txt'), open = fs.open;
  await fs.writeFile(outside, 'outside untouched\n', { mode: 0o600 }); const before = await fs.lstat(outside, { bigint: true });
  let reached = false, outsideReads = 0;
  fs.open = async (file, ...args) => {
    if (file === outside) outsideReads++;
    const fd = await open(file, ...args);
    if (file === f.event && !reached) { reached = true; await fs.rename(f.event, f.event + '.preserved'); await fs.symlink(outside, f.event); }
    return fd;
  };
  try { await assert.rejects(f.run(), /Supabase canary control stopped at checkout/); } finally { fs.open = open; }
  assert(reached); assert.equal(outsideReads, 0); assert.equal(f.sudo.length, 0);
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside untouched\n');
  const after = await fs.lstat(outside, { bigint: true }); for (const key of ['ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(after[key], before[key]);
});

test('the exact Event path is rejected as a symlink, hardlink, executable, special-mode or oversized file without alteration', async t => {
  for (const kind of ['symlink', 'hardlink', 'executable', 'special-mode', 'oversized']) {
    const f = await legacyEventGitFixture(t), outside = path.join(f.appRoot, 'outside.private.txt'); await fs.writeFile(outside, 'outside untouched\n', { mode: 0o600 });
    if (kind === 'symlink' || kind === 'hardlink') { await fs.unlink(f.event); await fs[kind === 'symlink' ? 'symlink' : 'link'](outside, f.event); }
    if (kind === 'executable') await fs.chmod(f.event, 0o755);
    if (kind === 'special-mode') { await fs.chmod(f.event, 0o4600); assert.equal((await fs.stat(f.event)).mode & 0o7777, 0o4600); }
    if (kind === 'oversized') await fs.writeFile(f.event, Buffer.alloc(512 * 1024 + 1, 97));
    await assert.rejects(f.run(), /Supabase canary control stopped at checkout/);
    assert.equal(await fs.readFile(outside, 'utf8'), 'outside untouched\n'); assert.equal(f.sudo.length, 0);
  }
});

test('the isolated release still rejects the same exact Event path', async t => {
  const f = await hostFixture(t), original = f.adapters.exec;
  await fs.mkdir(path.join(f.base, 'routes'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(f.base, 'routes/Event.js'), '// preserved legacy fixture\n', { mode: 0o600 });
  f.adapters.exec = async (file, args, options) => file === 'git' && args.includes('--porcelain')
    ? { stdout: '?? server/routes/Event.js\n' } : original(file, args, options);
  await assert.rejects(f.run('plan'), /Supabase canary control stopped at prepared-host/);
  assert.deepEqual(f.sudo, ['probe']); assert.equal(f.urls.length, 0);
});

test('the host probes first, checks only loopback health and keeps an owner-private sealed handshake', async t => {
  const f = await hostFixture(t);
  const probe = await f.run('probe'); assert.equal(probe.readOnly, true); assert.deepEqual(f.sudo, ['probe']);
  assert.equal(f.urls.length, 0); assert.equal(f.held.size, 0);
  const planned = await f.run('plan'); assert.deepEqual(f.sudo, ['probe', 'probe', 'plan']);
  assert.equal(planned.routingChanged, false); assert.equal(planned.liveBrowserVerified, false);
  assert.equal(f.held.size, 0); assert(f.urls.every(url => ['http://127.0.0.1:5000/api/health', 'http://127.0.0.1:5002/health'].includes(url)));
  const result = detail(planned); assert(!JSON.stringify(result).includes(f.secret));
  const folder = path.join(f.base, '.private/driver-report-supabase-handoff/canary'), files = await fs.readdir(folder);
  assert.equal(files.length, 1); const file = path.join(folder, files[0]);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600); assert.equal(sha(await fs.readFile(file)), planned.handshakeSha256);
  assert(!JSON.stringify(planned).includes(result.plan.selector)); assert(!JSON.stringify(planned).includes(f.secret));
  await f.run('enable', { planSha256: planned.planSha256 });
  await f.run('seal-entry', { planSha256: planned.planSha256 });
  await f.run('restore', { planSha256: planned.planSha256 });
  assert.equal(f.held.size, 0); assert(f.commands.every(([file, args]) => file === 'git' || file === 'pm2' && JSON.stringify(args) === '["jlist"]'));
});

test('a failed initial checkout retains the same guard and returns only bounded RSA-sealed read-only Git diagnostics', async t => {
  const f = await hostFixture(t), original = f.adapters.exec;
  const secret = 'fictional-private-git-detail/https://never-export.invalid/credential';
  f.adapters.exec = async (file, args, options) => {
    if (file === 'git' && args.includes('--porcelain')) {
      assert.equal(options.cwd, f.appRoot); return { stdout: ' M server/' + secret + '\n', stderr: '' };
    }
    return original(file, args, options);
  };
  let failure; await assert.rejects(f.run('probe'), error => { failure = error; return error.phase === 'checkout'; });
  const receipt = failure.supabaseControlStopped; assert(receipt);
  assert.deepEqual(Object.keys(receipt).sort(), ['status', 'applicationCommit', 'operatorPhase', 'metadataSha256', 'capsule'].sort());
  assert.equal(receipt.status, 'supabase-control-stopped'); assert.equal(receipt.operatorPhase, 'checkout');
  assert(!JSON.stringify(failure).includes(secret)); assert(!JSON.stringify(receipt).includes(secret));
  const capsule = openTransferSecrets(privateKey, receipt.capsule);
  assert.equal(capsule.kind, 'supabase-canary-checkout-failure-capsule-v1');
  const packed = Buffer.from(capsule.metadataGzipBase64, 'base64'); assert.equal(sha(packed), capsule.metadataGzipSha256);
  const raw = gunzipSync(packed, { maxOutputLength: 24 * 1024 });
  assert.equal(sha(raw), capsule.metadataSha256); assert.equal(sha(raw), receipt.metadataSha256);
  const metadata = JSON.parse(raw);
  assert.equal(metadata.kind, 'supabase-canary-checkout-first-failure-v1'); assert.equal(metadata.operatorPhase, 'checkout');
  assert.equal(metadata.failedStep, 'server-status'); assert.equal(metadata.repositoryRole, 'base');
  assert.equal(metadata.acceptedAsVerified, false); assert.equal(metadata.routingChanged, false);
  assert.equal(metadata.sourceStarted, false); assert.equal(metadata.readOnly, true);
  assert.deepEqual(metadata.commands.map(row => row.step), ['head', 'toplevel', 'tracked-code', 'server-status', 'server-diffstat']);
  assert(metadata.commands.find(row => row.step === 'server-status').stdout.includes(secret));
  assert(metadata.commands.every(row => Buffer.byteLength(row.stdout) <= 2048 && Buffer.byteLength(row.stderr) <= 2048));
  assert.equal(f.sudo.length, 0); assert.equal(f.urls.length, 0); assert.equal(f.held.size, 0);
  const { driverAuditSupabaseControlStoppedReceipt } = await import('./driver-audit-native-handoff.mjs');
  assert.deepEqual(driverAuditSupabaseControlStoppedReceipt(receipt, f.p.base, 'checkout'), receipt);
});

test('checkout command errors and oversized diagnostic output stay encrypted, bounded and unable to admit a probe', async t => {
  const f = await hostFixture(t), original = f.adapters.exec, secret = 'fictional-raw-git-error-private-value';
  f.adapters.exec = async (file, args, options) => {
    if (file === 'git' && args.includes('HEAD') && !args.includes('--no-optional-locks')) {
      throw Object.assign(Error(secret), { code: 128, stdout: secret.repeat(1000), stderr: secret.repeat(1000) });
    }
    if (file === 'git' && args.includes('--no-optional-locks')) return { stdout: Buffer.alloc(10000, 0xff), stderr: secret.repeat(1000) };
    return original(file, args, options);
  };
  let failure; await assert.rejects(f.run('probe'), error => { failure = error; return error.phase === 'checkout'; });
  const receipt = failure.supabaseControlStopped; assert(receipt); assert(!JSON.stringify(failure).includes(secret));
  const value = openTransferSecrets(privateKey, receipt.capsule), packed = Buffer.from(value.metadataGzipBase64, 'base64');
  const raw = gunzipSync(packed, { maxOutputLength: 24 * 1024 }), metadata = JSON.parse(raw);
  assert.equal(metadata.failedStep, 'head'); assert(metadata.commands.every(row => row.stdoutTruncated && row.stderrTruncated));
  assert(metadata.commands.every(row => Buffer.byteLength(row.stdout) <= 2048 && Buffer.byteLength(row.stderr) <= 2048));
  assert(raw.length <= 24 * 1024); assert.equal(f.sudo.length, 0); assert.equal(f.urls.length, 0);
});

test('a failed read-only privilege probe prevents readiness reads, file writes and any mutation attempt', async t => {
  const f = await hostFixture(t), before = await fs.readdir(path.join(f.base, '.private/driver-report-supabase-handoff'));
  f.adapters.rootCommand = async () => { throw Error('fictional sudo diagnostic ' + f.secret); };
  await assert.rejects(f.run('plan'), error => error.phase === 'privilege-probe' && !JSON.stringify(error).includes(f.secret));
  assert.equal(f.urls.length, 0); assert.equal(f.held.size, 0);
  assert.deepEqual(await fs.readdir(path.join(f.base, '.private/driver-report-supabase-handoff')), before);
});

function openedPrivilegeFailure(failure) {
  const receipt = failure.supabaseControlStopped; assert(receipt);
  assert.deepEqual(Object.keys(receipt).sort(), ['status', 'applicationCommit', 'operatorPhase', 'metadataSha256', 'capsule'].sort());
  assert.equal(receipt.operatorPhase, 'privilege-probe'); const capsule = openTransferSecrets(privateKey, receipt.capsule);
  assert.equal(capsule.kind, 'supabase-canary-privilege-failure-capsule-v1');
  const packed = Buffer.from(capsule.metadataGzipBase64, 'base64'); assert.equal(sha(packed), capsule.metadataGzipSha256);
  const raw = gunzipSync(packed, { maxOutputLength: 32 * 1024 }); assert.equal(sha(raw), receipt.metadataSha256);
  const metadata = JSON.parse(raw); assert.equal(metadata.kind, 'supabase-canary-privilege-first-failure-v1');
  assert.equal(metadata.readOnly, true); assert.equal(metadata.acceptedAsVerified, false); assert.equal(metadata.guardChanged, false);
  return { receipt, metadata, raw };
}

test('a privilege-probe exception retains its private cause only in the bounded encrypted first-failure capsule', async t => {
  const f = await hostFixture(t), before = await fs.readdir(path.join(f.base, '.private/driver-report-supabase-handoff'));
  f.adapters.rootCommand = async () => { throw Object.assign(Error('fictional sudo cause ' + f.secret), { code: 'EACCES' }); };
  let error; await assert.rejects(f.run('probe'), e => { error = e; return e.phase === 'privilege-probe'; });
  const { receipt, metadata } = openedPrivilegeFailure(error);
  assert(metadata.cause.message.includes(f.secret)); assert.equal(metadata.cause.code, 'EACCES');
  assert.deepEqual(metadata.executableChecks.map(row => row.path), ['/usr/bin/sudo', '/usr/bin/node']);
  assert(!JSON.stringify(error).includes(f.secret)); assert(!JSON.stringify(receipt).includes(f.secret));
  assert.equal(f.urls.length, 0); assert.deepEqual(await fs.readdir(path.join(f.base, '.private/driver-report-supabase-handoff')), before);
});

test('a rejected fixed executable identity is reported privately before any privileged process is spawned', async t => {
  const f = await hostFixture(t); f.adapters.executable = async file => ({ path: file, uid: 1000, mode: 0o100775, signature: 'fictional wrong owner' });
  let error; await assert.rejects(f.run('probe'), e => { error = e; return e.phase === 'privilege-probe'; });
  const { metadata } = openedPrivilegeFailure(error); assert.equal(metadata.executableChecks[0].observed.uid, 1000);
  assert.equal(metadata.executableChecks[0].guardAccepted, false); assert.deepEqual(f.sudo, []); assert.equal(f.urls.length, 0);
});

test('a source writer, running sync, broad listener or wrong report identity blocks canary planning', async t => {
  for (const mutate of [
    f => f.rows.push({ name: 'matter-driver-audit-source' }),
    f => { f.rows[1].pid = 222; f.rows[1].pm2_env.status = 'online'; },
    f => { f.adapters.listenerFor = async () => { throw Error('Broad listener'); }; },
    f => { f.adapters.fetch = async () => new Response('{}', { status: 503 }); },
    f => { f.rows[2].pm2_env.pm_exec_path = '/unreviewed/script'; },
  ]) {
    const f = await hostFixture(t); mutate(f);
    await assert.rejects(f.run('plan')); assert.deepEqual(f.sudo, ['probe']); assert.equal(f.held.size, 0);
  }
});

test('drift after a genuine routing change requests an exact saved-plan rollback without touching business workers', async t => {
  const f = await hostFixture(t), planned = await f.run('plan');
  f.afterRoot(operation => { if (operation === 'enable') f.rows[0].pid++; });
  await assert.rejects(f.run('enable', { planSha256: planned.planSha256 }), error => error.phase === 'readback' && error.rollbackRestored === true);
  assert.deepEqual(f.sudo.slice(-3), ['probe', 'enable', 'restore']);
  assert.deepEqual(f.root.files.main.bytes, main); assert.deepEqual(f.root.files.site.bytes, site); assert.equal(f.held.size, 0);
  assert(!f.commands.some(([file, args]) => file === 'pm2' && args[0] !== 'jlist'));
});

test('a writable privileged executable is rejected before even the read-only sudo probe', async t => {
  const f = await hostFixture(t); f.adapters.executable = async file => ({ path: file, uid: 1000, mode: 0o100775, signature: '123' });
  await assert.rejects(f.run('probe')); assert.deepEqual(f.sudo, []);
});

test('the actual transport uses only fixed sudo/node arguments, clean environment and verified stdin', async t => {
  const f = await hostFixture(t), original = childProcess.spawn;
  delete f.adapters.rootCommand; let seen = false;
  childProcess.spawn = (file, args, options) => {
    seen = true; assert.equal(file, '/usr/bin/sudo'); assert.deepEqual(args, ['-n', '--', '/usr/bin/node', '--input-type=module', '-']);
    assert.equal(options.cwd, '/'); assert.deepEqual(options.env, { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' });
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    const pieces = []; child.stdin.on('data', bytes => pieces.push(bytes)); child.stdin.on('finish', () => {
      const script = Buffer.concat(pieces); assert(script.subarray(0, subject.driverAuditSupabaseCanarySource().length).equals(subject.driverAuditSupabaseCanarySource()));
      subject.runDriverAuditSupabaseCanaryRoot({ operation: 'probe', recipientPublicKey }, f.root.api).then(result => {
        child.stdout.end(JSON.stringify(result)); child.stderr.end(); child.emit('close', 0);
      }).catch(error => { child.emit('error', error); child.emit('close', 1); });
    }); return child;
  };
  syncBuiltinESMExports();
  try { const result = await f.run('probe'); assert(result.privilegeVerified); assert(seen); }
  finally { childProcess.spawn = original; syncBuiltinESMExports(); }
});

test('privilege transport failures never return raw stderr or continue to readiness', async t => {
  const f = await hostFixture(t), original = childProcess.spawn; delete f.adapters.rootCommand;
  childProcess.spawn = () => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    child.stdin.on('finish', () => { child.stderr.end(f.secret); child.stdout.end(); child.emit('close', 1); }); return child;
  };
  syncBuiltinESMExports();
  try { await assert.rejects(f.run('plan'), error => error.phase === 'privilege-probe' && !JSON.stringify(error).includes(f.secret)); assert.equal(f.urls.length, 0); }
  finally { childProcess.spawn = original; syncBuiltinESMExports(); }
});

test('actual privilege transport seals bounded stderr/stdout and exit facts while retaining fixed sudo arguments and waiting for close', async t => {
  const f = await hostFixture(t), original = childProcess.spawn; delete f.adapters.rootCommand;
  let closed = false;
  childProcess.spawn = (file, args, options) => {
    assert.equal(file, '/usr/bin/sudo'); assert.deepEqual(args, ['-n', '--', '/usr/bin/node', '--input-type=module', '-']);
    assert.deepEqual(options.env, { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' });
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    child.stdin.on('finish', () => { child.stdout.end('local private stdout ' + f.secret); child.stderr.end((f.secret + '\n').repeat(10000));
      setTimeout(() => { closed = true; child.emit('close', 1, null); }, 10); }); return child;
  }; syncBuiltinESMExports();
  let error; try { await assert.rejects(f.run('probe'), e => { error = e; return e.phase === 'privilege-probe'; }); }
  finally { childProcess.spawn = original; syncBuiltinESMExports(); }
  assert(closed); const { receipt, metadata } = openedPrivilegeFailure(error);
  assert.equal(metadata.transport.exitCode, 1); assert.equal(metadata.transport.signal, null);
  assert(metadata.transport.stderr.includes(f.secret)); assert(metadata.transport.stderrTruncated);
  assert(Buffer.byteLength(metadata.transport.stderr) <= 4096); assert(metadata.transport.stderrBytes > 4096);
  assert(metadata.transport.stdout.includes(f.secret)); assert(!JSON.stringify(receipt).includes(f.secret)); assert.equal(f.urls.length, 0);
});

test('a malformed successful local privileged response remains a stopped operation and is only retained inside encryption', async t => {
  const f = await hostFixture(t); f.adapters.rootCommand = async () => 'not-json-' + f.secret;
  let error; await assert.rejects(f.run('probe'), e => { error = e; return e.phase === 'privilege-probe'; });
  const { receipt, metadata } = openedPrivilegeFailure(error); assert(metadata.rootResponse.stdout.includes(f.secret));
  assert(!JSON.stringify(receipt).includes(f.secret)); assert.equal(f.urls.length, 0);
});

test('oversized local privileged output still stops at the original cap and records its close signal privately', async t => {
  const f = await hostFixture(t), original = childProcess.spawn; delete f.adapters.rootCommand; let kills = 0, closed = false;
  childProcess.spawn = () => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = signal => { assert.equal(signal, 'SIGTERM'); kills++; setImmediate(() => { closed = true; child.emit('close', null, 'SIGTERM'); }); return true; };
    child.stdin.on('finish', () => { child.stderr.end(f.secret + '\0'.repeat(10000)); child.stdout.end(Buffer.alloc(128 * 1024 + 1, 0)); }); return child;
  }; syncBuiltinESMExports();
  let error; try { await assert.rejects(f.run('probe'), e => { error = e; return e.phase === 'privilege-probe'; }); }
  finally { childProcess.spawn = original; syncBuiltinESMExports(); }
  assert(closed); assert.equal(kills, 1); const { receipt, metadata, raw } = openedPrivilegeFailure(error);
  assert(raw.length <= 32 * 1024); assert.equal(metadata.transport.exitCode, null); assert.equal(metadata.transport.signal, 'SIGTERM');
  assert.equal(metadata.transport.reason, 'stdout-limit'); assert.equal(metadata.transport.stdoutBytes, 128 * 1024 + 1);
  assert(metadata.transport.stdoutTruncated); assert(!JSON.stringify(receipt).includes(f.secret)); assert.equal(f.urls.length, 0);
});

test('the real generated root catch keeps its bounded cause in the local pipe and emits only a static stderr message', () => {
  const result = childProcess.spawnSync(process.execPath, ['--input-type=module', '-'], {
    input: subject.driverAuditSupabaseCanaryRootInput({ operation: 'fixture-invalid-operation', recipientPublicKey }),
    env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 10000, maxBuffer: 32 * 1024,
  });
  assert.equal(result.status, 1); assert.equal(result.stderr, 'Canary privileged command stopped\n');
  const local = JSON.parse(result.stdout); assert.equal(local.kind, 'supabase-canary-root-local-failure-v1');
  assert.equal(typeof local.cause.message, 'string'); assert(local.cause.stack.length > 0); assert(Buffer.byteLength(result.stdout) <= 4096);
});

test('the exact generated privileged program parses as ESM without running any root operation', () => {
  const result = childProcess.spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: subject.driverAuditSupabaseCanaryRootInput({ operation: 'probe', recipientPublicKey }), encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
});

test('an npm identity change during enable fails readback and restores only the exact canary configuration', async t => {
  const f = await hostFixture(t), planned = await f.run('plan'), original = f.adapters.systemFile;
  let changed = false;
  f.adapters.systemFile = async file => ({ ...await original(file), sha256: (changed ? 'b' : 'a').repeat(64) });
  f.afterRoot(operation => { if (operation === 'enable') changed = true; });
  await assert.rejects(f.run('enable', { planSha256: planned.planSha256 }), error => error.rollbackRestored === true);
  assert.deepEqual(f.root.files.main.bytes, main); assert.equal(f.held.size, 0);
});

test('actual source exclusion stays held through privileged execution and is released after readback', async t => {
  const f = await hostFixture(t), planned = await f.run('plan'), file = path.join(f.sourceRoot, 'source-worker.lock'); let reached = false;
  f.afterRoot(async operation => { if (operation === 'enable') { reached = true; await assert.rejects(acquireWorkerLock(file), /Collector already active/); } });
  await f.run('enable', { planSha256: planned.planSha256 }); assert(reached);
  const lock = await acquireWorkerLock(file); await lock.release();
});

test('unexpected root plaintext fields are refused without exposing them or admitting a plan', async t => {
  const f = await hostFixture(t), original = f.adapters.rootCommand;
  f.adapters.rootCommand = async input => JSON.stringify({ ...JSON.parse(await original(input)), plaintext: f.secret });
  await assert.rejects(f.run('plan'), error => error.phase === 'privilege-probe' && !JSON.stringify(error).includes(f.secret));
  assert.equal(f.urls.length, 0); assert.equal(f.held.size, 0);
});

test('real signal child: the in-flight privileged operation keeps parent exclusion until close and restore',
  { skip: !['1', 'promote'].includes(process.env.DRIVER_AUDIT_CANARY_SIGNAL_CHILD) }, async t => {
    const promoting = process.env.DRIVER_AUDIT_CANARY_SIGNAL_CHILD === 'promote';
    const f = promoting ? await hostPromotionFixture(t) : await hostFixture(t), planned = promoting ? f.planned : await f.run('plan');
    const original = f.adapters.rootCommand; let reached = false;
    f.adapters.rootCommand = async script => {
      const match = script.toString().match(/JSON\.parse\(Buffer\.from\(("[A-Za-z0-9+/=]+"), 'base64'\)\)/);
      const input = JSON.parse(Buffer.from(JSON.parse(match[1]), 'base64'));
      if (input.operation === (promoting ? 'promote' : 'enable')) {
        reached = true; process.stdout.write('CANARY_ROOT_INFLIGHT:' + process.pid + '\n');
        await new Promise(resolve => setTimeout(resolve, 400));
        assert(f.held.size > 0, 'Parent exclusion must survive SIGTERM until privileged close');
        await assert.rejects(acquireWorkerLock(path.join(f.sourceRoot, 'source-worker.lock')), /Collector already active/);
      }
      if (input.operation === (promoting ? 'rollback-promotion' : 'restore') && reached) {
        process.stdout.write('CANARY_RESTORE_INFLIGHT:' + process.pid + '\n');
        await new Promise(resolve => setTimeout(resolve, 100)); assert(f.held.size > 0);
      }
      return original(script);
    };
    await assert.rejects(promoting ? f.promote() : f.run('enable', { planSha256: planned.planSha256 }), error => error.phase === 'cancelled' && error.rollbackRestored === true);
    const expected = promoting ? detail(planned).plan.sealed : { main: main.toString('base64'), site: site.toString('base64') };
    assert(reached); assert.equal(f.held.size, 0); for (const name of ['main', 'site']) assert.deepEqual(f.root.files[name].bytes, Buffer.from(expected[name], 'base64'));
    process.stdout.write('CANARY_SIGNAL_SAFE\n');
  });

test('a real SIGTERM cannot release parent worker locks while its privileged child is still in flight', async () => {
  for (const mode of ['1', 'promote']) {
  const child = childProcess.spawn(process.execPath, ['--test', '--test-name-pattern=real signal child:', fileURLToPath(import.meta.url)], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DRIVER_AUDIT_CANARY_SIGNAL_CHILD: mode }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', sent = false, repeated = false;
  child.stdout.on('data', bytes => { output += bytes; const match = /CANARY_ROOT_INFLIGHT:(\d+)\n/.exec(output);
    if (!sent && match) { sent = true; process.kill(Number(match[1]), 'SIGTERM'); }
    const restoring = /CANARY_RESTORE_INFLIGHT:(\d+)\n/.exec(output);
    if (!repeated && restoring) { repeated = true; process.kill(Number(restoring[1]), 'SIGINT'); process.kill(Number(restoring[1]), 'SIGHUP'); } });
  child.stderr.on('data', bytes => { output += bytes; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  clearTimeout(timer); assert(sent && repeated); assert.equal(result.signal, null, output); assert.equal(result.code, 0, output); assert(output.includes('CANARY_SIGNAL_SAFE'));
  }
});

test('cancellation during awaited final cleanup cannot return success and preserves existing signal handlers', async t => {
  const f = await hostFixture(t), planned = await f.run('plan'), stop = new AbortController(), original = f.adapters.load;
  const marker = () => {}; process.on('SIGHUP', marker);
  const before = Object.fromEntries(['SIGTERM', 'SIGINT', 'SIGHUP'].map(event => [event, process.listeners(event)]));
  f.adapters.signal = stop.signal;
  f.adapters.load = async name => {
    const module = await original(name); return { async acquireWorkerLock(file) {
      const lease = await module.acquireWorkerLock(file); return { async release() {
        await lease.release(); if (file.endsWith('/operator.lock')) stop.abort();
      } };
    } };
  };
  try {
    await assert.rejects(f.run('enable', { planSha256: planned.planSha256 }), error => error.phase === 'cancelled' && error.rollbackRestored === true);
    for (const event of Object.keys(before)) assert.deepEqual(process.listeners(event), before[event]);
    assert.deepEqual(f.root.files.site.bytes, site); assert.equal(f.held.size, 0);
  } finally { process.off('SIGHUP', marker); }
});

function acceptanceFixture(plan, currentReadiness, handshake) {
  const current = { collectorRevision: 5771, generation: currentReadiness.reportHealth.generation, reportHash: currentReadiness.reportHealth.reportHash,
    manifestSha256: sha('actual latest manifest'), sourceBasis: sha('actual latest basis') };
  const previous = { collectorRevision: 5463, generation: '15d10c15a4e3ca405ba8a39b328f14023be977e91cc3ee003622d6c086da8709',
    reportHash: sha('actual previous report'), manifestSha256: '3ac4484fe65910ce356eee487e8ebe4a50b0f52e64d81e892fb2c4b1ea8325c2', sourceBasis: sha('actual previous basis') };
  const proof = value => ({ manifestSha256: value.manifestSha256, businessSha256: sha('business-' + value.generation),
    gpsSha256: sha('gps-' + value.generation), photosSha256: sha('photos-' + value.generation), historySha256: sha('history-' + value.generation) });
  return { version: 1, kind: 'supabase-browser-canary-acceptance-v1', planSha256: plan.planSha256,
    preparedReceiptSha256: currentReadiness.preparedReceiptSha256, applicationCommit: '701655794e1711b4d8c737e929360ecfe5d2f0ca',
    releaseCommit: '4a00becfe4954b8139df6ac3c6058c2a592484d2', checkedAt: '2026-11-17T15:00:00.000Z', current, previous,
    host: { repository: 'fictional/report-app', runId: 101, jobId: 102, workflowCommit: 'a'.repeat(40), operatorSha256: sha('operator'),
      jobSha256: sha('actual raw job'), logSha256: sha('actual raw log'), handshakeSha256: sha(handshake),
      envelopeSha256: sha(JSON.stringify(JSON.parse(handshake).root)), metadataSha256: JSON.parse(handshake).root.metadataSha256,
      operation: 'seal-entry', status: 'completed', conclusion: 'success', completedAt: '2026-11-17T15:00:00.000Z' },
    browser: { kind: 'authenticated-own-staff-browser', receiptSha256: sha('actual private browser receipt'), checkedAt: '2026-11-17T15:00:00.000Z',
      generation: current.generation, reportHash: current.reportHash,
      checks: Object.fromEntries(['business', 'gps', 'photos', 'reviews'].map(name => [name, { status: 'passed', evidenceSha256: sha('actual browser-' + name) }])) },
    packages: { kind: 'supabase-original-package-byte-comparison-v1', receiptSha256: sha('actual package comparison'), current: proof(current), previous: proof(previous) },
    sourceHeads: { 'collector-state': { revision: 5771, bodySha256: '836c9507dd7704b40c876bf050e55fe487cddfc124b6a38f4f4af87993f5ad62' },
      ...Object.fromEntries(['review-journal', 'preview-gps-map-20261106:review-journal',
        'preview-acceptance-gps-final-20261111:review-journal', 'preview-acceptance-gps-hosted-20261109:review-journal',
        'preview-acceptance-hosted-20261109:review-journal', 'preview-acceptance-household-20261109:review-journal',
        'preview-acceptance-reconcile-20261109:review-journal'].map((name, i) => [name, { revision: i + 1, bodySha256: sha('review-' + i) }])) },
    sourceHeadsProofSha256: sha('actual eight head proof') };
}

test('promotion removes selectors and clocks and directs only the already reviewed report paths to5002', () => {
  assert.equal(typeof subject.createDriverAuditSupabasePromotionPlan, 'function');
  const canaryPlan = canary.createDriverAuditSupabaseCanaryPlan({ main, site, selector: 'a'.repeat(64), entryNonce: 'b'.repeat(64),
    issuedAt: '2026-11-17T15:00:00.000Z' }, { hashes });
  const value = subject.createDriverAuditSupabasePromotionPlan({ canaryPlan }, { verifyCanaryPlan: input => canary.createDriverAuditSupabaseCanaryPlan(input, { hashes }) });
  const config = Buffer.from(value.promoted.main, 'base64').toString(), selected = Buffer.from(value.promoted.site, 'base64').toString();
  assert(!config.includes('$cookie_')); assert(!config.includes('$msec')); assert(!selected.includes(canaryPlan.selector));
  assert(!selected.includes(canaryPlan.entryPath)); assert(selected.includes('proxy_pass http://127.0.0.1:5002;'));
  assert(selected.includes('proxy_pass http://127.0.0.1:5000/api/;'));
  const tokens = [...config.matchAll(/"~(\^[^"\n]+)" 1;/g)].map(match => new RegExp(match[1])); assert.equal(tokens.length, 1);
  for (const path of ['/api/reporting/reviews', '/report-data/snapshot.json', '/api/session/refresh', '/driver-audit-view']) assert(tokens[0].test(path));
  for (const path of ['/api/deliveries', '/api/auth/me', '/api/reporting-other/reviews', '/socket.io/', '/uploads/photo.jpg']) assert(!tokens[0].test(path));
  for (const [name, original] of Object.entries({ main, site })) {
    const stripped = Buffer.from(value.promoted[name], 'base64').toString().replace(/^[ \t]*# BEGIN MATTER REPORTS SELECTED [A-Z]+\n[\s\S]*?[ \t]*# END MATTER REPORTS SELECTED [A-Z]+\n/gm, '');
    assert.equal(stripped, original.toString());
  }
});

test('promotion acceptance binds the real sealed handshake, latest+previous bytes, own browser and all8 heads with exact scalar types', async t => {
  assert.equal(typeof subject.validateDriverAuditSupabaseCanaryAcceptance, 'function');
  const f = await rootFixture(t), currentReadiness = { ...readiness, reportHealth: { ...readiness.reportHealth, collectorRevision: 5771 } };
  const planned = await subject.runDriverAuditSupabaseCanaryRoot({ operation: 'plan', recipientPublicKey, readiness: currentReadiness }, f.api), plan = detail(planned).plan;
  await subject.runDriverAuditSupabaseCanaryRoot({ operation: 'enable', recipientPublicKey, readiness: currentReadiness, planSha256: plan.planSha256 }, f.api);
  const sealed = await subject.runDriverAuditSupabaseCanaryRoot({ operation: 'seal-entry', recipientPublicKey, planSha256: plan.planSha256 }, f.api);
  const handshake = Buffer.from(JSON.stringify({ version: 1, kind: 'supabase-canary-host-handshake-v1', applicationCommit: '701655794e1711b4d8c737e929360ecfe5d2f0ca',
    preparedReceiptSha256: currentReadiness.preparedReceiptSha256, probeMetadataSha256: sha('probe'), readiness: null, root: sealed }));
  const value = acceptanceFixture(plan, currentReadiness, handshake), bytes = Buffer.from(JSON.stringify(value));
  const checked = subject.validateDriverAuditSupabaseCanaryAcceptance({ bytes, sha256: sha(bytes), canaryPlan: plan, readiness: currentReadiness, handshake,
    now: Date.parse(value.checkedAt) }); assert.equal(checked.current.collectorRevision, 5771);
  for (const mutate of [
    a => { a.browser.checks.photos.status = 'pending'; }, a => { a.host.logSha256 = [a.host.logSha256]; },
    a => { a.current.generation = [a.current.generation]; }, a => { a.host.runId = '101'; },
    a => { a.previous.collectorRevision = 4775; }, a => { delete a.sourceHeads['review-journal']; },
    a => { a.sourceHeads['collector-state'].bodySha256 = sha('different source'); }, a => { a.packages.previous.photosSha256 = null; },
    a => { a.host.handshakeSha256 = sha('foreign'); }, a => { a.browser.kind = 'anonymous'; },
  ]) {
    const bad = structuredClone(value); mutate(bad); const raw = Buffer.from(JSON.stringify(bad));
    assert.throws(() => subject.validateDriverAuditSupabaseCanaryAcceptance({ bytes: raw, sha256: sha(raw), canaryPlan: plan, readiness: currentReadiness, handshake, now: Date.parse(value.checkedAt) }));
  }
  assert.throws(() => subject.validateDriverAuditSupabaseCanaryAcceptance({ bytes, sha256: sha(bytes), canaryPlan: plan, readiness: currentReadiness, handshake,
    now: Date.parse(plan.expiresAt) }));
});

test('promotion tests and reloads exact fixed files, and failures restore the sealed canary without overwriting an independent edit', async t => {
  assert.equal(typeof subject.executeDriverAuditSupabasePromotion, 'function');
  for (const fault of ['none', 'test', 'reload', 'independent']) {
    const f = await rootFixture(t), planned = await subject.runDriverAuditSupabaseCanaryRoot({ operation: 'plan', recipientPublicKey, readiness }, f.api), plan = detail(planned).plan;
    await subject.runDriverAuditSupabaseCanaryRoot({ operation: 'enable', recipientPublicKey, readiness, planSha256: plan.planSha256 }, f.api);
    await subject.runDriverAuditSupabaseCanaryRoot({ operation: 'seal-entry', recipientPublicKey, planSha256: plan.planSha256 }, f.api);
    const originalTest = f.executor.test, originalReload = f.executor.reload;
    let injected = false;
    if (fault === 'test' || fault === 'independent') f.executor.test = async () => {
      if (!injected) { injected = true; if (fault === 'independent') f.files.site.bytes = Buffer.from('independent configuration'); throw Error('nginx private diagnostic'); }
      return originalTest();
    };
    if (fault === 'reload') f.executor.reload = async () => { if (!injected) { injected = true; throw Error('nginx reload private diagnostic'); } return originalReload(); };
    const create = input => subject.createDriverAuditSupabasePromotionPlan(input, { verifyCanaryPlan: f.api.createPlan });
    if (fault === 'none') {
      const result = await subject.executeDriverAuditSupabasePromotion({ canaryPlan: plan }, f.executor, create);
      assert.equal(result.defaultReportTarget, 'supabase'); assert.equal(result.businessRoutingChanged, false); assert.equal(result.authGranted, false);
      assert(!f.files.main.bytes.includes(Buffer.from('$cookie_'))); assert.deepEqual(f.calls.slice(-2), ['nginx-test', 'nginx-reload']);
    } else {
      await assert.rejects(subject.executeDriverAuditSupabasePromotion({ canaryPlan: plan }, f.executor, create), error => error.rollbackRestored === (fault !== 'independent'));
      if (fault === 'independent') assert.equal(f.files.site.bytes.toString(), 'independent configuration');
      else assert.deepEqual(f.files.site.bytes, Buffer.from(plan.sealed.site, 'base64'));
    }
  }
});

test('root promotion requires actual sealed plan and immutable acceptance, and retry retains the original admission clock', async t => {
  const f = await rootFixture(t), currentReadiness = { ...readiness, reportHealth: { ...readiness.reportHealth, collectorRevision: 5771 } };
  const planned = await subject.runDriverAuditSupabaseCanaryRoot({ operation: 'plan', recipientPublicKey, readiness: currentReadiness }, f.api), plan = detail(planned).plan;
  await subject.runDriverAuditSupabaseCanaryRoot({ operation: 'enable', recipientPublicKey, readiness: currentReadiness, planSha256: plan.planSha256 }, f.api);
  const sealed = await subject.runDriverAuditSupabaseCanaryRoot({ operation: 'seal-entry', recipientPublicKey, planSha256: plan.planSha256 }, f.api);
  const handshake = Buffer.from(JSON.stringify({ version: 1, kind: 'supabase-canary-host-handshake-v1', applicationCommit: '701655794e1711b4d8c737e929360ecfe5d2f0ca',
    preparedReceiptSha256: currentReadiness.preparedReceiptSha256, probeMetadataSha256: sha('probe'), readiness: null, root: sealed }));
  const bytes = Buffer.from(JSON.stringify(acceptanceFixture(plan, currentReadiness, handshake))), input = { operation: 'promote', recipientPublicKey,
    readiness: currentReadiness, planSha256: plan.planSha256, canaryAcceptanceSha256: sha(bytes), acceptanceBase64: bytes.toString('base64'), sealHandshakeBase64: handshake.toString('base64') };
  const promoted = await subject.runDriverAuditSupabaseCanaryRoot(input, f.api), first = detail(promoted);
  assert.equal(promoted.status, 'canary-root-promote'); assert.equal(promoted.defaultReportTarget, 'supabase'); assert.equal(promoted.businessRoutingChanged, false);
  const file = f.local('/var/lib/matter-driver-reports-canary/promotion-complete-' + plan.planSha256 + '.json'), saved = await fs.readFile(file);
  f.advance(700000);
  const retry = detail(await subject.runDriverAuditSupabaseCanaryRoot(input, f.api));
  assert.equal(retry.completion.admittedAt, first.completion.admittedAt); assert.deepEqual(await fs.readFile(file), saved);
  await assert.rejects(subject.runDriverAuditSupabaseCanaryRoot({ ...input, canaryAcceptanceSha256: sha('different') }, f.api));
  assert(!f.files.main.bytes.includes(Buffer.from('$cookie_')));
});

async function hostPromotionFixture(t) {
  const f = await hostFixture(t, { latest: true }), planned = await f.run('plan'), planDetail = detail(planned), plan = planDetail.plan;
  await f.run('enable', { planSha256: planned.planSha256 });
  const sealed = await f.run('seal-entry', { planSha256: planned.planSha256 });
  const folder = path.join(f.base, '.private/driver-report-supabase-handoff/canary');
  const handshake = await fs.readFile(path.join(folder, 'handshake-' + sealed.handshakeSha256 + '.private.json')).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return fs.readFile(path.join(folder, 'seal-entry-' + sealed.metadataSha256 + '.private.json'));
  });
  const acceptance = acceptanceFixture(plan, planDetail.readiness, handshake), bytes = Buffer.from(JSON.stringify(acceptance)), acceptanceSha256 = sha(bytes);
  const compressed = gzipSync(bytes), acceptanceObjectSha256 = sha(compressed);
  await fs.writeFile(path.join(folder, 'acceptance-' + acceptanceSha256 + '.private.json'), bytes, { mode: 0o600 });
  await fs.writeFile(path.join(folder, 'acceptance-' + acceptanceSha256 + '.transport.private.json'), JSON.stringify({ version: 1,
    kind: 'supabase-canary-acceptance-transport-v1', canaryAcceptanceSha256: acceptanceSha256,
    canaryAcceptanceObjectSha256: acceptanceObjectSha256, key: acceptanceObjectSha256 + '.gz' }), { mode: 0o600 });
  return { ...f, planned, acceptance, acceptanceSha256, acceptanceObjectSha256, compressed, folder,
    promote: () => f.run('promote', { planSha256: plan.planSha256, canaryAcceptanceSha256: acceptanceSha256,
      canaryAcceptanceObjectSha256: acceptanceObjectSha256 }) };
}

async function acceptanceTransport(f, { bytes = f.compressed, privateBucket = true } = {}) {
  const file = path.join(f.server, '.env.local'), cacheDirectory = path.join(f.syncRoot, 'work/archive-cache');
  await fs.mkdir(cacheDirectory, { mode: 0o700 });
  const secret = 'fictional-private-supabase-proof-secret';
  await fs.writeFile(file, ['DRIVER_AUDIT_EXECUTION_HOST=sidi', 'DRIVER_AUDIT_DATA_STORE=supabase',
    'DRIVER_AUDIT_IMPORT_ENABLED=0', 'DRIVER_AUDIT_REPLICA_GC_ENABLED=0', 'DRIVER_AUDIT_RELEASE_SHA=' + f.p.release,
    'MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY=' + cacheDirectory, 'MATTER_SUPABASE_SECRET=' + secret,
    'DRIVER_AUDIT_SUPABASE_SECRET=' + secret].join('\n'), { mode: 0o600 });
  const counters = { opens: 0, privateChecks: 0, reads: 0, closes: 0 }, original = f.adapters.load;
  const backend = { kind: 'supabase', executionHost: 'sidi', executionAdmission: 'fixed-host-v1',
    transferAccounting: 'supabase-http-bytes-v1', archiveCacheDirectory: cacheDirectory,
    archive: { managedReadCache: true,
      async assertPrivate() { counters.privateChecks++; return { bucket: 'matter-report-archive', public: !privateBucket }; },
      async readObject(key, options) { counters.reads++; assert.equal(key, f.acceptanceObjectSha256 + '.gz');
        assert.equal(options.maxBytes, 64 * 1024); assert(options.signal instanceof AbortSignal); return [bytes]; } },
    async close() { counters.closes++; } };
  f.adapters.load = async (name, root) => {
    if (name === 'node_modules/dotenv/lib/main.js') {
      assert.equal(root, path.dirname(f.server)); return import('../../server/node_modules/dotenv/lib/main.js');
    }
    if (name === 'services/driverAuditSupabaseAppBackend.js') {
      assert.equal(root, path.dirname(f.server)); return { async createDriverAuditSupabaseAppBackend({ env }) {
        counters.opens++; assert.equal(env.MATTER_SUPABASE_SECRET, secret); assert.equal(env.MONGODB_URI, undefined); return backend;
      } };
    }
    return original(name, root);
  };
  return { counters, backend, file, secret };
}

test('promotion retrieves a missing proof through the actual Sidi backend interface once and reuses its immutable transport binding', async t => {
  const f = await hostPromotionFixture(t), proof = path.join(f.folder, 'acceptance-' + f.acceptanceSha256 + '.private.json');
  const recipe = path.join(f.folder, 'acceptance-' + f.acceptanceSha256 + '.transport.private.json');
  await fs.unlink(proof); await fs.unlink(recipe); const remote = await acceptanceTransport(f);
  const result = await f.promote();
  assert.deepEqual(remote.counters, { opens: 1, privateChecks: 1, reads: 1, closes: 1 });
  assert.equal(result.canaryAcceptanceObjectSha256, f.acceptanceObjectSha256);
  assert.equal(sha(await fs.readFile(proof)), f.acceptanceSha256); assert.equal((await fs.stat(proof)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(recipe)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await fs.readFile(recipe)).canaryAcceptanceObjectSha256, f.acceptanceObjectSha256);
  const load = f.adapters.load;
  f.adapters.load = async (...args) => { assert.equal(args[0], 'vendor/driver-audits/integration/hosted/worker-lock.mjs'); return load(...args); };
  await f.promote(); assert.equal(remote.counters.reads, 1); assert(!JSON.stringify(result).includes(remote.secret));
  const handshake = JSON.parse(await fs.readFile(path.join(f.folder, 'handshake-' + result.handshakeSha256 + '.private.json')));
  assert.equal(handshake.canaryAcceptanceObjectSha256, f.acceptanceObjectSha256);
  assert(!(await fs.readdir(f.folder)).some(name => name.endsWith('.tmp')));
});

test('proof transport cleans only its bounded private interrupted temporaries and preserves unrelated files', async t => {
  const f = await hostPromotionFixture(t), proof = path.join(f.folder, 'acceptance-' + f.acceptanceSha256 + '.private.json');
  await fs.unlink(proof); await fs.unlink(path.join(f.folder, 'acceptance-' + f.acceptanceSha256 + '.transport.private.json'));
  await fs.writeFile(path.join(f.folder, '.acceptance-' + 'a'.repeat(32) + '.tmp'), 'interrupted private fragment', { mode: 0o600 });
  const untouched = path.join(f.folder, 'unrelated.private.json'); await fs.writeFile(untouched, '{}', { mode: 0o600 });
  await acceptanceTransport(f); await f.promote();
  assert.deepEqual(await fs.readFile(untouched), Buffer.from('{}'));
  assert(!(await fs.readdir(f.folder)).some(name => name.endsWith('.tmp')));
});

test('a downloaded proof keeps its physical environment pin through privileged promotion readback', async t => {
  const f = await hostPromotionFixture(t), proof = path.join(f.folder, 'acceptance-' + f.acceptanceSha256 + '.private.json');
  await fs.unlink(proof); await fs.unlink(path.join(f.folder, 'acceptance-' + f.acceptanceSha256 + '.transport.private.json'));
  const remote = await acceptanceTransport(f);
  f.afterRoot(async operation => { if (operation === 'promote') await fs.appendFile(remote.file, '\nAFTER_ROOT_DRIFT=1'); });
  await assert.rejects(f.promote(), error => error.phase === 'readback' && error.rollbackRestored === true);
  assert(f.root.files.main.bytes.includes(Buffer.from('$cookie_'))); assert.equal(f.held.size, 0);
});

test('a preexisting exact proof needs its original compressed transport binding and cannot be rebound', async t => {
  const f = await hostPromotionFixture(t), recipe = path.join(f.folder, 'acceptance-' + f.acceptanceSha256 + '.transport.private.json');
  await fs.unlink(recipe); const remote = await acceptanceTransport(f); await f.promote(); assert.equal(remote.counters.reads, 1);
  const before = await fs.readFile(recipe), routed = Buffer.from(f.root.files.main.bytes);
  await assert.rejects(f.run('promote', { planSha256: f.planned.planSha256, canaryAcceptanceSha256: f.acceptanceSha256,
    canaryAcceptanceObjectSha256: 'f'.repeat(64) }));
  assert.deepEqual(await fs.readFile(recipe), before); assert.deepEqual(f.root.files.main.bytes, routed); assert.equal(remote.counters.reads, 1);
});

test('private-bucket, compressed/raw hashes, gzip limits and metered-backend identity fail before routing', async t => {
  for (const mode of ['public', 'compressed-hash', 'raw-hash', 'not-gzip', 'too-large', 'expanded', 'unmetered', 'mongo', 'unmanaged']) {
    const f = await hostPromotionFixture(t), proof = path.join(f.folder, 'acceptance-' + f.acceptanceSha256 + '.private.json');
    const recipe = path.join(f.folder, 'acceptance-' + f.acceptanceSha256 + '.transport.private.json');
    await fs.unlink(proof); await fs.unlink(recipe);
    let compressed = f.compressed;
    if (mode === 'compressed-hash') compressed = Buffer.from('wrong bytes');
    if (mode === 'raw-hash') compressed = gzipSync(Buffer.from('{}'));
    if (mode === 'not-gzip') compressed = Buffer.from('{}');
    if (mode === 'too-large') compressed = Buffer.alloc(64 * 1024 + 1);
    if (mode === 'expanded') compressed = gzipSync(Buffer.alloc(16 * 1024 + 1));
    if (['raw-hash', 'not-gzip', 'too-large', 'expanded'].includes(mode)) f.acceptanceObjectSha256 = sha(compressed);
    const remote = await acceptanceTransport(f, { bytes: compressed, privateBucket: mode !== 'public' });
    if (mode === 'unmetered') remote.backend.transferAccounting = null;
    if (mode === 'mongo') remote.backend.kind = 'mongo';
    if (mode === 'unmanaged') remote.backend.archive.managedReadCache = false;
    await assert.rejects(f.run('promote', { planSha256: f.planned.planSha256, canaryAcceptanceSha256: f.acceptanceSha256,
      canaryAcceptanceObjectSha256: f.acceptanceObjectSha256 }));
    assert.equal(remote.counters.closes, 1); assert(!f.sudo.includes('promote')); assert.equal(f.held.size, 0);
    await assert.rejects(fs.lstat(proof), { code: 'ENOENT' }); assert(!JSON.stringify(f.root).includes(remote.secret));
  }
});

test('transport RPC errors, durable configuration drift and cancellation never admit or cache a proof', async t => {
  for (const mode of ['read-error', 'environment-drift', 'abort', 'close-error']) {
    const f = await hostPromotionFixture(t), proof = path.join(f.folder, 'acceptance-' + f.acceptanceSha256 + '.private.json');
    await fs.unlink(proof); await fs.unlink(path.join(f.folder, 'acceptance-' + f.acceptanceSha256 + '.transport.private.json'));
    const remote = await acceptanceTransport(f), readObject = remote.backend.archive.readObject, close = remote.backend.close;
    const controller = new AbortController(); f.adapters.signal = controller.signal;
    remote.backend.archive.readObject = async (...args) => {
      if (mode === 'read-error') throw Error(remote.secret);
      if (mode === 'environment-drift') await fs.appendFile(remote.file, '\nUNEXPECTED_CHANGED=1');
      if (mode === 'abort') controller.abort();
      return readObject(...args);
    };
    remote.backend.close = async () => { await close(); if (mode === 'close-error') throw Error(remote.secret); };
    await assert.rejects(f.promote(), error => !JSON.stringify(error).includes(remote.secret));
    assert.equal(remote.counters.closes, 1); assert(!f.sudo.includes('promote')); assert.equal(f.held.size, 0);
    await assert.rejects(fs.lstat(proof), { code: 'ENOENT' });
  }
});

test('the actual public Supabase backend meters the bounded proof GET below the persistent managed cache', async t => {
  const f = await hostPromotionFixture(t), proof = path.join(f.folder, 'acceptance-' + f.acceptanceSha256 + '.private.json');
  await fs.unlink(proof); await fs.unlink(path.join(f.folder, 'acceptance-' + f.acceptanceSha256 + '.transport.private.json'));
  const transport = await acceptanceTransport(f), load = f.adapters.load, calls = [];
  const { createDriverAuditSupabaseAppBackend } = await import('../../server/services/driverAuditSupabaseAppBackend.js');
  const fetchImpl = async (input, options) => {
    const url = new URL(input), name = url.pathname.split('/').at(-1);
    assert.equal(url.origin, 'https://trhhjfgfmxofxhnzocks.supabase.co');
    calls.push({ pathname: url.pathname, method: options.method });
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const args = JSON.parse(options.body), basis = 'supabase-http-bytes-v1';
      if (name === 'matter_hosted_app_read_egress_reserve') return Response.json({ version: 1, basis,
        allowed: true, id: args.p_id, period: '2026-11', requestBytes: args.p_request_bytes, responseBytes: args.p_response_bytes });
      if (name === 'matter_hosted_app_read_egress_settle') return Response.json({ version: 1, basis,
        settled: true, period: '2026-11', chargedRequestBytes: args.p_request_bytes, chargedResponseBytes: args.p_response_bytes });
      assert.equal(name, 'matter_hosted_app_photo_alias_read'); return Response.json({ reference: null });
    }
    assert.equal(options.method, 'GET');
    if (url.pathname === '/storage/v1/bucket/matter-report-archive') return Response.json({ id: 'matter-report-archive', public: false });
    assert.equal(url.pathname, '/storage/v1/object/authenticated/matter-report-archive/' + f.acceptanceObjectSha256 + '.gz');
    return new Response(f.compressed);
  };
  f.adapters.load = async (name, root) => {
    if (name !== 'services/driverAuditSupabaseAppBackend.js') return load(name, root);
    assert.equal(root, path.dirname(f.server));
    return { async createDriverAuditSupabaseAppBackend({ env }) {
      const backend = await createDriverAuditSupabaseAppBackend({ env, fetchImpl, cacheFreeBytes: async () => 2 * 1024 ** 3,
        photoStore: { identitySha256: 'a'.repeat(64), async verifyExistingPhoto() { assert.fail('A proof is not a photo'); },
          async readExistingPhoto() { assert.fail('A proof is not a photo'); }, async assertExistingPhotoRetention() {
          return { verified: true, rules: 0, existingPhotosExpire: false };
        } } });
      return { ...backend, close: async () => { transport.counters.closes++; } };
    } };
  };
  await f.promote();
  const downloads = () => calls.filter(value => value.pathname.startsWith('/storage/v1/object/'));
  assert.equal(downloads().length, 1);
  assert(calls.some(value => value.pathname.endsWith('/matter_hosted_app_read_egress_reserve')));
  assert(calls.some(value => value.pathname.endsWith('/matter_hosted_app_read_egress_settle')));
  assert(calls.filter(value => value.pathname.startsWith('/storage/')).every(value => value.method === 'GET'));
  // Simulate loss of only the tiny local proof. A fresh real backend reuses the
  // already verified compressed cache object; no second object download occurs.
  await fs.unlink(proof); await f.promote();
  assert.equal(downloads().length, 1); assert.equal(transport.counters.closes, 2);
  assert.equal(sha(await fs.readFile(proof)), f.acceptanceSha256);
});

test('host promotion consumes only an owner-private exact acceptance pack and retains all source/business worker identities', async t => {
  const f = await hostPromotionFixture(t), result = await f.promote();
  assert.equal(result.status, 'canary-root-promote'); assert.equal(result.defaultReportTarget, 'supabase');
  assert.equal(result.businessRoutingChanged, false); assert.equal(result.staffAuthorizationGranted, false); assert.equal(f.held.size, 0);
  assert(!f.root.files.main.bytes.includes(Buffer.from('$cookie_'))); assert(!f.root.files.site.bytes.includes(Buffer.from('Set-Cookie')));
  assert(f.commands.every(([file, args]) => file === 'git' || file === 'pm2' && JSON.stringify(args) === '["jlist"]'));
});

test('missing, widened, foreign or string-coerced acceptance cannot change default report routing', async t => {
  for (const mode of ['missing', 'permissions', 'foreign', 'array-input']) {
    const f = await hostPromotionFixture(t), file = path.join(f.folder, 'acceptance-' + f.acceptanceSha256 + '.private.json');
    if (mode === 'missing') await fs.unlink(file);
    if (mode === 'permissions') await fs.chmod(file, 0o644);
    if (mode === 'foreign') await fs.writeFile(file, '{}');
    const input = mode === 'array-input' ? { planSha256: f.planned.planSha256, canaryAcceptanceSha256: [f.acceptanceSha256],
      canaryAcceptanceObjectSha256: f.acceptanceObjectSha256 } : null;
    await assert.rejects(input ? f.run('promote', input) : f.promote());
    assert(f.root.files.main.bytes.includes(Buffer.from('$cookie_'))); assert.equal(f.held.size, 0);
  }
});

test('repeated successful canary operations retain every actual sealed receipt without rolling back on ciphertext changes', async t => {
  const f = await hostFixture(t), planned = await f.run('plan');
  const first = await f.run('enable', { planSha256: planned.planSha256 });
  const second = await f.run('enable', { planSha256: planned.planSha256 });
  assert.notEqual(first.handshakeSha256, second.handshakeSha256);
  const folder = path.join(f.base, '.private/driver-report-supabase-handoff/canary');
  for (const value of [first, second]) assert.equal(sha(await fs.readFile(path.join(folder, 'handshake-' + value.handshakeSha256 + '.private.json'))), value.handshakeSha256);
  await f.run('seal-entry', { planSha256: planned.planSha256 }); await f.run('seal-entry', { planSha256: planned.planSha256 });
  assert(f.root.files.main.bytes.includes(Buffer.from('$cookie_'))); assert(!f.root.files.site.bytes.includes(Buffer.from('Set-Cookie')));
});

test('repeated promotion confirmations preserve original root receipt/time and never restore on fresh ciphertext', async t => {
  const f = await hostPromotionFixture(t), first = await f.promote(), firstProof = detail(first);
  const second = await f.promote(), third = await f.promote();
  assert.equal(detail(second).completion.admittedAt, firstProof.completion.admittedAt);
  assert.equal(detail(third).completionSha256, firstProof.completionSha256);
  assert.equal(third.defaultReportTarget, 'supabase'); assert(!f.root.files.main.bytes.includes(Buffer.from('$cookie_')));
  assert.equal(first.routingChanged, true); assert.equal(third.routingChanged, false); assert.equal(third.reusedCompletion, true);
});

test('promotion readback drift or cancellation rolls back only to the sealed canary and releases exclusion', async t => {
  for (const cancel of [false, true]) {
    const f = await hostPromotionFixture(t), stop = new AbortController(); f.adapters.signal = stop.signal;
    f.afterRoot(operation => { if (operation === 'promote') { if (cancel) stop.abort(); else f.rows[0].pid++; } });
    await assert.rejects(f.promote(), error => error.phase === (cancel ? 'cancelled' : 'readback') && error.rollbackRestored === true);
    assert(f.root.files.main.bytes.includes(Buffer.from('$cookie_'))); assert(!f.root.files.site.bytes.includes(Buffer.from('Set-Cookie')));
    assert.equal(f.held.size, 0); assert(f.sudo.includes('rollback-promotion'));
  }
});

test('the former canary restore cannot overwrite successfully promoted default report routing', async t => {
  const f = await hostPromotionFixture(t); await f.promote(); const before = Buffer.from(f.root.files.main.bytes);
  await assert.rejects(f.run('restore', { planSha256: f.planned.planSha256 }));
  assert.deepEqual(f.root.files.main.bytes, before); assert(!before.includes(Buffer.from('$cookie_')));
});

test('a corrupted completion cannot invent an authorization flag or a future promotion clock', async t => {
  for (const mutate of [value => { value.result.authGranted = true; }, value => { value.confirmedAt = '2030-01-01T00:00:00.000Z'; }]) {
    const f = await hostPromotionFixture(t); await f.promote();
    const file = f.root.local('/var/lib/matter-driver-reports-canary/promotion-complete-' + f.planned.planSha256 + '.json');
    const value = JSON.parse(await fs.readFile(file)); mutate(value); await fs.writeFile(file, JSON.stringify(value));
    await assert.rejects(f.promote());
  }
});

test('promotion refuses a same-count journal substitution and preserves every original review namespace', async t => {
  const f = await hostPromotionFixture(t), oldName = 'preview-acceptance-reconcile-20261109:review-journal';
  const bad = structuredClone(f.acceptance), retained = bad.sourceHeads[oldName];
  delete bad.sourceHeads[oldName]; bad.sourceHeads['preview-unrelated:review-journal'] = retained;
  assert.equal(Object.keys(bad.sourceHeads).length, 8);
  const bytes = Buffer.from(JSON.stringify(bad)), pin = sha(bytes);
  await fs.writeFile(path.join(f.folder, 'acceptance-' + pin + '.private.json'), bytes, { mode: 0o600 });
  const objectPin = sha(gzipSync(bytes));
  await fs.writeFile(path.join(f.folder, 'acceptance-' + pin + '.transport.private.json'), JSON.stringify({ version: 1,
    kind: 'supabase-canary-acceptance-transport-v1', canaryAcceptanceSha256: pin,
    canaryAcceptanceObjectSha256: objectPin, key: objectPin + '.gz' }), { mode: 0o600 });
  const before = Buffer.from(f.root.files.main.bytes);
  await assert.rejects(f.run('promote', { planSha256: f.planned.planSha256, canaryAcceptanceSha256: pin,
    canaryAcceptanceObjectSha256: objectPin }));
  assert.deepEqual(f.root.files.main.bytes, before); assert(f.root.files.main.bytes.includes(Buffer.from('$cookie_'))); assert.equal(f.held.size, 0);
});
