import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { manageDriverAuditSource } from '../scripts/driverAuditSourceDeploy.js';

async function fixture(t, { running = false, failReadiness = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'driver-audit-source-deploy-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = { root, file: path.join(root, 'source.json'), configSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64) };
  let worker = running ? { id: 4, status: 'online', config: config.file } : null;
  let receipt = null;
  const calls = [];
  const adapter = {
    async worker() { return worker; },
    async check() { calls.push('check'); },
    async verifyRelease() { calls.push('release'); return { sha256: 'c'.repeat(64) }; },
    async readActivation() { return receipt; },
    async writeActivation(value) { receipt = value; calls.push('receipt:' + value.status); },
    async start() { calls.push('start'); worker = { id: 4, status: 'online', config: config.file }; },
    async stop() { calls.push('stop'); if (worker) worker.status = 'stopped'; },
    async wait() { calls.push('wait'); if (failReadiness) throw Error('readiness failed'); },
    async save() { calls.push('save'); },
  };
  return { config, adapter, calls, worker: () => worker, receipt: () => receipt };
}

test('source preflight checks imports without activating a worker', async t => {
  const f = await fixture(t);
  assert.equal((await manageDriverAuditSource({ operation: 'check', config: f.config, adapter: f.adapter })).status, 'checked');
  assert.deepEqual(f.calls, ['check']);
  assert.equal(f.worker(), null);
});

test('source start validates fresh proof, saves activation before dispatch and waits for readiness', async t => {
  const f = await fixture(t);
  assert.equal((await manageDriverAuditSource({ operation: 'start', config: f.config, adapter: f.adapter })).status, 'started');
  assert.deepEqual(f.calls, ['check', 'release', 'receipt:active', 'start', 'wait', 'save']);
  assert.equal(f.receipt().configSha256, f.config.configSha256);
  assert.equal(f.worker().status, 'online');
});

test('failed source startup stops the worker and preserves a retryable activation receipt', async t => {
  const f = await fixture(t, { failReadiness: true });
  await assert.rejects(manageDriverAuditSource({ operation: 'start', config: f.config, adapter: f.adapter }), /readiness failed/);
  assert.equal(f.worker().status, 'stopped');
  assert.equal(f.receipt().status, 'active');
  assert.equal(f.calls.at(-1), 'save');
});

test('source pause resumes only the same activated configuration and rollback prevents resurrection', async t => {
  const f = await fixture(t);
  await manageDriverAuditSource({ operation: 'start', config: f.config, adapter: f.adapter });
  await manageDriverAuditSource({ operation: 'pause', config: f.config, adapter: f.adapter });
  assert.equal(f.worker().status, 'stopped');
  await manageDriverAuditSource({ operation: 'resume', config: f.config, adapter: f.adapter });
  assert.equal(f.worker().status, 'online');
  await manageDriverAuditSource({ operation: 'rollback', config: f.config, adapter: f.adapter });
  assert.equal(f.worker().status, 'stopped');
  assert.equal(f.receipt().status, 'rolled-back');
  await assert.rejects(manageDriverAuditSource({ operation: 'resume', config: f.config, adapter: f.adapter }), /activation/i);
});

test('source controls refuse another registered configuration and keep inactive deploys inert', async t => {
  const f = await fixture(t);
  assert.equal((await manageDriverAuditSource({ operation: 'pause', config: f.config, adapter: f.adapter })).status, 'inactive');
  f.adapter.worker = async () => ({ id: 8, status: 'online', config: '/other/source.json' });
  await assert.rejects(manageDriverAuditSource({ operation: 'pause', config: f.config, adapter: f.adapter }), /configuration/i);
  assert.deepEqual(f.calls, []);
});

test('source pause and rollback stop a worker waiting for automatic restart', async t => {
  for (const operation of ['pause', 'rollback']) {
    const f = await fixture(t);
    await manageDriverAuditSource({ operation: 'start', config: f.config, adapter: f.adapter });
    f.worker().status = 'waiting restart';
    await manageDriverAuditSource({ operation, config: f.config, adapter: f.adapter });
    assert.equal(f.worker().status, 'stopped');
  }
});

test('source host check runs read-only and an ordinary deployment keeps an absent source worker inactive', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'source-host-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const server = path.join(root, 'server');
  await fs.mkdir(path.join(server, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(server, 'services'));
  await fs.writeFile(path.join(server, 'package.json'), '{"type":"module"}');
  for (const file of ['driverAuditSourceDeploy.js', 'driverAuditSource.js', 'driverAuditSourceStage.js']) {
    await fs.copyFile(fileURLToPath(new URL('../scripts/' + file, import.meta.url)), path.join(server, 'scripts', file));
  }
  await fs.copyFile(fileURLToPath(new URL('./driverAuditSource.js', import.meta.url)), path.join(server, 'services/driverAuditSource.js'));
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  const commit = 'a'.repeat(40);
  await fs.writeFile(path.join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' '${commit}'\n`, { mode: 0o700 });
  await fs.writeFile(path.join(bin, 'pm2'), '#!/bin/sh\n[ "$1" = jlist ] || exit 1\nprintf "[]\\n"\n', { mode: 0o700 });
  const env = { PATH: bin, DRIVER_AUDIT_DEPLOY_SHA: commit, DRIVER_AUDIT_SOURCE_NODE: process.execPath };
  const script = path.join(server, 'scripts/driverAuditSourceDeploy.js');
  const exec = promisify(execFile);
  const result = await exec(process.execPath, [script, 'audit-source-host-check'], { env });
  const host = JSON.parse(result.stdout);
  assert.equal(host.status, 'host-checked');
  assert.equal(host.deployedSha, commit);
  assert.ok(host.nodes.some(node => node.version === process.version && node.sqlite));
  assert.equal((await fs.readdir(server)).includes('.private'), false);
  const pause = await exec(process.execPath, [script, 'deploy-source-pause'], { env });
  assert.equal(JSON.parse(pause.stdout).status, 'inactive');
});
