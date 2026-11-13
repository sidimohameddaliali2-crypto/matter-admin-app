import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = fileURLToPath(new URL('../', import.meta.url));
const sha256 = /^[a-f0-9]{64}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const implementationFiles = [
  'services/driverAuditGarbageCollection.js',
  'services/driverAuditBuildRecipe.js',
  'services/driverAuditDirectImport.js',
  'services/driverAuditReplica.js',
  'services/driverAuditRetention.js',
  'services/driverAuditWriter.js',
  'services/driverAuditWorkspace.js',
  'services/driverAuditWorkspaceRetirement.js',
  'scripts/driverAuditSync.js',
  'vendor/driver-audits/integration/cloud/audit-replica.mjs',
  'vendor/driver-audits/integration/cloud/automatic-hosted-preview.mjs',
  'vendor/driver-audits/integration/cloud/driver-audit-archive.mjs',
  'vendor/driver-audits/integration/cloud/remote-preview-package.mjs',
  'vendor/driver-audits/integration/cloud/repository.mjs',
  'vendor/driver-audits/integration/hosted/supabase-archive.mjs',
];

export async function driverAuditRetentionImplementation(root = serverRoot) {
  const digests = await Promise.all(implementationFiles.map(async file => [file, digest(await fs.readFile(path.join(root, file)))]));
  return digest(JSON.stringify(digests));
}

export function driverAuditReplicaRetentionStatus(requested, receipt, implementationSha256) {
  if (!requested) return 'off';
  if (receipt?.replicaGcEnabled !== true || !sha256.test(receipt.gcRestoreReceiptSha256)
    || !sha256.test(receipt.gcImplementationSha256)) return 'proof-required';
  return receipt.gcImplementationSha256 === implementationSha256 ? 'qualified' : 'proof-stale';
}
