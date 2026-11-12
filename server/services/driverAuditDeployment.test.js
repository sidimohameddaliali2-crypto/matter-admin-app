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

const digest = value => value.repeat(64);
const proofIdentity = {
  generation: digest('1'), reportHash: digest('2'), descriptorSha256: digest('3'),
  manifestSha256: digest('4'), sourceRevision: 2118,
};
const seed = {
  pointer: { generation: proofIdentity.generation, reportHash: proofIdentity.reportHash, descriptor: { sha256: proofIdentity.descriptorSha256 } },
  manifestSha256: proofIdentity.manifestSha256, collectorRevision: proofIdentity.sourceRevision,
};
const journey = { servedSnapshot: true, verifiedPhoto: true, verifiedGps: true, reviewHistoryMatches: true, signedOutDenied: true, logout: true };

function proofFixture() {
  return {
    version: 1, scope: 'isolated-loopback-Mongo-only', implementationSha256: digest('5'),
    appCommit: 'a'.repeat(40), appRuntimeManifestSha256: digest('6'),
    archiveEvidence: { seedVerifiedCacheCopies: 238, seedVerifiedObjectIndexSha256: digest('7') },
    previous: { ...proofIdentity, archiveRestore: { files: 232, manifestSha256: digest('8') } },
    oldest: { postCollectionArchiveRead: { files: 232, manifestSha256: digest('9') } },
    collection: { objectsRemoved: 8, bytesReclaimed: 20, usedBefore: 100, usedAfter: 80, activeKeys: 238,
      previousKeys: 238, stagedKeys: 2, orphanProtected: true },
    reviews: { copied: true, unchanged: true, count: 14, sha256: digest('a'), journalWrites: 0 },
    checks: { baseline: journey, rollback: journey, archiveFallback: journey, currentPointerUnchanged: true, completeEmptyReplicaRestore: true },
    traffic: { productionRequests: 0, productionWrites: 0 },
  };
}

test('retention proof must be privately archived, exact and bound to the qualified implementation and approved seed', async () => {
  const { createHash } = await import('node:crypto');
  const { readDriverAuditRetentionProof } = await import('../scripts/driverAuditDeploy.js');
  const proof = proofFixture();
  async function load(value, overrides = {}) {
    const body = Buffer.from(JSON.stringify(value));
    const expectedSha256 = createHash('sha256').update(body).digest('hex');
    let privateChecked = false;
    const archive = {
      async assertPrivate() { privateChecked = true; },
      async readObject(key, { maxBytes }) {
        assert.ok(privateChecked);
        assert.equal(key, (overrides.expectedSha256 || expectedSha256) + '.json');
        assert.ok(maxBytes <= 16 * 1024);
        return [body];
      },
    };
    return readDriverAuditRetentionProof({ archive, expectedSha256, seed, implementationSha256: digest('5'), ...overrides });
  }
  await load(proof);
  await assert.rejects(load(proof, { expectedSha256: digest('f') }), /restore and rollback proof/i);
  await assert.rejects(load(proof, { implementationSha256: digest('f') }), /restore and rollback proof/i);
  await assert.rejects(load(proof, { seed: { ...seed, collectorRevision: 2119 } }), /restore and rollback proof/i);
  await assert.rejects(load({ ...proof, reviews: { ...proof.reviews, journalWrites: 1 } }), /restore and rollback proof/i);
  await assert.rejects(load({ ...proof, checks: { ...proof.checks, archiveFallback: { ...journey, verifiedPhoto: false } } }), /restore and rollback proof/i);
});

function livePointer(identity, sourceBodySha256) {
  const { generation, reportHash, descriptorSha256, manifestSha256, sourceRevision } = identity;
  return {
    version: 1, generation, reportHash, descriptor: { sha256: descriptorSha256 }, sourceRevision, sourceBodySha256,
    directImport: { version: 1, collectorRevision: sourceRevision, manifestSha256, sourceBasis: digest('9') },
    restore: { version: 1, archive: 'matter-report-archive', verified: true, generation, reportHash, descriptorSha256, manifestSha256 },
  };
}

test('retention pins the current and previous identities and rejects changes during the stop', async () => {
  const { checkDriverAuditRetentionHead, restartDriverAuditRetention } = await import('../scripts/driverAuditDeploy.js');
  const previous = livePointer(proofIdentity, digest('e'));
  const active = livePointer({ ...proofIdentity, generation: digest('b'), sourceRevision: 2124 }, digest('d'));
  const head = { ...active, previous };
  const generations = active.generation + ':' + previous.generation;
  const identity = checkDriverAuditRetentionHead(head, generations);
  assert.throws(() => checkDriverAuditRetentionHead({ ...head, previous: { ...previous, restore: undefined } }, generations), /active or previous/i);
  assert.throws(() => checkDriverAuditRetentionHead(head, previous.generation + ':' + active.generation), /active or previous/i);
  const calls = [];
  await assert.rejects(restartDriverAuditRetention({
    async checkHead() {
      const changed = checkDriverAuditRetentionHead({ ...head, sourceBodySha256: digest('c') }, generations);
      assert.deepEqual(changed, identity, 'changed head');
    },
    async stop() { calls.push('stop'); },
    async restart() { calls.push('restart'); },
    async wait() { calls.push('wait'); },
    async save() { calls.push('save'); },
    async writeSettings(enabled) { calls.push('settings:' + enabled); },
    async writeReceipt(enabled) { calls.push('receipt:' + enabled); },
  }), /changed head/i);
  assert.deepEqual(calls, ['stop','restart','wait','save']);
});

test('retention restarts only the supervised worker and restores the exact prior settings and receipt on failure', async () => {
  const { restartDriverAuditRetention } = await import('../scripts/driverAuditDeploy.js');
  async function run({ failStartup }) {
    const calls = [];
    let gc = false;
    let waits = 0;
    const task = restartDriverAuditRetention({
      async checkHead() { calls.push('head'); },
      async stop() { calls.push('stop'); },
      async restart() { calls.push('restart'); },
      async wait() {
        calls.push('wait');
        if (failStartup && waits++ === 0) throw Error('startup failed');
      },
      async save() { calls.push('save'); },
      async writeSettings(enabled) { calls.push('settings:' + enabled); gc = enabled; },
      async writeReceipt(enabled) { calls.push('receipt:' + enabled); },
    });
    if (failStartup) await assert.rejects(task, /startup failed/);
    else await task;
    assert.equal(gc,!failStartup);
    return calls;
  }
  const attempt = ['stop','head','receipt:true','settings:true','restart','wait'];
  assert.deepEqual(await run({ failStartup: false }), [...attempt,'save']);
  assert.deepEqual(await run({ failStartup: true }), [...attempt,'stop','settings:false','receipt:false','restart','wait','save']);
});
