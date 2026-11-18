import { gunzipSync } from 'node:zlib';
import { gpsAvailabilityFile, loadRemotePreviewPackage } from '../vendor/driver-audits/integration/cloud/remote-preview-package.mjs';
import { createCloudRepository } from '../vendor/driver-audits/integration/cloud/repository.mjs';
import { historyIndex } from '../vendor/driver-audits/integration/cloud/preview-source-history.mjs';
import { createHouseholdStore } from '../vendor/driver-audits/integration/cloud/household-arrangements.mjs';
import { namespaceState } from '../vendor/driver-audits/integration/cloud/preview-runtime.mjs';
import { buildDriverAuditLightProjection } from './driverAuditLightProjection.js';
import { buildDriverAuditLightPolicy } from './driverAuditLightPolicy.js';
import { stageDriverAuditLightView } from './driverAuditLightArchive.js';
import { readRetainedDriverAuditFile } from './driverAuditLightEvidence.js';
import { buildDriverAuditLightPhotoLookup } from './driverAuditLightPhotoSuggestions.js';

const MiB = 1024 ** 2;
const unpack = (bytes, maxOutputLength) => JSON.parse(gunzipSync(bytes, { maxOutputLength }));

// Runs in the publisher or controlled backfill. The live reader receives only
// the resulting immutable date index and the pages opened by staff.
export async function buildDriverAuditLightView({ head, previous, archive, sourceArchive = archive, reviewState,
  householdArrangements } = {}) {
  const pack = await loadRemotePreviewPackage({ descriptor: head.descriptor, transport: sourceArchive,
    parallelCoreReads: true });
  if (pack.generation !== head.generation || pack.reportHash !== head.reportHash
    || pack.descriptor.sourceManifestSha256 !== head.servingPackage.manifestSha256) {
    throw Error('The light report source does not match its verified publication');
  }
  const { publication, view, gps, availability } = pack.takeVerifiedRuntime();
  const stateStore = { read: async () => ({ body: JSON.stringify(publication), revision: 1 }) };
  const repository = await createCloudRepository({ stateStore, transport: sourceArchive, cacheBytes: 8 * MiB }).pin();
  const sourceManifest = publication.privateRelease?.currentHead?.manifest;
  let sourceHistoryCases;
  if (sourceManifest) {
    if (!/^[a-f0-9]{64}$/.test(sourceManifest.sha256) ||
      sourceManifest.url !== 'report-data/snapshot-' + sourceManifest.sha256 + '.json') {
      throw Error('The retained source report manifest differs');
    }
    const source = await readRetainedDriverAuditFile(repository,
      'assets/snapshot-' + sourceManifest.sha256 + '.json.gz', 128 * MiB);
    sourceHistoryCases = await historyIndex(source, sourceManifest);
  }
  const reviewSnapshot = unpack(await readRetainedDriverAuditFile(repository,
    'review-snapshots/' + head.reportHash + '.json.gz', 128 * MiB), 128 * MiB);
  const optional = file => pack.has(file) ? JSON.parse(pack.read(file)) : undefined;
  const corrections = optional('corrections.private.json'), decisions = optional('case-decisions.private.json');
  const projection = buildDriverAuditLightProjection({ publication, view, gps, descriptor: pack.descriptor,
    browser: unpack(pack.read('browser-data.private.json.gz'), 128 * MiB), corrections,
    decisions, photoBindingRegistry: optional('preview-photo-bindings.private.json'),
    sourceHistoryCases, reviewSnapshot });
  projection.context.photoLookup = await buildDriverAuditLightPhotoLookup({ publication, archive: sourceArchive })
    .catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  const arrangements = householdArrangements ?? (await createHouseholdStore(namespaceState(reviewState)).read()).arrangements;
  const policy = await buildDriverAuditLightPolicy({ view, gps, corrections, decisions, availability: availability ?? optional(gpsAvailabilityFile),
    reviewSnapshot, householdArrangements: arrangements });
  for (const entries of projection.days.values()) {
    for (const entry of entries) {
      const effective = policy.get(entry.row.key);
      if (!effective) throw Error('The saved light delivery policy is missing');
      entry.policy = effective;
      if (effective.overlay?.timingReassessment) entry.summary.timing = effective.overlay.timingReassessment.state;
    }
  }
  return stageDriverAuditLightView({ projection, head, previous, archive });
}
