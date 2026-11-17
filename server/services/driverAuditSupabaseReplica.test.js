import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { archiveBytes } from '../vendor/driver-audits/integration/cloud/repository.mjs';
import { createDriverAuditSupabaseReplica, driverAuditSupabaseReportHeadKey } from './driverAuditSupabaseReplica.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const at = '2026-11-12T00:00:00.000Z';
const clone = value => structuredClone(value);

function storage() {
  const objects = new Map(), reads = [], writes = [];
  return { objects, reads, writes,
    async readObject(key, { maxBytes } = {}) {
      reads.push(key);
      const bytes = objects.get(key);
      if (!bytes) throw Object.assign(Error('Original object missing'), { code: 'storage_not_found' });
      assert.ok(bytes.length <= maxBytes);
      return [Buffer.from(bytes)];
    },
    async putVerifiedObject(key, bytes) {
      writes.push(key); objects.set(key, Buffer.from(bytes));
      return { key, sha256: sha(bytes), bytes: bytes.length, verified: true };
    },
  };
}

function stateFixture() {
  let row = { revision: 0, body: null };
  const requests = [], originalRecords = Object.freeze({ collector: 'original', reviews: 'original', history: 'original' });
  return { requests, originalRecords,
    get row() { return clone(row); }, set row(value) { row = clone(value); },
    async read(key) { assert.equal(key, 'app-sidi-report-head'); return clone(row); },
    async compareAndSwap(request) {
      assert.equal(request.key, 'app-sidi-report-head');
      requests.push(clone(request));
      if (request.expectedRevision !== row.revision) throw Object.assign(Error('Concurrent publication'), { status: 409 });
      row = { revision: row.revision + 1, body: request.body };
      return { revision: row.revision, body_text: row.body, body_sha256: sha(row.body), event_text: request.event, replayed: false };
    },
  };
}

async function packageFixture(archive, collectorRevision = 5771, { previous = null } = {}) {
  const browser = Buffer.from(JSON.stringify({ fixture: collectorRevision })), generation = sha(browser);
  const reportHash = sha('report-' + collectorRevision), catalogHash = sha('catalog-' + collectorRevision);
  const snapshot = { sha256: generation, url: 'report-data/snapshot-' + generation + '.json' };
  const values = {
    'publication.private.json': Buffer.from(JSON.stringify({ head: { reportHash, manifest: snapshot,
      source: { observedAt: at } }, catalog: { sha256: catalogHash } })),
    'identities.private.json': Buffer.from('{}'), 'maps.private.json': Buffer.from('{}'),
    'gps-index.private.json.gz': gzipSync(Buffer.from('{"streamFiles":{"vehicle":"gps-stream.private.json.gz"}}')),
    'preview-read-view.private.json.gz': gzipSync(Buffer.from(JSON.stringify({ reportHash, generation, catalogHash,
      browser: snapshot, deferredQueryFiles: { rows: 'deferred.private.json.gz' } }))),
    'renderer.private.html': Buffer.from('<html>Fictional</html>'), 'build.private.json': Buffer.from('{}'),
    'browser-data.private.json.gz': gzipSync(browser),
    'gps-stream.private.json.gz': gzipSync(Buffer.from('{"gps":[1,2,3]}')),
    'deferred.private.json.gz': gzipSync(Buffer.from('{"rows":["fictional"]}')),
    'extra-declared.private.json': Buffer.from('{"declared":true}'),
  };
  const files = {};
  for (const [name, body] of Object.entries(values)) files[name] = await archiveBytes(archive, body, { domain: 'previewRuntime', path: name });
  const manifestSha256 = sha('manifest-' + collectorRevision), sourceBasis = sha('basis-' + collectorRevision);
  const descriptor = await archiveBytes(archive, Buffer.from(JSON.stringify({ version: 1, files,
    generation, reportHash, sourceManifestSha256: manifestSha256 })), { domain: 'previewPackage', path: 'descriptor.json' });
  const binding = { manifestSha256, generation, reportHash, descriptorSha256: descriptor.sha256 };
  return { files, head: { version: 1, generation, reportHash, descriptor,
    servingPackage: { version: 1, dataStore: 'supabase', collectorRevision, sourceBasis, manifestSha256 },
    closureReceipt: { version: 1, status: 'verified', sourceBasis, ...binding, checkedAt: at,
      checks: { archive: true, photos: true, reviewHistory: true } },
    restore: { version: 1, archive: 'matter-report-archive', verified: true, ...binding },
    visibleCutoffAt: at, publishedAt: at, previous } };
}

test('bootstrap fully reads every declared package file and stores only the additive pointer', async () => {
  const state = stateFixture(), archive = storage(), { head, files } = await packageFixture(archive);
  const replica = createDriverAuditSupabaseReplica({ state, archive });
  assert.equal(driverAuditSupabaseReportHeadKey, 'app-sidi-report-head');
  assert.equal(await replica.head(), null);
  archive.reads.length = 0;
  const result = await replica.activate({ expected: null, head });
  assert.equal(result.status, 'published');
  assert.equal(result.head.sourceRevision, 1);
  assert.equal(result.head.servingPackage.collectorRevision, 5771);
  assert.equal(result.head.sourceBodySha256, sha(state.row.body));
  for (const file of Object.values(files)) assert.ok(archive.reads.includes(file.chunks[0].sha256 + '.gz'));
  assert.deepEqual(state.originalRecords, { collector: 'original', reviews: 'original', history: 'original' });
  assert.equal(state.requests.length, 1);
  assert.ok(!Object.hasOwn(JSON.parse(state.row.body), 'sourceRevision'));
  assert.ok(!Object.hasOwn(JSON.parse(state.row.body), 'directImport'));
});

test('later publications retain the exact previous pointer identity without recursively copying history', async () => {
  const state = stateFixture(), archive = storage(), replica = createDriverAuditSupabaseReplica({ state, archive });
  const first = (await packageFixture(archive, 5771)).head, second = (await packageFixture(archive, 5772)).head;
  await replica.activate({ expected: null, head: first });
  const original = await replica.head();
  await replica.activate({ expected: original, head: second });
  const actual = await replica.head();
  assert.equal(actual.sourceRevision, 2);
  assert.equal(actual.previous.sourceRevision, original.sourceRevision);
  assert.equal(actual.previous.sourceBodySha256, original.sourceBodySha256);
  assert.deepEqual(actual.previous.closureReceipt, original.closureReceipt);
  assert.equal(Object.hasOwn(actual.previous, 'previous'), false);
  assert.equal(state.requests.length, 2);
  const retry = await replica.activate({ expected: actual, head: second });
  assert.equal(retry.status, 'unchanged');
  assert.equal(state.requests.length, 2);
});

test('an explicit bootstrap previous pointer is preserved only after all its bytes verify', async () => {
  const state = stateFixture(), archive = storage(), older = (await packageFixture(archive, 4775)).head;
  delete older.previous;
  const next = (await packageFixture(archive, 5771, { previous: older })).head;
  const replica = createDriverAuditSupabaseReplica({ state, archive });
  await replica.activate({ expected: null, head: next });
  assert.deepEqual((await replica.head()).previous, older);
  const later = (await packageFixture(archive, 5772, { previous: older })).head;
  await assert.rejects(replica.activate({ expected: await replica.head(), head: later }), /previous/i);
  assert.equal(state.requests.length, 1);
});

test('missing or corrupt deferred, GPS and otherwise declared bytes prevent any publication', async () => {
  for (const name of ['gps-stream.private.json.gz', 'deferred.private.json.gz', 'extra-declared.private.json']) {
    const state = stateFixture(), archive = storage(), { head, files } = await packageFixture(archive);
    archive.objects.delete(files[name].chunks[0].sha256 + '.gz');
    await assert.rejects(createDriverAuditSupabaseReplica({ state, archive }).activate({ expected: null, head }), /missing/i);
    assert.equal(state.requests.length, 0);
  }
  const state = stateFixture(), archive = storage(), { head, files } = await packageFixture(archive);
  archive.objects.set(files['gps-stream.private.json.gz'].chunks[0].sha256 + '.gz', Buffer.from('wrong'));
  await assert.rejects(createDriverAuditSupabaseReplica({ state, archive }).activate({ expected: null, head }), /integrity/i);
  assert.equal(state.requests.length, 0);
});

test('unverified bootstrap previous bytes cannot be hidden behind a valid current package', async () => {
  const state = stateFixture(), archive = storage(), old = await packageFixture(archive, 4775);
  delete old.head.previous;
  const { head } = await packageFixture(archive, 5771, { previous: old.head });
  archive.objects.delete(old.files['deferred.private.json.gz'].chunks[0].sha256 + '.gz');
  await assert.rejects(createDriverAuditSupabaseReplica({ state, archive }).activate({ expected: null, head }), /missing/i);
  assert.equal(state.requests.length, 0);
});

test('closure, restore, source identity, cutoff and typed metadata mismatches fail closed', async () => {
  const archive = storage(), { head } = await packageFixture(archive);
  const mutations = [
    h => { h.servingPackage.dataStore = 'mongo'; }, h => { h.servingPackage.collectorRevision = '5771'; },
    h => { h.servingPackage.sourceBasis = sha('other'); }, h => { h.servingPackage.manifestSha256 = sha('other'); },
    h => { h.closureReceipt.collectorRevision = 44; }, h => { h.closureReceipt.checks.photos = false; },
    h => { h.closureReceipt.checkedAt = 'yesterday'; }, h => { h.restore.verified = false; },
    h => { h.restore.descriptorSha256 = sha('other'); }, h => { h.visibleCutoffAt = '2026-11-13T00:00:00.000Z'; },
    h => { h.directImport = {}; }, h => { h.sourceRevision = 5771; },
    h => { h.descriptor.chunks[0].offset = 1; }, h => { h.raw = 'unexpected raw payload'; },
  ];
  for (const mutate of mutations) {
    const state = stateFixture(), changed = clone(head); mutate(changed);
    await assert.rejects(createDriverAuditSupabaseReplica({ state, archive }).activate({ expected: null, head: changed }));
    assert.equal(state.requests.length, 0);
  }
  const state = stateFixture(), enriched = clone(head); enriched.closureReceipt.collectorRevision = 5771;
  await createDriverAuditSupabaseReplica({ state, archive }).activate({ expected: null, head: enriched });
  assert.equal(state.requests.length, 1);
});

test('the app pointer CAS revision and exact body digest both protect against stale writers', async () => {
  const state = stateFixture(), archive = storage(), replica = createDriverAuditSupabaseReplica({ state, archive });
  const first = (await packageFixture(archive, 5771)).head, next = (await packageFixture(archive, 5772)).head;
  await replica.activate({ expected: null, head: first });
  const prior = await replica.head();
  for (const expected of [null, { ...prior, sourceRevision: 5771 }, { ...prior, sourceBodySha256: sha('other') }]) {
    await assert.rejects(replica.activate({ expected, head: next }), /concurrent|expected|revision/i);
  }
  assert.equal(state.requests.length, 1);
});

test('source collector revisions cannot move backwards or give one revision a different package', async () => {
  const state = stateFixture(), archive = storage(), replica = createDriverAuditSupabaseReplica({ state, archive });
  await replica.activate({ expected: null, head: (await packageFixture(archive, 5771)).head });
  const prior = await replica.head();
  await assert.rejects(replica.activate({ expected: prior, head: (await packageFixture(archive, 4775)).head }), /backwards/i);
  const changed = (await packageFixture(archive, 5771)).head;
  changed.reportHash = sha('conflict');
  await assert.rejects(replica.activate({ expected: prior, head: changed }), /conflict|binding|package/i);
  assert.equal(state.requests.length, 1);
});

test('a pointer changed during full verification is never overwritten', async () => {
  const state = stateFixture(), archive = storage(), replica = createDriverAuditSupabaseReplica({ state, archive });
  const first = (await packageFixture(archive, 5771)).head, next = (await packageFixture(archive, 5772)).head;
  await replica.activate({ expected: null, head: first });
  const prior = await replica.head(), read = archive.readObject;
  let changed = false;
  archive.readObject = async (...args) => { if (!changed) { changed = true; state.row = { revision: 2, body: JSON.stringify(next) }; } return read(...args); };
  await assert.rejects(replica.activate({ expected: prior, head: next }), /concurrent/i);
  assert.equal(state.requests.length, 1);
  assert.equal(state.row.revision, 2);
});

test('caller mutation cannot replace the captured expected identity during byte verification', async () => {
  const state = stateFixture(), archive = storage(), replica = createDriverAuditSupabaseReplica({ state, archive });
  const first = (await packageFixture(archive, 5771)).head, next = (await packageFixture(archive, 5772)).head;
  await replica.activate({ expected: null, head: first });
  const expected = await replica.head(), read = archive.readObject;
  let changed = false;
  archive.readObject = async (...args) => {
    if (!changed) {
      changed = true;
      state.row = { revision: 2, body: JSON.stringify(next) };
      expected.sourceRevision = 2; expected.sourceBodySha256 = sha(state.row.body);
    }
    return read(...args);
  };
  await assert.rejects(replica.activate({ expected, head: next }), /concurrent/i);
  assert.equal(state.requests.length, 1);
  assert.equal(state.row.revision, 2);
});

test('lost acknowledgement recovers only exact expected+1 committed bytes', async () => {
  const state = stateFixture(), archive = storage(), { head } = await packageFixture(archive);
  const cas = state.compareAndSwap;
  state.compareAndSwap = async request => { await cas(request); throw Error('Lost acknowledgement'); };
  const result = await createDriverAuditSupabaseReplica({ state, archive }).activate({ expected: null, head });
  assert.equal(result.recoveredAcknowledgement, true);
  assert.equal(result.head.sourceRevision, 1);
  const different = stateFixture();
  different.compareAndSwap = async request => { different.row = { revision: 2, body: request.body }; throw Error('Lost acknowledgement'); };
  await assert.rejects(createDriverAuditSupabaseReplica({ state: different, archive }).activate({ expected: null, head }), /acknowledgement/);
});

test('successful acknowledgement is still followed by exact current-state readback', async () => {
  const state = stateFixture(), archive = storage(), { head } = await packageFixture(archive);
  const cas = state.compareAndSwap;
  state.compareAndSwap = async request => { const result = await cas(request); state.row = { revision: 2, body: request.body }; return result; };
  await assert.rejects(createDriverAuditSupabaseReplica({ state, archive }).activate({ expected: null, head }), /readback|concurrent/i);
});

test('immutable object writes require exact receipt and full content readback', async () => {
  const state = stateFixture(), archive = storage(), replica = createDriverAuditSupabaseReplica({ state, archive });
  const bytes = Buffer.from('immutable'), key = sha(bytes) + '.gz';
  await replica.putObject(key, bytes);
  assert.deepEqual(Buffer.concat(await replica.readObject(key, { maxBytes: bytes.length })), bytes);
  const put = archive.putVerifiedObject;
  archive.putVerifiedObject = async (k, b) => { const receipt = await put(k, b); archive.objects.set(k, Buffer.from('corrupt')); return receipt; };
  await assert.rejects(replica.putObject(key, bytes), /integrity|readback/i);
  archive.putVerifiedObject = async () => ({ key, sha256: sha(bytes), verified: false });
  await assert.rejects(replica.putObject(key, bytes), /verified|receipt/i);
  assert.equal(state.requests.length, 0);
});

test('stored pointer shape and impossible empty-state revisions are rejected without writes', async () => {
  const state = stateFixture(), archive = storage(), { head } = await packageFixture(archive), replica = createDriverAuditSupabaseReplica({ state, archive });
  state.row = { revision: 1, body: null };
  await assert.rejects(replica.head(), /revision|state/i);
  state.row = { revision: 0, body: JSON.stringify(head) };
  await assert.rejects(replica.head(), /revision|state/i);
  state.row = { revision: 1, body: JSON.stringify({ ...head, sourceBodySha256: sha('invented') }) };
  await assert.rejects(replica.head(), /metadata|pointer/i);
  assert.equal(state.requests.length, 0);
});
