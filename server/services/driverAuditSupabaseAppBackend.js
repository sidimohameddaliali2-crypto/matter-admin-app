import fs from 'node:fs/promises';
import path from 'node:path';
import { createHostedRpc } from '../vendor/driver-audits/integration/cloud/rpc.mjs';
import { createSupabaseArchiveTransport } from '../vendor/driver-audits/integration/hosted/supabase-archive.mjs';
import { createDriverAuditFixedHostBudgetFactory } from './driverAuditFixedHostBudget.js';
import { createDriverAuditPollProgress } from './driverAuditPollProgress.js';
import { createDriverAuditReadCache } from './driverAuditReadCache.js';
import { createDriverAuditCollectorReadCache } from './driverAuditCollectorReadCache.js';
import { createDriverAuditLinkedPhotoReader, createDriverAuditSpacesArchive } from './driverAuditSpacesArchive.js';
import { createDriverAuditSupabaseArchive } from './driverAuditSupabaseArchive.js';
import { createDriverAuditSupabaseTransfer } from './driverAuditSupabaseTransfer.js';
import { createDriverAuditSupabaseWorkerStatusStore, driverAuditSupabaseWorkerStatusKey,
  readDriverAuditFileSyncStatus } from './driverAuditSyncStatus.js';
import { createDriverAuditPhotoRecovery } from './driverAuditPhotoRecovery.js';
import { createCloudState } from '../vendor/driver-audits/integration/cloud/cloud-state.mjs';

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
  const executionHost = env.DRIVER_AUDIT_EXECUTION_HOST;
  check(['sidi', 'off-host'].includes(executionHost)
    && (env.DRIVER_AUDIT_DATA_STORE || 'supabase') === 'supabase', 'Explicit managed Supabase execution is required');
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
    fetchImpl: (url, options, maxResponseBytes) => transfer.wrapFetch({ maxResponseBytes })(url, options) });
  const uploads = photoStore || (executionHost === 'off-host'
    ? createDriverAuditLinkedPhotoReader({ env, fetchImpl }) : createDriverAuditSpacesArchive({ env }));
  const recoveryDirectory = env.DRIVER_AUDIT_PHOTO_RECOVERY_DIRECTORY;
  const photoRecovery = recoveryDirectory === undefined ? undefined : createDriverAuditPhotoRecovery(recoveryDirectory);
  check(executionHost !== 'off-host' || photoRecovery, 'Off-host reporting requires its private photo recovery directory');
  check(!photoRecovery || recoveryDirectory !== cacheDirectory && !recoveryDirectory.startsWith(cacheDirectory + path.sep),
    'Original photo recovery must be outside the disposable archive cache');
  const photoArchive = createDriverAuditSupabaseArchive({ archive: original, rpc: rpcForResponseLimit(16 * 1024),
    photoStore: uploads, photoRecovery, env });
  const progressRpc = (name, args) => {
    check(['matter_hosted_state_read', 'matter_hosted_native_progress_cas'].includes(name),
      'Unexpected Sidi polling progress operation');
    return rpc(name === 'matter_hosted_state_read' ? 'matter_hosted_app_progress_read' : 'matter_hosted_app_progress_cas', args);
  };
  const remoteStatus = env.DRIVER_AUDIT_SERVING_STORE === 'supabase'
    ? createDriverAuditSupabaseWorkerStatusStore({ state: createCloudState({ rpc: (name, args) => {
      check(name === 'matter_hosted_state_read' && [driverAuditSupabaseWorkerStatusKey, 'app-sidi-report-head'].includes(args.p_key),
        'Unexpected shared report-status read');
      return rpcForResponseLimit(args.p_key === driverAuditSupabaseWorkerStatusKey ? 16 * 1024 : 768 * 1024)(name, args);
    } }) }) : null;
  return {
    kind: 'supabase', executionHost, executionAdmission: 'fixed-host-v1',
    transferAccounting: 'supabase-http-bytes-v1',
    rpc, rpcForResponseLimit,
    archive: createDriverAuditReadCache({ archive: photoArchive, cacheDirectory, cacheFreeBytes }),
    archiveCacheDirectory: cacheDirectory,
    photoAliasIdentitySha256: uploads.identitySha256,
    pollProgress: createDriverAuditPollProgress({ rpc: progressRpc }),
    createExecutionBudget: createDriverAuditFixedHostBudgetFactory(),
    archiveReadBudget: meteredReader,
    readTransferUsage: transfer.readTransferUsage,
    readSyncStatus: (generation, clock) => remoteStatus ? remoteStatus.read(generation, clock)
      : readDriverAuditFileSyncStatus(path.join(path.dirname(path.dirname(cacheDirectory)), 'sync-status.private.json'), generation, clock),
  };
}
