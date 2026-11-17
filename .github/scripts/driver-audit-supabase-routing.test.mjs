import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { sealTransferSecrets, openTransferSecrets } from '../../server/services/driverAuditTransferCodec.js';
import { acquireWorkerLock } from '../../server/vendor/driver-audits/integration/hosted/worker-lock.mjs';

const operator = await import('./driver-audit-supabase-routing.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const appSha = '701655794e1711b4d8c737e929360ecfe5d2f0ca';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
const recipientPublicKey = publicKey.export({ type: 'spki', format: 'pem' });

async function fixture(t) {
  const appRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'supabase-routing-')));
  t.after(() => fs.rm(appRoot, { recursive: true, force: true }));
  const server = path.join(appRoot, 'server'), nginxRoot = path.join(appRoot, 'nginx');
  const lockRoot = path.join(server, '.private/driver-report-supabase-handoff');
  await fs.mkdir(lockRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(nginxRoot, 'sites-enabled'), { recursive: true, mode: 0o755 });
  await fs.mkdir(path.join(nginxRoot, 'sites-available'), { mode: 0o755 });
  const mainFile = path.join(nginxRoot, 'nginx.conf'), siteFile = path.join(nginxRoot, 'sites-available/matter');
  const linkFile = path.join(nginxRoot, 'sites-enabled/matter');
  const secret = 'fictional-private-provider-value';
  const main = Buffer.from('events {}\nhttp { include sites-enabled/*; }\n');
  const site = Buffer.from('server { server_name fixture.example.invalid; add_header X-Private "' + secret
    + '"; location /api/ { proxy_pass http://127.0.0.1:5000; } }\n');
  await fs.writeFile(mainFile, main, { mode: 0o644 });
  await fs.writeFile(siteFile, site, { mode: 0o644 });
  await fs.symlink('../sites-available/matter', linkFile);
  const rows = [
    { name: 'matter-delivery-api', pm_id: 1, pid: 123, pm2_env: { status: 'online', pm_cwd: appRoot,
      pm_exec_path: '/usr/bin/npm', args: ['start', '--prefix', 'server'], pm_uptime: 12345,
      env: { MONGODB_URI: secret, JWT_SECRET: secret } } },
    { name: 'matter-driver-audit-sync', pm_id: 2, pid: 0, pm2_env: { status: 'stopped', pm_cwd: server,
      pm_exec_path: path.join(server, 'scripts/driverAuditSync.js'),
      args: ['--config', path.join(server, '.private/driver-audits', 'b'.repeat(64), 'sync.json')] } },
  ];
  const calls = [], loads = [], opened = [];
  let owned = true, observations = 0;
  const filesystem = {
    ...fs,
    async lstat(file, options) {
      const value = await fs.lstat(file, options);
      if (String(file).startsWith(nginxRoot)) value.uid = options?.bigint ? (owned ? 0n : 42n) : owned ? 0 : 42;
      return value;
    },
    async open(file, ...args) {
      opened.push(String(file)); const handle = await fs.open(file, ...args), stat = handle.stat.bind(handle);
      handle.stat = async options => {
        const value = await stat(options); value.uid = options?.bigint ? (owned ? 0n : 42n) : owned ? 0 : 42; return value;
      };
      return handle;
    },
  };
  const adapters = { platform: 'linux', nginxRoot, filesystem,
    nginxHashes: { main: sha(main), site: sha(site) },
    async exec(file, args) {
      calls.push({ file, args });
      if (file === 'git') return { stdout: args[0] === 'rev-parse' ? appSha + '\n' : '' };
      assert.equal(file, 'pm2'); assert.deepEqual(args, ['jlist']); observations++;
      return { stdout: JSON.stringify(rows) };
    },
    async load(name) {
      loads.push(name);
      if (name === 'services/driverAuditTransferCodec.js') return { sealTransferSecrets };
      if (name === 'vendor/driver-audits/integration/hosted/worker-lock.mjs') return { acquireWorkerLock };
      throw Error('Unexpected module: ' + name);
    },
    async systemFile() { return { realpath: '/usr/share/nodejs/npm/bin/npm-cli.js', uid: 0,
      mode: 0o100644, bytes: 1000, sha256: 'f'.repeat(64) }; },
  };
  const run = changes => {
    assert.equal(typeof operator.runDriverAuditSupabaseRouting, 'function');
    return operator.runDriverAuditSupabaseRouting({ operation: 'inspect-supabase-routing', appRoot,
      expectedSha: appSha, recipientPublicKey, ...changes }, adapters);
  };
  return { appRoot, server, lockRoot, nginxRoot, mainFile, siteFile, linkFile, main, site, secret, rows,
    calls, loads, opened, adapters, run, setOwned(value) { owned = value; }, observations: () => observations };
}

function unseal(result) {
  const capsule = openTransferSecrets(privateKey, result.capsule);
  const compressed = Buffer.from(capsule.metadataGzipBase64, 'base64');
  assert.equal(sha(compressed), capsule.metadataGzipSha256);
  const bytes = gunzipSync(compressed); assert.equal(sha(bytes), result.metadataSha256);
  return JSON.parse(bytes);
}

test('routing inspection seals exact pinned files and link without publishing config or PM2 environment', async t => {
  const f = await fixture(t), result = await f.run(), saved = unseal(result);
  assert.equal(result.status, 'supabase-routing-inspected'); assert.equal(result.readOnly, true);
  assert.equal(result.routingChanged, false); assert.equal(result.workersStarted, false);
  assert.equal(result.applicationDatabaseConnections, 0); assert.equal(result.networkRequests, 0);
  assert.equal(saved.applicationCommit, appSha);
  assert.equal(saved.nginx.files.length, 2);
  assert.deepEqual(saved.nginx.files.map(row => Buffer.from(row.contentBase64, 'base64')), [f.main, f.site]);
  assert.equal(saved.nginx.link.target, '../sites-available/matter');
  const plain = JSON.stringify(result), metadata = JSON.stringify(saved);
  for (const value of [f.secret, f.appRoot, 'fixture.example.invalid', 'proxy_pass', 'MONGODB_URI', 'JWT_SECRET']) assert(!plain.includes(value));
  assert(!metadata.includes('MONGODB_URI')); assert(!metadata.includes('JWT_SECRET'));
  assert(f.calls.every(call => call.file === 'git' || call.file === 'pm2' && call.args.join() === 'jlist'));
  assert(f.loads.every(name => !/Mongo|DataBackend|loadEnv|supabase/i.test(name)));
  assert.deepEqual(await fs.readFile(f.mainFile), f.main); assert.deepEqual(await fs.readFile(f.siteFile), f.site);
  await assert.rejects(fs.access(path.join(f.lockRoot, 'operator.lock')), { code: 'ENOENT' });
});

test('unsupported hosts, checkout identity and recipients fail before opening Nginx or loading a database', async t => {
  for (const mutate of [f => { f.adapters.platform = 'darwin'; }, f => { f.adapters.exec = async () => ({ stdout: 'a'.repeat(40) }); },
    f => { f.adapters.exec = async () => { throw Error(f.secret); }; }]) {
    const f = await fixture(t); mutate(f);
    await assert.rejects(f.run(), error => /^Supabase routing inspection stopped at [a-z-]+$/.test(error.message) && !error.message.includes(f.secret));
    assert.deepEqual(f.opened, []);
  }
  for (const changes of [{ expectedSha: 'a'.repeat(40) }, { recipientPublicKey: 'PRIVATE KEY forbidden' }, { operation: 'reload-nginx' }]) {
    const f = await fixture(t); await assert.rejects(f.run(changes), /Supabase routing inspection stopped at inputs/);
    assert.equal(f.observations(), 0);
  }
});

test('only the exact online NPM business registration and stopped old sync with absent source are accepted', async t => {
  for (const mutate of [f => { f.rows.push(structuredClone(f.rows[0])); }, f => { f.rows[0].pm2_env.args = ['start']; },
    f => { f.rows[0].pm2_env.pm_exec_path = '/tmp/npm'; }, f => { f.rows[1].pid = 987; f.rows[1].pm2_env.status = 'online'; },
    f => { f.rows[1].pm2_env.args[1] = '/tmp/arbitrary/sync.json'; },
    f => { f.rows.push({ name: 'matter-driver-audit-source', pid: 0, pm2_env: { status: 'stopped' } }); },
    f => { f.rows.push({ name: 'matter-driver-reports-api', pid: 0, pm2_env: { status: 'stopped' } }); }]) {
    const f = await fixture(t); mutate(f); await assert.rejects(f.run(), /Supabase routing inspection stopped at workers/);
    assert.deepEqual(f.opened, []);
  }
});

test('wrong hashes, unsafe ownership or writable configuration fail closed without raw diagnostics', async t => {
  for (const mutate of [f => f.adapters.nginxHashes.main = '0'.repeat(64), f => f.adapters.nginxHashes.site = '0'.repeat(64),
    f => f.setOwned(false), async f => fs.chmod(f.mainFile, 0o666), async f => fs.chmod(f.siteFile, 0o664)]) {
    const f = await fixture(t); await mutate(f);
    await assert.rejects(f.run(), error => /^Supabase routing inspection stopped at nginx-[a-z-]+$/.test(error.message)
      && !JSON.stringify(error).includes(f.secret) && !error.message.includes(f.nginxRoot));
  }
});

test('configuration or symlink redirection cannot read an unapproved target', async t => {
  for (const kind of ['main-link', 'site-link', 'wrong-pointer', 'parent-link']) {
    const f = await fixture(t), outside = path.join(f.appRoot, 'outside-private');
    await fs.writeFile(outside, f.secret);
    if (kind === 'main-link') { await fs.unlink(f.mainFile); await fs.symlink(outside, f.mainFile); }
    if (kind === 'site-link') { await fs.unlink(f.siteFile); await fs.symlink(outside, f.siteFile); }
    if (kind === 'wrong-pointer') { await fs.unlink(f.linkFile); await fs.symlink(outside, f.linkFile); }
    if (kind === 'parent-link') {
      const available = path.join(f.nginxRoot, 'sites-available'), moved = path.join(f.nginxRoot, 'moved');
      await fs.rename(available, moved); await fs.symlink(moved, available);
    }
    await assert.rejects(f.run(), /Supabase routing inspection stopped at nginx-/);
    assert(!f.opened.includes(outside));
  }
});

test('truncation, opened-file changes and oversized configurations cannot produce an inspection receipt', async t => {
  for (const kind of ['truncated', 'changed', 'oversized']) {
    const f = await fixture(t), original = f.adapters.filesystem.open;
    if (kind === 'oversized') {
      const bytes = Buffer.alloc(128 * 1024 + 1, 65); await fs.writeFile(f.mainFile, bytes); f.adapters.nginxHashes.main = sha(bytes);
    } else f.adapters.filesystem.open = async (file, ...args) => {
      const handle = await original(file, ...args);
      if (file === f.mainFile) {
        const read = handle.read.bind(handle); let first = true;
        handle.read = async (...values) => {
          if (kind === 'truncated') return { bytesRead: 0 };
          const result = await read(...values);
          if (first) { first = false; await fs.appendFile(file, '# independent configuration edit\n'); }
          return result;
        };
      }
      return handle;
    };
    await assert.rejects(f.run(), /Supabase routing inspection stopped at nginx-/);
  }
});

test('post-read pointer, permissions, worker and checkout drift reject even after sealing', async t => {
  for (const kind of ['pointer', 'mode', 'worker', 'checkout']) {
    const f = await fixture(t), load = f.adapters.load, exec = f.adapters.exec;
    let drift = false;
    f.adapters.load = async name => {
      const value = await load(name);
      if (name !== 'services/driverAuditTransferCodec.js') return value;
      return { sealTransferSecrets(key, body) {
        drift = true;
        return sealTransferSecrets(key, body);
      } };
    };
    f.adapters.exec = async (file, args) => {
      if (drift) {
        if (kind === 'pointer') { drift = false; await fs.unlink(f.linkFile); await fs.symlink(f.siteFile, f.linkFile); }
        if (kind === 'mode') { drift = false; await fs.chmod(f.siteFile, 0o666); }
        if (kind === 'worker') { drift = false; f.rows[1].pid = 765; f.rows[1].pm2_env.status = 'online'; }
        if (kind === 'checkout' && file === 'git') return { stdout: 'a'.repeat(40) };
      }
      return exec(file, args);
    };
    await assert.rejects(f.run(), /Supabase routing inspection stopped at readback/);
  }
});

test('the existing operator lock excludes simultaneous preparation and is released after a failed inspection', async t => {
  const f = await fixture(t), held = await acquireWorkerLock(path.join(f.lockRoot, 'operator.lock'));
  await assert.rejects(f.run(), /Supabase routing inspection stopped at lock/); assert.deepEqual(f.opened, []);
  await held.release();
  f.adapters.nginxHashes.site = '0'.repeat(64);
  await assert.rejects(f.run(), /Supabase routing inspection stopped at nginx-/);
  const again = await acquireWorkerLock(path.join(f.lockRoot, 'operator.lock')); await again.release();
});

test('unsafe mutex aliases and weak recipients cannot reach configuration reads', async t => {
  for (const name of ['operator.lock', 'operator.lock.sqlite']) {
    const f = await fixture(t), other = path.join(f.appRoot, 'independent-file');
    await fs.writeFile(other, f.secret, { mode: 0o600 }); await fs.symlink(other, path.join(f.lockRoot, name));
    await assert.rejects(f.run(), /Supabase routing inspection stopped at lock/);
    assert.deepEqual(f.opened, []); assert.equal(await fs.readFile(other, 'utf8'), f.secret);
  }
  const { publicKey: weakKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const f = await fixture(t);
  await assert.rejects(f.run({ recipientPublicKey: weakKey.export({ type: 'spki', format: 'pem' }) }), /stopped at inputs/);
  assert.deepEqual(f.calls, []);
});

test('a bounded but incompressible inspection cannot exceed the existing sealed-capsule limit', async t => {
  const f = await fixture(t), bytes = randomBytes(80 * 1024);
  await fs.writeFile(f.mainFile, bytes); f.adapters.nginxHashes.main = sha(bytes);
  await assert.rejects(f.run(), /Supabase routing inspection stopped at readback/);
  assert(!f.loads.includes('services/driverAuditTransferCodec.js'));
  const lock = await acquireWorkerLock(path.join(f.lockRoot, 'operator.lock')); await lock.release();
});

test('a failed file close still releases the operator mutex and exports only a static cleanup error', async t => {
  const f = await fixture(t), original = f.adapters.filesystem.open;
  f.adapters.filesystem.open = async (...args) => {
    const handle = await original(...args), close = handle.close.bind(handle);
    handle.close = async () => { await close(); throw Error(f.secret); };
    return handle;
  };
  await assert.rejects(f.run(), error => error.phase === 'cleanup'
    && error.message === 'Supabase routing inspection stopped at cleanup' && !JSON.stringify(error).includes(f.secret));
  const lock = await acquireWorkerLock(path.join(f.lockRoot, 'operator.lock')); await lock.release();
});

test('the real workflow selector resolves both Supabase operations to existing reviewed operator files', async () => {
  const workflow = await fs.readFile(new URL('../workflows/driver-audit-native-handoff.yml', import.meta.url), 'utf8');
  const start = workflow.indexOf('          case "$OPERATION" in');
  const end = workflow.indexOf("          printf 'import_code=", start);
  assert(start >= 0 && end > start);
  const selector = workflow.slice(start, end).split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');
  const root = new URL('../../', import.meta.url);
  for (const [operation, expected] of [
    ['inspect-supabase-routing', '.github/scripts/driver-audit-supabase-routing.mjs'],
    ['inspect-supabase-host', '.github/scripts/driver-audit-supabase-handoff.mjs'],
    ['prepare-supabase-host', '.github/scripts/driver-audit-supabase-handoff.mjs'],
    ['inspect-database-config', '.github/scripts/driver-audit-native-database-check.mjs'],
  ]) {
    const result = await promisify(execFile)('bash', ['-c', selector + '\nprintf \'%s\' "$operator_file"'],
      { cwd: root, env: { PATH: process.env.PATH, OPERATION: operation }, timeout: 5000 });
    assert.equal(result.stdout, expected);
    assert((await fs.stat(new URL(expected, root))).isFile());
  }
});
