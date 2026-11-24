import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const moduleUrl = new URL('./driverAuditHostedBootstrap.js', import.meta.url);
const implementation = await import(moduleUrl).catch(error => { if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error; });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value));
const routes = ['/api/collector?task=delivery-history', '/api/collector?task=delivery', '/api/morning-gps',
  '/api/collector?task=gps-publish', '/api/collector?task=photo-backlog', '/api/collector?task=photo-grade'];

function captures() {
  return {
    repository: encode({ full_name: 'sidimohameddaliali2-crypto/matter-admin-app', default_branch: 'main', private: false,
      owner: { login: 'sidimohameddaliali2-crypto', type: 'User' } }),
    environment: encode({ name: 'driver-reports-worker', protection_rules: [{ type: 'branch_policy' }],
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }),
    branches: encode({ total_count: 1, branch_policies: [{ name: 'main', type: 'branch' }] }),
    secrets: encode({ total_count: 2, secrets: [{ name: 'DRIVER_AUDIT_WORKER_SUPABASE_SECRET' }, { name: 'DRIVER_AUDIT_WORKER_CACHE_KEY' }] }),
  };
}

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'driver-audit-hosted-bootstrap-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  async function write(file, bytes) {
    await fs.mkdir(path.dirname(file), { mode: 0o700, recursive: true });
    await fs.writeFile(file, bytes, { mode: 0o600 });
  }
  const files = ['source/api/collector.mjs', 'source/integration/hosted/native-backend.mjs',
    'source/integration/hosted/archive-read-cache.mjs', 'source/integration/cloud/native-poll-progress.mjs'];
  const code = Buffer.from('export default function(){throw Error("Private code must not execute in preflight");}\n');
  const sourceManifest = encode({ schemaVersion: 1, managedSourceExecutionHost: 'off-host', managedSourceExecutionAdmission: 'fixed-host-v1',
    files: files.map(file => ({ path: file, sha256: sha(code), bytes: code.length })),
    entrypoints: routes.map((route, index) => ({ id: 'fixture-' + index, path: route, module: files[0], exportName: 'default',
      method: 'GET', timeZone: 'UTC', schedule: '30 6 * * *', maxDurationSeconds: 300, requiredEnvironment: [] })) });
  const sourceManifestSha256 = sha(sourceManifest), sourceRoot = path.join(root, 'collector', sourceManifestSha256);
  for (const file of files) await write(path.join(sourceRoot, 'runtime', file), code);
  await write(path.join(sourceRoot, 'runtime', 'manifest.private.json'), sourceManifest);
  const builder = { 'scripts/run-automatic-report.mjs': code }, builderManifest = encode({ version: 1,
    files: Object.fromEntries(Object.entries(builder).map(([file, body]) => [file, sha(body)])) });
  for (const [file, body] of Object.entries(builder)) await write(path.join(root, 'builder', file), body);
  await write(path.join(root, 'builder/runtime-manifest.json'), builderManifest);
  const baseline = { 'build.private.json': encode({ renderer: 'fictional' }), 'publication.private.json': encode({ retained: 'fictional-original' }) };
  const baselineManifest = encode(Object.fromEntries(Object.entries(baseline).map(([file, body]) => [file, sha(body)])));
  for (const [file, body] of Object.entries(baseline)) await write(path.join(root, 'baseline', file), body);
  await write(path.join(root, 'baseline/files.private.json'), baselineManifest);
  const journals = encode({ retained: 'fictional journal bytes' }); await write(path.join(root, 'validation-journals.private.json'), journals);
  await fs.mkdir(path.join(root, 'work/archive-cache'), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(root, 'photo-recovery'), { mode: 0o700 });
  const environment = encode({ DRIVER_AUDIT_EXECUTION_HOST: 'off-host', DRIVER_AUDIT_DATA_STORE: 'supabase',
    MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY: path.join(root, 'work/archive-cache'), DRIVER_AUDIT_PHOTO_RECOVERY_DIRECTORY: path.join(root, 'photo-recovery'),
    MATTER_SUPABASE_SECRET: 'fictional-supabase-private-value', CRON_SECRET: 'fictional-cron-private-value-0000000000',
    MATTER_DELIVERY_API_KEY: 'fictional-delivery-private-value', MATTER_DELIVERY_ENABLED: '1', MATTER_GPS_ENABLED: '1',
    MATTER_GPS_PUBLICATION_ENABLED: '1', MATTER_PHOTO_READ_ENABLED: '1', MATTER_PHOTO_GRADE_ENABLED: '0' });
  const envFile = path.join(sourceRoot, 'environment.private.json'); await write(envFile, environment);
  const source = encode({ version: 1, root: sourceRoot, runtimeRoot: path.join(sourceRoot, 'runtime'), manifestSha256: sourceManifestSha256,
    nodeVersion: process.version, nodeExecutable: await fs.realpath(process.execPath), environment: { path: envFile, sha256: sha(environment) }, gatewayCredential: null });
  const sourceFile = path.join(sourceRoot, 'source.json'); await write(sourceFile, source);
  const sync = encode({ version: 1, root, baselineRoot: path.join(root, 'baseline'), codeRoot: path.join(root, 'builder'),
    builderSha256: sha(builderManifest), rendererBuild: { path: path.join(root, 'baseline/build.private.json'), sha256: sha(baseline['build.private.json']) },
    journals: { path: path.join(root, 'validation-journals.private.json'), sha256: sha(journals) } });
  await write(path.join(root, 'sync.json'), sync);
  const snapshots = captures(), observedAt = new Date(Date.now() - 1000).toISOString();
  for (const [name, body] of Object.entries(snapshots)) await write(path.join(root, 'provisioning', name + '.private.json'), body);
  const activation = encode(implementation.createDriverAuditHostedEnvironmentActivation({ captures: snapshots, observedAt }));
  await write(path.join(root, 'hosted-environment-activation.private.json'), activation);
  const pins = { sourceManifestSha256, sourceFiles: files.length, builderSha256: sha(builderManifest), builderFiles: 1,
    baselineManifestSha256: sha(baselineManifest), baselineFiles: 2, rendererSha256: sha(baseline['build.private.json']),
    journalsSha256: sha(journals), nodeVersion: process.version };
  const rawPins = encode(pins); await write(path.join(root, 'hosted-release-pins.private.json'), rawPins);
  return { root, write, sourceFile, snapshots, observedAt,
    input: { root, syncSha256: sha(sync), sourceConfigSha256: sha(source), activationSha256: sha(activation), pinsSha256: sha(rawPins) }, pins };
}

test('the hosted bootstrap plan fixes exactly the two Dubai slots and remains unarmed', () => {
  assert.equal(typeof implementation.driverAuditHostedWorkerPlan, 'function');
  const plan = implementation.driverAuditHostedWorkerPlan();
  assert.deepEqual(plan.schedules, [{ dubai: '10:30', utc: '06:30', cron: '30 6 * * *' }, { dubai: '12:00', utc: '08:00', cron: '0 8 * * *' }]);
  assert.equal(plan.environment, 'driver-reports-worker'); assert.equal(plan.ref, 'refs/heads/main');
  assert.equal(plan.releasePinsFile, 'hosted-release-pins.private.json');
  for (const name of ['sourceManifestSha256', 'builderSha256', 'baselineManifestSha256', 'rendererSha256', 'journalsSha256',
    'sourceFiles', 'builderFiles', 'baselineFiles', 'nodeVersion']) assert.equal(Object.hasOwn(plan, name), false);
  assert.equal(plan.workerArmed, false); assert.equal(plan.networkRequests, 0);
});

test('scope activation is derived from pinned metadata and refuses reviews, wildcard branches and extra credentials', () => {
  const input = { captures: captures(), observedAt: new Date(Date.now() - 1000).toISOString() };
  const receipt = implementation.createDriverAuditHostedEnvironmentActivation(input);
  assert.equal(receipt.workerArmed, false); assert.equal(receipt.environment, 'driver-reports-worker');
  assert.equal(receipt.metadataSha256.environment, sha(input.captures.environment));
  for (const mutation of [
    c => { const j = JSON.parse(c.environment); j.protection_rules.push({ type: 'required_reviewers' }); c.environment = encode(j); },
    c => { c.branches = encode({ total_count: 1, branch_policies: [{ name: '*', type: 'branch' }] }); },
    c => { c.branches = encode({ total_count: 2, branch_policies: [{ name: 'main', type: 'branch' }, { name: '*', type: 'tag' }] }); },
    c => { const j = JSON.parse(c.secrets); j.secrets.push({ name: 'DO_SSH_KEY' }); j.total_count++; c.secrets = encode(j); },
    c => { const j = JSON.parse(c.secrets); j.secrets[0].value = 'must-not-be-accepted'; c.secrets = encode(j); },
  ]) { const c = captures(); mutation(c); assert.throws(() => implementation.createDriverAuditHostedEnvironmentActivation({ ...input, captures: c })); }
});

test('offline preflight verifies retained input bytes without executing code or claiming a durable hosted worker', async t => {
  const f = await fixture(t);
  const result = await implementation.preflightDriverAuditHostedBootstrap(f.input);
  assert.equal(result.status, 'hosted-bootstrap-inputs-validated'); assert.equal(result.workerArmed, false);
  assert.equal(result.sourceFiles, 4); assert.equal(result.builderFiles, 1); assert.equal(result.baselineFiles, 2);
  assert.equal(result.remoteEnvironmentAuthenticated, false);
  assert.deepEqual(result.remainingGates, ['authenticated-environment-readback', 'linux-qualification', 'durable-slot-admission',
    'durable-photo-recovery', 'authenticated-cache-checkpoint']);
  assert.equal(result.networkRequests, 0); assert.equal(result.databaseWrites, 0);
  assert.equal(JSON.stringify(result).includes('fictional-supabase-private-value'), false);
  assert.equal(await fs.stat(path.join(f.root, 'launch-verified.private.json')).then(() => true, () => false), false);
});

async function hostedRecovery(f, changes = {}) {
  const source = JSON.parse(await fs.readFile(f.sourceFile)), envFile = source.environment.path;
  const env = JSON.parse(await fs.readFile(envFile));
  delete env.DRIVER_AUDIT_PHOTO_RECOVERY_DIRECTORY;
  Object.assign(env, { DRIVER_AUDIT_PHOTO_RECOVERY_STORE: 'supabase' }, changes);
  const environment = encode(env); await f.write(envFile, environment);
  source.environment.sha256 = sha(environment);
  const rawSource = encode(source); await f.write(f.sourceFile, rawSource); f.input.sourceConfigSha256 = sha(rawSource);
  const configFile = path.join(f.root, 'sync.json'), config = JSON.parse(await fs.readFile(configFile));
  config.hostedSlotClaims = true;
  const rawConfig = encode(config); await f.write(configFile, rawConfig); f.input.syncSha256 = sha(rawConfig);
}

test('hosted Supabase recovery and durable claims are recognized without certifying runtime or provisioning', async t => {
  const f = await fixture(t); await hostedRecovery(f);
  const result = await implementation.preflightDriverAuditHostedBootstrap(f.input);
  assert.equal(result.photoRecoveryStore, 'supabase'); assert.equal(result.hostedSlotClaimsConfigured, true);
  assert.equal(result.workerArmed, false); assert.equal(result.remoteEnvironmentAuthenticated, false);
  assert(result.remainingGates.includes('durable-photo-recovery'));
  assert(result.remainingGates.includes('durable-slot-admission'));
  assert.equal(result.networkRequests, 0); assert.equal(result.databaseWrites, 0);
});

test('hosted recovery rejects local conflicts, unknown stores and missing durable claims', async t => {
  for (const change of ['directory', 'store', 'claims']) {
    const f = await fixture(t); await hostedRecovery(f, change === 'directory'
      ? { DRIVER_AUDIT_PHOTO_RECOVERY_DIRECTORY: path.join(f.root, 'photo-recovery') }
      : change === 'store' ? { DRIVER_AUDIT_PHOTO_RECOVERY_STORE: 'other' } : {});
    if (change === 'claims') {
      const filename = path.join(f.root, 'sync.json'), value = JSON.parse(await fs.readFile(filename));
      value.hostedSlotClaims = false; const raw = encode(value); await f.write(filename, raw); f.input.syncSha256 = sha(raw);
    }
    await assert.rejects(implementation.preflightDriverAuditHostedBootstrap(f.input));
  }
});

test('changed source, builder, baseline, renderer or journal bytes stop input validation', async t => {
  for (const name of ['runtime/source/api/collector.mjs', 'builder/scripts/run-automatic-report.mjs',
    'baseline/publication.private.json', 'baseline/build.private.json', 'validation-journals.private.json']) {
    const f = await fixture(t);
    const file = name.startsWith('runtime/') ? path.join(path.dirname(f.sourceFile), name) : path.join(f.root, name);
    await fs.appendFile(file, 'changed');
    await assert.rejects(implementation.preflightDriverAuditHostedBootstrap(f.input));
  }
});

test('unknown code, unsafe permissions, symlinks and altered scope snapshots are preserved and rejected', async t => {
  for (const kind of ['unknown', 'mode', 'link', 'scope']) {
    const f = await fixture(t), file = path.join(f.root, 'builder/scripts/run-automatic-report.mjs');
    if (kind === 'unknown') await f.write(path.join(f.root, 'builder/unlisted.mjs'), 'private');
    if (kind === 'mode') await fs.chmod(file, 0o644);
    if (kind === 'link') { await fs.rename(file, path.join(f.root, 'original.mjs')); await fs.symlink(path.join(f.root, 'original.mjs'), file); }
    if (kind === 'scope') await fs.appendFile(path.join(f.root, 'provisioning/environment.private.json'), ' ');
    await assert.rejects(implementation.preflightDriverAuditHostedBootstrap(f.input));
    assert.ok(await fs.lstat(file));
  }
});

test('a code file changed after its hash read cannot pass the final bootstrap input seal', async t => {
  const f = await fixture(t), open = fs.open;
  const code = path.join(f.root, 'builder/scripts/run-automatic-report.mjs'); let reached = false;
  fs.open = async function (file, ...args) {
    if (!reached && file === path.join(f.root, 'validation-journals.private.json')) {
      reached = true; await fs.appendFile(code, '// Independent late change\n');
    }
    return open.call(this, file, ...args);
  };
  try { await assert.rejects(implementation.preflightDriverAuditHostedBootstrap(f.input)); }
  finally { fs.open = open; }
  assert(reached); assert.match(await fs.readFile(code, 'utf8'), /Independent late change/);
});

test('invalid source credentials or enabled grading without its original credential binding fail closed', async t => {
  for (const change of [env => { env.CRON_SECRET = 'short'; }, env => { env.MATTER_PHOTO_GRADE_ENABLED = '1'; },
    env => { env.MATTER_SUPABASE_SECRET = 'invalid\nprivate-value'; }]) {
    const f = await fixture(t), source = JSON.parse(await fs.readFile(f.sourceFile)), envFile = source.environment.path;
    const env = JSON.parse(await fs.readFile(envFile)); change(env);
    const bytes = encode(env); await f.write(envFile, bytes); source.environment.sha256 = sha(bytes);
    const sourceBytes = encode(source); await f.write(f.sourceFile, sourceBytes); f.input.sourceConfigSha256 = sha(sourceBytes);
    await assert.rejects(implementation.preflightDriverAuditHostedBootstrap(f.input));
  }
});

test('release identities must come from the externally pinned private file with exact shape and safe permissions', async t => {
  for (const change of ['missing-hash', 'changed', 'extra-field', 'bad-hash', 'bad-count', 'bad-version', 'mode', 'symlink']) {
    const f = await fixture(t), filename = path.join(f.root, 'hosted-release-pins.private.json');
    if (change === 'missing-hash') delete f.input.pinsSha256;
    if (change === 'changed') await fs.appendFile(filename, ' ');
    if (['extra-field', 'bad-hash', 'bad-count', 'bad-version'].includes(change)) {
      const pins = JSON.parse(await fs.readFile(filename));
      if (change === 'extra-field') pins.unreviewed = true;
      if (change === 'bad-hash') pins.sourceManifestSha256 = ['not a typed digest'];
      if (change === 'bad-count') pins.baselineFiles = '2';
      if (change === 'bad-version') pins.nodeVersion = ['not a typed version'];
      const raw = encode(pins); await f.write(filename, raw); f.input.pinsSha256 = sha(raw);
    }
    if (change === 'mode') await fs.chmod(filename, 0o644);
    if (change === 'symlink') { await fs.rename(filename, filename + '.retained'); await fs.symlink(filename + '.retained', filename); }
    await assert.rejects(implementation.preflightDriverAuditHostedBootstrap(f.input));
  }
});

test('a private release pin changed after admission cannot pass the final input seal', async t => {
  const f = await fixture(t), open = fs.open, filename = path.join(f.root, 'hosted-release-pins.private.json');
  let reached = false;
  fs.open = async function (file, ...args) {
    if (!reached && file === path.join(f.root, 'validation-journals.private.json')) {
      reached = true; await fs.appendFile(filename, ' ');
    }
    return open.call(this, file, ...args);
  };
  try { await assert.rejects(implementation.preflightDriverAuditHostedBootstrap(f.input)); }
  finally { fs.open = open; }
  assert.equal(reached, true);
});

test('the executable exposes only offline plan/input validation and never prints private error causes', async () => {
  const run = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(moduleUrl), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
  });
  const plan = await run(['--plan']); assert.equal(plan.code, 0); assert.equal(JSON.parse(plan.stdout).workerArmed, false);
  for (const args of [['--run'], ['--validate-inputs', '--root', '/private-fictional-sensitive-path']]) {
    const result = await run(args); assert.equal(result.code, 1); assert.equal(result.stdout, '');
    assert.equal(result.stderr.includes('sensitive-path'), false);
  }
});
