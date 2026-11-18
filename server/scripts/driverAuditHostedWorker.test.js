import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sealDriverAuditHostedCache } from '../services/driverAuditHostedCache.js';
import { allowEncryptedCacheSave, hostedDriverAuditFixtureArchive, hostedDriverAuditWorkerSettings, requireHostedDriverAuditEnrollment,
  requireHostedDriverAuditQualification } from './driverAuditHostedWorker.js';

const releaseSha = 'a'.repeat(40), nodeVersion = 'v24.22.1';
const binding = { releaseSha, nodeVersion, bootstrapSha256: 'b'.repeat(64), activationSha256: 'c'.repeat(64),
  pinsSha256: 'd'.repeat(64), fixtureSha256: 'e'.repeat(64), syncSha256: 'f'.repeat(64), sourceConfigSha256: '1'.repeat(64) };
const runtime = { platform: 'linux', version: nodeVersion };
const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'sidimohameddaliali2-crypto/matter-admin-app',
  GITHUB_REF: 'refs/heads/main', GITHUB_SHA: releaseSha, GITHUB_EVENT_NAME: 'workflow_dispatch',
  DRIVER_AUDIT_WORKER_RELEASE_SHA: releaseSha, DRIVER_AUDIT_WORKER_CHECKOUT_SHA: releaseSha,
  DRIVER_AUDIT_WORKER_BOOTSTRAP_SHA256: binding.bootstrapSha256,
  DRIVER_AUDIT_WORKER_CACHE_KEY: Buffer.alloc(32, 12).toString('base64'), DRIVER_AUDIT_WORKER_SUPABASE_SECRET: 'fixture-credential-only-000' };

test('qualification is manual and scheduled slots require main, exact code, a Linux runner and an explicit arming flag', () => {
  const settings = hostedDriverAuditWorkerSettings(env, '--qualify', runtime);
  assert.equal(settings.releaseSha, releaseSha);
  assert.deepEqual(settings.cacheKey, Buffer.alloc(32, 12));
  assert.throws(() => hostedDriverAuditWorkerSettings(env, '--once', runtime));
  const scheduled = { ...env, GITHUB_EVENT_NAME: 'schedule', DRIVER_AUDIT_WORKER_ARMED: '1' };
  assert.equal(hostedDriverAuditWorkerSettings(scheduled, '--once', runtime).bootstrapSha256, binding.bootstrapSha256);
  assert.throws(() => hostedDriverAuditWorkerSettings(scheduled, '--qualify', runtime));
  for (const override of [{ GITHUB_REF: 'refs/heads/topic' }, { GITHUB_REPOSITORY: 'other/repo' },
    { GITHUB_SHA: 'not a commit' }, { DRIVER_AUDIT_WORKER_CHECKOUT_SHA: '3'.repeat(40) },
    { DRIVER_AUDIT_WORKER_BOOTSTRAP_SHA256: '../fixture' },
    { DRIVER_AUDIT_WORKER_CACHE_KEY: Buffer.alloc(32).toString('base64') }, { DRIVER_AUDIT_WORKER_SUPABASE_SECRET: '' }]) {
    assert.throws(() => hostedDriverAuditWorkerSettings({ ...scheduled, ...override }, '--once', runtime));
  }
  assert.throws(() => hostedDriverAuditWorkerSettings(scheduled, '--once', { ...runtime, platform: 'darwin' }));
});

test('an unrelated event-head change allows the same approved worker checkout', () => {
  const event = { ...env, GITHUB_SHA: '3'.repeat(40), GITHUB_EVENT_NAME: 'schedule', DRIVER_AUDIT_WORKER_ARMED: '1' };
  assert.equal(hostedDriverAuditWorkerSettings(event, '--once', runtime).releaseSha, releaseSha);
  assert.throws(() => hostedDriverAuditWorkerSettings({ ...event, DRIVER_AUDIT_WORKER_CHECKOUT_SHA: event.GITHUB_SHA }, '--once', runtime));
});

function qualification() {
  const MiB = 1024 ** 2;
  const usage = (day, usedBytes) => ({ version: 1, basis: 'supabase-http-bytes-v1',
    month: { period: '2026-11', usedBytes, reservedBytes: 0, limitBytes: 8192 * MiB },
    day: { period: day, usedBytes, reservedBytes: 0, limitBytes: 512 * MiB }, activeReservations: 0, uncertainReservations: 0 });
  return { version: 1, kind: 'driver-report-hosted-linux-qualification-v1', verified: true, platform: 'linux', ...binding,
    qualifiedAt: '2026-11-18T00:00:00.000Z', builderCandidateManifestSha256: '2'.repeat(64),
    deliveryScopeFixtureVerified: true,
    measurements: { coldArchiveReads: { requests: 5, bytes: 10 }, warmArchiveReads: { requests: 1, bytes: 2 },
      sourcePeakBytes: MiB, builderPeakBytes: MiB, memoryAvailableWithBuilderBytes: 900 * MiB,
      fixtureArchiveBytes: 1, builderArchiveBytes: 0 },
    transferUsage: { before: usage('2026-11-18', 1), after: usage('2026-11-18', 2) } };
}

test('held and stale qualification receipts cannot authorize source work', () => {
  const now = Date.parse('2026-11-19T00:00:00Z');
  assert.deepEqual(requireHostedDriverAuditQualification(qualification(), binding, now), qualification());
  for (const mutate of [receipt => { receipt.verified = false; }, receipt => { receipt.sourceConfigSha256 = '0'.repeat(64); },
    receipt => { receipt.qualifiedAt = '2026-11-20T00:00:00.000Z'; }, receipt => { receipt.measurements.warmArchiveReads.requests = 5; },
    receipt => { receipt.measurements.memoryAvailableWithBuilderBytes = 1; }, receipt => { receipt.transferUsage.after.day.usedBytes = 0; },
    receipt => { delete receipt.deliveryScopeFixtureVerified; }]) {
    const receipt = qualification(); mutate(receipt);
    assert.throws(() => requireHostedDriverAuditQualification(receipt, binding, now));
  }
  assert.throws(() => requireHostedDriverAuditQualification(null, binding, now));
});

test('enrollment belongs to the qualified config and succeeds the isolated proof', () => {
  const now = Date.parse('2026-11-19T07:00:00Z');
  const enrollment = { version: 1, sourceSha256: binding.sourceConfigSha256, syncSha256: binding.syncSha256,
    armedAt: '2026-11-19T00:15:00.000Z' };
  assert.strictEqual(requireHostedDriverAuditEnrollment(enrollment, binding, qualification(), now), enrollment);
  for (const override of [{ syncSha256: '0'.repeat(64) }, { armedAt: '2026-11-17T00:15:00.000Z' },
    { armedAt: '2026-11-20T00:15:00.000Z' }]) {
    assert.throws(() => requireHostedDriverAuditEnrollment({ ...enrollment, ...override }, binding, qualification(), now));
  }
});

test('workflow has the two Dubai slots and runs on a protected, serialized GitHub runner', async () => {
  const yaml = await fs.readFile(new URL('../../.github/workflows/driver-reports-worker.yml', import.meta.url), 'utf8');
  assert.deepEqual([...yaml.matchAll(/cron: '([^']+)'/g)].map(match => match[1]), ['30 6 * * *', '0 8 * * *']);
  assert.match(yaml, /environment: driver-reports-worker/);
  assert.match(yaml, /cancel-in-progress: false/);
  assert.match(yaml, /persist-credentials: false/);
  assert.match(yaml, /ref: \$\{\{ vars\.DRIVER_AUDIT_WORKER_RELEASE_SHA \}\}/);
  assert.match(yaml, /git merge-base --is-ancestor "\$checked_out" "\$GITHUB_SHA"/);
  assert.match(yaml, /cache-v1-\$\{\{ vars\.DRIVER_AUDIT_WORKER_RELEASE_SHA \}\}-\$\{\{ vars\.DRIVER_AUDIT_WORKER_BOOTSTRAP_SHA256 \}\}/);
  assert.doesNotMatch(yaml, /github\.sha == vars\.DRIVER_AUDIT_WORKER_RELEASE_SHA/);
  assert.match(yaml, /node-version: '24\.22\.1'/);
  assert.equal([...yaml.matchAll(/path: \$\{\{ runner\.temp \}\}\/driver-report-worker-cache-v1\/archive\.aes/g)].length, 2);
  assert.match(yaml, /always\(\) && github\.ref == 'refs\/heads\/main' && steps\.worker\.outputs\.encrypted-cache-ready == '1'/);
  assert.match(yaml, /actions\/cache\/restore@[a-f0-9]{40}/);
  assert.match(yaml, /actions\/cache\/save@[a-f0-9]{40}/);
  assert.doesNotMatch(yaml, /pull_request|upload-artifact|self-hosted/);
});

test('qualification uses the separately materialized private fixture and meters evidence object reads', async t => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'hosted-worker-fixture-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixturePath = path.join(root, 'source-replay.private.json.gz');
  const fixture = Buffer.from('synthetic sealed manifest fixture');
  const fixtureSha256 = createHash('sha256').update(fixture).digest('hex');
  await fs.writeFile(fixturePath, fixture, { mode: 0o600 });
  const evidence = 'c'.repeat(64) + '.gz', requests = [];
  const archive = hostedDriverAuditFixtureArchive({ root, fixturePath, fixtureSha256,
    readArchive(key, options) { requests.push([key, options]); return [Buffer.from('evidence')]; } });
  const options = { maxBytes: 1024 * 1024 };
  assert.deepEqual(await archive.readObject(fixtureSha256 + '.gz', options), [fixture]);
  assert.deepEqual(requests, []);
  assert.deepEqual(await archive.readObject(evidence, options), [Buffer.from('evidence')]);
  assert.deepEqual(requests, [[evidence, options]]);
  await fs.writeFile(fixturePath, 'modified fixture');
  await assert.rejects(archive.readObject(fixtureSha256 + '.gz', options));
});

test('cache save output requires a fresh encrypted checkpoint and the actual sealed format', async t => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'hosted-worker-cache-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cacheDirectory = path.join(root, 'cache');
  await fs.mkdir(cacheDirectory, { mode: 0o700 });
  const bytes = Buffer.from('synthetic fixture object');
  await fs.writeFile(path.join(cacheDirectory, createHash('sha256').update(bytes).digest('hex') + '.gz'), bytes, { mode: 0o600 });
  const sealed = [], key = Buffer.alloc(32, 5);
  await sealDriverAuditHostedCache({ cacheDirectory, releaseSha, namespace: 'fixture-cache', key, write: entry => sealed.push(entry) });
  const archive = path.join(root, 'archive.aes'), GITHUB_OUTPUT = path.join(root, 'github-output');
  await fs.writeFile(archive, Buffer.concat(sealed), { mode: 0o600 });
  await allowEncryptedCacheSave({ GITHUB_OUTPUT }, archive, { cacheSaved: false });
  await assert.rejects(fs.stat(GITHUB_OUTPUT), { code: 'ENOENT' });
  await allowEncryptedCacheSave({ GITHUB_OUTPUT }, archive, { cacheSaved: true });
  assert.equal(await fs.readFile(GITHUB_OUTPUT, 'utf8'), 'encrypted-cache-ready=1\n');
  await fs.writeFile(archive, bytes, { mode: 0o600 });
  await assert.rejects(allowEncryptedCacheSave({ GITHUB_OUTPUT }, archive, { cacheSaved: true }));
  assert.equal(await fs.readFile(GITHUB_OUTPUT, 'utf8'), 'encrypted-cache-ready=1\n');
});
