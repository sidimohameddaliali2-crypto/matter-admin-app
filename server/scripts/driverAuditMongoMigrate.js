import '../loadEnv.js';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import { createDriverAuditMongoArchive } from '../services/driverAuditMongoArchive.js';
import { createDriverAuditMongoTextReader } from '../services/driverAuditMongoText.js';
import { createDriverAuditMongoRpc, initializeDriverAuditMongoRpc } from '../services/driverAuditMongoRpc.js';
import { importDriverAuditMongoDocuments, importDriverAuditMongoHistorical,
  importDriverAuditMongoReceipts } from '../services/driverAuditMongoImport.js';
import { createCloudRepository } from '../vendor/driver-audits/integration/cloud/repository.mjs';
import { createCloudState } from '../vendor/driver-audits/integration/cloud/cloud-state.mjs';
import { readPrivateDriverAuditSource, verifyDriverAuditSource } from '../services/driverAuditSource.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;

async function* verifiedRows(root, reference) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]+\.jsonl$/.test(reference?.file || '')
      || !hashPattern.test(reference.sha256 || '')) throw Error('A pinned private import file is required');
  const filename = path.join(root, reference.file);
  const info = await fs.lstat(filename);
  if (!info.isFile() || info.uid !== process.getuid() || info.mode & 0o077
      || await fs.realpath(filename) !== filename) throw Error('The import input must be owner-private');
  const digest = createHash('sha256');
  for await (const part of createReadStream(filename)) digest.update(part);
  if (digest.digest('hex') !== reference.sha256) throw Error('The original import file hash differs');
  const lines = readline.createInterface({ input: createReadStream(filename), crlfDelay: Infinity });
  for await (const line of lines) {
    if (Buffer.byteLength(line) > 66 * 1024 * 1024) throw Error('The original import record exceeds its limit');
    if (line) yield JSON.parse(line);
  }
}

async function profileInput(file, expected) {
  const bytes = await readPrivateDriverAuditSource(file, 1024 * 1024);
  if (!hashPattern.test(expected || '') || sha(bytes) !== expected) throw Error('The native import profile hash differs');
  const profile = JSON.parse(bytes);
  if (profile.version !== 1 || typeof profile.targetDatabase !== 'string'
      || !profile.documents || !profile.receipts || !profile.historical || !profile.objects
      || !Number.isSafeInteger(profile.capacityBytes) || profile.capacityBytes < 1) {
    throw Error('The native import profile is incomplete');
  }
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
    const archive = createDriverAuditMongoArchive({ db, client, capacityBytes: profile.capacityBytes });
    const state = createCloudState({ rpc: createDriverAuditMongoRpc({ db, client, objects: archive }) });
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
    for (const row of objectIndex) {
      const prior = await db.collection('driverAuditNativeFiles').findOne({ _id: row.key });
      if (prior && prior.reference.size !== row.bytes) throw Error('A stored native object size differs');
      if (!prior) { missingBytes += row.bytes; missingObjects++; }
    }
    const stored = await archive.status();
    const plan = { objects: objectIndex.length, missingObjects, missingBytes,
      availableAllowanceBytes: profile.capacityBytes - stored.usedBytes };
    if (operation === 'plan') {
      console.log(JSON.stringify({ status: 'planned', importSha256: expected, ...plan }));
      return;
    }
    await initializeDriverAuditMongoRpc({ db, client });
    const args = { db, client, objects: archive, importSha256: expected };
    if (operation === 'stage') {
      if (missingBytes > plan.availableAllowanceBytes) throw Error('The native archive exceeds the available allowance');
      const documents = await importDriverAuditMongoDocuments({ ...args,
        documents: verifiedRows(root, profile.documents), previousImportSha256: profile.previousImportSha256 });
      const receipts = await importDriverAuditMongoReceipts({ ...args, receipts: verifiedRows(root, profile.receipts) });
      const historical = await importDriverAuditMongoHistorical({ ...args, records: verifiedRows(root, profile.historical) });
      for (const row of objectIndex) {
        const target = path.join(root, row.key);
        try {
          const existing = await archive.readObject(row.key, { maxBytes: row.bytes });
          if (Buffer.concat(existing).length !== row.bytes) throw Error('Native object readback size differs');
        } catch (error) {
          if (error.code !== 'storage_not_found') throw error;
          const bytes = await readPrivateDriverAuditSource(target, row.bytes);
          if (bytes.length !== row.bytes) throw Error('Original archive input size differs');
          await archive.putVerifiedObject(row.key, bytes);
        }
      }
      console.log(JSON.stringify({ status: 'staged', importSha256: expected, documents, receipts, historical,
        archive: await archive.status(), activationPending: true }));
      return;
    }
    const original = await Array.fromAsync(verifiedRows(root, profile.documents));
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
    for await (const row of verifiedRows(root, profile.receipts)) {
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
    for (const row of objectIndex) {
      const bytes = Buffer.concat(await archive.readObject(row.key, { maxBytes: row.bytes }));
      if (bytes.length !== row.bytes) throw Error('Native evidence size differs');
    }
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
    // This inventory proves only its declared objects. It cannot certify that
    // every historical photo, GPS window and review-snapshot dependency was
    // included. Never mint an activation parity receipt from this partial check.
    console.log(JSON.stringify({ status: 'staged-data-verified', importSha256: expected,
      documents: original.length, receipts: receiptCount, historical: historicalCount,
      archiveObjects: objectIndex.length, resultsEqual, reportIdentityEqual: identitiesEqual,
      assessmentHistoryEqual: historyEqual, activationPending: true, archiveClosurePending: true }));
  } finally { await connection.close(); }
}

main().catch(() => {
  console.error('Native Driver Reports migration stopped. Check the pinned inputs, target capacity and original evidence.');
  process.exitCode = 1;
});
