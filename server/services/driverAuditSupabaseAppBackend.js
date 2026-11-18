import fs from 'node:fs/promises';
import path from 'node:path';
import { createHostedRpc } from '../vendor/driver-audits/integration/cloud/rpc.mjs';
import { createSupabaseArchiveTransport } from '../vendor/driver-audits/integration/hosted/supabase-archive.mjs';
import { createDriverAuditFixedHostBudgetFactory } from './driverAuditFixedHostBudget.js';
import { createDriverAuditPollProgress } from './driverAuditPollProgress.js';
import { createDriverAuditReadCache } from './driverAuditReadCache.js';
import { createDriverAuditCollectorReadCache } from './driverAuditCollectorReadCache.js';
import { createDriverAuditSpacesArchive } from './driverAuditSpacesArchive.js';
import { createDriverAuditSupabaseArchive } from './driverAuditSupabaseArchive.js';
import { createDriverAuditSupabaseTransfer } from './driverAuditSupabaseTransfer.js';
import { readDriverAuditFileSyncStatus } from './driverAuditSyncStatus.js';
import { createDriverAuditPhotoRecovery } from './driverAuditPhotoRecovery.js';

const check = (condition, message) => { if (!condition) throw Error(message); };

// The HTTP meter owns durable byte/concurrency admission below the cache.
// These outer reader adapters must not create Vercel financial receipts or
// charge a verified disk-cache hit as another remote transfer.
const meteredReader = Object.freeze({
  async reserve() { return { allowed: true, accountingBasis: 'supabase-http-bytes-v1' }; },
  async settle() { return { settled: true, accountingBasis: 'supabase-http-bytes-v1' }; },
});

export async function createDriverAuditSupabaseAppBackend({ env = process.env, fetchImpl = fetch,
  photoStore, cacheFreeBytes } = {}) {
  check(env.DRIVER_AUDIT_EXECUTION_HOST === 'sidi'
    && (env.DRIVER_AUDIT_DATA_STORE || 'supabase') === 'supabase', 'Explicit Sidi Supabase execution is required');
  const secret = env.DRIVER_AUDIT_SUPABASE_SECRET || env.MATTER_SUPABASE_SECRET;
  const cacheDirectory = env.MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY;
  check(typeof cacheDirectory === 'string' && path.isAbsolute(cacheDirectory)
    && path.resolve(cacheDirectory) === cacheDirectory && await fs.realpath(cacheDirectory) === cacheDirectory,
  'The managed Sidi archive cache is required');
  const directory = await fs.lstat(cacheDirectory);
  check(directory.isDirectory() && directory.uid === process.getuid() && !(directory.mode & 0o077),
    'The managed Sidi archive cache must be owner-private');
  const controlRpc = createHostedRpc({ secret, fetchImpl, maxResponseBytes: 16 * 1024 });
  const transfer = createDriverAuditSupabaseTransfer({ controlRpc, fetchImpl });
  const collectorCache = createDriverAuditCollectorReadCache({ cacheDirectory, cacheFreeBytes });
  const rpcForResponseLimit = maxResponseBytes => collectorCache.wrapRpc(createHostedRpc({ secret, maxResponseBytes,
    fetchImpl: transfer.wrapFetch({ maxResponseBytes }) }), { maxResponseBytes });
  const rpc = rpcForResponseLimit(70 * 1024 ** 2);
  const original = createSupabaseArchiveTransport({ secret, drainAcknowledgements: true,
    fetchImpl: transfer.wrapFetch({ maxResponseBytes: 16 * 1024 ** 2 }) });
  const uploads = photoStore || createDriverAuditSpacesArchive({ env });
  const recoveryDirectory = env.DRIVER_AUDIT_PHOTO_RECOVERY_DIRECTORY;
  const photoRecovery = recoveryDirectory === undefined ? undefined : createDriverAuditPhotoRecovery(recoveryDirectory);
  check(!photoRecovery || recoveryDirectory !== cacheDirectory && !recoveryDirectory.startsWith(cacheDirectory + path.sep),
    'Original photo recovery must be outside the disposable archive cache');
  const photoArchive = createDriverAuditSupabaseArchive({ archive: original, rpc, photoStore: uploads, photoRecovery, env });
  const progressRpc = (name, args) => {
    check(['matter_hosted_state_read', 'matter_hosted_native_progress_cas'].includes(name),
      'Unexpected Sidi polling progress operation');
    return rpc(name === 'matter_hosted_state_read' ? 'matter_hosted_app_progress_read' : 'matter_hosted_app_progress_cas', args);
  };
  return {
    kind: 'supabase', executionHost: 'sidi', executionAdmission: 'fixed-host-v1',
    transferAccounting: 'supabase-http-bytes-v1',
    rpc, rpcForResponseLimit,
    archive: createDriverAuditReadCache({ archive: photoArchive, cacheDirectory, cacheFreeBytes }),
    archiveCacheDirectory: cacheDirectory,
    photoAliasIdentitySha256: uploads.identitySha256,
    pollProgress: createDriverAuditPollProgress({ rpc: progressRpc }),
    createExecutionBudget: createDriverAuditFixedHostBudgetFactory(),
    archiveReadBudget: meteredReader,
    readTransferUsage: transfer.readTransferUsage,
    readSyncStatus: (generation, clock) => readDriverAuditFileSyncStatus(
      path.join(path.dirname(path.dirname(cacheDirectory)), 'sync-status.private.json'), generation, clock),
  };
}
