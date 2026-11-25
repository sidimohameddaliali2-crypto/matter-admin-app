import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createApiGateway } from './api-gateway.mjs';
import { handoffApi } from './api-handoff.mjs';
import { controlRequest } from './api-release.mjs';
import { createApiRuntime } from '../../server/services/apiRuntime.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// Nginx keeps its client connections; only the gateway target changes.
test('real Nginx handoff preserves an in-flight POST, keeps GETs online and leaves the job process running', {
  skip: process.platform !== 'linux' || !process.env.NGINX_BIN,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'matter-api-'));
  let nginx, gateway, worker, reader, readerError, reading = false, stopControl, stopCandidateControl, rollbackWrite, releaseCandidate;
  const servers = [];
  let resolveWrite, writeStarted, releaseWrite;
  const started = new Promise(resolve => { writeStarted = resolve; });
  const released = new Promise(resolve => { releaseWrite = resolve; });
  let writes = 0, beats = 0;
  const oldSockets = new Set(), nextSockets = new Set();
  const status = () => ({ ready: true, database: 'connected', socketBusReady: true });
  const runtime = createApiRuntime({ settings: { releaseId: 'old' }, readiness: status, disconnectSockets: () => { for (const socket of oldSockets) socket.destroy(); } });
  const websocketBackend = (server, name, sockets) => server.on('upgrade', (req, socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    const key = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\n\r\n`);
    socket.write(Buffer.concat([Buffer.from([0x81, name.length]), Buffer.from(name)]));
    socket.on('data', bytes => { if ((bytes[0] & 15) === 8) socket.end(Buffer.from([0x88, 0])); });
  });
  try {
    await fs.writeFile(path.join(root, 'job.mjs'), 'setInterval(()=>process.send({beat:true}),10);');
    worker = fork(path.join(root, 'job.mjs'), [], { stdio: ['ignore','ignore','inherit','ipc'] });
    worker.on('message', () => beats++); const workerPid = worker.pid;
    const old = http.createServer((req, res) => runtime.track(req, res, async () => {
      if (req.url === '/api/write' && req.method === 'POST') {
        let body = ''; for await (const chunk of req) body += chunk;
        writeStarted(); await released; writes++; res.end('saved-once:' + body);
      } else res.end('old');
    }));
    const next = http.createServer((req, res) => res.end('new'));
    websocketBackend(old, 'old', oldSockets); websocketBackend(next, 'new', nextSockets);
    servers.push(old, next);
    await new Promise(resolve => old.listen(35010, '127.0.0.1', resolve));
    await new Promise(resolve => next.listen(35011, '127.0.0.1', resolve));
    const socketPath = path.join(root, 'control/old.sock'); stopControl = await runtime.listen(socketPath);
    const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const gatewayState = path.join(root, 'upstream.json'), gatewaySocket = path.join(root, 'control/gateway.sock');
    await fs.writeFile(gatewayState, JSON.stringify({ version: 1, port: 35010 }));
    gateway = await createApiGateway({ stateFile: gatewayState, socketPath: gatewaySocket });
    await fs.mkdir(path.join(root, 'logs'));
    await fs.writeFile(path.join(root, 'nginx.conf'), `pid ${root}/nginx.pid; error_log ${root}/error.log;
      events {} http { access_log off; client_body_temp_path ${root}/body; proxy_temp_path ${root}/proxy;
      fastcgi_temp_path ${root}/fastcgi; uwsgi_temp_path ${root}/uwsgi; scgi_temp_path ${root}/scgi;
      server { listen 127.0.0.1:${port}; location / { proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";
      proxy_pass http://127.0.0.1:34999; } } }
    `);
    nginx = spawn(process.env.NGINX_BIN, ['-p', root, '-c', path.join(root, 'nginx.conf'), '-g', 'daemon off;'], { stdio: 'inherit' });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) { try { if ((await fetch(base)).ok) break; } catch {} await pause(25); }
    const command = (operation, to, from) => operation === 'status' ? controlRequest(gatewaySocket)
      : controlRequest(gatewaySocket, 'POST', '/switch', { port: to, expectedPort: from });
    await assert.rejects(command('switch', 5001, 35010));
    await assert.rejects(command('switch', 35011, 35099));
    assert.equal((await command('status')).port, 35010);
    const oldClient = new WebSocket(base.replace('http:', 'ws:') + '/socket.io/');
    const oldMessage = once(oldClient, 'message'), oldClosed = once(oldClient, 'close');
    assert.equal((await oldMessage)[0].data, 'old');
    const longWrite = fetch(base + '/api/write', { method: 'POST', body: 'delivery-update' }).then(response => response.text());
    resolveWrite = longWrite;
    await started;
    reading = true; let observed = 0;
    reader = (async () => {
      while (reading) {
        const response = await fetch(base + '/api/read'); assert.equal(response.status, 200);
        assert.ok(['old','new','candidate'].includes(await response.text())); observed++; await pause(2);
      }
    })().catch(error => { readerError = error; reading = false; });
    let committed = false, retired = false;
    const result = await handoffApi({ candidate: { role: 'web', releaseId: 'new', port: 35011 }, previous: { role: 'web', releaseId: 'old', port: 35010 }, ops: {
      recordPending: async () => {}, start: async () => {}, ready: async () => {},
      switchTraffic: (to, from) => command('switch', to, from),
      publicReady: async () => {
        for (let i = 0; i < 100; i++) { if (await (await fetch(base)).text() === 'new') { setTimeout(releaseWrite, 250); return; } await pause(10); }
        throw Error('New traffic not observed');
      },
      publishWebsite: async () => ({ changed: true }), commit: async () => { committed = true; }, clearPending: async () => {},
      retire: async (prior, workers) => {
        assert.equal(committed, true); assert.equal(retired, false);
        await controlRequest(socketPath, 'POST', '/drain');
        let pendingObserved = false;
        for (let i = 0; i < 150; i++) {
          const current = await controlRequest(socketPath);
          const state = { pending: gateway.status().active[workers] || 0 };
          if (current.activeRequests > 0 || state.pending > 0) pendingObserved = true;
          if (current.activeRequests === 0 && state.pending === 0) {
            assert.equal(pendingObserved, true); assert.equal(writes, 1);
            await new Promise(resolve => old.close(resolve)); retired = true; return;
          }
          await pause(10);
        }
        throw Error('Drain did not complete');
      },
      retirementResult: async () => {},
      discard: async () => { throw Error('Unexpected discard'); }, restoreTraffic: async () => { throw Error('Unexpected rollback'); }, rollbackWebsite: async () => {},
    } });
    assert.equal(result.retirementPending, false); assert.equal(retired, true);
    assert.equal(await longWrite, 'saved-once:delivery-update'); assert.equal(writes, 1);
    await oldClosed;
    const newClient = new WebSocket(base.replace('http:', 'ws:') + '/socket.io/');
    assert.equal((await once(newClient, 'message'))[0].data, 'new');
    assert.equal(worker.pid, workerPid); process.kill(workerPid, 0); assert.ok(beats > 3);
    assert.equal(await (await fetch(base)).text(), 'new');
    // A failed public check can happen after users have reached the candidate.
    // Rollback must drain that candidate too, rather than killing its POST.
    const candidateStarted = new Promise(resolve => { writeStarted = resolve; });
    const candidateReleased = new Promise(resolve => { releaseCandidate = resolve; });
    let candidateWrites = 0, discarded = false;
    const candidateRuntime = createApiRuntime({ settings: { releaseId: 'candidate' }, readiness: status });
    const bad = http.createServer((req, res) => candidateRuntime.track(req, res, async () => {
      if (req.method === 'POST') { for await (const chunk of req) {} writeStarted(); await candidateReleased; candidateWrites++; res.end('candidate-write-saved'); }
      else res.end('candidate');
    }));
    servers.push(bad); await new Promise(resolve => bad.listen(35012, '127.0.0.1', resolve));
    const candidateSocket = path.join(root, 'control/candidate.sock'); stopCandidateControl = await candidateRuntime.listen(candidateSocket);
    await assert.rejects(handoffApi({ candidate: { role: 'web', releaseId: 'candidate', port: 35012 }, previous: { role: 'web', releaseId: 'new', port: 35011 }, ops: {
      recordPending: async () => {}, start: async () => {}, ready: async () => {},
      switchTraffic: (to, from) => command('switch', to, from),
      publicReady: async selected => {
        if (selected.releaseId === 'candidate') {
          let routed = false;
          for (let i = 0; i < 100; i++) { if (await (await fetch(base)).text() === 'candidate') { routed = true; break; } await pause(10); }
          assert.equal(routed, true);
          rollbackWrite = fetch(base + '/api/write', { method: 'POST', body: 'one-write' }).then(response => response.text());
          await candidateStarted; setTimeout(releaseCandidate, 150); throw Error('public check failed');
        }
        assert.equal(await (await fetch(base)).text(), 'new');
      },
      restoreTraffic: (prior, current) => command('switch', prior.port, current.port),
      discard: async (selected, proof) => {
        assert.equal(proof.mayHaveServed, true);
        await controlRequest(candidateSocket, 'POST', '/drain');
        for (let i = 0; i < 150; i++) {
          const active = await controlRequest(candidateSocket), state = { pending: gateway.status().active[proof.drainToken] || 0 };
          if (active.activeRequests === 0 && state.pending === 0) {
            assert.equal(candidateWrites, 1); await new Promise(resolve => bad.close(resolve)); discarded = true; return;
          }
          await pause(10);
        }
        throw Error('Rollback drain timed out');
      },
      clearPending: async () => {},
    } }), /public check failed/);
    assert.equal(discarded, true); assert.equal(await rollbackWrite, 'candidate-write-saved');
    assert.equal(newClient.readyState, 1); newClient.close(); await once(newClient, 'close');
    assert.equal(await (await fetch(base)).text(), 'new');
    assert.equal(worker.pid, workerPid); process.kill(workerPid, 0);
    reading = false; await reader; assert.ok(observed > 0);
    if (readerError) throw Error(`Continuous read failed: ${readerError.cause?.code || readerError.message}`, { cause: readerError });
  } finally {
    reading = false; releaseWrite?.(); releaseCandidate?.();
    for (const socket of [...oldSockets, ...nextSockets]) socket.destroy();
    if (reader) await reader;
    if (resolveWrite) await resolveWrite;
    if (rollbackWrite) await rollbackWrite;
    if (nginx && nginx.exitCode === null) { const closed = once(nginx, 'exit'); nginx.kill('SIGTERM'); await closed; }
    await gateway?.close();
    for (const server of servers) { server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); }
    await stopControl?.();
    await stopCandidateControl?.();
    if (worker && worker.exitCode === null) { const closed = once(worker, 'exit'); worker.kill(); await closed; }
    await fs.rm(root, { recursive: true, force: true });
  }
});
