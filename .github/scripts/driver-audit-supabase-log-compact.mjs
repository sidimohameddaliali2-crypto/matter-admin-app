import fs from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, createPublicKey, randomUUID } from 'node:crypto';
import { createGzip, createGunzip, gzipSync } from 'node:zlib';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const APP = '701655794e1711b4d8c737e929360ecfe5d2f0ca';
const PLAN = '8a554f4f4e357764b23eca0cc5dad9e19db32e86d6e4e321e6a67cb0969cecd3';
const selected = Object.freeze([
  { name: 'matter-delivery-api-out-0.log', ino: '794798', size: '472012406' },
  { name: 'server-error.log', ino: '878394', size: '205142782' },
  { name: 'server-out.log', ino: '878393', size: '201077858' },
]);
const sha = b => createHash('sha256').update(b).digest('hex'), encode = v => Buffer.from(JSON.stringify(v));
const need = (v, code = 'GUARD') => { if (!v) throw Object.assign(Error('Closed log compaction guard failed'), { code }); };
const hex = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const iso = v => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const scopedFolder = (v, parent, prefix) => typeof v === 'string' && path.dirname(v) === parent && path.normalize(v) === v
  && path.basename(v).startsWith(prefix) && /^[a-f0-9-]{36}$/.test(path.basename(v).slice(prefix.length));
const stat = s => Object.fromEntries(['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'blocks', 'mtimeNs', 'ctimeNs'].map(k => [k, String(s[k])]));
const dirId = s => ['dev', 'ino', 'uid', 'gid', 'mode'].map(k => String(s[k])).join(':');
const signature = s => Object.values(stat(s)).join(':');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const missing = e => ['ENOENT', 'ESRCH'].includes(e.code);
async function optional(file) { try { return await fs.lstat(file, { bigint: true }); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }

async function boundedRead(file, maximum, privateMode = false) {
  const before = await fs.lstat(file, { bigint: true });
  need(before.isFile() && !before.isSymbolicLink() && before.size <= BigInt(maximum)
    && (!privateMode || before.uid === BigInt(process.getuid()) && before.nlink === 1n && (Number(before.mode) & 0o7777) === 0o600)
    && await fs.realpath(file) === file, 'PRIVATE_FILE');
  const fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    need(signature(await fd.stat({ bigint: true })) === signature(before), 'FILE_CHANGED');
    const output = Buffer.alloc(maximum + 1); let bytes = 0;
    while (bytes <= maximum) { const r = await fd.read(output, bytes, output.length - bytes, bytes); if (!r.bytesRead) break; bytes += r.bytesRead; }
    need(bytes <= maximum && signature(await fd.stat({ bigint: true })) === signature(before)
      && signature(await fs.lstat(file, { bigint: true })) === signature(before), 'FILE_CHANGED');
    return output.subarray(0, bytes);
  } finally { await fd.close(); }
}
async function jsonFile(file, maximum = 4 * 1024 ** 2) { const b = await boundedRead(file, maximum, true);
  need(b.length > 0 && Buffer.from(b.toString()).equals(b)); return { raw: b, value: JSON.parse(b) }; }
async function dir(folder, handles, privateMode = false, sourceParent = false) {
  const before = await fs.lstat(folder, { bigint: true });
  need(before.isDirectory() && before.uid === BigInt(process.getuid()) && !(Number(before.mode) & (sourceParent ? 0o022 : 0o002))
    && (!privateMode || (Number(before.mode) & 0o7777) === 0o700) && await fs.realpath(folder) === folder, 'DIRECTORY');
  const fd = await fs.open(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(fd);
  const check = async () => need(dirId(await fd.stat({ bigint: true })) === dirId(before)
    && dirId(await fs.lstat(folder, { bigint: true })) === dirId(before) && await fs.realpath(folder) === folder, 'DIRECTORY_CHANGED');
  await check(); return { path: folder, fd, before, check, anchored: process.platform === 'linux' ? '/proc/self/fd/' + fd.fd : folder };
}
async function mkdir(parent, name, handles, fresh = false) {
  need(path.basename(name) === name && !['.', '..'].includes(name)); await parent.check(); let created = false;
  try { await fs.mkdir(path.join(parent.anchored, name), { mode: 0o700 }); created = true; }
  catch (e) { if (e.code !== 'EEXIST' || fresh) throw e; }
  await parent.fd.sync(); await parent.check(); return { ...await dir(path.join(parent.path, name), handles, true), created };
}
async function writeOnce(root, name, bytes) {
  const raw = Buffer.isBuffer(bytes) ? bytes : encode(bytes); need(path.basename(name) === name && raw.length <= 4 * 1024 ** 2);
  await root.check();
  if (await optional(path.join(root.path, name))) { need((await boundedRead(path.join(root.path, name), raw.length, true)).equals(raw), 'EXISTING_EVIDENCE'); return { sha256: sha(raw), bytes: raw.length }; }
  const temporary = '.metadata-' + randomUUID() + '.tmp';
  const fd = await fs.open(path.join(root.anchored, temporary), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await fd.writeFile(raw); await fd.sync(); } finally { await fd.close(); }
  await root.fd.sync(); await root.check();
  need((await boundedRead(path.join(root.path, temporary), raw.length, true)).equals(raw), 'WRITE_READBACK');
  if (await optional(path.join(root.path, name))) need((await boundedRead(path.join(root.path, name), raw.length, true)).equals(raw), 'EXISTING_EVIDENCE');
  else await fs.rename(path.join(root.anchored, temporary), path.join(root.anchored, name));
  await root.fd.sync(); await root.check(); need((await boundedRead(path.join(root.path, name), raw.length, true)).equals(raw), 'WRITE_READBACK');
  return { sha256: sha(raw), bytes: raw.length };
}
async function childNames(root, maximum) { await root.check(); const rows = await fs.readdir(root.anchored); need(rows.length <= maximum, 'DIRECTORY_BOUND');
  need(rows.every(n => n && path.basename(n) === n && !/[\\\0]/.test(n))); await root.check(); return rows.sort(); }

// No command lines or environments are read. Root administrators are explicitly
// outside this owner/group census; no global root-FD exclusion is asserted.
export async function inspectDriverAuditLogDescriptors({ procRoot = '/proc', uid, gid, identities, ownedReadFds = new Map(), signal }) {
  const started = Date.now(), matches = [], relevant = [], excludedRoot = [], pids = (await fs.readdir(procRoot)).filter(n => /^[1-9][0-9]{0,9}$/.test(n));
  need(pids.length <= 8192, 'PROC_BOUND'); let descriptors = 0;
  for (const pid of pids) {
    signal?.throwIfAborted(); need(Date.now() - started <= 30000, 'PROC_TIME_BOUND');
    let text;
    try { text = (await boundedRead(path.join(procRoot, pid, 'status'), 64 * 1024)).toString(); }
    catch (e) {
      if (missing(e)) continue;
      throw Object.assign(Error('Relevant process status is unreadable'), { code: 'PROC_STATUS_UNKNOWN', pid: Number(pid) });
    }
    const values = name => { const line = text.match(new RegExp('^' + name + ':[ \\t]*([0-9 \\t]*)$', 'm')); need(line, 'PROC_STATUS_SCHEMA');
      const result = line[1].trim() ? line[1].trim().split(/\s+/).map(Number) : [];
      need(result.every(v => Number.isSafeInteger(v) && v >= 0 && v <= 0xffffffff), 'PROC_STATUS_SCHEMA'); return result; };
    const uids = values('Uid'), gids = values('Gid'), groups = values('Groups');
    need(uids.length === 4 && gids.length === 4 && groups.length <= 1024, 'PROC_STATUS_SCHEMA');
    if (uids.every(v => v === 0) && !uids.includes(uid)) { excludedRoot.push(Number(pid)); continue; }
    if (!uids.includes(uid) && !gids.includes(gid) && !groups.includes(gid)) continue;
    relevant.push(Number(pid)); let fds;
    try { fds = (await fs.readdir(path.join(procRoot, pid, 'fd'))).filter(n => /^(?:0|[1-9][0-9]{0,9})$/.test(n)); }
    catch (e) { if (missing(e)) continue; throw Object.assign(Error('Relevant process descriptors are unreadable'), { code: 'PROC_FDS_UNKNOWN', pid: Number(pid) }); }
    need(fds.length <= 16384 && (descriptors += fds.length) <= 131072, 'PROC_FD_BOUND');
    for (const number of fds) {
      let info; try { info = await fs.stat(path.join(procRoot, pid, 'fd', number), { bigint: true }); }
      catch (e) { if (missing(e)) continue; throw Object.assign(Error('Descriptor identity is unreadable'), { code: 'PROC_FD_UNKNOWN', pid: Number(pid), fd: Number(number) }); }
      const id = String(info.dev) + ':' + String(info.ino); if (!identities.has(id)) continue;
      if (Number(pid) === process.pid && ownedReadFds.get(Number(number)) === id) {
        const fdinfo = (await boundedRead(path.join(procRoot, pid, 'fdinfo', number), 16 * 1024)).toString(), flags = fdinfo.match(/^flags:\s*([0-7]+)$/m);
        need(flags && (Number.parseInt(flags[1], 8) & 3) === 0, 'OWN_RAW_FD_NOT_READONLY'); continue;
      }
      matches.push({ pid: Number(pid), fd: Number(number), dev: String(info.dev), ino: String(info.ino) });
    }
  }
  if (matches.length) throw Object.assign(Error('A selected log descriptor is open'), { code: 'RAW_DESCRIPTOR_OPEN', pid: matches[0].pid, fd: matches[0].fd });
  return { version: 1, checkedAt: new Date().toISOString(), scope: 'same-uid-and-nonroot-primary-or-supplementary-gid', uid, gid,
    selectedIdentities: [...identities].sort(),
    relevantPids: relevant.sort((a, b) => a - b), excludedPrivilegedRootPids: excludedRoot.sort((a, b) => a - b),
    descriptorsChecked: descriptors, otherSelectedDescriptors: 0, globalRootDescriptorCoverageClaimed: false };
}

function pm2State(rows, appRoot, scope) {
  need(Array.isArray(rows) && rows.length <= 512, 'PM2_SCHEMA'); const one = name => { const a = rows.filter(r => r.name === name); need(a.length === 1, 'PM2_TOPOLOGY'); return a[0]; };
  const api = one('matter-delivery-api'), sync = one('matter-driver-audit-sync'), server = path.join(appRoot, 'server');
  need(!rows.some(r => ['matter-driver-audit-source', 'matter-driver-reports-api'].includes(r.name)), 'REPORT_PROCESS_PRESENT');
  need(api.pid > 0 && api.pm2_env?.status === 'online' && api.pm2_env.pm_cwd === appRoot
    && JSON.stringify(api.pm2_env.args) === '["start","--prefix","server"]'
    && ['/usr/bin/npm', '/usr/share/nodejs/npm/bin/npm-cli.js', '/usr/lib/node_modules/npm/bin/npm-cli.js', '/usr/local/lib/node_modules/npm/bin/npm-cli.js'].includes(api.pm2_env.pm_exec_path), 'BUSINESS_PROCESS');
  const args = sync.pm2_env?.args;
  need(sync.pid === 0 && sync.pm2_env.status === 'stopped' && sync.pm2_env.pm_cwd === server
    && sync.pm2_env.pm_exec_path === path.join(server, 'scripts/driverAuditSync.js') && Array.isArray(args) && args.length === 2 && args[0] === '--config'
    && path.dirname(path.dirname(args[1])) === path.join(server, '.private/driver-audits')
    && /^[a-f0-9]{64}$/.test(path.basename(path.dirname(args[1]))) && path.basename(args[1]) === 'sync.json', 'SYNC_PROCESS');
  const core = [api, sync].map(r => {
    need(Number.isSafeInteger(r.pm_id) && r.pm_id >= 0 && Number.isSafeInteger(r.pid) && r.pid >= 0
      && Number.isSafeInteger(r.pm2_env.restart_time) && r.pm2_env.restart_time >= 0
      && Number.isSafeInteger(r.pm2_env.unstable_restarts) && r.pm2_env.unstable_restarts >= 0, 'PM2_COUNTERS');
    return { id: r.pm_id, name: r.name, pid: r.pid, status: r.pm2_env.status, script: r.pm2_env.pm_exec_path, cwd: r.pm2_env.pm_cwd,
      args: r.pm2_env.args, restartCount: r.pm2_env.restart_time, unstableRestarts: r.pm2_env.unstable_restarts, uptime: r.pm2_env.pm_uptime ?? null };
  });
  const paths = [];
  for (const r of rows) for (const field of ['pm_out_log_path', 'pm_err_log_path', 'pm_log_path']) {
    const file = r.pm2_env?.[field]; if ((file === undefined || file === null || file === '') && field === 'pm_log_path') continue;
    need(typeof file === 'string' && file.length <= 4096 && !file.includes('\0') && path.isAbsolute(file) && path.normalize(file) === file, 'PM2_LOG_MAPPING_UNKNOWN');
    need(!scope.some(row => path.join(appRoot, '..', '.pm2/logs', row.name) === file), 'SELECTED_PM2_LOG_MAPPING');
    paths.push({ id: r.pm_id, field, path: file });
  }
  return { core, paths };
}

async function hashStream(stream, maximum, signal, transform) {
  const hash = createHash('sha256'); let bytes = 0;
  await pipeline(...(transform ? [stream, transform] : [stream]), new Writable({ write(chunk, encoding, done) { bytes += chunk.length; if (bytes > maximum) return done(Error('Stream bound'));
    hash.update(chunk); done(); } }), { signal });
  return { sha256: hash.digest('hex'), bytes };
}
// The lifecycle owns this FileHandle. Destroying a failed pipeline must never
// close its descriptor behind the descriptor census or cleanup bookkeeping.
function rawStream(fd, size) {
  return Readable.from((async function* () {
    for (let position = 0; position < size;) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, size - position));
      const { bytesRead } = await fd.read(chunk, 0, chunk.length, position);
      need(bytesRead > 0, 'RAW_UNEXPECTED_EOF'); position += bytesRead; yield chunk.subarray(0, bytesRead);
    }
  })(), { objectMode: false, highWaterMark: 64 * 1024 });
}
async function gzipProof(file, expectedSize, signal) {
  const compressed = await hashStream(createReadStream(file, { highWaterMark: 64 * 1024 }), 128 * 1024 ** 2, signal);
  const raw = await hashStream(createReadStream(file, { highWaterMark: 64 * 1024 }), expectedSize, signal, createGunzip());
  need(raw.bytes === expectedSize, 'GZIP_LENGTH'); return { gzipSha256: compressed.sha256, gzipBytes: compressed.bytes, rawSha256: raw.sha256, rawBytes: raw.bytes };
}

function expectedStat(actual, expected, renamed = false) {
  const value = stat(actual); need(actual.isFile() && actual.nlink === 1n, 'RAW_TYPE_LINKS');
  for (const key of ['dev', 'ino', 'uid', 'gid', 'mode', 'size', 'blocks', 'mtimeNs', ...(renamed ? [] : ['ctimeNs'])])
    need(value[key] === expected[key], 'RAW_METADATA_CHANGED');
  if (renamed) need(BigInt(value.ctimeNs) >= BigInt(expected.ctimeNs), 'RAW_CTIME'); return value;
}
function originalRetiredProjection(value, expected) {
  const fields = ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'blocks', 'mtimeNs', 'ctimeNs'];
  return exact(value, fields) && fields.every(k => typeof value[k] === 'string' && /^[0-9]+$/.test(value[k]))
    && fields.filter(k => k !== 'ctimeNs').every(k => value[k] === expected[k]) && BigInt(value.ctimeNs) >= BigInt(expected.ctimeNs);
}
async function gzipStat(file) {
  const s = await fs.lstat(file, { bigint: true });
  need(s.isFile() && s.uid === BigInt(process.getuid()) && s.nlink === 1n && (Number(s.mode) & 0o7777) === 0o600
    && s.size <= 128n * 1024n ** 2n && await fs.realpath(file) === file, 'GZIP_FILE'); return s;
}
async function compressedUsage(archives) {
  let logical = 0n, allocated = 0n;
  for (const name of await childNames(archives, 32)) {
    need(selected.some(row => name.startsWith(row.name + '.gzip-')) && /\.gzip-[a-f0-9-]{36}$/.test(name), 'OUTPUT_NAMESPACE');
    const folder = path.join(archives.path, name), s = await fs.lstat(folder, { bigint: true });
    need(s.isDirectory() && s.uid === BigInt(process.getuid()) && (Number(s.mode) & 0o7777) === 0o700 && await fs.realpath(folder) === folder, 'OUTPUT_DIRECTORY');
    const names = await fs.readdir(folder); need(names.length <= 32 && names.every(n => ['attempt.private.json', 'created.private.json', 'interrupted.private.json',
      'scratch-released.private.json', 'payload.partial', 'payload.gz'].includes(n)
      || /^\.metadata-[a-f0-9-]{36}\.tmp$/.test(n)), 'OUTPUT_NAMESPACE');
    for (const file of names.filter(n => ['payload.partial', 'payload.gz'].includes(n))) { const st = await gzipStat(path.join(folder, file)); logical += st.size; allocated += st.blocks * 512n; }
  }
  return { logical, allocated };
}

export async function runDriverAuditSupabaseLogCompaction(args, adapters = {}) {
  let phase = 'inputs', lock, recovery, key, outwardFailure, seal;
  const handles = [], rawHandles = new Set(), ownedReadFds = new Map(), guards = [], censusProofs = [];
  const abort = new AbortController(), signal = adapters.signal ? AbortSignal.any([abort.signal, adapters.signal]) : abort.signal;
  const interrupt = () => abort.abort(Error('Log compaction interrupted'));
  const exec = adapters.exec ?? ((file, argv) => promisify(execFile)(file, argv, { cwd: args.appRoot, timeout: 10000, maxBuffer: 4 * 1024 ** 2 }));
  const load = adapters.load ?? (name => import(pathToFileURL(path.join(args.appRoot, 'server', name)).href));
  const scope = adapters.scope ?? { planSha256: PLAN, uid: 1000, gid: 1000, files: selected };
  const budget = adapters.outputBudget ?? 128 * 1024 ** 2;
  let planRaw, intentRef, intent, initial, rows, home, server, source, archives, rawRoot;
  const closeRaw = async fd => { if (!rawHandles.has(fd)) return; const number = fd.fd; await fd.close(); rawHandles.delete(fd); ownedReadFds.delete(number); };
  const pulse = async name => { signal.throwIfAborted(); await adapters.onPhase?.(name); signal.throwIfAborted(); };
  const stoppedFailure = (at, cause, cleanupFailures = []) => {
    const error = Object.assign(Error('Supabase closed log compaction stopped at ' + at), { phase: 'log-compaction-' + at });
    if (key && seal) try {
      const details = encode({ version: 1, kind: 'closed-log-compaction-failure-v1', applicationCommit: APP, planSha256: args.planSha256,
        phase: at, code: typeof cause?.code === 'string' ? cause.code.slice(0, 128) : null,
        message: String(cause?.message ?? '').slice(0, 2048), pid: cause?.pid ?? null, fd: cause?.fd ?? null, cleanupFailures,
        recoveryPath: recovery?.path ?? null, originalDataRollbackAttempted: false, recoveryRequiresSameIntent: true });
      const packed = gzipSync(details), capsule = seal(key, { version: 1, kind: 'supabase-closed-log-compaction-failure-capsule-v1', applicationCommit: APP,
        metadataSha256: sha(details), metadataGzipSha256: sha(packed), metadataGzipBase64: packed.toString('base64') });
      Object.defineProperty(error, 'supabaseControlStopped', { value: { status: 'supabase-control-stopped', applicationCommit: APP,
        operatorPhase: error.phase, metadataSha256: sha(details), capsule } });
    } catch { /* A private diagnostic never replaces the original guard. */ }
    return error;
  };
  try {
    need(args && Object.keys(args).sort().join(',') === 'appRoot,expectedSha,operation,planSha256,recipientPublicKey'
      && args.operation === 'archive-closed-logs' && args.expectedSha === APP && args.planSha256 === scope.planSha256 && hex(scope.planSha256)
      && (adapters.platform ?? process.platform) === 'linux' && process.getuid() === scope.uid && process.getgid() === scope.gid
      && Number.isSafeInteger(budget) && budget > 8192 && budget <= 128 * 1024 ** 2, 'INPUT_SCOPE');
    home = adapters.homeRoot ?? '/home/matter'; server = path.join(args.appRoot, 'server');
    need(path.isAbsolute(home) && path.resolve(home) === home && args.appRoot === path.join(home, 'matter-delivery-tracker')
      && typeof args.recipientPublicKey === 'string' && args.recipientPublicKey.length <= 8192 && !args.recipientPublicKey.includes('PRIVATE KEY'));
    key = createPublicKey(args.recipientPublicKey); need(key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails.modulusLength >= 3072);
    for (const event of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(event, interrupt); signal.throwIfAborted();
    for (const folder of [home, args.appRoot, server, path.join(home, '.pm2')])
      guards.push((await dir(folder, handles, false, [home, path.join(home, '.pm2')].includes(folder))).check);
    source = await dir(path.join(home, '.pm2/logs'), handles, false, true); guards.push(source.check);
    const checkout = async () => { need((await exec('git', ['rev-parse', 'HEAD'])).stdout.trim() === APP, 'CHECKOUT');
      await exec('git', ['ls-files', '--error-unmatch', 'server/services/driverAuditTransferCodec.js', 'server/vendor/driver-audits/integration/hosted/worker-lock.mjs']);
      await exec('git', ['diff', '--quiet', 'HEAD', '--', 'server']); };
    phase = 'checkout'; await checkout();
    ({ sealTransferSecrets: seal } = await load('services/driverAuditTransferCodec.js')); need(typeof seal === 'function');
    const snapshot = async () => pm2State(JSON.parse((await exec('pm2', ['jlist'])).stdout), args.appRoot, scope.files);
    phase = 'processes'; initial = await snapshot();
    phase = 'lock'; const lockDirectory = await dir(path.join(server, '.private/driver-report-supabase-handoff'), handles, true); guards.push(lockDirectory.check);
    const lockFiles = ['operator.lock', 'operator.lock.sqlite', 'operator.lock.sqlite-journal', 'operator.lock.sqlite-wal', 'operator.lock.sqlite-shm'];
    const lockIdentities = new Map();
    const checkLockFiles = async (pinned = false) => {
      await lockDirectory.check();
      for (const name of lockFiles) {
        const file = path.join(lockDirectory.path, name), s = await optional(file);
        if (!s) { need(!pinned || !['operator.lock', 'operator.lock.sqlite'].includes(name), 'MUTEX_DISAPPEARED'); continue; }
        need(s.isFile() && s.uid === BigInt(process.getuid()) && s.nlink === 1n && !(Number(s.mode) & 0o7133)
          && await fs.realpath(file) === file, 'MUTEX_FILE');
        const id = dirId(s) + ':' + s.nlink;
        if (pinned && lockIdentities.has(name)) need(id === lockIdentities.get(name), 'MUTEX_CHANGED');
        else if (['operator.lock', 'operator.lock.sqlite'].includes(name)) lockIdentities.set(name, id);
      }
    };
    await checkLockFiles();
    const { acquireWorkerLock } = await load('vendor/driver-audits/integration/hosted/worker-lock.mjs');
    lock = await acquireWorkerLock(path.join(lockDirectory.path, 'operator.lock'));
    // The helper may replace the stale legacy PID receipt, but the SQLite
    // inode must remain the safely admitted one. Pin the fresh owned receipt.
    lockIdentities.delete('operator.lock'); await checkLockFiles(true); guards.push(() => checkLockFiles(true));
    const parent = await dir(path.join(server, '.private/driver-report-log-archives'), handles, true); guards.push(parent.check);
    phase = 'original-plan'; const saved = await jsonFile(path.join(parent.path, args.planSha256 + '.private.json'));
    need(sha(saved.raw) === args.planSha256 && saved.value.version === 1 && saved.value.kind === 'supabase-pm2-log-archive-plan-v1'
      && saved.value.applicationCommit === APP && saved.value.logRoot === source.path && Array.isArray(saved.value.files), 'ORIGINAL_PLAN');
    planRaw = saved.raw; rows = scope.files.map(pin => {
      const found = saved.value.files.filter(r => r.name === pin.name); need(found.length === 1, 'PLAN_FILE'); const row = found[0];
      need(row.path === path.join(source.path, pin.name) && row.type === 'regular' && row.before && row.after && same(row.before, row.after)
        && row.after.ino === String(pin.ino) && row.after.size === String(pin.size) && row.after.uid === String(scope.uid)
        && row.after.gid === String(scope.gid) && Number(row.after.mode) === 0o100664 && row.after.nlink === '1', 'EXACT_LEGACY_FILE');
      return { name: pin.name, expected: row.after };
    });
    const planApi = saved.value.processes?.find(p => p.role === 'business-api');
    need(planApi && initial.core[0].id === planApi.id && initial.core[0].pid === planApi.pid && planApi.status === 'online', 'ORIGINAL_BUSINESS_PID');
    const identities = new Set();
    for (const row of rows) { const published = await optional(path.join(source.path, row.name));
      if (published) { expectedStat(published, row.expected); identities.add(row.expected.dev + ':' + row.expected.ino); } }
    const audit = async () => {
      const context = { uid: scope.uid, gid: scope.gid, identities, ownedReadFds, signal };
      const proof = await (adapters.inspectDescriptors ?? inspectDriverAuditLogDescriptors)(context);
      need(proof && proof.otherSelectedDescriptors === 0 && proof.globalRootDescriptorCoverageClaimed === false, 'DESCRIPTOR_AUDIT');
      censusProofs.push(proof); if (censusProofs.length > 64) censusProofs.shift(); return proof;
    };
    const processCheck = async () => {
      signal.throwIfAborted(); await checkout(); for (const check of guards) await check(); const state = await snapshot();
      need(same(state.core, initial.core), 'ORIGINAL_PROCESSES_CHANGED');
      for (const mapping of state.paths) {
        let s; try { s = await fs.stat(mapping.path, { bigint: true }); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
        need(!identities.has(String(s.dev) + ':' + String(s.ino)), 'PM2_INODE_ALIAS');
      }
    };
    phase = 'preflight'; await processCheck(); await audit(); await pulse('preflight');
    recovery = await mkdir(parent, args.planSha256 + '.recovery', handles); guards.push(recovery.check);
    const intentFile = path.join(recovery.path, 'intent.private.json');
    const intentPresent = await optional(intentFile);
    if (recovery.created || !intentPresent) {
      if (!recovery.created) {
        const pending = await childNames(recovery, 32);
        need(pending.every(n => /^\.metadata-[a-f0-9-]{36}\.tmp$/.test(n)), 'UNBOUND_RECOVERY_NAMESPACE');
        for (const row of rows) expectedStat(await fs.lstat(path.join(source.path, row.name), { bigint: true }), row.expected);
      }
      intent = { version: 1, kind: 'three-closed-log-compaction-intent-v1', planSha256: args.planSha256, applicationCommit: APP,
        createdAt: new Date().toISOString(), sourceDirectoryIdentity: dirId(source.before), originalProcesses: initial.core,
        files: rows, outputBudgetBytes: budget, trustedOwnerNamespaceExclusion: true, kernelNoReplaceOrInodeCasClaimed: false,
        rootAdministratorDescriptorCoverageClaimed: false, sourceModesChanged: false };
      intentRef = await writeOnce(recovery, 'intent.private.json', intent); await writeOnce(recovery, 'original-plan.private.json', planRaw);
    } else {
      const savedIntent = await jsonFile(intentFile); intent = savedIntent.value; intentRef = { sha256: sha(savedIntent.raw), bytes: savedIntent.raw.length };
      need(intent.kind === 'three-closed-log-compaction-intent-v1' && intent.planSha256 === args.planSha256 && intent.applicationCommit === APP
        && intent.sourceDirectoryIdentity === dirId(source.before) && same(intent.originalProcesses, initial.core) && same(intent.files, rows)
        && intent.outputBudgetBytes === budget && intent.trustedOwnerNamespaceExclusion === true && intent.kernelNoReplaceOrInodeCasClaimed === false, 'RECOVERY_INTENT');
      // Only these freshly read, hash-pinned original bytes can fill an
      // interrupted metadata copy; an existing conflict is never overwritten.
      await writeOnce(recovery, 'original-plan.private.json', planRaw);
    }
    rawRoot = await mkdir(recovery, 'raw', handles); archives = await mkdir(recovery, 'archives', handles);
    need(rawRoot.before.dev === source.before.dev, 'CROSS_DEVICE_RETIREMENT');
    need((await childNames(rawRoot, 24)).every(name => rows.some(row => name.startsWith(row.name + '.raw-'))
      && /\.raw-[a-f0-9-]{36}$/.test(name)), 'RAW_NAMESPACE');
    const states = new Map();
    // Discover every prior retirement before checking any published name. A
    // retry may resume a later file after an earlier verified raw was released.
    for (const row of rows) {
      const verified = Boolean(await optional(path.join(recovery.path, row.name + '.verified.private.json')));
      let hasRaw = false;
      for (const name of (await childNames(rawRoot, 24)).filter(n => n.startsWith(row.name + '.raw-'))) {
        const entry = await dir(path.join(rawRoot.path, name), handles, true);
        const contents = await childNames(entry, 32);
        need(contents.every(n => ['entry.private.json', 'original.log', 'retired.private.json'].includes(n) || /^\.metadata-[a-f0-9-]{36}\.tmp$/.test(n)), 'RAW_ENTRY_NAMESPACE');
        if (!await optional(path.join(entry.path, 'entry.private.json'))) {
          need(contents.every(n => /^\.metadata-[a-f0-9-]{36}\.tmp$/.test(n)), 'RAW_WITHOUT_ORIGIN'); continue;
        }
        const original = (await jsonFile(path.join(entry.path, 'entry.private.json'))).value;
        need(original.intentSha256 === intentRef.sha256 && original.name === row.name && same(original.originalStat, row.expected), 'RAW_ENTRY_INTENT');
        const found = await optional(path.join(entry.path, 'original.log'));
        if (found) { expectedStat(found, row.expected, true); need(!hasRaw, 'MULTIPLE_RAW_ENTRIES'); hasRaw = true;
          identities.add(row.expected.dev + ':' + row.expected.ino); }
      }
      if (hasRaw || verified) states.set(row.name, { retired: true, verified });
    }
    const sourceCheck = async () => {
      for (const row of rows) {
        const s = await optional(path.join(source.path, row.name));
        if (states.get(row.name)?.retired) need(!s, 'INDEPENDENT_ORIGINAL_RECREATED');
        else if (s) expectedStat(s, row.expected); else need(states.get(row.name)?.verified, 'ORIGINAL_DISAPPEARED');
      }
    };
    const receipts = [];
    for (const row of rows) {
      phase = 'recovery-state'; await pulse('before-file');
      const receiptName = row.name + '.verified.private.json', receiptPath = path.join(recovery.path, receiptName);
      let receipt = await optional(receiptPath) ? (await jsonFile(receiptPath)).value : null;
      if (receipt) need(exact(receipt, ['version', 'kind', 'intentSha256', 'planSha256', 'name', 'originalStat', 'retiredRawStat', 'rawEntry', 'gzipPath',
        'gzipStat', 'rawSha256', 'rawBytes', 'gzipSha256', 'gzipBytes', 'verifiedAt', 'independentOriginalFdAndGunzipVerified', 'globalRootDescriptorCoverageClaimed'])
        && receipt.version === 1 && receipt.kind === 'closed-log-gzip-verified-v1' && receipt.intentSha256 === intentRef.sha256 && receipt.planSha256 === args.planSha256
        && receipt.name === row.name && same(receipt.originalStat, row.expected) && hex(receipt.rawSha256)
        && originalRetiredProjection(receipt.retiredRawStat, row.expected)
        && hex(receipt.gzipSha256) && receipt.rawBytes === Number(row.expected.size) && Number.isSafeInteger(receipt.gzipBytes) && receipt.gzipBytes > 0
        && iso(receipt.verifiedAt) && receipt.independentOriginalFdAndGunzipVerified === true && receipt.globalRootDescriptorCoverageClaimed === false
        && scopedFolder(receipt.rawEntry, rawRoot.path, row.name + '.raw-')
        && typeof receipt.gzipPath === 'string' && path.basename(receipt.gzipPath) === 'payload.gz'
        && scopedFolder(path.dirname(receipt.gzipPath), archives.path, row.name + '.gzip-'), 'VERIFIED_RECEIPT');
      const entries = (await childNames(rawRoot, 24)).filter(n => n.startsWith(row.name + '.raw-'));
      let retired, preopened;
      for (const name of entries) {
        need(/\.raw-[a-f0-9-]{36}$/.test(name), 'RAW_NAMESPACE'); const entry = await dir(path.join(rawRoot.path, name), handles, true);
        const contents = await childNames(entry, 32);
        need(contents.every(n => ['entry.private.json', 'original.log', 'retired.private.json'].includes(n) || /^\.metadata-[a-f0-9-]{36}\.tmp$/.test(n)), 'RAW_ENTRY_NAMESPACE');
        if (!await optional(path.join(entry.path, 'entry.private.json'))) { need(contents.every(n => /^\.metadata-[a-f0-9-]{36}\.tmp$/.test(n)), 'RAW_WITHOUT_ORIGIN'); continue; }
        const entryIntent = (await jsonFile(path.join(entry.path, 'entry.private.json'))).value;
        need(entryIntent.kind === 'closed-log-retirement-entry-v1' && entryIntent.intentSha256 === intentRef.sha256 && entryIntent.name === row.name
          && same(entryIntent.originalStat, row.expected), 'RAW_ENTRY_INTENT');
        if (await optional(path.join(entry.path, 'original.log'))) { need(!retired, 'MULTIPLE_RAW_ENTRIES'); retired = entry; }
      }
      if (!retired && !receipt) {
        need(entries.length < 8, 'RETIREMENT_ATTEMPT_BOUND');
        phase = 'retire'; const original = path.join(source.path, row.name); expectedStat(await fs.lstat(original, { bigint: true }), row.expected);
        preopened = await fs.open(path.join(source.anchored, row.name), constants.O_RDONLY | constants.O_NOFOLLOW); rawHandles.add(preopened);
        expectedStat(await preopened.stat({ bigint: true }), row.expected);
        ownedReadFds.set(preopened.fd, row.expected.dev + ':' + row.expected.ino);
        await processCheck(); await audit(); await sourceCheck();
        retired = await mkdir(rawRoot, row.name + '.raw-' + randomUUID(), handles, true);
        await writeOnce(retired, 'entry.private.json', { version: 1, kind: 'closed-log-retirement-entry-v1', intentSha256: intentRef.sha256,
          name: row.name, originalStat: row.expected, createdAt: new Date().toISOString(), freshOneUseNamespace: true });
        await source.check(); await retired.check(); need(!await optional(path.join(retired.path, 'original.log')), 'PREEXISTING_DESTINATION');
        expectedStat(await fs.lstat(original, { bigint: true }), row.expected); await pulse('before-rename');
        // Exclusive fresh private namespace, not kernel NOREPLACE/inode CAS.
        await fs.rename(path.join(source.anchored, row.name), path.join(retired.anchored, 'original.log'));
        await source.fd.sync(); await retired.fd.sync();
        expectedStat(await fs.lstat(path.join(retired.path, 'original.log'), { bigint: true }), row.expected, true);
        need(!await optional(original), 'INDEPENDENT_ORIGINAL_RECREATED'); await pulse('after-rename');
      }
      states.set(row.name, { retired: true, verified: Boolean(receipt) });
      let raw, rawStat, rawPath;
      if (retired) {
        rawPath = path.join(retired.path, 'original.log'); rawStat = await fs.lstat(rawPath, { bigint: true }); expectedStat(rawStat, row.expected, true);
        raw = preopened ?? await fs.open(path.join(retired.anchored, 'original.log'), constants.O_RDONLY | constants.O_NOFOLLOW); rawHandles.add(raw);
        need(signature(await raw.stat({ bigint: true })) === signature(rawStat), 'RAW_OPEN_CHANGED');
        ownedReadFds.set(raw.fd, row.expected.dev + ':' + row.expected.ino);
        identities.add(row.expected.dev + ':' + row.expected.ino);
        const retiredRef = path.join(retired.path, 'retired.private.json');
        if (await optional(retiredRef)) need(same((await jsonFile(retiredRef)).value.rawStat, stat(rawStat)), 'RETIRED_STAT_CHANGED');
        else await writeOnce(retired, 'retired.private.json', { version: 1, intentSha256: intentRef.sha256, originalStat: row.expected,
          rawStat: stat(rawStat), observedRetirementAt: new Date().toISOString(), originalIntentClockPreserved: intent.createdAt });
      } else need(receipt && !await optional(path.join(source.path, row.name)), 'RAW_MISSING_WITHOUT_VERIFIED_ARCHIVE');
      if (receipt) {
        const entry = await dir(receipt.rawEntry, handles, true);
        const original = (await jsonFile(path.join(entry.path, 'entry.private.json'))).value;
        const previous = (await jsonFile(path.join(entry.path, 'retired.private.json'))).value;
        need(original.kind === 'closed-log-retirement-entry-v1' && original.intentSha256 === intentRef.sha256 && original.name === row.name
          && same(original.originalStat, row.expected) && previous.version === 1 && previous.intentSha256 === intentRef.sha256
          && same(previous.originalStat, row.expected) && same(previous.rawStat, receipt.retiredRawStat)
          && previous.originalIntentClockPreserved === intent.createdAt && iso(previous.observedRetirementAt)
          && (!raw || retired.path === receipt.rawEntry && same(stat(rawStat), receipt.retiredRawStat)), 'RECEIPT_RAW_ORIGIN');
      }
      await processCheck(); await audit(); await sourceCheck();
      if (!receipt) {
        phase = 'gzip'; need(raw, 'RAW_REQUIRED'); let usage = await compressedUsage(archives);
        const finalized = [];
        for (const name of (await childNames(archives, 32)).filter(n => n.startsWith(row.name + '.gzip-'))) {
          const output = await dir(path.join(archives.path, name), handles, true);
          const final = await optional(path.join(output.path, 'payload.gz')), partial = await optional(path.join(output.path, 'payload.partial'));
          if (!final && !partial) continue;
          need(!(final && partial), 'AMBIGUOUS_OUTPUT');
          const attempt = (await jsonFile(path.join(output.path, 'attempt.private.json'))).value;
          need(attempt.version === 1 && attempt.intentSha256 === intentRef.sha256 && attempt.name === row.name
            && attempt.rawEntry === retired.path && same(attempt.originalStat, row.expected), 'GZIP_RECOVERY_ORIGIN');
          // Interrupted metadata admission can leave an empty scratch inode;
          // it carries no original bytes and is preserved without reuse.
          if (!final && partial.size === 0n && !await optional(path.join(output.path, 'created.private.json'))) continue;
          const created = (await jsonFile(path.join(output.path, 'created.private.json'))).value;
          need(attempt.version === 1 && attempt.intentSha256 === intentRef.sha256 && attempt.name === row.name
            && attempt.rawEntry === retired.path && same(attempt.originalStat, row.expected)
            && created.version === 1 && created.intentSha256 === intentRef.sha256 && created.rawName === row.name, 'GZIP_RECOVERY_ORIGIN');
          const leaf = final ? 'payload.gz' : 'payload.partial', present = stat(await gzipStat(path.join(output.path, leaf)));
          need(['dev', 'ino', 'uid', 'gid', 'mode', 'nlink'].every(k => present[k] === created.outputStat?.[k]), 'GZIP_RECOVERY_IDENTITY');
          let interrupted = null;
          if (leaf === 'payload.partial' && await optional(path.join(output.path, 'interrupted.private.json'))) {
            interrupted = (await jsonFile(path.join(output.path, 'interrupted.private.json'))).value;
            need(exact(interrupted, ['version', 'kind', 'intentSha256', 'name', 'originalStat', 'rawStat', 'rawSha256', 'rawBytes',
              'attemptSha256', 'createdSha256', 'partialStat', 'partialSha256', 'partialBytes', 'capturedAt']) && interrupted.version === 1
              && interrupted.kind === 'closed-log-interrupted-scratch-v1' && interrupted.intentSha256 === intentRef.sha256 && interrupted.name === row.name
              && same(interrupted.originalStat, row.expected) && same(interrupted.rawStat, stat(rawStat)) && same(interrupted.partialStat, present)
              && interrupted.attemptSha256 === sha(encode(attempt)) && interrupted.createdSha256 === sha(encode(created))
              && interrupted.rawBytes === Number(row.expected.size) && interrupted.partialBytes === Number(present.size)
              && hex(interrupted.rawSha256) && hex(interrupted.partialSha256) && iso(interrupted.capturedAt), 'INTERRUPTED_SCRATCH_ORIGIN');
            const original = await hashStream(rawStream(raw, Number(row.expected.size)), Number(row.expected.size), signal);
            const scratch = await hashStream(createReadStream(path.join(output.path, leaf)), budget, signal);
            need(original.sha256 === interrupted.rawSha256 && original.bytes === interrupted.rawBytes && scratch.sha256 === interrupted.partialSha256
              && scratch.bytes === interrupted.partialBytes && signature(await raw.stat({ bigint: true })) === signature(rawStat)
              && same(stat(await gzipStat(path.join(output.path, leaf))), present), 'INTERRUPTED_SCRATCH_CHANGED');
          }
          let proof;
          try { proof = await gzipProof(path.join(output.path, leaf), Number(row.expected.size), signal); }
          catch (e) {
            if (leaf !== 'payload.partial' || !['Z_BUF_ERROR', 'GZIP_LENGTH'].includes(e.code)) throw e;
            need(interrupted, 'INCOMPLETE_SCRATCH_UNBOUND');
            // Only captured, unchanged incomplete scratch is discarded. The
            // original remains privately retained and freshly hash verified.
            await processCheck(); await audit(); await sourceCheck(); await output.check();
            need(same(stat(await gzipStat(path.join(output.path, leaf))), present), 'INTERRUPTED_SCRATCH_CHANGED');
            await fs.unlink(path.join(output.anchored, leaf)); await output.fd.sync();
            await writeOnce(output, 'scratch-released.private.json', { version: 1, intentSha256: intentRef.sha256, name: row.name,
              interruptionSha256: sha(encode(interrupted)), releasedAt: new Date().toISOString(), originalRawUnchanged: true });
            continue;
          }
          need(same(stat(await gzipStat(path.join(output.path, leaf))), present), 'GZIP_RECOVERY_IDENTITY');
          finalized.push({ output, present, leaf, proof });
        }
        usage = await compressedUsage(archives);
        need(finalized.length <= 1, 'MULTIPLE_FINALIZED_OUTPUTS');
        if (finalized.length) {
          const { output, leaf, proof } = finalized[0]; let present = finalized[0].present;
          const original = await hashStream(rawStream(raw, Number(row.expected.size)), Number(row.expected.size), signal);
          need(original.bytes === Number(row.expected.size) && original.sha256 === proof.rawSha256
            && signature(await raw.stat({ bigint: true })) === signature(rawStat)
            && same(stat(await gzipStat(path.join(output.path, leaf))), present), 'GZIP_RECOVERY_PARITY');
          need(usage.logical <= BigInt(budget) && usage.allocated <= BigInt(budget), 'GZIP_BUDGET');
          await processCheck(); await audit(); await sourceCheck(); await output.fd.sync();
          if (leaf === 'payload.partial') {
            await pulse('before-gzip-finalize'); need(!await optional(path.join(output.path, 'payload.gz')), 'GZIP_DESTINATION_EXISTS');
            await fs.rename(path.join(output.anchored, leaf), path.join(output.anchored, 'payload.gz')); await output.fd.sync();
            present = stat(await gzipStat(path.join(output.path, 'payload.gz')));
          }
          receipt = { version: 1, kind: 'closed-log-gzip-verified-v1', intentSha256: intentRef.sha256, planSha256: args.planSha256,
            name: row.name, originalStat: row.expected, retiredRawStat: stat(rawStat), rawEntry: retired.path,
            gzipPath: path.join(output.path, 'payload.gz'), gzipStat: present,
            rawSha256: original.sha256, rawBytes: original.bytes, gzipSha256: proof.gzipSha256, gzipBytes: proof.gzipBytes,
            verifiedAt: new Date().toISOString(), independentOriginalFdAndGunzipVerified: true, globalRootDescriptorCoverageClaimed: false };
          await writeOnce(recovery, receiptName, receipt); await pulse('verified-receipt');
        }
        if (!receipt) {
        need(usage.logical < BigInt(budget) && usage.allocated < BigInt(budget), 'GZIP_BUDGET');
        const free = await fs.statfs(recovery.path, { bigint: true });
        need(free.bavail * free.bsize >= BigInt(budget) - usage.allocated + 64n * 1024n ** 2n, 'TEMP_SPACE_HEADROOM');
        need((await childNames(archives, 32)).filter(n => n.startsWith(row.name + '.gzip-')).length < 8, 'GZIP_ATTEMPT_BOUND');
        const output = await mkdir(archives, row.name + '.gzip-' + randomUUID(), handles, true);
        await writeOnce(output, 'attempt.private.json', { version: 1, intentSha256: intentRef.sha256, name: row.name,
          rawEntry: retired.path, originalStat: row.expected, createdAt: new Date().toISOString() });
        const target = path.join(output.anchored, 'payload.partial'), fd = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        const allocationReserve = Math.max(4096, Math.min(1024 * 1024, Math.floor(budget / 8)));
        need(free.bsize <= BigInt(allocationReserve), 'FILESYSTEM_BLOCK_BOUND');
        let rawBytes = 0, gzipBytes = 0, currentWrite = Promise.resolve(), compressionFailure; const rawHash = createHash('sha256');
        const available = budget - Number(usage.logical > usage.allocated ? usage.logical : usage.allocated) - allocationReserve;
        try {
          await fd.sync(); await writeOnce(output, 'created.private.json', { version: 1, intentSha256: intentRef.sha256,
            rawName: row.name, outputStat: stat(await fd.stat({ bigint: true })) });
          await pipeline(rawStream(raw, Number(row.expected.size)),
            new Transform({ transform(chunk, encoding, done) { rawBytes += chunk.length; rawHash.update(chunk); done(null, chunk); } }), createGzip(),
            new Transform({ transform(chunk, encoding, done) { gzipBytes += chunk.length;
              done(gzipBytes > available ? Object.assign(Error('Gzip budget exceeded'), { code: 'GZIP_BUDGET' }) : null, chunk); } }),
            new Writable({ highWaterMark: 64 * 1024, write(chunk, encoding, done) {
              currentWrite = (async () => { for (let at = 0; at < chunk.length;) { const r = await fd.write(chunk, at, chunk.length - at, null); need(r.bytesWritten > 0); at += r.bytesWritten; } })();
              currentWrite.then(() => done(), done);
            } }), { signal });
          await fd.sync();
        } catch (cause) {
          compressionFailure = cause;
          try {
            // Do not reuse the aborted signal for this bounded recovery
            // capture. Interruption handlers and the mutex remain owned.
            await currentWrite.catch(() => {}); await fd.sync(); await output.fd.sync();
            const before = stat(await fd.stat({ bigint: true }));
            const attempt = (await jsonFile(path.join(output.path, 'attempt.private.json'))).value;
            const created = (await jsonFile(path.join(output.path, 'created.private.json'))).value;
            const original = await hashStream(rawStream(raw, Number(row.expected.size)), Number(row.expected.size));
            const scratch = await hashStream(createReadStream(path.join(output.path, 'payload.partial')), budget);
            need(same(stat(await fd.stat({ bigint: true })), before) && same(stat(await gzipStat(path.join(output.path, 'payload.partial'))), before)
              && signature(await raw.stat({ bigint: true })) === signature(rawStat), 'INTERRUPTED_CAPTURE_CHANGED');
            await writeOnce(output, 'interrupted.private.json', { version: 1, kind: 'closed-log-interrupted-scratch-v1', intentSha256: intentRef.sha256,
              name: row.name, originalStat: row.expected, rawStat: stat(rawStat), rawSha256: original.sha256, rawBytes: original.bytes,
              attemptSha256: sha(encode(attempt)), createdSha256: sha(encode(created)), partialStat: before,
              partialSha256: scratch.sha256, partialBytes: scratch.bytes, capturedAt: new Date().toISOString() });
          } catch { /* Unbound partials remain intact and cannot be discarded on retry. */ }
          throw cause;
        } finally {
          try { await fd.close(); await output.fd.sync(); } catch (e) { if (!compressionFailure) throw e; }
        }
        need(rawBytes === Number(row.expected.size) && signature(await raw.stat({ bigint: true })) === signature(rawStat), 'RAW_CHANGED_DURING_GZIP');
        const firstSha = rawHash.digest('hex'), independentRaw = await hashStream(rawStream(raw, Number(row.expected.size)), Number(row.expected.size), signal);
        need(independentRaw.bytes === Number(row.expected.size) && independentRaw.sha256 === firstSha, 'RAW_HASH_CHANGED');
        const proof = await gzipProof(path.join(output.path, 'payload.partial'), Number(row.expected.size), signal);
        need(proof.rawSha256 === firstSha && signature(await raw.stat({ bigint: true })) === signature(rawStat), 'GZIP_PARITY');
        const occupied = await compressedUsage(archives); need(occupied.logical <= BigInt(budget) && occupied.allocated <= BigInt(budget), 'GZIP_BUDGET');
        await processCheck(); await audit(); await sourceCheck(); await pulse('before-gzip-finalize');
        need(!await optional(path.join(output.path, 'payload.gz')), 'GZIP_DESTINATION_EXISTS');
        await fs.rename(target, path.join(output.anchored, 'payload.gz')); await output.fd.sync();
        receipt = { version: 1, kind: 'closed-log-gzip-verified-v1', intentSha256: intentRef.sha256, planSha256: args.planSha256,
          name: row.name, originalStat: row.expected, retiredRawStat: stat(rawStat), rawEntry: retired.path,
          gzipPath: path.join(output.path, 'payload.gz'), gzipStat: stat(await gzipStat(path.join(output.path, 'payload.gz'))),
          rawSha256: firstSha, rawBytes, gzipSha256: proof.gzipSha256, gzipBytes: proof.gzipBytes, verifiedAt: new Date().toISOString(),
          independentOriginalFdAndGunzipVerified: true, globalRootDescriptorCoverageClaimed: false };
        await writeOnce(recovery, receiptName, receipt); await pulse('verified-receipt');
        }
      }
      phase = 'archive-readback'; const beforeGzip = await gzipStat(receipt.gzipPath); need(same(stat(beforeGzip), receipt.gzipStat), 'ARCHIVE_STAT_CHANGED');
      const verified = await gzipProof(receipt.gzipPath, Number(row.expected.size), signal);
      need(verified.rawSha256 === receipt.rawSha256 && verified.gzipSha256 === receipt.gzipSha256 && verified.gzipBytes === receipt.gzipBytes
        && same(stat(await gzipStat(receipt.gzipPath)), receipt.gzipStat), 'ARCHIVE_BYTES_CHANGED');
      const readyName = row.name + '.unlink-ready.private.json', readyPath = path.join(recovery.path, readyName);
      const releasedName = row.name + '.released.private.json', releasedPath = path.join(recovery.path, releasedName);
      const validateReady = value => {
        need(exact(value, ['version', 'kind', 'intentSha256', 'name', 'verifiedReceiptSha256', 'rawStat', 'checkedAt', 'ownRawDescriptorClosed',
          'descriptorCensus', 'descriptorCensusSha256', 'originalProcessesSha256']) && value.version === 1
          && value.kind === 'closed-log-raw-unlink-ready-v1' && value.intentSha256 === intentRef.sha256 && value.name === row.name
          && value.verifiedReceiptSha256 === sha(encode(receipt)) && same(value.rawStat, receipt.retiredRawStat)
          && value.ownRawDescriptorClosed === true && value.originalProcessesSha256 === sha(encode(initial.core))
          && value.descriptorCensusSha256 === sha(encode(value.descriptorCensus)) && value.descriptorCensus?.version === 1
          && value.descriptorCensus.otherSelectedDescriptors === 0 && value.descriptorCensus.globalRootDescriptorCoverageClaimed === false
          && Array.isArray(value.descriptorCensus.selectedIdentities) && value.descriptorCensus.selectedIdentities.includes(row.expected.dev + ':' + row.expected.ino)
          && iso(value.checkedAt) && iso(value.descriptorCensus.checkedAt) && Date.parse(value.checkedAt) >= Date.parse(value.descriptorCensus.checkedAt)
          && Date.parse(value.checkedAt) >= Date.parse(receipt.verifiedAt), 'UNLINK_INTENT'); return value;
      };
      const savedReady = await optional(readyPath) ? validateReady((await jsonFile(readyPath)).value) : null;
      let released = await optional(releasedPath) ? (await jsonFile(releasedPath)).value : null;
      if (released) need(!raw && savedReady && exact(released, ['version', 'kind', 'intentSha256', 'name', 'verifiedReceiptSha256', 'observedAt',
        'originalVerifiedAt', 'rawPathAbsent', 'archiveByteParityVerified']) && released.version === 1 && released.kind === 'closed-log-raw-released-v1'
        && released.intentSha256 === intentRef.sha256 && released.name === row.name && released.verifiedReceiptSha256 === sha(encode(receipt))
        && released.originalVerifiedAt === receipt.verifiedAt && released.rawPathAbsent === true && released.archiveByteParityVerified === true
        && iso(released.observedAt) && Date.parse(released.observedAt) >= Date.parse(savedReady.checkedAt), 'RELEASED_EVIDENCE');
      if (raw) {
        const actualRaw = await hashStream(rawStream(raw, Number(row.expected.size)), Number(row.expected.size), signal);
        need(actualRaw.bytes === Number(row.expected.size) && actualRaw.sha256 === verified.rawSha256, 'ACTUAL_RAW_ARCHIVE_PARITY');
        need(signature(await raw.stat({ bigint: true })) === signature(rawStat), 'RAW_CHANGED');
        await processCheck(); await audit(); await sourceCheck(); await closeRaw(raw); raw = null;
        await processCheck(); await audit(); await sourceCheck();
        need(signature(await fs.lstat(rawPath, { bigint: true })) === signature(rawStat), 'RAW_CHANGED');
        const ready = { version: 1, kind: 'closed-log-raw-unlink-ready-v1', intentSha256: intentRef.sha256, name: row.name,
          verifiedReceiptSha256: sha(encode(receipt)), rawStat: stat(rawStat), checkedAt: new Date().toISOString(), ownRawDescriptorClosed: true,
          descriptorCensus: censusProofs.at(-1), descriptorCensusSha256: sha(encode(censusProofs.at(-1))), originalProcessesSha256: sha(encode(initial.core)) };
        if (!savedReady) { validateReady(ready); await writeOnce(recovery, readyName, ready); }
        phase = 'raw-unlink'; await pulse('before-raw-unlink'); await processCheck(); await audit(); await sourceCheck();
        need(signature(await fs.lstat(rawPath, { bigint: true })) === signature(rawStat)
          && same(stat(await gzipStat(receipt.gzipPath)), receipt.gzipStat), 'FINAL_RAW_ARCHIVE_STAT');
        await fs.unlink(path.join(retired.anchored, 'original.log')); await retired.fd.sync(); await pulse('after-raw-unlink');
      } else need(savedReady, 'MISSING_RAW_RELEASE_INTENT');
      states.set(row.name, { retired: true, verified: true });
      if (!released) await writeOnce(recovery, releasedName, { version: 1, kind: 'closed-log-raw-released-v1',
        intentSha256: intentRef.sha256, name: row.name, verifiedReceiptSha256: sha(encode(receipt)), observedAt: new Date().toISOString(),
        originalVerifiedAt: receipt.verifiedAt, rawPathAbsent: true, archiveByteParityVerified: true });
      identities.delete(row.expected.dev + ':' + row.expected.ino);
      receipts.push(receipt);
    }
    phase = 'complete-readback'; await processCheck(); await audit(); await sourceCheck();
    const available = await fs.statfs(recovery.path, { bigint: true }), availableBytes = available.bavail * available.bsize;
    const metadata = { version: 1, kind: 'three-closed-log-compaction-result-v1', applicationCommit: APP, planSha256: args.planSha256,
      intentSha256: intentRef.sha256, originalIntentCreatedAt: intent.createdAt, completedAt: new Date().toISOString(), receipts,
      descriptorCensuses: censusProofs, originalProcesses: initial.core, gzipBudgetBytes: budget,
      availableBytes: String(availableBytes), oneGiBSeedReserveBytes: '1073741824', additionalDerivedReserveBytes: '268435456',
      spaceTargetBytes: '1342177280', meetsSpaceTarget: availableBytes >= 1342177280n, seedReadyClaimed: false,
      sourceRecordsChanged: false, workersChanged: false, routingChanged: false, globalRootDescriptorCoverageClaimed: false,
      trustedOwnerNamespaceExclusion: true, kernelNoReplaceOrInodeCasClaimed: false,
      fullHostPlanRead: true, fullHostPlanBytesExported: planRaw.length <= 128 * 1024,
      fullHostPlan: planRaw.length <= 128 * 1024 ? { sha256: args.planSha256, bytes: planRaw.length, dataBase64: planRaw.toString('base64') } : null };
    let bytes = encode(metadata), packed = gzipSync(bytes);
    if (bytes.length > 384 * 1024 || packed.length > 40 * 1024) { metadata.fullHostPlan = null; metadata.fullHostPlanBytesExported = false;
      bytes = encode(metadata); packed = gzipSync(bytes); }
    need(bytes.length <= 384 * 1024 && packed.length <= 40 * 1024, 'RESULT_BOUND');
    await writeOnce(recovery, 'completion-' + sha(bytes) + '.private.json', bytes);
    const capsule = seal(key, { version: 1, kind: 'supabase-closed-log-compaction-capsule-v1', applicationCommit: APP,
      metadataSha256: sha(bytes), metadataGzipSha256: sha(packed), metadataGzipBase64: packed.toString('base64') });
    await processCheck(); signal.throwIfAborted();
    return { status: 'supabase-closed-logs-archived', operation: args.operation, applicationCommit: APP, planSha256: args.planSha256,
      intentSha256: intentRef.sha256, metadataSha256: sha(bytes), recipientSha256: sha(args.recipientPublicKey), capsule,
      archivedLogs: receipts.length, rawFilesUnlinked: receipts.length, logBytesPreserved: true, gzipParityVerified: true,
      workersChanged: false, routingChanged: false, applicationDatabaseConnections: 0, networkRequests: 0 };
  } catch (cause) {
    outwardFailure = stoppedFailure(phase, cause);
    throw outwardFailure;
  } finally {
    const failures = [];
    const failed = (kind, error) => failures.push({ kind, code: typeof error?.code === 'string' ? error.code.slice(0, 128) : null });
    for (const fd of [...rawHandles]) try { await closeRaw(fd); } catch (e) { failed('raw-close', e); }
    for (const fd of handles.reverse()) try { await fd.close(); } catch (e) { failed('directory-close', e); }
    try { await lock?.release(); } catch (e) { failed('operator-lock-release', e); }
    const interrupted = signal.aborted; for (const event of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.off(event, interrupt);
    if (failures.length && outwardFailure) Object.defineProperties(outwardFailure, {
      cleanupFailed: { value: true }, cleanupFailures: { value: failures },
    });
    else if (failures.length) throw stoppedFailure('cleanup', Error('Owned cleanup did not complete'), failures);
    if (interrupted && !outwardFailure) throw stoppedFailure('interrupted', Error('Log compaction interrupted'));
  }
}
