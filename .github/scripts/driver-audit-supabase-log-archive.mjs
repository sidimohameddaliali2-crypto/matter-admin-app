import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, createPublicKey } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const APP = '701655794e1711b4d8c737e929360ecfe5d2f0ca', execute = promisify(execFile);
const sha = b => createHash('sha256').update(b).digest('hex'), need = v => { if (!v) throw Error('Log plan guard failed'); };
const identity = s => ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink'].map(k => String(s[k])).join(':');
const directoryIdentity = s => ['dev', 'ino', 'uid', 'gid', 'mode'].map(k => String(s[k])).join(':');
const signature = s => identity(s) + ':' + [s.size, s.blocks, s.mtimeNs, s.ctimeNs].map(String).join(':');
const stat = s => Object.fromEntries(['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'blocks', 'mtimeNs', 'ctimeNs'].map(k => [k, String(s[k])]));
const files = ['server/package.json', 'server/package-lock.json', 'server/services/driverAuditTransferCodec.js',
  'server/vendor/driver-audits/integration/hosted/worker-lock.mjs'];

async function directory(filesystem, folder, handles, privateMode = false) {
  const before = await filesystem.lstat(folder, { bigint: true });
  need(before.isDirectory() && before.uid === BigInt(process.getuid()) && !(Number(before.mode) & 0o002)
    && (!privateMode || (Number(before.mode) & 0o7777) === 0o700) && await filesystem.realpath(folder) === folder);
  const fd = await filesystem.open(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(fd);
  const check = async () => need(directoryIdentity(await fd.stat({ bigint: true })) === directoryIdentity(before)
    && directoryIdentity(await filesystem.lstat(folder, { bigint: true })) === directoryIdentity(before) && await filesystem.realpath(folder) === folder);
  await check(); return { fd, before, check, anchored: process.platform === 'linux' ? '/proc/self/fd/' + fd.fd : folder };
}

async function logInventory(filesystem, root) {
  await root.check(); const names = [], stream = await filesystem.opendir(root.anchored);
  try { for await (const entry of stream) { need(names.length < 4096 && entry.name && !/[\/\\\0]/.test(entry.name)); names.push(entry.name); } }
  finally { await stream.close().catch(e => { if (e.code !== 'ERR_DIR_CLOSED') throw e; }); }
  const result = new Map();
  for (const name of names.sort()) {
    try {
      const info = await filesystem.lstat(path.join(root.anchored, name), { bigint: true });
      result.set(name, { type: info.isFile() ? 'regular' : info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'other',
        stat: stat(info), identity: identity(info), signature: signature(info) });
    } catch (e) { if (e.code !== 'ENOENT') throw e; result.set(name, null); }
  }
  await root.check(); return result;
}

function processSnapshot(rows, appRoot, logRoot) {
  need(Array.isArray(rows) && rows.length <= 512);
  const named = name => rows.filter(r => r?.name === name), api = named('matter-delivery-api'), sync = named('matter-driver-audit-sync');
  need(api.length === 1 && sync.length === 1 && !named('matter-driver-audit-source').length && !named('matter-driver-reports-api').length);
  const a = api[0], b = sync[0], server = path.join(appRoot, 'server');
  need(a.pid > 0 && a.pm2_env?.status === 'online' && a.pm2_env.pm_cwd === appRoot
    && ['/usr/bin/npm', '/usr/share/nodejs/npm/bin/npm-cli.js', '/usr/lib/node_modules/npm/bin/npm-cli.js', '/usr/local/lib/node_modules/npm/bin/npm-cli.js'].includes(a.pm2_env.pm_exec_path)
    && JSON.stringify(a.pm2_env.args) === '["start","--prefix","server"]');
  const args = b.pm2_env?.args, config = Array.isArray(args) ? args[1] : null;
  need(b.pid === 0 && b.pm2_env.status === 'stopped' && b.pm2_env.pm_cwd === server
    && b.pm2_env.pm_exec_path === path.join(server, 'scripts/driverAuditSync.js') && args.length === 2 && args[0] === '--config'
    && typeof config === 'string' && path.dirname(path.dirname(config)) === path.join(server, '.private/driver-audits')
    && /^[a-f0-9]{64}$/.test(path.basename(path.dirname(config))) && path.basename(config) === 'sync.json');
  const ids = new Set(); let mappingComplete = true;
  const processes = rows.map(r => {
    need(Number.isSafeInteger(r.pm_id) && r.pm_id >= 0 && !ids.has(r.pm_id) && typeof r.name === 'string' && r.name.length <= 200
      && Number.isSafeInteger(r.pid) && r.pid >= 0 && typeof r.pm2_env?.status === 'string' && r.pm2_env.status.length <= 64); ids.add(r.pm_id);
    const channel = value => {
      if (typeof value !== 'string' || value.length > 4096 || value.includes('\0') || !path.isAbsolute(value) || path.normalize(value) !== value) {
        mappingComplete = false; return { scope: 'unresolved', path: null };
      }
      return { scope: value === '/dev/null' ? 'disabled' : path.dirname(value) === logRoot ? 'fixed-direct-log-root' : 'outside-direct-log-root', path: value };
    };
    return { id: r.pm_id, name: r.name, pid: r.pid, status: r.pm2_env.status,
      role: r === a ? 'business-api' : r === b ? 'managed-stopped-sync' : 'other-process',
      stdout: channel(r.pm2_env.pm_out_log_path), stderr: channel(r.pm2_env.pm_err_log_path) };
  }).sort((x, y) => x.id - y.id);
  return { processes, mappingComplete };
}

async function pm2Implementation(exec, filesystem) {
  const result = { observedCliVersion: null, cli: null, codeFingerprints: { status: 'not-captured' },
    installedPackageVersion: null, daemonVersionVerified: false, activeArchiveQualified: false };
  try {
    const output = await exec('pm2', ['--version'], { timeout: 10000, maxBuffer: 8192 });
    const text = String(output.stdout).replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (/^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[A-Za-z0-9.-]{1,64})?$/.test(text)) result.observedCliVersion = text;
  } catch { /* Optional installed-runtime evidence remains explicitly unknown. */ }
  try {
    const output = await exec('/usr/bin/which', ['pm2'], { timeout: 10000, maxBuffer: 8192 }), requested = String(output.stdout).trim();
    need(requested.length <= 4096 && !/[\r\n\0]/.test(requested) && path.isAbsolute(requested) && path.normalize(requested) === requested);
    const resolved = await filesystem.realpath(requested), info = await filesystem.lstat(resolved, { bigint: true });
    need(info.isFile() && [0n, BigInt(process.getuid())].includes(info.uid) && !(Number(info.mode) & 0o6022)
      && info.size > 0n && info.size <= 2n * 1024n ** 2n && await filesystem.realpath(resolved) === resolved);
    result.cli = { requestedPath: requested, resolvedPath: resolved, stat: stat(info) };
  } catch { /* No arbitrary fallback path, import, installation or source call. */ }
  return result;
}

function classify(before, after, mappings, mappingComplete, name) {
  const current = after ?? before, changed = !before || !after || before.signature !== after.signature;
  const activeMapped = mappings.some(r => r.pid > 0 || r.status !== 'stopped');
  const managedStopped = mappings.length > 0 && mappings.every(r => r.role === 'managed-stopped-sync' && r.status === 'stopped' && r.pid === 0);
  const gzipName = /\.gz$/i.test(name), safe = after?.type === 'regular' && after.stat.uid === String(process.getuid())
    && after.stat.nlink === '1' && !(Number(after.stat.mode) & 0o6133);
  const classification = current?.type !== 'regular' ? 'nonregular-protected' : activeMapped ? 'active-mapped-log-protected'
    : gzipName ? 'gzip-name-protected' : !safe ? 'unsafe-or-shared-log-protected'
      : changed ? 'changing-log-protected' : mappingComplete && managedStopped && /\.log$/.test(name)
        ? 'managed-stopped-log-review-candidate' : 'unknown-log-protected';
  return { classification, changedDuringPlanning: changed, activeMapped, managedStopped, gzipName,
    eligibleForSeparateArchiveReview: classification === 'managed-stopped-log-review-candidate', openFileDescriptorsVerified: false };
}

async function savePlan(filesystem, server, raw, planSha, handles) {
  const parent = await directory(filesystem, path.join(server, '.private'), handles, true);
  const name = 'driver-report-log-archives', folder = path.join(server, '.private', name);
  try { await filesystem.mkdir(path.join(parent.anchored, name), { mode: 0o700 }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  await parent.check(); await parent.fd.sync(); const root = await directory(filesystem, folder, handles, true);
  const filename = planSha + '.private.json', file = path.join(folder, filename), anchored = path.join(root.anchored, filename);
  const readback = async () => {
    const before = await filesystem.lstat(file, { bigint: true });
    need(before.isFile() && before.uid === BigInt(process.getuid()) && before.nlink === 1n
      && (Number(before.mode) & 0o7777) === 0o600 && before.size === BigInt(raw.length) && await filesystem.realpath(file) === file);
    const fd = await filesystem.open(anchored, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      need(signature(await fd.stat({ bigint: true })) === signature(before)); const data = Buffer.alloc(raw.length);
      for (let at = 0; at < data.length;) { const r = await fd.read(data, at, data.length - at, at); need(r.bytesRead > 0); at += r.bytesRead; }
      need((await fd.read(Buffer.alloc(1), 0, 1, data.length)).bytesRead === 0 && data.equals(raw) && signature(await fd.stat({ bigint: true })) === signature(before)
        && signature(await filesystem.lstat(file, { bigint: true })) === signature(before));
    } finally { await fd.close(); }
    await root.check();
  };
  let fd;
  try { fd = await filesystem.open(anchored, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (e) { if (e.code !== 'EEXIST') throw e; await readback(); return { path: file, sha256: planSha, bytes: raw.length }; }
  try { await fd.writeFile(raw); await fd.sync(); } finally { await fd.close(); }
  await root.fd.sync(); await readback(); return { path: file, sha256: planSha, bytes: raw.length };
}

// Planning writes one metadata file. Log bytes and process registrations remain untouched.
export async function runDriverAuditSupabaseLogArchive(args, adapters = {}) {
  let phase = 'inputs', lock; const handles = [], guards = [];
  const filesystem = adapters.filesystem ?? fs, now = adapters.now ?? (() => new Date());
  const exec = adapters.exec ?? ((file, argv, options = {}) => execute(file, argv, { cwd: args.appRoot, timeout: 10000, maxBuffer: 4 * 1024 ** 2, ...options }));
  const load = adapters.load ?? (name => import(pathToFileURL(path.join(args.appRoot, 'server', name)).href));
  try {
    need(args && Object.keys(args).sort().join(',') === 'appRoot,expectedSha,operation,recipientPublicKey'
      && args.operation === 'plan-log-archive' && args.expectedSha === APP && (adapters.platform ?? process.platform) === 'linux');
    const home = adapters.homeRoot ?? '/home/matter';
    need(path.isAbsolute(home) && path.resolve(home) === home && args.appRoot === path.join(home, 'matter-delivery-tracker')
      && typeof args.recipientPublicKey === 'string' && args.recipientPublicKey.length <= 8192 && !args.recipientPublicKey.includes('PRIVATE KEY'));
    const key = createPublicKey(args.recipientPublicKey); need(key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails.modulusLength >= 3072);
    const server = path.join(args.appRoot, 'server'), logRoot = path.join(home, '.pm2/logs');
    for (const folder of [home, args.appRoot, server]) guards.push((await directory(filesystem, folder, handles)).check);
    const checkout = async () => { need((await exec('git', ['rev-parse', 'HEAD'])).stdout.trim() === APP);
      await exec('git', ['ls-files', '--error-unmatch', ...files]); await exec('git', ['diff', '--quiet', 'HEAD', '--', 'server']); };
    phase = 'checkout'; await checkout(); const snapshot = async () => processSnapshot(JSON.parse((await exec('pm2', ['jlist'])).stdout), args.appRoot, logRoot);
    phase = 'workers'; const processes = await snapshot();
    phase = 'lock'; const lockRoot = path.join(server, '.private/driver-report-supabase-handoff');
    guards.push((await directory(filesystem, lockRoot, handles, true)).check);
    for (const name of ['operator.lock', 'operator.lock.sqlite', 'operator.lock.sqlite-journal', 'operator.lock.sqlite-wal', 'operator.lock.sqlite-shm']) {
      try { const s = await filesystem.lstat(path.join(lockRoot, name), { bigint: true });
        need(s.isFile() && s.uid === BigInt(process.getuid()) && s.nlink === 1n && !(Number(s.mode) & 0o022)
          && await filesystem.realpath(path.join(lockRoot, name)) === path.join(lockRoot, name)); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    const { acquireWorkerLock } = await load('vendor/driver-audits/integration/hosted/worker-lock.mjs'); lock = await acquireWorkerLock(path.join(lockRoot, 'operator.lock'));
    phase = 'log-metadata'; guards.push((await directory(filesystem, path.join(home, '.pm2'), handles)).check);
    const logs = await directory(filesystem, logRoot, handles); guards.push(logs.check);
    const before = await logInventory(filesystem, logs), implementation = await pm2Implementation(exec, filesystem), after = await logInventory(filesystem, logs);
    phase = 'workers-readback'; need(JSON.stringify(await snapshot()) === JSON.stringify(processes));
    const entries = [...new Set([...before.keys(), ...after.keys()])].sort().map(name => {
      const file = path.join(logRoot, name), mappings = [];
      for (const p of processes.processes) for (const stream of ['stdout', 'stderr']) if (p[stream].scope === 'fixed-direct-log-root' && p[stream].path === file)
        mappings.push({ id: p.id, name: p.name, pid: p.pid, status: p.status, role: p.role, stream });
      const first = before.get(name), last = after.get(name);
      return { name, path: file, type: last?.type ?? first?.type ?? 'unavailable', before: first?.stat ?? null, after: last?.stat ?? null,
        mappings, ...classify(first, last, mappings, processes.mappingComplete, name) };
    });
    const total = { regularFilesAfter: 0, regularLogicalBytesAfter: 0n, uniqueAllocatedBlockBytesAfter: 0n,
      stableStoppedReviewCandidateBytes: 0n, stableStoppedReviewCandidates: 0 };
    const inodes = new Set(); for (const row of entries) if (row.type === 'regular' && row.after) {
      total.regularFilesAfter++; total.regularLogicalBytesAfter += BigInt(row.after.size);
      const inode = row.after.dev + ':' + row.after.ino; if (!inodes.has(inode)) { inodes.add(inode); total.uniqueAllocatedBlockBytesAfter += BigInt(row.after.blocks) * 512n; }
      if (row.eligibleForSeparateArchiveReview) { total.stableStoppedReviewCandidateBytes += BigInt(row.after.size); total.stableStoppedReviewCandidates++; }
    }
    const totals = Object.fromEntries(Object.entries(total).map(([k, v]) => [k, typeof v === 'bigint' ? String(v) : v]));
    const plan = { version: 1, kind: 'supabase-pm2-log-archive-plan-v1', applicationCommit: APP, generatedAt: now().toISOString(), logRoot,
      directoryIdentity: directoryIdentity(logs.before), processes: processes.processes, mappingComplete: processes.mappingComplete,
      pm2Implementation: implementation, files: entries, totals, minimumSeedReserveBytes: '1073741824',
      logBodyBytesRead: 0, logBodyBytesWritten: 0, openFileDescriptorsVerified: false, compressionAuthorized: false,
      deletionAuthorized: false, seedReadyClaimed: false, activeLogAppendAllowed: true,
      futureApplyRequiresFreshFileMappingAndWritableDescriptorChecks: true };
    const raw = Buffer.from(JSON.stringify(plan)); need(raw.length <= 4 * 1024 ** 2); const planSha = sha(raw);
    const planRef = { path: path.join(server, '.private/driver-report-log-archives', planSha + '.private.json'), sha256: planSha, bytes: raw.length };
    const metadata = { version: 1, kind: 'supabase-pm2-log-archive-plan-result-v1', applicationCommit: APP,
      plan: planRef, generatedAt: plan.generatedAt, totals, mappingComplete: plan.mappingComplete, pm2Implementation: implementation,
      files: [...entries].sort((a, b) => BigInt(a.after?.size ?? 0) === BigInt(b.after?.size ?? 0) ? a.name < b.name ? -1 : 1
        : BigInt(a.after?.size ?? 0) > BigInt(b.after?.size ?? 0) ? -1 : 1).slice(0, 128), fileCount: entries.length,
      fileRecordsOmitted: entries.length > 128, logBodyBytesRead: 0, logBodyBytesWritten: 0,
      openFileDescriptorsVerified: false, compressionAuthorized: false, deletionAuthorized: false, seedReadyClaimed: false };
    let bytes, packed; for (let n = 0; n < 9; n++) {
      bytes = Buffer.from(JSON.stringify(metadata)); packed = gzipSync(bytes); if (bytes.length <= 384 * 1024 && packed.length <= 40 * 1024) break;
      metadata.files = metadata.files.slice(0, Math.floor(metadata.files.length / 2)); metadata.fileRecordsOmitted = true;
    }
    need(bytes.length <= 384 * 1024 && packed.length <= 40 * 1024);
    const verify = async () => { await checkout(); for (const check of guards) await check();
      need(JSON.stringify(await snapshot()) === JSON.stringify(processes)); };
    phase = 'readback'; await verify();
    phase = 'seal'; const { sealTransferSecrets } = await load('services/driverAuditTransferCodec.js');
    const capsule = sealTransferSecrets(key, { version: 1, kind: 'supabase-pm2-log-archive-plan-capsule-v1', applicationCommit: APP,
      metadataSha256: sha(bytes), metadataGzipSha256: sha(packed), metadataGzipBase64: packed.toString('base64') });
    phase = 'readback'; await verify(); phase = 'plan-write'; await savePlan(filesystem, server, raw, planSha, handles);
    phase = 'readback'; await verify();
    return { status: 'supabase-log-archive-planned', operation: args.operation, applicationCommit: APP, planSha256: planSha,
      metadataSha256: sha(bytes), recipientSha256: sha(args.recipientPublicKey), capsule, planOnly: true,
      logBodyBytesRead: 0, logBodyBytesWritten: 0, compressionPerformed: false, deletedFiles: 0,
      workersChanged: false, routingChanged: false, applicationDatabaseConnections: 0, networkRequests: 0 };
  } catch { throw Object.assign(Error('Supabase log archive plan stopped at ' + phase), { phase }); }
  finally { let failure = false; for (const handle of handles.reverse()) try { await handle.close(); } catch { failure = true; }
    try { await lock?.release(); } catch { failure = true; } if (failure) throw Object.assign(Error('Supabase log archive plan stopped at cleanup'), { phase: 'cleanup' }); }
}
