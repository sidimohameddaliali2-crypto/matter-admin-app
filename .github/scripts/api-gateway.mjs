import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { listenPrivate } from './private-socket.mjs';

export const gatewayProtocol = 'matter-api-gateway-v1';
const validPort = value => Number.isInteger(value) && (value === 5000 || value >= 35000 && value <= 35999);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function runtimeDigest() {
  return digest(Buffer.concat(await Promise.all([fs.readFile(fileURLToPath(import.meta.url)), fs.readFile(new URL('./private-socket.mjs', import.meta.url))])));
}
const hopHeaders = new Set(['connection','proxy-connection','keep-alive','te','trailer','transfer-encoding','upgrade','proxy-authenticate','proxy-authorization']);
function endToEnd(headers) {
  const named = new Set(String(headers.connection || '').toLowerCase().split(',').map(value => value.trim()));
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !hopHeaders.has(name) && !named.has(name)));
}
async function atomicJson(file, value) {
  const temporary = file + '.next'; const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  try { await fs.rename(temporary, file); } finally { await fs.unlink(temporary).catch(() => {}); }
}

export async function createApiGateway({ stateFile, socketPath, port = 34999 }) {
  let current = JSON.parse(await fs.readFile(stateFile, 'utf8')).port, switching = false;
  if (!validPort(current)) throw Error('Invalid gateway target');
  const active = new Map(), upgraded = new Set(), instanceId = randomUUID(), sha256 = await runtimeDigest();
  const capture = () => {
    // Capture and increment synchronously. A switch acknowledgement therefore
    // guarantees no later request can select the former target unnoticed.
    const target = current; active.set(target, (active.get(target) || 0) + 1); let done = false;
    return { target, finish() { if (!done) { done = true; active.set(target, active.get(target) - 1); } } };
  };
  const server = http.createServer((req, res) => {
    const route = capture();
    const upstream = http.request({ host: '127.0.0.1', port: route.target, path: req.url, method: req.method,
      headers: endToEnd(req.headers), agent: false }, incoming => {
      res.writeHead(incoming.statusCode, { ...endToEnd(incoming.headers), Connection: 'close' });
      incoming.on('error', () => res.destroy()); incoming.pipe(res);
    });
    // Never retry a write: a disconnected backend can have an uncertain result.
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502, { Connection: 'close' }); res.end(); });
    req.on('aborted', () => upstream.destroy()); req.on('error', () => upstream.destroy());
    res.once('finish', route.finish);
    res.once('close', () => { if (!res.writableFinished) upstream.destroy(); route.finish(); });
    req.pipe(upstream);
  });
  server.on('upgrade', (req, client, head) => {
    const route = capture(), upstream = net.createConnection({ host: '127.0.0.1', port: route.target });
    upgraded.add(client);
    upstream.once('connect', () => {
      upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${req.rawHeaders.reduce((lines, value, index, values) => index % 2 ? lines : lines + value + ': ' + values[index + 1] + '\r\n', '')}\r\n`);
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    const finish = () => { upgraded.delete(client); client.destroy(); upstream.destroy(); route.finish(); };
    client.on('error', finish); upstream.on('error', finish); client.on('close', finish); upstream.on('close', finish);
  });
  const status = () => ({ protocol: gatewayProtocol, sha256, instanceId, port: current, active: Object.fromEntries(active) });
  const control = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/status') return res.end(JSON.stringify(status()));
    if (req.method !== 'POST' || req.url !== '/switch') { res.writeHead(404); return res.end('{}'); }
    if (switching) { res.writeHead(409); return res.end('{}'); }
    switching = true;
    try {
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 1024) throw Error('Control request too large'); }
      const { port: next, expectedPort } = JSON.parse(body);
      if (!validPort(next) || expectedPort !== current) { res.writeHead(409); return res.end('{}'); }
      const previousPort = current;
      await atomicJson(stateFile, { version: 1, port: next });
      current = next;
      res.end(JSON.stringify({ ...status(), previousPort, drainToken: previousPort }));
    } catch { res.writeHead(503); res.end('{}'); }
    finally { switching = false; }
  });
  const stopControl = await listenPrivate(control, socketPath);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { status, async close() { for (const client of upgraded) client.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await stopControl(); } };
}

export async function prepareApiGateway(appRoot) {
  if (process.platform !== 'linux') throw Error('Linux required');
  const root = path.join(await fs.realpath(appRoot), '.api');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077) throw Error('Private API directory required');
  const sha256 = await runtimeDigest(), runtime = path.join(root, `gateway-${sha256}`);
  await fs.mkdir(runtime, { mode: 0o700 });
  for (const name of ['api-gateway.mjs','private-socket.mjs']) await fs.copyFile(new URL(name, import.meta.url), path.join(runtime, name), fs.constants.COPYFILE_EXCL);
  const stateFile = path.join(root, 'upstream.json'), socketPath = path.join(root, 'control/gateway.sock');
  await fs.writeFile(stateFile, JSON.stringify({ version: 1, port: 5000 }), { mode: 0o600, flag: 'wx' });
  const settings = { version: 1, protocol: gatewayProtocol, sha256, stateFile, socketPath, port: 34999 };
  await fs.writeFile(path.join(root, 'gateway.private.json'), JSON.stringify(settings), { mode: 0o600, flag: 'wx' });
  await fs.writeFile(path.join(root, 'gateway-process.private.json'), JSON.stringify({ apps: [{
    name: 'matter-api-gateway', script: path.join(runtime, 'api-gateway.mjs'), args: ['serve', path.join(root, 'gateway.private.json')],
    interpreter: process.execPath, instances: 1, exec_mode: 'fork', cwd: root,
  }] }), { mode: 0o600, flag: 'wx' });
  return { prepared: true, sha256, gatewayPort: 34999, targetPort: 5000 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, file] = process.argv.slice(2);
  try {
    if (command === 'prepare') console.log(JSON.stringify(await prepareApiGateway(file)));
    else if (command === 'serve') {
      const settings = JSON.parse(await fs.readFile(file, 'utf8'));
      if (settings.protocol !== gatewayProtocol || settings.sha256 !== await runtimeDigest() || settings.port !== 34999) throw Error('Gateway identity differs');
      await createApiGateway(settings);
    } else throw Error('Use prepare APP_ROOT or serve PRIVATE_CONFIG');
  } catch { console.error('Gateway operation refused; inspect private configuration without exposing it.'); process.exitCode = 1; }
}
