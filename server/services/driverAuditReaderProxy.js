import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { auditRoute } from './driverAuditIntegration.js';
import { readerActorHeader, readerIngressHeader } from './driverAuditHttp.js';

const reader = fileURLToPath(new URL('../scripts/driverAuditReaderChild.js', import.meta.url));
const localHost = '127.0.0.1';
const excludedHeaders = new Set(['connection', 'proxy-connection', 'keep-alive', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization', readerActorHeader, readerIngressHeader]);
const settings = ['JWT_SECRET', 'DRIVER_AUDIT_ORIGIN', 'DRIVER_AUDIT_SUPABASE_SECRET',
  'DRIVER_AUDIT_STAFF_RENDERER_DIR', 'DRIVER_AUDIT_STAFF_RENDERER_SHA256', 'DRIVER_AUDIT_RELEASE_SHA',
  'MATTER_SUPABASE_SECRET', 'MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY',
  'SPACES_ENDPOINT', 'SPACES_BUCKET', 'SPACES_REGION', 'SPACES_KEY', 'SPACES_SECRET'];

function endToEndHeaders(headers) {
  const named = new Set(String(headers.connection ?? '').toLowerCase().split(',').map(value => value.trim()));
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excludedHeaders.has(name) && !named.has(name)));
}

function readStaffActor(encoded) {
  if (typeof encoded !== 'string' || encoded.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(encoded)) return;
  try {
    const { kind, id, name, role } = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    if (kind !== 'staff' || typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id)
      || typeof name !== 'string' || name.length > 100 || typeof role !== 'string' || role.length > 50) return;
    return Object.freeze({ kind, id, name, role });
  } catch { return undefined; }
}

function unavailable(response) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) return response.destroy();
  response.writeHead(503, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Driver Reports is temporarily unavailable. Your saved reports and reviews are retained.');
}

// Keep report decoding and rendering outside the business API's event loop.
// The worker only listens on loopback, and only the parent holds its ingress key.
export function createDriverAuditReaderProxy({ env = process.env, spawn = fork, now = Date.now } = {}) {
  if (env.DRIVER_AUDIT_SERVING_STORE !== 'supabase' || env.DRIVER_AUDIT_ENABLED !== '1'
    || env.DRIVER_AUDIT_IMPORT_ENABLED !== '0') throw Error('Explicit Supabase report serving is required');

  const businessPort = Number(env.PORT || 5000);
  if (!Number.isInteger(businessPort) || businessPort < 1 || businessPort > 65535) {
    throw Error('A fixed local staff API port is required');
  }
  const workerEnv = Object.fromEntries(settings.filter(name => env[name] !== undefined).map(name => [name, env[name]]));
  let active, stopped = false, retryAt = 0;

  function stopReader(entry) {
    if (!entry || entry.closing) return;
    entry.closing = true;
    clearTimeout(entry.startTimer);
    entry.rejectReady(Error('Report reader stopped'));
    // IPC can disconnect while the reader is still draining requests. Keep
    // ownership until the OS reports that its process actually exited.
    entry.stopTimer = setTimeout(() => entry.child.kill('SIGKILL'), 7500);
    entry.stopTimer.unref();
    if (entry.child.connected) entry.child.disconnect();
    else entry.child.kill('SIGTERM');
  }

  function startedReader() {
    if (stopped || now() < retryAt) return Promise.reject(Error('Report reader starting'));
    if (active) return active.closing ? Promise.reject(Error('Report reader stopping')) : active.ready;
    const key = randomBytes(32).toString('base64url');
    const child = spawn(reader, [], {
      env: { ...workerEnv, DRIVER_AUDIT_READER_KEY: key, DRIVER_AUDIT_READER_STAFF_PORT: String(businessPort) },
      execArgv: ['--max-old-space-size=1024'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const entry = { child, closing: false };
    active = entry;
    let finish;
    entry.closed = new Promise(resolve => { finish = resolve; });
    entry.ready = new Promise((resolve, reject) => {
      entry.rejectReady = reject;
      const ended = () => {
        clearTimeout(entry.startTimer);
        clearTimeout(entry.stopTimer);
        if (active === entry) {
          active = undefined;
          retryAt = now() + 5000;
        }
        reject(Error('Report reader stopped'));
        finish();
      };
      entry.startTimer = setTimeout(() => stopReader(entry), 10000);
      child.on('error', () => stopReader(entry));
      child.once('exit', ended);
      child.once('close', ended);
      child.once('disconnect', () => stopReader(entry));
      child.once('message', value => {
        if (value?.ready !== true || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
          return stopReader(entry);
        }
        if (entry.closing) return;
        clearTimeout(entry.startTimer);
        resolve({ port: value.port, key });
      });
    });
    return entry.ready;
  }

  async function middleware(req, res, next) {
    let address;
    try { address = new URL(req.url, 'http://driver-report.local'); } catch { return next(); }
    if (!auditRoute(address.pathname)) return next();
    try {
      const { port, key } = await startedReader();
      if (res.destroyed || req.aborted) return;
      const upstream = request({ host: localHost, port, method: req.method, path: address.pathname + address.search,
        headers: { ...endToEndHeaders(req.headers), [readerIngressHeader]: key } }, incoming => {
        if (res.destroyed) return incoming.destroy();
        const actor = readStaffActor(incoming.headers[readerActorHeader]);
        if (actor) req.activityActor = actor;
        res.writeHead(incoming.statusCode, endToEndHeaders(incoming.headers));
        incoming.on('error', () => unavailable(res));
        incoming.pipe(res);
      });
      upstream.setTimeout(45000, () => upstream.destroy(Error('Report request timed out')));
      upstream.on('error', () => unavailable(res));
      req.on('aborted', () => upstream.destroy());
      req.on('error', () => upstream.destroy());
      res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
      req.pipe(upstream);
    } catch { unavailable(res); }
  }

  middleware.prewarm = async () => {
    const { port, key } = await startedReader();
    const response = await fetch('http://' + localHost + ':' + port + '/health', {
      headers: { [readerIngressHeader]: key }, redirect: 'error', signal: AbortSignal.timeout(45000),
    });
    await response.body?.cancel();
    return response.status === 200;
  };
  middleware.close = () => {
    stopped = true;
    const reader = active;
    stopReader(reader);
    return reader?.closed ?? Promise.resolve();
  };
  return middleware;
}
