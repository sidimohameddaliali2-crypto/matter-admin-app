import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const subject = await import('./driver-audit-supabase-canary.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const main = Buffer.from('user www-data;\nevents {}\nhttp {\n    include /etc/nginx/sites-enabled/*;\n}\n');
const site = Buffer.from(`server {
    listen 443 ssl;
    server_name fictional.invalid;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    root /fictional/client/build;
    location / {
        try_files $uri $uri/ /index.html;
    }
    location /uploads/ {
        alias /fictional/uploads/;
        expires 1y;
    }
    location /api/ {
        proxy_pass http://127.0.0.1:5000/api/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
    location /socket.io/ {
        proxy_pass http://127.0.0.1:5000/socket.io/;
    }
}
`);
const hashes = { main: sha(main), site: sha(site) };
const issuedAt = '2026-11-17T15:00:00.000Z';

function plan(changes = {}) {
  assert.equal(typeof subject.createDriverAuditSupabaseCanaryPlan, 'function');
  return subject.createDriverAuditSupabaseCanaryPlan({ main, site, selector: 'a'.repeat(64), entryNonce: 'b'.repeat(64),
    issuedAt, ttlSeconds: 120, ...changes }, { hashes });
}

function executor() {
  const files = { main: { bytes: Buffer.from(main), mode: 0o644 }, site: { bytes: Buffer.from(site), mode: 0o644 } };
  const calls = []; let backup, locked = false, fail;
  const ex = { hashes, files, calls, now: () => Date.parse(issuedAt) + 1000,
    async withLock(operation) { assert(!locked); locked = true; try { return await operation(); } finally { locked = false; } },
    async read() { return Object.fromEntries(Object.entries(files).map(([name, row]) => [name,
      { bytes: Buffer.from(row.bytes), mode: row.mode, sha256: sha(row.bytes), signature: sha(row.bytes) + ':' + row.mode }])); },
    async backup(value, mayCreate) {
      assert(locked);
      if (!backup) { assert(mayCreate); backup = { planSha256: value.planSha256, modes: { main: files.main.mode, site: files.site.mode } }; }
      assert.equal(backup.planSha256, value.planSha256); return backup;
    },
    async replace(name, expected, bytes, mode) {
      assert(locked); assert(['main', 'site'].includes(name)); assert.equal(sha(files[name].bytes), expected.sha256);
      assert.equal(sha(files[name].bytes) + ':' + files[name].mode, expected.signature);
      calls.push('write-' + name);
      if (fail?.at === 'write-' + name) { const f = fail; fail = null; f.action?.(); throw Error('private failure'); }
      files[name] = { bytes: Buffer.from(bytes), mode };
    },
    async test() { calls.push('test'); if (fail?.at === 'test') { const f = fail; fail = null; f.action?.(); throw Error('private configuration diagnostic'); } },
    async reload() { calls.push('reload'); if (fail?.at === 'reload') { fail = null; throw Error('private reload diagnostic'); } },
    fail(at, action) { fail = { at, action }; }, isLocked: () => locked,
  };
  return ex;
}

test('canary plan changes only marked gates and preserves all original directives and inherited proxy headers', () => {
  const value = plan();
  assert.equal(value.expiresAt, '2026-11-17T15:02:00.000Z');
  for (const name of ['main', 'site']) for (const phase of ['enabled', 'sealed']) {
    const text = Buffer.from(value[phase][name], 'base64').toString();
    const original = text.replace(/^[ \t]*# BEGIN MATTER REPORTS CANARY [A-Z]+\n[\s\S]*?[ \t]*# END MATTER REPORTS CANARY [A-Z]+\n/gm, '');
    assert.equal(original, (name === 'main' ? main : site).toString());
  }
  const enabled = Buffer.from(value.enabled.site, 'base64').toString();
  assert(enabled.includes('proxy_pass http://127.0.0.1:5000/api/;'));
  assert(enabled.includes('proxy_pass http://127.0.0.1:5002;'));
  assert(!enabled.includes('5002/')); assert(!enabled.includes('proxy_pass http://$'));
  assert(enabled.includes('proxy_set_header X-Forwarded-Proto $scheme;'));
  assert(enabled.includes('Secure; HttpOnly; SameSite=Strict'));
  const entry = enabled.slice(enabled.indexOf('location = /_matter-driver-reports-canary/'));
  for (const header of ['Strict-Transport-Security', 'X-Frame-Options', 'X-Content-Type-Options', 'X-XSS-Protection']) assert(entry.includes('add_header ' + header));
  assert(!Buffer.from(value.sealed.site, 'base64').toString().includes(value.entryPath));
  const diff = subject.driverAuditSupabaseCanaryDiff(value);
  assert(diff.includes('--- /etc/nginx/nginx.conf')); assert(diff.includes('+++ /etc/nginx/sites-available/matter'));
});

async function fixedExecutor(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nginx-canary-executor-')));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  const local = file => path.join(root, file.slice(1));
  for (const dir of ['/etc/nginx/sites-available', '/etc/nginx/sites-enabled', '/var/lib']) await fs.mkdir(local(dir), { recursive: true, mode: 0o755 });
  for (const [name, bytes] of [['nginx.conf', main], ['sites-available/matter', site]]) {
    const file = local('/etc/nginx/' + name); await fs.writeFile(file, bytes, { mode: 0o644 }); await fs.chmod(file, 0o644);
  }
  await fs.symlink('../sites-available/matter', local('/etc/nginx/sites-enabled/matter'));
  const commands = [], mutations = [], synced = [], openedPhysicalPaths = [], descriptors = new Map();
  let wrongOwner = false, failLockClose = false, failBackupSync = false;
  const mapped = async file => {
    const reference = /^\/proc\/self\/fd\/(\d+)\/(.+)$/.exec(file);
    if (!reference) return local(file);
    const held = descriptors.get(Number(reference[1])); assert(held);
    const queue = [root]; let checked = 0;
    while (queue.length) {
      const folder = queue.pop(), stat = await fs.lstat(folder); assert(++checked < 1000);
      if (stat.ino === held.ino && stat.dev === held.dev) return path.join(folder, reference[2]);
      for (const entry of await fs.readdir(folder, { withFileTypes: true })) if (entry.isDirectory()) queue.push(path.join(folder, entry.name));
    }
    assert.fail('Opened directory fixture disappeared');
  };
  const owned = stat => { stat.uid = typeof stat.uid === 'bigint' ? wrongOwner ? 123n : 0n : wrongOwner ? 123 : 0;
    stat.gid = typeof stat.gid === 'bigint' ? 0n : 0; return stat; };
  const filesystem = {
    async lstat(file, options) { return owned(await fs.lstat(local(file), options)); },
    async realpath(file) { return '/' + path.relative(root, await fs.realpath(local(file))); },
    async readlink(file) { return fs.readlink(local(file)); },
    async mkdir(file, options) { mutations.push('mkdir:' + file); return fs.mkdir(local(file), options); },
    async rename(from, to) { mutations.push('rename:' + to); return fs.rename(await mapped(from), await mapped(to)); },
    async unlink(file) { mutations.push('unlink:' + file); return fs.unlink(await mapped(file)); },
    async open(file, ...args) {
      const physical = await mapped(file), handle = await fs.open(physical, ...args), stat = handle.stat.bind(handle), sync = handle.sync.bind(handle), close = handle.close.bind(handle);
      const descriptor = handle.fd, actual = await stat(); if (actual.isDirectory()) descriptors.set(descriptor, actual);
      openedPhysicalPaths.push(await fs.realpath(physical));
      handle.stat = async options => owned(await stat(options));
      handle.chown = async (uid, gid) => { assert.equal(uid, 0); assert.equal(gid, 0); };
      handle.sync = async () => {
        synced.push(file);
        if (failBackupSync && file === '/var/lib/matter-driver-reports-canary') throw Error('private durability failure');
        return sync();
      };
      handle.close = async () => { await close(); descriptors.delete(descriptor); if (failLockClose && file.endsWith('/operator.lock')) throw Error('private close failure'); };
      return handle;
    },
  };
  const ex = subject.createDriverAuditSupabaseCanaryExecutor({ filesystem, uid: () => 0, platform: 'linux',
    async exec(file, args, options) { commands.push({ file, args, options }); return { stdout: '' }; } });
  ex.hashes = hashes; ex.now = () => Date.parse(issuedAt) + 1000;
  return { root, local, ex, commands, mutations, synced, filesystem, openedPhysicalPaths,
    wrongOwner() { wrongOwner = true; }, failLockClose() { failLockClose = true; }, failBackupSync() { failBackupSync = true; } };
}

test('fixed executor atomically backs up and restores its two exact files with no shell, credentials or arbitrary path', async t => {
  const f = await fixedExecutor(t), value = plan();
  await subject.executeDriverAuditSupabaseCanary({ operation: 'enable', plan: value }, f.ex);
  const folder = f.local('/var/lib/matter-driver-reports-canary'), backup = path.join(folder, value.planSha256 + '.json');
  const saved = JSON.parse(await fs.readFile(backup)); assert.deepEqual(saved.plan.before, value.before);
  assert.equal((await fs.stat(folder)).mode & 0o777, 0o700); assert.equal((await fs.stat(backup)).mode & 0o777, 0o600);
  assert(f.synced.includes('/var/lib/matter-driver-reports-canary'));
  assert.deepEqual(f.commands.map(row => [row.file, row.args]), [
    ['/usr/sbin/nginx', ['-t', '-c', '/etc/nginx/nginx.conf']],
    ['/usr/sbin/nginx', ['-s', 'reload', '-c', '/etc/nginx/nginx.conf']],
  ]);
  for (const row of f.commands) { assert.equal(row.options.cwd, '/'); assert.deepEqual(Object.keys(row.options.env).sort(), ['LANG', 'PATH']); }
  await subject.executeDriverAuditSupabaseCanary({ operation: 'seal-entry', plan: value }, f.ex);
  await subject.executeDriverAuditSupabaseCanary({ operation: 'restore', plan: value }, f.ex);
  assert.deepEqual(await fs.readFile(f.local('/etc/nginx/nginx.conf')), main);
  assert.deepEqual(await fs.readFile(f.local('/etc/nginx/sites-available/matter')), site);
  assert.equal((await fs.stat(f.local('/etc/nginx/nginx.conf'))).mode & 0o777, 0o644);
  assert.equal(await fs.readlink(f.local('/etc/nginx/sites-enabled/matter')), '../sites-available/matter');
  assert((await fs.readdir(folder)).includes(value.planSha256 + '.json'));
});

test('temporary config creation remains attached to its opened parent when the named directory is replaced', async t => {
  const f = await fixedExecutor(t), outside = path.join(f.root, 'outside'), original = f.filesystem.open;
  await fs.mkdir(outside, { mode: 0o700 }); let swapped = false;
  f.filesystem.open = async (file, ...args) => {
    if (!swapped && path.basename(file).startsWith('.matter-canary-')) {
      swapped = true; await fs.rename(f.local('/etc/nginx'), f.local('/etc/nginx.saved'));
      await fs.symlink(outside, f.local('/etc/nginx'));
    }
    return original(file, ...args);
  };
  await assert.rejects(subject.executeDriverAuditSupabaseCanary({ operation: 'enable', plan: plan() }, f.ex));
  assert(swapped, 'The fixture must reach the actual temporary-file open boundary');
  assert(!f.openedPhysicalPaths.some(file => file.startsWith(outside + path.sep)), 'No temporary file may be created through the replacement alias');
  assert.deepEqual(await fs.readdir(outside), []);
  assert(!(await fs.readdir(f.local('/etc/nginx.saved'))).some(name => name.startsWith('.matter-canary-')));
});

test('missing durable backup-directory sync aborts before changing Nginx configuration', async t => {
  const f = await fixedExecutor(t); f.failBackupSync();
  await assert.rejects(subject.executeDriverAuditSupabaseCanary({ operation: 'enable', plan: plan() }, f.ex));
  assert.deepEqual(await fs.readFile(f.local('/etc/nginx/nginx.conf')), main);
  assert.deepEqual(await fs.readFile(f.local('/etc/nginx/sites-available/matter')), site);
  assert.equal(f.commands.length, 0);
});

test('fixed executor releases its exclusion receipt even when closing it reports failure', async t => {
  const f = await fixedExecutor(t); f.failLockClose();
  await assert.rejects(subject.executeDriverAuditSupabaseCanary({ operation: 'enable', plan: plan() }, f.ex));
  await assert.rejects(fs.access(f.local('/var/lib/matter-driver-reports-canary/operator.lock')), { code: 'ENOENT' });
});

test('fixed executor rejects non-root invocation and unsafe file ownership or symlinks without modifying targets', async t => {
  const ex = subject.createDriverAuditSupabaseCanaryExecutor({ uid: () => 123, platform: 'linux' });
  await assert.rejects(ex.withLock(async () => assert.fail('Nonroot callback')));
  const f = await fixedExecutor(t); f.wrongOwner(); await assert.rejects(f.ex.read()); assert.equal(f.mutations.length, 0);
  const g = await fixedExecutor(t), target = g.local('/etc/nginx/sites-available/matter'), independent = g.local('/independent');
  await fs.writeFile(independent, 'independent bytes'); await fs.unlink(target); await fs.symlink(independent, target);
  await assert.rejects(g.ex.read()); assert.equal(await fs.readFile(independent, 'utf8'), 'independent bytes'); assert.equal(g.mutations.length, 0);
});

test('generated Nginx map admits only the selector, actual report paths and bounded server epoch seconds', () => {
  const value = plan(), text = Buffer.from(value.enabled.main, 'base64').toString();
  const expressions = content => [...content.matchAll(/"~(\^[^"\n]+)" 1;/g)].map(match => new RegExp(match[1].replaceAll('\\\\', '\\')));
  const route = expressions(text.split('map "$cookie_matter_driver_reports_canary:$msec:$uri" $matter_driver_reports_canary {\n')[1].split('\n}\n')[0]);
  const entry = expressions(text.split('map $msec $matter_driver_reports_canary_entry {\n')[1].split('\n}\n')[0]);
  assert(route.length > 0 && entry.length > 0);
  const now = Date.parse(issuedAt) / 1000;
  for (const uri of ['/driver-audit-view', '/api/driver-audits/session', '/api/session', '/api/session/refresh',
    '/api/reporting/reviews', '/report-data/snapshot-' + 'c'.repeat(64) + '.json', '/report-assets/font-' + 'd'.repeat(64) + '.woff2']) {
    assert(route.some(expression => expression.test(value.selector + ':' + now + '.123:' + uri)), uri);
  }
  for (const [cookie, second, uri] of [[value.selector, now - 1, '/api/reporting/status'], [value.selector, now + 120, '/api/reporting/status'],
    ['c'.repeat(64), now, '/api/reporting/status'], [value.selector, now, '/api/deliveries'],
    [value.selector, now, '/api/auth/me'], [value.selector, now, '/driver-reports'], [value.selector, now, '/api/reporting-else/status']]) {
    assert(!route.some(expression => expression.test(cookie + ':' + second + '.123:' + uri)));
  }
  assert(entry.some(expression => expression.test(now + '.999')));
  assert(!entry.some(expression => expression.test(now + 120 + '.000')));
});

test('default and maximum canary windows use bounded Nginx tokens with no gap or extended expiry', () => {
  for (const ttlSeconds of [60, 120, 600, 900]) {
    const value = ttlSeconds === 600
      ? subject.createDriverAuditSupabaseCanaryPlan({ main, site, selector: 'a'.repeat(64), entryNonce: 'b'.repeat(64), issuedAt }, { hashes })
      : plan({ ttlSeconds });
    const text = Buffer.from(value.enabled.main, 'base64').toString();
    const tokens = [...text.matchAll(/"~(\^[^"\n]+)" 1;/g)];
    assert(tokens.length > 0);
    // Nginx's configuration reader rejects a single 4096-byte parameter.
    for (const token of tokens) assert(Buffer.byteLength(token[0]) < 1024, 'Each generated regex must remain well below the parser limit');
    const route = tokens.map(token => new RegExp(token[1])).filter(expression => expression.source.includes(value.selector));
    const entry = tokens.map(token => new RegExp(token[1])).filter(expression => !expression.source.includes(value.selector));
    const start = Date.parse(issuedAt) / 1000;
    for (let offset = -1; offset <= ttlSeconds; offset++) {
      const expected = offset >= 0 && offset < ttlSeconds, second = start + offset;
      assert.equal(route.some(expression => expression.test(value.selector + ':' + second + '.500:/api/reporting/status')), expected);
      assert.equal(entry.some(expression => expression.test(second + '.500')), expected);
    }
  }
});

test('unreviewed inputs, executable selectors and unbounded windows cannot produce an applicable plan', () => {
  for (const changes of [{ main: Buffer.from('unreviewed') }, { site: Buffer.from('unreviewed') }, { selector: '${bad};' },
    { entryNonce: 'a'.repeat(64) }, { ttlSeconds: 901 }, { ttlSeconds: 0 }, { issuedAt: '2026-11-17T15:00:00.123Z' }]) {
    assert.throws(() => plan(changes));
  }
});

test('enable, explicit entry sealing and restoration are separate exact operations without clock renewal', async () => {
  const value = plan(), ex = executor();
  const result = await subject.executeDriverAuditSupabaseCanary({ operation: 'enable', plan: value }, ex);
  assert.equal(result.authGranted, false); assert.equal(result.defaultRoutingChanged, false); assert.equal(result.liveRoutingVerified, false);
  assert.equal(ex.files.main.mode, 0o600); assert.equal(ex.files.site.mode, 0o600);
  assert.deepEqual(ex.calls.slice(-2), ['test', 'reload']);
  ex.now = () => Date.parse(value.expiresAt) + 1000;
  await subject.executeDriverAuditSupabaseCanary({ operation: 'seal-entry', plan: value }, ex);
  assert.equal(sha(ex.files.site.bytes), sha(Buffer.from(value.sealed.site, 'base64')));
  assert.equal(value.expiresAt, '2026-11-17T15:02:00.000Z');
  await subject.executeDriverAuditSupabaseCanary({ operation: 'restore', plan: value }, ex);
  assert.deepEqual(ex.files.main, { bytes: main, mode: 0o644 }); assert.deepEqual(ex.files.site, { bytes: site, mode: 0o644 });
  assert.equal(ex.isLocked(), false);
});

test('partial replacement, nginx test failure or reload failure restore exact original bytes and modes', async () => {
  for (const failure of ['write-site', 'test', 'reload']) {
    const value = plan(), ex = executor(); ex.fail(failure);
    await assert.rejects(subject.executeDriverAuditSupabaseCanary({ operation: 'enable', plan: value }, ex), error =>
      error.message === 'Driver Reports canary change stopped' && error.rollbackRestored === true && !error.message.includes('private'));
    assert.deepEqual(ex.files.main, { bytes: main, mode: 0o644 }); assert.deepEqual(ex.files.site, { bytes: site, mode: 0o644 });
    assert.equal(ex.isLocked(), false);
  }
});

test('an independent configuration edit blocks rollback rather than being overwritten', async () => {
  const value = plan(), ex = executor(), independent = Buffer.from('independent configuration');
  ex.fail('test', () => { ex.files.site = { bytes: independent, mode: 0o644 }; });
  await assert.rejects(subject.executeDriverAuditSupabaseCanary({ operation: 'enable', plan: value }, ex), error =>
    error.rollbackRestored === false && error.rollbackBlocked === true);
  assert.deepEqual(ex.files.site.bytes, independent); assert.equal(ex.isLocked(), false);
});

test('configuration drift during successful test or reload cannot receive a success or be overwritten', async () => {
  for (const phase of ['test', 'reload']) {
    const value = plan(), ex = executor(), run = ex[phase], independent = Buffer.from('independent valid configuration');
    ex[phase] = async () => { await run(); ex.files.site = { bytes: independent, mode: 0o644 }; };
    await assert.rejects(subject.executeDriverAuditSupabaseCanary({ operation: 'enable', plan: value }, ex), error => error.rollbackBlocked === true);
    assert.deepEqual(ex.files.site.bytes, independent);
    if (phase === 'test') assert(!ex.calls.includes('reload'));
  }
});

test('an expired, changed or unrelated plan is rejected before any configuration write', async () => {
  for (const kind of ['expired', 'changed', 'operation', 'foreign-current']) {
    const value = plan(), ex = executor();
    if (kind === 'expired') ex.now = () => Date.parse(value.expiresAt);
    if (kind === 'changed') value.selector = 'c'.repeat(64);
    if (kind === 'foreign-current') ex.files.site.bytes = Buffer.from('independent configuration');
    await assert.rejects(subject.executeDriverAuditSupabaseCanary({ operation: kind === 'operation' ? 'general-switch' : 'enable', plan: value }, ex));
    assert.equal(ex.calls.length, 0); assert.equal(ex.isLocked(), false);
  }
});
