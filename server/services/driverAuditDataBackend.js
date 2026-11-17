import mongoose from 'mongoose';
import { createHostedRpc } from '../vendor/driver-audits/integration/cloud/rpc.mjs';
import { createSupabaseArchiveTransport } from '../vendor/driver-audits/integration/hosted/supabase-archive.mjs';
import { createDriverAuditMongoArchive } from './driverAuditMongoArchive.js';
import { createDriverAuditMongoRpc, initializeDriverAuditMongoRpc } from './driverAuditMongoRpc.js';
import { createDriverAuditReviewContexts } from './driverAuditReviewContexts.js';

export const driverAuditNativeBackendSymbol = Symbol.for('matter.driver-audit.native-backend');

// Same-database reads have no Supabase transfer. Keep the bounded readers but
// avoid creating financial ledger writes for these local reads.
export const driverAuditLocalReaderBudget = Object.freeze({
  reserve: async () => ({ allowed: true }),
  settle: async () => ({ settled: true }),
});

export async function createDriverAuditDataBackend({ db, env = process.env, staging = false }) {
  const kind = env.DRIVER_AUDIT_DATA_STORE || 'supabase';
  if (kind === 'supabase') {
    const secret = env.DRIVER_AUDIT_SUPABASE_SECRET || env.MATTER_SUPABASE_SECRET;
    return { kind, rpc: createHostedRpc({ secret }), archive: createSupabaseArchiveTransport({ secret }) };
  }
  if (kind !== 'mongo') throw Error('Unknown Driver Reports data store');
  if (!db?.client) throw Error('The app MongoDB connection is required');
  if (!staging) {
    const authority = await db.collection('driverAuditNativeControl').findOne({ _id: 'authority' });
    if (authority?.status !== 'active' || authority.verified !== true
        || !/^[a-f0-9]{64}$/.test(authority.importSha256 || '')
        || !/^[a-f0-9]{64}$/.test(authority.paritySha256 || '')
        || authority.oldWritersFenced !== true || authority.oldReviewsFenced !== true) {
      throw Error('The verified native reporting import and writer handoff are required');
    }
  }
  const archive = createDriverAuditMongoArchive({
    db, client: db.client, capacityBytes: Number(env.DRIVER_AUDIT_NATIVE_CAPACITY_BYTES),
  });
  await initializeDriverAuditMongoRpc({ db, client: db.client });
  const { createDriverAuditFixedHostBudgetFactory } = await import('./driverAuditFixedHostBudget.js');
  const { createDriverAuditReadCache } = await import('./driverAuditReadCache.js');
  const archiveCacheDirectory = env.MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY || null;
  if (!staging && !archiveCacheDirectory) throw Error('The qualified shared native archive cache directory is required');
  const cachedArchive = createDriverAuditReadCache({ archive,
    cacheDirectory: archiveCacheDirectory, cacheEnabled: Boolean(archiveCacheDirectory) });
  return { kind, archive: cachedArchive, archiveCacheDirectory, rpc: createDriverAuditMongoRpc({ db, client: db.client, objects: archive }),
    reviewContexts: createDriverAuditReviewContexts({ db, archive: cachedArchive }),
    createExecutionBudget: createDriverAuditFixedHostBudgetFactory() };
}

// CLI workers use the same MongoDB setting as the app. It stays out of the
// recovered source environment and private runtime bundle.
export async function openDriverAuditDataBackend({ env = process.env, staging = false } = {}) {
  if ((env.DRIVER_AUDIT_DATA_STORE || 'supabase') === 'supabase') {
    return { ...await createDriverAuditDataBackend({ env }), close: async () => {} };
  }
  if (!env.MONGODB_URI) throw Error('The app MongoDB connection is unavailable');
  const connection = mongoose.createConnection(env.MONGODB_URI, {
    autoCreate: false, autoIndex: false, maxPoolSize: 3, serverSelectionTimeoutMS: 10000,
  });
  try {
    await connection.asPromise();
    return { ...await createDriverAuditDataBackend({ db: connection.db, env, staging }), db: connection.db, close: () => connection.close() };
  } catch (error) {
    await connection.close();
    throw error;
  }
}

export async function readDriverAuditDataCapacity(db) {
  const [hello, stats, reporting] = await Promise.all([
    db.command({ hello: 1 }),
    db.command({ dbStats: 1, scale: 1 }),
    db.collection('driverAuditNativeControl').findOne({ _id: 'capacity' }),
  ]);
  return {
    supportsTransactions: Boolean(hello.setName || hello.msg === 'isdbgrid'),
    databaseBytes: stats.dataSize,
    allocatedDatabaseBytes: stats.storageSize,
    indexBytes: stats.indexSize,
    ...(Number.isSafeInteger(stats.fsAvailableSize) ? { availableFilesystemBytes: stats.fsAvailableSize } : {}),
    nativeReporting: reporting ? { usedBytes: reporting.usedBytes, limitBytes: reporting.limitBytes } : null,
  };
}
