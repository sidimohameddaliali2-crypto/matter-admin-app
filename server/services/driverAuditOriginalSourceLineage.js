import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readPrivateDriverAuditSource, requirePrivateDriverAuditSourceDirectory } from './driverAuditSource.js';

export const DRIVER_AUDIT_HISTORICAL_SOURCE_FILE = 'historical-source-lineage.private.json';
// The original builder's source identity algorithm, independently checked
// against the original receipt and its restored backup. This file is unchanged
// in the managed-cache builder. A different algorithm needs explicit review.
export const DRIVER_AUDIT_ORIGINAL_BASIS_MODULE_SHA256 = '1ed994b9ec1075cc49763273e4604f0ec4900182202e5d7725ecfd858d2b7ad3';
const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requireProof = (condition, message = 'Original historical source proof differs') => { if (!condition) throw Error(message); };
const fields = ['key', 'revision', 'event_id', 'request_sha256', 'body_sha256', 'body_text', 'event_text', 'created_at'];
const exact = (value, names) => object(value) && isDeepStrictEqual(Object.keys(value).sort(), [...names].sort());
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

export function originalDriverAuditReceiptSha256(row) {
  requireProof(exact(row, fields) && row.key === 'collector-state' && Number.isSafeInteger(row.revision) && row.revision > 0
    && typeof row.body_text === 'string' && Buffer.byteLength(row.body_text) <= 2 * 1024 * 1024
    && digest(row.body_sha256) && hash(row.body_text) === row.body_sha256
    && digest(row.request_sha256) && typeof row.event_id === 'string' && row.event_id.length > 0 && row.event_id.length <= 256
    && typeof row.event_text === 'string' && Buffer.byteLength(row.event_text) <= 1024 * 1024
    && typeof row.created_at === 'string' && row.created_at.length <= 64 && Number.isFinite(Date.parse(row.created_at)));
  JSON.parse(row.event_text);
  return hash(JSON.stringify(Object.fromEntries(fields.map(key => [key, row[key]]))));
}

export function originalDriverAuditSourceBasis(publication) {
  const { head } = publication || {};
  requireProof(digest(head?.reportHash) && digest(head?.manifest?.sha256));
  return hash(JSON.stringify(canonical({ head: { reportHash: head.reportHash, manifest: head.manifest, gps: head.gps },
    gps: Object.fromEntries(Object.entries(publication.gpsState || {}).map(([key, value]) => [key, value.stateManifest])),
    photos: publication.cloudPhotoResults || {}, photoBindingRepair: publication.photoBindingRepair || null })));
}

// This proves only which ORIGINAL SOURCE RECEIPT must survive selection. It
// explicitly does not recover or verify an absent temporary rendered workspace.
export async function validateDriverAuditHistoricalSourceProof({ proof, config }) {
  requireProof(exact(proof, ['version', 'kind', 'origin', 'sourceBasisModuleSha256', 'entries']) && proof.version === 1
    && proof.kind === 'historical-source-receipt-retention-v1'
    && proof.sourceBasisModuleSha256 === DRIVER_AUDIT_ORIGINAL_BASIS_MODULE_SHA256
    && exact(proof.origin, ['sourceDumpSha256', 'sourceSnapshotSha256', 'restoreVerificationSha256', 'originalReceiptSha256'])
    && Object.values(proof.origin).every(digest) && Array.isArray(proof.entries) && proof.entries.length > 0 && proof.entries.length <= 8);
  requireProof(digest(config.builderSha256), 'The historical source needs the reviewed actual builder');
  const installed = await fs.lstat(config.codeRoot).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  // The existing atomic builder transition may be interrupted after retaining
  // the old directory and before installing the replacement. Only that exact
  // retained builder may supply the unchanged source-basis algorithm. A present
  // corrupt or symlinked canonical builder never gets a fallback.
  const codeRoot = installed ? config.codeRoot : path.join(path.dirname(config.codeRoot), 'builder-retained-' + config.builderSha256);
  await requirePrivateDriverAuditSourceDirectory(codeRoot);
  const { verifyAuditBuilder } = await import('../vendor/driver-audits/integration/cloud/driver-audit-handoff.mjs');
  await verifyAuditBuilder(codeRoot, config.builderSha256);
  const moduleFile = path.join(codeRoot, 'integration/cloud/automatic-release.mjs');
  requireProof(hash(await readPrivateDriverAuditSource(moduleFile, 1024 * 1024)) === proof.sourceBasisModuleSha256,
    'The original source basis implementation differs');
  const owners = new Set(), sources = new Set();
  for (const entry of proof.entries) {
    requireProof(exact(entry, ['owner', 'reference', 'receipt', 'receiptSha256', 'gap'])
      && exact(entry.owner, ['relative', 'sha256', 'collectorRevision'])
      && /^work\/attempts\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/accepted\.private\.json$/i.test(entry.owner.relative)
      && digest(entry.owner.sha256) && Number.isSafeInteger(entry.owner.collectorRevision)
      && exact(entry.reference, ['basis', 'privateRoot', 'manifestSha256'])
      && digest(entry.reference.basis) && digest(entry.reference.manifestSha256)
      && typeof entry.reference.privateRoot === 'string' && path.isAbsolute(entry.reference.privateRoot)
      && exact(entry.gap, ['kind', 'workspacePresent', 'renderedManifestAvailable'])
      && entry.gap.kind === 'preexisting-missing-temporary-report-workspace'
      && entry.gap.workspacePresent === false && entry.gap.renderedManifestAvailable === false
      && digest(entry.receiptSha256) && originalDriverAuditReceiptSha256(entry.receipt) === entry.receiptSha256
      && entry.receipt.revision < entry.owner.collectorRevision && !owners.has(entry.owner.relative)
      && !sources.has(entry.reference.privateRoot));
    requireProof(originalDriverAuditSourceBasis(JSON.parse(entry.receipt.body_text)) === entry.reference.basis,
      'Original receipt source basis does not match the historical reference');
    owners.add(entry.owner.relative); sources.add(entry.reference.privateRoot);
  }
  return { entries: proof.entries, basisModuleFile: moduleFile, canonicalBuilderAbsent: !installed };
}
