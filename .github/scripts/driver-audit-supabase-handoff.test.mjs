import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { constants } from 'node:fs';
import test from 'node:test';
import dotenv from '../../server/node_modules/dotenv/lib/main.js';
import { sealTransferSecrets, openTransferSecrets } from '../../server/services/driverAuditTransferCodec.js';
import { acquireWorkerLock } from '../../server/vendor/driver-audits/integration/hosted/worker-lock.mjs';
import { stageDriverAuditSource } from '../../server/scripts/driverAuditSourceStage.js';
import { archiveBytes } from '../../server/vendor/driver-audits/integration/cloud/repository.mjs';
import { verifyDriverAuditSupabaseServingPackage } from '../../server/services/driverAuditSupabaseReplica.js';
import { driverAuditSupabaseStoppedReceipt } from './driver-audit-native-handoff.mjs';

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

async function stagedSource(f, names, { writeFiles = false } = {}) {
  const files = names.map(name => ({ path: name, sha256: hash('export {};\n'), bytes: 11 }));
  const manifest = JSON.stringify({ schemaVersion: 1, files, entrypoints: [] }), manifestSha256 = hash(manifest);
  const root = path.join(f.server, '.private/driver-audit-source', manifestSha256), runtimeRoot = path.join(root, 'runtime');
  for (const name of writeFiles ? names : []) {
    await f.write(path.join(runtimeRoot, name), 'export {};\n');
  }
  await f.write(path.join(runtimeRoot, 'manifest.private.json'), manifest);
  const environment = await f.write(path.join(root, 'environment.private.json'), '{}');
  await f.write(path.join(root, 'source.json'), JSON.stringify({ version: 1, root, runtimeRoot, manifestSha256,
    environment, nodeExecutable: process.execPath, nodeVersion: process.version }));
  return { root, runtimeRoot };
}

test('listed source and builder paths retain legitimate leading-dot files and underscore directories', async t => {
  const f = await fixture(t), { gunzipSync } = await import('node:zlib');
  await stagedSource(f, ['source/.vercelignore', 'source/_lib/handler.mjs'], { writeFiles: true });
  const builderFile = path.join(f.root, 'builder/runtime-manifest.json'), builder = JSON.parse(await fs.readFile(builderFile));
  for (const name of ['.private-build-config', '_lib/reader.mjs']) builder.files[name] = (await f.write(path.join(f.root, 'builder', name), 'export {};\n')).sha256;
  const saved = await f.write(builderFile, JSON.stringify(builder));
  await f.write(f.configFile, JSON.stringify({ ...f.config, builderSha256: saved.sha256 }));
  const result = await f.run(), sealed = openTransferSecrets(privateKey, result.capsule);
  const evidence = JSON.parse(gunzipSync(Buffer.from(sealed.metadataGzipBase64, 'base64')));
  assert.equal(evidence.source.releases[0].files, 2);
  assert.equal(evidence.sync.builder.files, 75);
  assert.equal(evidence.mongoConnections, 0);
});

test('listed paths still reject traversal, absolute, backslash, encoded and non-normalized identities', async t => {
  for (const name of ['source/../escape.mjs', '/source/file.mjs', 'source\\file.mjs', 'source/%2e%2e/escape.mjs',
    'source/%2fescape.mjs', 'source/./file.mjs', 'source//file.mjs', 'source/file.mjs/', 'source/..',
    'source/file.mjs\u0000', 'source/C:/file.mjs', 'source/' + 'a'.repeat(1024)]) {
    const f = await fixture(t); await stagedSource(f, [name]);
    await assert.rejects(f.run(), error => error.phase === 'inspect-source');
    const b = await fixture(t), file = path.join(b.root, 'builder/runtime-manifest.json');
    const manifest = JSON.parse(await fs.readFile(file)); manifest.files[name] = hash('unread');
    const saved = await b.write(file, JSON.stringify(manifest));
    await b.write(b.configFile, JSON.stringify({ ...b.config, builderSha256: saved.sha256 }));
    await assert.rejects(b.run(), error => error.phase === 'inspect-builder-tree');
  }
});

test('legitimate leading-dot paths still reject symlinked files and parent directories', async t => {
  for (const parent of [false, true]) {
    const f = await fixture(t), source = await stagedSource(f, ['source/.vercelignore', 'source/_lib/handler.mjs'], { writeFiles: true });
    if (parent) {
      const directory = path.join(source.runtimeRoot, 'source/_lib');
      await fs.rm(directory, { recursive: true });
      const outside = path.join(f.server, '.private/outside');
      await f.write(path.join(outside, 'handler.mjs'), 'export {};\n');
      await fs.symlink(outside, directory);
    } else {
      const file = path.join(source.runtimeRoot, 'source/.vercelignore');
      await fs.unlink(file); await fs.symlink(path.join(f.server, '.env'), file);
    }
    await assert.rejects(f.run(), error => error.phase === 'inspect-source');
  }
});

async function preparationFixture(t) {
  const f = await fixture(t), node = { executable: '/usr/bin/node', version: 'v22.23.4', sha256: hash('fictional-node') };
  f.adapters.node = node;
  const original = Object.fromEntries(['CRON_SECRET', 'MATTER_SUPABASE_SECRET', 'MATTER_DELIVERY_API_KEY', 'AI_GATEWAY_API_KEY',
    'MATTER_DELIVERY_ENABLED', 'MATTER_PHOTO_READ_ENABLED', 'MATTER_PHOTO_GRADE_ENABLED', 'MATTER_GPS_ENABLED',
    'MATTER_GPS_PUBLICATION_ENABLED'].map(name => [name, name.endsWith('_ENABLED') ? 'true' : f.secret]));
  const oldSource = await stagedSource(f, ['source/.vercelignore'], { writeFiles: true });
  const oldConfigFile = path.join(oldSource.root, 'source.json'), oldConfig = JSON.parse(await fs.readFile(oldConfigFile));
  oldConfig.environment = await f.write(oldConfig.environment.path, JSON.stringify({ ...original, DRIVER_AUDIT_DATA_STORE: 'mongo' }));
  Object.assign(oldConfig, { nodeExecutable: node.executable, nodeVersion: node.version });
  await f.write(oldConfigFile, JSON.stringify(oldConfig));
  const baselineFile = await f.write(path.join(f.root, 'baseline/input.private.json'), '{"original":true}');
  const baseline = await f.write(path.join(f.root, 'baseline/files.private.json'), JSON.stringify({ 'input.private.json': baselineFile.sha256 }));
  f.seed.manifestSha256 = baseline.sha256; await f.write(path.join(f.root, 'seed.json'), JSON.stringify(f.seed));
  const makePackage = async (id, collectorRevision) => {
    const parent = path.join(f.root, 'work/attempts', id), privateRoot = path.join(parent, 'server-data');
    const data = await f.write(path.join(privateRoot, 'original-data.private.json'), '{"retained":' + collectorRevision + '}');
    const manifest = await f.write(path.join(privateRoot, 'files.private.json'), JSON.stringify({ 'original-data.private.json': data.sha256 }));
    const value = { version: 1, privateRoot, collectorRevision, sourceBasis: hash('basis-' + collectorRevision),
      manifestSha256: manifest.sha256, generation: hash('generation-' + collectorRevision), reportHash: hash('report-' + collectorRevision) };
    const accepted = await f.write(path.join(parent, 'accepted.private.json'), JSON.stringify(value));
    return { ...value, attemptId: id, acceptedSha256: accepted.sha256, directSeedSha256: null };
  };
  const current = await makePackage('11111111-1111-4111-8111-111111111111', 11);
  const serving = await makePackage('22222222-2222-4222-8222-222222222222', 10);
  const previous = await makePackage('33333333-3333-4333-8333-333333333333', 9);
  await f.write(path.join(f.root, 'work/current.private.json'), JSON.stringify(current));
  await f.write(path.join(f.server, 'package.json'), '{"type":"module","scripts":{"start":"node server.js"}}');
  const lock = await f.write(path.join(f.server, 'package-lock.json'), '{"lockfileVersion":3}');
  await fs.mkdir(path.join(f.server, 'node_modules'), { mode: 0o700 });
  const oldBuilder = JSON.parse(await fs.readFile(path.join(f.root, 'builder/runtime-manifest.json')));
  const builderRows = [];
  for (const name of Object.keys(oldBuilder.files)) {
    const bytes = name === 'integration/cloud/module-1.mjs' ? Buffer.from('export const managed = true;\n') : await fs.readFile(path.join(f.root, 'builder', name));
    oldBuilder.files[name] = hash(bytes); builderRows.push({ path: name, dataBase64: bytes.toString('base64') });
  }
  const builderManifest = Buffer.from(JSON.stringify(oldBuilder)), builderSha256 = hash(builderManifest);
  builderRows.unshift({ path: 'runtime-manifest.json', dataBase64: builderManifest.toString('base64') });
  const sourceBytes = Buffer.from('export {};\n'), sourceFiles = ['source/api/fixture.mjs', 'source/integration/hosted/native-backend.mjs',
    'source/integration/hosted/archive-read-cache.mjs', 'source/integration/cloud/native-poll-progress.mjs'];
  const sourceManifest = Buffer.from(JSON.stringify({ schemaVersion: 1,
    managedSourceExecutionHost: 'sidi', managedSourceExecutionAdmission: 'fixed-host-v1',
    files: sourceFiles.map(path => ({ path, sha256: hash(sourceBytes), bytes: sourceBytes.length })),
    entrypoints: [{ id: 'delivery', module: 'source/api/fixture.mjs', exportName: 'default', method: 'GET',
      path: '/api/collector?task=delivery', schedule: '* * * * *', timeZone: 'UTC', maxDurationSeconds: 300,
      requiredEnvironment: ['CRON_SECRET', 'MATTER_DELIVERY_ENABLED'] }] }));
  const sourceSha256 = hash(sourceManifest), sourceRows = [{ path: 'manifest.private.json', dataBase64: sourceManifest.toString('base64') },
    ...sourceFiles.map(path => ({ path, dataBase64: sourceBytes.toString('base64') }))];
  const archive = (manifestSha256, files) => {
    const bytes = gzipSync(Buffer.from(JSON.stringify({ version: 1, manifestSha256, files })));
    return { sha256: hash(bytes), bytes: bytes.length, dataBase64: bytes.toString('base64') };
  };
  const inspected = await f.run(), releaseSha = 'd'.repeat(40);
  const bootstrap = { version: 1, kind: 'driver-reports-supabase-bootstrap-v1', releaseSha,
    packageLockSha256: lock.sha256, inspectionMetadataSha256: inspected.metadataSha256,
    expected: { syncConfigSha256: hash(await fs.readFile(f.configFile)), seedSha256: hash(await fs.readFile(path.join(f.root, 'seed.json'))),
      currentPointerSha256: hash(await fs.readFile(path.join(f.root, 'work/current.private.json'))), sourceConfigSha256: hash(await fs.readFile(oldConfigFile)) },
    retained: [{ ...serving, role: 'serving-current' }, { ...previous, role: 'serving-previous' }],
    builder: archive(builderSha256, builderRows), source: archive(sourceSha256, sourceRows) };
  const pins = { release: releaseSha, source: sourceSha256, sourceFiles: sourceFiles.length, oldSource: path.basename(oldSource.root), builder: builderSha256, builderFiles: 73,
    oldBuilder: f.config.builderSha256, baseline: baseline.sha256, baselineRevision: 7, candidate: current.manifestSha256,
    candidateRevision: 11, candidateBasis: current.sourceBasis,
    servingCurrent: { collectorRevision: serving.collectorRevision, manifestSha256: serving.manifestSha256, generation: serving.generation },
    servingPrevious: { collectorRevision: previous.collectorRevision, manifestSha256: previous.manifestSha256, generation: previous.generation } };
  const expectedEnvironment = () => {
    const id = hash(JSON.stringify(['driver-reports-supabase-sync-v1', bootstrap.releaseSha, pins.source, pins.builder, pins.baseline, pins.candidate]));
    return { ...original, MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY: path.join(f.server, '.private/driver-report-app-releases', bootstrap.releaseSha,
      'server/.private/driver-audits', id, 'work/archive-cache'), DRIVER_AUDIT_EXECUTION_HOST: 'sidi' };
  };
  bootstrap.expected.sourceEnvironmentSha256 = hash(JSON.stringify(expectedEnvironment()));
  f.adapters.pins = pins;
  const commands = [], exec = f.adapters.exec;
  f.adapters.exec = async (file, args, options) => {
    commands.push({ file, args, options });
    if (file === 'git' && args[0] === 'clone') {
      const target = args.at(-1); await fs.mkdir(path.join(target, 'server'), { recursive: true, mode: 0o700 });
      await f.write(path.join(target, 'server/package-lock.json'), await fs.readFile(path.join(f.server, 'package-lock.json')));
      await f.write(path.join(target, 'server/package.json'), '{"type":"module"}'); return { stdout: '' };
    }
    if (file === 'git' && args[0] === '-C') return { stdout: args[2] === 'rev-parse' ? (args[3] === '--show-toplevel' ? args[1] : releaseSha) + '\n' : '' };
    if (file === '/usr/bin/npm') {
      if (args[0] === 'ci') {
        await f.write(path.join(options.cwd, 'node_modules/fictional-package/index.js'), 'module.exports = "isolated";\n');
        return { stdout: '' };
      }
      assert.deepEqual(args, ['ls', '--omit=dev', '--all', '--json']);
      return { stdout: JSON.stringify({ name: 'fictional-release', dependencies: { 'fictional-package': { version: '1.0.0' } } }) };
    }
    return exec(file, args);
  };
  let reads = 0;
  f.adapters.bootstrapArchive = { async assertPrivate() { return { public: false }; }, async readObject() { reads++; return [gzipSync(Buffer.from(JSON.stringify(bootstrap)))]; } };
  f.adapters.stageSource = async ({ sourceRoot, compressed, environmentBytes, nodeExecutable }) => {
    const { gunzipSync } = await import('node:zlib'), bundle = JSON.parse(gunzipSync(compressed));
    const root = path.join(sourceRoot, bundle.manifestSha256), runtimeRoot = path.join(root, 'runtime');
    for (const row of bundle.files) await f.write(path.join(runtimeRoot, row.path), Buffer.from(row.dataBase64, 'base64'));
    const environment = await f.write(path.join(root, 'environment.private.json'), environmentBytes);
    const configFile = path.join(root, 'source.json');
    await f.write(configFile, JSON.stringify({ version: 1, root, runtimeRoot, manifestSha256: bundle.manifestSha256,
      nodeExecutable, nodeVersion: bundle.nodeVersion, environment }));
    return { configFile, manifestSha256: bundle.manifestSha256 };
  };
  const run = () => f.run({ operation: 'prepare-supabase-host', bootstrapSha256: hash(gzipSync(Buffer.from(JSON.stringify(bootstrap)))) });
  return { ...f, bootstrap, pins, runPrepare: run, original, commands, expectedEnvironment, reads: () => reads };
}

test('preparing Supabase stages an isolated release and all four original package roles without selecting a serving seed', async t => {
  const f = await preparationFixture(t), original = await fs.readFile(f.configFile), pointer = await fs.readFile(path.join(f.root, 'work/current.private.json'));
  const result = await f.runPrepare();
  assert.equal(result.status, 'supabase-host-prepared'); assert.equal(result.workersStarted, false);
  assert.equal(result.readOnly, false); assert.equal(result.stagingOnly, true); assert.equal(result.databaseWrites, false);
  assert.equal(result.routingChanged, false); assert.equal(result.seedSelected, false); assert.equal(f.reads(), 1);
  const capsule = openTransferSecrets(privateKey, result.capsule), { gunzipSync } = await import('node:zlib');
  const evidence = JSON.parse(gunzipSync(Buffer.from(capsule.metadataGzipBase64, 'base64')));
  assert.equal(evidence.preparation.packages.length, 4);
  const root = evidence.preparation.syncRoot;
  await assert.rejects(fs.access(path.join(root, 'seed.json')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(root, 'work/current.private.json')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(f.configFile), original);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'work/current.private.json')), pointer);
  const env = dotenv.parse(await fs.readFile(path.join(evidence.preparation.releaseRoot, 'server/.env.local')));
  assert.equal(env.DRIVER_AUDIT_EXECUTION_HOST, 'sidi'); assert.equal(env.DRIVER_AUDIT_DATA_STORE, 'supabase');
  assert.equal(env.DRIVER_AUDIT_ENABLED, '0'); assert.equal(env.DRIVER_AUDIT_IMPORT_ENABLED, '0');
  assert.equal(env.DRIVER_AUDIT_REPLICA_GC_ENABLED, '0'); assert.equal(env.MONGODB_URI, undefined);
  assert(f.commands.every(call => call.file === 'git' || call.file === '/usr/bin/npm' || call.file === 'pm2' && call.args.join() === 'jlist'));
  assert(!f.commands.some(call => call.args.some(arg => ['reset', 'restart', 'start', 'save'].includes(arg))));
  assert(!JSON.stringify(result).includes(f.secret));
});

test('prepared release retries are exact and preserve hardlink inode, permissions and original modification times', async t => {
  const f = await preparationFixture(t), first = await f.runPrepare(), { gunzipSync } = await import('node:zlib');
  const one = JSON.parse(gunzipSync(Buffer.from(openTransferSecrets(privateKey, first.capsule).metadataGzipBase64, 'base64'))).preparation;
  const old = path.join(f.root, 'baseline/input.private.json'), copied = path.join(one.syncRoot, 'baseline/input.private.json');
  const original = await fs.lstat(old, { bigint: true }), linked = await fs.lstat(copied, { bigint: true });
  assert.equal(original.ino, linked.ino); assert.equal(original.dev, linked.dev); assert.equal(original.mtimeNs, linked.mtimeNs);
  assert.equal(Number(original.mode) & 0o777, 0o600);
  const receipt = await fs.readFile(path.join(one.syncRoot, 'staging.private.json'));
  await f.runPrepare(); assert.deepEqual(await fs.readFile(path.join(one.syncRoot, 'staging.private.json')), receipt);
  assert.equal((await fs.lstat(old, { bigint: true })).mtimeNs, original.mtimeNs);
  assert.equal((await fs.lstat(copied, { bigint: true })).ino, linked.ino);
  assert.equal(f.commands.filter(row => row.args[0] === 'clone').length, 1);
  assert.equal(f.commands.filter(row => row.file === '/usr/bin/npm' && row.args[0] === 'ci').length, 1);
  const source = JSON.parse(await fs.readFile(path.join(path.dirname(one.sourceConfig), 'environment.private.json')));
  for (const [key, value] of Object.entries(f.original)) assert.equal(source[key], value);
  assert.equal(Object.keys(source).length, 11);
  assert.equal(source.MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY, path.join(one.syncRoot, 'work/archive-cache'));
  assert.equal(one.offHostRebasedEnvironmentBackupPending, true);
});

test('bootstrap integrity, intent, code, package and lock conflicts fail before any worker or serving change', async t => {
  for (const change of [f => { f.bootstrap.inspectionMetadataSha256 = hash('stale inspection'); },
    f => { f.bootstrap.expected.currentPointerSha256 = hash('different candidate pointer'); },
    f => { f.bootstrap.expected.sourceConfigSha256 = hash('different source credentials'); },
    f => { f.bootstrap.expected.sourceEnvironmentSha256 = hash('different offhost environment'); },
    f => { f.bootstrap.builder.dataBase64 = Buffer.from('corrupt code').toString('base64'); },
    f => { f.bootstrap.source.dataBase64 = Buffer.from('corrupt source').toString('base64'); },
    f => { f.bootstrap.packageLockSha256 = hash('different dependency lock'); },
    f => { f.bootstrap.retained[0].collectorRevision--; },
    f => { f.bootstrap.retained[1].privateRoot = f.bootstrap.retained[0].privateRoot; },
    f => { f.bootstrap.environment = { password: f.secret }; },
    async f => { await f.write(path.join(f.root, 'baseline/input.private.json'), f.secret); }]) {
    const f = await preparationFixture(t); await change(f);
    const original = await fs.readFile(f.configFile), pointer = await fs.readFile(path.join(f.root, 'work/current.private.json'));
    await assert.rejects(f.runPrepare(), error => /^Supabase handoff stopped at prepare-[a-z-]+$/.test(error.message)
      && !error.message.includes(f.secret));
    assert.deepEqual(await fs.readFile(f.configFile), original); assert.deepEqual(await fs.readFile(path.join(f.root, 'work/current.private.json')), pointer);
    assert(f.commands.every(row => row.file === 'git' || row.file === '/usr/bin/npm' || row.file === 'pm2' && row.args.join() === 'jlist'));
  }
});

test('a wrong bootstrap hash, public bucket or oversized response cannot reach release cloning', async t => {
  for (const fail of ['hash', 'public', 'large']) {
    const f = await preparationFixture(t);
    if (fail === 'public') f.adapters.bootstrapArchive.assertPrivate = async () => ({ public: true });
    else f.adapters.bootstrapArchive.readObject = async () => [Buffer.alloc(fail === 'large' ? 2 * 1024 ** 2 + 1 : 10)];
    await assert.rejects(f.runPrepare(), error => error.phase === 'prepare-bootstrap');
    assert(!f.commands.some(row => row.args[0] === 'clone'));
  }
});

test('a retained package path or hardlink conflict stays untouched and never creates an effective seed', async t => {
  const f = await preparationFixture(t), original = f.adapters.exec;
  f.adapters.exec = async (file, args, options) => {
    const result = await original(file, args, options);
    if (file === 'git' && args[0] === 'clone') {
      const id = hash(JSON.stringify(['driver-reports-supabase-sync-v1', f.bootstrap.releaseSha, f.pins.source,
        f.pins.builder, f.pins.baseline, f.pins.candidate]));
      await f.write(path.join(args.at(-1), 'server/.private/driver-audits', id, 'baseline/input.private.json'), 'independent private file');
    }
    return result;
  };
  await assert.rejects(f.runPrepare(), error => error.phase === 'prepare-stage-packages');
  const release = path.join(f.server, '.private/driver-report-app-releases', f.bootstrap.releaseSha);
  const files = await fs.readdir(path.join(release, 'server/.private/driver-audits'));
  const root = path.join(release, 'server/.private/driver-audits', files[0]);
  assert.equal(await fs.readFile(path.join(root, 'baseline/input.private.json'), 'utf8'), 'independent private file');
  await assert.rejects(fs.access(path.join(root, 'seed.json')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(root, 'staging.private.json')), { code: 'ENOENT' });
});

test('independent source or worker drift cannot become a successful staged receipt', async t => {
  for (const kind of ['source', 'worker']) {
    const f = await preparationFixture(t), stage = f.adapters.stageSource;
    f.adapters.stageSource = async args => {
      const result = await stage(args);
      if (kind === 'source') await f.write(f.configFile, JSON.stringify({ ...f.config, independentEdit: true }));
      else f.rows[1].pid = 9876;
      return result;
    };
    await assert.rejects(f.runPrepare(), error => /^readback/.test(error.phase));
    assert.equal(kind === 'source' ? JSON.parse(await fs.readFile(f.configFile)).independentEdit : f.rows[1].pid, kind === 'source' ? true : 9876);
  }
});

test('preparation calls the real source stager with the derived legal cache root and preserves the original nine values', async t => {
  const f = await preparationFixture(t);
  delete f.adapters.stageSource;
  f.adapters.loadRelease = async name => {
    assert.equal(name, 'scripts/driverAuditSourceStage.js'); return { stageDriverAuditSource };
  };
  const result = await f.runPrepare(), { gunzipSync } = await import('node:zlib');
  const prepared = JSON.parse(gunzipSync(Buffer.from(openTransferSecrets(privateKey, result.capsule).metadataGzipBase64, 'base64'))).preparation;
  const config = JSON.parse(await fs.readFile(prepared.sourceConfig)), environment = JSON.parse(await fs.readFile(config.environment.path));
  assert.equal(config.nodeExecutable, '/usr/bin/node'); assert.equal(config.nodeVersion, 'v22.23.4');
  assert.equal(environment.MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY, path.join(prepared.syncRoot, 'work/archive-cache'));
  for (const [name, value] of Object.entries(f.original)) assert.equal(environment[name], value);
  await assert.rejects(fs.access(path.join(path.dirname(prepared.sourceConfig), 'source-state.private.json')), { code: 'ENOENT' });
});

async function directSeed(f, row) {
  const objects = new Map(), at = '2026-11-12T00:00:00.000Z', browser = Buffer.from(JSON.stringify({ fixture: row.collectorRevision }));
  const generation = hash(browser), reportHash = hash('direct-report-' + row.collectorRevision), catalogHash = hash('fictional-catalog');
  const snapshot = { sha256: generation, url: 'report-data/snapshot-' + generation + '.json' };
  const values = {
    'publication.private.json': Buffer.from(JSON.stringify({ head: { reportHash, manifest: snapshot, source: { observedAt: at } }, catalog: { sha256: catalogHash } })),
    'identities.private.json': Buffer.from('{}'), 'maps.private.json': Buffer.from('{}'),
    'gps-index.private.json.gz': gzipSync(Buffer.from('{"streamFiles":{"vehicle":"gps-stream.private.json.gz"}}')),
    'preview-read-view.private.json.gz': gzipSync(Buffer.from(JSON.stringify({ reportHash, generation, catalogHash,
      browser: snapshot, deferredQueryFiles: { rows: 'deferred.private.json.gz' } }))),
    'renderer.private.html': Buffer.from('<html>Fictional</html>'), 'build.private.json': Buffer.from('{}'),
    'browser-data.private.json.gz': gzipSync(browser), 'gps-stream.private.json.gz': gzipSync(Buffer.from('{"gps":[1,2,3]}')),
    'deferred.private.json.gz': gzipSync(Buffer.from('{"rows":["fictional"]}')),
  };
  const storage = { async putVerifiedObject(key, bytes) { objects.set(key, bytes); return { key, bytes: bytes.length, sha256: hash(bytes), verified: true }; } };
  const files = {};
  for (const [name, bytes] of Object.entries(values)) files[name] = await archiveBytes(storage, bytes, { domain: 'previewRuntime', path: name });
  const descriptor = await archiveBytes(storage, Buffer.from(JSON.stringify({ version: 1, files, generation, reportHash,
    sourceManifestSha256: row.manifestSha256 })), { domain: 'previewPackage', path: 'descriptor.json' });
  const parent = path.dirname(row.privateRoot), bundleRoot = path.join(parent, 'audit-objects');
  for (const [name, bytes] of objects) await f.write(path.join(bundleRoot, name), bytes);
  const identity = { generation, reportHash, manifestSha256: row.manifestSha256, descriptorSha256: descriptor.sha256 };
  const seed = { version: 1, mode: 'sync', bundleRoot, pointer: { version: 1, generation, reportHash, descriptor },
    collectorRevision: row.collectorRevision, sourceBasis: row.sourceBasis, manifestSha256: row.manifestSha256, visibleCutoffAt: at,
    closureReceipt: { version: 1, status: 'verified', sourceBasis: row.sourceBasis, ...identity, checkedAt: at,
      checks: { archive: true, photos: true, reviewHistory: true } }, restore: { version: 1, archive: 'matter-report-archive', verified: true, ...identity } };
  Object.assign(row, { generation, reportHash });
  row.acceptedSha256 = (await f.write(path.join(parent, 'accepted.private.json'), JSON.stringify({ ...row, version: 1 }))).sha256;
  row.directSeedSha256 = (await f.write(path.join(parent, 'direct-seed.private.json'), JSON.stringify(seed))).sha256;
  const pin = row.role === 'serving-current' ? f.pins.servingCurrent : f.pins.servingPrevious; pin.generation = generation;
  return { seed, objects, files };
}

test('staging verifies every original serving current/previous descriptor byte without uploading or selecting either seed', async t => {
  const f = await preparationFixture(t);
  for (const row of f.bootstrap.retained) await directSeed(f, row);
  f.adapters.loadRelease = async name => { assert.equal(name, 'services/driverAuditSupabaseReplica.js'); return { verifyDriverAuditSupabaseServingPackage }; };
  const result = await f.runPrepare(), { gunzipSync } = await import('node:zlib');
  const value = JSON.parse(gunzipSync(Buffer.from(openTransferSecrets(privateKey, result.capsule).metadataGzipBase64, 'base64'))).preparation;
  const served = value.packages.filter(row => row.role.startsWith('serving-'));
  assert.equal(served.length, 2); assert(served.every(row => row.descriptorVerified && row.servingSelectionPending));
  assert.equal(value.seedSelected, false);
  await assert.rejects(fs.access(path.join(value.syncRoot, 'seed.json')), { code: 'ENOENT' });
});

test('a missing original deferred or GPS object cannot receive a complete staging receipt', async t => {
  for (const name of ['deferred.private.json.gz', 'gps-stream.private.json.gz']) {
    const f = await preparationFixture(t), row = f.bootstrap.retained[0], pkg = await directSeed(f, row);
    const chunk = pkg.files[name].chunks[0]; await fs.unlink(path.join(pkg.seed.bundleRoot, chunk.sha256 + '.gz'));
    f.adapters.loadRelease = async () => ({ verifyDriverAuditSupabaseServingPackage });
    await assert.rejects(f.runPrepare(), error => error.phase === 'prepare-stage-packages');
    const releaseRoot = path.join(f.server, '.private/driver-report-app-releases', f.bootstrap.releaseSha);
    const roots = await fs.readdir(path.join(releaseRoot, 'server/.private/driver-audits'));
    await assert.rejects(fs.access(path.join(releaseRoot, 'server/.private/driver-audits', roots[0], 'staging.private.json')), { code: 'ENOENT' });
  }
});

test('late original acceptance or staged environment edits are preserved and cannot be admitted as completed staging', async t => {
  for (const kind of ['original-accepted', 'staged-environment']) {
    const f = await preparationFixture(t), stage = f.adapters.stageSource;
    let edited;
    if (kind === 'original-accepted') f.adapters.stageSource = async args => {
      const value = await stage(args); edited = path.join(path.dirname(f.bootstrap.retained[0].privateRoot), 'accepted.private.json');
      await f.write(edited, 'independent acceptance edit'); return value;
    };
    else {
      const exec = f.adapters.exec;
      f.adapters.exec = async (file, args, options) => {
        if (file === 'git' && args[0] === '-C' && args[2] === 'rev-parse') {
          const target = path.join(args[1], 'server/.env.local');
          if (await fs.access(target).then(() => true, () => false)) { edited = target; await f.write(target, 'DRIVER_AUDIT_ENABLED=1\n'); }
        }
        return exec(file, args, options);
      };
    }
    await assert.rejects(f.runPrepare(), error => error.phase === 'prepare-staging-readback' || error.phase === 'staging-final-readback');
    assert(edited); assert.equal(await fs.readFile(edited, 'utf8'), kind === 'original-accepted' ? 'independent acceptance edit' : 'DRIVER_AUDIT_ENABLED=1\n');
  }
});

test('the host bridge forwards only the bootstrap hash and recipient before any native session or database module', async t => {
  const f = await fixture(t), bin = path.join(f.appRoot, 'bin'), bootstrapSha256 = 'e'.repeat(64);
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'git'), '#!/bin/sh\nprintf "%s\\n" ' + commit + '\n', { mode: 0o700 });
  await fs.mkdir(path.join(f.server, 'services'), { recursive: true });
  await fs.writeFile(path.join(f.server, 'package.json'), '{"type":"module"}');
  await fs.copyFile(fileURLToPath(new URL('../../server/services/driverAuditSource.js', import.meta.url)), path.join(f.server, 'services/driverAuditSource.js'));
  const code = 'export async function runDriverAuditSupabaseHandoff(args){' +
    'if(args.operation!=="prepare-supabase-host"||args.bootstrapSha256!=="' + bootstrapSha256 + '"||!args.recipientPublicKey)throw Error("Wrong dispatch");' +
    'if(Object.keys(args).sort().join()!=="appRoot,bootstrapSha256,expectedSha,operation,recipientPublicKey")throw Error("Unexpected native argument");' +
    'return {status:"supabase-host-prepared",workersStarted:false,mongoConnections:0};}';
  const script = fileURLToPath(new URL('./driver-audit-native-handoff.mjs', import.meta.url));
  const source = 'Object.defineProperty(process,"platform",{value:"linux"});process.chdir(' + JSON.stringify(f.appRoot) +
    ');process.argv.push("--run");await import(' + JSON.stringify(script) + ');';
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], { env: { PATH: bin,
    EXPECTED_DEPLOYED_SHA: commit, NATIVE_HANDOFF_OPERATION: 'prepare-supabase-host', SUPABASE_BOOTSTRAP_SHA256: bootstrapSha256,
    NATIVE_IMPORT_CODE: Buffer.from(code).toString('base64'),
    NATIVE_TRANSFER_PLAN_B64: Buffer.from(JSON.stringify({ version: 1, recipientPublicKey })).toString('base64') } });
  assert.deepEqual(JSON.parse(result.stdout), { status: 'supabase-host-prepared', workersStarted: false, mongoConnections: 0 });
});

test('real local Git staging checks out the reviewed release while the original checkout and private inputs remain exact', async t => {
  const f = await preparationFixture(t), execute = promisify(execFile);
  const git = async args => execute('git', args, { cwd: f.appRoot, timeout: 10000, maxBuffer: 1024 * 1024 });
  await f.write(path.join(f.appRoot, '.gitignore'), '/server/.private/\n/server/.env*\n/server/node_modules/\n');
  for (const name of ['scripts/driverAuditHttp.js', 'scripts/driverAuditSourceStage.js', 'services/driverAuditSource.js',
    'services/driverAuditSupabaseReplica.js', 'services/driverAuditSupabaseSync.js',
    'services/driverAuditTransferCodec.js', 'vendor/driver-audits/integration/hosted/worker-lock.mjs',
    'vendor/driver-audits/integration/hosted/supabase-archive.mjs', 'loadEnv.js']) await f.write(path.join(f.server, name), 'export {};\n');
  await git(['init', '--quiet']); await git(['add', '.']);
  const commitArgs = ['-c', 'user.name=Fictional Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m'];
  await git([...commitArgs, 'Original fixture']);
  const base = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  await f.write(path.join(f.appRoot, 'reviewed-release.txt'), 'Separate reviewed fixture release\n');
  await git(['add', 'reviewed-release.txt']); await git([...commitArgs, 'Reviewed fixture']);
  const releaseSha = (await git(['rev-parse', 'HEAD'])).stdout.trim(); await git(['checkout', '--quiet', '--detach', base]);
  const originalExec = f.adapters.exec, statuses = [];
  f.adapters.exec = async (file, args, options) => {
    const result = await (file === 'git' ? git(args) : originalExec(file, args, options));
    if (file === 'git' && args.includes('status')) statuses.push(result.stdout);
    return result;
  };
  const common = { appRoot: f.appRoot, expectedSha: base, recipientPublicKey };
  f.bootstrap.releaseSha = releaseSha;
  f.pins.release = releaseSha;
  f.bootstrap.expected.sourceEnvironmentSha256 = hash(JSON.stringify(f.expectedEnvironment()));
  f.bootstrap.inspectionMetadataSha256 = (await operator.runDriverAuditSupabaseHandoff({ ...common, operation: 'inspect-supabase-host' }, f.adapters)).metadataSha256;
  const before = await fs.readFile(f.configFile), current = await fs.readFile(path.join(f.root, 'work/current.private.json'));
  const result = await operator.runDriverAuditSupabaseHandoff({ ...common, operation: 'prepare-supabase-host',
    bootstrapSha256: hash(gzipSync(Buffer.from(JSON.stringify(f.bootstrap)))) }, f.adapters).catch(error => {
    assert.fail(error.phase + ': ' + JSON.stringify(statuses));
  });
  assert.equal(result.releaseCommit, releaseSha); assert.equal((await git(['rev-parse', 'HEAD'])).stdout.trim(), base);
  await operator.runDriverAuditSupabaseHandoff({ ...common, operation: 'prepare-supabase-host',
    bootstrapSha256: hash(gzipSync(Buffer.from(JSON.stringify(f.bootstrap)))) }, f.adapters);
  assert.equal((await git(['status', '--porcelain'])).stdout, '');
  assert.deepEqual(await fs.readFile(f.configFile), before); assert.deepEqual(await fs.readFile(path.join(f.root, 'work/current.private.json')), current);
  const release = path.join(f.server, '.private/driver-report-app-releases', releaseSha);
  assert.equal((await git(['-C', release, 'rev-parse', 'HEAD'])).stdout.trim(), releaseSha);
  await assert.rejects(fs.access(path.join(release, '.git/objects/info/alternates')), { code: 'ENOENT' });
  assert((await fs.lstat(path.join(release, 'server/node_modules'))).isDirectory());
  await f.write(path.join(f.server, 'node_modules/business-app-only.js'), 'independent business dependency change');
  await assert.rejects(fs.access(path.join(release, 'server/node_modules/business-app-only.js')), { code: 'ENOENT' });
});

test('preparation rejects a linked private parent before creating any directory outside the release', async t => {
  const f = await preparationFixture(t), exec = f.adapters.exec, outside = path.join(f.appRoot, 'outside-private');
  await fs.mkdir(outside, { mode: 0o700 });
  f.adapters.exec = async (file, args, options) => {
    const result = await exec(file, args, options);
    if (file === 'git' && args[0] === 'clone') {
      const parent = path.join(args.at(-1), 'server/.private');
      await fs.mkdir(parent, { recursive: true, mode: 0o700 });
      await fs.symlink(outside, path.join(parent, 'driver-audits'));
    }
    return result;
  };
  await assert.rejects(f.runPrepare(), error => error.phase === 'prepare-stage-directories');
  assert(f.commands.some(row => row.file === '/usr/bin/npm' && row.args[0] === 'ci'));
  assert.deepEqual(await fs.readdir(outside), []);
});

test('isolated dependency installation has a bounded secret-free environment and never links to the business app', async t => {
  const f = await preparationFixture(t), result = await f.runPrepare();
  const prepared = JSON.parse((await import('node:zlib')).gunzipSync(Buffer.from(openTransferSecrets(privateKey, result.capsule).metadataGzipBase64, 'base64'))).preparation;
  const install = f.commands.find(row => row.file === '/usr/bin/npm' && row.args[0] === 'ci');
  assert(install); assert.deepEqual(install.args, ['ci', '--omit=dev', '--no-audit', '--no-fund']);
  assert.equal(install.options.cwd, path.join(prepared.releaseRoot, 'server'));
  assert.equal(install.options.timeout, 300000);
  assert.equal(install.options.env.NODE_OPTIONS, '--max-old-space-size=1024');
  assert(!JSON.stringify(install.options.env).includes(f.secret));
  assert(!Object.keys(install.options.env).some(key => /MONGO|JWT|SUPABASE|SPACES|TOKEN|PASSWORD/.test(key)));
  const dependencies = path.join(prepared.releaseRoot, 'server/node_modules');
  assert((await fs.lstat(dependencies)).isDirectory());
  assert.equal(prepared.dependencies.mode, 'isolated-npm-ci-v1');
  assert.equal(prepared.dependencies.target, undefined);
  assert(f.commands.find(row => row.args[0] === 'clone').args.includes('--dissociate'));
});

test('a dependency changed after installation is retained and rejects retry instead of reinstalling over it', async t => {
  const f = await preparationFixture(t), result = await f.runPrepare();
  const prepared = JSON.parse((await import('node:zlib')).gunzipSync(Buffer.from(openTransferSecrets(privateKey, result.capsule).metadataGzipBase64, 'base64'))).preparation;
  const file = path.join(prepared.releaseRoot, 'server/node_modules/fictional-package/index.js');
  await f.write(file, 'independent dependency edit');
  await assert.rejects(f.runPrepare(), error => error.phase === 'prepare-dependencies');
  assert.equal(await fs.readFile(file, 'utf8'), 'independent dependency edit');
  assert.equal(f.commands.filter(row => row.file === '/usr/bin/npm' && row.args[0] === 'ci').length, 1);
});

test('an interrupted isolated install retries only inside the staged release and never changes business dependencies', async t => {
  const f = await preparationFixture(t), exec = f.adapters.exec;
  const original = await f.write(path.join(f.server, 'node_modules/business-only.js'), 'original business dependency');
  let fail = true;
  f.adapters.exec = async (file, args, options) => {
    const result = await exec(file, args, options);
    if (file === '/usr/bin/npm' && args[0] === 'ci' && fail) { fail = false; throw Error(f.secret); }
    return result;
  };
  await assert.rejects(f.runPrepare(), error => error.message === 'Supabase handoff stopped at prepare-dependencies');
  const result = await f.runPrepare(); assert.equal(result.stagingOnly, true);
  assert.equal(hash(await fs.readFile(original.path)), original.sha256);
  assert.equal(f.commands.filter(row => row.file === '/usr/bin/npm' && row.args[0] === 'ci').length, 2);
});

test('a preexisting dependency symlink is rejected before any install or modification of its target', async t => {
  const f = await preparationFixture(t), exec = f.adapters.exec;
  const original = await f.write(path.join(f.server, 'node_modules/business-only.js'), 'untouched business dependency');
  f.adapters.exec = async (file, args, options) => {
    const result = await exec(file, args, options);
    if (file === 'git' && args[0] === 'clone') await fs.symlink(path.join(f.server, 'node_modules'), path.join(args.at(-1), 'server/node_modules'));
    return result;
  };
  await assert.rejects(f.runPrepare(), error => error.phase === 'prepare-dependencies');
  assert(!f.commands.some(row => row.file === '/usr/bin/npm'));
  assert.equal(hash(await fs.readFile(original.path)), original.sha256);
});

test('retained-package diagnostics identify only fixed role and read boundaries without exposing private names', async t => {
  for (const [change, phase] of [
    [f => fs.chmod(path.join(f.root, 'baseline/input.private.json'), 0o644), 'prepare-baseline-file-metadata'],
    [f => fs.unlink(path.join(f.root, 'baseline/input.private.json')), 'prepare-baseline-manifest-members'],
    [f => f.write(path.join(path.dirname(f.bootstrap.retained[0].privateRoot), 'accepted.private.json'), '{"private":"' + f.secret + '"}'),
      'prepare-serving-current-accepted-pin'],
    [async f => {
      const row = f.bootstrap.retained[0], value = await directSeed(f, row);
      await f.write(path.join(value.seed.bundleRoot, 'unlisted-object'), 'fictional private body');
    }, 'prepare-serving-current-audit-objects-object-identity'],
  ]) {
    const f = await preparationFixture(t); await change(f);
    await assert.rejects(f.runPrepare(), error => error.phase === phase && error.message === 'Supabase handoff stopped at ' + phase
      && !JSON.stringify(error).includes(f.root) && !JSON.stringify(error).includes(f.secret));
    assert(!f.commands.some(row => row.args[0] === 'clone'));
  }
});

test('the first package failure seals bounded metadata and never opens an unsafe owner, mode or symlink target', async t => {
  for (const kind of ['mode', 'owner', 'symlink']) {
    const f = await preparationFixture(t), file = path.join(f.root, 'baseline/input.private.json');
    const declared = hash(await fs.readFile(file));
    let outside;
    if (kind === 'mode') await fs.chmod(file, 0o644);
    if (kind === 'symlink') {
      outside = (await f.write(path.join(f.appRoot, 'outside-private-body'), f.secret)).path;
      await fs.unlink(file); await fs.symlink(outside, file);
    }
    const open = fs.open, lstat = fs.lstat; let unsafeOpens = 0, failure;
    fs.open = async (name, ...args) => {
      if (name === file || name === outside) { unsafeOpens++; throw Error('An unsafe private body must not be opened'); }
      return open(name, ...args);
    };
    if (kind === 'owner') fs.lstat = async (name, options) => {
      const info = await lstat(name, options);
      if (name === file) info.uid = options?.bigint ? 99999n : 99999;
      return info;
    };
    try { await assert.rejects(f.runPrepare(), error => { failure = error; return error.phase === 'prepare-baseline-file-metadata'; }); }
    finally { fs.open = open; fs.lstat = lstat; }
    assert.equal(unsafeOpens, 0); assert(!f.commands.some(row => row.args[0] === 'clone'));
    const receipt = failure.supabaseHostStopped;
    assert.equal(receipt.status, 'supabase-host-stopped'); assert.equal(receipt.applicationCommit, commit);
    assert.deepEqual(driverAuditSupabaseStoppedReceipt(receipt, commit, failure.phase), receipt);
    const value = openTransferSecrets(privateKey, receipt.capsule), { gunzipSync } = await import('node:zlib');
    const packed = Buffer.from(value.metadataGzipBase64, 'base64'), bytes = gunzipSync(packed), metadata = JSON.parse(bytes);
    assert(bytes.length <= 8192); assert.equal(hash(bytes), receipt.metadataSha256); assert.equal(hash(packed), value.metadataGzipSha256);
    assert.equal(metadata.relativePath, 'input.private.json'); assert.equal(metadata.role, 'baseline');
    assert.equal(metadata.declaredSha256, declared); assert.equal(metadata.alreadyReadSha256, null);
    assert.equal(metadata.statKind, kind === 'symlink' ? 'symbolic-link' : 'regular-file');
    assert.equal(metadata.realpathMatches, kind !== 'symlink');
    if (kind === 'mode') assert.equal(metadata.mode, 0o644);
    if (kind === 'owner') assert.equal(metadata.ownerUid, 99999);
    assert(!bytes.includes(Buffer.from(f.secret))); assert(!JSON.stringify(receipt).includes(f.root));
    assert(!Object.keys(metadata).some(key => /error|message|body|content|environment/i.test(key)));
  }
});

test('the core stopped-receipt allowlist rejects plaintext additions, wrong bindings and noncanonical ciphertext', () => {
  const capsule = sealTransferSecrets(recipientPublicKey, { fictional: true });
  const receipt = { status: 'supabase-host-stopped', applicationCommit: commit, operatorPhase: 'prepare-baseline-file-metadata',
    metadataSha256: hash('fictional metadata'), capsule };
  assert.deepEqual(driverAuditSupabaseStoppedReceipt(receipt, commit, receipt.operatorPhase), receipt);
  for (const changed of [{ ...receipt, message: 'NEVER-PRINT-PRIVATE-ERROR' }, { ...receipt, applicationCommit: 'f'.repeat(40) },
    { ...receipt, operatorPhase: 'prepare-private/customer' }, { ...receipt, metadataSha256: 'private text' },
    { ...receipt, capsule: { ...capsule, privatePath: '/fictional/private' } },
    { ...receipt, capsule: { ...capsule, data: 'non canonical ciphertext' } },
    { ...receipt, capsule: { ...capsule, data: Buffer.alloc(25000).toString('base64') } }]) {
    assert.equal(driverAuditSupabaseStoppedReceipt(changed, commit, receipt.operatorPhase), null);
  }
});

test('a completed permitted file read can report its differing hash while retaining the private body', async t => {
  const f = await preparationFixture(t), file = path.join(f.root, 'baseline/input.private.json');
  const declared = hash(await fs.readFile(file)), changed = Buffer.from(f.secret); await f.write(file, changed);
  let failure;
  await assert.rejects(f.runPrepare(), error => { failure = error; return error.phase === 'prepare-baseline-manifest-members'; });
  const value = openTransferSecrets(privateKey, failure.supabaseHostStopped.capsule), { gunzipSync } = await import('node:zlib');
  const raw = gunzipSync(Buffer.from(value.metadataGzipBase64, 'base64')), metadata = JSON.parse(raw);
  assert.equal(metadata.declaredSha256, declared); assert.equal(metadata.alreadyReadSha256, hash(changed));
  assert.equal(metadata.bytes, changed.length); assert(!raw.includes(changed));
  assert(!f.commands.some(row => row.args[0] === 'clone'));
});

test('the actual host bridge prints only the encrypted stopped schema and exits unsuccessfully', async t => {
  const f = await fixture(t), bin = path.join(f.appRoot, 'bin'); await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'git'), '#!/bin/sh\nprintf "%s\\n" ' + commit + '\n', { mode: 0o700 });
  await fs.mkdir(path.join(f.server, 'services'), { recursive: true });
  await fs.writeFile(path.join(f.server, 'package.json'), '{"type":"module"}');
  await fs.copyFile(fileURLToPath(new URL('../../server/services/driverAuditSource.js', import.meta.url)), path.join(f.server, 'services/driverAuditSource.js'));
  const receipt = { status: 'supabase-host-stopped', applicationCommit: commit, operatorPhase: 'prepare-baseline-file-metadata',
    metadataSha256: hash('fictional diagnostic'), capsule: sealTransferSecrets(recipientPublicKey, { relativePath: 'fictional-private-file' }) };
  const code = 'export async function runDriverAuditSupabaseHandoff(){throw Object.assign(Error("NEVER-PRINT-PRIVATE-FAILURE"),' +
    JSON.stringify({ phase: receipt.operatorPhase, supabaseHostStopped: receipt }) + ');}';
  const script = fileURLToPath(new URL('./driver-audit-native-handoff.mjs', import.meta.url));
  const source = 'Object.defineProperty(process,"platform",{value:"linux"});process.chdir(' + JSON.stringify(f.appRoot) +
    ');process.argv.push("--run");await import(' + JSON.stringify(script) + ');';
  await assert.rejects(promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], { env: { PATH: bin,
    EXPECTED_DEPLOYED_SHA: commit, NATIVE_HANDOFF_OPERATION: 'prepare-supabase-host', SUPABASE_BOOTSTRAP_SHA256: 'e'.repeat(64),
    NATIVE_IMPORT_CODE: Buffer.from(code).toString('base64'),
    NATIVE_TRANSFER_PLAN_B64: Buffer.from(JSON.stringify({ version: 1, recipientPublicKey })).toString('base64') } }), error => {
    assert.equal(error.code, 1); assert.deepEqual(JSON.parse(error.stdout.trim()), receipt);
    assert(!error.stdout.includes('fictional-private-file')); assert(!error.stderr.includes('NEVER-PRINT'));
    assert(error.stderr.includes('operatorPhase=' + receipt.operatorPhase)); return true;
  });
});

async function archiveBackedFixture(f, role, { present = false, mismatchedName = false } = {}) {
  const body = Buffer.from('fictional retained archive ' + role), expected = hash(body);
  const name = 'archive-' + (mismatchedName ? hash('different filename') : expected) + '.private.bin';
  let row, root;
  if (role === 'baseline-builder-input') root = path.join(f.root, 'baseline');
  else if (role === 'candidate') {
    row = JSON.parse(await fs.readFile(path.join(f.root, 'work/current.private.json'))); root = row.privateRoot;
  } else { row = f.bootstrap.retained.find(item => item.role === role); root = row.privateRoot; }
  const file = path.join(root, 'files.private.json'), values = JSON.parse(await fs.readFile(file));
  values[name] = expected; const manifest = await f.write(file, JSON.stringify(values));
  if (present) await f.write(path.join(root, name), body);
  if (role === 'baseline-builder-input') {
    f.pins.baseline = manifest.sha256; f.seed.manifestSha256 = manifest.sha256;
    f.bootstrap.expected.seedSha256 = (await f.write(path.join(f.root, 'seed.json'), JSON.stringify(f.seed))).sha256;
  } else {
    row.manifestSha256 = manifest.sha256;
    const acceptedFile = path.join(path.dirname(root), 'accepted.private.json');
    const accepted = JSON.parse(await fs.readFile(acceptedFile)); accepted.manifestSha256 = manifest.sha256;
    row.acceptedSha256 = (await f.write(acceptedFile, JSON.stringify(accepted))).sha256;
    if (role === 'candidate') {
      f.pins.candidate = manifest.sha256;
      f.bootstrap.expected.currentPointerSha256 = (await f.write(path.join(f.root, 'work/current.private.json'), JSON.stringify(row))).sha256;
    } else (role === 'serving-current' ? f.pins.servingCurrent : f.pins.servingPrevious).manifestSha256 = manifest.sha256;
  }
  f.bootstrap.expected.sourceEnvironmentSha256 = hash(JSON.stringify(f.expectedEnvironment()));
  f.bootstrap.inspectionMetadataSha256 = (await f.run()).metadataSha256;
  return { root, name, sha256: expected, body, manifest: manifest.sha256 };
}

test('archive-backed package manifests retain exact remote references and a separately pinned physical-presence mask', async t => {
  const f = await preparationFixture(t), refs = new Map();
  for (const role of ['baseline-builder-input', 'candidate', 'serving-current', 'serving-previous']) refs.set(role, await archiveBackedFixture(f, role));
  const result = await f.runPrepare(), { gunzipSync } = await import('node:zlib');
  const prepared = JSON.parse(gunzipSync(Buffer.from(openTransferSecrets(privateKey, result.capsule).metadataGzipBase64, 'base64'))).preparation;
  for (const row of prepared.packages) {
    const original = refs.get(row.role); assert.equal(row.archiveBackedManifest, true);
    assert.equal(row.archiveReferences.locallyMissing, 1); assert.equal(row.archiveReferences.remoteAvailabilityVerified, false);
    const raw = await fs.readFile(row.archiveReferences.path), mask = JSON.parse(raw);
    assert.equal(hash(raw), row.archiveReferences.sha256);
    assert.deepEqual(mask.missingArchiveReferences, [original.sha256]);
    assert.equal(mask.manifestSha256, original.manifest); assert.equal(mask.inventorySha256, row.inventorySha256);
    assert.equal(row.missingArchiveReferencesSha256, hash(JSON.stringify([original.sha256])));
    assert.deepEqual(await fs.readFile(path.join(row.root, 'files.private.json')), await fs.readFile(path.join(original.root, 'files.private.json')));
    await assert.rejects(fs.access(path.join(row.root, original.name)), { code: 'ENOENT' });
    assert.equal((await fs.lstat(row.archiveReferences.path)).mode & 0o777, 0o600);
  }
  assert.equal(f.reads(), 1, 'Only the already authorized bootstrap is downloaded; omitted archive bytes are not restaged');
});

test('missing archive-name/hash mismatches and every other missing declared file remain rejected', async t => {
  const f = await preparationFixture(t); await archiveBackedFixture(f, 'baseline-builder-input', { mismatchedName: true });
  await assert.rejects(f.runPrepare(), error => error.phase === 'prepare-baseline-manifest-members');
  assert(!f.commands.some(row => row.args[0] === 'clone'));
});

test('physical archive presence must remain stable and independent additions or removals are never undone', async t => {
  for (const [present, target] of [[false, false], [true, false], [false, true], [true, true]]) {
    const f = await preparationFixture(t), ref = await archiveBackedFixture(f, 'baseline-builder-input', { present });
    const stage = f.adapters.stageSource;
    const root = target ? path.join(path.dirname(path.dirname(f.expectedEnvironment().MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY)), 'baseline') : ref.root;
    const file = path.join(root, ref.name);
    f.adapters.stageSource = async args => {
      const value = await stage(args);
      if (present) await fs.unlink(file); else await f.write(file, ref.body);
      return value;
    };
    await assert.rejects(f.runPrepare(), error => error.phase === 'prepare-staging-readback');
    if (present) await assert.rejects(fs.access(file), { code: 'ENOENT' });
    else assert.deepEqual(await fs.readFile(file), ref.body);
  }
});

test('an archive reference never excuses a present corrupt file, directory or symbolic link', async t => {
  for (const kind of ['corrupt', 'directory', 'symlink']) {
    const f = await preparationFixture(t), ref = await archiveBackedFixture(f, 'baseline-builder-input');
    const file = path.join(ref.root, ref.name);
    if (kind === 'corrupt') await f.write(file, 'different actual bytes');
    else if (kind === 'directory') await fs.mkdir(file, { mode: 0o700 });
    else await fs.symlink(path.join(f.appRoot, 'absent-outside-target'), file);
    await assert.rejects(f.runPrepare(), /Supabase handoff stopped at prepare-baseline/);
    assert(!f.commands.some(row => row.args[0] === 'clone'));
  }
});

test('normal generated data directories stay private through an explicit owner700 boundary without chmodding original directories or leaves', async t => {
  const f=await preparationFixture(t), pointer=JSON.parse(await fs.readFile(path.join(f.root,'work/current.private.json'))), root=pointer.privateRoot;
  await fs.chmod(root,0o775);const extra=path.join(root,'generated-data');await fs.mkdir(extra,{mode:0o775});await fs.chmod(extra,0o775);
  await f.write(path.join(extra,'unlisted-immutable.private.json'),'fictional retained artifact');
  const original=await fs.stat(path.join(extra,'unlisted-immutable.private.json'),{bigint:true});
  const result=await f.runPrepare(),{gunzipSync}=await import('node:zlib');
  const prepared=JSON.parse(gunzipSync(Buffer.from(openTransferSecrets(privateKey,result.capsule).metadataGzipBase64,'base64'))).preparation;
  const candidate=prepared.packages.find(row=>row.role==='candidate');
  assert.equal(candidate.privateDirectoryBoundary,prepared.syncRoot);
  assert.equal((await fs.lstat(root)).mode&0o777,0o775);assert.equal((await fs.lstat(extra)).mode&0o777,0o775);
  assert.equal((await fs.lstat(f.root)).mode&0o777,0o700);
  const copied=await fs.stat(path.join(candidate.root,'generated-data/unlisted-immutable.private.json'),{bigint:true});
  assert.equal(copied.ino,original.ino);assert.equal(copied.mode,original.mode);assert.equal(copied.mtimeNs,original.mtimeNs);
  assert.equal(Number(copied.mode)&0o777,0o600);assert.equal((await fs.lstat(candidate.root)).mode&0o777,0o700);
});

test('an exposed package boundary or unsafe owner, symlink or changing ancestor is rejected before a candidate data file is opened', async t => {
  for(const kind of ['boundary','owner','symlink','mode-drift']){
    const f=await preparationFixture(t),pointer=JSON.parse(await fs.readFile(path.join(f.root,'work/current.private.json'))),root=pointer.privateRoot;
    await fs.chmod(root,0o775);const manifest=path.join(root,'files.private.json');
    const open=fs.open,lstat=fs.lstat;let candidateReads=0,changed=false;
    if(kind==='boundary')await fs.chmod(f.root,0o755);
    if(kind==='symlink'){
      const parent=path.dirname(root),retained=path.join(f.root,'moved-original-attempt');await fs.rename(parent,retained);await fs.symlink(retained,parent);
    }
    if(kind==='owner')fs.lstat=async(name,options)=>{const value=await lstat(name,options);if(name===path.dirname(root))value.uid=options?.bigint?99999n:99999;return value;};
    fs.open=async(name,flags,...rest)=>{
      if(name===manifest)candidateReads++;
      const handle=await open(name,flags,...rest);
      if(kind==='mode-drift'&&name===root&&typeof flags==='number'&&(flags&constants.O_DIRECTORY)&&!changed){changed=true;await fs.chmod(root,0o755);}
      return handle;
    };
    try{await assert.rejects(f.runPrepare(),/Supabase handoff stopped/);}finally{fs.open=open;fs.lstat=lstat;}
    assert.equal(candidateReads,0);assert(!f.commands.some(row=>row.args[0]==='clone'));
    if(kind==='mode-drift')assert.equal((await fs.lstat(root)).mode&0o777,0o755,'An independent mode change is preserved');
  }
});

test('ordinary data directories never relax the existing600 leaf or strict code and configuration guards', async t => {
  const f=await preparationFixture(t),pointer=JSON.parse(await fs.readFile(path.join(f.root,'work/current.private.json'))),root=pointer.privateRoot;
  await fs.chmod(root,0o775);const file=path.join(root,'original-data.private.json');await fs.chmod(file,0o664);
  await assert.rejects(f.runPrepare(),error=>error.phase==='prepare-candidate-package-file-metadata');
  assert.equal((await fs.lstat(file)).mode&0o777,0o664);assert(!f.commands.some(row=>row.args[0]==='clone'));
});
