import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
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
  const counts = { refreshPaused: 0, startupFailed: 0, memoryLimit: 0, retirementDeferred: 0, lastRetirementDeferredAttempts: null, lastAbandonedRetirement: null, other: 0 };
  const file = path.join(pm2Home, 'logs', name + '-error.log');
  const log = await readTail(file, 32 * 1024).catch(() => null);
  for (const line of (log || '').split(/\r?\n/).filter(Boolean).slice(-40)) {
    const deferred = /\{"event":"audit-workspace-retirement-deferred","attempts":([1-9]\d{0,4})\}$/.exec(line);
    const abandoned = /\{"event":"audit-workspace-abandoned-retired","attempts":([1-9]\d{0,4}),"files":([1-9]\d{0,8}),"bytes":(\d{1,15}),"allocatedBytes":(\d{1,15}),"freeDiskDeltaBytes":(-?\d{1,15})\}$/.exec(line);
    if (line.includes('Driver audit sync paused this refresh.')) counts.refreshPaused++;
    else if (line.includes('Driver audit sync could not start.')) counts.startupFailed++;
    else if (/heap out of memory|Reached heap limit/.test(line)) counts.memoryLimit++;
    else if (deferred) { counts.retirementDeferred++; counts.lastRetirementDeferredAttempts = Number(deferred[1]); }
    else if (abandoned) {
      const [attempts, files, bytes, allocatedBytes, freeDiskDeltaBytes] = abandoned.slice(1).map(Number);
      counts.lastAbandonedRetirement = { attempts, files, bytes, allocatedBytes, freeDiskDeltaBytes };
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

async function main() {
  const appRoot = await fs.realpath(process.cwd());
  const expected = process.env.EXPECTED_DEPLOYED_SHA;
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
  console.log(JSON.stringify(await readAuditSyncStatus({ appRoot, pm2Home, entry })));
}

if (process.argv[1] === '-' && process.argv[2] === '--print') {
  main().catch(() => {
    console.error('Could not read audit sync status from the reviewed production checkout.');
    process.exitCode = 1;
  });
}
