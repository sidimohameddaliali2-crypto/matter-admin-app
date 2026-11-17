import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { sealTransferSecrets, openTransferSecrets } from '../../server/services/driverAuditTransferCodec.js';
import { acquireWorkerLock } from '../../server/vendor/driver-audits/integration/hosted/worker-lock.mjs';
const subject = await import('./driver-audit-supabase-log-archive.mjs').catch(e => { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; return {}; });
const APP = '701655794e1711b4d8c737e929360ecfe5d2f0ca', sha = b => createHash('sha256').update(b).digest('hex');
const keys = generateKeyPairSync('rsa', { modulusLength: 3072 }), recipientPublicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
async function fixture(t) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'log-plan-'))); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const appRoot = path.join(home, 'matter-delivery-tracker'), server = path.join(appRoot, 'server'), logs = path.join(home, '.pm2/logs');
  const lockRoot = path.join(server, '.private/driver-report-supabase-handoff');
  await fs.mkdir(logs, { recursive: true, mode: 0o700 }); await fs.mkdir(lockRoot, { recursive: true, mode: 0o700 });
  const secret = 'fictional-private-log-body', files = { active: 'matter-delivery-api-out.log', stopped: 'matter-driver-audit-sync-out.log',
    gzip: 'matter-driver-audit-sync-out.log.1.gz', unknown: 'old-unregistered.log' };
  for (const name of Object.values(files)) await fs.writeFile(path.join(logs, name), secret, { mode: 0o600 });
  const rows = [
    { name: 'matter-delivery-api', pm_id: 1, pid: 123, pm2_env: { status: 'online', pm_cwd: appRoot, pm_exec_path: '/usr/bin/npm',
      args: ['start', '--prefix', 'server'], pm_out_log_path: path.join(logs, files.active), pm_err_log_path: path.join(logs, 'matter-delivery-api-error.log'), JWT_SECRET: secret } },
    { name: 'matter-driver-audit-sync', pm_id: 2, pid: 0, pm2_env: { status: 'stopped', pm_cwd: server,
      pm_exec_path: path.join(server, 'scripts/driverAuditSync.js'), args: ['--config', path.join(server, '.private/driver-audits', 'b'.repeat(64), 'sync.json')],
      pm_out_log_path: path.join(logs, files.stopped), pm_err_log_path: path.join(logs, 'matter-driver-audit-sync-error.log') } },
  ];
  const calls = [], loads = [], opened = [];
  const adapters = { platform: 'linux', homeRoot: home, filesystem: { ...fs,
    async open(file, flags, ...args) {
      opened.push(String(file));
      assert(!String(file).startsWith(logs + '/'), 'Log bodies must not be opened');
      return fs.open(file, flags, ...args);
    } },
    async exec(file, args) {
      calls.push({ file, args });
      if (file === 'git') return { stdout: args[0] === 'rev-parse' ? APP + '\n' : '' };
      if (file === '/usr/bin/which') return { stdout: '/unavailable/pm2\n' };
      assert.equal(file, 'pm2');
      if (args[0] === '--version') return { stdout: '6.0.0\n' };
      assert.deepEqual(args, ['jlist']); return { stdout: JSON.stringify(rows) };
    },
    async load(name) { loads.push(name); if (name.includes('worker-lock')) return { acquireWorkerLock };
      if (name === 'services/driverAuditTransferCodec.js') return { sealTransferSecrets }; throw Error('Unexpected module'); },
  };
  const run = changes => { assert.equal(typeof subject.runDriverAuditSupabaseLogArchive, 'function');
    return subject.runDriverAuditSupabaseLogArchive({ operation: 'plan-log-archive', appRoot, expectedSha: APP, recipientPublicKey, ...changes }, adapters); };
  return { home, appRoot, server, logs, lockRoot, files, secret, rows, calls, loads, opened, adapters, run };
}
function opened(result) {
  const envelope = openTransferSecrets(keys.privateKey, result.capsule), packed = Buffer.from(envelope.metadataGzipBase64, 'base64');
  assert.equal(sha(packed), envelope.metadataGzipSha256); const raw = gunzipSync(packed, { maxOutputLength: 384 * 1024 });
  assert.equal(sha(raw), result.metadataSha256); return JSON.parse(raw);
}
test('a log plan stores exact private metadata and maps active, stopped, gzip-name and unknown logs without opening bodies', async t => {
  const f = await fixture(t), before = await fs.stat(path.join(f.logs, f.files.stopped), { bigint: true }), result = await f.run(), meta = opened(result);
  assert.equal(result.status, 'supabase-log-archive-planned'); assert.equal(result.compressionPerformed, false); assert.equal(result.deletedFiles, 0);
  const raw = await fs.readFile(meta.plan.path); assert.equal(sha(raw), result.planSha256); assert.equal(meta.plan.sha256, result.planSha256);
  assert.equal((await fs.stat(meta.plan.path)).mode & 0o7777, 0o600); const plan = JSON.parse(raw);
  assert.equal(plan.files.find(r => r.name === f.files.active).classification, 'active-mapped-log-protected');
  assert.equal(plan.files.find(r => r.name === f.files.stopped).classification, 'managed-stopped-log-review-candidate');
  assert.equal(plan.files.find(r => r.name === f.files.gzip).classification, 'gzip-name-protected');
  assert.equal(plan.files.find(r => r.name === f.files.unknown).classification, 'unknown-log-protected');
  assert.equal(plan.logBodyBytesRead, 0); assert.equal(plan.compressionAuthorized, false); assert.equal(plan.openFileDescriptorsVerified, false);
  assert.equal(plan.pm2Implementation.observedCliVersion, '6.0.0'); assert.equal(plan.pm2Implementation.activeArchiveQualified, false);
  assert.equal(plan.pm2Implementation.codeFingerprints.status, 'not-captured');
  assert(!raw.includes(Buffer.from(f.secret))); assert(!JSON.stringify(result).includes(f.home)); assert(!JSON.stringify(result).includes(f.secret));
  assert(!raw.includes(Buffer.from('JWT_SECRET'))); assert.deepEqual(await fs.stat(path.join(f.logs, f.files.stopped), { bigint: true }), before);
  assert(f.loads.every(name => !/Mongo|loadEnv|DataBackend/i.test(name))); assert(f.calls.every(r => ['git', 'pm2', '/usr/bin/which'].includes(r.file)));
});
test('symlink hardlink nonregular and unsafe leaves remain protected and are never followed or modified', async t => {
  const f = await fixture(t), outside = path.join(f.home, 'original-evidence'); await fs.writeFile(outside, f.secret, { mode: 0o600 });
  await fs.symlink(outside, path.join(f.logs, 'alias.log')); await fs.link(outside, path.join(f.logs, 'shared.log'));
  await fs.mkdir(path.join(f.logs, 'directory.log')); await fs.chmod(path.join(f.logs, f.files.stopped), 0o666);
  const plan = JSON.parse(await fs.readFile(opened(await f.run()).plan.path));
  for (const name of ['alias.log', 'shared.log', 'directory.log', f.files.stopped]) assert.equal(plan.files.find(r => r.name === name).eligibleForSeparateArchiveReview, false);
  assert.equal(await fs.readFile(outside, 'utf8'), f.secret); assert((await fs.lstat(path.join(f.logs, 'alias.log'))).isSymbolicLink());
});
test('active append is retained and observed rather than requiring stable active log sizes', async t => {
  const f = await fixture(t), exec = f.adapters.exec; let changed = false;
  f.adapters.exec = async (file, args) => {
    if (file === 'pm2' && args[0] === '--version') { changed = true; await fs.appendFile(path.join(f.logs, f.files.active), ' new business log'); }
    return exec(file, args);
  };
  const plan = JSON.parse(await fs.readFile(opened(await f.run()).plan.path)); assert(changed);
  const row = plan.files.find(r => r.name === f.files.active); assert.equal(row.classification, 'active-mapped-log-protected');
  assert.equal(row.changedDuringPlanning, true); assert((await fs.readFile(path.join(f.logs, f.files.active), 'utf8')).endsWith(' new business log'));
});
test('missing mappings and shared active mappings cannot turn stopped or unidentified files into archive candidates', async t => {
  const f = await fixture(t); delete f.rows[0].pm2_env.pm_err_log_path;
  const plan = JSON.parse(await fs.readFile(opened(await f.run()).plan.path));
  assert.equal(plan.mappingComplete, false); assert(plan.files.every(r => !r.eligibleForSeparateArchiveReview));
  f.rows[0].pm2_env.pm_err_log_path = path.join(f.logs, f.files.stopped);
  const next = JSON.parse(await fs.readFile(opened(await f.run()).plan.path));
  assert.equal(next.files.find(r => r.name === f.files.stopped).classification, 'active-mapped-log-protected');
});
test('PM2 process drift, root substitution and caller-selected paths fail without a plan or changed originals', async t => {
  for (const kind of ['process', 'root']) {
    const f = await fixture(t), exec = f.adapters.exec;
    f.adapters.exec = async (file, args) => {
      if (file === 'pm2' && args[0] === '--version') {
        if (kind === 'process') f.rows[0].pid++;
        else { await fs.rename(f.logs, f.logs + '-original'); await fs.mkdir(f.logs, { mode: 0o700 }); }
      }
      return exec(file, args);
    };
    await assert.rejects(f.run(), /Supabase log archive plan stopped at/);
    await assert.rejects(fs.access(path.join(f.server, '.private/driver-report-log-archives')), { code: 'ENOENT' });
  }
  const f = await fixture(t); await assert.rejects(f.run({ paths: ['/etc'] }), /stopped at inputs/);
});
test('the existing mutex excludes planning and saved-plan conflicts never overwrite evidence', async t => {
  const f = await fixture(t), held = await acquireWorkerLock(path.join(f.lockRoot, 'operator.lock'));
  try { await assert.rejects(f.run(), /stopped at lock/); } finally { await held.release(); }
  const original = f.adapters.now; f.adapters.now = () => new Date('2026-11-17T23:00:00.000Z');
  const first = opened(await f.run()), file = first.plan.path; await fs.writeFile(file, 'independent saved plan edit', { mode: 0o600 });
  await assert.rejects(f.run(), /stopped at plan-write/); assert.equal(await fs.readFile(file, 'utf8'), 'independent saved plan edit'); f.adapters.now = original;
});

test('a growing stopped-process log remains protected without inferring that daemon file descriptors are closed', async t => {
  const f = await fixture(t), exec = f.adapters.exec;
  f.adapters.exec = async (file, args) => {
    if (file === 'pm2' && args[0] === '--version') await fs.appendFile(path.join(f.logs, f.files.stopped), ' late daemon write');
    return exec(file, args);
  };
  const plan = JSON.parse(await fs.readFile(opened(await f.run()).plan.path)), row = plan.files.find(r => r.name === f.files.stopped);
  assert.equal(row.managedStopped, true); assert.equal(row.classification, 'changing-log-protected');
  assert.equal(row.eligibleForSeparateArchiveReview, false); assert.equal(row.openFileDescriptorsVerified, false);
});
