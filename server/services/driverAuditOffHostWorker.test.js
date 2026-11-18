import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/driverAuditOffHostWorker.js', import.meta.url));
const runner = new URL('./driverAuditSupabaseSync.js', import.meta.url).href;
const sourceModule = new URL('./driverAuditSource.js', import.meta.url).href;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, { failure = false, exerciseCollection = false, historyFailure = false, omitHistory = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'driver-audit-offhost-cli-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  async function write(file, bytes) {
    await fs.mkdir(path.dirname(file), { mode: 0o700, recursive: true });
    await fs.writeFile(file, bytes, { mode: 0o600 });
  }
  const code = 'export default async function(){}\n';
  const files = ['source/api/collector.mjs', 'source/integration/hosted/native-backend.mjs',
    'source/integration/hosted/archive-read-cache.mjs', 'source/integration/cloud/native-poll-progress.mjs'];
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, managedSourceExecutionHost: 'off-host',
    managedSourceExecutionAdmission: 'fixed-host-v1',
    files: files.map(file => ({ path: file, sha256: sha(code), bytes: Buffer.byteLength(code) })),
    entrypoints: [...(omitHistory ? [] : ['/api/collector?task=delivery-history']),
      '/api/collector?task=delivery', '/api/morning-gps', '/api/collector?task=gps-publish',
      '/api/collector?task=photo-backlog', '/api/collector?task=photo-grade'].map((route, i) => ({
      id: 'fictional-' + i, module: files[0], exportName: 'default', method: 'GET', path: route,
      schedule: '30 6 * * *', timeZone: 'UTC', maxDurationSeconds: 300, requiredEnvironment: [],
    })) }));
  const sourceRoot = path.join(root, 'collector', sha(manifest)), runtimeRoot = path.join(sourceRoot, 'runtime');
  for (const file of files) await write(path.join(runtimeRoot, file), code);
  await write(path.join(runtimeRoot, 'manifest.private.json'), manifest);
  const environment = Buffer.from(JSON.stringify({ DRIVER_AUDIT_EXECUTION_HOST: 'off-host',
    DRIVER_AUDIT_DATA_STORE: 'supabase', MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY: path.join(root, 'work/archive-cache'),
    CRON_SECRET: 'fictional-test-only-cron-secret-00000000', MATTER_DELIVERY_ENABLED: '1',
    MATTER_GPS_ENABLED: '1', MATTER_GPS_PUBLICATION_ENABLED: '1', MATTER_PHOTO_READ_ENABLED: '1' }));
  const environmentFile = path.join(sourceRoot, 'environment.private.json'); await write(environmentFile, environment);
  const sourceFile = path.join(sourceRoot, 'source.json');
  const source = Buffer.from(JSON.stringify({ version: 1, root: sourceRoot, runtimeRoot,
    manifestSha256: sha(manifest), nodeVersion: process.version, nodeExecutable: await fs.realpath(process.execPath),
    environment: { path: environmentFile, sha256: sha(environment) }, gatewayCredential: null }));
  await write(sourceFile, source);
  const syncFile = path.join(root, 'sync.json'), sync = Buffer.from(JSON.stringify({ version: 1, root }));
  await write(syncFile, sync);
  const enrolled = { version: 1, syncSha256: sha(sync), sourceSha256: sha(source),
    armedAt: new Date(Date.now() - 1000).toISOString() };
  const enrollmentFile = path.join(root, 'launch-verified.private.json');
  // Only the external runner boundary is replaced here. Real CLI parsing,
  // complete source/config verification and enrollment reads run in the child;
  // the actual scheduler/build/CAS path has separate service fixtures.
  const hook = path.join(root, 'runner-boundary.mjs');
  const replacement = `export async function runDriverAuditSupabaseSync(input){
    if (${failure}) throw Error('fictional private failure must not be printed');
    if (${exerciseCollection}) {
      globalThis.fixtureSourceRoutes=[];let admissions=0;
      await input.collectSource({signal:new AbortController().signal,onAdmission:async()=>{admissions++;}});
      globalThis.fixtureSourceRoutes.push('build-after-source');
      console.log(JSON.stringify({routes:globalThis.fixtureSourceRoutes,admissions}));return;
    }
    console.log(JSON.stringify({mode:input.mode??null,enrolled:typeof input.armedAt==='string',
      sourceConfigured:typeof input.collectSource==='function'}));
  }`;
  const sourceBoundary = `export {readDriverAuditSourceConfig,readPrivateDriverAuditSource} from ${JSON.stringify(sourceModule)};
    export async function runDriverAuditSourceChild(config,entry,{onAdmission}={}){
      globalThis.fixtureSourceRoutes.push(entry.path);await onAdmission?.();
      if(${historyFailure}&&entry.path==='/api/collector?task=delivery-history')throw Error('Fictional prior-day source failure');
      return {status:'complete',httpStatus:200};
    }`;
  await write(hook, `import {registerHooks} from 'node:module';registerHooks({
    resolve(specifier,context,next){if(${exerciseCollection}&&context.parentURL===${JSON.stringify(new URL('../scripts/driverAuditOffHostWorker.js', import.meta.url).href)}
      &&specifier==='../services/driverAuditSource.js')return{url:${JSON.stringify('data:text/javascript,' + encodeURIComponent(sourceBoundary))},shortCircuit:true};return next(specifier,context);},
    load(url,context,next){
    if(url===${JSON.stringify(runner)})return{format:'module',source:${JSON.stringify(replacement)},shortCircuit:true};
    return next(url,context);}});`);
  async function run(mode) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', hook, script, '--config', syncFile, '--source', sourceFile,
        ...(mode === undefined ? [] : [mode])], { env: { PATH: process.env.PATH, HOME: os.homedir() }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', part => { stdout += part; }); child.stderr.on('data', part => { stderr += part; });
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
  }
  return { run, enrolled, enrollmentFile, write };
}

test('off-host --once forwards only the enrolled configuration and exits without the daemon', async t => {
  const f = await fixture(t); await f.write(f.enrollmentFile, JSON.stringify(f.enrolled));
  const result = await f.run('--once');
  assert.equal(result.code, 0); assert.equal(result.signal, null); assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { mode: '--once', enrolled: true, sourceConfigured: true });
});

test('off-host --once rejects absent, different and future enrollment before the runner', async t => {
  const f = await fixture(t);
  for (const value of [null, { ...f.enrolled, syncSha256: 'f'.repeat(64) },
    { ...f.enrolled, sourceSha256: 'f'.repeat(64) }, { ...f.enrolled, armedAt: new Date(Date.now() + 3600_000).toISOString() }]) {
    if (value) await f.write(f.enrollmentFile, JSON.stringify(value));
    const result = await f.run('--once');
    assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /worker is held/);
  }
});

test('a genuine once-run rejection exits nonzero without printing private causes or a success', async t => {
  const f = await fixture(t, { failure: true }); await f.write(f.enrollmentFile, JSON.stringify(f.enrolled));
  const result = await f.run('--once');
  assert.equal(result.code, 1); assert.equal(result.stdout, '');
  assert.equal(result.stderr.includes('fictional private failure'), false); assert.match(result.stderr, /worker is held/);
});

test('off-host check and seed keep their unenrolled behavior while daemon still requires enrollment', async t => {
  const f = await fixture(t);
  for (const mode of ['--check', '--seed-only']) {
    const result = await f.run(mode);
    assert.equal(result.code, 0); assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { mode, enrolled: false, sourceConfigured: true });
  }
  const held = await f.run(); assert.equal(held.code, 1); assert.equal(held.stdout, '');
  await f.write(f.enrollmentFile, JSON.stringify(f.enrolled));
  const enrolled = await f.run(); assert.equal(enrolled.code, 0);
  assert.deepEqual(JSON.parse(enrolled.stdout), { mode: null, enrolled: true, sourceConfigured: true });
});

test('every off-host slot catches up the pinned prior-day handler before current-day evidence and one build', async t => {
  const f = await fixture(t, { exerciseCollection: true }); await f.write(f.enrollmentFile, JSON.stringify(f.enrolled));
  const result = await f.run('--once'); assert.equal(result.code, 0); assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { routes: ['/api/collector?task=delivery-history', '/api/collector?task=delivery',
    '/api/morning-gps', '/api/collector?task=gps-publish', '/api/collector?task=photo-backlog', '/api/collector?task=photo-grade',
    'build-after-source'], admissions: 1 });
});

test('missing or failed prior-day catch-up never reaches the current build', async t => {
  for (const options of [{ exerciseCollection: true, historyFailure: true }, { exerciseCollection: true, omitHistory: true }]) {
    const f = await fixture(t, options); await f.write(f.enrollmentFile, JSON.stringify(f.enrolled));
    const result = await f.run('--once'); assert.equal(result.code, 1); assert.equal(result.stdout, '');
    assert.match(result.stderr, /worker is held/);
  }
});
