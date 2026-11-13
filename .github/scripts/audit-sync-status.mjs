import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const name = 'matter-driver-audit-sync';
const sha = /^[a-f0-9]{40}$/;
const manifest = /^[a-f0-9]{64}$/;
const attempt = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const heartbeatStates = ['pending', 'checking', 'ready', 'failed', 'budget-deferred', 'capacity-blocked'];
const buildStates = ['building', 'validating', 'ready', 'unchanged', 'superseded', 'retry-pending'];
const tracked = ['combined-reviews.private.json', 'verified-gps-windows.private.json', 'gps-refresh-receipt.private.json',
  'automatic-build.private.json', 'automatic-preservation.private.json', 'automatic-validation.private.json',
  'accepted.private.json', 'direct-seed.private.json'];
const attemptDirectories = ['saved-current', 'server-data', 'audit-objects'];

const missing = error => { if (error.code === 'ENOENT') return null; throw error; };
const stat = file => fs.lstat(file).catch(missing);
const number = value => Number.isFinite(value) && value >= 0 ? value : null;
const iso = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
  ? new Date(value).toISOString() : null;
const allowed = (value, list) => list.includes(value) ? value : null;
const byteCount = value => Number.isSafeInteger(value) && value >= 0;

async function readRetentionInputs(appRoot) {
  const server = path.join(appRoot, 'server');
  await import(pathToFileURL(path.join(server, 'loadEnv.js')).href);
  const require = createRequire(path.join(server, 'package.json'));
  const mongoose = require('mongoose');
  const connection = mongoose.createConnection(process.env.MONGODB_URI, {
    autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 5000,
  });
  try {
    await connection.asPromise();
    const control = connection.db.collection('driverAuditControl');
    const [entry, stage, capacity] = await Promise.all([
      control.findOne({ _id: 'head' }, { projection: { head: 1 } }),
      control.findOne({ _id: 'direct-stage' }, { projection: { _id: 1 } }),
      control.findOne({ _id: 'capacity' }, { projection: { limit: 1, used: 1 } }),
    ]);
    const head = entry?.head;
    if (![head?.generation, head?.previous?.generation].every(value => manifest.test(value)) ||
        !byteCount(capacity?.limit) || !byteCount(capacity?.used) || capacity.used > capacity.limit) {
      throw Error('The retained audit release identity is unavailable');
    }
    return { generation: head.generation, previousGeneration: head.previous.generation,
      revision: number(head.directImport?.collectorRevision), previousRevision: number(head.previous.directImport?.collectorRevision),
      importedAt: iso(head.importedAt instanceof Date ? head.importedAt.toISOString() : head.importedAt),
      stagePending: !!stage, capacityBytes: capacity.limit, usedBytes: capacity.used };
  } finally { await connection.close(); }
}

function capacityFailure(saved) {
  if (saved?.status !== 'capacity-blocked' || saved.errorCode !== 'AUDIT_CAPACITY') return null;
  const { kind, availableBytes, requiredBytes } = saved.capacity ?? {};
  if (kind === 'build-disk' && availableBytes === null && requiredBytes === null) return { kind, availableBytes, requiredBytes };
  if (!allowed(kind, ['build-disk', 'replica-storage', 'import-transfer']) || !byteCount(requiredBytes)
    || requiredBytes === 0 || (availableBytes === null ? kind !== 'build-disk' : !byteCount(availableBytes) || availableBytes >= requiredBytes)) return null;
  return { kind, availableBytes, requiredBytes };
}

async function readTail(file, maximumBytes, privateOnly = false) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(missing);
  if (!handle) return null;
  try {
    const info = await handle.stat();
    if (!info.isFile() || privateOnly && (info.mode & 0o077 || info.size > maximumBytes)) return null;
    const length = Math.min(info.size, maximumBytes), bytes = Buffer.alloc(length);
    const { bytesRead } = await handle.read(bytes, 0, length, info.size - length);
    return bytes.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function json(file) {
  const source = await readTail(file, 256 * 1024, true);
  try { return source ? JSON.parse(source) : null; }
  catch { return null; }
}

async function summarizeDirectory(directory) {
  if (!(await stat(directory))?.isDirectory()) return null;
  const limit = 8192;
  let entries = 0, files = 0, bytes = 0, allocatedBytes = 0, latest = 0;
  for await (const entry of await fs.opendir(directory)) {
    if (entries === limit) break;
    entries++;
    if (!entry.isFile()) continue;
    const info = await stat(path.join(directory, entry.name));
    if (!info?.isFile()) continue;
    files++;
    bytes += info.size;
    allocatedBytes += info.blocks * 512;
    latest = Math.max(latest, info.mtimeMs);
  }
  return { files, bytes, allocatedBytes, latestWriteAt: latest ? new Date(latest).toISOString() : null, bounded: entries === limit };
}

async function summarizeAttemptDirectories(directory) {
  return Object.fromEntries(await Promise.all(attemptDirectories.map(async key => [key, await summarizeDirectory(path.join(directory, key))])));
}

async function summarizeAttempts(work, current, saved, progress) {
  const root = path.join(work, 'attempts');
  if (!(await stat(root))?.isDirectory() || await fs.realpath(root) !== root) return null;
  const keep = new Set([current?.privateRoot, current?.previous?.privateRoot, current?.baselineRoot]
    .filter(value => typeof value === 'string').map(value => path.dirname(value)));
  const found = [];
  let scanned = 0, scanBounded = false;
  for await (const entry of await fs.opendir(root)) {
    if (scanned === 4096) { scanBounded = true; break; }
    scanned++;
    if (!entry.isDirectory() || !attempt.test(entry.name)) continue;
    const directory = path.join(root, entry.name), info = await stat(directory);
    if (!info?.isDirectory()) continue;
    const children = await fs.opendir(directory).catch(missing);
    if (!children) continue;
    let nonempty;
    try { nonempty = !!await children.read(); }
    finally { await children.close(); }
    found.push({ id: entry.name, directory, nonempty, modified: info.mtimeMs });
  }
  const selected = found.sort((a, b) => Number(b.nonempty) - Number(a.nonempty) || b.modified - a.modified).slice(0, 64);
  const summaries = [];
  for (const { id, directory, nonempty, modified } of selected) {
    const [accepted, seed, proof, abandoned, legacy, direct, directories] = await Promise.all([
      json(path.join(directory, 'accepted.private.json')),
      json(path.join(directory, 'direct-seed.private.json')),
      json(path.join(directory, 'retired-workspace.private.json')),
      json(path.join(directory, 'abandoned-workspace.private.json')),
      json(path.join(directory, 'compacted-files.private.json')),
      summarizeDirectory(directory),
      summarizeAttemptDirectories(directory),
    ]);
    const protectedByPointer = keep.has(directory);
    const protectedByHeartbeat = manifest.test(saved?.activeGeneration) && seed?.pointer?.generation === saved.activeGeneration;
    const inUse = ['building', 'validating'].includes(progress?.status) && progress.id === id;
    summaries.push({ id, nonempty, modifiedAt: new Date(modified).toISOString(), accepted: !!accepted, seed: !!seed,
      prepared: proof?.status === 'prepared', retired: proof?.status === 'retired', legacyCompacted: legacy?.complete === true,
      abandonedPrepared: abandoned?.status === 'prepared', abandonedRetired: abandoned?.status === 'retired',
      abandonedScope: ['copies-only', 'source-and-rebuild'].includes(abandoned?.scope) ? abandoned.scope : null,
      protected: protectedByPointer || protectedByHeartbeat || inUse, protectedByPointer, protectedByHeartbeat, inUse,
      collectorRevision: number(accepted?.collectorRevision ?? seed?.collectorRevision), direct, directories });
  }
  return { observed: found.length, nonempty: found.filter(item => item.nonempty).length, omitted: found.length - selected.length,
    scanBounded, summaries };
}

async function summarizeLogs(pm2Home) {
  const counts = { refreshPaused: 0, startupFailed: 0, memoryLimit: 0, retirementDeferred: 0, lastRetirementDeferredAttempts: null, lastAbandonedRetirement: null, lastArchiveCopyRetirement: null, other: 0 };
  const file = path.join(pm2Home, 'logs', name + '-error.log');
  const log = await readTail(file, 32 * 1024).catch(() => null);
  for (const line of (log || '').split(/\r?\n/).filter(Boolean).slice(-40)) {
    const deferred = /\{"event":"audit-workspace-retirement-deferred","attempts":([1-9]\d{0,4})\}$/.exec(line);
    const abandoned = /\{"event":"audit-workspace-abandoned-retired","attempts":([1-9]\d{0,4}),"files":([1-9]\d{0,8}),"bytes":(\d{1,15}),"allocatedBytes":(\d{1,15}),"freeDiskDeltaBytes":(-?\d{1,15})\}$/.exec(line);
    const copies = /\{"event":"audit-workspace-archive-copies-retired","files":([1-9]\d{0,8}),"bytes":(\d{1,15}),"allocatedBytes":(\d{1,15}),"freeDiskDeltaBytes":(-?\d{1,15})\}$/.exec(line);
    if (line.includes('Driver audit sync paused this refresh.')) counts.refreshPaused++;
    else if (line.includes('Driver audit sync could not start.')) counts.startupFailed++;
    else if (/heap out of memory|Reached heap limit/.test(line)) counts.memoryLimit++;
    else if (deferred) { counts.retirementDeferred++; counts.lastRetirementDeferredAttempts = Number(deferred[1]); }
    else if (abandoned) {
      const [attempts, files, bytes, allocatedBytes, freeDiskDeltaBytes] = abandoned.slice(1).map(Number);
      counts.lastAbandonedRetirement = { attempts, files, bytes, allocatedBytes, freeDiskDeltaBytes };
    }
    else if (copies) {
      const [files, bytes, allocatedBytes, freeDiskDeltaBytes] = copies.slice(1).map(Number);
      counts.lastArchiveCopyRetirement = { files, bytes, allocatedBytes, freeDiskDeltaBytes };
    }
    else counts.other++;
  }
  return counts;
}

function syncRoot(appRoot, entry) {
  const server = path.join(appRoot, 'server'), base = path.join(server, '.private/driver-audits');
  const pm = entry.pm2_env;
  const file = pm?.args?.[1];
  const root = typeof file === 'string' ? path.dirname(file) : '';
  if (entry.name !== name || pm?.pm_cwd !== server || pm.pm_exec_path !== path.join(server, 'scripts/driverAuditSync.js')
    || !Array.isArray(pm.args) || pm.args.length !== 2 || pm.args[0] !== '--config'
    || path.dirname(root) !== base || !manifest.test(path.basename(root)) || file !== path.join(root, 'sync.json')) {
    throw Error('The registered process does not match the reviewed audit worker');
  }
  return root;
}

export async function readAuditSyncStatus({ appRoot, pm2Home, entry }) {
  const disk = await fs.statfs(appRoot);
  const memory = await fs.readFile('/proc/meminfo', 'utf8').catch(() => '');
  const available = /^MemAvailable:\s+(\d+) kB$/m.exec(memory);
  const host = { freeMemoryBytes: available ? Number(available[1]) * 1024 : os.freemem(), freeDiskBytes: disk.bavail * disk.bsize };
  if (!entry) return { host, worker: { registered: false }, logs: await summarizeLogs(pm2Home) };

  const root = syncRoot(appRoot, entry);
  if (await fs.realpath(root) !== root || !(await stat(root))?.isDirectory()) throw Error('The audit workspace is unavailable');
  const pm = entry.pm2_env, work = path.join(root, 'work');
  const workDisk = await fs.statfs(work).catch(missing);
  host.workFreeDiskBytes = workDisk ? workDisk.bavail * workDisk.bsize : null;
  const current = await json(path.join(work, 'current.private.json'));
  const progress = await json(path.join(work, 'status.private.json'));
  const saved = await json(path.join(root, 'sync-status.private.json'));
  const attemptId = [progress?.id, progress?.attempt?.id, typeof current?.privateRoot === 'string'
    ? path.basename(path.dirname(current.privateRoot)) : null].find(value => typeof value === 'string' && attempt.test(value));
  const directory = attemptId ? path.join(work, 'attempts', attemptId) : null;
  const files = {};
  let directories = {};
  if (directory && (await stat(directory))?.isDirectory() && await fs.realpath(directory) === directory) {
    for (const file of tracked) {
      const info = await stat(path.join(directory, file));
      if (info?.isFile()) files[file] = { bytes: info.size, modifiedAt: info.mtime.toISOString() };
    }
    directories = await summarizeAttemptDirectories(directory);
  }
  const started = number(pm.pm_uptime);
  return {
    host,
    worker: { registered: true, status: allowed(pm.status, ['online', 'stopped', 'errored', 'launching', 'stopping', 'waiting restart']),
      pid: number(entry.pid), restarts: number(pm.restart_time), elapsedMs: started ? Math.max(0, Date.now() - started) : null,
      rssBytes: number(entry.monit?.memory), cpuPercent: number(entry.monit?.cpu) },
    heartbeat: saved && { status: allowed(saved.status, heartbeatStates), errorCode: allowed(saved.errorCode, ['AUDIT_BUDGET', 'AUDIT_CAPACITY', 'SYNC_FAILED']),
      capacity: capacityFailure(saved),
      replicaGcStatus: allowed(saved.replicaGcStatus, ['off', 'qualified', 'proof-required', 'proof-stale']),
      checkedAt: iso(saved.checkedAt), nextCheckAt: iso(saved.nextCheckAt), latestCaptureAt: iso(saved.latestCaptureAt), visibleCutoffAt: iso(saved.visibleCutoffAt) },
    build: { status: allowed(progress?.status, buildStates), startedAt: iso(progress?.startedAt ?? progress?.attempt?.startedAt),
      checkedAt: iso(progress?.checkedAt), candidateVerifiedAt: iso(current?.verifiedAt), files, directories },
    attempts: await summarizeAttempts(work, current, saved, progress),
    archiveCache: await summarizeDirectory(path.join(work, 'archive-cache')),
    metadataCache: await summarizeDirectory(path.join(work, 'metadata')),
    stagedBaseline: await summarizeDirectory(path.join(root, 'baseline')),
    logs: await summarizeLogs(pm2Home),
  };
}

// This payload is limited to the exact reviewed code-only export.
const candidateBuilder = '5ee269b38fa25a6ccb2f418822155a1255b2237a80bb0156ddb24100b47c6729';
const previousBuilder = '13cfd8e5b543714ce6fa93d6aece9e229d4ff0e558768807622d595e29a200b7';
const bundleHash = '7cd0c2e4c4f8364359e5b8566e6e5aac51c53e7d240473f4cd5b15d4b5fb021c';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const codePath = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.(?:mjs|js)$/;
const smokeSource = String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {gzip,gunzip} from 'node:zlib';
import {promisify} from 'node:util';
const [builder, expected, volume, verifier, ...rest] = process.argv.slice(2);
const { verifyAuditBuilder } = await import(pathToFileURL(verifier).href);
assert(path.isAbsolute(builder??'')&&path.isAbsolute(volume??'')&&!rest.length,'Expected builder path, SHA-256 and private scratch parent');
await verifyAuditBuilder(builder,expected);
const exportsByFile={
  'integration/cloud/automatic-release.mjs':['automaticReleaseBasis','createAutomaticRelease'],
  'integration/cloud/automatic-release-source.mjs':['createAutomaticReleaseSource'],
  'integration/cloud/automatic-release-build.mjs':['buildAutomaticRelease'],
  'scripts/run-automatic-report.mjs':['validateAutomaticCandidate'],
};
for(const [file,names] of Object.entries(exportsByFile)){
  const loaded=await import(pathToFileURL(path.join(builder,file)).href);
  for(const name of names)assert.equal(typeof loaded[name],'function');
}
const {compactDirectBuildVersion}=await import(pathToFileURL(path.join(builder,'integration/cloud/automatic-release-build.mjs')).href);
assert.equal(compactDirectBuildVersion,1);

const scratch=await fs.mkdtemp(path.join(await fs.realpath(volume),'audit-builder-smoke-'));
try{
  const db=new DatabaseSync(path.join(scratch,'lock.sqlite'));
  try{db.exec('BEGIN EXCLUSIVE; ROLLBACK;');}finally{db.close();}
  const original=Buffer.from('audit builder smoke\n'.repeat(256));
  const file=path.join(scratch,'scratch.gz');
  await fs.writeFile(file,await promisify(gzip)(original),{mode:0o600,flag:'wx'});
  await fs.link(file,file+'.linked');
  assert.equal((await fs.stat(file)).ino,(await fs.stat(file+'.linked')).ino);
  assert.deepEqual(await promisify(gunzip)(await fs.readFile(file+'.linked')),original);
  const directory=await fs.open(scratch,'r');
  try{await directory.sync();}finally{await directory.close();}
}finally{await fs.rm(scratch,{recursive:true,force:true});}
console.log(JSON.stringify({status:'checked',platform:process.platform,release:os.release(),node:process.version,builderSha256:expected}));
`;

export async function stageQualificationBuilder({ source, target, encoded, expectedBundleHash, expectedBuilder, verify }) {
  if (typeof encoded !== 'string' || encoded.length > 48000 || digest(encoded) !== expectedBundleHash) {
    throw Error('Unexpected private builder bundle');
  }
  const bundle = JSON.parse(gunzipSync(Buffer.from(encoded, 'base64'), { maxOutputLength: 128 * 1024 }));
  const manifestBytes = Buffer.from(bundle.manifest, 'base64');
  const parsed = JSON.parse(manifestBytes);
  if (bundle.version !== 1 || parsed.version !== 1 || digest(manifestBytes) !== expectedBuilder ||
      !parsed.files || !bundle.delta || !Object.hasOwn(parsed.files, 'scripts/run-automatic-report.mjs')) {
    throw Error('Unexpected replacement builder manifest');
  }
  const files = Object.entries(parsed.files);
  if (files.length > 128 || Object.keys(bundle.delta).some(name => !Object.hasOwn(parsed.files, name)) ||
      files.some(([name, hash]) => name.length >= 512 || !codePath.test(name) || !manifest.test(hash))) {
    throw Error('Unexpected replacement builder file list');
  }
  await fs.mkdir(target, { mode: 0o700 });
  for (const [name, hash] of files) {
    const sourceFile = path.join(source, name);
    const bytes = Object.hasOwn(bundle.delta, name)
      ? Buffer.from(bundle.delta[name], 'base64')
      : await fs.readFile(sourceFile);
    if (bytes.length > 8 * 1024 * 1024 || digest(bytes) !== hash) throw Error('Replacement builder file hash mismatch');
    const output = path.join(target, name);
    await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
    await fs.writeFile(output, bytes, { mode: 0o600, flag: 'wx' });
  }
  await fs.writeFile(path.join(target, 'runtime-manifest.json'), manifestBytes, { mode: 0o600, flag: 'wx' });
  await verify(target, expectedBuilder);
  return files.length;
}

async function qualifyBuilder(appRoot, entry, pm2Home, encoded) {
  if (process.platform !== 'linux' || entry?.pm2_env?.status !== 'online' ||
      !Number.isSafeInteger(entry.pid) || entry.pid < 1) throw Error('Online Linux worker required');
  const root = syncRoot(appRoot, entry);
  const info = await stat(root);
  const workerProc = '/proc/' + entry.pid;
  if (!info?.isDirectory() || info.uid !== process.getuid() || info.mode & 0o077 ||
      await fs.realpath(root) !== root || (await fs.stat(workerProc)).uid !== info.uid) {
    throw Error('Managed worker ownership required');
  }
  const work = path.join(root, 'work');
  if (await fs.realpath(work) !== work || (await fs.stat(work)).dev !== info.dev) throw Error('Build volume mismatch');
  const source = path.join(root, 'builder');
  const config = await json(path.join(root, 'sync.json'));
  if (config?.root !== root || config.codeRoot !== source || config.builderSha256 !== previousBuilder) {
    throw Error('Running builder pin differs from the reviewed predecessor');
  }
  const node = await fs.realpath(workerProc + '/exe');
  const verifier = path.join(appRoot, 'server/vendor/driver-audits/integration/cloud/driver-audit-handoff.mjs');
  const { verifyAuditBuilder } = await import(pathToFileURL(verifier).href);
  await verifyAuditBuilder(source, previousBuilder);

  const directory = await fs.mkdtemp(path.join(work, 'audit-linux-qualification-'));
  try {
    const code = path.join(directory, 'builder');
    const smoke = path.join(directory, 'smoke.mjs');
    const files = await stageQualificationBuilder({ source, target: code, encoded,
      expectedBundleHash: bundleHash, expectedBuilder: candidateBuilder, verify: verifyAuditBuilder });
    await fs.writeFile(smoke, smokeSource, { mode: 0o600, flag: 'wx' });
    const env = { PATH: '/usr/bin:/bin', HOME: directory, LANG: 'C' };
    const result = await exec(node, [smoke, code, candidateBuilder, directory, verifier], { env, timeout: 30000 });
    const receipt = JSON.parse(result.stdout);
    if (receipt.status !== 'checked' || receipt.platform !== 'linux' || receipt.node !== 'v22.23.4' ||
        receipt.builderSha256 !== candidateBuilder) throw Error('Unexpected Linux smoke receipt');
    const after = await exec('pm2', ['jlist'], { env: { PATH: process.env.PATH, HOME: os.homedir(), PM2_HOME: pm2Home },
      timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
    const rows = JSON.parse(after.stdout).filter(row => row.name === name);
    if (rows.length !== 1 || rows[0].pid !== entry.pid || rows[0].pm_id !== entry.pm_id ||
        rows[0].pm2_env.pm_uptime !== entry.pm2_env.pm_uptime || rows[0].pm2_env.restart_time !== entry.pm2_env.restart_time ||
        rows[0].pm2_env.status !== 'online' || syncRoot(appRoot, rows[0]) !== root ||
        (await json(path.join(root, 'sync.json')))?.builderSha256 !== previousBuilder) {
      throw Error('Managed worker changed during qualification');
    }
    const staged = path.join(root, 'builder-staged-' + candidateBuilder);
    if (await stat(staged)) await verifyAuditBuilder(staged, candidateBuilder);
    else await fs.rename(code, staged);
    await verifyAuditBuilder(staged, candidateBuilder);
    const rootHandle = await fs.open(root, 'r');
    try { await rootHandle.sync(); } finally { await rootHandle.close(); }
    const disk = await fs.statfs(work);
    const memory = await fs.readFile('/proc/meminfo', 'utf8');
    const available = /^MemAvailable:\s+(\d+) kB$/m.exec(memory);
    return { ...receipt, workerUnchanged: true, previousBuilderSha256: previousBuilder, files, staged: true,
      freeDiskBytes: disk.bavail * disk.bsize, freeMemoryBytes: available ? Number(available[1]) * 1024 : null };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  const appRoot = await fs.realpath(process.cwd());
  const expected = process.env.EXPECTED_DEPLOYED_SHA;
  const encoded = process.env.BUILDER_QUALIFICATION_BUNDLE;
  delete process.env.BUILDER_QUALIFICATION_BUNDLE;
  const git = await exec('git', ['rev-parse', 'HEAD'], { cwd: appRoot, timeout: 5000 });
  if (!sha.test(expected) || git.stdout.trim() !== expected) throw Error('Unexpected production checkout');

  const pm2Home = process.env.PM2_HOME || path.join(os.homedir(), '.pm2');
  const socket = await stat(path.join(pm2Home, 'rpc.sock'));
  let entry;
  if (socket?.isSocket()) {
    const daemon = Number((await readTail(path.join(pm2Home, 'pm2.pid'), 32))?.trim());
    if (!Number.isSafeInteger(daemon) || daemon < 1) throw Error('Existing process supervisor unavailable');
    process.kill(daemon, 0);
    const result = await exec('pm2', ['jlist'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
    const entries = JSON.parse(result.stdout).filter(row => row.name === name);
    if (entries.length > 1) throw Error('Multiple audit workers registered');
    [entry] = entries;
  }
  if (process.env.CLEAR_REPORTING_BUILD_CACHES === 'true') {
    if (process.env.QUALIFY_BUILDER === 'true') throw Error('Select one audit operation');
    const root = syncRoot(appRoot, entry);
    const configured = await exec('npm', ['config', 'get', 'cache'], { timeout: 5000 });
    const npmCache = path.join(os.homedir(), '.npm');
    const caches = [path.join(npmCache, '_cacache'), path.join(appRoot, 'client/node_modules/.cache')];
    if (configured.stdout.trim() !== npmCache) throw Error('The npm cache differs from the reviewed location');
    const before = await fs.statfs(root);
    for (const cache of caches) {
      const info = await stat(cache);
      if (!info) continue;
      if (!info.isDirectory() || info.uid !== process.getuid() || await fs.realpath(cache) !== cache) {
        throw Error('The package cache is not an owned directory');
      }
      await fs.rm(cache, { recursive: true });
    }
    const after = await fs.statfs(root);
    console.log(JSON.stringify({ packageCachesCleared: true, beforeBytes: before.bavail * before.bsize,
      afterBytes: after.bavail * after.bsize }));
    return;
  }
  if (process.env.QUALIFY_BUILDER === 'true') {
    console.log(JSON.stringify(await qualifyBuilder(appRoot, entry, pm2Home, encoded)));
  } else {
    const status = await readAuditSyncStatus({ appRoot, pm2Home, entry });
    const releases = entry ? await readRetentionInputs(appRoot) : null;
    console.log(JSON.stringify({ ...status, releases }));
  }
}

if (process.argv[1] === '-' && process.argv[2] === '--print') {
  main().catch(() => {
    console.error(process.env.QUALIFY_BUILDER === 'true'
      ? 'Could not verify the pinned Linux builder on the reviewed production host.'
      : 'Could not read audit sync status from the reviewed production checkout.');
    process.exitCode = 1;
  });
}
