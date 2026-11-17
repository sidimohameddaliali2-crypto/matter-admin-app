import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID, createPublicKey } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => isDeepStrictEqual(a, b);
const check = (condition, message) => { if (!condition) throw Object.assign(Error(message), { parityGuard: true }); };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const dataFiles = ['documents', 'receipts', 'historical', 'objects', 'reviewContexts', 'reviewDependencies', 'bookkeepingBackup'];
const encode = values => values.map(JSON.stringify).join('\n') + '\n';
const canonicalInventory = values => [...values].sort((a, b) => a.key.localeCompare(b.key)).map(({ key, bytes }) => ({ key, bytes }));
const execute = promisify(execFile);

function validatePublicRecipient(value) {
  check(typeof value === 'string' && value.length <= 8192 && !value.includes('PRIVATE KEY')
    && /^-----BEGIN (?:RSA )?PUBLIC KEY-----[\s\S]+-----END (?:RSA )?PUBLIC KEY-----\s*$/.test(value),
  'A bounded strong public RSA recipient is required');
  let key;
  try { key = createPublicKey(value); } catch { throw Error('A bounded strong public RSA recipient is required'); }
  check(key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails.modulusLength >= 3072,
    'A bounded strong public RSA recipient is required');
}

async function nativeIndex(db, name, identity = row => row._id) {
  const fields = ['_id', 'key', 'revision', 'body_sha256', 'body_ref', 'body_control', 'importedBy', 'importedRevision',
    'importedBodySha256', 'event_id', 'request_sha256', 'event_sha256', 'event_ref', 'created_at', 'namespace', 'rowSha256',
    'availability', 'sha256', 'reference', 'manifest'];
  const result = new Map(), cursor = db.collection(name).find({}, { projection: Object.fromEntries(fields.map(field => [field, 1])) });
  for await (const row of cursor) {
    check(result.size < 100000, 'The native original-record index exceeds its bound');
    const id = identity(row); check(!result.has(id), 'Duplicate native original-record identity'); result.set(id, row);
  }
  return result;
}

async function verifyTextBatches(iterable, verify, finish) {
  let batch = [], size = 0;
  async function run() {
    const rows = batch, results = new Array(rows.length); let cursor = 0, failure;
    await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
      while (!failure) { const index = cursor++; if (index >= rows.length) return;
        try { results[index] = await verify(rows[index]); } catch (error) { failure = error; }
      }
    }));
    if (failure) throw failure;
    for (let i = 0; i < rows.length; i++) finish(rows[i], results[i]);
    batch = []; size = 0;
  }
  for await (const row of iterable) {
    const bytes = ['body_text', 'event_text'].reduce((n, key) => n + (typeof row[key] === 'string' ? Buffer.byteLength(row[key]) : 0), 0);
    if (batch.length && (batch.length === 64 || size + bytes > 16 * 1024 * 1024)) await run();
    batch.push(row); size += bytes;
  }
  if (batch.length) await run();
}

export function nativeDriverAuditTargetIdentity(uri, databaseName) {
  check(typeof uri === 'string' && /^mongodb(?:\+srv)?:\/\//.test(uri)
    && typeof databaseName === 'string' && databaseName.length > 0, 'The existing native database identity is required');
  // Authentication is deliberately excluded from this nonsecret identity.
  const parts = /^(mongodb(?:\+srv)?:\/\/)([^/?]+)(.*)$/.exec(uri);
  check(parts, 'The existing native database identity is required');
  const authority = parts[2].slice(parts[2].lastIndexOf('@') + 1);
  check(authority.length > 0, 'The existing native database identity is required');
  return hash(JSON.stringify([databaseName, parts[1] + authority + parts[3]]));
}

function inventory(values) {
  const rows = canonicalInventory(values), keys = new Set();
  for (const row of rows) {
    check(/^[a-f0-9]{64}\.(?:gz|json)$/.test(row.key || '') && integer(row.bytes)
      && row.bytes > 0 && row.bytes <= 16 * 1024 * 1024 && !keys.has(row.key), 'The exact original archive inventory differs');
    keys.add(row.key);
  }
  check(rows.length > 0 && rows.length <= 100000, 'The original archive inventory is incomplete');
  return { rows, keys, inventorySha256: hash(encode(rows)), objects: rows.length, bytes: rows.reduce((n, row) => n + row.bytes, 0) };
}

// Only file references and referenced chunk IDs/sizes are read. Document-text
// chunks outside this immutable object union do not invalidate its attestation.
export async function captureNativeDriverAuditArchiveMetadata({ db, objects, targetIdentitySha256 }) {
  check(digest(targetIdentitySha256), 'The exact native database identity is required');
  const expected = inventory(objects), files = [], chunkSizes = new Map();
  for (let start = 0; start < expected.rows.length; start += 500) {
    const batch = expected.rows.slice(start, start + 500), found = await db.collection('driverAuditNativeFiles')
      .find({ _id: { $in: batch.map(row => row.key) } }, { projection: { _id: 1, reference: 1 } }).toArray();
    const mapped = new Map(found.map(row => [row._id, row]));
    check(mapped.size === batch.length && found.length === batch.length, 'A required native archive file is absent');
    for (const row of batch) {
      const ref = mapped.get(row.key)?.reference;
      check(ref?.version === 1 && ref.sha256 === row.key.slice(0, 64) && ref.size === row.bytes
        && Array.isArray(ref.chunks) && ref.chunks.length > 0 && ref.chunks.length <= 16,
      'A native archive file reference differs from the original');
      let size = 0;
      for (const part of ref.chunks) {
        check(digest(part?.sha256) && integer(part.size) && part.size > 0 && part.size <= 4 * 1024 * 1024
          && (!chunkSizes.has(part.sha256) || chunkSizes.get(part.sha256) === part.size), 'A native archive chunk reference differs');
        chunkSizes.set(part.sha256, part.size); size += part.size;
      }
      check(size === row.bytes, 'A native archive reference has incomplete byte coverage');
      files.push([row.key, ref]);
    }
  }
  const chunks = [...chunkSizes].sort(([a], [b]) => a.localeCompare(b));
  for (let start = 0; start < chunks.length; start += 500) {
    const batch = chunks.slice(start, start + 500), found = await db.collection('driverAuditNativeChunks')
      .find({ _id: { $in: batch.map(([id]) => id) } }, { projection: { _id: 1, size: 1 } }).toArray();
    const mapped = new Map(found.map(row => [row._id, row.size]));
    check(found.length === batch.length && mapped.size === batch.length && batch.every(([id, size]) => mapped.get(id) === size),
      'Native archive chunk metadata is absent or changed');
  }
  const filesSha256 = hash(encode(files)), chunksSha256 = hash(encode(chunks));
  const total = await db.collection('driverAuditNativeFiles').countDocuments();
  check(integer(total) && total >= expected.objects, 'Native archive file coverage differs');
  return { inventorySha256: expected.inventorySha256, objects: expected.objects, bytes: expected.bytes,
    targetDatabase: db.databaseName, targetIdentitySha256,
    filesSha256, chunksSha256, metadataSha256: hash(JSON.stringify([targetIdentitySha256, filesSha256, chunksSha256])),
    referencedChunks: chunks.length, protectedStagingExtras: total - expected.objects };
}

function validateClosure({ closure, profile, expected }) {
  check(closure?.version === 1 && closure.status === 'final-driver-audit-source-closure'
    && closure.verified === true && closure.complete === true, 'A final independently verified source closure is required');
  check(object(closure.origin) && ['sourceSnapshotSha256', 'restoreVerificationSha256', 'originalArchiveInventorySha256', 'sourceDumpSha256']
    .every(key => digest(closure.origin[key])), 'Original source and restored-backup provenance are required');
  check(closure.origin.acceptedNativeImportSha256s === undefined || Array.isArray(closure.origin.acceptedNativeImportSha256s)
    && closure.origin.acceptedNativeImportSha256s.length <= 64 && closure.origin.acceptedNativeImportSha256s.every(digest),
  'Accepted previous native import provenance differs');
  check(Number.isSafeInteger(closure.sourceRevision) && closure.sourceRevision > 0
    && digest(closure.collectorRootsSha256) && closure.collectorRootsSha256 === profile.collectorRootsSha256,
  'The final source closure and actual collector census differ');
  check(object(closure.bootstrap) && Number.isSafeInteger(closure.bootstrap.collectorRevision)
    && closure.bootstrap.collectorRevision > 0
    && ['manifestSha256', 'sourceBasis', 'seedSha256'].every(key => digest(closure.bootstrap[key])),
  'The actual original bootstrap identity is required');
  check(object(closure.inputs) && dataFiles.every(name => same(closure.inputs[name], profile[name])),
    'The source closure does not bind all original input files');
  check(closure.archive?.inventorySha256 === expected.inventorySha256 && closure.archive.objects === expected.objects
    && closure.archive.bytes === expected.bytes, 'The complete original physical object union differs');
  const coverage = closure.coverage;
  check(object(coverage) && object(coverage.photos) && object(coverage.gps) && object(coverage.raw) && object(coverage.results)
    && ['objects', 'bytes', 'identities'].every(key => integer(coverage.photos[key]))
    && ['objects', 'bytes', 'snapshotRefs'].every(key => integer(coverage.gps[key]))
    && coverage.photos.objects > 0 && coverage.gps.objects > 0 && coverage.photos.objects <= expected.objects
    && coverage.gps.objects <= expected.objects && coverage.photos.bytes <= expected.bytes && coverage.gps.bytes <= expected.bytes
    && integer(coverage.raw.identities) && integer(coverage.results.assessmentRows)
    && integer(coverage.results.historicalRows) && integer(coverage.reviewEvents), 'Pinned photo, GPS, result and review reference coverage is required');
  check(object(closure.gaps) && ['reviewContexts', 'images', 'logicalPaths'].every(key => Array.isArray(closure.gaps[key]))
    && closure.gaps.reviewContexts.every(digest) && closure.gaps.images.every(digest)
    && closure.gaps.logicalPaths.every(value => typeof value === 'string')
    && new Set(closure.gaps.reviewContexts).size === closure.gaps.reviewContexts.length,
  'The original unavailable-evidence baseline is required');
  check(Array.isArray(closure.inlineReferences) && closure.inlineReferences.length <= 4096,
    'Pinned inline original-source references are required');
}

function validateAttestation(attestation, metadata, implementationIdentities, now) {
  check(attestation?.version === 1 && attestation.kind === 'complete-native-archive-byte-attestation-v1'
    && attestation.verified === true && attestation.allObjectsRead === true
    && ['fresh-full-object-read', 'migration-cli-full-object-read'].includes(attestation.method)
    && attestation.inventorySha256 === metadata.inventorySha256 && attestation.objects === metadata.objects
    && digest(attestation.sourceObjectsSha256) && attestation.sourceObjectsInventorySha256 === metadata.inventorySha256
    && attestation.targetDatabase === metadata.targetDatabase && attestation.targetIdentitySha256 === metadata.targetIdentitySha256
    && attestation.bytes === metadata.bytes && attestation.bytesRead === metadata.bytes
    && attestation.metadataSha256 === metadata.metadataSha256
    && attestation.metadataBeforeSha256 === metadata.metadataSha256 && attestation.metadataAfterSha256 === metadata.metadataSha256
    && attestation.archiveImplementationSha256 === implementationIdentities.archiveSha256
    && Number.isFinite(Date.parse(attestation.completedAt)) && Date.parse(attestation.completedAt) <= now,
  'A complete immutable archive byte attestation is required');
  if (attestation.method === 'fresh-full-object-read') {
    check(attestation.sourceImplementationSha256 === implementationIdentities.verifierSha256,
      'The full byte verification implementation differs');
  } else {
    const result = attestation.cliReceipt;
    check(attestation.sourceImplementationSha256 === implementationIdentities.migrationCliSha256
      && digest(attestation.sourceProfileSha256) && result?.status === 'staged-data-verified'
      && result.importSha256 === attestation.sourceProfileSha256 && result.archiveObjects === metadata.objects
      && result.resultsEqual === true && result.reportIdentityEqual === true && result.assessmentHistoryEqual === true
      && result.activationPending === true && result.archiveClosurePending === true
      && digest(result.collectorRootsSha256) && hash(JSON.stringify(result)) === attestation.cliReceiptSha256,
    'The completed code-pinned migration byte verification is required');
  }
}
export { validateAttestation as validateDriverAuditNativeArchiveByteAttestation };

// Call only around the already-authorized migration CLI verification. This
// constructor does not execute the CLI or touch the database. Its owner-private
// result can replace another full archive scan after both metadata captures and
// the exact code-pinned CLI completion have been independently observed.
export function createDriverAuditNativeCliByteAttestation({ before, after, cliReceipt, sourceProfileSha256, sourceProfileBytes, sourceObjectsBytes,
  implementationIdentities, completedAt = new Date().toISOString() }) {
  check(same(before, after) && digest(sourceProfileSha256), 'The native archive changed during the migration byte pass');
  check(Buffer.isBuffer(sourceProfileBytes) && hash(sourceProfileBytes) === sourceProfileSha256,
    'The exact source CLI profile bytes are required');
  const sourceProfile = JSON.parse(sourceProfileBytes), ref = sourceProfile.objects;
  check(sourceProfile.version === 2 && sourceProfile.targetDatabase === before.targetDatabase && object(ref)
    && digest(ref.sha256) && typeof ref.file === 'string' && Buffer.isBuffer(sourceObjectsBytes)
    && sourceObjectsBytes.length <= 32 * 1024 * 1024 && hash(sourceObjectsBytes) === ref.sha256,
  'The source CLI object input is not bound to its profile');
  const raw = ref.file.endsWith('.gz') ? gunzipSync(sourceObjectsBytes, { maxOutputLength: 16 * 1024 * 1024 }) : sourceObjectsBytes;
  const sourceInventory = inventory(raw.toString('utf8').split('\n').filter(Boolean).map(JSON.parse));
  check(sourceInventory.inventorySha256 === before.inventorySha256 && sourceInventory.objects === before.objects
    && sourceInventory.bytes === before.bytes, 'The source CLI profile verified another physical object inventory');
  const attestation = { version: 1, kind: 'complete-native-archive-byte-attestation-v1', verified: true,
    method: 'migration-cli-full-object-read', allObjectsRead: true,
    sourceImplementationSha256: implementationIdentities.migrationCliSha256,
    archiveImplementationSha256: implementationIdentities.archiveSha256, sourceProfileSha256,
    sourceObjectsSha256: ref.sha256, sourceObjectsInventorySha256: sourceInventory.inventorySha256,
    inventorySha256: before.inventorySha256, objects: before.objects, bytes: before.bytes, bytesRead: before.bytes,
    targetDatabase: before.targetDatabase, targetIdentitySha256: before.targetIdentitySha256,
    metadataSha256: before.metadataSha256, metadataBeforeSha256: before.metadataSha256,
    metadataAfterSha256: after.metadataSha256, completedAt, cliReceipt, cliReceiptSha256: hash(JSON.stringify(cliReceipt)) };
  validateAttestation(attestation, before, implementationIdentities, Date.now());
  return attestation;
}

function manifestCoverage(manifest, expected) {
  check(manifest?.version === 1 && digest(manifest.sha256) && typeof manifest.domain === 'string'
    && typeof manifest.path === 'string' && integer(manifest.size) && manifest.size <= 128 * 1024 * 1024
    && Array.isArray(manifest.chunks), 'An original review manifest differs');
  let offset = 0;
  for (const part of manifest.chunks) {
    check(part.offset === offset && digest(part.sha256) && integer(part.size) && part.size > 0
      && expected.get(part.sha256 + '.gz') === part.size, 'A review dependency is outside the complete original object union');
    offset += part.size;
  }
  check(offset === manifest.size, 'Original review dependency byte coverage differs');
}

async function verifyInline(archive, references, expected) {
  const groups = new Map(), seen = new Set(); let bytesReadFresh = 0;
  for (const ref of references) {
    check(object(ref) && expected.has(ref.objectKey) && typeof ref.pointer === 'string'
      && ref.pointer.startsWith('/') && ref.pointer.length <= 4096 && ref.pointer.split('/').length <= 65
      && ['base64', 'json', 'text'].includes(ref.encoding) && ['gps', 'source'].includes(ref.kind)
      && digest(ref.sha256) && integer(ref.bytes) && ref.bytes <= 128 * 1024 * 1024, 'An inline original-source reference differs');
    const id = JSON.stringify([ref.objectKey, ref.pointer]); check(!seen.has(id), 'Duplicate inline original-source reference'); seen.add(id);
    if (!groups.has(ref.objectKey)) groups.set(ref.objectKey, []);
    groups.get(ref.objectKey).push(ref);
  }
  for (const [key, refs] of groups) {
    let packed = Buffer.concat(await archive.readObject(key, { maxBytes: expected.get(key) }));
    check(packed.length === expected.get(key) && hash(packed) === key.slice(0, 64), 'Inline source container differs');
    bytesReadFresh += packed.length;
    if (packed[0] === 31 && packed[1] === 139) packed = gunzipSync(packed, { maxOutputLength: 128 * 1024 * 1024 });
    const container = JSON.parse(packed); packed = null;
    for (const ref of refs) {
    let value = container;
    for (const token of ref.pointer.slice(1).split('/')) {
      check(!/~(?![01])/.test(token), 'Invalid inline original-source pointer');
      const name = token.replace(/~1/g, '/').replace(/~0/g, '~');
      check(value !== null && typeof value === 'object' && Object.hasOwn(value, name), 'Original inline evidence is absent'); value = value[name];
    }
    let bytes;
    if (ref.encoding === 'base64') {
      check(typeof value === 'string', 'Original inline encoding differs'); bytes = Buffer.from(value, 'base64');
      check(bytes.toString('base64') === value, 'Original inline encoding differs');
    } else { check(ref.encoding === 'json' || typeof value === 'string', 'Original inline text differs');
      bytes = Buffer.from(ref.encoding === 'json' ? JSON.stringify(value) : value); }
    check(bytes.length === ref.bytes && hash(bytes) === ref.sha256, 'Original inline GPS or source bytes differ');
    }
  }
  return { verified: references.length, containers: groups.size, referenceSha256: hash(JSON.stringify(references)), bytesReadFresh, checkedFresh: true };
}

// This verifier reads native collections and pinned original files only. It
// never invokes the migration CLI, initializes collections, updates authority,
// obtains source data, or treats a partial CLI result as complete closure.
export async function verifyDriverAuditNativeParity(args) {
  const { db, archive, profileBytes, profileSha256, closureProofBytes, closureProofSha256, sessionId,
    implementationIdentities, targetIdentitySha256, readRows, readPinnedJson, readText, readTechnical, isTechnicalKey,
    createReceiptSelection, collectCensus } = args;
  let phase = 'pinned-inputs';
  try {
    check(uuid(sessionId) && digest(profileSha256) && hash(profileBytes) === profileSha256
      && digest(closureProofSha256) && hash(closureProofBytes) === closureProofSha256, 'The exact original import and closure pins are required');
    const profile = JSON.parse(profileBytes), closure = JSON.parse(closureProofBytes);
    check(profile.version === 2 && profile.receiptInput === 'selected' && profile.targetDatabase === db.databaseName
      && integer(profile.capacityBytes) && profile.capacityBytes > 0 && digest(profile.collectorRootsSha256)
      && dataFiles.every(key => object(profile[key]) && digest(profile[key].sha256)), 'A complete selected-receipt native import profile is required');
    check(object(implementationIdentities) && ['verifierSha256', 'archiveSha256', 'migrationCliSha256']
      .every(key => digest(implementationIdentities[key])), 'Trusted verification implementation identities are required');
    const objects = await Array.fromAsync(readRows(profile.objects)), expected = inventory(objects), expectedMap = new Map(expected.rows.map(row => [row.key, row.bytes]));
    validateClosure({ closure, profile, expected });
    const importedOrigins = new Set([profileSha256, ...(digest(profile.previousImportSha256) ? [profile.previousImportSha256] : []),
      ...(closure.origin.acceptedNativeImportSha256s || [])]);
    const original = await Array.fromAsync(readRows(profile.documents));
    const backup = await readPinnedJson(profile.bookkeepingBackup);
    check(backup?.verified === true && backup.originalsPreserved === true && digest(backup.originalReceiptSha256)
      && backup.sourceDumpSha256 === closure.origin.sourceDumpSha256 && backup.liveReceiptSha256 === profile.receipts.sha256
      && backup.collectorRootsSha256 === closure.collectorRootsSha256 && integer(backup.liveReceiptCount)
      && integer(backup.receiptCount) && backup.receiptCount >= backup.liveReceiptCount,
    'The original selected receipt backup and provenance differ');
    const census = async () => {
      const value = await collectCensus(original);
      check(value?.sha256 === closure.collectorRootsSha256 && same(value.bootstrap, closure.bootstrap)
        && Array.isArray(value.collectorRevisions) && value.collectorRevisions.includes(closure.sourceRevision)
        && value.collectorRevisions.includes(closure.bootstrap.collectorRevision), 'The actual final collector or bootstrap census changed');
      return value;
    };
    phase = 'actual-census'; const roots = await census();
    check(typeof createReceiptSelection === 'function', 'The reviewed original receipt selector is required');
    const receiptSelection = createReceiptSelection({ backup, originalReceiptSha256: backup.originalReceiptSha256,
      collectorRevisions: roots.collectorRevisions, receiptBindings: roots.receiptBindings });
    const authority = await db.collection('driverAuditNativeControl').findOne({ _id: 'authority' });
    check(authority?.status === 'staging' && authority.importSha256 === profileSha256 && integer(authority.writeFence),
      'The native staged authority differs');
    const authoritySha256 = hash(JSON.stringify(authority));
    phase = 'native-record-indexes';
    // One bounded index read per collection replaces tens of thousands of
    // serial remote lookups. Every text payload is still freshly hash checked.
    const documentIndex = await nativeIndex(db, 'driverAuditNativeDocuments');
    const receiptIndex = await nativeIndex(db, 'driverAuditNativeReceipts', row => JSON.stringify([row.key, row.revision]));
    const historicalIndex = await nativeIndex(db, 'driverAuditNativeHistorical');
    const contextIndex = await nativeIndex(db, 'driverAuditNativeReviewContexts');
    const reviewFileIndex = await nativeIndex(db, 'driverAuditNativeReviewFiles');
    const counts = { documents: 0, receipts: 0, historical: 0, reviewEvents: 0, reviewContexts: 0,
      availableReviewContexts: 0, sourceMissingReviewContexts: 0, reviewFiles: 0, archiveObjects: expected.objects };
    const fingerprints = Object.fromEntries(['documents', 'receipts', 'historical', 'reviewEvents'].map(key => [key, createHash('sha256')]));
    const keys = new Set(), reviewHashes = new Set();
    phase = 'current-documents';
    await verifyTextBatches(original, async row => {
      check(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(row.key || '') && !keys.has(row.key) && Number.isSafeInteger(row.revision) && row.revision > 0
        && typeof row.body_text === 'string', 'Original document identities differ'); keys.add(row.key);
      const saved = documentIndex.get(row.key), bodySha256 = hash(row.body_text);
      check(saved && saved.revision === row.revision && saved.body_sha256 === bodySha256 && importedOrigins.has(saved.importedBy)
        && saved.importedRevision === row.revision && saved.importedBodySha256 === bodySha256,
      'An original current document or imported provenance differs');
      const text = saved.body_control ? await readTechnical(saved.body_control) : await readText(saved.body_ref);
      check(text === row.body_text, 'Original current document bytes differ');
      return bodySha256;
    }, (row, bodySha256) => {
      fingerprints.documents.update(JSON.stringify([row.key, row.revision, bodySha256]) + '\n'); counts.documents++;
      if (row.key === 'review-journal' || row.key.endsWith(':review-journal')) {
        const value = JSON.parse(row.body_text); check(Array.isArray(value.records?.reportingReviews), 'Original human review history differs');
        for (const event of value.records.reportingReviews) {
          check(digest(event?.data?.snapshotHash), 'Original human review context identity differs'); reviewHashes.add(event.data.snapshotHash);
          fingerprints.reviewEvents.update(JSON.stringify([row.key, event]) + '\n'); counts.reviewEvents++;
        }
      }
    });
    check(keys.has('collector-state') && keys.has('review-journal')
      && original.find(row => row.key === 'collector-state').revision === closure.sourceRevision,
    'Original collector and human review heads are required');
    phase = 'original-receipts'; const receiptKeys = new Set(), collectorRevisions = new Set();
    await verifyTextBatches(readRows(profile.receipts), async row => {
      const id = JSON.stringify([row.key, row.revision]);
      check(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(row.key || '') && Number.isSafeInteger(row.revision) && row.revision > 0
        && typeof row.event_id === 'string' && !receiptKeys.has(id) && !isTechnicalKey(row.key) && (row.key !== 'collector-state' || roots.collectorRevisions.includes(row.revision))
        && receiptSelection.include(row) && typeof row.body_text === 'string' && typeof row.event_text === 'string' && hash(row.body_text) === row.body_sha256
        && digest(row.request_sha256) && typeof row.created_at === 'string' && Number.isFinite(Date.parse(row.created_at)),
      'The original selected receipt coverage differs'); receiptKeys.add(id);
      if (row.key === 'collector-state') collectorRevisions.add(row.revision);
      const saved = receiptIndex.get(id);
      check(saved && saved.event_id === row.event_id && saved.request_sha256 === row.request_sha256
        && saved.body_sha256 === row.body_sha256 && saved.event_sha256 === hash(row.event_text)
        && saved.created_at === row.created_at && importedOrigins.has(saved.importedBy)
        && await readText(saved.body_ref) === row.body_text && await readText(saved.event_ref) === row.event_text,
      'Original receipt body, event, clock or imported provenance differs');
    }, row => {
      fingerprints.receipts.update(JSON.stringify([row.key, row.revision, row.event_id, row.request_sha256,
        row.body_sha256, hash(row.event_text), row.created_at]) + '\n'); counts.receipts++;
    });
    check(counts.receipts === backup.liveReceiptCount && roots.collectorRevisions.every(value => collectorRevisions.has(value)),
      'A required original collector receipt is absent');
    phase = 'original-history'; const historicalIds = new Set();
    await verifyTextBatches(readRows(profile.historical), async row => {
      check(typeof row.namespace === 'string' && typeof row.body_text === 'string', 'Original historical source identity differs');
      const rowSha256 = hash(row.body_text), id = hash(JSON.stringify([row.namespace, rowSha256]));
      check(!historicalIds.has(id), 'Duplicate original historical identity'); historicalIds.add(id);
      const saved = historicalIndex.get(id);
      check(saved && saved.namespace === row.namespace && saved.rowSha256 === rowSha256 && importedOrigins.has(saved.importedBy)
        && await readText(saved.body_ref) === row.body_text, 'Original historical namespace, identity, bytes or provenance differs');
      return rowSha256;
    }, (row, rowSha256) => {
      fingerprints.historical.update(JSON.stringify([row.namespace, rowSha256]) + '\n'); counts.historical++;
    });
    check(counts.historical === closure.coverage.results.historicalRows && counts.reviewEvents === closure.coverage.reviewEvents,
      'Pinned original historical or human review coverage differs');
    phase = 'review-contexts'; const contexts = new Map(), dependencies = new Map(), reviewFiles = new Map();
    for await (const row of readRows(profile.reviewContexts)) {
      check(reviewHashes.has(row?.snapshotHash) && !contexts.has(row.snapshotHash)
        && ['available', 'source-missing'].includes(row.availability) && Array.isArray(row.provenance) && row.provenance.length > 0,
      'Original human context coverage or provenance differs');
      if (row.availability === 'available') {
        check(['state', 'archive'].includes(row.manifest?.domain)
          && row.manifest.path === 'review-snapshots/' + row.snapshotHash + '.json.gz', 'Original human snapshot manifest differs');
        manifestCoverage(row.manifest, expectedMap); counts.availableReviewContexts++;
      } else { check(row.manifest === undefined, 'A source-missing review context gained a manifest'); counts.sourceMissingReviewContexts++; }
      contexts.set(row.snapshotHash, row);
    }
    check(contexts.size === reviewHashes.size && same([...contexts.values()].filter(row => row.availability === 'source-missing')
      .map(row => row.snapshotHash).sort(), [...closure.gaps.reviewContexts].sort()), 'Original unavailable review context baseline differs');
    for await (const row of readRows(profile.reviewDependencies)) {
      check(contexts.has(row?.snapshotHash) && !dependencies.has(row.snapshotHash) && Array.isArray(row.files), 'Original review dependency coverage differs');
      dependencies.set(row.snapshotHash, row);
    }
    check(dependencies.size === contexts.size, 'An original human dependency set is absent');
    for (const [snapshotHash, context] of contexts) {
      const related = dependencies.get(snapshotHash), bytes = Buffer.from(JSON.stringify({ context, dependencies: related }));
      const saved = contextIndex.get(snapshotHash);
      check(saved && saved.availability === context.availability && saved.sha256 === hash(bytes)
        && (await archive.readBytes(saved.reference, { maxBytes: bytes.length })).equals(bytes), 'Stored human review context differs');
      for (const manifest of [context.manifest, ...related.files].filter(Boolean)) {
        manifestCoverage(manifest, expectedMap); const id = hash(JSON.stringify([manifest.domain, manifest.path]));
        check(!reviewFiles.has(id) || same(reviewFiles.get(id), manifest), 'Original human context file identities conflict'); reviewFiles.set(id, manifest);
      }
    }
    for (const [id, manifest] of reviewFiles) {
      const saved = reviewFileIndex.get(id);
      check(saved && same(saved.manifest, manifest), 'Stored human review dependency differs');
    }
    counts.reviewContexts = contexts.size; counts.reviewFiles = reviewFiles.size;
    for (const [collection, count] of [['driverAuditNativeDocuments', counts.documents], ['driverAuditNativeReceipts', counts.receipts],
      ['driverAuditNativeHistorical', counts.historical], ['driverAuditNativeReviewContexts', counts.reviewContexts], ['driverAuditNativeReviewFiles', counts.reviewFiles]]) {
      check(await db.collection(collection).countDocuments() === count, 'Native original-record coverage differs');
    }
    phase = 'archive-metadata'; const before = await captureNativeDriverAuditArchiveMetadata({ db, objects, targetIdentitySha256 });
    const now = (args.now || Date.now)();
    let attestation = args.priorArchiveAttestation || await args.readArchiveAttestation?.(before);
    let mode = 'reused-full-byte-attestation', objectBytesReadFresh = 0;
    if (attestation) validateAttestation(attestation, before, implementationIdentities, now);
    else {
      phase = 'archive-bytes'; let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(4, objects.length) }, async () => {
        for (;;) {
          const row = expected.rows[cursor++]; if (!row) return;
          const bytes = Buffer.concat(await archive.readObject(row.key, { maxBytes: row.bytes }));
          check(bytes.length === row.bytes && hash(bytes) === row.key.slice(0, 64), 'Original native GPS, photo or source archive bytes differ');
          objectBytesReadFresh += bytes.length;
        }
      }));
      check(objectBytesReadFresh === expected.bytes, 'The full native archive byte pass is incomplete');
      mode = 'fresh-full-object-read';
      attestation = { version: 1, kind: 'complete-native-archive-byte-attestation-v1', verified: true,
        method: mode, allObjectsRead: true, sourceImplementationSha256: implementationIdentities.verifierSha256,
        archiveImplementationSha256: implementationIdentities.archiveSha256, sourceProfileSha256: profileSha256,
        sourceObjectsSha256: profile.objects.sha256, sourceObjectsInventorySha256: expected.inventorySha256,
        targetDatabase: before.targetDatabase, targetIdentitySha256,
        inventorySha256: expected.inventorySha256, objects: expected.objects, bytes: expected.bytes, bytesRead: objectBytesReadFresh,
        metadataSha256: before.metadataSha256, metadataBeforeSha256: before.metadataSha256,
        metadataAfterSha256: before.metadataSha256, completedAt: new Date((args.now || Date.now)()).toISOString() };
    }
    phase = 'inline-originals'; const inlineReferences = await verifyInline(archive, closure.inlineReferences, expectedMap);
    phase = 'final-stability'; const after = await captureNativeDriverAuditArchiveMetadata({ db, objects, targetIdentitySha256 });
    check(same(before, after), 'Immutable native archive metadata changed during verification');
    check(hash(JSON.stringify(await db.collection('driverAuditNativeControl').findOne({ _id: 'authority' }))) === authoritySha256,
      'Native authority or staged state changed during verification');
    await census();
    const result = { version: 1, status: 'complete-native-parity-verified', verified: true, sessionId,
      profileSha256, closureProofSha256, collectorRootsSha256: roots.sha256,
      sourceRevision: closure.sourceRevision, counts,
      fingerprints: Object.fromEntries(Object.entries(fingerprints).map(([name, value]) => [name, value.digest('hex')])),
      originSha256: hash(JSON.stringify(closure.origin)), bootstrapSha256: hash(JSON.stringify(closure.bootstrap)),
      semanticCoverage: { basis: 'pinned-independent-final-source-closure',
        photos: { objects: closure.coverage.photos.objects, bytes: closure.coverage.photos.bytes, identities: closure.coverage.photos.identities },
        gps: { objects: closure.coverage.gps.objects, bytes: closure.coverage.gps.bytes, snapshotRefs: closure.coverage.gps.snapshotRefs },
        raw: { identities: closure.coverage.raw.identities }, results: { assessmentRows: closure.coverage.results.assessmentRows,
          historicalRows: closure.coverage.results.historicalRows }, reviewEvents: closure.coverage.reviewEvents },
      sourceGaps: { reviewContexts: closure.gaps.reviewContexts.length, images: closure.gaps.images.length,
        logicalPaths: closure.gaps.logicalPaths.length, baselineSha256: hash(JSON.stringify(closure.gaps)) },
      completeByteParity: { verified: true, inventorySha256: expected.inventorySha256, objects: expected.objects, bytes: expected.bytes,
        basis: 'complete-pinned-original-closure-and-native-byte-equality' },
      archive: { mode, objectBytesReadFresh, inventorySha256: expected.inventorySha256, metadataSha256: before.metadataSha256,
        targetIdentitySha256,
        fullBytesVerifiedAt: attestation.completedAt, sourceImplementationSha256: attestation.sourceImplementationSha256,
        archiveImplementationSha256: attestation.archiveImplementationSha256, protectedStagingExtras: before.protectedStagingExtras },
      inlineReferences, archiveAttestation: attestation,
      resultsEqual: true, gpsEqual: true, photosEqual: true, reviewHistoryEqual: true,
      freshOriginalRecordComparisons: true, authorityChanged: false, activationPending: true };
    return result;
  } catch (error) {
    throw Object.assign(Error(error.parityGuard ? error.message : 'Native parity stopped at ' + phase), { phase });
  }
}

async function savePrivateReceipt(file, bytes, read) {
  try { const existing = await read(file, 4 * 1024 * 1024);
    check(hash(existing) === hash(bytes), 'An immutable private parity receipt differs'); return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = file + '.' + randomUUID() + '.tmp', handle = await fs.open(temporary, 'wx', 0o600);
  try { try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await fs.link(temporary, file); const directory = await fs.open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await fs.unlink(temporary); }
}

// Public dispatch supplies identities only. The host derives every private path
// and every application import from its exact reviewed deployed checkout.
export async function runDriverAuditNativeParity({ sessionId, profileSha256, closureProofSha256, expectedSha, appRoot,
  recipientPublicKey }, adapters = {}) {
  let phase = 'checkout', connection, lock;
  const exec = adapters.exec || execute, env = adapters.env || process.env;
  try {
    check(uuid(sessionId) && digest(profileSha256) && digest(closureProofSha256), 'Public session, import and closure identities are required');
    if (recipientPublicKey !== undefined) validatePublicRecipient(recipientPublicKey);
    check(typeof appRoot === 'string' && path.isAbsolute(appRoot) && path.resolve(appRoot) === appRoot
      && await fs.realpath(appRoot) === appRoot, 'The exact application root is required');
    const checkout = async () => {
      check((adapters.platform || process.platform) === 'linux' && /^[a-f0-9]{40}$/.test(expectedSha || '')
        && (await exec('git', ['rev-parse', 'HEAD'], { cwd: appRoot, timeout: 5000, maxBuffer: 4096 })).stdout.trim() === expectedSha,
      'The exact reviewed Linux checkout is required');
      await exec('git', ['diff', '--quiet', expectedSha, '--', 'server/services/driverAuditSource.js',
        'server/services/driverAuditLiveImport.js', 'server/services/driverAuditOriginalSourceLineage.js', 'server/services/driverAuditMongoArchive.js',
        'server/services/driverAuditMongoText.js', 'server/services/driverAuditTechnicalState.js',
        'server/services/driverAuditTransferCodec.js',
        'server/scripts/driverAuditMongoMigrate.js'], { cwd: appRoot, timeout: 5000, maxBuffer: 4096 });
    };
    await checkout(); const server = path.join(appRoot, 'server');
    const load = adapters.load || (name => import(pathToFileURL(path.join(server, name)).href));
    await load('loadEnv.js');
    const { readPrivateDriverAuditSource: read, requirePrivateDriverAuditSourceDirectory: privateDirectory } = await load('services/driverAuditSource.js');
    const transferRoot = path.join(server, '.private/driver-audit-native-transfer'), folder = path.join(transferRoot, sessionId);
    phase = 'private-session'; await privateDirectory(transferRoot); await privateDirectory(folder);
    const { acquireWorkerLock } = await load('vendor/driver-audits/integration/hosted/worker-lock.mjs');
    lock = await acquireWorkerLock(path.join(transferRoot, 'operator.lock'));
    const state = JSON.parse(await read(path.join(folder, 'session.private.json'), 128 * 1024));
    const received = JSON.parse(await read(path.join(folder, 'received.private.json'), 1024 * 1024));
    check(state.version === 1 && state.sessionId === sessionId && digest(state.inventorySha256)
      && state.plan?.inventorySha256 === state.inventorySha256 && integer(state.createdAt) && state.createdAt <= Date.now()
      && received.version === 1 && received.verified === true && received.status === 'transfer-received'
      && received.sessionId === sessionId && received.targetDatabase === state.targetDatabase
      && received.inventorySha256 === state.inventorySha256 && received.authorityChanged === false
      && received.objects === state.plan.objectCount && received.bytes === state.plan.objectBytes
      && integer(received.objects) && received.objects > 0 && received.objects <= 100000
      && integer(received.bytes) && received.bytes > 0 && received.bytes <= 16 * 1024 ** 3
      && Number.isFinite(Date.parse(received.completedAt)) && Date.parse(received.completedAt) >= state.createdAt
      && Date.parse(received.completedAt) <= Date.now(),
    'The verified original transfer receipt differs');
    const profileBytes = await read(path.join(folder, 'profile.private.json'), 1024 * 1024);
    check(hash(profileBytes) === profileSha256, 'The owner-private native import profile differs');
    const profile = JSON.parse(profileBytes), closureProofBytes = await read(path.join(folder, 'closure-proof.private.json'), 16 * 1024 * 1024);
    check(profile.capacityBytes === state.capacityBytes, 'The exact staged native allowance differs');
    check(hash(closureProofBytes) === closureProofSha256, 'The owner-private final closure proof differs');
    const inputReferences = [];
    for (const name of dataFiles) {
      const ref = profile[name], records = received.inputFiles?.filter(row => row.name === ref?.file);
      check(object(ref) && /^[a-zA-Z0-9][a-zA-Z0-9._-]+\.(?:jsonl(?:\.gz)?|private\.json)$/.test(ref.file || '')
        && digest(ref.sha256) && records?.length === 1 && records[0].sha256 === ref.sha256
        && integer(records[0].bytes) && records[0].bytes > 0 && records[0].bytes <= 64 * 1024 * 1024,
      'An original import file lacks received provenance');
      inputReferences.push({ ref, received: records[0] });
    }
    const verifyInputPins = async () => {
      for (const item of inputReferences) {
        const bytes = await read(path.join(folder, item.ref.file), item.received.bytes);
        check(bytes.length === item.received.bytes && hash(bytes) === item.ref.sha256, 'A received original input changed');
      }
      check(hash(await read(path.join(folder, 'profile.private.json'), 1024 * 1024)) === profileSha256
        && hash(await read(path.join(folder, 'closure-proof.private.json'), 16 * 1024 * 1024)) === closureProofSha256,
      'The pinned profile or final closure changed');
    };
    await verifyInputPins();
    phase = 'database'; check(typeof env.MONGODB_URI === 'string' && env.MONGODB_URI.length > 0, 'The existing app database is required');
    const { default: mongoose } = await load('node_modules/mongoose/index.js');
    connection = mongoose.createConnection(env.MONGODB_URI, { autoCreate: false, autoIndex: false, maxPoolSize: 4, serverSelectionTimeoutMS: 10000 });
    await connection.asPromise(); const db = connection.db;
    check(db.databaseName === state.targetDatabase && db.databaseName === profile.targetDatabase, 'The exact target database differs');
    const syncParent = path.join(server, '.private/driver-audits');
    check(path.dirname(profile.syncRoot || '') === syncParent && digest(path.basename(profile.syncRoot)), 'The managed sync root differs');
    const stopped = async () => {
      const entries = JSON.parse((await exec('pm2', ['jlist'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 })).stdout);
      const sync = entries.filter(row => row.name === 'matter-driver-audit-sync');
      check(Array.isArray(entries) && sync.length === 1 && sync[0].pm2_env?.status === 'stopped'
        && sync[0].pm2_env.pm_cwd === server && sync[0].pm2_env.pm_exec_path === path.join(server, 'scripts/driverAuditSync.js')
        && same(sync[0].pm2_env.args, ['--config', path.join(profile.syncRoot, 'sync.json')])
        && entries.filter(row => row.name === 'matter-driver-audit-source').every(row => row.pm2_env?.status === 'stopped')
        && !await db.collection('driverAuditControl').findOne({ _id: 'direct-stage' }), 'Stopped original report workers and stable roots are required');
    };
    phase = 'writers'; await stopped(); await privateDirectory(profile.syncRoot);
    const { readDriverAuditImportRows, collectDriverAuditReceiptRoots, createDriverAuditReceiptSelection,
      isDriverAuditTechnicalKey } = await load('services/driverAuditLiveImport.js');
    const { createDriverAuditMongoArchive } = await load('services/driverAuditMongoArchive.js');
    const { createDriverAuditMongoTextReader } = await load('services/driverAuditMongoText.js');
    const { createDriverAuditTechnicalState } = await load('services/driverAuditTechnicalState.js');
    const archive = createDriverAuditMongoArchive({ db, client: connection.getClient(), capacityBytes: profile.capacityBytes });
    const technical = createDriverAuditTechnicalState({ db, objects: archive });
    const readPinnedJson = async ref => { const bytes = await read(path.join(folder, ref.file), 1024 * 1024);
      check(hash(bytes) === ref.sha256, 'Pinned original backup proof differs'); return JSON.parse(bytes); };
    const implementationIdentities = {
      verifierSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))),
      archiveSha256: hash(await fs.readFile(path.join(server, 'services/driverAuditMongoArchive.js'))),
      migrationCliSha256: hash(await fs.readFile(path.join(server, 'scripts/driverAuditMongoMigrate.js'))),
    };
    const targetIdentitySha256 = nativeDriverAuditTargetIdentity(env.MONGODB_URI, db.databaseName);
    const attestationFile = metadata => path.join(transferRoot, 'archive-bytes-' + metadata.inventorySha256 + '-' + metadata.metadataSha256 + '.private.json');
    let priorAttestationBytes;
    phase = 'complete-parity';
    const result = await verifyDriverAuditNativeParity({ db, archive, profileBytes, profileSha256, closureProofBytes, closureProofSha256,
      sessionId, implementationIdentities, targetIdentitySha256, readRows: ref => readDriverAuditImportRows(folder, ref), readPinnedJson,
      readText: createDriverAuditMongoTextReader(archive), readTechnical: reference => technical.read(reference), isTechnicalKey: isDriverAuditTechnicalKey,
      createReceiptSelection: createDriverAuditReceiptSelection,
      collectCensus: async documents => {
        const value = await collectDriverAuditReceiptRoots({ db, documents, syncRoot: profile.syncRoot });
        const bytes = await read(path.join(profile.syncRoot, 'seed.json'), 1024 * 1024), seed = JSON.parse(bytes);
        check(value.roots.some(root => root.kind === 'seed.json' && root.sha256 === hash(bytes)), 'The census bootstrap seed changed');
        return { ...value, bootstrap: { collectorRevision: seed.collectorRevision, manifestSha256: seed.manifestSha256,
          sourceBasis: seed.sourceBasis, seedSha256: hash(bytes) } };
      }, readArchiveAttestation: async metadata => {
        try { priorAttestationBytes = await read(attestationFile(metadata), 1024 * 1024); return JSON.parse(priorAttestationBytes); }
        catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
      } });
    await stopped(); await checkout(); await verifyInputPins();
    phase = 'private-receipts';
    const archiveBytes = priorAttestationBytes || Buffer.from(JSON.stringify(result.archiveAttestation, null, 2) + '\n');
    if (!priorAttestationBytes) await savePrivateReceipt(attestationFile(result.archive), archiveBytes, read);
    const receipt = { ...result, applicationCommit: expectedSha, verifiedAt: new Date().toISOString(), archiveAttestationSha256: hash(archiveBytes) };
    delete receipt.archiveAttestation;
    const receiptBytes = Buffer.from(JSON.stringify(receipt, null, 2) + '\n');
    const receiptFile = path.join(folder, 'parity-' + profileSha256 + '-' + closureProofSha256 + '-' + hash(receiptBytes) + '.private.json');
    await savePrivateReceipt(receiptFile, receiptBytes, read);
    let sealedReceipt;
    if (recipientPublicKey !== undefined) {
      phase = 'sealed-receipt';
      check((await read(receiptFile, 4 * 1024 * 1024)).equals(receiptBytes), 'The saved private parity receipt changed');
      const { sealTransferSecrets } = await load('services/driverAuditTransferCodec.js');
      const capsule = sealTransferSecrets(recipientPublicKey, { version: 1, kind: 'native-parity-receipt-export-v1',
        sessionId, applicationCommit: expectedSha, profileSha256, closureProofSha256,
        receiptSha256: hash(receiptBytes), receiptBytes: receiptBytes.length, dataBase64: receiptBytes.toString('base64') });
      await stopped(); await checkout(); await verifyInputPins();
      check((await read(receiptFile, 4 * 1024 * 1024)).equals(receiptBytes), 'The saved private parity receipt changed');
      sealedReceipt = { recipientSha256: hash(recipientPublicKey), receiptSha256: hash(receiptBytes), capsule };
    }
    return { ...receipt, receiptSha256: hash(receiptBytes), ...(sealedReceipt ? { sealedReceipt } : {}) };
  } catch (error) {
    throw Object.assign(Error(error.parityGuard ? error.message : 'Native parity stopped at ' + phase), { phase: error.phase || phase });
  } finally {
    let failed = false; try { await connection?.close(); } catch { failed = true; }
    try { await lock?.release(); } catch { failed = true; }
    if (failed) throw Object.assign(Error('Native parity cleanup stopped'), { phase: 'cleanup' });
  }
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runDriverAuditNativeParity({ sessionId: process.env.NATIVE_TRANSFER_SESSION_ID,
    profileSha256: process.env.NATIVE_IMPORT_PROFILE_SHA256, closureProofSha256: process.env.NATIVE_CLOSURE_PROOF_SHA256,
    expectedSha: process.env.EXPECTED_DEPLOYED_SHA, appRoot: await fs.realpath(process.cwd()) }))); }
  catch (error) { console.error('Native parity stopped at ' + (error.phase || 'checkout') + '. Check the pinned originals and unchanged native staging state.'); process.exitCode = 1; }
}
