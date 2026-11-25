import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { handoffApi } from './api-handoff.mjs';
import { gatewayProtocol } from './api-gateway.mjs';
import { publishWebsite, publishLiveWebsite, rollbackWebsite, rollbackLiveWebsite, checkPublicWebsite } from './website-release.mjs';

const run = promisify(execFile);
const releasePattern = /^[a-f0-9]{40}-\d+-\d+$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const stop = code => { throw Object.assign(new Error(code), { safeCode: code }); };
const absent = error => { if (error.code === 'ENOENT') return null; throw error; };
const readJson = async file => { const bytes = await fs.readFile(file).catch(absent); return bytes === null ? null : JSON.parse(bytes); };
const privateDirectory = async directory => {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077) throw Error('API state must be owner-private');
};
async function writeJson(file, value) {
  const temporary = file + '.next';
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  try { await fs.rename(temporary, file); } finally { await fs.unlink(temporary).catch(absent); }
}
export async function controlRequest(socketPath, method = 'GET', endpoint = '/status', body) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: endpoint, method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' } }, response => {
      let body = '';
      response.on('data', bytes => { body += bytes; if (body.length > 16384) request.destroy(Error('Control response too large')); });
      response.on('error', reject); response.on('aborted', () => reject(Error('Control response interrupted')));
      response.on('end', () => { try { if (response.statusCode !== 200) throw Error('Control operation refused'); resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    request.on('error', reject); request.setTimeout(5000, () => request.destroy(Error('Control timed out'))); request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function eventually(check, attempts = 90) {
  for (let i = 0; i < attempts; i++) {
    try { if (await check()) return; } catch { /* Preserve old traffic while waiting. */ }
    if (i + 1 < attempts) await delay(1000);
  }
  throw Error('API verification timed out');
}
async function health(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(5000), cache: 'no-store' });
  if (!response.ok) throw Error('API health failed');
  return response.json();
}
async function gatewayFor(root) {
  const config = await readJson(path.join(root, 'gateway.private.json'));
  if (config?.protocol !== gatewayProtocol || config.socketPath !== path.join(root, 'control/gateway.sock') || !/^[a-f0-9]{64}$/.test(config.sha256 || '')) stop('GATEWAY_NOT_QUALIFIED');
  const initial = await controlRequest(config.socketPath);
  if (initial.protocol !== gatewayProtocol || initial.sha256 !== config.sha256 || !initial.instanceId) throw Error('Gateway runtime differs');
  return async (operation, to, from) => {
    const before = await controlRequest(config.socketPath);
    if (before.instanceId !== initial.instanceId || before.sha256 !== config.sha256) throw Error('Gateway restarted during handoff');
    if (operation === 'status') return before;
    if (operation !== 'switch') throw Error('Unsupported gateway operation');
    const result = await controlRequest(config.socketPath, 'POST', '/switch', { port: to, expectedPort: from });
    if (result.instanceId !== initial.instanceId || result.port !== to || result.drainToken !== from) throw Error('Gateway switch acknowledgement differs');
    return result;
  };
}
const pm2 = async args => run('pm2', args, { timeout: 180000, maxBuffer: 16 * 1024 * 1024 });

async function retireWeb(previous, candidate, drainToken, gateway) {
  if (previous.role !== 'web' || !releasePattern.test(previous.releaseId || '') || previous.name !== `matter-api-${previous.releaseId}`
    || candidate.name === previous.name || previous.port === candidate.port) throw Error('Invalid retirement target');
  if ((await gateway('status')).port !== candidate.port) throw Error('Upstream moved before retirement');
  if (drainToken !== previous.port) throw Error('Gateway drain target differs');
  const registered = JSON.parse((await pm2(['jlist'])).stdout).some(item => item.name === previous.name);
  if (registered) await controlRequest(previous.socketPath, 'POST', '/drain');
  await eventually(async () => {
    const old = registered ? await controlRequest(previous.socketPath) : { activeRequests: 0 };
    const state = await gateway('status');
    return old.activeRequests === 0 && (state.active[previous.port] || 0) === 0;
  }, 120);
  if ((await gateway('status')).port !== candidate.port) throw Error('Upstream moved during retirement');
  if (registered) await pm2(['delete', previous.name]);
}

export async function finishApiRetirement(appRoot) {
  if (process.platform !== 'linux') throw Error('Linux required');
  const root = path.join(await fs.realpath(appRoot), '.api'); await privateDirectory(root);
  const lock = path.join(root, 'deploy.lock'); await fs.mkdir(lock, { mode: 0o700 });
  try {
    if (await readJson(path.join(root, 'pending.json'))) throw Error('Unresolved handoff needs separate recovery');
    const file = path.join(root, 'current.json'), current = await readJson(file);
    if (!current?.retirementPending) return { retirementPending: false };
    const gateway = await gatewayFor(root);
    await retireWeb(current.previous, current.candidate, current.drainToken, gateway);
    await pm2(['save']); await writeJson(file, { ...current, retirementPending: false });
    return { retirementPending: false };
  } finally { await fs.rmdir(lock); }
}

export async function deployApi({ appRoot, releaseId, websiteSource, websiteMode = '0', origin = 'https://matterapp.online' }) {
  if (process.platform !== 'linux' || !releasePattern.test(releaseId) || !['0', '1'].includes(websiteMode)) throw Error('Invalid Linux API release request');
  appRoot = await fs.realpath(appRoot);
  const root = path.join(appRoot, '.api'); await privateDirectory(root);
  const controlRoot = path.join(root, 'control'); await privateDirectory(controlRoot);
  const lock = path.join(root, 'deploy.lock'); await fs.mkdir(lock, { mode: 0o700 });
  const currentFile = path.join(root, 'current.json'), pendingFile = path.join(root, 'pending.json');
  try {
    if (await readJson(pendingFile)) stop('API_HANDOFF_UNRESOLVED');
    const current = await readJson(currentFile);
    if (current?.retirementPending) stop('API_RETIREMENT_PENDING');
    const gateway = await gatewayFor(root);
    // Never change the job owner's files, environment, PM2 registration or PID.
    const processes = JSON.parse((await pm2(['jlist'])).stdout);
    const gateways = processes.filter(item => item.name === 'matter-api-gateway' && item.pm2_env.status === 'online');
    if (gateways.length !== 1) stop('GATEWAY_NOT_RUNNING');
    const owners = processes.filter(item => item.name === 'matter-delivery-api');
    if (owners.length !== 1 || owners[0].pm2_env.status !== 'online') throw Error('Exactly one existing online job owner is required');
    const owner = owners[0];
    const ownerHealth = await health(5000);
    if (ownerHealth.database !== 'connected' || ownerHealth.deployment?.role !== 'legacy-jobs'
      || ownerHealth.deployment?.backgroundJobs !== true || ownerHealth.deployment?.socketBusReady !== true
      || ownerHealth.deployment?.ready !== true || typeof ownerHealth.deployment?.reportEnabled !== 'boolean') stop('JOB_OWNER_NOT_QUALIFIED');
    const previous = current?.candidate || { role: 'jobs', name: 'matter-delivery-api', port: 5000 };
    if ((await gateway('status')).port !== previous.port) throw Error('Gateway and API state disagree');
    const memory = await fs.readFile('/proc/meminfo', 'utf8');
    const available = Number(memory.match(/^MemAvailable:\s+(\d+)\s+kB/m)?.[1] || 0) * 1024;
    const disk = await fs.statfs(root);
    // The retained report reader can allocate a 1 GiB child heap. Do not cold
    // start its replacement on the earlier 256 MiB assumption.
    const requiredMemory = ownerHealth.deployment.reportEnabled ? 2 * 1024 ** 3 : 512 * 1024 ** 2;
    if (available < requiredMemory || disk.bavail * disk.bsize < 1024 ** 3) stop('API_CAPACITY_INSUFFICIENT');
    const releaseRoot = path.join(root, 'releases', releaseId);
    const stat = await fs.lstat(releaseRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(releaseRoot) !== releaseRoot) throw Error('Invalid isolated API release directory');
    if (await fs.lstat(path.join(releaseRoot, 'process.private.json')).catch(absent)) throw Error('Release already prepared; use a new reviewed run attempt');
    const sharedRoot = path.join(appRoot, 'server');
    for (const name of ['uploads', '.private']) {
      const source = path.join(sharedRoot, name);
      const sourceStat = await fs.lstat(source).catch(absent);
      if (sourceStat) {
        if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw Error('Shared API path must be an existing real directory');
        await fs.symlink(source, path.join(releaseRoot, 'server', name));
      }
    }
    await run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: path.join(releaseRoot, 'server'), timeout: 600000, maxBuffer: 2 * 1024 * 1024 });
    const net = await import('node:net');
    const reservedPorts = new Set([previous.port, current?.previous?.port,
      ...processes.filter(item => item.name?.startsWith('matter-api-')).map(item => Number(item.pm2_env.MATTER_API_PORT))]);
    let port;
    for (let value = 35000; value <= 35999; value++) {
      if (reservedPorts.has(value)) continue;
      const free = await new Promise(resolve => {
        const probe = net.createServer(); probe.once('error', () => resolve(false));
        probe.listen(value, '127.0.0.1', () => probe.close(() => resolve(true)));
      });
      if (free) { port = value; break; }
    }
    if (!port) throw Error('No unused candidate API port');
    const inherited = { ...(owner.pm2_env.env || {}) };
    for (const [key, value] of Object.entries(owner.pm2_env)) if (/^[A-Z][A-Z0-9_]*$/.test(key) && ['string', 'number', 'boolean'].includes(typeof value)) inherited[key] = value;
    const candidate = { role: 'web', releaseId, port, name: `matter-api-${releaseId}`, socketPath: path.join(controlRoot, hash(releaseId).slice(0, 16) + '.sock') };
    const config = { apps: [{ name: candidate.name, script: path.join(releaseRoot, 'server/server.js'), cwd: sharedRoot,
      interpreter: process.execPath, instances: 1, exec_mode: 'fork', kill_timeout: 600000,
      env: { ...inherited, NODE_ENV: 'production', MATTER_RELEASE_SHA: releaseId.slice(0, 40), MATTER_API_RELEASE: releaseId,
        MATTER_API_PORT: String(port), MATTER_SHARED_SERVER_ROOT: sharedRoot, MATTER_API_WEB_ONLY: '1', MATTER_API_CONTROL_SOCKET: candidate.socketPath } }] };
    const processFile = path.join(releaseRoot, 'process.private.json'); await writeJson(processFile, config);
    let committed;
    const publicReady = async selected => eventually(async () => {
      const response = await fetch(origin + '/api/health?release=' + (selected.releaseId || 'jobs'), { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!response.ok) return false;
      const body = await response.json();
      return body.database === 'connected' && body.deployment?.ready === true
        && (selected.role === 'jobs' ? body.deployment.role === 'legacy-jobs' : body.deployment.releaseId === selected.releaseId);
    });
    const ops = {
      recordPending: record => writeJson(pendingFile, { version: 1, ...record, websiteMode, startedAt: new Date().toISOString() }),
      start: async () => { await pm2(['start', processFile]); await pm2(['save']); },
      ready: selected => eventually(async () => {
        const body = await controlRequest(selected.socketPath);
        return body.releaseId === selected.releaseId && body.ready && body.backgroundJobs === false && body.socketBusReady && !body.draining;
      }),
      switchTraffic: (to, from) => gateway('switch', to, from),
      restoreTraffic: async (prior, next) => {
        const actual = (await gateway('status')).port;
        if (actual === prior.port) return { drainToken: next.port };
        if (actual !== next.port) throw Error('Unknown active upstream');
        return gateway('switch', prior.port, next.port);
      },
      publicReady,
      publishWebsite: async () => {
        const result = websiteMode === '1'
          ? await publishWebsite(appRoot, websiteSource, releaseId, { checkPublic: source => checkPublicWebsite(source, origin) })
          : await publishLiveWebsite(appRoot, websiteSource, releaseId, origin);
        return { changed: !result.unchanged };
      },
      rollbackWebsite: () => websiteMode === '1' ? rollbackWebsite(appRoot) : rollbackLiveWebsite(appRoot),
      commit: async record => {
        committed = { version: 1, ...record, websiteMode, retirementPending: record.previous.role === 'web', jobOwner: { name: owner.name, pidAtVerification: owner.pid, port: 5000 }, committedAt: new Date().toISOString() };
        await writeJson(currentFile, committed);
      },
      discard: async (selected, { previous: prior, mayHaveServed, drainToken }) => {
        if (selected.role !== 'web' || selected.name === owner.name) throw Error('Job owner must never be stopped');
        const active = (await gateway('status')).port;
        if (active === selected.port) throw Error('Cannot discard the routed API');
        if (mayHaveServed) {
          if (drainToken !== selected.port) throw Error('Unknown rollback routing; retain the candidate');
          await retireWeb(selected, prior, drainToken, gateway);
          await pm2(['save']); return;
        }
        const live = JSON.parse((await pm2(['jlist'])).stdout).filter(item => item.name === selected.name);
        if (live.length) await pm2(['delete', selected.name]);
        await pm2(['save']);
      },
      clearPending: () => fs.unlink(pendingFile).catch(absent),
      retire: (prior, token) => retireWeb(prior, candidate, token, gateway),
      retirementResult: async ({ retirementPending }) => {
        await pm2(['save']);
        await writeJson(currentFile, { ...committed, retirementPending });
      },
    };
    return await handoffApi({ candidate, previous, ops });
  } finally { await fs.rmdir(lock); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [appRoot, releaseId, websiteSource, websiteMode] = process.argv.slice(2);
  try { console.log(JSON.stringify(appRoot === 'retire' ? await finishApiRetirement(releaseId) : await deployApi({ appRoot, releaseId, websiteSource, websiteMode }))); }
  catch (error) { console.error(`API handoff stopped${/^[A-Z_]+$/.test(error.safeCode || '') ? ': ' + error.safeCode : ''}. Existing job owner and release evidence are retained; inspect private API state and PM2 logs.`); process.exitCode = 1; }
}
