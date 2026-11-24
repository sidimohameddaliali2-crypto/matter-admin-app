import { connectPreviewCorrections } from '../vendor/driver-audits/integration/cloud/preview-corrections.mjs';
import { connectPreviewOrderTiming } from '../vendor/driver-audits/integration/cloud/preview-order-timing.mjs';

const check = value => { if (!value) throw Error('The original light report policy inputs differ'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const equal = (one, two) => JSON.stringify(one) === JSON.stringify(two);

function originalRows(rows) {
  check(Array.isArray(rows) && rows.length <= 100000);
  const result = new Map();
  for (const row of rows) {
    check(object(row) && typeof row.key === 'string' && row.key.length > 0
      && digest(row.assessmentHash) && !result.has(row.key));
    result.set(row.key, row);
  }
  return result;
}

// Build-time only: the existing preview wrappers evaluate the full frozen
// population together, including same-day peers and owner arrangements. Staff
// reads receive the per-case result, never the complete GPS or policy index.
export async function buildDriverAuditLightPolicy({ view, gps, corrections, availability,
  decisions, reviewSnapshot, householdArrangements } = {}) {
  check(view?.version === 1 && digest(view.generation) && digest(view.reportHash)
    && view.overlay?.status === 'ready' && view.overlay.generation === view.generation
    && Array.isArray(view.overlay.entries) && Array.isArray(view.photos)
    && gps?.version === 1 && object(gps.records) && Array.isArray(householdArrangements)
    && reviewSnapshot?.snapshotHash === view.reportHash);
  const source = originalRows(view.gpsRows), reviews = originalRows(reviewSnapshot.rows);
  check(source.size === reviews.size);
  for (const [key, row] of source) {
    const review = reviews.get(key);
    check(digest(row.delivery?.source_sha256) && review?.assessmentHash === row.assessmentHash
      && (!review.delivery?.source_sha256 || review.delivery.source_sha256 === row.delivery.source_sha256));
  }
  const seen = new Set();
  for (const entry of view.overlay.entries) {
    const row = source.get(entry?.recordKey);
    check(row && !seen.has(entry.recordKey) && entry.assessmentHash === row.assessmentHash
      && entry.deliverySourceSha256 === row.delivery.source_sha256);
    seen.add(entry.recordKey);
  }

  let service = {
    async evidenceOverlay() { return view.overlay; },
    async snapshotFor(hash) { check(hash === view.reportHash); return reviewSnapshot; },
  };
  if (corrections != null || availability != null) {
    service = connectPreviewCorrections(service, view, {
      ...(corrections ?? { version: 1, generation: view.generation, reportHash: view.reportHash, records: [] }),
      ...(availability != null ? { gpsAvailability: availability } : {}),
    });
  }
  service = connectPreviewOrderTiming(service, view, gps, { frozen: true, decisions,
    households: { async read() { return { arrangements: householdArrangements }; } } });
  const overlay = await service.evidenceOverlay({}), snapshot = await service.snapshotFor(view.reportHash);
  const entries = new Map(overlay.entries.map(entry => [entry.recordKey, entry]));
  const decorated = originalRows(snapshot.rows), householdKeys = new Set();
  for (const entry of entries.values()) {
    const household = entry.timingReassessment?.householdResolution;
    if (household) { householdKeys.add(household.recordKey); householdKeys.add(household.partnerRecordKey); }
  }
  const result = new Map();
  for (const [key, original] of reviews) {
    const row = decorated.get(key), entry = entries.get(key);
    check(row);
    // GPS has its separately verified per-case representation. All other
    // original policy fields, including availability and accepted decisions,
    // remain intact in this compact overlay.
    const compact = entry ? Object.fromEntries(Object.entries(entry).filter(([name]) => name !== 'gpsEvidence')) : null;
    const value = { overlay: compact, sharedHouseholdStop: householdKeys.has(key)
      ? await service.householdStopFor(key) : null,
    // Flat union matches the original finding validator; these are evaluated
    // finding identities, not replacements for the saved review issue ID.
    reviewFindingIds: [...new Set([...(row.findings ?? []), ...(row.photoFindings ?? [])].map(finding => finding.issue_id))] };
    if (!equal(row.findings, original.findings)) value.findings = row.findings;
    if (!equal(row.tier, original.tier)) value.tier = row.tier;
    result.set(key, value);
  }
  return structuredClone(result);
}
