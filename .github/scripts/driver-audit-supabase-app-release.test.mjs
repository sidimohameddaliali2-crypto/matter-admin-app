import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createServer } from 'node:http';

const exec = promisify(execFile);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const implementation = await import('./driver-audit-supabase-app-release.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const request = { version: 1, expectedOldSha: '1'.repeat(40), selectedSha: '2'.repeat(40),
  reportHeadSha256: '3'.repeat(64), generation: '4'.repeat(64) };

test('the manual request accepts only the exact reviewed commits and report identity', () => {
  assert.equal(typeof implementation.validateAppReaderReleaseRequest, 'function', 'The guarded reader release is implemented');
  assert.deepEqual(implementation.validateAppReaderReleaseRequest(request), request);
  for (const bad of [{ ...request, command: 'npm ci' }, { ...request, selectedSha: '../main' },
    { ...request, expectedOldSha: request.selectedSha }, { ...request, generation: null }]) {
    assert.throws(() => implementation.validateAppReaderReleaseRequest(bad));
  }
});

test('after restart, the signed-out report check preserves the configured public Host on loopback', async t => {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push([req.url, req.headers.host]);
    if (req.url === '/api/health') return res.end(JSON.stringify({ database: 'connected' }));
    res.statusCode = req.headers.host === 'reports.example.invalid' ? 401 : 403;
    res.end('Sign in');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await implementation.verifyAppReaderHealth({ origin: 'https://reports.example.invalid', port: server.address().port });
  assert.deepEqual(requests.map(([route]) => route), ['/api/health', '/api/reporting/status']);
  assert.deepEqual(requests[1], ['/api/reporting/status', 'reports.example.invalid']);
});

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'supabase-reader-release-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (name, bytes, mode = 0o644) => {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes, { mode });
  };
  const git = async (...args) => (await exec('git', ['-C', root, ...args])).stdout.trim();
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Fictional Fixture');
  await git('config', 'user.email', 'fixture@example.invalid');
  await git('remote', 'add', 'origin', 'https://github.com/sidimohameddaliali2-crypto/matter-admin-app.git');
  await write('.gitignore', 'server/.env*\nserver/node_modules/\nserver/.private/\nclient/build/\nclient/node_modules/\n');
  await write('server/package.json', '{"type":"module"}\n');
  await write('server/package-lock.json', '{"lockfileVersion":3,"packages":{}}\n');
  await write('server/server.js', '// Existing business entrypoint\n');
  await write('server/routes/events.js', '// Existing business route\n');
  await write('client/package.json', '{"scripts":{"build":"unchanged"}}\n');
  await write('server/services/driverAuditIntegration.js', 'export const version="old";\n');
  await git('add', '.'); await git('commit', '-m', 'Existing app');
  const old = await git('rev-parse', 'HEAD');
  await write('server/services/driverAuditIntegration.js', 'export const version="new";\n');
  await write('server/services/driverAuditSupabaseAppBackend.js', 'export const backend="supabase";\n');
  await git('add', '.'); await git('commit', '-m', 'Reviewed report reader');
  const selected = await git('rev-parse', 'HEAD');
  await git('checkout', '--detach', old);
  await write('server/routes/Event.js', '// Preserved, never imported\n', 0o664);
  await write('server/.env.local', 'JWT_SECRET=fictional-existing-secret-long-enough\nDRIVER_AUDIT_ORIGIN=https://matterapp.online\nDRIVER_AUDIT_IMPORT_ENABLED=0\nKEEP_BUSINESS=unchanged\n', 0o600);
  await write('server/node_modules/.package-lock.json', 'existing installed dependencies\n');
  await write('server/node_modules/unchanged/index.js', 'do not reinstall\n');
  await fs.cp(new URL('../../server/node_modules/dotenv', import.meta.url), path.join(root, 'server/node_modules/dotenv'), { recursive: true });
  await write('client/build/index.html', 'existing website\n');
  await write('client/node_modules/unchanged/index.js', 'do not rebuild\n');
  const beforeEnv = await fs.readFile(path.join(root, 'server/.env.local'));
  let pid = 123, restarts = 0, failHealth = false;
  const rows = () => [{ name: 'matter-delivery-api', pid, pm_id: 7,
    pm2_env: { status: 'online', pm_cwd: root, pm_exec_path: '/usr/bin/npm', args: ['start', '--prefix', 'server'],
      pm_uptime: 1000 + restarts, restart_time: restarts } },
  { name: 'matter-driver-audit-sync', pid: 0, pm2_env: { status: 'stopped' } }];
  const f = { root, write, git, old, selected, beforeEnv, rows, get restarts() { return restarts; },
    request: { ...request, expectedOldSha: old, selectedSha: selected }, failNextHealth() { failHealth = true; } };
  f.dependencies = {
    inspectProcesses: async () => structuredClone(rows()),
    restart: async () => { pid++; restarts++; },
    async preflight({ selectedRoot, env, expected }) {
      assert.equal(await git('rev-parse', 'HEAD'), old, 'Preflight runs before code cutover');
      assert.deepEqual(await fs.readFile(path.join(root, 'server/.env.local')), beforeEnv);
      assert.match(await fs.readFile(path.join(selectedRoot, 'server/services/driverAuditIntegration.js'), 'utf8'), /"new"/);
      assert.equal(env.DRIVER_AUDIT_SERVING_STORE, 'supabase');
      assert.equal(env.DRIVER_AUDIT_IMPORT_ENABLED, '0');
      return { generation: expected.generation, reportHeadSha256: expected.reportHeadSha256,
        namedEvidenceVerified: true, prewarmed: true, remoteBytesRequired: 0, availableTransferBytes: 1000000 };
    },
    async verifyHealth() { if (failHealth) { failHealth = false; throw Error('Fictional new app health failure'); } },
  };
  return f;
}

test('report-only release preserves existing client, dependencies, local file and PM2 registration', async t => {
  assert.equal(typeof implementation.releaseSupabaseAppReader, 'function');
  const f = await fixture(t);
  const keep = ['client/build/index.html', 'client/node_modules/unchanged/index.js',
    'server/node_modules/unchanged/index.js', 'server/routes/Event.js', 'server/routes/events.js', 'server/server.js'];
  const original = await Promise.all(keep.map(name => fs.readFile(path.join(f.root, name))));
  const result = await implementation.releaseSupabaseAppReader({ appRoot: f.root, request: f.request, dependencies: f.dependencies });
  assert.equal(result.status, 'supabase-app-reader-released');
  assert.equal(await f.git('rev-parse', 'HEAD'), f.selected);
  assert.equal(f.restarts, 1);
  assert.deepEqual(await Promise.all(keep.map(name => fs.readFile(path.join(f.root, name)))), original);
  const after = await fs.readFile(path.join(f.root, 'server/.env.local'), 'utf8');
  assert.match(after, /KEEP_BUSINESS=unchanged/); assert.match(after, /DRIVER_AUDIT_SERVING_STORE="supabase"/);
  assert.equal(f.rows()[0].pm2_env.pm_exec_path, '/usr/bin/npm');
});

test('a client, dependency lock or business-route change stops before any preflight or restart', async t => {
  for (const name of ['client/package.json', 'server/package-lock.json', 'server/routes/events.js']) {
    const f = await fixture(t);
    await f.git('checkout', '--detach', f.selected);
    await f.write(name, 'unreviewed business change\n');
    await f.git('add', name); await f.git('commit', '-m', 'Unrelated change');
    f.request.selectedSha = await f.git('rev-parse', 'HEAD');
    await f.git('checkout', '--detach', f.old);
    f.dependencies.preflight = async () => assert.fail('Preflight must not start');
    await assert.rejects(implementation.releaseSupabaseAppReader({ appRoot: f.root, request: f.request, dependencies: f.dependencies }));
    assert.equal(f.restarts, 0); assert.equal(await f.git('rev-parse', 'HEAD'), f.old);
  }
});

test('failed selected-package preflight leaves all app code and settings untouched', async t => {
  const f = await fixture(t);
  f.dependencies.preflight = async () => { throw Error('Missing verified report'); };
  await assert.rejects(implementation.releaseSupabaseAppReader({ appRoot: f.root, request: f.request, dependencies: f.dependencies }));
  assert.equal(await f.git('rev-parse', 'HEAD'), f.old); assert.equal(f.restarts, 0);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'server/.env.local')), f.beforeEnv);
});

test('a failed API restart health check restores the exact old code and original settings', async t => {
  const f = await fixture(t); f.failNextHealth();
  await assert.rejects(implementation.releaseSupabaseAppReader({ appRoot: f.root, request: f.request, dependencies: f.dependencies }));
  assert.equal(await f.git('rev-parse', 'HEAD'), f.old); assert.equal(f.restarts, 2);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'server/.env.local')), f.beforeEnv);
  assert.match(await fs.readFile(path.join(f.root, 'server/services/driverAuditIntegration.js'), 'utf8'), /"old"/);
  assert.equal(await fs.readFile(path.join(f.root, 'client/build/index.html'), 'utf8'), 'existing website\n');
});

test('a completed environment promotion with lost acknowledgement restores exact original settings', async t => {
  const f = await fixture(t), rename = fs.rename, envFile = path.join(f.root, 'server/.env.local');
  let reached = false;
  fs.rename = async function (from, to) {
    const result = await rename(from, to);
    if (to === envFile && !reached) { reached = true; throw Object.assign(Error('Lost environment rename acknowledgement'), { code: 'EIO' }); }
    return result;
  };
  try { await assert.rejects(implementation.releaseSupabaseAppReader({ appRoot: f.root, request: f.request, dependencies: f.dependencies })); }
  finally { fs.rename = rename; }
  assert(reached); assert.equal(await f.git('rev-parse', 'HEAD'), f.old);
  assert.deepEqual(await fs.readFile(envFile), f.beforeEnv);
});

test('a foreign environment edit at temporary creation is preserved instead of promoted over', async t => {
  const f = await fixture(t), open = fs.open, envFile = path.join(f.root, 'server/.env.local');
  let reached = false;
  fs.open = async function (name, ...args) {
    const file = await open(name, ...args);
    if (!reached && String(name).includes('reader-release-') && args[0] === 'wx'
      && await fs.realpath(path.dirname(String(name))) === path.join(f.root, 'server')) {
      reached = true; await fs.appendFile(envFile, 'FOREIGN_DURING_PROMOTION=keep\n');
    }
    return file;
  };
  try { await assert.rejects(implementation.releaseSupabaseAppReader({ appRoot: f.root, request: f.request, dependencies: f.dependencies })); }
  finally { fs.open = open; }
  assert(reached); assert.match(await fs.readFile(envFile, 'utf8'), /FOREIGN_DURING_PROMOTION=keep/);
});

test('rollback preserves a foreign environment edit made while its private temporary file is created', async t => {
  const f = await fixture(t), open = fs.open, envFile = path.join(f.root, 'server/.env.local');
  let promotions = 0, reached = false; f.failNextHealth();
  fs.open = async function (name, ...args) {
    const file = await open(name, ...args);
    if (String(name).includes('reader-release-') && args[0] === 'wx'
      && await fs.realpath(path.dirname(String(name))) === path.join(f.root, 'server') && ++promotions === 2) {
      reached = true; await fs.appendFile(envFile, 'FOREIGN_DURING_ROLLBACK=keep\n');
    }
    return file;
  };
  try { await assert.rejects(implementation.releaseSupabaseAppReader({ appRoot: f.root, request: f.request, dependencies: f.dependencies }),
    error => error.code === 'APP_READER_ROLLBACK_PENDING'); }
  finally { fs.open = open; }
  assert(reached); assert.match(await fs.readFile(envFile, 'utf8'), /FOREIGN_DURING_ROLLBACK=keep/);
  assert.equal(f.restarts, 1);
});

test('a restart acknowledgement with an unchanged API identity cannot claim release', async t => {
  const f = await fixture(t); f.dependencies.restart = async () => {};
  await assert.rejects(implementation.releaseSupabaseAppReader({ appRoot: f.root, request: f.request, dependencies: f.dependencies }));
  assert.equal(await f.git('rev-parse', 'HEAD'), f.old);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'server/.env.local')), f.beforeEnv);
});

async function interruptedRelease(t, pair = 'new-new') {
  const f = await fixture(t), privateRoot = path.join(f.root, 'server/.private');
  await fs.mkdir(privateRoot, { mode: 0o700 });
  const rowsFile = path.join(privateRoot, 'process-fixture.json'), marker = path.join(privateRoot, 'crash-marker');
  await fs.writeFile(rowsFile, JSON.stringify(f.rows()), { mode: 0o600 });
  const runner = path.join(privateRoot, 'kill-runner.mjs');
  await fs.writeFile(runner, `
    import fs from 'node:fs/promises';
    import {releaseSupabaseAppReader} from ${JSON.stringify(new URL('./driver-audit-supabase-app-release.mjs', import.meta.url).href)};
    let input='';for await(const part of process.stdin)input+=part;
    const c=JSON.parse(input), hold=async()=>{await fs.writeFile(c.marker,'admitted');await new Promise(()=>setInterval(()=>{},1000));};
    const rows=async()=>JSON.parse(await fs.readFile(c.rowsFile));
    if(c.pair==='new-old'){
      const open=fs.open;
      fs.open=async function(name,...args){const file=await open(name,...args);
        if(String(name).includes('reader-release-')&&args[0]==='wx'&&await fs.realpath(String(name).slice(0,String(name).lastIndexOf('/')))===c.root+'/server')await hold();
        return file;};
    }
    await releaseSupabaseAppReader({appRoot:c.root,request:c.request,dependencies:{inspectProcesses:rows,
      preflight:async()=>({generation:c.request.generation,reportHeadSha256:c.request.reportHeadSha256,prewarmed:true,namedEvidenceVerified:true}),
      restart:hold,verifyHealth:async()=>{}}});
  `, { mode: 0o600 });
  const child = spawn(process.execPath, [runner], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; }); child.stdout.resume();
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  child.stdin.end(JSON.stringify({ root: f.root, request: f.request, rowsFile, marker, pair }));
  for (let n = 0; n < 400 && !(await fs.stat(marker).catch(() => null)); n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await fs.readFile(marker, 'utf8').catch(() => stderr), 'admitted');
  child.kill('SIGKILL'); assert.equal((await closed).signal, 'SIGKILL');
  assert.equal(await f.git('rev-parse', 'HEAD'), f.selected);
  const proof = async ({ expected }) => ({ generation: expected.generation, reportHeadSha256: expected.reportHeadSha256,
    namedEvidenceVerified: true, prewarmed: true });
  f.dependencies.preflight = proof;
  return f;
}

test('a real SIGKILL after code or environment promotion resumes from the original durable intent', async t => {
  for (const pair of ['new-old', 'new-new', 'old-new', 'old-old']) {
    const f = await interruptedRelease(t, pair === 'new-old' ? pair : 'new-new');
    if (pair.startsWith('old-')) await f.git('checkout', '--detach', f.old);
    if (pair === 'old-old') await fs.writeFile(path.join(f.root, 'server/.env.local'), f.beforeEnv, { mode: 0o600 });
    const result = await implementation.releaseSupabaseAppReader({ appRoot: f.root, request: f.request, dependencies: f.dependencies });
    assert.equal(result.status, 'supabase-app-reader-released'); assert.equal(f.restarts, 1);
    assert.equal(result.apiProcessRestartVerified, true);
    assert.equal(result.authenticatedGenerationAcceptancePending, true);
    assert.match(await fs.readFile(path.join(f.root, 'server/.env.local'), 'utf8'), /DRIVER_AUDIT_SERVING_STORE="supabase"/);
  }
});

test('recorded recovery refuses changed business code, dependencies, or process registration before package reads', async t => {
  for (const kind of ['code', 'dependencies', 'registration']) {
    const f = await interruptedRelease(t);
    if (kind === 'code') await f.write('server/routes/events.js', '// Preserve a new business edit\n');
    if (kind === 'dependencies') await f.write('server/node_modules/unchanged/index.js', '// Preserve changed dependencies\n');
    if (kind === 'registration') f.dependencies.inspectProcesses = async () => f.rows().map(row => row.name === 'matter-delivery-api'
      ? { ...row, pm2_env: { ...row.pm2_env, args: ['other-entrypoint'] } } : row);
    f.dependencies.preflight = async () => assert.fail('Foreign recovery inputs must stop before a package read');
    await assert.rejects(implementation.releaseSupabaseAppReader({ appRoot: f.root, request: f.request, dependencies: f.dependencies }));
    assert.equal(f.restarts, 0); assert.equal(await f.git('rev-parse', 'HEAD'), f.selected);
  }
});

test('check-only preserves an interrupted app and a resumed release preserves foreign changes', async t => {
  const f = await interruptedRelease(t), before = await fs.readFile(path.join(f.root, 'server/.env.local'));
  await assert.rejects(implementation.releaseSupabaseAppReader({ appRoot: f.root, request: f.request, apply: false, dependencies: f.dependencies }));
  assert.equal(f.restarts, 0); assert.equal(await f.git('rev-parse', 'HEAD'), f.selected);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'server/.env.local')), before);
  await fs.appendFile(path.join(f.root, 'server/.env.local'), 'FOREIGN_AFTER_CRASH=keep\n');
  await assert.rejects(implementation.releaseSupabaseAppReader({ appRoot: f.root, request: f.request, dependencies: f.dependencies }));
  assert.equal(f.restarts, 0); assert.match(await fs.readFile(path.join(f.root, 'server/.env.local'), 'utf8'), /FOREIGN_AFTER_CRASH=keep/);
});

test('a completed exact release retry verifies the existing process without another package read or restart', async t => {
  const f = await fixture(t);
  const original = await implementation.releaseSupabaseAppReader({ appRoot: f.root, request: f.request, dependencies: f.dependencies });
  f.dependencies.preflight = async () => assert.fail('An exact completed retry must not read the package again');
  const resumed = await implementation.releaseSupabaseAppReader({ appRoot: f.root, request: f.request, dependencies: f.dependencies });
  assert.deepEqual(resumed, original); assert.equal(f.restarts, 1);
});

test('only the reviewed report proxy entrypoints extend the existing release path allowlist', async t => {
  const f = await fixture(t); await f.git('checkout', '--detach', f.selected);
  await f.write('server/server.js', '// Reviewed report proxy registration\n');
  await f.write('server/services/driverAuditReaderProxy.js', '// Reviewed report proxy\n');
  await f.write('server/scripts/driverAuditReaderChild.js', '// Reviewed report child\n');
  await f.write('server/vendor/driver-audits/integration/cloud/automatic-hosted-preview.mjs', '// Exact prepared descriptor readiness\n');
  await f.git('add', 'server/server.js', 'server/services/driverAuditReaderProxy.js', 'server/scripts/driverAuditReaderChild.js',
    'server/vendor/driver-audits/integration/cloud/automatic-hosted-preview.mjs');
  await f.git('commit', '-m', 'Reviewed report isolation');
  f.request.selectedSha = await f.git('rev-parse', 'HEAD'); await f.git('checkout', '--detach', f.old);
  const result = await implementation.releaseSupabaseAppReader({ appRoot: f.root, request: f.request, dependencies: f.dependencies });
  assert.equal(result.status, 'supabase-app-reader-released');
});

test('a foreign environment edit after a lost acknowledgement is preserved for review', async t => {
  const f = await fixture(t), rename = fs.rename, envFile = path.join(f.root, 'server/.env.local');
  let reached = false;
  fs.rename = async function (from, to) {
    const result = await rename(from, to);
    if (to === envFile && !reached) { reached = true; await fs.appendFile(envFile, 'FOREIGN_CHANGE=keep\n');
      throw Object.assign(Error('Lost environment acknowledgement with drift'), { code: 'EIO' }); }
    return result;
  };
  try { await assert.rejects(implementation.releaseSupabaseAppReader({ appRoot: f.root, request: f.request, dependencies: f.dependencies }),
    error => error.code === 'APP_READER_ROLLBACK_PENDING'); }
  finally { fs.rename = rename; }
  assert(reached); assert.match(await fs.readFile(envFile, 'utf8'), /FOREIGN_CHANGE=keep/);
  assert.equal(f.restarts, 0);
});

test('completed Git checkout with a lost acknowledgement reconciles the actual selected commit', async t => {
  const f = await fixture(t), realGit = (await exec('/usr/bin/which', ['git'])).stdout.trim();
  const originalPath = process.env.PATH;
  const privateRoot = path.join(f.root, 'server/.private'); await fs.mkdir(privateRoot, { mode: 0o700 });
  const bin = path.join(privateRoot, 'mock-bin'); await fs.mkdir(bin, { mode: 0o700 });
  const marker = path.join(bin, 'reached');
  const script = '#!/bin/sh\n' + JSON.stringify(realGit) + ' "$@"\nresult=$?\n' +
    'case "$*" in *"checkout --detach --no-overwrite-ignore ' + f.selected + '")\n' +
    'if [ "$result" = 0 ] && [ ! -e ' + JSON.stringify(marker) + ' ]; then printf reached > ' + JSON.stringify(marker) + '; exit 77; fi;; esac\nexit "$result"\n';
  await fs.writeFile(path.join(bin, 'git'), script, { mode: 0o700 });
  process.env.PATH = bin + path.delimiter + originalPath;
  try { await assert.rejects(implementation.releaseSupabaseAppReader({ appRoot: f.root, request: f.request, dependencies: f.dependencies })); }
  finally { process.env.PATH = originalPath; }
  assert.equal(await fs.readFile(marker, 'utf8'), 'reached');
  assert.equal(await f.git('rev-parse', 'HEAD'), f.old);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'server/.env.local')), f.beforeEnv);
});

test('the actual private history header is accepted while missing privacy directives fail', () => {
  assert.equal(typeof implementation.verifyAppReaderHistoryLanding, 'function');
  const response = { status: 200, cacheControl: 'private, no-store, max-age=0', body: '<h1>Saved source assessments</h1>' };
  assert.equal(implementation.verifyAppReaderHistoryLanding(response), true);
  for (const bad of [{ ...response, status: 401 }, { ...response, cacheControl: 'private' },
    { ...response, cacheControl: 'public, no-store' }, { ...response, body: 'Other page' }])
    assert.throws(() => implementation.verifyAppReaderHistoryLanding(bad));
});

test('actual host memory admission preserves the measured two-generation 2304 MiB envelope', () => {
  const required = 2304 * 1024 ** 2;
  assert.equal(implementation.requireAppReaderMemory(required), true);
  for (const available of [required - 1, 2036 * 1024 ** 2, 1280 * 1024 ** 2, null, NaN, Infinity])
    assert.throws(() => implementation.requireAppReaderMemory(available));
});

test('light reader startup admits only the verified index and bounded pointer request within the standard allowance', async t => {
  assert.equal(typeof implementation.planLightAppReaderStartup, 'function');
  const cacheDirectory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'light-reader-budget-')));
  t.after(() => fs.rm(cacheDirectory, { recursive: true, force: true }));
  const bytes = gzipSync(Buffer.from('{"tiny":"index"}'));
  const lightView = { sha256: sha(bytes), size: bytes.length };
  const usage = { day: { limitBytes: 512 * 1024 ** 2, usedBytes: 0, reservedBytes: 0 },
    month: { limitBytes: 8 * 1024 ** 3, usedBytes: 0, reservedBytes: 0 } };
  const cold = await implementation.planLightAppReaderStartup({ lightView, cacheDirectory, usage });
  assert.equal(cold.remoteBytesRequired, bytes.length);
  assert(cold.requiredBytes >= 2 * 1024 ** 2 + bytes.length);
  await fs.writeFile(path.join(cacheDirectory, lightView.sha256 + '.gz'), bytes, { mode: 0o600 });
  const warm = await implementation.planLightAppReaderStartup({ lightView, cacheDirectory, usage });
  assert.equal(warm.remoteBytesRequired, 0);
  assert.equal(warm.requiredBytes, 2 * 1024 ** 2);
  const nearlyFull = structuredClone(usage);
  nearlyFull.day.usedBytes = nearlyFull.day.limitBytes - warm.requiredBytes + 1;
  await assert.rejects(implementation.planLightAppReaderStartup({ lightView, cacheDirectory, usage: nearlyFull }),
    error => error.code === 'APP_READER_COLD_BUDGET');
  await fs.writeFile(path.join(cacheDirectory, lightView.sha256 + '.gz'), 'corrupt');
  assert.equal((await implementation.planLightAppReaderStartup({ lightView, cacheDirectory, usage })).remoteBytesRequired, bytes.length);
});

test('a selected light release persists the explicit selector and requires a light preflight proof', async t => {
  const f = await fixture(t); await f.git('checkout', '--detach', f.selected);
  const services = ['Archive', 'Evidence', 'Page', 'Reader', 'Projection', 'Reviews', 'Build', 'Policy'];
  for (const name of services) await f.write('server/services/driverAuditLight' + name + '.js', '// Reviewed light reader\n');
  for (const suffix of ['.js', '.test.js']) await f.write('server/scripts/driverAuditHostedBootstrap' + suffix, '// Offline staged metadata\n');
  await f.write('server/services/driverAuditHostedSlots.js', '// Durable hosted slots\n');
  await f.git('add', ...services.map(name => 'server/services/driverAuditLight' + name + '.js'),
    'server/scripts/driverAuditHostedBootstrap.js', 'server/scripts/driverAuditHostedBootstrap.test.js', 'server/services/driverAuditHostedSlots.js');
  await f.git('commit', '-m', 'Reviewed light reader'); f.request.selectedSha = await f.git('rev-parse', 'HEAD');
  await f.git('checkout', '--detach', f.old);
  const preflight = f.dependencies.preflight;
  await assert.rejects(implementation.releaseSupabaseAppReader({ appRoot: f.root, request: f.request, dependencies: f.dependencies }),
    /Selected report preflight was not verified/);
  assert.equal(f.restarts, 0);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'server/.env.local')), f.beforeEnv);
  f.dependencies.preflight = async input => {
    assert.equal(input.env.DRIVER_AUDIT_LIGHT_READER, '1');
    return { ...await preflight(input), lightweight: true };
  };
  await implementation.releaseSupabaseAppReader({ appRoot: f.root, request: f.request, dependencies: f.dependencies });
  assert.match(await fs.readFile(path.join(f.root, 'server/.env.local'), 'utf8'), /DRIVER_AUDIT_LIGHT_READER="1"/);
});

async function lightPreflightFixture(t) {
  const [{ createDriverAuditLightArchive, stageDriverAuditLightView }, { createDriverAuditIntegration },
    { archiveBytes, archiveCatalog }, { compareUploadLocation }] = await Promise.all([
    import('../../server/services/driverAuditLightArchive.js'), import('../../server/services/driverAuditIntegration.js'),
    import('../../server/vendor/driver-audits/integration/cloud/repository.mjs'),
    import('../../server/vendor/driver-audits/app/src/content/dashboard/upload-location.mjs'),
  ]);
  const cacheDirectory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'reader-light-preflight-')));
  t.after(() => fs.rm(cacheDirectory, { recursive: true, force: true }));
  const blobs = new Map(), reads = [], rpcReads = [], routes = [];
  const archive = {
    async readObject(key, { maxBytes }) {
      reads.push(key); assert(blobs.has(key), 'Only staged light/evidence objects may be read');
      const bytes = blobs.get(key); assert(bytes.length <= maxBytes); return [bytes];
    },
    async putVerifiedObject(key, bytes) {
      assert.equal(key, sha(bytes) + '.gz'); blobs.set(key, Buffer.from(bytes));
      return { verified: true, key, sha256: sha(bytes) };
    },
  };
  const head = { generation: request.generation, reportHash: sha('original snapshot'),
    sourceBodySha256: request.reportHeadSha256, visibleCutoffAt: '2026-11-18T07:00:00.000Z' };
  const photo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwcB/UtqpEwAAAAASUVORK5CYII=', 'base64');
  const key = '2025-11-05/old-delivery', delivery = { id: 'old-delivery', upload: '2025-11-05T06:00:00.000Z' };
  const assessmentHash = sha('original assessment'), deliveryDigest = sha(JSON.stringify(delivery));
  const uploadLocation = compareUploadLocation({ upload: delivery.upload });
  const gps = { result: { binding: { assessmentHash, deliveryDigest }, vehicle: 'original-vehicle', gps: { streams: [] } },
    context: {}, evidenceResult: { recordKey: key, versionId: sha('original GPS'), assessmentHash, deliveryDigest, uploadLocation } };
  const historyBytes = Buffer.from(JSON.stringify({ rows: [{ key, result: 'retained original' }] }));
  const historySha = sha(historyBytes), historyUrl = 'report-data/history-' + historySha + '.json';
  const refs = [await archiveBytes(archive, gzipSync(historyBytes), { domain: 'state', path: 'assets/' + historyUrl.slice(12) + '.gz' }),
    await archiveBytes(archive, photo, { domain: 'objects', path: sha(photo) })];
  const catalog = await archiveCatalog(archive, refs);
  const entry = { row: { key }, summary: { key, driverId: 'original-driver' },
    gpsRow: { key, date: '2025-11-05', assessmentHash, delivery }, gps, photo: { sha256: sha(photo) },
    history: { staff: { url: historyUrl, sha256: historySha, count: 1 }, source: null },
    reviewRow: { key, findings: [] }, issues: [{ id: 'original-issue', deliveryId: key,
      evidence: { source_sha256: sha('original source'), rule_version: 'original-rule' } }] };
  const current = { ...structuredClone(entry), row: { key: '2026-11-18/current-delivery' },
    summary: { key: '2026-11-18/current-delivery', driverId: 'original-driver' } };
  // No new GPS/photo/review result is fabricated for the current date. The
  // deterministic samples deliberately exercise the retained historical case.
  current.gps = null; current.photo.sha256 = null; current.issues = [];
  current.gpsRow = { ...current.gpsRow, key: current.row.key, date: '2026-11-18' };
  current.reviewRow = { key: current.row.key, findings: [] };
  current.history = { staff: null, source: null };
  head.lightView = await stageDriverAuditLightView({ head, archive, projection: {
    days: new Map([['2025-11-05', [entry]], ['2026-11-18', [current]]]),
    context: { generation: head.generation, reportHash: head.reportHash, cutoff: head.visibleCutoffAt,
      records: 2, history: { staffRows: 1 }, review: { snapshotHash: head.reportHash, deliveryReview: true },
      reviewResolved: true, refs: { catalog }, gpsStreamRefs: {}, gpsEvidenceRefs: {}, gpsMetadata: {},
      extraSourceHistoryCases: {}, extraStaffHistoryCases: {} },
  } });
  const replica = { head: async () => head };
  const usage = { day: { limitBytes: 512 * 1024 ** 2, usedBytes: 0, reservedBytes: 0 },
    month: { limitBytes: 8 * 1024 ** 3, usedBytes: 0, reservedBytes: 0 } };
  const backend = { kind: 'supabase', executionHost: 'sidi', archive,
    rpc: async () => assert.fail('Unbounded or unrelated RPC is forbidden'),
    rpcForResponseLimit: limit => async (name, args) => {
      rpcReads.push({ name, key: args.p_key, limit });
      assert.equal(name, 'matter_hosted_state_read'); assert.equal(args.p_key, 'preview-gps-map-20261106:review-journal');
      return { body_text: null, revision: 0 };
    },
    archiveReadBudget: { reserve: async () => ({ allowed: true }), settle: async () => ({ settled: true }) },
    readTransferUsage: async () => usage,
  };
  reads.length = 0;
  return { head, backend, replica, cacheDirectory, usage, blobs, reads, rpcReads, routes, entry,
    env: { DRIVER_AUDIT_ENABLED: '1', DRIVER_AUDIT_IMPORT_ENABLED: '0', DRIVER_AUDIT_SERVING_STORE: 'supabase',
      DRIVER_AUDIT_LIGHT_READER: '1', DRIVER_AUDIT_ORIGIN: 'https://matterapp.online' },
    expected: request, signal: new AbortController().signal, createDriverAuditLightArchive,
    createDriverAuditIntegration(options) {
      const actual = createDriverAuditIntegration({ ...options, dependencies: { ...options.dependencies, store: replica,
        createCoordinator: () => ({ status: () => ({}), poll: () => assert.fail('The full CORE must not load') }) } });
      const handler = (req, res, next) => { routes.push(new URL(req.url, 'https://matterapp.online').pathname); return actual(req, res, next); };
      handler.prewarm = actual.prewarm;
      return handler;
    },
  };
}

test('light release preflight exercises the actual staff routes, named hashes and archived date without any full CORE', async t => {
  assert.equal(typeof implementation.preflightLightAppReader, 'function');
  const f = await lightPreflightFixture(t);
  const result = await implementation.preflightLightAppReader(f);
  assert.equal(result.lightweight, true); assert.equal(result.namedEvidenceVerified, true);
  for (const endpoint of ['dates', 'deliveries', 'gps', 'photo', 'history', 'reviews'])
    assert(f.routes.includes('/api/reporting/light/' + endpoint));
  assert(f.reads.length > 0); assert(f.rpcReads.length > 0);
  assert(f.rpcReads.every(row => row.limit === 512 * 1024));
});

test('light preflight refuses a missing index before any remote archive or route read', async t => {
  const f = await lightPreflightFixture(t); delete f.head.lightView;
  await assert.rejects(implementation.preflightLightAppReader(f), /requires its lightweight index/);
  assert.deepEqual(f.reads, []); assert.deepEqual(f.routes, []);
});

test('light preflight refuses a changed named photo and leaves its original source bytes intact', async t => {
  const f = await lightPreflightFixture(t), original = f.createDriverAuditIntegration;
  f.createDriverAuditIntegration = options => {
    const real = original(options);
    const handler = (req, res, next) => {
      if (req.url.startsWith('/api/reporting/light/photo?')) {
        res.writeHead(200, { 'Cache-Control': 'private, no-store', 'X-Report-Image-Sha256': f.entry.photo.sha256 });
        return res.end('different photo');
      }
      return real(req, res, next);
    };
    handler.prewarm = real.prewarm; return handler;
  };
  await assert.rejects(implementation.preflightLightAppReader(f), /original photo bytes differ/);
});

test('light preflight rejects an advanced serving head rather than releasing a stale selected generation', async t => {
  const f = await lightPreflightFixture(t); let calls = 0;
  f.replica.head = async () => ({ ...f.head, sourceBodySha256: ++calls === 1 ? f.head.sourceBodySha256 : sha('a newer actual head') });
  await assert.rejects(implementation.preflightLightAppReader(f), /advanced during lightweight preflight/);
  assert.equal(calls, 2);
  assert(f.routes.includes('/api/reporting/light/reviews'));
});

test('changed settings during preflight are preserved and stop the release', async t => {
  const f = await fixture(t), original = f.dependencies.preflight;
  f.dependencies.preflight = async args => { const value = await original(args); await fs.appendFile(path.join(f.root, 'server/.env.local'), 'NEW_BUSINESS=keep\n'); return value; };
  await assert.rejects(implementation.releaseSupabaseAppReader({ appRoot: f.root, request: f.request, dependencies: f.dependencies }));
  assert.equal(await f.git('rev-parse', 'HEAD'), f.old); assert.equal(f.restarts, 0);
  assert.match(await fs.readFile(path.join(f.root, 'server/.env.local'), 'utf8'), /NEW_BUSINESS=keep/);
});

test('rollback also recovers a crashed new API without changing its registration', async t => {
  const f = await fixture(t); f.failNextHealth();
  f.dependencies.inspectProcesses = async () => f.rows().map(row => row.name === 'matter-delivery-api' && f.restarts === 1
    ? { ...row, pid: 0, pm2_env: { ...row.pm2_env, status: 'errored' } } : structuredClone(row));
  await assert.rejects(implementation.releaseSupabaseAppReader({ appRoot: f.root, request: f.request, dependencies: f.dependencies }));
  assert.equal(await f.git('rev-parse', 'HEAD'), f.old); assert.equal(f.restarts, 2);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'server/.env.local')), f.beforeEnv);
});

test('an exact retry after a recovered failed restart reuses original recovery evidence', async t => {
  const f = await fixture(t); f.failNextHealth();
  await assert.rejects(implementation.releaseSupabaseAppReader({ appRoot: f.root, request: f.request, dependencies: f.dependencies }));
  const result = await implementation.releaseSupabaseAppReader({ appRoot: f.root, request: f.request, dependencies: f.dependencies });
  assert.equal(result.status, 'supabase-app-reader-released'); assert.equal(f.restarts, 3);
});

test('cancellation during final staging cleanup rolls back before releasing exclusion', async t => {
  const f = await fixture(t), stop = new AbortController(), remove = fs.rm;
  fs.rm = async function (name, options) {
    const result = await remove(name, options);
    if (String(name).includes('/preflight-')) stop.abort(Error('Stopped during cleanup'));
    return result;
  };
  try {
    await assert.rejects(implementation.releaseSupabaseAppReader({ appRoot: f.root, request: f.request,
      dependencies: f.dependencies, signal: stop.signal }));
  } finally { fs.rm = remove; }
  assert.equal(await f.git('rev-parse', 'HEAD'), f.old);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'server/.env.local')), f.beforeEnv);
});

test('unknown untracked or linked original inputs stop without modifying them', async t => {
  for (const kind of ['unknown', 'environment-link', 'operator-link']) {
    const f = await fixture(t);
    if (kind === 'unknown') await f.write('server/routes/unreviewed.js', 'preserve this file');
    if (kind === 'environment-link') {
      await fs.rename(path.join(f.root, 'server/.env.local'), path.join(f.root, 'server/.env.saved'));
      await fs.symlink('.env.saved', path.join(f.root, 'server/.env.local'));
    }
    if (kind === 'operator-link') {
      const controls = path.join(f.root, 'server/.private/driver-report-app-reader-releases');
      await fs.mkdir(controls, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(f.root, 'outside.sqlite'), 'DO NOT OPEN');
      await fs.symlink(path.join(f.root, 'outside.sqlite'), path.join(controls, 'operator.sqlite'));
    }
    await assert.rejects(implementation.releaseSupabaseAppReader({ appRoot: f.root, request: f.request, dependencies: f.dependencies }));
    assert.equal(f.restarts, 0); assert.equal(await f.git('rev-parse', 'HEAD'), f.old);
    if (kind === 'operator-link') assert.equal(await fs.readFile(path.join(f.root, 'outside.sqlite'), 'utf8'), 'DO NOT OPEN');
  }
});

test('cold reader admission accounts for the restarted API and never extends the normal quota', async t => {
  assert.equal(typeof implementation.planAppReaderTransfer, 'function');
  const f = await fixture(t), cache = path.join(f.root, 'server/cache');
  await fs.mkdir(cache, { mode: 0o700 });
  const body = Buffer.from('verified cached immutable core');
  const descriptor = { files: { 'renderer.private.html': { chunks: [{ size: body.length, sha256: sha(body) }] } } };
  const usage = { month: { limitBytes: 1024 ** 3, usedBytes: 1000, reservedBytes: 0 },
    day: { limitBytes: 4 * 1024 ** 2, usedBytes: 0, reservedBytes: 0 } };
  const cold = await implementation.planAppReaderTransfer({ descriptor, cacheDirectory: cache, usage, freeBytes: 600 * 1024 ** 2 });
  assert.equal(cold.remoteBytesRequired, body.length); assert.equal(cold.coldLoads, 2);
  await fs.writeFile(path.join(cache, sha(body) + '.gz'), body, { mode: 0o600 });
  const warm = await implementation.planAppReaderTransfer({ descriptor, cacheDirectory: cache, usage, freeBytes: 600 * 1024 ** 2 });
  assert.equal(warm.remoteBytesRequired, 0);
  descriptor.files['renderer.private.html'].chunks = [8, 8, 8, 3].map((size, i) => ({ size: size * 1024 ** 2, sha256: sha('cold-' + i) }));
  await assert.rejects(implementation.planAppReaderTransfer({ descriptor, cacheDirectory: cache, usage, freeBytes: 600 * 1024 ** 2 }),
    error => error.code === 'APP_READER_COLD_BUDGET' && error.requiredBytes === 56 * 1024 ** 2);
});

test('check-only uses the same report proof without changing checkout, environment or process', async t => {
  const f = await fixture(t);
  const result = await implementation.releaseSupabaseAppReader({ appRoot: f.root, request: f.request, apply: false, dependencies: f.dependencies });
  assert.equal(result.status, 'supabase-app-reader-checked');
  assert.equal(await f.git('rev-parse', 'HEAD'), f.old); assert.equal(f.restarts, 0);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'server/.env.local')), f.beforeEnv);
});

test('a cold-budget stop never checks out code or changes the existing app flags', async t => {
  const f = await fixture(t);
  f.dependencies.preflight = async () => { throw Object.assign(Error('Cold reader cannot fit'),
    { code: 'APP_READER_COLD_BUDGET', requiredBytes: 35 * 1024 ** 2, availableBytes: 11 * 1024 ** 2 }); };
  await assert.rejects(implementation.releaseSupabaseAppReader({ appRoot: f.root, request: f.request, dependencies: f.dependencies }),
    error => error.code === 'APP_READER_COLD_BUDGET');
  assert.equal(await f.git('rev-parse', 'HEAD'), f.old); assert.equal(f.restarts, 0);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'server/.env.local')), f.beforeEnv);
});

test('base environment changes during preflight are preserved and stop before restart', async t => {
  const f = await fixture(t), preflight = f.dependencies.preflight;
  await f.write('server/.env', 'EXISTING_BUSINESS=before\n', 0o600);
  f.dependencies.preflight = async args => { const value = await preflight(args); await fs.appendFile(path.join(f.root, 'server/.env'), 'NEW_BUSINESS=after\n'); return value; };
  await assert.rejects(implementation.releaseSupabaseAppReader({ appRoot: f.root, request: f.request, dependencies: f.dependencies }));
  assert.equal(await f.git('rev-parse', 'HEAD'), f.old); assert.equal(f.restarts, 0);
  assert.match(await fs.readFile(path.join(f.root, 'server/.env'), 'utf8'), /NEW_BUSINESS=after/);
});

test('an online report worker stops the release before any package read', async t => {
  const f = await fixture(t);
  f.dependencies.inspectProcesses = async () => f.rows().map(row => row.name === 'matter-driver-audit-sync'
    ? { ...row, pid: 444, pm2_env: { ...row.pm2_env, status: 'online' } } : row);
  f.dependencies.preflight = async () => assert.fail('No package read while a report worker is online');
  await assert.rejects(implementation.releaseSupabaseAppReader({ appRoot: f.root, request: f.request, dependencies: f.dependencies }));
  assert.equal(f.restarts, 0);
});

test('a foreign Git origin or hidden tracked changes stop before any package read', async t => {
  for (const kind of ['origin', 'hidden-change']) {
    const f = await fixture(t);
    if (kind === 'origin') await f.git('remote', 'set-url', 'origin', 'https://example.invalid/other-app.git');
    else { await f.git('update-index', '--assume-unchanged', 'server/services/driverAuditIntegration.js');
      await f.write('server/services/driverAuditIntegration.js', 'Preserve hidden local edit\n'); }
    f.dependencies.preflight = async () => assert.fail('No package read before repository identity is proven');
    await assert.rejects(implementation.releaseSupabaseAppReader({ appRoot: f.root, request: f.request, dependencies: f.dependencies }));
    assert.equal(f.restarts, 0); assert.equal(await f.git('rev-parse', 'HEAD'), f.old);
  }
});

test('a business-code edit made during preflight is preserved and prevents cutover', async t => {
  const f = await fixture(t), preflight = f.dependencies.preflight;
  f.dependencies.preflight = async args => { const value = await preflight(args);
    await f.write('server/routes/events.js', '// Preserve concurrent business edit\n'); return value; };
  await assert.rejects(implementation.releaseSupabaseAppReader({ appRoot: f.root, request: f.request, dependencies: f.dependencies }));
  assert.equal(await f.git('rev-parse', 'HEAD'), f.old); assert.equal(f.restarts, 0);
  assert.equal(await fs.readFile(path.join(f.root, 'server/routes/events.js'), 'utf8'), '// Preserve concurrent business edit\n');
});

test('lost restart acknowledgement restores the old app without starting another process registration', async t => {
  const f = await fixture(t), restart = f.dependencies.restart;
  f.dependencies.restart = async () => { await restart(); if (f.restarts === 1) throw Error('Lost restart acknowledgement'); };
  await assert.rejects(implementation.releaseSupabaseAppReader({ appRoot: f.root, request: f.request, dependencies: f.dependencies }));
  assert.equal(await f.git('rev-parse', 'HEAD'), f.old); assert.equal(f.restarts, 2);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'server/.env.local')), f.beforeEnv);
});

test('preflight context exits its fixed child before app cutover can retain a second report heap', async () => {
  assert.equal(typeof implementation.runAppReaderPreflightChild, 'function');
  const source = 'export async function preflightAppReader(input){return {generation:input.expected.generation,pid:process.pid};}';
  const result = await implementation.runAppReaderPreflightChild({ expected: request },
    { moduleUrl: 'data:text/javascript;base64,' + Buffer.from(source).toString('base64') });
  assert.equal(result.generation, request.generation);
  assert.notEqual(result.pid, process.pid);
  assert.throws(() => process.kill(result.pid, 0), error => error.code === 'ESRCH');
});

test('cancelling a read-only preflight waits for its child to close', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-preflight-signal-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, 'pid');
  const source = 'import fs from "node:fs/promises";export async function preflightAppReader(input){const keep=setInterval(()=>{},10000);try{await fs.writeFile(input.marker,String(process.pid));await new Promise((_,reject)=>input.signal.addEventListener("abort",()=>reject(Error("Stopped")),{once:true}));}finally{clearInterval(keep);}}';
  const stop = new AbortController();
  const running = implementation.runAppReaderPreflightChild({ marker },
    { moduleUrl: 'data:text/javascript;base64,' + Buffer.from(source).toString('base64'), signal: stop.signal });
  running.catch(() => {});
  let pid;
  for (let n = 0; n < 100 && !pid; n++) { await new Promise(resolve => setTimeout(resolve, 10)); pid = Number(await fs.readFile(marker, 'utf8').catch(() => '')); }
  assert(pid); stop.abort(Error('Stopped after admission'));
  await assert.rejects(running);
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
});

const workflow = await fs.readFile(new URL('../workflows/deploy-digitalocean.yml', import.meta.url), 'utf8');
function workflowStep(name) {
  const marker = '      - name: ' + name + '\n', start = workflow.indexOf(marker);
  assert(start >= 0, 'Reviewed workflow step exists');
  const end = workflow.indexOf('\n      - name:', start + marker.length);
  return workflow.slice(start, end < 0 ? undefined : end);
}
function workflowScript(name, field = 'run') {
  const indentation = field === 'script' ? 10 : 8, content = indentation + 2;
  const body = workflowStep(name), marker = ' '.repeat(indentation) + field + ': |\n';
  const start = body.indexOf(marker); assert(start >= 0);
  return body.slice(start + marker.length).split('\n').filter(line => !line || line.startsWith(' '.repeat(content)))
    .map(line => line.startsWith(' '.repeat(content)) ? line.slice(content) : line).join('\n');
}
async function stdinCommand(binary, args, input, { env = {}, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', part => { stdout += part; }); child.stderr.on('data', part => { stderr += part; });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); child.stdin.end(input);
  });
}

test('both reader choices bypass normal deploy/build and every legacy audit mutation', () => {
  const shouldRun = (name, operation, atomic = '0') => {
    const expression = /\n        if: (.+)/.exec(workflowStep(name))[1];
    return Function('github', 'inputs', 'vars', 'return ' + expression)(
      { event_name: 'workflow_dispatch' }, { operation }, { ATOMIC_WEBSITE_DEPLOY: atomic });
  };
  for (const operation of ['check-supabase-reader', 'deploy-supabase-reader']) {
    for (const atomic of ['0', '1']) for (const name of ['Set up website build runtime',
      'Build and seal website away from the live server', 'Upload immutable website candidate', 'Deploy over SSH',
      'Run reviewed driver audit operation']) assert.equal(shouldRun(name, operation, atomic), false);
    for (const name of ['Prepare the reviewed report-only operator', 'Release only the verified Supabase report reader'])
      assert.equal(shouldRun(name, operation), true);
  }
  assert.equal(shouldRun('Deploy over SSH', 'deploy'), true);
  assert.equal(shouldRun('Run reviewed driver audit operation', 'audit-rollback'), true);
});

test('the real workflow input gate rejects missing or substituted report hashes before SSH', async () => {
  const script = workflowScript('Verify reviewed audit operation inputs');
  const env = { GITHUB_SHA: request.selectedSha, EXPECTED_SHA: request.selectedSha, OPERATION: 'deploy-supabase-reader',
    READER_PREVIOUS_SHA: request.expectedOldSha, READER_HEAD_SHA: request.reportHeadSha256, READER_GENERATION: request.generation,
    GC_RESTORE_RECEIPT: '' };
  assert.equal((await stdinCommand('/bin/bash', [], script, { env })).code, 0);
  for (const bad of [{ READER_HEAD_SHA: '' }, { EXPECTED_SHA: request.expectedOldSha },
    { READER_PREVIOUS_SHA: request.selectedSha }, { READER_GENERATION: 'not-a-generation' }]) {
    assert.notEqual((await stdinCommand('/bin/bash', [], script, { env: { ...env, ...bad } })).code, 0);
  }
});

test('the actual compressed host driver rejects operator tampering without importing it', async () => {
  const script = workflowScript('Release only the verified Supabase report reader', 'script');
  const body = script.split("<<'NODE'\n")[1].split('\nNODE')[0];
  const source = Buffer.from('throw Error("PRIVATE SENTINEL MUST NOT APPEAR");');
  const env = { READER_OPERATOR_GZIP: gzipSync(source).toString('base64'), READER_OPERATOR_SHA: sha('different'),
    READER_REQUEST: Buffer.from(JSON.stringify(request)).toString('base64'), READER_APPLY: '1' };
  const result = await stdinCommand(process.execPath, ['--input-type=module'], body, { env });
  assert.equal(result.code, 1); assert.equal(JSON.parse(result.stdout).status, 'supabase-app-reader-stopped');
  assert(!result.stdout.includes('PRIVATE SENTINEL')); assert(!result.stderr.includes('PRIVATE SENTINEL'));
});

test('the real host driver keeps the read-only choice explicit after decompression', async () => {
  const script = workflowScript('Release only the verified Supabase report reader', 'script');
  const body = script.split("<<'NODE'\n")[1].split('\nNODE')[0];
  const source = Buffer.from('export const validateAppReaderReleaseRequest=x=>x;export async function releaseSupabaseAppReader({apply}){return {status:apply?"apply":"check"};}');
  for (const apply of ['0', '1']) {
    const env = { READER_OPERATOR_GZIP: gzipSync(source).toString('base64'), READER_OPERATOR_SHA: sha(source),
      READER_REQUEST: Buffer.from(JSON.stringify(request)).toString('base64'), READER_APPLY: apply };
    const result = await stdinCommand(process.execPath, ['--input-type=module'], body, { env });
    assert.equal(result.code, 0); assert.equal(JSON.parse(result.stdout).status, apply === '0' ? 'check' : 'apply');
  }
});
