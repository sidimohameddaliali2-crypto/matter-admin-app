import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import dotenv from 'dotenv';
import { writeDriverAuditEnvironment } from '../scripts/driverAuditDeploy.js';

const settings = {
  DRIVER_AUDIT_ENABLED: '1',
  DRIVER_AUDIT_IMPORT_ENABLED: '0',
  DRIVER_AUDIT_REPLICA_GC_ENABLED: '0',
  DRIVER_AUDIT_ORIGIN: 'https://matterapp.online',
  DRIVER_AUDIT_CAPACITY_BYTES: '134217728',
  DRIVER_AUDIT_SUPABASE_SECRET: 'test-reporting-credential',
};
const exec = promisify(execFile);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'driver-audit-deploy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, envFile: path.join(root, '.env.local') };
}

test('audit config preserves unrelated values, survives retries, and rolls back without retaining the new secret', async t => {
  const { root, envFile } = await fixture(t);
  const original = '# app settings\nCUSTOMER_SERVICE_STORAGE=supabase\nAPP_CERT="line one\nDRIVER_AUDIT_ENABLED=old text\nline three"\n';
  await fs.writeFile(envFile, original, { mode: 0o644 });

  await writeDriverAuditEnvironment(root, settings);
  const configured = await fs.readFile(envFile, 'utf8');
  assert.ok(configured.startsWith(original));
  assert.deepEqual(dotenv.parse(configured), { ...dotenv.parse(original), ...settings });
  assert.equal((await fs.stat(envFile)).mode & 0o777, 0o600);
  await writeDriverAuditEnvironment(root, settings);
  assert.equal(await fs.readFile(envFile, 'utf8'), configured);

  const disabled = { DRIVER_AUDIT_ENABLED: '0', DRIVER_AUDIT_IMPORT_ENABLED: '0', DRIVER_AUDIT_REPLICA_GC_ENABLED: '0' };
  await writeDriverAuditEnvironment(root, disabled);
  const rolledBack = await fs.readFile(envFile, 'utf8');
  assert.ok(rolledBack.startsWith(original));
  assert.deepEqual(dotenv.parse(rolledBack), { ...dotenv.parse(original), ...disabled });
});

test('replica retention can be persisted only with an enabled audit and a strict flag', async t => {
  const { root, envFile } = await fixture(t);
  const approvedSync = { ...settings, DRIVER_AUDIT_REPLICA_GC_ENABLED: '1' };
  await writeDriverAuditEnvironment(root, approvedSync);
  assert.equal(dotenv.parse(await fs.readFile(envFile)).DRIVER_AUDIT_REPLICA_GC_ENABLED, '1');
  await assert.rejects(writeDriverAuditEnvironment(root, {
    DRIVER_AUDIT_ENABLED: '0', DRIVER_AUDIT_IMPORT_ENABLED: '0', DRIVER_AUDIT_REPLICA_GC_ENABLED: '1',
  }), /Invalid driver audit settings/);
  await assert.rejects(writeDriverAuditEnvironment(root, { ...approvedSync, DRIVER_AUDIT_REPLICA_GC_ENABLED: 'true' }), /Invalid driver audit settings/);
  assert.equal(dotenv.parse(await fs.readFile(envFile)).DRIVER_AUDIT_REPLICA_GC_ENABLED, '1');
});

test('audit config refuses a symlink and preserves its target', async t => {
  const { root, envFile } = await fixture(t);
  const target = path.join(root, 'other.env');
  await fs.writeFile(target, 'UNCHANGED=1\n', { mode: 0o600 });
  await fs.symlink(target, envFile);
  await assert.rejects(writeDriverAuditEnvironment(root, settings), /regular file/);
  assert.equal(await fs.readFile(target, 'utf8'), 'UNCHANGED=1\n');
});

test('an ordinary deployment leaves an unregistered audit worker inactive', async t => {
  const { root } = await fixture(t);
  const server = path.join(root, 'server');
  const scripts = path.join(server, 'scripts');
  const bin = path.join(root, 'bin');
  await fs.mkdir(scripts, { recursive: true });
  await fs.mkdir(bin);
  await fs.writeFile(path.join(server, 'package.json'), '{"type":"module"}');
  const script = path.join(scripts, 'driverAuditDeploy.js');
  await fs.copyFile(fileURLToPath(new URL('../scripts/driverAuditDeploy.js', import.meta.url)), script);
  const commit = 'a'.repeat(40);
  await fs.writeFile(path.join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' '${commit}'\n`, { mode: 0o700 });
  await fs.writeFile(path.join(bin, 'pm2'), '#!/bin/sh\n[ "$1" = jlist ] || exit 1\nprintf "[]\\n"\n', { mode: 0o700 });
  const env = { PATH: bin, DRIVER_AUDIT_DEPLOY_SHA: commit };
  const result = await exec(process.execPath, [script, 'deploy-worker-pause'], { env });
  assert.equal(result.stdout.trim(), 'inactive');
  await assert.rejects(exec(process.execPath, [script, 'deploy-worker-resume'], { env }), /not paused/);
  await assert.rejects(exec(process.execPath, [script, 'deploy-worker-pause'], {
    env: { ...env, DRIVER_AUDIT_DEPLOY_SHA: 'b'.repeat(40) },
  }), /differs from the reviewed commit/);
  await assert.rejects(exec(process.execPath, [script, 'deploy-worker-pause'], {
    env: { ...env, DRIVER_AUDIT_GC_RESTORE_RECEIPT_SHA256: 'c'.repeat(64) },
  }), /requires the reviewed restore receipt SHA-256 on audit-sync-start/);
});
