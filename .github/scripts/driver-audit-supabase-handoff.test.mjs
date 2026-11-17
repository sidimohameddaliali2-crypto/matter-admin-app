import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import dotenv from '../../server/node_modules/dotenv/lib/main.js';
import { sealTransferSecrets, openTransferSecrets } from '../../server/services/driverAuditTransferCodec.js';
import { acquireWorkerLock } from '../../server/vendor/driver-audits/integration/hosted/worker-lock.mjs';

const operator = await import('./driver-audit-supabase-handoff.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const commit = 'a'.repeat(40);
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
const recipientPublicKey = publicKey.export({ type: 'spki', format: 'pem' });

async function fixture(t) {
  const appRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'supabase-handoff-')));
  t.after(() => fs.rm(appRoot, { recursive: true, force: true }));
  const server = path.join(appRoot, 'server'), root = path.join(server, '.private/driver-audits', 'b'.repeat(64));
  const write = async (file, bytes) => {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, bytes, { mode: 0o600 });
    return { path: file, sha256: hash(bytes) };
  };
  const rendererBuild = await write(path.join(root, 'baseline/build.private.json'), '{"version":1}');
  const journals = await write(path.join(root, 'validation-journals.private.json'), '{"version":1}');
  const files = {};
  for (let index = 0; index < 73; index++) {
    const name = index === 0 ? 'scripts/run-automatic-report.mjs' : 'integration/cloud/module-' + index + '.mjs';
    files[name] = (await write(path.join(root, 'builder', name), 'export {};\n')).sha256;
  }
  const builder = await write(path.join(root, 'builder/runtime-manifest.json'), JSON.stringify({ version: 1, files }));
  const baseline = await write(path.join(root, 'baseline/files.private.json'), '{"files":[]}');
  const seed = { version: 1, collectorRevision: 7, manifestSha256: baseline.sha256 };
  await write(path.join(root, 'seed.json'), JSON.stringify(seed));
  const config = { version: 1, root, codeRoot: path.join(root, 'builder'), baselineRoot: path.join(root, 'baseline'),
    builderSha256: builder.sha256, rendererBuild, journals };
  const configFile = path.join(root, 'sync.json');
  await write(configFile, JSON.stringify(config));
  await fs.mkdir(path.join(server, '.private/driver-audit-source'), { mode: 0o700 });
  const secret = 'fictional-secret-NEVER-EXPORT';
  await write(path.join(server, '.env'), 'JWT_SECRET=' + secret + '\nMATTER_SUPABASE_SECRET=' + secret + '\nMONGODB_URI=' + secret + '\n');
  await write(path.join(server, '.env.local'), 'SPACES_ENDPOINT=https://fra1.digitaloceanspaces.com\nSPACES_REGION=fra1\nSPACES_BUCKET=fictional-private\nSPACES_KEY=' + secret + '\nSPACES_SECRET=' + secret + '\n');
  const nginxRoot = path.join(appRoot, 'nginx');
  await write(path.join(nginxRoot, 'nginx.conf'), 'events {}\nhttp {}\n');
  const rows = [
    { name: 'matter-delivery-api', pm_id: 1, pid: 123, pm2_env: { status: 'online', pm_cwd: appRoot,
      pm_exec_path: '/usr/bin/npm', args: ['start', '--prefix', 'server'], pm_uptime: 12345, env: { MONGODB_URI: secret } } },
    { name: 'matter-driver-audit-sync', pm_id: 2, pid: 0, pm2_env: { status: 'stopped', pm_cwd: server,
      pm_exec_path: path.join(server, 'scripts/driverAuditSync.js'), args: ['--config', configFile], exec_interpreter: process.execPath } },
  ];
  const calls = [], loads = [];
  let observations = 0;
  const adapters = { platform: 'linux', nginxRoot,
    async exec(file, args) {
      calls.push({ file, args });
      if (file === 'git') return { stdout: args[0] === 'rev-parse' ? commit + '\n' : '' };
      assert.equal(file, 'pm2'); assert.deepEqual(args, ['jlist']); observations++;
      return { stdout: JSON.stringify(rows) };
    },
    async load(name) {
      loads.push(name);
      if (name === 'services/driverAuditTransferCodec.js') return { sealTransferSecrets };
      if (name === 'vendor/driver-audits/integration/hosted/worker-lock.mjs') return { acquireWorkerLock };
      if (name === 'node_modules/dotenv/lib/main.js') return dotenv;
      throw Error('Unreviewed app module requested: ' + name);
    },
    async systemFile() { return { realpath: '/usr/share/nodejs/npm/bin/npm-cli.js', uid: 0, mode: 0o100644,
      bytes: 1000, sha256: 'f'.repeat(64) }; },
  };
  const run = async (changes = {}) => {
    assert.equal(typeof operator.runDriverAuditSupabaseHandoff, 'function');
    return operator.runDriverAuditSupabaseHandoff({ operation: 'inspect-supabase-host', appRoot, expectedSha: commit,
      recipientPublicKey, ...changes }, adapters);
  };
  return { appRoot, server, root, config, configFile, seed, secret, rows, calls, loads, adapters, run,
    observations: () => observations, write };
}

test('Supabase host inspection seals exact stopped-worker metadata without opening a database or exporting credentials', async t => {
  const f = await fixture(t), before = await fs.readFile(f.configFile);
  const result = await f.run();
  assert.equal(result.status, 'supabase-host-inspected');
  assert.equal(result.readOnly, true);
  assert.equal(result.workersStarted, false);
  assert.equal(result.routingChanged, false);
  const capsule = openTransferSecrets(privateKey, result.capsule);
  const { gunzipSync } = await import('node:zlib');
  const raw = gunzipSync(Buffer.from(capsule.metadataGzipBase64, 'base64'));
  assert.equal(hash(raw), result.metadataSha256);
  const evidence = JSON.parse(raw);
  assert.equal(evidence.applicationCommit, commit);
  assert.equal(evidence.sync.config.root, f.root);
  assert.equal(evidence.sync.builder.files, 73);
  assert.equal(evidence.sync.seed.value.collectorRevision, 7);
  assert.equal(evidence.configuration.supabase.secretConfigured, true);
  assert.equal(evidence.mongoConnections, 0);
  assert(!JSON.stringify(result).includes(f.root));
  assert(!JSON.stringify(result).includes(f.secret));
  assert(!raw.includes(Buffer.from(f.secret)));
  assert(!raw.includes(Buffer.from('MONGODB_URI')));
  assert.deepEqual(await fs.readFile(f.configFile), before);
  assert(f.calls.every(call => call.file === 'git' || call.file === 'pm2' && call.args.join() === 'jlist'));
  assert(f.loads.every(name => !/mongoose|Mongo|DataBackend|loadEnv/.test(name)));
});

test('inspection rejects an unreviewed host, recipient or ambiguous or active report worker before sealing', async t => {
  for (const change of [f => { f.adapters.platform = 'darwin'; }, f => { f.rows.push(structuredClone(f.rows[1])); },
    f => { f.rows[1].pm2_env.status = 'online'; f.rows[1].pid = 234; },
    f => { f.rows[1].pm2_env.pm_exec_path = path.join(f.server, 'server.js'); },
    f => { f.rows[0].pm2_env.args = ['start']; }]) {
    const f = await fixture(t); change(f);
    await assert.rejects(f.run(), /Supabase handoff stopped/);
  }
  const f = await fixture(t);
  await assert.rejects(f.run({ recipientPublicKey: 'PRIVATE KEY must not enter logs' }), /Supabase handoff stopped/);
  assert.equal(f.observations(), 0);
});

test('untracked or dirty reviewed app code is rejected before reading any worker or credential', async t => {
  for (const command of ['ls-files', 'diff']) {
    const f = await fixture(t), original = f.adapters.exec;
    f.adapters.exec = (file, args) => {
      if (file === 'git' && args[0] === command) throw Error('fictional-sensitive-error-DO-NOT-OUTPUT');
      return original(file, args);
    };
    await assert.rejects(f.run(), error => error.message === 'Supabase handoff stopped at checkout');
    assert.equal(f.observations(), 0);
  }
});

test('the before and after census rejects independent configuration drift without restoring over it', async t => {
  const f = await fixture(t), original = f.adapters.exec;
  f.adapters.exec = async (file, args) => {
    if (file === 'pm2' && f.observations() === 2) await f.write(f.configFile, JSON.stringify({ ...f.config, independentEdit: true }));
    return original(file, args);
  };
  await assert.rejects(f.run(), /Supabase handoff stopped/);
  assert.equal(JSON.parse(await fs.readFile(f.configFile)).independentEdit, true);
});

test('corrupt, unlisted or linked builder files never become a verified inspection', async t => {
  for (const change of [f => f.write(path.join(f.root, 'builder/integration/cloud/module-1.mjs'), 'changed'),
    f => f.write(path.join(f.root, 'builder/unlisted.mjs'), 'unexpected'),
    async f => {
      const file = path.join(f.root, 'builder/integration/cloud/module-1.mjs');
      await fs.unlink(file); await fs.symlink(path.join(f.root, 'seed.json'), file);
    }]) {
    const f = await fixture(t); await change(f);
    await assert.rejects(f.run(), /Supabase handoff stopped/);
  }
});

test('existing environment read permissions and absent optional Spaces endpoint do not trigger network probes', async t => {
  const f = await fixture(t);
  await fs.chmod(path.join(f.server, '.env'), 0o644);
  await f.write(path.join(f.server, '.env.local'), 'SPACES_BUCKET=fictional-private\n');
  const result = await f.run(), sealed = openTransferSecrets(privateKey, result.capsule);
  const { gunzipSync } = await import('node:zlib');
  const evidence = JSON.parse(gunzipSync(Buffer.from(sealed.metadataGzipBase64, 'base64')));
  assert.deepEqual(evidence.configuration.spaces, { configured: false, identitySha256: null });
  assert(!f.loads.some(name => /Mongo|Spaces|Backend/.test(name)));
});

test('Nginx inspection cannot follow a configured link outside the fixed config root', async t => {
  const f = await fixture(t), directory = path.join(f.adapters.nginxRoot, 'sites-enabled');
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.symlink(path.join(f.server, '.env'), path.join(directory, 'outside.conf'));
  await assert.rejects(f.run(), /Supabase handoff stopped/);
});

test('unrelated nested config values are not copied into the sealed metadata projection', async t => {
  const f = await fixture(t);
  await f.write(f.configFile, JSON.stringify({ ...f.config,
    rendererBuild: { ...f.config.rendererBuild, accidentalSecret: f.secret },
    journals: { ...f.config.journals, accidentalSecret: f.secret },
    legacyBuildRecipe: { builderSha256: 'a'.repeat(64), accidentalSecret: f.secret } }));
  const result = await f.run(), sealed = openTransferSecrets(privateKey, result.capsule);
  const { gunzipSync } = await import('node:zlib');
  const raw = gunzipSync(Buffer.from(sealed.metadataGzipBase64, 'base64'));
  assert(!raw.includes(Buffer.from(f.secret)));
});

test('the host bridge dispatches Supabase inspection without loading any native transfer or database module', async t => {
  const f = await fixture(t), bin = path.join(f.appRoot, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'git'), '#!/bin/sh\nprintf "%s\\n" ' + commit + '\n', { mode: 0o700 });
  await fs.mkdir(path.join(f.server, 'services'), { recursive: true });
  await fs.writeFile(path.join(f.server, 'package.json'), '{"type":"module"}');
  await fs.copyFile(fileURLToPath(new URL('../../server/services/driverAuditSource.js', import.meta.url)),
    path.join(f.server, 'services/driverAuditSource.js'));
  const code = 'export async function runDriverAuditSupabaseHandoff(args){' +
    'if(args.operation!=="inspect-supabase-host"||args.expectedSha!=="' + commit + '"||!args.recipientPublicKey)throw Error("Wrong dispatch");' +
    'return {status:"supabase-host-inspected",readOnly:true,mongoConnections:0};}';
  const script = fileURLToPath(new URL('./driver-audit-native-handoff.mjs', import.meta.url));
  const source = 'Object.defineProperty(process,"platform",{value:"linux"});process.chdir(' + JSON.stringify(f.appRoot) +
    ');process.argv.push("--run");await import(' + JSON.stringify(script) + ');';
  const output = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], { env: {
    PATH: bin, EXPECTED_DEPLOYED_SHA: commit, NATIVE_HANDOFF_OPERATION: 'inspect-supabase-host',
    NATIVE_IMPORT_CODE: Buffer.from(code).toString('base64'),
    NATIVE_TRANSFER_PLAN_B64: Buffer.from(JSON.stringify({ version: 1, recipientPublicKey })).toString('base64'),
  } });
  assert.deepEqual(JSON.parse(output.stdout), { status: 'supabase-host-inspected', readOnly: true, mongoConnections: 0 });
});

test('a strict bare Spaces hostname and its HTTPS spelling have the same sealed configuration identity', async t => {
  const f = await fixture(t), { gunzipSync } = await import('node:zlib');
  const identity = async () => {
    const result = await f.run(), capsule = openTransferSecrets(privateKey, result.capsule);
    return JSON.parse(gunzipSync(Buffer.from(capsule.metadataGzipBase64, 'base64'))).configuration.spaces;
  };
  const https = await identity();
  const file = path.join(f.server, '.env.local'), before = await fs.readFile(file, 'utf8');
  await f.write(file, before.replace('https://fra1.digitaloceanspaces.com', 'fra1.digitaloceanspaces.com'));
  assert.deepEqual(await identity(), https);
  for (const endpoint of ['http://fra1.digitaloceanspaces.com', 'https://u:p@fra1.digitaloceanspaces.com',
    'https://fra1.digitaloceanspaces.com:443', 'https://fra1.digitaloceanspaces.com/../',
    'https://fra1.digitaloceanspaces.com?token=private', 'fra1.digitaloceanspaces.com/photos']) {
    await f.write(file, before.replace('https://fra1.digitaloceanspaces.com', endpoint));
    await assert.rejects(f.run(), /Supabase handoff stopped/);
  }
});

test('metadata failures report only the fixed failing subphase while all existing guards remain closed', async t => {
  const cases = [
    ['configuration', f => f.write(path.join(f.server, '.env.local'), 'SPACES_ENDPOINT=not-a-provider\n')],
    ['sync-config', f => f.write(f.configFile, JSON.stringify({ ...f.config, version: 2 }))],
    ['builder-manifest', f => f.write(f.configFile, JSON.stringify({ ...f.config, builderSha256: 'e'.repeat(64) }))],
    ['builder-tree', f => f.write(path.join(f.root, 'builder/integration/cloud/module-1.mjs'), f.secret)],
    ['renderer', f => f.write(f.config.rendererBuild.path, f.secret)],
    ['journals', f => f.write(f.config.journals.path, f.secret)],
    ['baseline', f => fs.unlink(path.join(f.root, 'baseline/files.private.json'))],
    ['seed', f => f.write(path.join(f.root, 'seed.json'), JSON.stringify({ ...f.seed, manifestSha256: 'e'.repeat(64) }))],
    ['pointers', f => f.write(path.join(f.root, 'work/current.private.json'), f.secret)],
    ['source', f => f.write(path.join(f.server, '.private/driver-audit-source', 'c'.repeat(64), 'source.json'), f.secret)],
    ['nginx', async f => {
      const directory = path.join(f.adapters.nginxRoot, 'sites-enabled');
      await fs.mkdir(directory, { mode: 0o700 });
      await fs.symlink(path.join(f.server, '.env'), path.join(directory, 'outside.conf'));
    }],
  ];
  for (const [name, change] of cases) {
    const f = await fixture(t); await change(f);
    await assert.rejects(f.run(), error => {
      assert.equal(error.phase, 'inspect-' + name);
      assert.equal(error.message, 'Supabase handoff stopped at inspect-' + name);
      assert.deepEqual(Object.keys(error), ['phase']);
      assert(!error.message.includes(f.secret) && !error.message.includes(f.root));
      return true;
    });
  }
});

test('worker and second-census failures identify their fixed boundary without exporting independent edits', async t => {
  const first = await fixture(t);
  first.rows[0].pm2_env.args = ['start'];
  await assert.rejects(first.run(), error => error.phase === 'workers' && error.message === 'Supabase handoff stopped at workers');

  const f = await fixture(t), original = f.adapters.exec;
  f.adapters.exec = async (file, args) => {
    if (file === 'pm2' && f.observations() === 2) await f.write(path.join(f.root, 'seed.json'), f.secret);
    return original(file, args);
  };
  await assert.rejects(f.run(), error => error.phase === 'readback-seed'
    && error.message === 'Supabase handoff stopped at readback-seed');
  assert.equal(await fs.readFile(path.join(f.root, 'seed.json'), 'utf8'), f.secret);
});
