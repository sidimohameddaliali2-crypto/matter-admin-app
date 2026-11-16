import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readManifestBytes } from '../vendor/driver-audits/integration/cloud/repository.mjs';

const hex = value => /^[a-f0-9]{64}$/.test(value || '');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const id = (domain, file) => sha(JSON.stringify([domain, file]));
const missing = () => Object.assign(Error('Original review context unavailable'), { code: 'ENOENT' });

function reviewHashes(documents) {
  const hashes = new Set();
  for (const row of documents) {
    if (row.key !== 'review-journal' && !row.key.endsWith(':review-journal')) continue;
    const state = JSON.parse(row.body_text);
    if (!Array.isArray(state?.records?.reportingReviews)) throw Error('Original review history differs');
    for (const event of state.records.reportingReviews) {
      if (!hex(event?.data?.snapshotHash)) throw Error('Original review context hash differs');
      hashes.add(event.data.snapshotHash);
    }
  }
  return hashes;
}

function allowedDependency(manifest, snapshotHash) {
  if (['objects', 'legacyObjects'].includes(manifest?.domain)) return hex(manifest.path);
  if (!['state', 'archive'].includes(manifest?.domain)) return false;
  return manifest.path === 'photo-generations/' + snapshotHash + '.json'
    || /^photo-inventories\/(?:queues\/)?[a-f0-9]{64}\.json$/.test(manifest.path || '')
    || /^photos\/[a-f0-9]{64}\.gz$/.test(manifest.path || '');
}

// This small index points at original evidence named by human reviews, so a
// newer publication cannot strand an older saved response or its photo context.
export async function importDriverAuditReviewContexts({ db, archive, documents, contexts, dependencies = [], verifyOnly = false, importSha256 }) {
  if (!hex(importSha256)) throw Error('Pinned original review context import required');
  const expected = reviewHashes(documents), entries = new Map(), files = new Map();
  const collection = db.collection('driverAuditNativeReviewContexts');
  const fileIndex = db.collection('driverAuditNativeReviewFiles');
  const addFile = manifest => {
    const key = id(manifest.domain, manifest.path), prior = files.get(key);
    if (prior && (prior.sha256 !== manifest.sha256 || prior.size !== manifest.size)) {
      throw Error('Original review dependency differs between contexts');
    }
    files.set(key, manifest);
  };
  for await (const row of contexts) {
    if (!hex(row?.snapshotHash) || !expected.has(row.snapshotHash) || entries.has(row.snapshotHash)
        || !['available', 'source-missing'].includes(row.availability)
        || !Array.isArray(row.provenance) || !row.provenance.length) throw Error('Original review context coverage differs');
    if (row.availability === 'available') {
      if (!['state', 'archive'].includes(row.manifest?.domain) || row.manifest.path !== 'review-snapshots/' + row.snapshotHash + '.json.gz') {
        throw Error('Original review context manifest differs');
      }
      const bytes = await readManifestBytes(archive, row.manifest, { maxBytes: 128 * 1024 * 1024 });
      const snapshot = JSON.parse(gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 }));
      if (snapshot.snapshotHash !== row.snapshotHash || !Array.isArray(snapshot.rows)) throw Error('Original review context identity differs');
      addFile(row.manifest);
    } else if (row.manifest !== undefined) throw Error('Missing original review context has a manifest');
    entries.set(row.snapshotHash, row);
  }
  if (entries.size !== expected.size) throw Error('Original review context coverage differs');
  const related = new Map();
  for await (const row of dependencies) {
    if (!entries.has(row?.snapshotHash) || related.has(row.snapshotHash) || !Array.isArray(row.files)) {
      throw Error('Original review dependency coverage differs');
    }
    for (const manifest of row.files) {
      if (!allowedDependency(manifest, row.snapshotHash)) throw Error('Original review dependency path differs');
      await readManifestBytes(archive, manifest, { maxBytes: 128 * 1024 * 1024 });
      addFile(manifest);
    }
    related.set(row.snapshotHash, row);
  }
  if (related.size !== expected.size) throw Error('Original review dependency coverage differs');
  // Check the complete plan before committing immutable index entries.
  const prepared = [];
  for (const row of entries.values()) {
    const bytes = Buffer.from(JSON.stringify({ context: row, dependencies: related.get(row.snapshotHash) || null }));
    if (bytes.length > 2 * 1024 * 1024) throw Error('Original review context index exceeds limit');
    const prior = await collection.findOne({ _id: row.snapshotHash });
    if (prior && prior.sha256 !== sha(bytes)) throw Error('Stored original review context differs');
    if (verifyOnly && (!prior || !(await archive.readBytes(prior.reference, { maxBytes: bytes.length })).equals(bytes))) {
      throw Error('Stored original review context differs');
    }
    prepared.push({ row, bytes });
  }
  for (const [key, manifest] of files) {
    const prior = await fileIndex.findOne({ _id: key });
    if ((verifyOnly && !prior) || prior && JSON.stringify(prior.manifest) !== JSON.stringify(manifest)) throw Error('Stored original review dependency differs');
  }
  if (!verifyOnly) {
    const session = db.client.startSession();
    try {
      await session.withTransaction(async () => {
        const control = db.collection('driverAuditNativeControl');
        const authority = await control.findOne({ _id: 'authority' }, { session });
        if (authority?.status !== 'staging' || authority.importSha256 !== importSha256) {
          throw Error('Original review context import authority changed');
        }
        await control.updateOne({ _id: 'authority' }, { $inc: { writeFence: 1 } }, { session });
        for (const { row, bytes } of prepared) {
          const prior = await collection.findOne({ _id: row.snapshotHash }, { session });
          if (prior && prior.sha256 !== sha(bytes)) throw Error('Stored original review context differs');
          const reference = await archive.putBytes(bytes, { session });
          await collection.updateOne({ _id: row.snapshotHash }, { $setOnInsert: {
            availability: row.availability, sha256: sha(bytes), reference,
          } }, { upsert: true, session });
        }
        const existing = await fileIndex.find({ _id: { $in: [...files.keys()] } }, { session }).toArray();
        for (const prior of existing) {
          if (JSON.stringify(prior.manifest) !== JSON.stringify(files.get(prior._id))) throw Error('Stored original review dependency differs');
        }
        if (files.size) await fileIndex.bulkWrite([...files].map(([key, manifest]) => ({ updateOne: {
          filter: { _id: key }, update: { $setOnInsert: { manifest } }, upsert: true,
        } })), { session });
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority', j: true, wtimeoutMS: 10000 }, readPreference: 'primary' });
    } finally { await session.endSession(); }
  }
  return { contexts: entries.size, available: [...entries.values()].filter(row => row.availability === 'available').length,
    sourceMissing: [...entries.values()].filter(row => row.availability === 'source-missing').length, files: files.size };
}

export function createDriverAuditReviewContexts({ db, archive }) {
  const collection = db.collection('driverAuditNativeReviewFiles');
  async function resolveFile(domain, file) {
    let row = await collection.findOne({ _id: id(domain, file) });
    if (!row && ['state', 'archive'].includes(domain) && /^review-snapshots\/[a-f0-9]{64}\.json\.gz$/.test(file)) {
      row = await collection.findOne({ _id: id(domain === 'state' ? 'archive' : 'state', file) });
    }
    if (!row) throw missing();
    return row.manifest;
  }
  async function readFile(domain, file, { maxBytes }) {
    return readManifestBytes(archive, await resolveFile(domain, file), { maxBytes });
  }
  const attach = repository => ({ ...repository,
    async resolveFile(domain, file) {
      try { return await repository.resolveFile(domain, file); }
      catch (error) { if (error.code !== 'ENOENT') throw error; return resolveFile(domain, file); }
    },
    async readFile(domain, file, options) {
      try { return await repository.readFile(domain, file, options); }
      catch (error) { if (error.code !== 'ENOENT') throw error; return readFile(domain, file, options); }
    },
  });
  return { readFile, resolveFile, attach };
}
