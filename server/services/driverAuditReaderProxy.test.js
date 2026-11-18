import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, request } from 'node:http';
import test from 'node:test';
import { createDriverAuditReaderProxy } from './driverAuditReaderProxy.js';
import { readerActorHeader } from './driverAuditHttp.js';

const env = { DRIVER_AUDIT_SERVING_STORE: 'supabase', DRIVER_AUDIT_ENABLED: '1',
  DRIVER_AUDIT_IMPORT_ENABLED: '0', PORT: '5050', MONGODB_URI: 'fixture-business-only' };

async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  return { port, origin: 'http://127.0.0.1:' + port };
}

function fakeChild(port, { holdOpen = false } = {}) {
  const child = new EventEmitter();
  child.connected = true;
  child.finish = () => child.emit('exit', 0);
  child.kill = signal => { if (!holdOpen || signal === 'SIGKILL') child.finish(); };
  child.disconnect = () => {
    if (!child.connected) return;
    child.connected = false;
    child.emit('disconnect');
    if (!holdOpen) queueMicrotask(child.finish);
  };
  queueMicrotask(() => child.emit('message', { ready: true, port }));
  return child;
}

test('the report child receives only report requests, preserves staff cookies and streams reviews', async t => {
  let key, workerCalls = 0, starts = 0, received, recordedActor;
  const actor = { id: 'a'.repeat(24), kind: 'staff', name: 'Fictional Reviewer', role: 'manager' };
  const actorHeader = Buffer.from(JSON.stringify(actor)).toString('base64url');
  const worker = await listen(t, async (req, res) => {
    workerCalls++;
    const chunks = [];
    for await (const part of req) chunks.push(part);
    assert.equal(req.headers['x-matter-report-reader'], key);
    if (req.url === '/health') { res.writeHead(200); return res.end(); }
    received = { method: req.method, url: req.url, cookie: req.headers.cookie,
      body: Buffer.concat(chunks).toString(), hop: req.headers['x-private-hop'], actor: req.headers[readerActorHeader] };
    res.writeHead(200, { 'Set-Cookie': ['first=1', 'second=2'], 'Cache-Control': 'no-store', [readerActorHeader]: actorHeader });
    res.end('saved');
  });
  const proxy = createDriverAuditReaderProxy({ env, spawn(_file, _args, options) {
    starts++;
    key = options.env.DRIVER_AUDIT_READER_KEY;
    assert.match(key, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(options.env.DRIVER_AUDIT_READER_STAFF_PORT, '5050');
    assert.equal(options.env.MONGODB_URI, undefined);
    assert.deepEqual(options.execArgv, ['--max-old-space-size=1024']);
    return fakeChild(worker.port);
  } });
  t.after(() => proxy.close());
  const app = await listen(t, (req, res) => {
    res.once('finish', () => { recordedActor = req.activityActor; });
    return proxy(req, res, () => res.end('business'));
  });
  assert.equal(await (await fetch(app.origin + '/api/deliveries')).text(), 'business');
  assert.equal(starts, 0);
  assert.equal(await proxy.prewarm(), true);
  const { response, body } = await new Promise((resolve, reject) => {
    const outbound = request(app.origin + '/api/reporting/reviews?slot=morning', {
      method: 'POST', headers: { cookie: 'staff=fixture', connection: 'x-private-hop',
        'x-private-hop': 'do not forward', 'x-matter-report-reader': 'client-forged', [readerActorHeader]: 'client-forged' },
    }, async response => {
      try {
        const chunks = [];
        for await (const part of response) chunks.push(part);
        resolve({ response, body: Buffer.concat(chunks).toString() });
      } catch (error) { reject(error); }
    });
    outbound.on('error', reject);
    outbound.end('{"review":"fixture"}');
  });
  assert.equal(body, 'saved');
  assert.deepEqual(response.headers['set-cookie'], ['first=1', 'second=2']);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers[readerActorHeader], undefined);
  assert.deepEqual(recordedActor, actor);
  assert.equal(starts, 1);
  assert.equal(workerCalls, 2);
  assert.deepEqual(received, { method: 'POST', url: '/api/reporting/reviews?slot=morning',
    cookie: 'staff=fixture', body: '{"review":"fixture"}', hop: undefined, actor: undefined });
});

test('a dead report worker leaves business requests available and backs off before starting again', async t => {
  let now = 1000, starts = 0, child;
  const worker = await listen(t, (_req, res) => res.end('report'));
  const proxy = createDriverAuditReaderProxy({ env, now: () => now, spawn() {
    starts++;
    return child = fakeChild(worker.port, { holdOpen: starts === 1 });
  } });
  t.after(() => proxy.close());
  const app = await listen(t, (req, res) => proxy(req, res, () => res.end('business')));
  assert.equal(await (await fetch(app.origin + '/api/reporting/status')).text(), 'report');
  child.disconnect();
  assert.equal((await fetch(app.origin + '/api/reporting/status')).status, 503);
  assert.equal(await (await fetch(app.origin + '/api/health')).text(), 'business');
  assert.equal(starts, 1);
  now += 10000;
  assert.equal((await fetch(app.origin + '/api/reporting/status')).status, 503);
  assert.equal(starts, 1, 'A disconnected process is still owned until its exit');
  child.finish();
  assert.equal((await fetch(app.origin + '/api/reporting/status')).status, 503);
  now += 5000;
  assert.equal(await (await fetch(app.origin + '/api/reporting/status')).text(), 'report');
  assert.equal(starts, 2);
});
