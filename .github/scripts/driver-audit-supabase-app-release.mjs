import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

const exec = promisify(execFile);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (condition, message = 'The guarded app reader release was stopped') => { if (!condition) throw Error(message); };
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const uid = () => process.getuid();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const signature = s => [s.dev, s.ino, s.uid, s.gid, s.mode, s.nlink, s.size, s.mtimeMs, s.ctimeMs].join(':');
const safeRelative = name => typeof name === 'string' && name.length <= 400 && !name.includes('\\')
  && name.split('/').every(part => /^[A-Za-z0-9_.-]+$/.test(part) && !['.', '..'].includes(part));
const appServices = new Set(['driverAuditCollectorReadCache', 'driverAuditDataBackend', 'driverAuditDirectImport',
  'driverAuditHttp', 'driverAuditIntegration', 'driverAuditPhotoRecovery', 'driverAuditPollProgress', 'driverAuditSource',
  'driverAuditSourceDeployment', 'driverAuditSourceQualification', 'driverAuditSourceStage', 'driverAuditSpacesArchive',
  'driverAuditSupabaseAppBackend', 'driverAuditSupabaseAppProgress', 'driverAuditSupabaseArchive', 'driverAuditSupabaseReplica',
  'driverAuditSupabaseSync', 'driverAuditSupabaseTransfer', 'driverAuditSync', 'driverAuditSyncStatus']);
const appScripts = new Set(['driverAuditHttp', 'driverAuditOffHostWorker', 'driverAuditQualificationChild', 'driverAuditSource',
  'driverAuditSourceDeploy', 'driverAuditSourceQualify', 'driverAuditSourceStage', 'driverAuditSync']);
const vendorFiles = new Set(['integration/cloud/preview-gps.mjs', 'integration/cloud/preview-order-timing.mjs',
  'integration/cloud/preview-runtime.mjs', 'integration/cloud/remote-preview-package.mjs',
  'integration/cloud/cloud-http.mjs', 'integration/cloud/preview-source-history.mjs',
  'integration/hosted/supabase-archive.mjs', 'runtime-manifest.json']);
function allowedChange(name) {
  if (!safeRelative(name)) return false;
  if (/^server\/services\/driverAudit[A-Za-z0-9]+\.test\.js$/.test(name)) return true;
  const service = /^server\/services\/(.+?)(?:\.test)?\.js$/.exec(name);
  const script = /^server\/scripts\/(.+)\.js$/.exec(name);
  return service ? appServices.has(service[1]) : script ? appScripts.has(script[1])
    : name.startsWith('server/vendor/driver-audits/') ? vendorFiles.has(name.slice('server/vendor/driver-audits/'.length))
      : name === 'AGENTS.md' || name === 'server/migrations/20261117103823_driver_audit_app_poll_progress.sql'
        || /^docs\/driver-audits\/[A-Za-z0-9-]+\.md$/.test(name)
        || ['docs/traceability/ROUTES.md', 'docs/traceability/routes.json'].includes(name)
        || /^\.github\/scripts\/driver-audit-[A-Za-z0-9.-]+\.mjs$/.test(name)
        || ['.github/workflows/driver-audit-native-handoff.yml', '.github/workflows/deploy-digitalocean.yml'].includes(name);
}

export function validateAppReaderReleaseRequest(value) {
  check(value && typeof value === 'object' && !Array.isArray(value)
    && same(Object.keys(value).sort(), ['version', 'expectedOldSha', 'selectedSha', 'reportHeadSha256', 'generation'].sort())
    && value.version === 1 && commit(value.expectedOldSha) && commit(value.selectedSha)
    && value.expectedOldSha !== value.selectedSha && digest(value.reportHeadSha256) && digest(value.generation),
  'Exact reviewed app and report identities are required');
  return Object.freeze({ version: 1, expectedOldSha: value.expectedOldSha, selectedSha: value.selectedSha,
    reportHeadSha256: value.reportHeadSha256, generation: value.generation });
}

async function directory(name, { privateMode = false } = {}) {
  const info = await fs.lstat(name);
  check(info.isDirectory() && !info.isSymbolicLink() && info.uid === uid()
    && !(info.mode & 0o002) && (!privateMode || !(info.mode & 0o077)) && !(info.mode & 0o7000) && await fs.realpath(name) === name,
  'An owned canonical release directory is required');
  return info;
}
async function privateDirectory(name) {
  const parent = path.dirname(name);
  await directory(parent);
  try { await fs.mkdir(name, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  await directory(name, { privateMode: true });
}
async function read(name, maximum = 1024 * 1024, { privateMode = false, optional = false } = {}) {
  let info;
  try { info = await fs.lstat(name); } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  check(info.isFile() && !info.isSymbolicLink() && info.uid === uid() && info.nlink === 1 && info.size <= maximum
    && !(info.mode & 0o7000) && (!privateMode || !(info.mode & 0o077)) && await fs.realpath(name) === name,
  'An owned regular release input is required');
  const handle = await fs.open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    check(signature(await handle.stat()) === signature(info));
    const bytes = await handle.readFile();
    check(bytes.length === info.size && signature(await handle.stat()) === signature(info)
      && signature(await fs.lstat(name)) === signature(info) && await fs.realpath(name) === name,
    'A release input changed during reading');
    return { bytes, sha256: sha(bytes), signature: signature(info), mode: info.mode & 0o777 };
  } finally { await handle.close(); }
}
async function atomic(name, bytes, mode = 0o600) {
  const parentName = path.dirname(name), info = await directory(parentName);
  const parent = await fs.open(parentName, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const identity = value => [value.dev, value.ino, value.uid, value.gid, value.mode].join(':');
  const recheck = async () => check(identity(await parent.stat()) === identity(info)
    && identity(await directory(parentName)) === identity(info), 'The release directory changed');
  const base = process.platform === 'linux' ? '/proc/self/fd/' + parent.fd : parentName;
  const temporary = path.join(base, '.reader-release-' + randomUUID() + '.tmp');
  try {
    await recheck();
    const file = await fs.open(temporary, 'wx', mode);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await recheck();
    await fs.rename(temporary, path.join(base, path.basename(name)));
    await parent.sync(); await recheck();
  } finally { try { await fs.rm(temporary, { force: true }); } finally { await parent.close(); } }
}
async function immutable(name, bytes) {
  const prior = await read(name, 16 * 1024 ** 2, { privateMode: true, optional: true });
  if (prior) { check(prior.sha256 === sha(bytes), 'A private release receipt conflicts'); return; }
  // All callers hold the existing operator exclusion in this owner-private
  // namespace. Finalize complete, fsynced bytes rather than a partial receipt.
  await atomic(name, bytes);
}
const git = async (root, args, maximum = 4 * 1024 ** 2) => (await exec('git', ['--no-optional-locks',
  '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', root, ...args],
{ timeout: 30000, maxBuffer: maximum, encoding: 'buffer' })).stdout;
const gitText = async (root, args) => (await git(root, args)).toString('utf8').trim();

async function inventory(root, { contents = false } = {}) {
  const output = [], pending = [''];
  while (pending.length) {
    const relative = pending.pop(), absolute = path.join(root, relative), info = await fs.lstat(absolute);
    check(info.uid === uid() && (info.isFile() || info.isDirectory() || info.isSymbolicLink()), 'Unexpected preserved application path');
    if (info.isSymbolicLink()) {
      const target = await fs.readlink(absolute), resolved = path.resolve(path.dirname(absolute), target);
      check(resolved.startsWith(root + path.sep), 'An installed dependency links outside its retained tree');
      output.push([relative, signature(info), target]);
      continue;
    }
    if (info.isDirectory()) {
      for (const name of (await fs.readdir(absolute)).sort().reverse()) pending.push(path.join(relative, name));
    } else output.push([relative, signature(info), contents ? sha(await fs.readFile(absolute)) : null]);
    check(output.length + pending.length < 60000, 'Preserved application inventory is too large');
  }
  return sha(JSON.stringify(output));
}
function registration(rows, root, { online = true } = {}) {
  const entries = rows.filter(row => row.name === 'matter-delivery-api');
  check(entries.length === 1, 'One existing business API is required');
  const api = entries[0], env = api.pm2_env;
  check((!online || api.pid > 0 && env?.status === 'online') && env.pm_cwd === root
    && ['/usr/bin/npm', '/usr/share/nodejs/npm/bin/npm-cli.js', '/usr/lib/node_modules/npm/bin/npm-cli.js',
      '/usr/local/lib/node_modules/npm/bin/npm-cli.js'].includes(env.pm_exec_path)
    && same(env.args, ['start', '--prefix', 'server']), 'The existing API registration differs');
  const held = rows.filter(row => ['matter-driver-audit-source', 'matter-driver-audit-sync', 'matter-driver-reports-api'].includes(row.name));
  check(held.every(row => row.pid === 0 && row.pm2_env?.status === 'stopped'), 'Report workers must remain held');
  return { api: { name: api.name, cwd: env.pm_cwd, script: env.pm_exec_path, args: env.args },
    others: rows.filter(row => row.name !== api.name).map(row => [row.name, row.pid, row.pm2_env?.status, row.pm2_env?.pm_cwd, row.pm2_env?.pm_exec_path]).sort() };
}
async function systemNpmIdentity() {
  const filename = await fs.realpath('/usr/bin/npm');
  check(['/usr/share/nodejs/npm/bin/npm-cli.js', '/usr/lib/node_modules/npm/bin/npm-cli.js',
    '/usr/local/lib/node_modules/npm/bin/npm-cli.js'].includes(filename), 'The existing system NPM wrapper differs');
  const opened = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await opened.stat();
    check(info.isFile() && info.uid === 0 && !(info.mode & 0o022) && info.size <= 512 * 1024);
    const bytes = await opened.readFile();
    check(signature(await opened.stat()) === signature(info) && signature(await fs.lstat(filename)) === signature(info)
      && await fs.realpath('/usr/bin/npm') === filename);
    return signature(info) + ':' + sha(bytes);
  } finally { await opened.close(); }
}
async function defaultProcesses() {
  const { stdout } = await exec('pm2', ['jlist'], { timeout: 10000, maxBuffer: 8 * 1024 ** 2 });
  const rows = JSON.parse(stdout); check(Array.isArray(rows)); return rows;
}
async function defaultRestart() { await exec('pm2', ['restart', 'matter-delivery-api'], { timeout: 30000, maxBuffer: 2 * 1024 ** 2 }); }
async function defaultHealth({ origin }) {
  let last;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await fetch('http://127.0.0.1:5000/api/health', { signal: AbortSignal.timeout(3000) });
      check(response.ok && (await response.json()).database === 'connected', 'Business API health is unavailable');
      const denied = await fetch('http://127.0.0.1:5000/api/reporting/status', {
        headers: { host: new URL(origin).host }, signal: AbortSignal.timeout(5000) });
      check(denied.status === 401, 'Signed-out report access must be denied');
      return;
    } catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  throw last;
}
function settings(bytes, cache) {
  const values = { DRIVER_AUDIT_ENABLED: '1', DRIVER_AUDIT_IMPORT_ENABLED: '0', DRIVER_AUDIT_SERVING_STORE: 'supabase',
    DRIVER_AUDIT_REPLICA_GC_ENABLED: '0', MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY: cache };
  let text = bytes.toString('utf8'); check(Buffer.from(text).equals(bytes), 'Invalid environment encoding');
  for (const [key, value] of Object.entries(values)) {
    const regex = new RegExp('^(?:export[ \\t]+)?' + key + '[ \\t]*=.*$', 'gm');
    check([...text.matchAll(regex)].length <= 1, 'Duplicate report configuration');
    const line = key + '=' + JSON.stringify(value);
    text = regex.test(text) ? text.replace(regex, line) : text + (text.endsWith('\n') ? '' : '\n') + line + '\n';
  }
  return Buffer.from(text);
}
async function stageServer(root, selected, target) {
  const lines = (await git(root, ['ls-tree', '-rl', selected, '--', 'server'])).toString('utf8').trim().split('\n');
  let total = 0;
  for (const line of lines) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\s+(\d+)\t(server\/.+)$/.exec(line);
    check(match && safeRelative(match[4]) && (total += Number(match[3])) <= 32 * 1024 ** 2,
      'The reviewed server source tree exceeds its scope');
    const output = path.join(target, match[4]);
    await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
    await fs.writeFile(output, await git(root, ['cat-file', 'blob', match[2]], 4 * 1024 ** 2), { flag: 'wx', mode: 0o600 });
  }
  await fs.symlink(path.join(root, 'server/node_modules'), path.join(target, 'server/node_modules'), 'dir');
}

export async function planAppReaderTransfer({ descriptor, cacheDirectory, usage, freeBytes }) {
  const core = ['publication.private.json', 'identities.private.json', 'maps.private.json', 'gps-index.private.json.gz',
    'preview-read-view.private.json.gz', 'renderer.private.html', 'build.private.json', 'browser-data.private.json.gz',
    'browser-data.private.br', 'corrections.private.json', 'release-gps-availability.private.json',
    'release-gps-availability.private.json.gz', 'case-decisions.private.json', 'photo-prime.private.json', 'preview-photo-bindings.private.json'];
  const missing = new Map();
  for (const name of core) for (const chunk of descriptor.files[name]?.chunks ?? []) {
    check(digest(chunk.sha256) && Number.isSafeInteger(chunk.size) && chunk.size > 0 && chunk.size <= 8 * 1024 ** 2);
    check(!missing.has(chunk.sha256) || missing.get(chunk.sha256) === chunk.size, 'Conflicting selected core chunks');
    const cached = await read(path.join(cacheDirectory, chunk.sha256 + '.gz'), chunk.size, { privateMode: true, optional: true }).catch(() => null);
    if (!cached || cached.bytes.length !== chunk.size || cached.sha256 !== chunk.sha256) missing.set(chunk.sha256, chunk.size);
  }
  const remoteBytesRequired = [...missing.values()].reduce((a, b) => a + b, 0);
  const availableTransferBytes = Math.min(...[usage?.month, usage?.day].map(period => {
    check(period && ['limitBytes', 'usedBytes', 'reservedBytes'].every(key => Number.isSafeInteger(period[key]) && period[key] >= 0));
    return period.limitBytes - period.usedBytes - period.reservedBytes;
  }));
  check(Number.isSafeInteger(freeBytes) && freeBytes >= 0);
  const coldLoads = freeBytes >= 1024 ** 3 + remoteBytesRequired ? 1 : 2;
  const requiredBytes = remoteBytesRequired * coldLoads + 2 * 1024 ** 2;
  if (availableTransferBytes < requiredBytes) throw Object.assign(Error('The remaining standard transfer allowance cannot admit the cold reader'),
    { code: 'APP_READER_COLD_BUDGET', requiredBytes, availableBytes: availableTransferBytes });
  return { remoteBytesRequired, availableTransferBytes, coldLoads, requiredBytes };
}

export function verifyAppReaderHistoryLanding({ status, cacheControl, body }) {
  const directives = typeof cacheControl === 'string' ? cacheControl.split(',').map(value => value.trim().toLowerCase()) : [];
  check(status === 200 && directives.includes('private') && directives.includes('no-store') && !directives.includes('public')
    && typeof body === 'string' && body.includes('Saved source assessments'), 'The authenticated source-history landing page differs');
  return true;
}

export async function preflightAppReader({ selectedRoot, env, expected, cacheDirectory, signal }) {
  const load = name => import(pathToFileURL(path.join(selectedRoot, 'server', name)).href);
  const [{ createDriverAuditSupabaseAppBackend }, { createCloudState }, { createDriverAuditSupabaseReplica },
    { readManifestBytes }, { createDriverAuditIntegration }, { createAutomaticHostedPreview }] = await Promise.all([
    load('services/driverAuditSupabaseAppBackend.js'), load('vendor/driver-audits/integration/cloud/cloud-state.mjs'),
    load('services/driverAuditSupabaseReplica.js'), load('vendor/driver-audits/integration/cloud/repository.mjs'),
    load('services/driverAuditIntegration.js'),
    load('vendor/driver-audits/integration/cloud/automatic-hosted-preview.mjs'),
  ]);
  const backend = await createDriverAuditSupabaseAppBackend({ env: { ...env, DRIVER_AUDIT_EXECUTION_HOST: 'sidi', DRIVER_AUDIT_DATA_STORE: 'supabase' },
    fetchImpl: (url, options) => fetch(url, { ...options, signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal }) });
  await backend.archive.assertPrivate();
  const state = createCloudState({ rpc: backend.rpcForResponseLimit(768 * 1024) });
  const replica = createDriverAuditSupabaseReplica({ state, archive: backend.archive });
  const head = await replica.head();
  check(head?.sourceBodySha256 === expected.reportHeadSha256 && head.generation === expected.generation,
    'The selected Supabase report does not match');
  const descriptor = JSON.parse(await readManifestBytes(backend.archive, head.descriptor, { maxBytes: 8 * 1024 ** 2 }));
  check(descriptor.sourceManifestSha256 === head.servingPackage.manifestSha256
    && descriptor.generation === head.generation && descriptor.reportHash === head.reportHash, 'Selected report descriptor differs');
  const usage = await backend.readTransferUsage();
  // With less than the existing cache reserve, preflight RAM cannot make the
  // restarted API's second cold load free. Both loads must fit the real cap.
  const disk = await fs.statfs(cacheDirectory);
  const plan = await planAppReaderTransfer({ descriptor, cacheDirectory, usage, freeBytes: disk.bavail * disk.bsize });
  const privateSession = { actor: { id: 'private-release-preflight', email: 'preflight@example.invalid', role: 'viewer' }, csrf: '0'.repeat(64) };
  let loaded;
  const integration = createDriverAuditIntegration({ env, db: () => { throw Error('Report preflight must not open MongoDB'); },
    dependencies: { backend, createCoordinator: options => createAutomaticHostedPreview({ ...options,
      async loadPackage(input) { loaded = await options.loadPackage(input); return loaded; } }),
    auth: { authenticate: async value => { if (value !== 'private-release-preflight') throw Object.assign(Error('Sign in'), { status: 401 }); return privateSession; }, csrfMatches: () => false } } });
  check(await integration.prewarm(), 'The selected report could not prewarm');
  // Core bytes are read by the actual immutable package loader. A named GPS
  // projection and photo exercise real staff routes without issuing a staff JWT.
  check(loaded, 'The actual app reader did not retain a verified package');
  const view = JSON.parse(gunzipSync(loaded.read('preview-read-view.private.json.gz')));
  const index = JSON.parse(gunzipSync(loaded.read('gps-index.private.json.gz'), { maxOutputLength: 256 * 1024 ** 2 }));
  const gps = view.gpsRows.find(row => row?.key && row.assessmentHash
    && (index.records?.[row.key]?.evidenceFile || index.records?.[row.key]?.evidenceResult));
  const photo = view.photos.find(row => Array.isArray(row) && digest(row[1]));
  check(gps && photo, 'Named original GPS and photo evidence are required');
  const server = createServer((req, res) => integration(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const [route, key] of [['gps-evidence', gps.key], ['photo/image', photo[0]]]) {
      const query = new URLSearchParams({ record: key, snapshot: head.reportHash });
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/reporting/' + route + '?' + query,
        { headers: { host: new URL(env.DRIVER_AUDIT_ORIGIN).host, cookie: 'private-release-preflight' }, signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
      check(response.ok, 'Named saved report evidence is unavailable');
      const bytes = Buffer.from(await response.arrayBuffer());
      check(bytes.length > 0 && bytes.length <= 16 * 1024 ** 2);
      if (route === 'photo/image') check(sha(bytes) === photo[1], 'Named original photo bytes differ');
      else {
        const value = JSON.parse(bytes), original = index.records[key];
        check(value.recordKey === key && value.assessmentHash === gps.assessmentHash && value.status === 'ready'
          && value.gpsEvidence?.versionId === (original.evidenceSummary ?? original.evidenceResult).versionId,
        'Named GPS record differs');
      }
    }
    const history = await fetch('http://127.0.0.1:' + server.address().port + '/api/reporting/history-archive',
      { headers: { host: new URL(env.DRIVER_AUDIT_ORIGIN).host, cookie: 'private-release-preflight' }, signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    verifyAppReaderHistoryLanding({ status: history.status, cacheControl: history.headers.get('cache-control'), body: await history.text() });
  } finally { await new Promise(resolve => server.close(resolve)); }
  const fresh = await replica.head();
  check(fresh.sourceBodySha256 === head.sourceBodySha256, 'Supabase report advanced during preflight');
  const remaining = await backend.readTransferUsage();
  const availableAfter = Math.min(...[remaining.month, remaining.day].map(period => period.limitBytes - period.usedBytes - period.reservedBytes));
  const startupBytes = (plan.coldLoads === 2 ? plan.remoteBytesRequired : 0) + 2 * 1024 ** 2;
  if (!Number.isSafeInteger(availableAfter) || availableAfter < startupBytes) throw Object.assign(
    Error('The remaining standard transfer allowance cannot admit API startup'),
    { code: 'APP_READER_COLD_BUDGET', requiredBytes: startupBytes, availableBytes: availableAfter });
  return { reportHeadSha256: head.sourceBodySha256, generation: head.generation, prewarmed: true,
    namedEvidenceVerified: true, ...plan };
}

export async function runAppReaderPreflightChild(input, { moduleUrl = import.meta.url, signal } = {}) {
  check(typeof moduleUrl === 'string' && moduleUrl.length < 100 * 1024);
  signal?.throwIfAborted();
  const body = Buffer.from(JSON.stringify(input)); check(body.length <= 1024 * 1024);
  const driver = `
    const stop=new AbortController();const cancel=()=>stop.abort(Error('Reader preflight stopped'));
    for(const name of ['SIGTERM','SIGINT','SIGHUP'])process.on(name,cancel);
    try{
      let bytes=0,parts=[];for await(const part of process.stdin){bytes+=part.length;if(bytes>1048576)throw Error('Input bound');parts.push(part);}
      const input=JSON.parse(Buffer.concat(parts));
      const module=await import(${JSON.stringify(moduleUrl)});
      const result=await module.preflightAppReader({...input,signal:stop.signal});
      stop.signal.throwIfAborted();console.log(JSON.stringify({ok:true,result}));
    }catch(error){console.log(JSON.stringify({ok:false,code:error.code==='APP_READER_COLD_BUDGET'?error.code:'APP_READER_PREFLIGHT',
      ...(error.code==='APP_READER_COLD_BUDGET'?{requiredBytes:error.requiredBytes,availableBytes:error.availableBytes}:{})}));process.exitCode=1;}
    finally{for(const name of ['SIGTERM','SIGINT','SIGHUP'])process.removeListener(name,cancel);}
  `;
  const env = Object.fromEntries(['HOME', 'LANG', 'LC_ALL', 'TZ'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=1024', '--input-type=module', '-e', driver],
      { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', length = 0, forced, cause;
    const timer = setTimeout(() => { cause = Error('Reader preflight exceeded its bound'); child.kill('SIGTERM');
      forced = setTimeout(() => child.kill('SIGKILL'), 10000); }, 120000);
    const abort = () => { cause = signal.reason; child.kill('SIGTERM'); forced ??= setTimeout(() => child.kill('SIGKILL'), 10000); };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', part => { length += part.length; if (length > 64 * 1024) { cause = Error('Reader preflight output exceeded its bound'); child.kill('SIGKILL'); } else output += part; });
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.once('error', error => { cause = error; });
    child.once('close', code => {
      clearTimeout(timer); clearTimeout(forced); signal?.removeEventListener('abort', abort);
      if (cause) return reject(cause);
      try {
        const result = JSON.parse(output);
        if (code !== 0 || !result.ok) throw Object.assign(Error('The selected report preflight stopped'),
          result.code === 'APP_READER_COLD_BUDGET' ? { code: result.code, requiredBytes: result.requiredBytes, availableBytes: result.availableBytes } : {});
        resolve(result.result);
      } catch (error) { reject(error); }
    });
    child.stdin.end(body);
    if (signal?.aborted) abort();
  });
}

export async function releaseSupabaseAppReader({ appRoot, request, apply = true, dependencies = {}, signal } = {}) {
  request = validateAppReaderReleaseRequest(request);
  check(typeof apply === 'boolean' && path.isAbsolute(appRoot ?? '') && path.resolve(appRoot) === appRoot);
  await directory(appRoot); await directory(path.join(appRoot, 'server'));
  const processes = dependencies.inspectProcesses ?? defaultProcesses, restart = dependencies.restart ?? defaultRestart;
  const health = dependencies.verifyHealth ?? defaultHealth, preflight = dependencies.preflight
    ?? (async input => {
      const memory = /\bMemAvailable:\s+(\d+) kB/.exec(await fs.readFile('/proc/meminfo', 'utf8'));
      check(memory && Number(memory[1]) * 1024 >= 1280 * 1024 ** 2,
        'The existing app must retain enough memory for the bounded reader preflight');
      const { signal, ...payload } = input;
      return runAppReaderPreflightChild(payload, { signal });
    });
  const stop = new AbortController(), cancel = () => { if (!stop.signal.aborted) stop.abort(Error('App reader release stopped')); };
  signal?.addEventListener('abort', cancel);
  if (signal?.aborted) cancel();
  for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(name, cancel);
  const unlisten = () => {
    for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.removeListener(name, cancel);
    signal?.removeEventListener('abort', cancel);
  };
  const privateRoot = path.join(appRoot, 'server/.private');
  const controls = path.join(privateRoot, 'driver-report-app-reader-releases');
  const identity = sha(JSON.stringify(request)), receiptRoot = path.join(controls, identity);
  let lock, changedCode = false, changedEnv = false, codeAttempted = false, envAttempted = false;
  let envFile, originalEnv, nextEnv, beforeRegistration, staged, outcome, failure;
  const rollback = async () => {
    check(same(registration(await processes(), appRoot, { online: false }), beforeRegistration), 'Rollback process identity changed');
    const actualCommit = await gitText(appRoot, ['rev-parse', 'HEAD']);
    check([request.expectedOldSha, request.selectedSha].includes(actualCommit)
      && !(await gitText(appRoot, ['diff', '--name-only', 'HEAD'])), 'Rollback preserves unexpected code changes');
    const actualEnv = await read(envFile, 256 * 1024, { privateMode: true });
    check(actualEnv.sha256 === originalEnv.sha256 || envAttempted && actualEnv.sha256 === sha(nextEnv),
      'Rollback preserves changed settings');
    if (actualEnv.sha256 !== originalEnv.sha256) await atomic(envFile, originalEnv.bytes);
    if (actualCommit !== request.expectedOldSha) await git(appRoot, ['checkout', '--detach', '--no-overwrite-ignore', request.expectedOldSha]);
    await restart(); await health({ origin: 'https://matterapp.online' });
    await atomic(path.join(receiptRoot, 'state.private.json'), Buffer.from(JSON.stringify({ version: 1, status: 'rolled-back', request })));
  };
  try {
    stop.signal.throwIfAborted();
    await privateDirectory(privateRoot); await privateDirectory(controls); await privateDirectory(receiptRoot);
    const lockFile = path.join(controls, 'operator.sqlite');
    const existingLock = await read(lockFile, 1024 * 1024, { privateMode: true, optional: true });
    if (!existingLock) { const handle = await fs.open(lockFile, 'wx', 0o600); await handle.close(); }
    lock = new DatabaseSync(lockFile);
    lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
    stop.signal.throwIfAborted();
    check(await gitText(appRoot, ['rev-parse', '--show-toplevel']) === appRoot
      && await gitText(appRoot, ['rev-parse', 'HEAD']) === request.expectedOldSha, 'The existing app commit differs');
    check(!(await gitText(appRoot, ['diff', '--name-only', 'HEAD'])), 'Existing tracked app files changed');
    check((await gitText(appRoot, ['ls-files', '-v'])).split('\n').every(line => line.startsWith('H ')),
      'Git index flags cannot hide existing app changes');
    const remote = await gitText(appRoot, ['remote', 'get-url', 'origin']);
    check(remote === 'https://github.com/sidimohameddaliali2-crypto/matter-admin-app.git'
      || remote === 'git@github.com:sidimohameddaliali2-crypto/matter-admin-app.git', 'The existing Git origin differs');
    const untracked = await gitText(appRoot, ['ls-files', '--others', '--exclude-standard']);
    check(!untracked || untracked === 'server/routes/Event.js', 'Unexpected untracked application input');
    const event = untracked ? await read(path.join(appRoot, untracked), 512 * 1024) : null;
    try { await git(appRoot, ['cat-file', '-e', request.selectedSha + '^{commit}']); }
    catch {
      await git(appRoot, ['fetch', '--no-tags', 'origin', request.selectedSha]);
    }
    const names = (await gitText(appRoot, ['diff', '--name-only', '--no-renames', request.expectedOldSha, request.selectedSha])).split('\n');
    check(names.length > 0 && names.every(allowedChange), 'The selected release changes unrelated app paths');
    beforeRegistration = registration(await processes(), appRoot);
    const npmBefore = dependencies.inspectProcesses ? null : await systemNpmIdentity();
    const dependency = path.join(appRoot, 'server/node_modules'), clientBuild = path.join(appRoot, 'client/build');
    await directory(dependency); await directory(clientBuild);
    const dependenciesBefore = await inventory(dependency), websiteBefore = await inventory(clientBuild, { contents: true });
    envFile = path.join(appRoot, 'server/.env.local'); originalEnv = await read(envFile, 256 * 1024, { privateMode: true });
    const baseEnv = await read(path.join(appRoot, 'server/.env'), 256 * 1024, { privateMode: true, optional: true });
    const dotenv = createRequire(path.join(appRoot, 'server/package.json'))('dotenv');
    const env = { ...(baseEnv ? dotenv.parse(baseEnv.bytes) : {}), ...dotenv.parse(originalEnv.bytes) };
    check(env.DRIVER_AUDIT_ORIGIN === 'https://matterapp.online', 'The existing staff report origin is required');
    const sync = (await processes()).find(row => row.name === 'matter-driver-audit-sync');
    let cacheDirectory;
    if (dependencies.preflight) {
      cacheDirectory = path.join(receiptRoot, 'fixture-cache'); await privateDirectory(cacheDirectory);
    } else {
      const args = sync?.pm2_env?.args;
      check(sync?.pm2_env.pm_exec_path === path.join(appRoot, 'server/scripts/driverAuditSync.js')
        && sync.pm2_env.pm_cwd === path.join(appRoot, 'server')
        && Array.isArray(args) && args.length === 2 && args[0] === '--config'
        && typeof args[1] === 'string' && path.isAbsolute(args[1]) && path.resolve(args[1]) === args[1]
        && /^server\/\.private\/driver-audits\/[a-f0-9]{64}\/sync\.json$/.test(path.relative(appRoot, args[1])),
      'The stopped sync configuration must identify its existing cache');
      const config = JSON.parse((await read(args[1], 1024 * 1024, { privateMode: true })).bytes);
      check(config.root === path.dirname(args[1]));
      await directory(config.root, { privateMode: true });
      cacheDirectory = path.join(config.root, 'work/archive-cache'); await directory(cacheDirectory, { privateMode: true });
    }
    nextEnv = settings(originalEnv.bytes, cacheDirectory);
    const selectedEnv = { ...env, DRIVER_AUDIT_ENABLED: '1', DRIVER_AUDIT_IMPORT_ENABLED: '0',
      DRIVER_AUDIT_SERVING_STORE: 'supabase', DRIVER_AUDIT_REPLICA_GC_ENABLED: '0', MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY: cacheDirectory };
    const disk = await fs.statfs(receiptRoot);
    check(disk.bavail * disk.bsize >= 64 * 1024 ** 2, 'The existing app needs room for its bounded temporary code preflight');
    check(!(await fs.readdir(receiptRoot)).some(name => name.startsWith('preflight-')),
      'An interrupted temporary code preflight requires private review');
    staged = await fs.mkdtemp(path.join(receiptRoot, 'preflight-'));
    await stageServer(appRoot, request.selectedSha, staged);
    const proof = await preflight({ selectedRoot: staged, env: selectedEnv, expected: request, cacheDirectory, signal: stop.signal });
    check(proof?.prewarmed === true && proof.namedEvidenceVerified === true && proof.generation === request.generation
      && proof.reportHeadSha256 === request.reportHeadSha256
      && Object.keys(proof).every(key => ['generation', 'reportHeadSha256', 'prewarmed', 'namedEvidenceVerified',
        'remoteBytesRequired', 'availableTransferBytes', 'coldLoads', 'requiredBytes'].includes(key)),
    'Selected report preflight was not verified');
    const recheck = async () => {
      check(await gitText(appRoot, ['rev-parse', 'HEAD']) === (changedCode ? request.selectedSha : request.expectedOldSha)
        && !(await gitText(appRoot, ['diff', '--name-only', 'HEAD'])), 'The reviewed app code changed');
      check(await gitText(appRoot, ['ls-files', '--others', '--exclude-standard']) === untracked,
        'The preserved untracked application inputs changed');
      check((await read(envFile, 256 * 1024, { privateMode: true })).sha256 === (changedEnv ? sha(nextEnv) : originalEnv.sha256), 'Report settings changed');
      check((await read(path.join(appRoot, 'server/.env'), 256 * 1024, { privateMode: true, optional: true }))?.sha256 === baseEnv?.sha256,
        'The existing business environment changed');
      check(same(registration(await processes(), appRoot), beforeRegistration), 'A protected process registration changed');
      if (npmBefore) check(await systemNpmIdentity() === npmBefore, 'The existing system NPM wrapper changed');
      check(await inventory(dependency) === dependenciesBefore && await inventory(clientBuild, { contents: true }) === websiteBefore,
        'Existing dependencies or website bytes changed');
      if (event) { const current = await read(path.join(appRoot, untracked), 512 * 1024); check(current.sha256 === event.sha256 && current.signature === event.signature, 'The preserved business file changed'); }
    };
    await recheck(); stop.signal.throwIfAborted();
    if (!apply) {
      outcome = { version: 1, status: 'supabase-app-reader-checked', applicationCommit: request.expectedOldSha,
        selectedCommit: request.selectedSha, reportHeadSha256: request.reportHeadSha256, generation: request.generation,
        activationPerformed: false, ...proof };
    } else {
      await immutable(path.join(receiptRoot, 'environment-before.private.bin'), originalEnv.bytes);
      const intent = { version: 1, request, environmentBeforeSha256: originalEnv.sha256,
        environmentAfterSha256: sha(nextEnv), cacheDirectory };
      await immutable(path.join(receiptRoot, 'intent.private.json'), Buffer.from(JSON.stringify(intent)));
      codeAttempted = true;
      await git(appRoot, ['checkout', '--detach', '--no-overwrite-ignore', request.selectedSha]); changedCode = true;
      check(await gitText(appRoot, ['rev-parse', 'HEAD']) === request.selectedSha);
      await recheck(); stop.signal.throwIfAborted();
      envAttempted = true;
      await atomic(envFile, nextEnv); changedEnv = true;
      await restart(); await health({ origin: env.DRIVER_AUDIT_ORIGIN });
      await recheck(); stop.signal.throwIfAborted();
      outcome = { version: 1, status: 'supabase-app-reader-released', previousCommit: request.expectedOldSha,
        applicationCommit: request.selectedSha, reportHeadSha256: request.reportHeadSha256, generation: request.generation,
        dependenciesReinstalled: false, websiteRebuilt: false, workersStarted: false, routingChanged: false,
        authenticatedBrowserAcceptancePending: true };
    }
  } catch (cause) {
    failure = cause;
  } finally {
    try {
      try { if (staged) await fs.rm(staged, { recursive: true, force: true }); } catch (error) { failure ??= error; }
      if (!failure && stop.signal.aborted) failure = stop.signal.reason;
      if (!failure) {
        try {
          if (apply) await immutable(path.join(receiptRoot, 'completed.private.json'), Buffer.from(JSON.stringify(outcome)));
          else await atomic(path.join(receiptRoot, 'preflight.private.json'), Buffer.from(JSON.stringify(outcome)));
          if (stop.signal.aborted) failure = stop.signal.reason;
        } catch (error) { failure = error; }
      }
      if (failure && (codeAttempted || envAttempted)) {
        try { await rollback(); }
        catch { failure = Object.assign(Error('App reader release stopped; private rollback requires review'), { code: 'APP_READER_ROLLBACK_PENDING', cause: failure }); }
      }
    }
    finally {
      try { lock?.close(); } finally { unlisten(); }
    }
  }
  if (failure) throw failure;
  return outcome;
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  try {
    check(process.argv.length === 4 && process.argv[2] === '--request' && process.env.DRIVER_AUDIT_APP_PATH);
    const encoded = process.argv[3]; check(encoded.length <= 4096 && Buffer.from(encoded, 'base64').toString('base64') === encoded);
    console.log(JSON.stringify(await releaseSupabaseAppReader({ appRoot: process.env.DRIVER_AUDIT_APP_PATH,
      request: JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) })));
  } catch { console.error('The reviewed Supabase reader release stopped. Existing private recovery evidence is retained.'); process.exitCode = 1; }
}
