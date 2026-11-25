import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createApiGateway, prepareApiGateway } from './api-gateway.mjs';
import { listenPrivate } from './private-socket.mjs';
import { controlRequest } from './api-release.mjs';

test('gateway switches are conditional, durable and fail closed when state cannot be saved', { skip: process.platform !== 'linux' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'matter-gateway-'));
  const stateFile = path.join(root, 'state.json'), socketPath = path.join(root, 'control/gateway.sock');
  await fs.writeFile(stateFile, '{"version":1,"port":35010}');
  let gateway;
  t.after(async () => { await gateway?.close(); await fs.rm(root, { recursive: true, force: true }); });
  gateway = await createApiGateway({ stateFile, socketPath, port: 0 });
  const original = await controlRequest(socketPath);
  await assert.rejects(createApiGateway({ stateFile, socketPath, port: 0 }), /already running/);
  await assert.rejects(controlRequest(socketPath, 'POST', '/switch', { port: 5001, expectedPort: 35010 }));
  await assert.rejects(controlRequest(socketPath, 'POST', '/switch', { port: 35011, expectedPort: 5000 }));
  assert.equal((await controlRequest(socketPath)).port, 35010);
  await fs.writeFile(stateFile + '.next', 'interrupted evidence');
  await assert.rejects(controlRequest(socketPath, 'POST', '/switch', { port: 35011, expectedPort: 35010 }));
  assert.equal((await controlRequest(socketPath)).port, 35010);
  await fs.unlink(stateFile + '.next');
  const switched = await controlRequest(socketPath, 'POST', '/switch', { port: 35011, expectedPort: 35010 });
  assert.equal(switched.drainToken, 35010);
  await gateway.close(); gateway = null;
  gateway = await createApiGateway({ stateFile, socketPath, port: 0 });
  const restarted = await controlRequest(socketPath);
  assert.equal(restarted.port, 35011); assert.notEqual(restarted.instanceId, original.instanceId);
});

test('private control socket recovers after a crash but does not unlink an active listener', { skip: process.platform !== 'linux' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'matter-socket-'));
  const socket = path.join(root, 'control/fixture.sock'), childFile = path.join(root, 'child.mjs');
  const source = new URL('./private-socket.mjs', import.meta.url).href;
  await fs.writeFile(childFile, `import http from 'node:http';const {listenPrivate}=await import(${JSON.stringify(source)});await listenPrivate(http.createServer((q,s)=>s.end('{}')),${JSON.stringify(socket)});process.send('ready');`);
  const child = fork(childFile, [], { stdio: ['ignore','ignore','inherit','ipc'] });
  let close;
  t.after(async () => { if (child.exitCode === null) child.kill('SIGKILL'); await close?.(); await fs.rm(root, { recursive: true, force: true }); });
  await once(child, 'message'); const stopped = once(child, 'exit'); child.kill('SIGKILL'); await stopped;
  assert.equal((await fs.lstat(socket)).isSocket(), true);
  close = await listenPrivate(http.createServer((req, res) => res.end('{}')), socket);
  await assert.rejects(listenPrivate(http.createServer(), socket), /already running/);
  assert.deepEqual(await controlRequest(socket), {});
});

test('gateway preparation is stage-only and refuses to overwrite its pinned runtime or route', { skip: process.platform !== 'linux' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'matter-gateway-stage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'server')); await fs.writeFile(path.join(root, 'server/.env'), 'fixture-private-settings');
  const result = await prepareApiGateway(root);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  const processFile = JSON.parse(await fs.readFile(path.join(root, '.api/gateway-process.private.json')));
  assert.equal(processFile.apps[0].name, 'matter-api-gateway'); assert.equal(processFile.apps[0].env, undefined);
  const route = await fs.readFile(path.join(root, '.api/upstream.json'), 'utf8');
  assert.equal(JSON.parse(route).port, 5000);
  await assert.rejects(prepareApiGateway(root));
  assert.equal(await fs.readFile(path.join(root, '.api/upstream.json'), 'utf8'), route);
  assert.equal(await fs.readFile(path.join(root, 'server/.env'), 'utf8'), 'fixture-private-settings');
});
