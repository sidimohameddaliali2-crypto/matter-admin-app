import http from 'node:http';
import path from 'node:path';
import { listenPrivate } from '../../.github/scripts/private-socket.mjs';

export function apiRuntimeSettings(env = process.env) {
  if (!env.MATTER_API_RELEASE) {
    if (env.MATTER_API_WEB_ONLY || env.MATTER_API_PORT || env.MATTER_API_CONTROL_SOCKET || env.MATTER_SHARED_SERVER_ROOT) throw Error('Incomplete managed API settings');
    return null;
  }
  const { MATTER_API_RELEASE: releaseId, MATTER_API_PORT: value, MATTER_SHARED_SERVER_ROOT: sharedRoot } = env;
  const port = Number(value);
  if (!/^[a-f0-9]{40}-\d+-\d+$/.test(releaseId) || !Number.isInteger(port) || port < 35000 || port > 35999
    || !sharedRoot || !path.isAbsolute(sharedRoot) || env.MATTER_API_WEB_ONLY !== '1') throw Error('Invalid managed API release settings');
  return { releaseId, port, sharedRoot };
}

// Only the isolated web release gets a control socket. Legacy startup continues
// to own scheduled work; web handoffs never stop or duplicate those jobs.
export function createApiRuntime({ settings, readiness, disconnectSockets = () => {}, onStop = async () => {} }) {
  let activeRequests = 0, draining = false;
  const status = () => ({ releaseId: settings.releaseId, backgroundJobs: false, activeRequests, draining, ...readiness() });
  const track = (req, res, next) => {
    activeRequests++;
    let finished = false;
    const complete = () => { if (!finished) { finished = true; activeRequests--; } };
    res.once('finish', complete); res.once('close', complete); next();
  };
  let control;
  return {
    status, track,
    async listen(socketPath) {
      control = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'POST' && req.url === '/drain') { draining = true; disconnectSockets(); }
        else if (req.method !== 'GET' || req.url !== '/status') { res.writeHead(404); return res.end('{}'); }
        res.end(JSON.stringify(status()));
      });
      const close = await listenPrivate(control, socketPath);
      return async () => { await onStop(); await close(); };
    },
  };
}
