import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { manageDriverAuditSource } from '../scripts/driverAuditSourceDeploy.js';
import { stageDriverAuditSource } from '../scripts/driverAuditSourceStage.js';

async function fixture(t, { running = false, failReadiness = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'driver-audit-source-deploy-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = { root, file: path.join(root, 'source.json'), configSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64) };
  let worker = running ? { id: 4, status: 'online', config: config.file } : null;
  let receipt = null;
  const calls = [];
  const adapter = {
    async worker() { return worker; },
    async check() { calls.push('check'); },
    async verifyRelease() { calls.push('release'); return { sha256: 'c'.repeat(64) }; },
    async readActivation() { return receipt; },
    async writeActivation(value) { receipt = value; calls.push('receipt:' + value.status); },
    async start() { calls.push('start'); worker = { id: 4, status: 'online', config: config.file }; },
    async stop() { calls.push('stop'); if (worker) worker.status = 'stopped'; },
    async wait() { calls.push('wait'); if (failReadiness) throw Error('readiness failed'); },
    async save() { calls.push('save'); },
  };
  return { config, adapter, calls, worker: () => worker, receipt: () => receipt };
}

test('source preflight checks imports without activating a worker', async t => {
  const f = await fixture(t);
  assert.equal((await manageDriverAuditSource({ operation: 'check', config: f.config, adapter: f.adapter })).status, 'checked');
  assert.deepEqual(f.calls, ['check']);
  assert.equal(f.worker(), null);
});

test('source start validates fresh proof, saves activation before dispatch and waits for readiness', async t => {
  const f = await fixture(t);
  assert.equal((await manageDriverAuditSource({ operation: 'start', config: f.config, adapter: f.adapter })).status, 'started');
  assert.deepEqual(f.calls, ['check', 'release', 'receipt:active', 'start', 'wait', 'save']);
  assert.equal(f.receipt().configSha256, f.config.configSha256);
  assert.equal(f.worker().status, 'online');
});

test('failed source startup stops the worker and preserves a retryable activation receipt', async t => {
  const f = await fixture(t, { failReadiness: true });
  await assert.rejects(manageDriverAuditSource({ operation: 'start', config: f.config, adapter: f.adapter }), /readiness failed/);
  assert.equal(f.worker().status, 'stopped');
  assert.equal(f.receipt().status, 'active');
  assert.equal(f.calls.at(-1), 'save');
});

test('source pause resumes only the same activated configuration and rollback prevents resurrection', async t => {
  const f = await fixture(t);
  await manageDriverAuditSource({ operation: 'start', config: f.config, adapter: f.adapter });
  await manageDriverAuditSource({ operation: 'pause', config: f.config, adapter: f.adapter });
  assert.equal(f.worker().status, 'stopped');
  await manageDriverAuditSource({ operation: 'resume', config: f.config, adapter: f.adapter });
  assert.equal(f.worker().status, 'online');
  await manageDriverAuditSource({ operation: 'rollback', config: f.config, adapter: f.adapter });
  assert.equal(f.worker().status, 'stopped');
  assert.equal(f.receipt().status, 'rolled-back');
  await assert.rejects(manageDriverAuditSource({ operation: 'resume', config: f.config, adapter: f.adapter }), /activation/i);
});

test('source controls refuse another registered configuration and keep inactive deploys inert', async t => {
  const f = await fixture(t);
  assert.equal((await manageDriverAuditSource({ operation: 'pause', config: f.config, adapter: f.adapter })).status, 'inactive');
  f.adapter.worker = async () => ({ id: 8, status: 'online', config: '/other/source.json' });
  await assert.rejects(manageDriverAuditSource({ operation: 'pause', config: f.config, adapter: f.adapter }), /configuration/i);
  assert.deepEqual(f.calls, []);
});

test('source pause and rollback stop a worker waiting for automatic restart', async t => {
  for (const operation of ['pause', 'rollback']) {
    const f = await fixture(t);
    await manageDriverAuditSource({ operation: 'start', config: f.config, adapter: f.adapter });
    f.worker().status = 'waiting restart';
    await manageDriverAuditSource({ operation, config: f.config, adapter: f.adapter });
    assert.equal(f.worker().status, 'stopped');
  }
});

test('source host check runs read-only and an ordinary deployment keeps an absent source worker inactive', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'source-host-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const server = path.join(root, 'server');
  await fs.mkdir(path.join(server, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(server, 'services'));
  await fs.writeFile(path.join(server, 'package.json'), '{"type":"module"}');
  for (const file of ['driverAuditSourceDeploy.js', 'driverAuditSource.js', 'driverAuditSourceStage.js']) {
    await fs.copyFile(fileURLToPath(new URL('../scripts/' + file, import.meta.url)), path.join(server, 'scripts', file));
  }
  await fs.copyFile(fileURLToPath(new URL('./driverAuditSource.js', import.meta.url)), path.join(server, 'services/driverAuditSource.js'));
  await fs.writeFile(path.join(server, 'services/driverAuditDataBackend.js'),
    'export const driverAuditNativeBackendSymbol=Symbol.for("matter.driver-audit.native-backend");' +
    'export function openDriverAuditDataBackend(){throw Error("Host inspection must not open a backend");}' +
    'export function readDriverAuditDataCapacity(){throw Error("Supabase host inspection does not require MongoDB");}');
  await fs.copyFile(fileURLToPath(new URL('../loadEnv.js', import.meta.url)), path.join(server, 'loadEnv.js'));
  await fs.symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(server, 'node_modules'));
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  const commit = 'a'.repeat(40);
  await fs.writeFile(path.join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' '${commit}'\n`, { mode: 0o700 });
  await fs.writeFile(path.join(bin, 'pm2'), '#!/bin/sh\n[ "$1" = jlist ] || exit 1\nprintf "[]\\n"\n', { mode: 0o700 });
  const env = { PATH: bin, DRIVER_AUDIT_DEPLOY_SHA: commit, DRIVER_AUDIT_SOURCE_NODE: process.execPath };
  const script = path.join(server, 'scripts/driverAuditSourceDeploy.js');
  const exec = promisify(execFile);
  const result = await exec(process.execPath, [script, 'audit-source-host-check'], { env });
  const host = JSON.parse(result.stdout);
  assert.equal(host.status, 'host-checked');
  assert.equal(host.deployedSha, commit);
  assert.ok(host.nodes.some(node => node.version === process.version && node.sqlite));
  assert.equal((await fs.readdir(server)).includes('.private'), false);
  const pause = await exec(process.execPath, [script, 'deploy-source-pause'], { env });
  assert.equal(JSON.parse(pause.stdout).status, 'inactive');
});

test('a Supabase host check does not open the unrelated app MongoDB connection', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'supabase-host-check-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const server = path.join(root, 'server'), bin = path.join(root, 'bin'), marker = path.join(root, 'mongo-attempted');
  for (const directory of ['scripts', 'services', 'node_modules/mongoose']) await fs.mkdir(path.join(server, directory), { recursive: true });
  await fs.mkdir(bin);
  await fs.writeFile(path.join(server, 'package.json'), '{"type":"module"}');
  for (const name of ['driverAuditSourceDeploy.js', 'driverAuditSource.js', 'driverAuditSourceStage.js'])
    await fs.copyFile(fileURLToPath(new URL('../scripts/' + name, import.meta.url)), path.join(server, 'scripts', name));
  await fs.copyFile(fileURLToPath(new URL('./driverAuditSource.js', import.meta.url)), path.join(server, 'services/driverAuditSource.js'));
  await fs.writeFile(path.join(server, 'services/driverAuditDataBackend.js'),
    'export const driverAuditNativeBackendSymbol=Symbol.for("matter.driver-audit.native-backend");' +
    'export function openDriverAuditDataBackend(){throw Error("No backend needed for host check");}' +
    'export function readDriverAuditDataCapacity(){throw Error("Mongo not needed");}');
  await fs.writeFile(path.join(server, 'loadEnv.js'), 'export {};');
  await fs.writeFile(path.join(server, 'node_modules/mongoose/package.json'), '{"type":"module","main":"index.js"}');
  await fs.writeFile(path.join(server, 'node_modules/mongoose/index.js'),
    'import fs from "node:fs";export default {createConnection(){fs.writeFileSync(' + JSON.stringify(marker) + ',"attempted");throw Error("Unrelated Mongo probe attempted");}};');
  const commit = 'a'.repeat(40);
  await fs.writeFile(path.join(bin, 'git'), '#!/bin/sh\nprintf "%s\\n" ' + commit + '\n', { mode: 0o700 });
  await fs.writeFile(path.join(bin, 'pm2'), '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o700 });
  const result = await promisify(execFile)(process.execPath, [path.join(server, 'scripts/driverAuditSourceDeploy.js'), 'audit-source-host-check'],
    { env: { PATH: bin, DRIVER_AUDIT_DEPLOY_SHA: commit, DRIVER_AUDIT_SOURCE_NODE: process.execPath,
      DRIVER_AUDIT_EXECUTION_HOST: 'sidi', DRIVER_AUDIT_DATA_STORE: 'mongo', MONGODB_URI: 'mongodb://fixture.invalid/never-open' } });
  const host = JSON.parse(result.stdout);
  assert.equal(host.status, 'host-checked');
  assert.equal(host.dataStore, 'supabase');
  assert.equal(host.mongo.required, false);
  assert.equal(await fs.stat(marker).catch(error => error.code), 'ENOENT');
});

test('the real Sidi source child binds its staged Supabase credential before loading the runtime', async t => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sidi-source-child-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const server = path.join(base, 'server'), sourceRoot = path.join(server, '.private/driver-audit-source');
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  for (const directory of ['scripts', 'services', 'vendor/driver-audits/integration/hosted', '.private/driver-audit-source'])
    await fs.mkdir(path.join(server, directory), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(server, 'package.json'), '{"type":"module"}');
  for (const [source, target] of [['../scripts/driverAuditSource.js', 'scripts/driverAuditSource.js'],
    ['./driverAuditSource.js', 'services/driverAuditSource.js'], ['./driverAuditHeavyWork.js', 'services/driverAuditHeavyWork.js'],
    ['../vendor/driver-audits/integration/hosted/worker-lock.mjs', 'vendor/driver-audits/integration/hosted/worker-lock.mjs']])
    await fs.copyFile(fileURLToPath(new URL(source, import.meta.url)), path.join(server, target));
  const called = path.join(base, 'handler.private.json'), closed = path.join(base, 'closed.private.json');
  const control = path.join(base, 'backend-control.private.json');
  await fs.writeFile(control, '{}', { mode: 0o600 });
  await fs.writeFile(path.join(server, 'loadEnv.js'),
    'process.env.DRIVER_AUDIT_EXECUTION_HOST="sidi";process.env.DRIVER_AUDIT_SUPABASE_SECRET="wrong-inherited-value";');
  await fs.writeFile(path.join(server, 'services/driverAuditDataBackend.js'), [
    'import assert from "node:assert/strict";import fs from "node:fs/promises";',
    'export const driverAuditNativeBackendSymbol=Symbol.for("matter.driver-audit.native-backend");',
    'export async function openDriverAuditDataBackend({env=process.env}={}){',
    'assert.equal(env.MATTER_SUPABASE_SECRET,"fictional-staged-value");',
    'assert.equal(env.DRIVER_AUDIT_SUPABASE_SECRET,"fictional-staged-value");',
    'const changes=JSON.parse(await fs.readFile(' + JSON.stringify(control) + '));',
    'return {kind:"supabase",executionHost:"sidi",executionAdmission:"fixed-host-v1",rpc:async()=>{},',
    'archiveCacheDirectory:env.MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY,',
    'archive:{managedReadCache:true,readObject(){},putVerifiedObject(){}},pollProgress:{version:1,read(){},compareAndSwap(){}},createExecutionBudget(){},',
    'transferAccounting:"supabase-http-bytes-v1",archiveReadBudget:{reserve(){},settle(){}},readTransferUsage(){},',
    'close:()=>fs.writeFile(' + JSON.stringify(closed) + ',"closed"),...changes};}',
  ].join('\n'));
  const handler = Buffer.from([
    'import assert from "node:assert/strict";import fs from "node:fs/promises";',
    'const backend=globalThis[Symbol.for("matter.driver-audit.native-backend")];',
    'assert.equal(backend?.kind,"supabase");assert.equal(backend.executionHost,"sidi");',
    'export default async function(req,res){await fs.writeFile(' + JSON.stringify(called) + ',"called");',
    'res.end(JSON.stringify({status:"complete",collected:1}));}',
  ].join('\n'));
  const files = new Map([['source/api/collector.mjs', handler], ...[
    'source/integration/hosted/native-backend.mjs', 'source/integration/hosted/archive-read-cache.mjs',
    'source/integration/cloud/native-poll-progress.mjs'].map(name => [name, Buffer.from('export {};')])]);
  const entrypoint = { id: 'delivery', module: 'source/api/collector.mjs', exportName: 'default', method: 'GET',
    path: '/api/collector?task=delivery', schedule: '* * * * *', timeZone: 'UTC', maxDurationSeconds: 5, requiredEnvironment: ['CRON_SECRET'] };
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, managedSourceExecutionHost: 'sidi',
    managedSourceExecutionAdmission: 'fixed-host-v1', entrypoints: [entrypoint],
    files: [...files].map(([relative, bytes]) => ({ path: relative, bytes: bytes.length, sha256: digest(bytes) })) }));
  const root = path.join(sourceRoot, digest(manifest)), runtimeRoot = path.join(root, 'runtime');
  for (const [relative, bytes] of files) {
    await fs.mkdir(path.dirname(path.join(runtimeRoot, relative)), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(runtimeRoot, relative), bytes, { mode: 0o600 });
  }
  await fs.writeFile(path.join(runtimeRoot, 'manifest.private.json'), manifest, { mode: 0o600 });
  const environment = Buffer.from(JSON.stringify({ CRON_SECRET: 'c'.repeat(32), MATTER_SUPABASE_SECRET: 'fictional-staged-value',
    DRIVER_AUDIT_EXECUTION_HOST: 'sidi', MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY:
      path.join(server, '.private/driver-audits', 'a'.repeat(64), 'work/archive-cache') }));
  const environmentFile = path.join(root, 'environment.private.json'), configFile = path.join(root, 'source.json');
  await fs.writeFile(environmentFile, environment, { mode: 0o600 });
  await fs.writeFile(configFile, JSON.stringify({ version: 1, root, runtimeRoot, manifestSha256: digest(manifest),
    nodeVersion: process.version, nodeExecutable: process.execPath, environment: { path: environmentFile, sha256: digest(environment) } }), { mode: 0o600 });
  const source = await import(pathToFileURL(path.join(server, 'services/driverAuditSource.js')).href);
  const config = await source.readDriverAuditSourceConfig(configFile);
  assert.deepEqual(await source.runDriverAuditSourceChild(config, entrypoint), { httpStatus: 200, status: 'complete', collected: 1 });
  assert.equal(await fs.readFile(called, 'utf8'), 'called');
  assert.equal(await fs.readFile(closed, 'utf8'), 'closed');
  for (const changes of [{ kind: 'mongo' }, { executionHost: 'other' }, { executionAdmission: 'unbounded' }, { pollProgress: { version: 1 } }]) {
    await fs.rm(called);
    await fs.writeFile(control, JSON.stringify(changes), { mode: 0o600 });
    await assert.rejects(source.runDriverAuditSourceChild(config, entrypoint), /child execution failed/i);
    assert.equal(await fs.stat(called).catch(error => error.code), 'ENOENT');
    await fs.writeFile(called, 'reset', { mode: 0o600 });
  }
});

test('explicit held deployment qualification stops and saves the actual sync lifecycle before releasing admission', async t => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sidi-held-deploy-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const server = path.join(base, 'server'), bin = path.join(base, 'bin');
  for (const relative of ['scripts', 'services', '.private/driver-audit-source'])
    await fs.mkdir(path.join(server, relative), { recursive: true, mode: 0o700 });
  await fs.mkdir(bin);
  await fs.writeFile(path.join(server, 'package.json'), '{"type":"module"}');
  for (const name of ['driverAuditSourceDeploy.js', 'driverAuditSource.js', 'driverAuditSourceStage.js'])
    await fs.copyFile(fileURLToPath(new URL('../scripts/' + name, import.meta.url)), path.join(server, 'scripts', name));
  for (const name of ['driverAuditSource.js', 'driverAuditHeavyWork.js'])
    await fs.copyFile(fileURLToPath(new URL('./' + name, import.meta.url)), path.join(server, 'services', name));
  await fs.symlink(fileURLToPath(new URL('./driverAuditWorkspace.js', import.meta.url)), path.join(server, 'services/driverAuditWorkspace.js'));
  await fs.symlink(fileURLToPath(new URL('../vendor', import.meta.url)), path.join(server, 'vendor'));
  await fs.writeFile(path.join(server, 'services/driverAuditDataBackend.js'),
    'export const driverAuditNativeBackendSymbol=Symbol.for("matter.driver-audit.native-backend");' +
    'export const driverAuditLocalReaderBudget={};export function openDriverAuditDataBackend(){throw Error("No real backend in fixture");}' +
    'export function readDriverAuditDataCapacity(){throw Error("No database in fixture");}');
  await fs.copyFile(fileURLToPath(new URL('../scripts/driverAuditSourceQualify.js', import.meta.url)),
    path.join(server, 'scripts/driverAuditSourceQualify.actual.js'));
  await fs.writeFile(path.join(server, 'scripts/driverAuditSourceQualify.js'), [
    'export * from "./driverAuditSourceQualify.actual.js";',
    'import {withDriverAuditHeldQualificationSync} from "./driverAuditSourceQualify.actual.js";',
    'export const qualifyDriverAuditSource=()=>{throw Error("Wrong unheld qualification branch");};',
    'export const qualifyDriverAuditSourceWhileHeld=options=>withDriverAuditHeldQualificationSync(options,async()=>{throw Error("Stop before heavy replay");});',
  ].join('\n'));
  const digest = value => createHash('sha256').update(value).digest('hex');
  const module = Buffer.from('export default async function(req,res){res.end("{\\"status\\":\\"disabled\\"}");}');
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1,
    files: [{ path: 'source/api/collector.mjs', bytes: module.length, sha256: digest(module) }],
    entrypoints: [{ id: 'delivery', module: 'source/api/collector.mjs', exportName: 'default', method: 'GET',
      path: '/api/collector?task=delivery', schedule: '* * * * *', timeZone: 'UTC', maxDurationSeconds: 300, requiredEnvironment: ['CRON_SECRET'] }] }));
  const compressed = gzipSync(JSON.stringify({ version: 1, manifestSha256: digest(manifest), nodeExecutable: process.execPath,
    nodeVersion: process.version, files: [{ path: 'manifest.private.json', dataBase64: manifest.toString('base64') },
      { path: 'source/api/collector.mjs', dataBase64: module.toString('base64') }] }));
  const staged = await stageDriverAuditSource({ sourceRoot: path.join(server, '.private/driver-audit-source'), compressed,
    expectedBundleSha256: digest(compressed), expectedManifestSha256: digest(manifest), nodeExecutable: process.execPath,
    environmentBytes: Buffer.from(JSON.stringify({ CRON_SECRET: 'c'.repeat(32) })) });
  const stateFile = path.join(base, 'pm2.private.json'), logFile = path.join(base, 'calls.private.json');
  const heavyFile = path.join(server, '.private/driver-audit-heavy-work/work.lock');
  const syncFile = path.join(server, '.private/driver-audits', 'b'.repeat(64), 'sync.json');
  const rows = [{ name: 'matter-delivery-api', pid: process.pid, pm2_env: { status: 'online' } },
    { name: 'matter-driver-audit-sync', pm_id: 3, pid: 0, pm2_env: { status: 'stopped', pm_cwd: server,
      pm_exec_path: path.join(server, 'scripts/driverAuditSync.js'), args: ['--config', syncFile], exec_interpreter: process.execPath } }];
  await fs.writeFile(stateFile, JSON.stringify(rows), { mode: 0o600 });
  await fs.writeFile(logFile, '[]', { mode: 0o600 });
  const pm2Script = path.join(bin, 'pm2-fixture.cjs');
  await fs.writeFile(pm2Script, [
    'const fs=require("node:fs");const args=process.argv.slice(2),file=' + JSON.stringify(stateFile) + ',log=' + JSON.stringify(logFile) + ';',
    'const rows=JSON.parse(fs.readFileSync(file));if(args[0]==="jlist"){console.log(JSON.stringify(rows));process.exit(0);}',
    'const owner=Number(fs.readFileSync(' + JSON.stringify(heavyFile) + ',"utf8"));process.kill(owner,0);',
    'const calls=JSON.parse(fs.readFileSync(log));calls.push(args);fs.writeFileSync(log,JSON.stringify(calls));',
    'const sync=rows.find(x=>x.name==="matter-driver-audit-sync");',
    'if(args[0]==="restart"){sync.pm2_env.status="online";sync.pid=owner;}',
    'else if(args[0]==="stop"){sync.pm2_env.status="stopped";sync.pid=0;}',
    'else if(args[0]!=="save")process.exit(1);fs.writeFileSync(file,JSON.stringify(rows));',
  ].join('\n'), { mode: 0o600 });
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  await fs.writeFile(path.join(bin, 'pm2'), '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(pm2Script) + ' "$@"\n', { mode: 0o700 });
  const commit = 'a'.repeat(40);
  await fs.writeFile(path.join(bin, 'git'), '#!/bin/sh\nprintf "%s\\n" ' + commit + '\n', { mode: 0o700 });
  assert.deepEqual(JSON.parse((await promisify(execFile)(path.join(bin, 'pm2'), ['jlist'], { env: { PATH: bin } })).stdout), rows);
  const before = await fs.readFile(staged.configFile);
  let failure;
  await assert.rejects(promisify(execFile)(process.execPath,
    ['--input-type=module', '-e', 'import {deployDriverAuditSource} from ' +
      JSON.stringify(pathToFileURL(path.join(server, 'scripts/driverAuditSourceDeploy.js')).href) +
      ';await deployDriverAuditSource("audit-source-qualify-held");'],
    { env: { PATH: bin, DRIVER_AUDIT_DEPLOY_SHA: commit, DRIVER_AUDIT_SOURCE_MANIFEST: digest(manifest),
      DRIVER_AUDIT_SOURCE_QUALIFICATION_SHA256: 'd'.repeat(64) } }).catch(error => { failure = error; throw error; }), /Command failed/);
  assert.deepEqual(JSON.parse(await fs.readFile(logFile)), [
    ['restart', 'matter-driver-audit-sync'], ['stop', 'matter-driver-audit-sync'], ['save']], failure?.stderr);
  assert.equal(JSON.parse(await fs.readFile(stateFile))[1].pm2_env.status, 'stopped');
  assert.equal(await fs.stat(heavyFile).catch(error => error.code), 'ENOENT');
  assert.deepEqual(await fs.readFile(staged.configFile), before);
});
