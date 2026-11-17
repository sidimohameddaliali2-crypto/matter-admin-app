import '../loadEnv.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import { createDriverAuditMongoArchive } from '../services/driverAuditMongoArchive.js';
import { validateDriverAuditSpacesArchiveReference } from '../services/driverAuditSpacesArchive.js';
import { createDriverAuditMongoTextReader } from '../services/driverAuditMongoText.js';
import { importDriverAuditReviewContexts } from '../services/driverAuditReviewContexts.js';
import { collectDriverAuditReceiptRoots, createDriverAuditReceiptSelection,
  readDriverAuditImportRows as verifiedRows } from '../services/driverAuditLiveImport.js';
import { createDriverAuditMongoRpc, initializeDriverAuditMongoRpc } from '../services/driverAuditMongoRpc.js';
import { importDriverAuditMongoDocuments, importDriverAuditMongoHistorical,
  importDriverAuditMongoReceipts } from '../services/driverAuditMongoImport.js';
import { createCloudRepository } from '../vendor/driver-audits/integration/cloud/repository.mjs';
import { createCloudState } from '../vendor/driver-audits/integration/cloud/cloud-state.mjs';
import { readPrivateDriverAuditSource, verifyDriverAuditSource } from '../services/driverAuditSource.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;

async function objectFileIndex(db, objectIndex) {
  const records = new Map(), keys = new Set();
  if (!Array.isArray(objectIndex) || objectIndex.length > 100000) throw Error('The native archive inventory exceeds its bound');
  for (const row of objectIndex) {
    if (!/^[a-f0-9]{64}\.(?:gz|json)$/.test(row?.key || '') || !Number.isSafeInteger(row.bytes)
      || row.bytes < 1 || row.bytes > 16 * 1024 * 1024 || keys.has(row.key)) throw Error('The native archive inventory is invalid');
    keys.add(row.key);
  }
  for (let start = 0; start < objectIndex.length; start += 500) {
    const batch = objectIndex.slice(start, start + 500), wanted = new Set(batch.map(row => row.key));
    const found = await db.collection('driverAuditNativeFiles').find({ _id: { $in: [...wanted] } }).toArray();
    for (const row of found) {
      if (!wanted.has(row._id) || records.has(row._id)) throw Error('Native archive metadata identities differ');
      records.set(row._id, row);
    }
  }
  return records;
}

async function objectStoreBinding(db, configuredIdentitySha256) {
  if (configuredIdentitySha256 !== undefined && !hashPattern.test(configuredIdentitySha256)) throw Error('Invalid configured archive identity');
  const row = await db.collection('driverAuditNativeControl').findOne({ _id: 'archive-object-store' });
  if (row && (Object.keys(row).sort().join(',') !== '_id,identitySha256,provider,version'
      || row.version !== 1 || row.provider !== 'spaces' || !hashPattern.test(row.identitySha256 || '')
      || row.identitySha256 !== configuredIdentitySha256)) throw Error('Native archive object store identity differs');
  return row;
}

function archiveFileReference(saved, row, store) {
  const external = Object.hasOwn(saved, 'externalReference');
  if (saved._id !== row.key || Object.keys(saved).sort().join(',') !== (external ? '_id,externalReference' : '_id,reference')) {
    throw Error('Native archive file metadata is mixed or contains unknown fields');
  }
  if (external) {
    if (!store) throw Error('Native external archive identity is absent');
    return { external: true, reference: validateDriverAuditSpacesArchiveReference(saved.externalReference,
      { identitySha256: store.identitySha256, key: row.key, bytes: row.bytes }) };
  }
  const ref = saved.reference;
  if (!ref || Object.keys(ref).sort().join(',') !== 'chunks,sha256,size,version'
    || ref.version !== 1 || ref.sha256 !== row.key.slice(0, 64) || ref.size !== row.bytes
    || !Array.isArray(ref.chunks) || ref.chunks.length < 1 || ref.chunks.length > 16
    || ref.chunks.some(part => !part || Object.keys(part).sort().join(',') !== 'sha256,size')) {
    throw Error('Native archive object metadata differs');
  }
  return { external: false, reference: ref };
}

// Previously received objects were already hash-read back by the immutable
// native writer. Staging checks references and chunk presence without another
// complete payload scan. It cannot mint a byte-verification or activation proof.
export async function stageDriverAuditMongoArchiveObjects({ db, archive, objectIndex, readOriginal, fileIndex, objectStoreIdentitySha256 }) {
  const existing = fileIndex ?? await objectFileIndex(db, objectIndex), parts = new Map(), missing = [];
  const store = await objectStoreBinding(db, objectStoreIdentitySha256);
  let existingObjects = 0;
  for (const row of objectIndex) {
    const saved = existing.get(row.key);
    if (!saved) { missing.push(row); continue; }
    const checked = archiveFileReference(saved, row, store), ref = checked.reference;
    if (checked.external) { existingObjects++; continue; }
    let covered = 0;
    for (const part of ref.chunks) {
      if (!hashPattern.test(part?.sha256 || '') || !Number.isSafeInteger(part.size) || part.size < 1
        || part.size > 4 * 1024 * 1024 || parts.has(part.sha256) && parts.get(part.sha256) !== part.size) {
        throw Error('Native archive chunk metadata differs');
      }
      parts.set(part.sha256, part.size); covered += part.size;
    }
    if (covered !== row.bytes) throw Error('Native archive metadata byte coverage differs');
    existingObjects++;
  }
  const chunks = [...parts];
  for (let start = 0; start < chunks.length; start += 500) {
    const batch = chunks.slice(start, start + 500);
    const found = await db.collection('driverAuditNativeChunks').find({ _id: { $in: batch.map(([id]) => id) } },
      { projection: { _id: 1, size: 1 } }).toArray(), sizes = new Map(found.map(row => [row._id, row.size]));
    if (found.length !== batch.length || sizes.size !== batch.length || batch.some(([id, size]) => sizes.get(id) !== size)) {
      throw Error('A required native archive chunk is missing or its metadata differs');
    }
  }
  for (const row of missing) {
    const bytes = await readOriginal(row);
    if (!Buffer.isBuffer(bytes) || bytes.length !== row.bytes || sha(bytes) !== row.key.slice(0, 64)) {
      throw Error('Original archive input binding differs');
    }
    const saved = await archive.putVerifiedObject(row.key, bytes);
    if (saved?.verified !== true || saved.key !== row.key || saved.sha256 !== row.key.slice(0, 64) || saved.bytes !== row.bytes) {
      throw Error('The missing native archive input did not verify');
    }
  }
  return { existingObjects, importedObjects: missing.length, fullByteVerificationPending: true };
}

export async function verifyDriverAuditMongoArchiveObjects({ archive, objectIndex }) {
  let bytesRead = 0;
  for (const row of objectIndex) {
    const bytes = Buffer.concat(await archive.readObject(row.key, { maxBytes: row.bytes }));
    if (bytes.length !== row.bytes || sha(bytes) !== row.key.slice(0, 64)) throw Error('Native evidence integrity differs');
    bytesRead += bytes.length;
  }
  return { objects: objectIndex.length, bytesRead };
}

async function profileInput(file, expected) {
  const bytes = await readPrivateDriverAuditSource(file, 1024 * 1024);
  if (!hashPattern.test(expected || '') || sha(bytes) !== expected) throw Error('The native import profile hash differs');
  const profile = JSON.parse(bytes);
  if (profile.version !== 2 || typeof profile.targetDatabase !== 'string'
      || !profile.documents || !profile.receipts || !profile.historical || !profile.objects
      || !profile.bookkeepingBackup || !profile.reviewContexts || !profile.reviewDependencies
      || !Number.isSafeInteger(profile.capacityBytes) || profile.capacityBytes < 1) {
    throw Error('The native import profile is incomplete');
  }
  if (!['full', 'selected'].includes(profile.receiptInput || 'full')) throw Error('Unknown native receipt input');
  return { profile, root: path.dirname(file) };
}

async function main() {
  const [operation, file, expected, ...extra] = process.argv.slice(2);
  if (!['plan', 'stage', 'verify'].includes(operation) || !path.isAbsolute(file || '') || extra.length) {
    throw Error('Use plan, stage or verify with the absolute private profile and its SHA-256');
  }
  const { profile, root } = await profileInput(file, expected);
  if (!process.env.MONGODB_URI) throw Error('The app MongoDB connection is unavailable');
  const connection = mongoose.createConnection(process.env.MONGODB_URI, {
    autoCreate: false, autoIndex: false, maxPoolSize: 3, serverSelectionTimeoutMS: 10000,
  });
  try {
    await connection.asPromise();
    const db = connection.db, client = connection.getClient();
    if (db.databaseName !== profile.targetDatabase) throw Error('The native import targets another database');
    const { createDriverAuditNativeObjectStore } = await import('../services/driverAuditNativeObjectStore.js');
    const objectStore = await createDriverAuditNativeObjectStore({ env: process.env });
    const archive = createDriverAuditMongoArchive({ db, client, capacityBytes: profile.capacityBytes, objectStore });
    const state = createCloudState({ rpc: createDriverAuditMongoRpc({ db, client, objects: archive }) });
    const original = await Array.fromAsync(verifiedRows(root, profile.documents));
    const reference = profile.bookkeepingBackup;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]+\.private\.json$/.test(reference.file || '')) throw Error('Pinned bookkeeping backup required');
    const backupBytes = await readPrivateDriverAuditSource(path.join(root, reference.file), 1024 * 1024);
    if (!hashPattern.test(reference.sha256 || '') || sha(backupBytes) !== reference.sha256) throw Error('Bookkeeping backup proof differs');
    const backup = JSON.parse(backupBytes);
    const census = await collectDriverAuditReceiptRoots({ db, documents: original, syncRoot: profile.syncRoot });
    const preselected = profile.receiptInput === 'selected';
    const selection = createDriverAuditReceiptSelection({ backup,
      originalReceiptSha256: preselected ? backup.originalReceiptSha256 : profile.receipts.sha256,
      collectorRevisions: census.collectorRevisions, receiptBindings: census.receiptBindings });
    if (preselected && (backup.liveReceiptSha256 !== profile.receipts.sha256
        || !Number.isSafeInteger(backup.liveReceiptCount) || backup.liveReceiptCount < 1
        || backup.collectorRootsSha256 !== census.sha256)) throw Error('Selected receipt proof differs');
    if (operation !== 'plan' && census.sha256 !== profile.collectorRootsSha256) throw Error('Required collector roots changed');
    const selectedStats = { original: preselected ? backup.receiptCount : 0, inputRows: 0,
      live: 0, backupOnly: preselected ? backup.receiptCount - backup.liveReceiptCount : 0 };
    const foundCollector = new Set();
    async function* selectedReceipts() {
      for await (const row of verifiedRows(root, profile.receipts)) {
        selectedStats.inputRows++;
        if (!preselected) selectedStats.original++;
        if (!selection.include(row)) {
          if (preselected) throw Error('Selected live input contains backup-only bookkeeping');
          selectedStats.backupOnly++; continue;
        }
        selectedStats.live++;
        if (row.key === 'collector-state') foundCollector.add(row.revision);
        yield row;
      }
      if (selectedStats.inputRows !== (preselected ? backup.liveReceiptCount : backup.receiptCount)
          || census.collectorRevisions.some(revision => !foundCollector.has(revision))) {
        throw Error('Original receipt backup or required collector coverage differs');
      }
    }
    const assertCensus = async () => {
      const actual = await collectDriverAuditReceiptRoots({ db, documents: original, syncRoot: profile.syncRoot });
      if (actual.sha256 !== census.sha256) throw Error('Serving or retained collector roots changed during migration');
    };
    const objectIndex = [];
    const seen = new Set();
    for await (const row of verifiedRows(root, profile.objects)) {
      if (!/^[a-f0-9]{64}\.(?:gz|json)$/.test(row.key || '') || !Number.isSafeInteger(row.bytes)
          || row.bytes < 1 || row.bytes > 16 * 1024 * 1024 || seen.has(row.key)) {
        throw Error('The native archive inventory is invalid');
      }
      seen.add(row.key);
      objectIndex.push(row);
    }
    let missingBytes = 0;
    let missingObjects = 0;
    const fileIndex = await objectFileIndex(db, objectIndex);
    const store = await objectStoreBinding(db, objectStore?.identitySha256);
    for (const row of objectIndex) {
      const prior = fileIndex.get(row.key);
      if (prior) archiveFileReference(prior, row, store);
      if (!prior) { missingBytes += row.bytes; missingObjects++; }
    }
    const stored = await archive.status();
    const plan = { objects: objectIndex.length, missingObjects, missingBytes,
      availableAllowanceBytes: profile.capacityBytes - stored.usedBytes };
    if (operation === 'plan') {
      console.log(JSON.stringify({ status: 'planned', importSha256: expected, ...plan,
        collectorRootsSha256: census.sha256, collectorRevisions: census.collectorRevisions,
        technicalHistory: 'verified-backup-only' }));
      return;
    }
    await initializeDriverAuditMongoRpc({ db, client });
    const args = { db, client, objects: archive, importSha256: expected, collectorRevisions: census.collectorRevisions };
    if (operation === 'stage') {
      if (missingBytes > plan.availableAllowanceBytes) throw Error('The native archive exceeds the available allowance');
      const documents = await importDriverAuditMongoDocuments({ ...args,
        documents: verifiedRows(root, profile.documents), previousImportSha256: profile.previousImportSha256 });
      const receipts = await importDriverAuditMongoReceipts({ ...args, receipts: selectedReceipts() });
      const historical = await importDriverAuditMongoHistorical({ ...args, records: verifiedRows(root, profile.historical) });
      const archiveStage = await stageDriverAuditMongoArchiveObjects({ db, archive, objectIndex, fileIndex, objectStoreIdentitySha256: objectStore?.identitySha256,
        readOriginal: row => readPrivateDriverAuditSource(path.join(root, row.key), row.bytes) });
      const reviewContexts = await importDriverAuditReviewContexts({ db, archive, documents: original, importSha256: expected,
        contexts: verifiedRows(root, profile.reviewContexts), dependencies: verifiedRows(root, profile.reviewDependencies) });
      await assertCensus();
      console.log(JSON.stringify({ status: 'staged', importSha256: expected, documents, receipts, historical, selectedStats,
        reviewContexts, archiveStage, archive: await archive.status(), activationPending: true }));
      return;
    }
    await verifyDriverAuditSource({ runtimeRoot: profile.runtimeRoot, expectedSha256: profile.runtimeSha256 });
    const { createCloudPublication } = await import(pathToFileURL(
      path.join(profile.runtimeRoot, 'source/integration/cloud/publication.mjs')).href);
    const originalState = new Map(original.map(row => [row.key, { revision: row.revision, body: row.body_text }]));
    const source = createCloudRepository({ stateStore: { read: async key => originalState.get(key) },
      transport: archive, key: 'collector-state' });
    const target = createCloudRepository({ stateStore: state, transport: archive, key: 'collector-state' });
    const load = repository => createCloudPublication({ repository, transport: archive,
      collectorState: { compareAndSwap: async () => { throw Error('Migration verification is read only'); } } })
      .loadCurrent({ includeGps: true });
    for (const row of original) {
      const saved = await state.read(row.key);
      if (saved.revision !== row.revision || saved.body !== row.body_text) throw Error('Original saved state differs');
    }
    let receiptCount = 0, historicalCount = 0;
    const readText = createDriverAuditMongoTextReader(archive);
    for await (const row of selectedReceipts()) {
      const saved = await db.collection('driverAuditNativeReceipts').findOne({ key: row.key, revision: row.revision });
      if (!saved || saved.event_id !== row.event_id || saved.request_sha256 !== row.request_sha256
          || saved.body_sha256 !== row.body_sha256 || saved.created_at !== row.created_at
          || await readText(saved.body_ref) !== row.body_text
          || await readText(saved.event_ref) !== row.event_text) throw Error('Original receipt readback differs');
      receiptCount++;
    }
    for await (const row of verifiedRows(root, profile.historical)) {
      const id = sha(JSON.stringify([row.namespace, sha(row.body_text)]));
      const saved = await db.collection('driverAuditNativeHistorical').findOne({ _id: id });
      if (!saved || saved.namespace !== row.namespace || await readText(saved.body_ref) !== row.body_text) {
        throw Error('Original historical row readback differs');
      }
      historicalCount++;
    }
    if (await db.collection('driverAuditNativeDocuments').countDocuments() !== original.length
        || await db.collection('driverAuditNativeReceipts').countDocuments() !== receiptCount
        || await db.collection('driverAuditNativeHistorical').countDocuments() !== historicalCount) {
      throw Error('Native original-record coverage differs');
    }
    const archiveVerification = await verifyDriverAuditMongoArchiveObjects({ archive, objectIndex });
    const reviewContexts = await importDriverAuditReviewContexts({ db, archive, documents: original, verifyOnly: true, importSha256: expected,
      contexts: verifiedRows(root, profile.reviewContexts), dependencies: verifiedRows(root, profile.reviewDependencies) });
    const [before, after] = await Promise.all([load(source), load(target)]);
    const queries = ['reporting_validated_deliveries', 'reporting_saved_gps_assessment_history'];
    const resultsEqual = queries.every(key => sha(JSON.stringify(before.app.queries[key]))
      === sha(JSON.stringify(after.app.queries[key])));
    const identitiesEqual = before.head.manifest.sha256 === after.head.manifest.sha256
      && before.head.reportHash === after.head.reportHash && before.historyCount === after.historyCount;
    const historyId = 'reporting_validated_history';
    const historyEqual = sha(JSON.stringify(before.app._dataAppQueryLoading.queries[historyId]))
      === sha(JSON.stringify(after.app._dataAppQueryLoading.queries[historyId]));
    if (!resultsEqual || !identitiesEqual || !historyEqual) throw Error('Original report readback differs');
    await assertCensus();
    // This inventory proves only its declared objects. It cannot certify that
    // every historical photo, GPS window and review-snapshot dependency was
    // included. Never mint an activation parity receipt from this partial check.
    console.log(JSON.stringify({ status: 'staged-data-verified', importSha256: expected,
      documents: original.length, receipts: receiptCount, historical: historicalCount,
      selectedStats, collectorRootsSha256: census.sha256,
      archiveObjects: archiveVerification.objects, archiveBytesRead: archiveVerification.bytesRead,
      reviewContexts, resultsEqual, reportIdentityEqual: identitiesEqual,
      assessmentHistoryEqual: historyEqual, activationPending: true, archiveClosurePending: true }));
  } finally { await connection.close(); }
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Native Driver Reports migration stopped. Check the pinned inputs, target capacity and original evidence.');
    process.exitCode = 1;
  });
}
