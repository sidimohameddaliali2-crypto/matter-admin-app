import { createHash } from 'node:crypto';

const chunkBytes = 4 * 1024 * 1024;
const maximumBytes = 64 * 1024 * 1024;
const hashPattern = /^[a-f0-9]{64}$/;
const keyPattern = /^[a-f0-9]{64}\.(?:gz|json)$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const binary = row => Buffer.isBuffer(row?.bytes) ? row.bytes : row?.bytes?.value?.(true);
const transactionOptions = {
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority', j: true, wtimeoutMS: 10000 },
  readPreference: 'primary',
};

// This archive owns its evidence independently of the disposable serving replica.
// Every reference names immutable bytes. A caller transaction can atomically
// commit a new state pointer and its new chunks together.
export function createDriverAuditMongoArchive({ db, client, capacityBytes, objectStore }) {
  if (!db?.collection || !client?.startSession || !Number.isSafeInteger(capacityBytes)
      || capacityBytes < 1 || capacityBytes > 60_000_000_000) {
    throw Error('An explicit native reporting storage allowance is required');
  }
  if (objectStore && (!hashPattern.test(objectStore.identitySha256)
      || typeof objectStore.putVerifiedObject !== 'function' || typeof objectStore.readBytes !== 'function'
      || typeof objectStore.assertPrivate !== 'function')) throw Error('Native external archive configuration is invalid');
  const chunks = db.collection('driverAuditNativeChunks');
  const files = db.collection('driverAuditNativeFiles');
  const control = db.collection('driverAuditNativeControl');

  async function transaction(operation, session) {
    if (session) {
      if (!session.inTransaction()) throw Error('Native archive transaction is inactive');
      return operation(session);
    }
    const owned = client.startSession();
    try {
      let result;
      await owned.withTransaction(async () => { result = await operation(owned); }, transactionOptions);
      return result;
    } finally { await owned.endSession(); }
  }

  async function allowance(session) {
    const current = await control.findOne({ _id: 'capacity' }, { session });
    if (current) {
      const technicalBytes = current.technicalBytes === undefined ? 0 : current.technicalBytes;
      if (current.limitBytes !== capacityBytes || !Number.isSafeInteger(current.usedBytes)
          || current.usedBytes < 0 || current.usedBytes > capacityBytes
          || !Number.isSafeInteger(technicalBytes) || technicalBytes < 0 || technicalBytes > current.usedBytes) {
        throw Error('Native reporting storage allowance differs');
      }
      return;
    }
    await control.insertOne({ _id: 'capacity', limitBytes: capacityBytes, usedBytes: 0 }, { session });
  }

  async function storeBytes(bytes, session) {
    await allowance(session);
    const references = [];
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
      const part = bytes.subarray(offset, offset + chunkBytes);
      const sha256 = digest(part);
      references.push({ sha256, size: part.length });
      const prior = await chunks.findOne({ _id: sha256 }, { session });
      if (prior) {
        const saved = binary(prior);
        if (!saved || saved.length !== part.length || digest(saved) !== sha256) {
          throw Error('Native archive chunk integrity failure');
        }
        continue;
      }
      const chargedBytes = part.length + 1024;
      const allocation = await control.updateOne({
        _id: 'capacity', limitBytes: capacityBytes, usedBytes: { $lte: capacityBytes - chargedBytes },
      }, { $inc: { usedBytes: chargedBytes } }, { session });
      if (!allocation.matchedCount) {
        throw Object.assign(Error('Native reporting storage allowance exhausted'), { code: 'AUDIT_CAPACITY' });
      }
      await chunks.insertOne({ _id: sha256, size: part.length, bytes: Buffer.from(part) }, { session });
    }
    return { version: 1, sha256: digest(bytes), size: bytes.length, chunks: references };
  }

  function validateReference(reference, maxBytes) {
    if (reference?.version !== 1 || !hashPattern.test(reference.sha256)
        || !Number.isSafeInteger(reference.size) || reference.size < 0
        || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || reference.size > maxBytes
        || maxBytes > maximumBytes || !Array.isArray(reference.chunks)
        || reference.chunks.length > maximumBytes / chunkBytes) {
      throw Error('Native archive reference exceeds its size limit');
    }
    let size = 0;
    for (const part of reference.chunks) {
      if (!hashPattern.test(part?.sha256) || !Number.isSafeInteger(part.size)
          || part.size < 1 || part.size > chunkBytes) throw Error('Native archive reference is invalid');
      size += part.size;
    }
    if (size !== reference.size) throw Error('Native archive reference integrity failure');
  }

  async function readBytes(reference, { maxBytes = maximumBytes, session } = {}) {
    validateReference(reference, maxBytes);
    const result = [];
    for (const part of reference.chunks) {
      const row = await chunks.findOne({ _id: part.sha256 }, { session });
      const saved = binary(row);
      if (!saved || saved.length !== part.size || row.size !== part.size || digest(saved) !== part.sha256) {
        throw Error('Native archive chunk integrity failure');
      }
      result.push(saved);
    }
    const bytes = Buffer.concat(result, reference.size);
    if (digest(bytes) !== reference.sha256) throw Error('Native archive file integrity failure');
    return bytes;
  }

  async function putBytes(bytes, { session } = {}) {
    if (!Buffer.isBuffer(bytes) || bytes.length > maximumBytes) throw Error('Native archive payload exceeds its limit');
    return transaction(current => storeBytes(bytes, current), session);
  }

  async function externalReference(reference, options = {}) {
    if (!objectStore) throw Error('Native external archive object store is required');
    const { validateDriverAuditSpacesArchiveReference } = await import('./driverAuditSpacesArchive.js');
    return validateDriverAuditSpacesArchiveReference(reference, { identitySha256: objectStore.identitySha256, ...options });
  }

  async function objectStoreIdentity(session, create = false) {
    if (!objectStore) throw Error('Native external archive object store is required');
    const saved = await control.findOne({ _id: 'archive-object-store' }, { session });
    if (!saved && create) {
      await control.insertOne({ _id: 'archive-object-store', version: 1, provider: 'spaces',
        identitySha256: objectStore.identitySha256 }, { session });
      return;
    }
    if (!saved || Object.keys(saved).length !== 4 || saved.version !== 1 || saved.provider !== 'spaces'
        || saved.identitySha256 !== objectStore.identitySha256) throw Error('Native archive object store identity differs');
  }

  async function readFile(saved, key, { maxBytes, signal, session } = {}) {
    if (Object.hasOwn(saved, 'externalReference')) {
      if (Object.hasOwn(saved, 'reference')) throw Error('Native archive object reference is ambiguous');
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > maximumBytes) {
        throw Error('Native archive reference exceeds its size limit');
      }
      const checked = await externalReference(saved.externalReference, { key });
      if (checked.size > maxBytes) throw Error('Native archive reference exceeds its size limit');
      await objectStoreIdentity(session);
      // This path is only called outside canonical state transactions. Protected
      // state/history still use the unchanged Mongo chunk readBytes protocol.
      if (session) throw Error('External archive reads cannot enter a Mongo transaction');
      const bytes = await objectStore.readBytes(checked, { maxBytes: Math.min(maxBytes, 16 * 1024 * 1024), signal });
      if (!Buffer.isBuffer(bytes) || bytes.length !== checked.size || digest(bytes) !== checked.sha256) {
        throw Error('Native external archive object integrity failure');
      }
      return bytes;
    }
    return readBytes(saved.reference, { maxBytes, session });
  }

  async function readObject(key, { maxBytes = 16 * 1024 * 1024, signal } = {}) {
    if (!keyPattern.test(key)) throw Error('Invalid native archive object key');
    signal?.throwIfAborted();
    const saved = await files.findOne({ _id: key });
    if (!saved) throw Object.assign(Error('Native archive object unavailable'), { code: 'storage_not_found' });
    const bytes = await readFile(saved, key, { maxBytes, signal });
    if (digest(bytes) !== key.slice(0, 64)) throw Error('Native archive object integrity failure');
    signal?.throwIfAborted();
    return [bytes];
  }

  async function putVerifiedObject(key, bytes, { signal } = {}) {
    if (!keyPattern.test(key) || !Buffer.isBuffer(bytes) || !bytes.length
        || bytes.length > 16 * 1024 * 1024 || digest(bytes) !== key.slice(0, 64)) {
      throw Error('Native archive object binding is invalid');
    }
    signal?.throwIfAborted();
    if (objectStore) {
      const body = Buffer.from(bytes), existing = await files.findOne({ _id: key });
      if (existing) {
        const saved = await readFile(existing, key, { maxBytes: body.length, signal });
        if (!saved.equals(body)) throw Error('Native archive object integrity failure');
        signal?.throwIfAborted();
        return { key, sha256: digest(body), bytes: body.length, verified: true };
      }
      // Pin the owned destination before any external I/O. Upload/readback is
      // deliberately outside the metadata transaction and cannot publish state.
      await transaction(async session => {
        await objectStoreIdentity(session, true);
        await allowance(session);
      });
      signal?.throwIfAborted();
      const returned = await objectStore.putVerifiedObject(key, body, { signal });
      if (!Object.isFrozen(returned)) throw Error('Native external archive reference must be frozen');
      const reference = await externalReference(returned, { key, bytes: body.length });
      signal?.throwIfAborted();
      await transaction(async session => {
        signal?.throwIfAborted();
        await objectStoreIdentity(session);
        await allowance(session);
        const prior = await files.findOne({ _id: key }, { session });
        if (prior) {
          if (Object.hasOwn(prior, 'externalReference')) {
            if (Object.hasOwn(prior, 'reference')) throw Error('Native archive object reference is ambiguous');
            const checked = await externalReference(prior.externalReference, { key, bytes: body.length });
            if (JSON.stringify(checked) !== JSON.stringify(reference)) throw Error('Native external archive reference differs');
          } else {
            const saved = await readBytes(prior.reference, { maxBytes: body.length, session });
            if (!saved.equals(body)) throw Error('Native archive object integrity failure');
          }
          return;
        }
        const chargedBytes = body.length + 1024;
        const allocation = await control.updateOne({ _id: 'capacity', limitBytes: capacityBytes,
          usedBytes: { $lte: capacityBytes - chargedBytes },
        }, { $inc: { usedBytes: chargedBytes } }, { session });
        if (!allocation.matchedCount) {
          throw Object.assign(Error('Native reporting storage allowance exhausted'), { code: 'AUDIT_CAPACITY' });
        }
        await files.insertOne({ _id: key, externalReference: reference }, { session });
        signal?.throwIfAborted();
      });
      return { key, sha256: digest(body), bytes: body.length, verified: true };
    }
    await transaction(async session => {
      const existing = await files.findOne({ _id: key }, { session });
      if (existing) {
        const saved = await readBytes(existing.reference, { maxBytes: bytes.length, session });
        if (!saved.equals(bytes)) throw Error('Native archive object integrity failure');
        return;
      }
      const reference = await storeBytes(bytes, session);
      await files.insertOne({ _id: key, reference }, { session });
    });
    const verified = Buffer.concat(await readObject(key, { maxBytes: bytes.length }));
    if (!verified.equals(bytes)) throw Error('Native archive readback integrity failure');
    return { key, sha256: digest(bytes), bytes: bytes.length, verified: true };
  }

  return {
    putBytes, readBytes, readObject, putVerifiedObject,
    ...(typeof objectStore?.offerSourcePhotoCandidate === 'function' ? {
      offerExistingPhotoCandidate: args => objectStore.offerSourcePhotoCandidate(args),
    } : {}),
    async reserveTechnicalBytes(bytes, { session }) {
      if (!session?.inTransaction() || !Number.isSafeInteger(bytes) || bytes < 1) throw Error('Invalid native recovery allocation');
      await allowance(session);
      const changed = await control.updateOne({ _id: 'capacity', limitBytes: capacityBytes,
        usedBytes: { $lte: capacityBytes - bytes },
        $expr: { $lte: [{ $ifNull: ['$technicalBytes', 0] }, 64 * 1024 * 1024 - bytes] },
      }, { $inc: { usedBytes: bytes, technicalBytes: bytes } }, { session });
      if (!changed.matchedCount) throw Object.assign(Error('Native recovery allowance exhausted'), { code: 'AUDIT_RECOVERY_CAPACITY' });
    },
    async releaseTechnicalBytes(bytes, { session }) {
      if (!session?.inTransaction() || !Number.isSafeInteger(bytes) || bytes < 1) throw Error('Invalid native recovery release');
      await allowance(session);
      const changed = await control.updateOne({ _id: 'capacity', limitBytes: capacityBytes,
        usedBytes: { $gte: bytes }, technicalBytes: { $gte: bytes },
      }, { $inc: { usedBytes: -bytes, technicalBytes: -bytes } }, { session });
      if (!changed.matchedCount) throw Error('Native recovery allocation differs');
    },
    async assertPrivate(options) {
      if (!objectStore) return { bucket: 'matter-report-archive', public: false };
      const proof = await objectStore.assertPrivate(options);
      if (proof?.public !== false || proof.identitySha256 !== objectStore.identitySha256) {
        throw Error('Native external archive privacy proof differs');
      }
      return proof;
    },
    async status() {
      const saved = await control.findOne({ _id: 'capacity' });
      return { limitBytes: capacityBytes, usedBytes: saved?.usedBytes ?? 0 };
    },
  };
}
