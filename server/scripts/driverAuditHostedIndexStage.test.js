import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { archiveBytes } from '../vendor/driver-audits/integration/cloud/repository.mjs';
import { sealDriverAuditHostedIndexBundle } from './driverAuditHostedIndexBundle.js';
import { runDriverAuditHostedIndexStage } from './driverAuditHostedIndexStage.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const date = '2027-10-09T00:00:00.000Z';
const key = 'app-sidi-report-head';
const json = value => Buffer.from(JSON.stringify(value));

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'hosted-index-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const remote = new Map(), reads = [], writes = [], selections = [], reservations = new Map();
  const archive = {
    async assertPrivate() { return { public: false }; },
    async readObject(name, { maxBytes }) {
      reads.push(name);
      const bytes = remote.get(name);
      if (!bytes) throw Object.assign(Error('Fixture object missing'), { code: 'storage_not_found' });
      assert.ok(bytes.length <= maxBytes);
      return [Buffer.from(bytes)];
    },
    async putVerifiedObject(name, bytes) {
      writes.push(name); remote.set(name, Buffer.from(bytes));
      return { key: name, sha256: sha(bytes), bytes: bytes.length, verified: true };
    },
  };
  const browser = json({ fixture: true }), generation = sha(browser), reportHash = sha('report'), catalog = sha('catalog');
  const manifestSha256 = sha('original manifest'), sourceBasis = sha('original basis');
  const snapshot = { sha256: generation, url: 'report-data/snapshot-' + generation + '.json' };
  const files = {};
  for (const [name, bytes] of Object.entries({
    'publication.private.json': json({ head: { reportHash, manifest: snapshot, source: { observedAt: date } }, catalog: { sha256: catalog } }),
    'identities.private.json': json({}), 'maps.private.json': json({}), 'gps-index.private.json.gz': gzipSync(json({})),
    'preview-read-view.private.json.gz': gzipSync(json({ reportHash, generation, catalogHash: catalog, browser: snapshot, gpsRows: [] })),
    'renderer.private.html': Buffer.from('<html>Fixture</html>'), 'build.private.json': json({}), 'browser-data.private.json.gz': gzipSync(browser),
  })) files[name] = await archiveBytes(archive, bytes, { domain: 'previewRuntime', path: name });
  const descriptor = await archiveBytes(archive, json({ version: 1, files, sourceManifestSha256: manifestSha256, reportHash, generation }),
    { domain: 'previewPackage', path: 'descriptor.json' });
  const binding = { manifestSha256, generation, reportHash, descriptorSha256: descriptor.sha256 };
  const candidate = { version: 1, generation, reportHash, descriptor,
    servingPackage: { version: 1, dataStore: 'supabase', collectorRevision: 8, sourceBasis, manifestSha256 },
    closureReceipt: { version: 1, status: 'verified', sourceBasis, ...binding, checkedAt: date,
      checks: { archive: true, photos: true, reviewHistory: true } },
    restore: { version: 1, archive: 'matter-report-archive', verified: true, ...binding }, visibleCutoffAt: date,
  };
  const old = { ...candidate, servingPackage: { ...candidate.servingPackage, collectorRevision: 7 } };
  const oldBody = JSON.stringify(old);
  candidate.previous = old;
  const light = gzipSync(json({ version: 1, generation, reportHash, catalog: { sha256: catalog }, visibleCutoffAt: date,
    review: { snapshotHash: reportHash }, days: [], records: 0, history: { staffRows: 0 } }));
  candidate.lightView = { sha256: sha(light), size: light.length };
  const objects = new Map([[sha(light) + '.gz', light]]);
  const paritySha256 = sha('fixture parity'), sourceBody = JSON.stringify({ fixture: true });
  const records = new Map([[key, { revision: 3, body_text: oldBody }], ['collector-state', { revision: 8, body_text: sourceBody }]]);
  const journals = Array.from({ length: 7 }, (_, i) => {
    const name = `archive-fixture-${i}:review-journal`, body_text = JSON.stringify({ fixture: i });
    records.set(name, { revision: i + 1, body_text });
    return { key: name, revision: i + 1, bodySha256: sha(body_text) };
  });
  const proof = { version: 1, kind: 'driver-audit-hosted-index-cutover', notBefore: date, expectedOldSha: '1'.repeat(40),
    expectedHead: { sourceRevision: 3, sourceBodySha256: sha(oldBody) },
    collector: { revision: 8, bodySha256: sha(sourceBody), eventId: 'fixture-source-event' }, journals, paritySha256,
    uploads: { endpoint: 'nyc3.digitaloceanspaces.com', bucket: 'fixture-photos', region: 'nyc3' } };
  const contents = { candidate: json(candidate), proof: json(proof), objects,
    stagedIndex: json({ version: 1, scope: 'verified-fixture-index', published: false, activated: false,
      independentParitySha256: paritySha256, collectorRevision: 8, originalDescriptorSha256: descriptor.sha256,
      lightView: candidate.lightView, objectCount: 1, objectBytes: light.length, originalGpsPhotosReviewsRemainInExistingArchive: true,
      archives: Array.from(objects, ([key, bytes]) => ({ key, bytes: bytes.length })) }) };
  const receipts = [{ revision: 8, event_id: proof.collector.eventId, body_sha256: proof.collector.bodySha256,
    request_sha256: sha('source request'), body_text: sourceBody, event_text: '{}' }];
  let usage = 512 * 1024 ** 2;
  const backend = {
    archive,
    archiveReadBudget: { async reserve() { return { allowed: true }; }, async settle() { return { settled: true }; } },
    async readTransferUsage() { return { day: { period: date.slice(0, 10), limitBytes: usage, usedBytes: 0, reservedBytes: 0 },
      month: { period: date.slice(0, 7), limitBytes: 8 * 1024 ** 3, usedBytes: 0, reservedBytes: 0 }, activeReservations: 0 }; },
    rpcForResponseLimit() { return async (method, args) => {
      if (method === 'matter_hosted_state_read') return records.get(args.p_key);
      if (method === 'matter_hosted_state_receipts') return (args.p_key === key ? selections : receipts).filter(row => row.revision > args.p_after).slice(0, 1);
      if (method === 'matter_hosted_state_cas') {
        assert.equal(args.p_key, key);
        assert.equal(args.p_expected, records.get(key).revision);
        const row = { revision: args.p_expected + 1, body_text: args.p_body_text };
        records.set(key, row);
        const receipt = { ...row, event_id: args.p_event_id, body_sha256: sha(args.p_body_text), event_text: args.p_event_text,
          request_sha256: sha(args.p_request_text), replayed: false };
        selections.push(receipt);
        return receipt;
      }
      if (method === 'matter_hosted_archive_reserve') {
        const row = { id: args.p_id, reserved_bytes: args.p_reserved_bytes, consumed_bytes: 0, released: false };
        reservations.set(row.id, row);
        return { ...row };
      }
      if (method === 'matter_hosted_archive_consume' || method === 'matter_hosted_archive_release') {
        const row = reservations.get(args.p_id);
        if (method.endsWith('consume')) row.consumed_bytes += args.p_bytes; else row.released = true;
        return { ...row };
      }
      throw Error('Unexpected fixture RPC ' + method);
    }; },
  };
  const run = (mode, options = {}) => runDriverAuditHostedIndexStage({ mode, root, contents, backend,
    bundleSha256: sha('fixture bundle'), releaseSha: '2'.repeat(40), clock: () => Date.parse(date) + 60_000, ...options });
  writes.length = 0;
  return { root, run, contents, candidate, proof, records, reads, writes, selections, remote, archive, oldBody,
    setUsage: value => { usage = value; } };
}

test('checking an authenticated bundle is offline and rejects mismatched objects', async t => {
  const f = await fixture(t);
  assert.equal((await f.run('check', { backend: undefined })).status, 'hosted-index-checked');
  assert.deepEqual(f.reads, []);
  f.contents.objects.set(f.candidate.lightView.sha256 + '.gz', Buffer.from('wrong'));
  await assert.rejects(f.run('check', { backend: undefined }), /inventory|object/i);
});

test('a listed report date needs its original bundled pages before anything can be staged', async t => {
  const f = await fixture(t);
  const index = JSON.parse(f.contents.stagedIndex);
  const missing = { sha256: sha('missing date pages'), size: 24 };
  const root = gzipSync(json({ version: 1, generation: f.candidate.generation, reportHash: f.candidate.reportHash,
    catalog: { sha256: sha('catalog') }, visibleCutoffAt: date, history: { staffRows: 0 }, review: { snapshotHash: f.candidate.reportHash },
    records: 0, days: [{ day: date.slice(0, 10), records: 0, extraCases: 0, fingerprint: missing.sha256, ref: missing }] }));
  const lightView = { sha256: sha(root), size: root.length };
  f.contents.objects = new Map([[lightView.sha256 + '.gz', root]]);
  f.contents.candidate = json({ ...f.candidate, lightView });
  f.contents.stagedIndex = json({ ...index, lightView, objectBytes: root.length, archives: [{ key: lightView.sha256 + '.gz', bytes: root.length }] });
  await assert.rejects(f.run('stage'), /bundle/i);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.reads, []);
});

test('the CLI authenticates a pinned private bundle without using a Supabase credential', async t => {
  const f = await fixture(t);
  const stageRoot = path.join(f.root, 'sealed-input'), objectRoot = path.join(stageRoot, 'objects');
  await fs.mkdir(objectRoot, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(stageRoot, 'candidate.private.json'), f.contents.candidate, { mode: 0o600 });
  await fs.writeFile(path.join(stageRoot, 'staged-index.private.json'), f.contents.stagedIndex, { mode: 0o600 });
  for (const [name, bytes] of f.contents.objects) await fs.writeFile(path.join(objectRoot, name), bytes, { mode: 0o600 });
  const material = Buffer.alloc(32, 7), releaseSha = '2'.repeat(40);
  const bundle = await sealDriverAuditHostedIndexBundle({ stageRoot, proof: f.contents.proof, key: material, releaseSha });
  const bundlePath = path.join(f.root, 'encrypted-index.private.bin');
  await fs.writeFile(bundlePath, bundle, { mode: 0o600 });
  const args = [fileURLToPath(new URL('./driverAuditHostedIndexStage.js', import.meta.url)), '--check', '--root', f.root,
    '--bundle', bundlePath, '--bundle-sha', sha(bundle), '--release-sha', releaseSha];
  const exec = promisify(execFile);
  const { stdout, stderr } = await exec(process.execPath, args, { env: { DRIVER_AUDIT_WORKER_CACHE_KEY: material.toString('base64') } });
  assert.deepEqual(JSON.parse(stdout), { status: 'hosted-index-checked', objects: 1, selected: false, staffAppSwitched: false });
  assert.equal(stderr, '');
  await assert.rejects(exec(process.execPath, args, { env: { DRIVER_AUDIT_WORKER_CACHE_KEY: Buffer.alloc(32, 9).toString('base64') } }),
    error => error.code === 1 && error.stdout === '' && /stage stopped/.test(error.stderr));
});

test('staging respects the one-time Dubai reset window, transfer limits and upload identity', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run('stage', { clock: () => Date.parse(date) - 1 }), /reset|window/i);
  await assert.rejects(f.run('stage', { clock: () => Date.parse(date) + 24 * 60 * 60 * 1000 }), /reset|window/i);
  f.setUsage(50);
  await assert.rejects(f.run('stage'), /allowance/i);
  f.contents.proof = json({ ...f.proof, uploads: { ...f.proof.uploads, region: 'sfo2' } });
  await assert.rejects(f.run('check'), /photo|upload/i);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.reads, []);
});

test('staging preserves rollback bytes and selection is exact, separate and idempotent', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run('select'), /stage/i);
  assert.equal((await f.run('stage')).status, 'hosted-index-staged');
  assert.deepEqual(f.writes, [f.candidate.lightView.sha256 + '.gz']);
  assert.equal(f.records.get(key).body_text, f.oldBody);
  assert.equal((await f.run('select')).status, 'hosted-index-selected');
  const selection = JSON.parse(await fs.readFile(path.join(f.root, 'selection.private.json')));
  assert.equal(selection.request.reportHeadSha256, sha(f.records.get(key).body_text));
  assert.equal(selection.request.generation, f.candidate.generation);
  assert.equal(JSON.parse(f.records.get(key).body_text).previous.sourceBodySha256, sha(f.oldBody));
  assert.equal((await f.run('select')).status, 'hosted-index-selected');
  assert.equal(f.selections.length, 1);
});

test('a changed journal during package verification stops before CAS', async t => {
  const f = await fixture(t);
  await f.run('stage');
  const read = f.archive.readObject;
  f.archive.readObject = async (name, options) => {
    const original = f.proof.journals[0];
    f.records.set(original.key, { revision: original.revision + 1, body_text: '{"saved":true}' });
    return read(name, options);
  };
  await assert.rejects(f.run('select'), /journal/i);
  assert.deepEqual(f.selections, []);
  assert.equal(f.records.get(key).body_text, f.oldBody);
});
