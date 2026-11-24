import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createDriverAuditMongoArchive } from '../../server/services/driverAuditMongoArchive.js';
import { validateDriverAuditSpacesArchiveReference } from '../../server/services/driverAuditSpacesArchive.js';
import { createDriverAuditMongoTextReader } from '../../server/services/driverAuditMongoText.js';
import { readDriverAuditImportRows, isDriverAuditTechnicalKey, createDriverAuditReceiptSelection } from '../../server/services/driverAuditLiveImport.js';
import { originalDriverAuditReceiptSha256 } from '../../server/services/driverAuditOriginalSourceLineage.js';
import { readPrivateDriverAuditSource, requirePrivateDriverAuditSourceDirectory } from '../../server/services/driverAuditSource.js';
import { createDriverAuditTechnicalState } from '../../server/services/driverAuditTechnicalState.js';
import { sealTransferSecrets, openTransferSecrets } from '../../server/services/driverAuditTransferCodec.js';

const implementation = await import('./driver-audit-native-parity.mjs').catch(() => ({}));
const hash = value => createHash('sha256').update(value).digest('hex');
const sessionId = '00000000-0000-4000-8000-000000000001';
const identities = { verifierSha256: 'a'.repeat(64), archiveSha256: 'b'.repeat(64), migrationCliSha256: 'c'.repeat(64) };
const copy = value => structuredClone(value);

async function fixture(t, options = {}) {
  assert.equal(typeof implementation.verifyDriverAuditNativeParity, 'function', 'the complete read-only verifier is required');
  const appRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-parity-')));
  t.after(() => fs.rm(appRoot, { recursive: true, force: true }));
  const server = path.join(appRoot, 'server'), transferRoot = path.join(server, '.private/driver-audit-native-transfer');
  const folder = path.join(transferRoot, sessionId), syncRoot = path.join(server, '.private/driver-audits', 'f'.repeat(64));
  for (const dir of [folder, syncRoot, path.join(server, 'services'), path.join(server, 'scripts')]) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  }
  for (const name of ['services/driverAuditMongoArchive.js', 'services/driverAuditSpacesArchive.js',
    'services/driverAuditNativeObjectStore.js', 'scripts/driverAuditMongoMigrate.js']) {
    const bytes = await fs.readFile(new URL('../../server/' + name, import.meta.url)).catch(error => {
      if (name === 'services/driverAuditNativeObjectStore.js' && error.code === 'ENOENT') return Buffer.from('// fictional factory code identity\n');
      throw error;
    });
    await fs.writeFile(path.join(server, name), bytes, { mode: 0o600 });
  }
  const tables = new Map(), table = name => { if (!tables.has(name)) tables.set(name, []); return tables.get(name); };
  const match = (row, query) => Object.entries(query).every(([key, value]) => value && typeof value === 'object'
    && '$in' in value ? value.$in.includes(row[key]) : row[key] === value);
  const db = { databaseName: 'fictional_existing', collection(name) {
    return { async findOne(query) { return table(name).find(row => match(row, query)) || null; },
      find(query = {}) { const values = table(name).filter(row => match(row, query)); return {
        async toArray() { return values; }, async *[Symbol.asyncIterator]() { yield* values; },
      }; }, async countDocuments(query = {}) { return table(name).filter(row => match(row, query)).length; },
      async updateOne() { throw Error('parity must not mutate the database'); },
      async insertOne() { throw Error('parity must not mutate the database'); },
    };
  } };
  const client = { startSession() { throw Error('parity must not start a write transaction'); } };
  function reference(bytes) {
    const sha256 = hash(bytes);
    if (!table('driverAuditNativeChunks').some(row => row._id === sha256)) {
      table('driverAuditNativeChunks').push({ _id: sha256, size: bytes.length, bytes: Buffer.from(bytes) });
    }
    return { version: 1, sha256, size: bytes.length, chunks: [{ sha256, size: bytes.length }] };
  }
  const textReference = text => reference(gzipSync(Buffer.from(text)));
  const photograph = Buffer.from('fictional-original-photograph');
  const gps = gzipSync(Buffer.from('{"points":[{"lat":1,"lng":2,"gpsTime":"2026-11-16T01:00:00Z"}]}'));
  const inline = Buffer.from('{"gpsTime":"2026-11-16T01:00:00Z","quality":"original"}');
  const inlineAudit = gzipSync(Buffer.from(JSON.stringify({ files: [{ base64: inline.toString('base64') }] })));
  const largePayload = options.inlineContainerCount ? 'x'.repeat(8 * 1024 * 1024) : null;
  const inlineContainers = options.inlineContainerCount
    ? Array.from({ length: options.inlineContainerCount }, (_, index) => gzipSync(Buffer.from(JSON.stringify({ index, payload: largePayload }))))
    : [inlineAudit];
  const snapshotHash = '3'.repeat(64), missingSnapshotHash = '4'.repeat(64);
  const snapshot = gzipSync(Buffer.from(JSON.stringify({ snapshotHash, rows: [{ key: 'fictional-record' }] })));
  const evidence = [photograph, gps, ...inlineContainers, snapshot].map(bytes => ({ key: hash(bytes) + '.gz', bytes }));
  for (const item of evidence) table('driverAuditNativeFiles').push({ _id: item.key, reference: reference(item.bytes) });
  const source = [{ key: 'collector-state', revision: 2, body_text: '{"version":1,"records":1}' },
    { key: 'review-journal', revision: 2, body_text: JSON.stringify({ records: { reportingReviews: [
      { eventId: 'fictional-review-1', data: { snapshotHash, notes: 'PRIVATE FIXTURE REVIEW MUST NOT LEAK' } },
      { eventId: 'fictional-review-2', data: { snapshotHash: missingSnapshotHash, notes: 'old unavailable context' } },
    ] } }) }];
  const seed = { version: 1, collectorRevision: 1, manifestSha256: '5'.repeat(64), sourceBasis: '6'.repeat(64) };
  await fs.writeFile(path.join(syncRoot, 'seed.json'), JSON.stringify(seed), { mode: 0o600 });
  const bootstrap = { collectorRevision: 1, manifestSha256: seed.manifestSha256, sourceBasis: seed.sourceBasis, seedSha256: hash(JSON.stringify(seed)) };
  let census = { collectorRevisions: [1, 2], roots: [{ kind: 'source-current', revision: 2, sha256: hash(source[0].body_text) },
    { kind: 'bootstrap', revision: 1 }, { kind: 'seed.json', sha256: bootstrap.seedSha256 }] };
  census = { ...census, sha256: hash(JSON.stringify(census)), bootstrap };
  const receipts = [1, 2].map(revision => ({ key: 'collector-state', revision,
    event_id: 'fictional-collector-' + revision, request_sha256: hash('request-' + revision),
    body_text: '{"version":1,"records":1}', event_text: '{"kind":"original-capture"}',
    body_sha256: hash('{"version":1,"records":1}'), created_at: '2026-11-16T01:00:00.000000+00:00' }));
  if (options.receiptBinding) {
    const { sha256: priorHash, bootstrap: originalBootstrap, ...pinned } = census;
    census = { ...pinned, receiptBindings: [{ key: 'collector-state', revision: 1,
      receiptSha256: originalDriverAuditReceiptSha256(receipts[0]) }] };
    census = { ...census, sha256: hash(JSON.stringify(census)), bootstrap: originalBootstrap };
  }
  const historical = Array.from({ length: options.historicalRows || 1 }, (_, index) => ({ namespace: 'reporting.delivery',
    body_text: JSON.stringify({ record: 'fictional-' + index, gpsTime: '2026-11-16T01:00:00Z' }) }));
  const manifest = (domain, filename, bytes) => ({ version: 1, domain, path: filename, kind: 'immutable-evidence',
    size: bytes.length, sha256: hash(bytes), chunks: [{ offset: 0, size: bytes.length, sha256: hash(bytes) }] });
  const contexts = [{ snapshotHash, availability: 'available', provenance: ['original-human-review'],
    manifest: manifest('archive', 'review-snapshots/' + snapshotHash + '.json.gz', snapshot) },
  { snapshotHash: missingSnapshotHash, availability: 'source-missing', provenance: ['original-human-review'] }];
  const dependencies = [{ snapshotHash, files: [manifest('objects', hash(photograph), photograph)] },
    { snapshotHash: missingSnapshotHash, files: [] }];
  const objects = evidence.map(item => ({ key: item.key, bytes: item.bytes.length })).sort((a, b) => a.key.localeCompare(b.key));
  const profile = { version: 2, targetDatabase: db.databaseName, capacityBytes: 16 * 1024 ** 3,
    receiptInput: 'selected', collectorRootsSha256: census.sha256, syncRoot,
    runtimeRoot: '/owner-private/runtime', runtimeSha256: '8'.repeat(64) };
  const values = { documents: source, receipts, historical, objects, reviewContexts: contexts, reviewDependencies: dependencies };
  for (const [name, rows] of Object.entries(values)) {
    const file = name + '.private.jsonl.gz', bytes = gzipSync(Buffer.from(rows.map(JSON.stringify).join('\n') + '\n'));
    await fs.writeFile(path.join(folder, file), bytes, { mode: 0o600 }); profile[name] = { file, sha256: hash(bytes) };
  }
  const backup = { verified: true, originalsPreserved: true, originalReceiptSha256: profile.receipts.sha256,
    sourceDumpSha256: '9'.repeat(64), receiptCount: receipts.length, liveReceiptCount: receipts.length,
    liveReceiptSha256: profile.receipts.sha256, collectorRootsSha256: census.sha256 };
  const backupBytes = Buffer.from(JSON.stringify(backup));
  profile.bookkeepingBackup = { file: 'bookkeeping-backup.private.json', sha256: hash(backupBytes) };
  await fs.writeFile(path.join(folder, profile.bookkeepingBackup.file), backupBytes, { mode: 0o600 });
  let profileBytes = Buffer.from(JSON.stringify(profile)), profileSha256 = hash(profileBytes);
  for (const row of source) table('driverAuditNativeDocuments').push({ _id: row.key, revision: row.revision,
    body_sha256: hash(row.body_text), body_ref: textReference(row.body_text), importedBy: profileSha256,
    importedRevision: row.revision, importedBodySha256: hash(row.body_text) });
  for (const row of receipts) { const { body_text, event_text, ...fields } = row;
    table('driverAuditNativeReceipts').push({ ...fields, event_sha256: hash(event_text), body_ref: textReference(body_text),
      event_ref: textReference(event_text), importedBy: profileSha256 }); }
  for (const row of historical) table('driverAuditNativeHistorical').push({ _id: hash(JSON.stringify([row.namespace, hash(row.body_text)])),
    namespace: row.namespace, rowSha256: hash(row.body_text), body_ref: textReference(row.body_text), importedBy: profileSha256 });
  for (const context of contexts) {
    const dependency = dependencies.find(row => row.snapshotHash === context.snapshotHash);
    const bytes = Buffer.from(JSON.stringify({ context, dependencies: dependency }));
    table('driverAuditNativeReviewContexts').push({ _id: context.snapshotHash, availability: context.availability,
      sha256: hash(bytes), reference: reference(bytes) });
    for (const m of [context.manifest, ...dependency.files].filter(Boolean)) {
      table('driverAuditNativeReviewFiles').push({ _id: hash(JSON.stringify([m.domain, m.path])), manifest: m });
    }
  }
  table('driverAuditNativeControl').push({ _id: 'authority', status: 'staging', importSha256: profileSha256, writeFence: 1 });
  const inventorySha256 = hash(objects.map(JSON.stringify).join('\n') + '\n');
  const closure = { version: 1, status: 'final-driver-audit-source-closure', verified: true, complete: true,
    sourceRevision: 2, collectorRootsSha256: census.sha256, bootstrap,
    origin: { sourceSnapshotSha256: 'd'.repeat(64), restoreVerificationSha256: 'e'.repeat(64),
      originalArchiveInventorySha256: 'f'.repeat(64), sourceDumpSha256: backup.sourceDumpSha256 },
    inputs: Object.fromEntries(Object.entries(profile).filter(([, v]) => v?.file).map(([k, v]) => [k, copy(v)])),
    archive: { inventorySha256, objects: objects.length, bytes: objects.reduce((n, row) => n + row.bytes, 0) },
    coverage: { photos: { objects: 1, bytes: photograph.length, identities: 1 },
      gps: { objects: 1, bytes: gps.length, snapshotRefs: 1 }, raw: { identities: 1 },
      results: { assessmentRows: 1, historicalRows: historical.length }, reviewEvents: 2 },
    gaps: { reviewContexts: [missingSnapshotHash], images: [], logicalPaths: [] },
    inlineReferences: options.inlineContainerCount ? inlineContainers.map((bytes, index) => ({ objectKey: evidence[index + 2].key,
      pointer: '/payload', encoding: 'text', sha256: hash(largePayload), bytes: largePayload.length, kind: 'gps' }))
      : [{ objectKey: evidence[2].key, pointer: '/files/0/base64', encoding: 'base64',
        sha256: hash(inline), bytes: inline.length, kind: 'gps' }] };
  const externalContents = new Map(), objectStoreIdentitySha256 = options.external ? '7'.repeat(64) : undefined;
  let externalReads = 0;
  const objectStore = options.external ? { identitySha256: objectStoreIdentitySha256,
    async assertPrivate() { return { public: false, identitySha256: objectStoreIdentitySha256 }; },
    async putVerifiedObject() { throw Error('parity must not write external objects'); },
    async readBytes(ref) { externalReads++; validateDriverAuditSpacesArchiveReference(ref, { identitySha256: objectStoreIdentitySha256 });
      const value = externalContents.get(ref.key); if (!value) throw Error('fictional original external object absent'); return value; },
  } : undefined;
  function externalize(index, alias = false) {
    const item = evidence[index], row = table('driverAuditNativeFiles').find(row => row._id === item.key);
    delete row.reference;
    row.externalReference = { version: 1, provider: 'spaces', identitySha256: objectStoreIdentitySha256,
      key: alias ? 'photos/fictional/original.jpg' : 'driver-reports/archive/v1/' + item.key,
      size: item.bytes.length, sha256: hash(item.bytes),
      ...(alias ? { kind: 'existing-photo-v1', etag: '"original-etag"', versionId: 'original-version' } : {}) };
    externalContents.set(row.externalReference.key, item.bytes); return row;
  }
  if (options.external) {
    table('driverAuditNativeControl').push({ _id: 'archive-object-store', version: 1, provider: 'spaces', identitySha256: objectStoreIdentitySha256 });
    externalize(0, true); externalize(1);
  }
  const archive = createDriverAuditMongoArchive({ db, client, capacityBytes: profile.capacityBytes, objectStore });
  const args = () => ({ db, archive, profileBytes, profileSha256, closureProofBytes: Buffer.from(JSON.stringify(closure)),
    closureProofSha256: hash(JSON.stringify(closure)), sessionId, implementationIdentities: identities,
    targetIdentitySha256: '1'.repeat(64), objectStoreIdentitySha256, validateExternalReference: validateDriverAuditSpacesArchiveReference,
    readRows: ref => readDriverAuditImportRows(folder, ref), readPinnedJson: async ref => {
      const bytes = await fs.readFile(path.join(folder, ref.file)); assert.equal(hash(bytes), ref.sha256); return JSON.parse(bytes);
    }, readText: createDriverAuditMongoTextReader(archive), readTechnical: async () => { throw Error('unused technical reference'); },
    isTechnicalKey: isDriverAuditTechnicalKey, createReceiptSelection: createDriverAuditReceiptSelection,
    collectCensus: async () => census });
  const save = (name, value) => fs.writeFile(path.join(folder, name), typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  const inputFiles = await Promise.all(dataFileRefs(profile).map(async ref => ({ name: ref.file, sha256: ref.sha256,
    bytes: (await fs.stat(path.join(folder, ref.file))).size })));
  const state = { version: 1, sessionId, targetDatabase: db.databaseName, capacityBytes: profile.capacityBytes,
    createdAt: Date.now() - 1000, inventorySha256: 'd'.repeat(64), plan: { inventorySha256: 'd'.repeat(64),
      objectCount: inputFiles.length, objectBytes: inputFiles.reduce((n, row) => n + row.bytes, 0) } };
  const received = { version: 1, sessionId, status: 'transfer-received', verified: true, authorityChanged: false,
    targetDatabase: db.databaseName, inventorySha256: state.inventorySha256, objects: state.plan.objectCount,
    bytes: state.plan.objectBytes, inputFiles, completedAt: new Date().toISOString() };
  let closed = 0, locked = false;
  const hostAdapters = { platform: 'linux', env: { MONGODB_URI: 'mongodb://fictional.invalid/fictional_existing' },
    async exec(file, argv) {
      if (file === 'git') return { stdout: argv[0] === 'rev-parse' ? 'a'.repeat(40) + '\n' : '' };
      assert.equal(file, 'pm2'); return { stdout: JSON.stringify([{ name: 'matter-driver-audit-sync', pm2_env: {
        status: 'stopped', pm_cwd: server, pm_exec_path: path.join(server, 'scripts/driverAuditSync.js'),
        args: ['--config', path.join(syncRoot, 'sync.json')] } }]) };
    }, async load(name) {
      if (name === 'loadEnv.js') return {};
      if (name === 'services/driverAuditSource.js') return { readPrivateDriverAuditSource, requirePrivateDriverAuditSourceDirectory };
      if (name === 'services/driverAuditMongoArchive.js') return { createDriverAuditMongoArchive };
      if (name === 'services/driverAuditNativeObjectStore.js') return { createDriverAuditNativeObjectStore: async () => objectStore };
      if (name === 'services/driverAuditSpacesArchive.js') return { validateDriverAuditSpacesArchiveReference };
      if (name === 'services/driverAuditMongoText.js') return { createDriverAuditMongoTextReader };
      if (name === 'services/driverAuditTechnicalState.js') return { createDriverAuditTechnicalState };
      if (name === 'services/driverAuditLiveImport.js') return { readDriverAuditImportRows, isDriverAuditTechnicalKey, createDriverAuditReceiptSelection,
        collectDriverAuditReceiptRoots: async () => census };
      if (name === 'vendor/driver-audits/integration/hosted/worker-lock.mjs') return { acquireWorkerLock: async () => {
        assert.equal(locked, false); locked = true; return { release: async () => { locked = false; } };
      } };
      if (name === 'node_modules/mongoose/index.js') return { default: { createConnection: () => ({
        db, getClient: () => client, asPromise: async () => {}, close: async () => { closed++; },
      }) } };
      throw Error('Unexpected host module');
    } };
  async function runHost(extra = {}) {
    await save('session.private.json', state); await save('received.private.json', received);
    await fs.writeFile(path.join(folder, 'profile.private.json'), profileBytes, { mode: 0o600 });
    const closureProofBytes = Buffer.from(JSON.stringify(closure)); await fs.writeFile(path.join(folder, 'closure-proof.private.json'), closureProofBytes, { mode: 0o600 });
    return implementation.runDriverAuditNativeParity({ sessionId, appRoot, profileSha256, closureProofSha256: hash(closureProofBytes),
      expectedSha: 'a'.repeat(40), ...extra }, hostAdapters);
  }
  return { args, source, receipts, historical, objects, profile, closure, census, archive, table, reference, textReference,
    appRoot, hostAdapters, state, received, runHost, get closed() { return closed; }, get locked() { return locked; },
    evidence, folder, externalContents, externalize, objectStoreIdentitySha256,
    get externalReads() { return externalReads; }, setCensus(value) { census = value; }, async run(extra = {}) {
      return implementation.verifyDriverAuditNativeParity({ ...args(), ...extra });
    } };
}

function dataFileRefs(profile) { return ['documents', 'receipts', 'historical', 'objects', 'reviewContexts', 'reviewDependencies', 'bookkeepingBackup'].map(name => profile[name]); }

const exportRecipient = generateKeyPairSync('rsa', { modulusLength: 3072 });
const exportPublicKey = exportRecipient.publicKey.export({ type: 'spki', format: 'pem' });

test('archive implementation identity binds all three ordered source files and rejects partial byte maps', () => {
  const files = implementation.driverAuditArchiveImplementationFiles;
  assert.deepEqual(files, ['services/driverAuditMongoArchive.js', 'services/driverAuditSpacesArchive.js', 'services/driverAuditNativeObjectStore.js']);
  const bytes = Object.fromEntries(files.map((file, index) => [file, Buffer.from('fictional implementation ' + index)]));
  const expected = hash(JSON.stringify(files.map(file => ({ file, sha256: hash(bytes[file]) }))));
  assert.equal(implementation.driverAuditArchiveImplementationSha256(bytes), expected);
  for (const file of files) {
    assert.notEqual(implementation.driverAuditArchiveImplementationSha256({ ...bytes, [file]: Buffer.from('changed') }), expected);
    assert.throws(() => implementation.driverAuditArchiveImplementationSha256({ ...bytes, [file]: undefined }));
  }
  assert.throws(() => implementation.driverAuditArchiveImplementationSha256({ ...bytes, extra: Buffer.from('unknown') }));
});

test('hybrid parity reads every legacy, private and original-photo byte while preserving exact original records', async t => {
  const f = await fixture(t, { external: true }), result = await f.run();
  assert.equal(result.verified, true); assert.equal(result.archive.objectBytesReadFresh, f.objects.reduce((sum, row) => sum + row.bytes, 0));
  assert.equal(f.externalReads, 2); assert.equal(result.freshOriginalRecordComparisons, true);
  const cached = await f.run({ priorArchiveAttestation: result.archiveAttestation });
  assert.equal(cached.archive.objectBytesReadFresh, 0); assert.equal(f.externalReads, 2);
});

test('hybrid parity rejects corrupt actual external photo and GPS bytes', async t => {
  for (const index of [0, 1]) await t.test('original-' + index, async t => {
    const f = await fixture(t, { external: true }), row = f.table('driverAuditNativeFiles').find(row => row._id === f.evidence[index].key);
    f.externalContents.set(row.externalReference.key, Buffer.alloc(f.evidence[index].bytes.length, 'x'));
    await assert.rejects(f.run(), /archive-bytes|differ/);
  });
});

test('hybrid metadata rejects mixed references, unknown fields and configured/store identity drift', async t => {
  for (const reason of ['mixed', 'unknown-row', 'unknown-ref', 'binding-extra', 'binding-drift', 'binding-missing', 'config-drift', 'unconfigured']) await t.test(reason, async t => {
    const f = await fixture(t, { external: true }), row = f.table('driverAuditNativeFiles').find(row => row.externalReference);
    const binding = f.table('driverAuditNativeControl').find(row => row._id === 'archive-object-store');
    if (reason === 'mixed') row.reference = f.reference(f.evidence[0].bytes);
    if (reason === 'unknown-row') row.unexpected = true;
    if (reason === 'unknown-ref') row.externalReference.unexpected = true;
    if (reason === 'binding-extra') binding.extra = true;
    if (reason === 'binding-drift') binding.identitySha256 = '0'.repeat(64);
    if (reason === 'binding-missing') f.table('driverAuditNativeControl').splice(f.table('driverAuditNativeControl').indexOf(binding), 1);
    await assert.rejects(f.run(reason === 'config-drift' ? { objectStoreIdentitySha256: '0'.repeat(64) }
      : reason === 'unconfigured' ? { objectStoreIdentitySha256: undefined } : {}));
    assert.equal(f.externalReads, 0);
  });
});

test('legacy unknown nested reference metadata is retained as a failed verification', async t => {
  const f = await fixture(t); f.table('driverAuditNativeFiles')[0].reference.chunks[0].externalReference = { unknown: true };
  await assert.rejects(f.run(), /archive chunk reference/);
});

test('moving a Mongo object or an original-photo alias invalidates the previous full-byte attestation', async t => {
  for (const index of [0, 2]) await t.test('layout-' + index, async t => {
    const f = await fixture(t, { external: true }), before = await f.run();
    f.externalize(index);
    await assert.rejects(f.run({ priorArchiveAttestation: before.archiveAttestation }), /attestation/);
    assert.equal((await f.run()).verified, true);
  });
});

test('original-photo alias key, ETag and version identities each invalidate cached byte reuse', async t => {
  for (const field of ['key', 'etag', 'versionId']) await t.test(field, async t => {
    const f = await fixture(t, { external: true }), before = await f.run();
    const row = f.table('driverAuditNativeFiles').find(row => row.externalReference?.kind === 'existing-photo-v1');
    row.externalReference[field] = field === 'key' ? 'photos/fictional/other.jpg' : field === 'etag' ? '"changed-etag"' : 'changed-version';
    await assert.rejects(f.run({ priorArchiveAttestation: before.archiveAttestation }), /attestation/);
  });
});

test('changed actual archive implementation prevents cached full-byte reuse', async t => {
  const f = await fixture(t, { external: true }), before = await f.run();
  await assert.rejects(f.run({ priorArchiveAttestation: before.archiveAttestation,
    implementationIdentities: { ...identities, archiveSha256: hash('changed factory bytes') } }), /attestation/);
});

test('hybrid host wiring uses configured store identity and the actual three-file implementation aggregate', async t => {
  const f = await fixture(t, { external: true }), first = await f.runHost();
  assert.equal(first.verified, true); assert.equal(f.externalReads, 2);
  const sources = Object.fromEntries(await Promise.all(implementation.driverAuditArchiveImplementationFiles.map(async name =>
    [name, await fs.readFile(path.join(f.appRoot, 'server', name))])));
  assert.equal(first.archive.archiveImplementationSha256, implementation.driverAuditArchiveImplementationSha256(sources));
  assert.equal((await f.runHost()).archive.mode, 'reused-full-byte-attestation'); assert.equal(f.externalReads, 2);
  await fs.appendFile(path.join(f.appRoot, 'server/services/driverAuditNativeObjectStore.js'), '\n// fictional changed deployed factory\n');
  await assert.rejects(f.runHost(), /complete-parity/); assert.equal(f.externalReads, 2);
});

test('optional RSA export seals the exact saved parity receipt without changing its bytes or identity', async t => {
  const f = await fixture(t), load = f.hostAdapters.load;
  f.hostAdapters.load = name => name === 'services/driverAuditTransferCodec.js' ? { sealTransferSecrets } : load(name);
  const result = await f.runHost({ recipientPublicKey: exportPublicKey });
  const value = openTransferSecrets(exportRecipient.privateKey, result.sealedReceipt.capsule);
  assert.equal(value.kind, 'native-parity-receipt-export-v1'); assert.equal(value.sessionId, sessionId);
  assert.equal(value.applicationCommit, 'a'.repeat(40)); assert.equal(value.profileSha256, result.profileSha256);
  assert.equal(value.closureProofSha256, result.closureProofSha256); assert.equal(value.receiptSha256, result.receiptSha256);
  const bytes = Buffer.from(value.dataBase64, 'base64');
  assert.equal(hash(bytes), result.receiptSha256); assert.equal(bytes.length, value.receiptBytes);
  const { receiptSha256, sealedReceipt, ...receipt } = result;
  assert.equal(hash(Buffer.from(JSON.stringify(receipt, null, 2) + '\n')), receiptSha256);
  const name = 'parity-' + result.profileSha256 + '-' + result.closureProofSha256 + '-' + receiptSha256 + '.private.json';
  assert.deepEqual(await fs.readFile(path.join(f.folder, name)), bytes);
  assert.equal(JSON.parse(bytes).sealedReceipt, undefined);
  assert(!JSON.stringify(sealedReceipt).includes(f.appRoot)); assert(!JSON.stringify(sealedReceipt).includes('PRIVATE FIXTURE'));
  assert.equal(f.closed, 1); assert.equal(f.locked, false);
});

test('invalid or weak parity recipients fail before opening the target database', async t => {
  const f = await fixture(t), weak = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  for (const recipientPublicKey of ['', 'fictional invalid recipient', exportRecipient.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    weak.publicKey.export({ type: 'spki', format: 'pem' }), ec.publicKey.export({ type: 'spki', format: 'pem' })]) {
    await assert.rejects(f.runHost({ recipientPublicKey }));
  }
  assert.equal(f.closed, 0); assert.equal(f.locked, false);
});

test('sealed parity export rejects saved-receipt mutation before returning any capsule', async t => {
  const f = await fixture(t), load = f.hostAdapters.load;
  f.hostAdapters.load = async name => {
    if (name !== 'services/driverAuditTransferCodec.js') return load(name);
    const receipt = (await fs.readdir(f.folder)).find(file => file.startsWith('parity-'));
    assert(receipt); await fs.appendFile(path.join(f.folder, receipt), ' ');
    return { sealTransferSecrets };
  };
  await assert.rejects(f.runHost({ recipientPublicKey: exportPublicKey }), error => !String(error).includes(f.appRoot));
  assert.equal(f.closed, 1); assert.equal(f.locked, false);
});

test('sealed parity export requires the actual encryption helper to be clean before and after sealing', async t => {
  for (const during of [false, true]) await t.test(during ? 'changed during sealing' : 'dirty at entry', async t => {
    const f = await fixture(t), execute = f.hostAdapters.exec, load = f.hostAdapters.load;
    let dirty = !during, guarded = false;
    f.hostAdapters.exec = async (file, args, options) => {
      if (file === 'git' && args[0] === 'diff' && args.includes('server/services/driverAuditTransferCodec.js')) {
        guarded = true; if (dirty) throw Error('PRIVATE FICTIONAL ENCRYPTION HELPER CHANGED');
      }
      return execute(file, args, options);
    };
    f.hostAdapters.load = async name => {
      if (name !== 'services/driverAuditTransferCodec.js') return load(name);
      dirty = true; return { sealTransferSecrets };
    };
    await assert.rejects(f.runHost({ recipientPublicKey: exportPublicKey }), error => !String(error).includes('PRIVATE FICTIONAL'));
    assert(guarded); assert.equal(f.locked, false);
  });
});

test('compares all original records, contexts and archive bytes without selecting authority', async t => {
  const f = await fixture(t), result = await f.run();
  assert.equal(result.verified, true); assert.equal(result.completeByteParity.verified, true);
  assert.deepEqual(result.counts, { documents: 2, receipts: 2, historical: 1, reviewEvents: 2, reviewContexts: 2,
    availableReviewContexts: 1, sourceMissingReviewContexts: 1, reviewFiles: 2, archiveObjects: 4 });
  assert.equal(result.archive.mode, 'fresh-full-object-read');
  assert.equal(result.archive.objectBytesReadFresh, f.objects.reduce((n, row) => n + row.bytes, 0));
  assert.equal(result.inlineReferences.verified, 1);
  assert.equal(result.authorityChanged, false); assert.equal(result.activationPending, true);
  assert.equal(f.table('driverAuditNativeControl')[0].status, 'staging');
  assert.equal(JSON.stringify(result).includes('PRIVATE FIXTURE'), false);
});

test('checks exact historical source receipt bindings from the actual census', async t => {
  const f = await fixture(t, { receiptBinding: true });
  assert.equal((await f.run()).verified, true);
  f.census.receiptBindings[0].receiptSha256 = hash('different original receipt');
  await assert.rejects(f.run(), error => error.phase === 'original-receipts');
});

for (const [name, mutate] of [
  ['changed current result body', f => { const row = f.table('driverAuditNativeDocuments')[0]; row.body_ref = f.textReference('{"records":0}'); }],
  ['changed receipt event', f => { f.table('driverAuditNativeReceipts')[0].event_ref = f.textReference('{"kind":"changed"}'); }],
  ['changed original receipt clock', f => { f.table('driverAuditNativeReceipts')[0].created_at = '2026-11-16T02:00:00Z'; }],
  ['changed historical body', f => { f.table('driverAuditNativeHistorical')[0].body_ref = f.textReference('{"record":"changed"}'); }],
  ['missing imported origin', f => { delete f.table('driverAuditNativeDocuments')[0].importedBy; }],
  ['missing original source provenance', f => { delete f.closure.origin; }],
  ['provisional source closure', f => { f.closure.status = 'provisional-operational-source-closure'; }],
  ['changed context availability', f => { f.table('driverAuditNativeReviewContexts')[1].availability = 'available'; }],
  ['changed inline GPS bytes', f => { f.closure.inlineReferences[0].sha256 = '0'.repeat(64); }],
  ['missing historical origin', f => { delete f.table('driverAuditNativeHistorical')[0].importedBy; }],
]) test('rejects ' + name, async t => { const f = await fixture(t); mutate(f); await assert.rejects(f.run()); });

for (const [name, index] of [['GPS', 1], ['photo', 0]]) test('rejects corrupt original ' + name + ' bytes', async t => {
  const f = await fixture(t), sha256 = f.evidence[index].key.slice(0, 64);
  f.table('driverAuditNativeChunks').find(row => row._id === sha256).bytes[0] ^= 1;
  await assert.rejects(f.run());
});

test('rejects actual collector census drift during fresh comparisons', async t => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(f.run({ collectCensus: async () => ++calls === 1 ? f.census : { ...f.census, sha256: '0'.repeat(64) } }));
});

test('reuses only a complete byte attestation bound to unchanged immutable metadata', async t => {
  const f = await fixture(t), first = await f.run(), second = await f.run({ priorArchiveAttestation: first.archiveAttestation });
  assert.equal(second.verified, true); assert.equal(second.archive.mode, 'reused-full-byte-attestation');
  assert.equal(second.archive.objectBytesReadFresh, 0); assert.equal(second.inlineReferences.verified, 1);
  const invalid = copy(first.archiveAttestation); invalid.metadataSha256 = '0'.repeat(64);
  await assert.rejects(f.run({ priorArchiveAttestation: invalid }));
});

test('rejects a partial CLI receipt presented as a full byte attestation', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run({ priorArchiveAttestation: { status: 'staged-data-verified', resultsEqual: true,
    archiveObjects: 4, archiveClosurePending: true } }));
});

test('a completed code-pinned CLI scan can attest bytes while records remain freshly compared', async t => {
  for (const external of [false, true]) await t.test(external ? 'hybrid' : 'legacy', async t => {
  const f = await fixture(t, { external }), args = f.args(), before = await implementation.captureNativeDriverAuditArchiveMetadata({
    ...args, objects: f.objects });
  const receipt = { status: 'staged-data-verified', importSha256: args.profileSha256, archiveObjects: 4,
    resultsEqual: true, reportIdentityEqual: true, assessmentHistoryEqual: true,
    collectorRootsSha256: f.census.sha256, activationPending: true, archiveClosurePending: true };
  const attestation = implementation.createDriverAuditNativeCliByteAttestation({ before, after: copy(before),
    cliReceipt: receipt, sourceProfileSha256: args.profileSha256, sourceProfileBytes: args.profileBytes,
    sourceObjectsBytes: await fs.readFile(path.join(f.folder, f.profile.objects.file)), implementationIdentities: identities });
  const result = await f.run({ priorArchiveAttestation: attestation });
  assert.equal(result.archive.mode, 'reused-full-byte-attestation'); assert.equal(result.archive.objectBytesReadFresh, 0);
  assert.equal(result.freshOriginalRecordComparisons, true);
  f.table('driverAuditNativeReceipts')[0].event_ref = f.textReference('{"changed":true}');
  await assert.rejects(f.run({ priorArchiveAttestation: attestation }));
  });
});

test('does not reuse a full scan from another target database identity', async t => {
  const f = await fixture(t), result = await f.run();
  await assert.rejects(f.run({ priorArchiveAttestation: result.archiveAttestation, targetIdentitySha256: '2'.repeat(64) }));
});

test('public parity result excludes private fields added to the reference coverage', async t => {
  const f = await fixture(t); f.closure.coverage.privateMaterial = 'PRIVATE FIXTURE CUSTOMER DATA';
  const result = await f.run(); assert.equal(JSON.stringify(result).includes('PRIVATE FIXTURE'), false);
});

test('host operator derives private paths, saves receipts and closes without database writes', async t => {
  const f = await fixture(t), result = await f.runHost();
  assert.equal(result.completeByteParity.verified, true); assert.equal(result.authorityChanged, false);
  assert.equal(f.closed, 1); assert.equal(f.locked, false);
  const files = await fs.readdir(f.folder); assert.equal(files.some(name => name.startsWith('parity-')), true);
  assert.equal(JSON.stringify(result).includes('PRIVATE FIXTURE'), false);
});

test('host operator rejects a received receipt with an impossible completion clock', async t => {
  const f = await fixture(t); f.received.completedAt = '2099-01-01T00:00:00Z';
  await assert.rejects(f.runHost()); assert.equal(f.locked, false);
});

test('changed native chunk identities invalidate reuse even when the original photo bytes remain intact', async t => {
  const f = await fixture(t), first = await f.run(), item = f.evidence[0], row = f.table('driverAuditNativeFiles').find(row => row._id === item.key);
  const a = f.reference(item.bytes.subarray(0, 12)), b = f.reference(item.bytes.subarray(12));
  row.reference.chunks = [a.chunks[0], b.chunks[0]];
  await assert.rejects(f.run({ priorArchiveAttestation: first.archiveAttestation }));
  assert.equal((await f.run()).archive.mode, 'fresh-full-object-read');
});

test('protected staging extras are counted separately without claiming they were freshly verified', async t => {
  const f = await fixture(t), extra = Buffer.from('fictional protected staging extra');
  f.table('driverAuditNativeFiles').push({ _id: hash(extra) + '.gz', reference: f.reference(extra) });
  const result = await f.run();
  assert.equal(result.archive.protectedStagingExtras, 1); assert.equal(result.completeByteParity.objects, 4);
});

test('rejects an imported origin outside the pinned current or accepted previous imports', async t => {
  const f = await fixture(t); f.table('driverAuditNativeHistorical')[0].importedBy = '0'.repeat(64);
  await assert.rejects(f.run());
});

test('target identity strips authentication without losing the host when a query contains an at sign', () => {
  const identity = implementation.nativeDriverAuditTargetIdentity;
  assert.equal(identity('mongodb://first:secret@host-a/db', 'db'), identity('mongodb://second:different@host-a/db', 'db'));
  assert.notEqual(identity('mongodb://host-a?appName=x@y', 'db'), identity('mongodb://host-b?appName=x@y', 'db'));
});

test('fresh original-text reads use bounded concurrency and still compare every trailing historical row', async t => {
  const f = await fixture(t, { historicalRows: 65 }), read = f.args().readText;
  let active = 0, peak = 0;
  const readText = async reference => { active++; peak = Math.max(peak, active);
    try { await new Promise(resolve => setTimeout(resolve, 2)); return await read(reference); }
    finally { active--; } };
  const result = await f.run({ readText });
  assert.equal(result.counts.historical, 65); assert(peak > 1 && peak <= 4, 'fresh native text reads must use bounded parallel I/O');
  f.table('driverAuditNativeHistorical')[64].body_ref = f.textReference('{"record":"last-row-changed"}');
  await assert.rejects(f.run({ readText }));
});

test('CLI attestation rejects another profile object inventory with the same object count and byte total', async t => {
  const f = await fixture(t), args = f.args(), before = await implementation.captureNativeDriverAuditArchiveMetadata({
    db: args.db, objects: f.objects, targetIdentitySha256: args.targetIdentitySha256 });
  const changed = copy(f.objects); changed[0].key = hash(Buffer.alloc(changed[0].bytes, 35)) + '.gz';
  const sourceObjectsBytes = gzipSync(Buffer.from(changed.map(JSON.stringify).join('\n') + '\n'));
  const profile = { ...f.profile, objects: { ...f.profile.objects, sha256: hash(sourceObjectsBytes) } };
  const sourceProfileBytes = Buffer.from(JSON.stringify(profile)), sourceProfileSha256 = hash(sourceProfileBytes);
  const cliReceipt = { status: 'staged-data-verified', importSha256: sourceProfileSha256, archiveObjects: before.objects,
    resultsEqual: true, reportIdentityEqual: true, assessmentHistoryEqual: true, collectorRootsSha256: f.census.sha256,
    activationPending: true, archiveClosurePending: true };
  assert.throws(() => implementation.createDriverAuditNativeCliByteAttestation({ before, after: copy(before), cliReceipt,
    sourceProfileSha256, sourceProfileBytes, sourceObjectsBytes, implementationIdentities: identities }));
});

test('inline originals release decoded containers under a bounded heap', async t => {
  if (process.env.NATIVE_PARITY_INLINE_HEAP_TEST !== '1') {
    const env = { ...process.env, NATIVE_PARITY_INLINE_HEAP_TEST: '1' }; delete env.NODE_TEST_CONTEXT;
    const child = await promisify(execFile)(process.execPath, ['--max-old-space-size=128', '--test',
      '--test-name-pattern=inline originals release decoded containers', fileURLToPath(import.meta.url)], {
      env, timeout: 30000, maxBuffer: 256 * 1024,
    });
    assert.match(child.stdout, /inline-container-heap-verified/);
    return;
  }
  const f = await fixture(t, { inlineContainerCount: 24 }), result = await f.run();
  assert.equal(result.inlineReferences.verified, 24); assert.equal(result.inlineReferences.containers, 24);
  assert.equal(result.verified, true);
  console.log('inline-container-heap-verified');
});
