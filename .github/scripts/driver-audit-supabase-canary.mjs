import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const need = value => { if (!value) throw Error('Canary guard failed'); };
const hashes = Object.freeze({ main: '4869cddce1030ceffb99bf88b1a64a0ec2b5d51c0c2377958f48533bae320522',
  site: 'ed8843629e6f3bde5231d4203be232f0835667b0fa51471e94fce8f5bc565a18' });
const files = Object.freeze({ main: '/etc/nginx/nginx.conf', site: '/etc/nginx/sites-available/matter' });
const link = '/etc/nginx/sites-enabled/matter', storage = '/var/lib/matter-driver-reports-canary';
const signature = info => [info.dev, info.ino, info.uid, info.gid, info.mode, info.size, info.mtimeNs, info.ctimeNs].map(String).join(':');
const identity = info => [info.dev, info.ino, info.uid, info.gid, info.mode].map(String).join(':');
const decode = value => Buffer.from(value, 'base64');
const block = (kind, body, indentation = '') => indentation + '# BEGIN MATTER REPORTS CANARY ' + kind + '\n'
  + body + indentation + '# END MATTER REPORTS CANARY ' + kind + '\n';
const once = (text, needle, replacement) => { need(text.split(needle).length === 2); return text.replace(needle, replacement); };

// The plan and diff contain the private selector/configuration. Store or seal
// them privately; the executing functions return only status and hashes.
export function createDriverAuditSupabaseCanaryPlan({ main, site, selector = randomBytes(32).toString('hex'),
  entryNonce = randomBytes(32).toString('hex'), issuedAt = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(), ttlSeconds = 600 }, adapters = {}) {
  const pins = adapters.hashes ?? hashes;
  need(Buffer.isBuffer(main) && Buffer.isBuffer(site) && main.length <= 128 * 1024 && site.length <= 128 * 1024
    && sha(main) === pins.main && sha(site) === pins.site && /^[a-f0-9]{64}$/.test(selector)
    && /^[a-f0-9]{64}$/.test(entryNonce) && selector !== entryNonce && Number.isInteger(ttlSeconds) && ttlSeconds >= 60 && ttlSeconds <= 900);
  const start = Date.parse(issuedAt); need(Number.isFinite(start) && start % 1000 === 0 && new Date(start).toISOString() === issuedAt);
  const expiresAt = new Date(start + ttlSeconds * 1000).toISOString();
  // Nginx rejects a single 4096-byte configuration token. Keep each exact
  // epoch allowlist row small instead of growing one token with the window.
  // https://github.com/nginx/nginx/blob/release-1.18.0/src/core/ngx_conf_file.c
  const epochs = Array.from({ length: Math.ceil(ttlSeconds / 60) }, (_, chunk) =>
    Array.from({ length: Math.min(60, ttlSeconds - chunk * 60) }, (_, i) => start / 1000 + chunk * 60 + i).join('|'));
  const scope = '(?:/driver-audit-view|/api/driver-audits/session|/api/session(?:/refresh)?|/api/reporting/.*|/report-data/.*|/report-assets/.*)';
  const map = block('MAP', 'map "$cookie_matter_driver_reports_canary:$msec:$uri" $matter_driver_reports_canary {\n'
    + '    default 0;\n' + epochs.map(epoch => '    "~^' + selector + ':(?:' + epoch + ')[.][0-9]+:' + scope + '$" 1;\n').join('') + '}\n'
    + 'map $msec $matter_driver_reports_canary_entry {\n    default 0;\n'
    + epochs.map(epoch => '    "~^(?:' + epoch + ')[.][0-9]+$" 1;\n').join('') + '}\n');
  const originalMain = main.toString('utf8'), originalSite = site.toString('utf8');
  need(Buffer.from(originalMain).equals(main) && Buffer.from(originalSite).equals(site)
    && !originalMain.includes('MATTER REPORTS CANARY') && !originalSite.includes('MATTER REPORTS CANARY'));
  const enabledMain = once(originalMain, 'http {\n', 'http {\n' + map);
  const gate = block('GATE', '        error_page 418 = @matter_driver_reports_canary;\n'
    + '        if ($matter_driver_reports_canary = 1) { return 418; }\n', '        ');
  let sealedSite = once(originalSite, '    location / {\n', '    location / {\n' + gate);
  sealedSite = once(sealedSite, '    location /api/ {\n', '    location /api/ {\n' + gate);
  const api = originalSite.split('    location /api/ {\n')[1]?.split('\n    }\n')[0];
  need(api?.includes('proxy_pass http://127.0.0.1:5000/api/;'));
  const proxyHeaders = api.split('\n').filter(line => /^        proxy_(?:http_version|set_header|cache_bypass) /.test(line)).join('\n');
  need(proxyHeaders.includes('proxy_set_header Host $host;') && proxyHeaders.includes('proxy_set_header X-Forwarded-Proto $scheme;'));
  // A named error redirect preserves POST/URI; proxy_pass without a URI keeps
  // the original full path and arguments. No regex location or variable URI.
  // https://nginx.org/en/docs/http/ngx_http_core_module.html#error_page
  // https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass
  const proxy = block('PROXY', '    location @matter_driver_reports_canary {\n'
    + '        proxy_pass http://127.0.0.1:5002;\n' + proxyHeaders + '\n    }\n', '    ');
  need(sealedSite.endsWith('}\n')); sealedSite = sealedSite.slice(0, -2) + proxy + '}\n';
  const inheritedHeaders = originalSite.slice(0, originalSite.indexOf('    location / {\n')).split('\n')
    .filter(line => /^    add_header /.test(line)).map(line => '    ' + line).join('\n');
  need(inheritedHeaders.includes('X-Frame-Options') && inheritedHeaders.includes('Strict-Transport-Security'));
  // add_header on the entry disables ordinary inherited headers; repeat the
  // exact server directives there, preserving the inspected security policy.
  // https://nginx.org/en/docs/http/ngx_http_headers_module.html#add_header
  const entryPath = '/_matter-driver-reports-canary/' + entryNonce;
  const entry = block('ENTRY', '    location = ' + entryPath + ' {\n'
    + '        if ($request_method != GET) { return 404; }\n'
    + '        if ($matter_driver_reports_canary_entry != 1) { return 404; }\n' + inheritedHeaders + '\n'
    + '        add_header Set-Cookie "matter_driver_reports_canary=' + selector + '; Path=/; Max-Age=' + ttlSeconds + '; Secure; HttpOnly; SameSite=Strict" always;\n'
    + '        add_header Cache-Control "no-store" always;\n        add_header Referrer-Policy "no-referrer" always;\n'
    + '        return 303 /driver-reports;\n    }\n', '    ');
  const enabledSite = sealedSite.slice(0, -2) + entry + '}\n';
  const value = { version: 1, kind: 'supabase-browser-canary-plan-v1', issuedAt, expiresAt, ttlSeconds, selector, entryNonce, entryPath,
    before: { main: main.toString('base64'), site: site.toString('base64') },
    enabled: { main: Buffer.from(enabledMain).toString('base64'), site: Buffer.from(enabledSite).toString('base64') },
    sealed: { main: Buffer.from(enabledMain).toString('base64'), site: Buffer.from(sealedSite).toString('base64') } };
  return { ...value, planSha256: sha(JSON.stringify(value)) };
}

export function driverAuditSupabaseCanaryDiff(plan) {
  return Object.keys(files).map(name => {
    const before = decode(plan.before[name]).toString().split('\n'), after = decode(plan.enabled[name]).toString().split('\n');
    let a = 0, b = 0;
    while (a < before.length && before[a] === after[a]) a++;
    while (b < before.length - a && before[before.length - 1 - b] === after[after.length - 1 - b]) b++;
    return '--- ' + files[name] + '\n+++ ' + files[name] + '\n@@ -' + (a + 1) + ',' + (before.length - a - b)
      + ' +' + (a + 1) + ',' + (after.length - a - b) + ' @@\n'
      + before.slice(a, before.length - b).map(line => '-' + line).join('\n') + '\n'
      + after.slice(a, after.length - b).map(line => '+' + line).join('\n') + '\n';
  }).join('\n');
}

export async function executeDriverAuditSupabaseCanary({ operation, plan }, executor = createDriverAuditSupabaseCanaryExecutor()) {
  need(['enable', 'seal-entry', 'restore'].includes(operation));
  const verified = createDriverAuditSupabaseCanaryPlan({ main: decode(plan.before.main), site: decode(plan.before.site),
    selector: plan.selector, entryNonce: plan.entryNonce, issuedAt: plan.issuedAt, ttlSeconds: plan.ttlSeconds }, { hashes: executor.hashes ?? hashes });
  need(JSON.stringify(verified) === JSON.stringify(plan));
  if (operation === 'enable') need(Date.parse(plan.issuedAt) <= executor.now() && executor.now() < Date.parse(plan.expiresAt));
  return executor.withLock(async () => {
    const known = name => ['before', 'enabled', 'sealed'].map(phase => sha(decode(plan[phase][name])));
    const readKnown = async () => {
      const result = await executor.read();
      for (const name of Object.keys(files)) need(known(name).includes(result[name].sha256));
      return result;
    };
    const initial = await readKnown(), isOriginal = Object.keys(files).every(name => initial[name].sha256 === sha(decode(plan.before[name])));
    need(operation !== 'seal-entry' || !isOriginal);
    const backup = await executor.backup(plan, isOriginal);
    const verifyVariant = async variant => {
      const after = await executor.read();
      for (const name of Object.keys(files)) need(after[name].sha256 === sha(decode(plan[variant][name]))
        && after[name].mode === (variant === 'before' ? backup.modes[name] : 0o600));
    };
    const writeVariant = async variant => {
      const before = await readKnown();
      for (const name of Object.keys(files)) {
        const bytes = decode(plan[variant][name]), mode = variant === 'before' ? backup.modes[name] : 0o600;
        if (before[name].sha256 !== sha(bytes) || before[name].mode !== mode) await executor.replace(name, before[name], bytes, mode);
      }
      await verifyVariant(variant);
    };
    const verifyAndReload = async variant => {
      await executor.test(); await verifyVariant(variant); await executor.reload(); await verifyVariant(variant);
    };
    try {
      const variant = operation === 'enable' ? 'enabled' : operation === 'seal-entry' ? 'sealed' : 'before';
      await writeVariant(variant); await verifyAndReload(variant);
      return { status: operation, planSha256: plan.planSha256, expiresAt: plan.expiresAt, entrySealed: operation !== 'enable',
        authGranted: false, defaultRoutingChanged: false, reloadRequested: true, liveRoutingVerified: false };
    } catch {
      let restored = false;
      try { await writeVariant('before'); await verifyAndReload('before'); restored = true; } catch { /* Preserve independent edits and private backup. */ }
      throw Object.assign(Error('Driver Reports canary change stopped'), { rollbackRestored: restored, rollbackBlocked: !restored });
    }
  });
}

// This executor has no configurable file, command, profile, environment or port.
// Adapters are exclusively a local test boundary. Live mutation requires UID0.
export function createDriverAuditSupabaseCanaryExecutor(adapters = {}) {
  const io = adapters.filesystem ?? fs, uid = adapters.uid ?? (() => process.getuid()), platform = adapters.platform ?? process.platform;
  const command = adapters.exec ?? promisify(execFile);
  const root = () => need(uid() === 0 && platform === 'linux');
  const directory = async (folder, privateMode = false) => {
    const stat = await io.lstat(folder, { bigint: true });
    need(stat.isDirectory() && stat.uid === 0n && !(Number(stat.mode) & (privateMode ? 0o077 : 0o022)) && await io.realpath(folder) === folder);
    return stat;
  };
  const read = async (file, privateMode = false) => {
    const before = await io.lstat(file, { bigint: true });
    need(before.isFile() && before.uid === 0n && !(Number(before.mode) & (privateMode ? 0o077 : 0o022))
      && before.size > 0n && before.size <= 128n * 1024n && await io.realpath(file) === file);
    const handle = await io.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      need(signature(await handle.stat({ bigint: true })) === signature(before));
      const bytes = Buffer.alloc(Number(before.size));
      for (let offset = 0; offset < bytes.length;) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset); need(bytesRead > 0); offset += bytesRead;
      }
      need((await handle.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead === 0
        && signature(await handle.stat({ bigint: true })) === signature(before)
        && signature(await io.lstat(file, { bigint: true })) === signature(before) && await io.realpath(file) === file);
      return { bytes, sha256: sha(bytes), mode: Number(before.mode) & 0o777, gid: Number(before.gid), signature: signature(before) };
    } finally { await handle.close(); }
  };
  const pointer = async () => {
    for (const folder of ['/etc/nginx', '/etc/nginx/sites-enabled', '/etc/nginx/sites-available']) await directory(folder);
    const stat = await io.lstat(link, { bigint: true }), target = await io.readlink(link);
    need(stat.isSymbolicLink() && stat.uid === 0n && ['../sites-available/matter', files.site].includes(target) && await io.realpath(link) === files.site);
    return { signature: signature(stat), target };
  };
  const syncDirectory = async folder => {
    const before = await directory(folder), handle = await io.open(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      need(identity(await handle.stat({ bigint: true })) === identity(before)); await handle.sync();
      need(identity(await io.lstat(folder, { bigint: true })) === identity(before) && await io.realpath(folder) === folder);
    } finally { await handle.close(); }
  };
  const atomic = async (file, bytes, mode, expected, gid = 0) => {
    root(); need(Buffer.isBuffer(bytes) && bytes.length <= 128 * 1024 && Number.isInteger(mode) && !(mode & ~0o777) && !(mode & 0o022));
    const folder = path.dirname(file), before = await directory(folder), handle = await io.open(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const anchored = '/proc/self/fd/' + handle.fd;
    const temporary = path.join(anchored, '.matter-canary-' + randomUUID() + '.tmp'); let created = false;
    try {
      need(identity(await handle.stat({ bigint: true })) === identity(before));
      if (expected) need((await read(file)).signature === expected.signature);
      const temp = await io.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); created = true;
      try { await temp.writeFile(bytes); await temp.chown(0, gid); await temp.chmod(mode); await temp.sync(); } finally { await temp.close(); }
      need(identity(await io.lstat(folder, { bigint: true })) === identity(before) && await io.realpath(folder) === folder);
      if (expected) need((await read(file)).signature === expected.signature);
      await io.rename(temporary, path.join(anchored, path.basename(file))); created = false; await handle.sync();
      need((await read(file)).sha256 === sha(bytes) && identity(await io.lstat(folder, { bigint: true })) === identity(before));
    } finally { if (created) await io.unlink(temporary); await handle.close(); }
  };
  return { hashes, now: () => Date.now(),
    async read() {
      const before = await pointer(), main = await read(files.main), site = await read(files.site);
      need(JSON.stringify(await pointer()) === JSON.stringify(before)); return { main, site };
    },
    async withLock(operation) {
      root(); await directory('/var/lib');
      await io.mkdir(storage, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; }); await directory(storage, true);
      await syncDirectory('/var/lib');
      const file = path.join(storage, 'operator.lock'), handle = await io.open(file, 'wx', 0o600);
      const locked = identity(await handle.stat({ bigint: true }));
      try { return await operation(); }
      finally {
        try { await handle.close(); }
        finally { need(identity(await io.lstat(file, { bigint: true })) === locked); await io.unlink(file); }
      }
    },
    async backup(plan, mayCreate) {
      root(); need(/^[a-f0-9]{64}$/.test(plan.planSha256)); const file = path.join(storage, plan.planSha256 + '.json');
      let saved = await read(file, true).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!saved) {
        need(mayCreate); const current = { main: await read(files.main), site: await read(files.site) }, modes = {};
        for (const name of Object.keys(files)) { need(current[name].bytes.equals(decode(plan.before[name]))); modes[name] = current[name].mode; }
        const bytes = Buffer.from(JSON.stringify({ version: 1, plan, modes, pointer: await pointer() }));
        need(bytes.length <= 128 * 1024); const handle = await io.open(file, 'wx', 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        saved = await read(file, true);
      }
      await syncDirectory(storage);
      const value = JSON.parse(saved.bytes); need(JSON.stringify(value.plan) === JSON.stringify(plan)
        && JSON.stringify(value.pointer) === JSON.stringify(await pointer())); return { modes: value.modes, backupSha256: saved.sha256 };
    },
    async replace(name, expected, bytes, mode) {
      root(); need(Object.hasOwn(files, name)); await pointer(); const current = await read(files[name]);
      need(current.sha256 === expected.sha256 && current.signature === expected.signature); await atomic(files[name], bytes, mode, current, current.gid);
    },
    async test() { root(); await command('/usr/sbin/nginx', ['-t', '-c', files.main], { cwd: '/', env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' }, timeout: 10000, maxBuffer: 65536 }); },
    async reload() { root(); await command('/usr/sbin/nginx', ['-s', 'reload', '-c', files.main], { cwd: '/', env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' }, timeout: 10000, maxBuffer: 65536 }); },
  };
}
