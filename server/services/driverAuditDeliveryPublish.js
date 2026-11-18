import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readManifestBytes } from '../vendor/driver-audits/integration/cloud/repository.mjs';
import { createHouseholdStore } from '../vendor/driver-audits/integration/cloud/household-arrangements.mjs';
import { namespaceState } from '../vendor/driver-audits/integration/cloud/preview-runtime.mjs';
import { getBusinessDayBounds } from '../utils/businessDate.js';
import { readDriverAuditDeliveryGpsScope } from './driverAuditDeliveryCaseProjection.js';
import { planDriverAuditDeliveryChanges, readDriverAuditDeliverySource } from './driverAuditDeliveryChanges.js';
import { driverAuditDeliveryIdentity } from './driverAuditDeliveryHead.js';
import { createDriverAuditDeliveryView } from './driverAuditDeliveryView.js';

const MiB = 1024 ** 2;
const collectorKey = 'collector-state';
const sha = body => createHash('sha256').update(body).digest('hex');
const requireScope = (condition, message) => {
  if (!condition) throw Object.assign(Error(message), { code: 'DRIVER_AUDIT_CASE_HELD' });
};

function collectorDocument(revision, body) {
  requireScope(Number.isSafeInteger(revision) && revision > 0 && typeof body === 'string',
    'An exact saved collector publication is required');
  const publication = { ...JSON.parse(body), revision };
  const cutoff = Date.parse(publication.head?.source?.observedAt);
  requireScope(Number.isFinite(cutoff), 'The saved delivery source cutoff is unavailable');
  return { publication, revision, bodySha256: sha(body), cutoff: new Date(cutoff).toISOString() };
}

async function basePolicy({ head, archive, reviewState, includeOriginalOverlay }) {
  const descriptor = JSON.parse(await readManifestBytes(archive, head.descriptor, { maxBytes: 8 * MiB }));
  requireScope(descriptor.version === 1 && descriptor.generation === head.generation
    && descriptor.reportHash === head.reportHash && descriptor.sourceManifestSha256 === head.servingPackage.manifestSha256,
  'The retained report policy does not match the published base');
  async function read(name, maximum, compressed = false) {
    const ref = descriptor.files?.[name];
    if (!ref) return undefined;
    requireScope(ref.domain === 'previewRuntime' && ref.path === name, 'The retained report policy reference differs');
    const bytes = await readManifestBytes(archive, ref, { maxBytes: maximum });
    return JSON.parse(compressed ? gunzipSync(bytes, { maxOutputLength: 128 * MiB }) : bytes);
  }
  const [view, corrections, decisions, households] = await Promise.all([
    includeOriginalOverlay ? read('preview-read-view.private.json.gz', 32 * MiB, true) : undefined,
    read('corrections.private.json', 16 * MiB),
    read('case-decisions.private.json', 16 * MiB),
    createHouseholdStore(namespaceState(reviewState)).read(),
  ]);
  requireScope((!includeOriginalOverlay || view?.generation === head.generation && view.reportHash === head.reportHash
    && view.overlay?.status === 'ready' && view.overlay.bindingsVerified === true && Array.isArray(view.overlay.entries))
    && (!corrections || Array.isArray(corrections.records)) && (!decisions || Array.isArray(decisions.records)),
  'The previously verified delivery policies are unavailable');
  return { overlays: new Map((view?.overlay.entries ?? []).map(entry => [entry.recordKey, entry])),
    corrections, decisions, households: households.arrangements, householdRevision: households.revision };
}

// Nearby rows are read-only context for a selected case. The slot never calls
// the complete report builder or changes a neighbor's saved presentation.
async function openCaseScopes({ head, pages, source, archive, reviewState, plan }) {
  const existingDays = new Set((await pages.index(head)).days.map(item => item.day));
  const selected = new Set(plan.selected.map(candidate => candidate.key)), sourceDays = new Map(), cachedDays = new Map();
  for (const candidate of source.cases.values()) {
    if (!sourceDays.has(candidate.day)) sourceDays.set(candidate.day, []);
    sourceDays.get(candidate.day).push(candidate);
  }
  const original = await basePolicy({ head, archive, reviewState, includeOriginalOverlay: plan.changedCount > 0 });
  async function dayContext(day) {
    if (!cachedDays.has(day)) {
      const directory = existingDays.has(day) ? await pages.directory(head, day) : null;
      const records = new Map(), incoming = new Map(), changed = new Map();
      requireScope((directory?.keys.length ?? 0) + (sourceDays.get(day)?.length ?? 0) <= 8000,
        'The dated evidence scope exceeds its bound');
      for (const key of directory?.keys ?? []) records.set(key, await pages.record(head, key));
      for (const candidate of sourceDays.get(day) ?? []) {
        const previous = records.get(candidate.key);
        if (!previous) incoming.set(candidate.key, await source.readCase(candidate.key));
        else if (selected.has(candidate.key) && (previous.gpsRow.assessmentHash !== candidate.summary.assessmentHash
          || previous.gpsRow.delivery.source_sha256 !== candidate.summary.delivery.source_sha256)) {
          changed.set(candidate.key, await source.readCase(candidate.key));
        }
      }
      // Keep only the active day resident. Immutable archive/cache identities
      // provide reuse if a subsequent slot opens this date.
      cachedDays.clear();
      cachedDays.set(day, { records, incoming, changed });
    }
    return cachedDays.get(day);
  }
  return {
    async forCase(candidate) {
      const { records, incoming, changed } = await dayContext(candidate.day);
      const previous = records.get(candidate.key);
      const peers = [...records.values()].filter(entry => entry.row.key !== candidate.key).map(entry => ({
        row: entry.gpsRow, gps: entry.gps,
      }));
      const observedPeers = [...incoming.values()].filter(row => row.key !== candidate.key).map(row => ({ row, gps: {} }));
      const changedPeers = [...changed.values()].filter(row => row.key !== candidate.key).map(row => ({ row, gps: {} }));
      const affectedHouseholds = original.households.filter(arrangement => candidate.day >= arrangement.effectiveFrom
        && (!arrangement.effectiveTo || candidate.day <= arrangement.effectiveTo));
      const scoped = document => document && { ...document, records: document.records.filter(row => row.recordKey === candidate.key) };
      const corrections = scoped(original.corrections);
      const relatedKeys = new Set((corrections?.records ?? []).flatMap(row => row.photoSupplements.flatMap(event =>
        event.relatedRecordKeys ?? [])));
      relatedKeys.delete(candidate.key);
      const relatedPhotos = [];
      for (const key of relatedKeys) {
        const peer = records.get(key) ?? await pages.record(head, key);
        const hash = peer.gpsRow.delivery.photo_sha256;
        requireScope(!selected.has(key) || source.cases.get(key)?.summary.delivery.photo_sha256 === hash,
          'The related photo binding must be verified with the affected delivery');
        relatedPhotos.push([key, hash]);
      }
      const gpsCoverage = candidate.inputs.gpsCoverage;
      requireScope(!gpsCoverage?.pendingPublication, 'The saved GPS publication is still pending');
      const gpsScope = gpsCoverage?.sources !== 'not-in-published-scope' && source.gpsAsOf
        ? await readDriverAuditDeliveryGpsScope({ source, candidate, complete: true, peers: [...peers, ...observedPeers].map(({ row, gps }) => ({
          ...row, context: gps?.context,
        })) }) : null;
      return { prior: previous ? { entry: previous, index: previous } : null, gpsScope,
        policyScope: { complete: true, peers: [...peers, ...observedPeers], changedPeers, relatedPhotos,
          householdArrangements: affectedHouseholds,
          overlay: original.overlays.has(candidate.key) ? [original.overlays.get(candidate.key)] : [],
          corrections, decisions: scoped(original.decisions) } };
    },
    async verify() {
      const households = await createHouseholdStore(namespaceState(reviewState)).read();
      requireScope(households.revision === original.householdRevision, 'The owner-accepted delivery arrangements advanced during staging');
    },
  };
}

export function createDriverAuditDeliveryPublisher({ archive, replica, sourceState, reviewState, originalCollectorReceipt,
  automaticReleaseBasis, openProjector, verifyInputs,
  readSource = readDriverAuditDeliverySource, openScopes = openCaseScopes } = {}) {
  const pages = createDriverAuditDeliveryView({ archive });
  let retainedSource;
  return async function publishSlot(scheduledAt) {
    requireScope(Number.isFinite(scheduledAt), 'An explicit delivery reporting slot is required');
    const { startOfDay } = getBusinessDayBounds(scheduledAt);
    const minutes = (scheduledAt - startOfDay.getTime()) / 60_000;
    requireScope(minutes === 630 || minutes === 720, 'An explicit delivery reporting slot is required');
    const [before, saved] = await Promise.all([replica.head(), sourceState.read(collectorKey)]);
    requireScope(before?.lightView, 'The last verified date index must be selected before delivery-scoped publishing');
    const active = driverAuditDeliveryIdentity(before), latest = collectorDocument(saved.revision, saved.body);
    requireScope(latest.revision >= active.collectorRevision && Date.parse(latest.cutoff) >= Date.parse(active.visibleCutoffAt),
      'The saved collector moved behind the published delivery evidence');
    const latestBasis = automaticReleaseBasis(latest.publication);
    const sameAsBase = !before.deliveryView && latestBasis === before.servingPackage.sourceBasis;
    requireScope(latest.revision !== before.servingPackage.collectorRevision || sameAsBase,
      'The saved collector conflicts with the original report source');
    if (sameAsBase) return { status: 'unchanged', head: before, latestCaptureAt: latest.cutoff, changedRecords: 0 };
    if (before.deliveryView && latest.revision === before.deliveryView.collectorRevision) {
      requireScope(latest.bodySha256 === before.deliveryView.sourceBodySha256, 'The saved collector body conflicts with its publication');
    }
    const source = await readSource({ archive, publication: latest.publication });
    let baseline;
    // The morning decision only uses key membership. The noon decision must
    // compare with each case's last published inputs, including the frozen base.
    if (minutes === 720) {
      const base = before.servingPackage;
      if (retainedSource?.revision !== base.collectorRevision || retainedSource?.basis !== base.sourceBasis) {
        const receipt = await originalCollectorReceipt(base.collectorRevision, base.sourceBasis, before.visibleCutoffAt);
        const original = collectorDocument(receipt.revision, receipt.body_text);
        requireScope(original.bodySha256 === receipt.body_sha256, 'The original delivery source receipt differs');
        retainedSource = { revision: receipt.revision, basis: base.sourceBasis,
          cases: (await readSource({ archive, publication: original.publication, comparisonOnly: true })).cases };
      }
      baseline = retainedSource;
    }
    const plan = await planDriverAuditDeliveryChanges({ scheduledAt, head: before, pages, baseline, latest: source });
    const pendingEvidence = source.gpsPending === true || plan.heldGpsCount > 0;
    if (!plan.selected.length) return { status: 'unchanged', head: before, latestCaptureAt: latest.cutoff, changedRecords: 0,
      pendingEvidence };
    const scopes = await openScopes({ head: before, pages, source, archive, reviewState, plan });
    const projectCase = await openProjector();
    const changes = [];
    const byDay = plan.selected.slice().sort((left, right) => left.day.localeCompare(right.day));
    for (const candidate of byDay) {
      const entry = await projectCase({ archive, source, candidate, ...await scopes.forCase(candidate) });
      changes.push({ key: candidate.key, sourceHash: candidate.sourceHash, gpsHash: candidate.gpsHash, entry });
    }
    await verifyInputs();
    const staged = await pages.stage({ head: before, changes, collectorRevision: latest.revision,
      sourceBodySha256: latest.bodySha256, visibleCutoffAt: latest.cutoff });
    requireScope(staged.changedRecords === changes.length, 'The verified staged deliveries differ from the scoped plan');
    const fresh = await sourceState.read(collectorKey);
    requireScope(fresh.revision === latest.revision && typeof fresh.body === 'string' && sha(fresh.body) === latest.bodySha256,
      'The saved collector advanced during delivery staging');
    await scopes.verify();
    await verifyInputs();
    const result = await replica.activateDeliveryView({ expected: before, staged });
    return { ...result, latestCaptureAt: latest.cutoff, changedRecords: staged.changedRecords, pendingEvidence };
  };
}
