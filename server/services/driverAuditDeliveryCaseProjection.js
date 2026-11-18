import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { verifyAuditBuilder } from '../vendor/driver-audits/integration/cloud/driver-audit-handoff.mjs';
import { archiveBytes, archiveCatalog, createCloudRepository, readManifestBytes } from '../vendor/driver-audits/integration/cloud/repository.mjs';
import { createImmutableEvidenceCache } from '../vendor/driver-audits/integration/cloud/immutable-evidence-cache.mjs';
import { readRows } from '../vendor/driver-audits/integration/cloud/preview-source-history.mjs';
import { createPreviewPhotoBindingRegistry, previewPhotoBindings } from '../vendor/driver-audits/integration/cloud/preview-photo-bindings.mjs';
import { householdResolutions } from '../vendor/driver-audits/integration/cloud/household-arrangements.mjs';
import { connectPreviewCorrections } from '../vendor/driver-audits/integration/cloud/preview-corrections.mjs';
import { applyOrderTiming, reassessOrderTiming } from '../vendor/driver-audits/app/src/content/dashboard/order-timing-policy.mjs';
import { gpsEvidenceResult, gpsEvidenceSummary } from '../vendor/driver-audits/integration/private-gps/evidence-result.mjs';
import { createDriverAuditLightEvidence, readRetainedDriverAuditFile } from './driverAuditLightEvidence.js';

const MiB = 1024 ** 2;
const assetLimit = 16 * MiB;
const sha = value => createHash('sha256').update(value).digest('hex');
const hash = value => sha(JSON.stringify(value));
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00Z'))
  && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const validClock = value => typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const nullableText = value => typeof value === 'string' ? value : null;
const hold = message => { throw Object.assign(Error(message), { code: 'DRIVER_AUDIT_CASE_HELD' }); };
const requireEvidence = (value, message) => { if (!value) hold(message); };
const sourceAssetPath = ref => 'assets/' + ref.url.slice('report-data/'.length) + '.gz';
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const gpsWindowCaches = new WeakMap();

function checkRow(row, key, day) {
  requireEvidence(row?.key === key && row.date === day && key === day + '/' + row.delivery?.delivery_id
    && hex(row.assessmentHash) && hex(row.delivery.source_sha256), 'The saved delivery assessment identity differs');
  return row;
}

function checkResource(ref, kind) {
  requireEvidence(hex(ref?.sha256) && ref.url === `report-data/${kind}-${ref.sha256}.json`
    && Number.isSafeInteger(ref.count) && ref.count >= 0, 'A saved delivery case reference differs');
}

async function readDetail(repository, ref, key, day) {
  checkResource(ref, 'detail');
  requireEvidence(ref.count === 1, 'The original delivery detail is unavailable');
  const packed = await readRetainedDriverAuditFile(repository, sourceAssetPath(ref), assetLimit);
  const bytes = gunzipSync(packed, { maxOutputLength: assetLimit });
  requireEvidence(sha(bytes) === ref.sha256, 'The saved delivery detail failed verification');
  const { rows } = JSON.parse(bytes);
  requireEvidence(Array.isArray(rows) && rows.length === 1, 'The saved delivery detail is ambiguous');
  return checkRow(rows[0], key, day);
}

async function originalCase(prior, archive, key, day) {
  if (prior === null) return null;
  const { entry, index = entry } = prior ?? {};
  requireEvidence(entry?.row?.key === key && hex(index?.catalog?.sha256) && hex(index.generation)
    && hex(index.reportHash) && hex(entry.review?.snapshotHash), 'The previous delivery evidence context is unavailable');
  const head = { reportHash: index.reportHash, manifest: { sha256: index.generation,
    url: 'report-data/snapshot-' + index.generation + '.json' } };
  const body = JSON.stringify({ version: 1, head, catalog: index.catalog });
  const repository = await createCloudRepository({ transport: archive, stateStore: { read: async () => ({ body, revision: 1 }) } }).pin();
  const row = await readDetail(repository, entry.detail, key, day);
  requireEvidence(entry.gpsRow?.assessmentHash === row.assessmentHash && equal(entry.gpsRow.delivery, row.delivery),
    'The previous delivery and GPS bindings differ');
  return { entry, index, row, repository };
}

async function resolveRetained(repository, file) {
  try { return await repository.resolveFile('state', file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return repository.resolveFile('archive', file);
  }
}

async function verifiedPhoto(repository, archive, index, entry) {
  const expected = entry.photo.sha256;
  const image = await createDriverAuditLightEvidence({ archive }).photo(index, entry);
  requireEvidence(image.sha256 === expected && sha(image.body) === expected, 'The original photo bytes differ');
  for (const [domain, file] of [['objects', expected], ['legacyObjects', expected], ['archive', `photos/${expected}.gz`]]) {
    try { return await repository.resolveFile(domain, file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  hold('The original photo catalogue binding is unavailable');
}

function photoFor(row, original, sourceView, { photoRepair, photoCapture }) {
  const sourceUrl = nullableText(row.delivery.photo_url);
  const proofTimestamp = nullableText(row.delivery.raw_upload ?? row.delivery.upload);
  const originalSha256 = row.delivery.photo_sha256 ?? null;
  const view = { ...sourceView, gpsRows: [row], photos: [[row.key, originalSha256]] };
  let repair = photoRepair;
  if (!repair && !originalSha256 && sourceUrl && photoCapture?.urlSha256 === sha(sourceUrl)
    && photoCapture.proofTimestamp === proofTimestamp && validClock(photoCapture.observedAt)) {
    const binding = { recordKey: row.key, imageSha256: photoCapture.sha256, urlSha256: photoCapture.urlSha256, proofTimestamp };
    repair = { ...binding, date: row.date, sourceRowSha256: row.delivery.source_sha256, assessmentHash: row.assessmentHash,
      sources: [{ ...binding, receiptSha256: photoCapture.receiptSha256, captureSha256: photoCapture.captureSha256,
        observedAt: photoCapture.observedAt }] };
  }
  const registry = repair ? createPreviewPhotoBindingRegistry(view, [row], [repair]) : null;
  const resolved = previewPhotoBindings(view, registry).get(row.key);
  const previous = original?.entry.photo;
  const sameBinding = previous?.sourceUrl === sourceUrl && previous?.proofTimestamp === proofTimestamp;
  requireEvidence(!previous?.sha256 || !sameBinding || !resolved || previous.sha256 === resolved,
    'A changed photo conflicts with an original delivery photo');
  const sha256 = resolved ?? (sameBinding ? previous?.sha256 : null) ?? null;
  requireEvidence(sha256 === null || hex(sha256) && sourceUrl, 'The delivery photo evidence is unavailable');
  requireEvidence(!sourceUrl || sha256, 'The referenced photo has no verified original bytes');
  return { sha256, originalSha256, sourceUrl, proofTimestamp };
}

async function stageRuntimeFile(archive, label, value) {
  const bytes = gzipSync(JSON.stringify(value));
  requireEvidence(bytes.length <= 8 * MiB, 'The scoped GPS file exceeds its saved limit');
  const name = label + '-' + sha(bytes) + '.private.json.gz';
  const ref = await archiveBytes(archive, bytes, { domain: 'previewRuntime', path: name });
  return { name, ref };
}

// The source reader has already bound each selected window to its immutable GPS namespace. Open only
// those exact source files, hash both originals, and preserve the two clocks separately.
export async function readDriverAuditDeliveryGpsScope({ source, candidate, peers = [], asOf = source?.gpsAsOf,
  complete = false } = {}) {
  const needed = candidate?.inputs?.gps;
  const lookup = source?.cases?.get(candidate?.key);
  const repository = source?.repository;
  requireEvidence(complete === true && validClock(asOf) && Array.isArray(peers) && Array.isArray(needed)
    && needed.length <= 32 && lookup?.sourceHash === candidate.sourceHash && equal(lookup.inputs.gps, needed),
  'A verified dated GPS scope is required');
  requireEvidence(candidate.inputs.gpsCoverage?.sources !== 'not-in-published-scope'
    && candidate.inputs.gpsCoverage?.pendingPublication !== true, 'The dated GPS coverage is not published yet');
  let cache = gpsWindowCaches.get(repository);
  if (!cache) {
    cache = createImmutableEvidenceCache({ maxBytes: 16 * MiB, maxEntries: 48 });
    gpsWindowCaches.set(repository, cache);
  }
  let totalBytes = 0;
  const windows = [];
  for (const saved of needed) {
    const { namespace, scopeKind, day, driverId, vehicleNo, snapshotSha256, observationSha256, fetchedAt } = saved;
    requireEvidence(/^[a-zA-Z0-9_-]{1,60}$/.test(namespace) && ['driver', 'vehicle'].includes(scopeKind)
      && validDay(day) && hex(snapshotSha256) && hex(observationSha256) && validClock(fetchedAt)
      && Date.parse(fetchedAt) <= Date.parse(asOf), 'A saved GPS window reference differs');
    const cacheKey = JSON.stringify([namespace, scopeKind, day, driverId, vehicleNo, snapshotSha256, observationSha256, fetchedAt]);
    const loaded = await cache.getOrLoad(cacheKey, async () => {
      const [packed, observation] = await Promise.all([
        repository.readFile('gps', `${namespace}/snapshots/${snapshotSha256}.json.gz`, { maxBytes: 32 * MiB }),
        repository.readFile('gps', `${namespace}/observations/${observationSha256}.json`, { maxBytes: MiB }),
      ]);
      const bytes = gunzipSync(packed, { maxOutputLength: 32 * MiB });
      requireEvidence(sha(bytes) === snapshotSha256 && sha(observation) === observationSha256,
        'A saved GPS window failed verification');
      const snapshot = JSON.parse(bytes), receipt = JSON.parse(observation);
      for (const record of [snapshot, receipt]) {
        requireEvidence(record.driverId === driverId && record.day === day && (record.scopeKind ?? 'driver') === scopeKind
          && (scopeKind !== 'vehicle' || String(record.vehicleNo) === String(vehicleNo)), 'A saved GPS window assignment differs');
      }
      requireEvidence(receipt.snapshotSha256 === snapshotSha256 && receipt.fetchedAt === fetchedAt
        && Array.isArray(snapshot.pages) && snapshot.pages.every(page => Array.isArray(page.data)), 'A saved GPS observation receipt differs');
      const window = { ...snapshot, scopeKind, snapshotSha256, fetchedAt, points: snapshot.pages.flatMap(page => page.data) };
      const size = bytes.length + observation.length;
      return { value: { window, size }, bytes: size };
    });
    totalBytes += loaded.size;
    requireEvidence(totalBytes <= 64 * MiB, 'The saved GPS case exceeds its decoded limit');
    windows.push(loaded.window);
  }
  return { asOf, windows, peers, complete: true };
}

async function projectGps({ row, candidate, original, gpsScope, archive, rules }) {
  const before = original?.entry.gps;
  const priorFiles = original?.entry.gpsFiles ?? { streams: {}, projections: {} };
  const sameDelivery = original && equal(original.row, row);
  if (!gpsScope) {
    requireEvidence(sameDelivery && !candidate.inputs.gps.length,
      'Verified dated GPS coverage and neighboring cases are required for this delivery');
    return { entry: before, files: priorFiles, asOf: original.entry.gpsAsOf, availability: null };
  }
  const { complete, asOf, windows, peers = [] } = gpsScope;
  requireEvidence(complete === true && validClock(asOf) && Array.isArray(windows) && Array.isArray(peers)
    && peers.every(peer => peer?.date === row.date && peer.key !== row.key), 'The scoped GPS observations are unavailable');
  requireEvidence(candidate.inputs.gps.every(expected => windows.some(saved => saved.snapshotSha256 === expected.snapshotSha256
    && saved.day === expected.day && saved.scopeKind === expected.scopeKind)), 'A dated GPS observation is missing from the verified scope');
  const ingested = rules.ingest({ windows, asOf });
  const related = new Set([...(before?.result?.gps?.streams ?? []),
    ...(before?.context?.vehicleAlternatives ?? []).map(vehicle => `${row.date}|${vehicle}`),
    ...ingested.streams.filter(stream => stream.day === row.date).map(stream => stream.key)]);
  const previousStreams = await Promise.all(Object.entries(priorFiles.streams).filter(([key]) => related.has(key)).map(async ([key, ref]) => {
    const saved = JSON.parse(gunzipSync(await readManifestBytes(archive, ref, { maxBytes: assetLimit }), { maxOutputLength: 32 * MiB }));
    requireEvidence(saved.key === key && saved.day === row.date, 'The retained GPS stream differs');
    return saved;
  }));
  const streams = rules.mergeRetainedGpsStreams(previousStreams, ingested.streams, ingested.qualityObservations)
    .filter(stream => stream.day === row.date);
  const index = { records: before ? { [row.key]: before } : {} };
  const selected = rules.refreshReleaseGps({ rows: [row], windows, streams, baselineStreams: previousStreams,
    baselineIndex: index, asOf }).index.records[row.key];
  requireEvidence(selected, 'The scoped GPS result is unavailable');
  const gpsInputsUnchanged = candidate.gpsHash == null || candidate.gpsHash === original?.entry.gpsInputHash;
  if (before && selected === before && sameDelivery && gpsInputsUnchanged && previousStreams.every(old => streams.some(next => equal(old, next)))
    && streams.length === previousStreams.length) {
    return { entry: before, files: priorFiles, asOf: original.entry.gpsAsOf,
      availability: rules.releaseAvailability(row, windows, before.context) };
  }
  let result = selected.result;
  if (result.gps?.streams?.length && peers.length) {
    result = rules.grade({ record: row, streams, context: selected.context, peers });
  }
  const savedLinks = before?.result?.gps?.streams ?? [];
  requireEvidence(savedLinks.every(key => result.gps?.streams?.includes(key)), 'A previously verified GPS association would be lost');
  const linked = streams.filter(stream => result.gps?.streams?.includes(stream.key));
  const available = rules.sourceStreamsForDelivery(streams, row);
  const raw = [...new Map(windows.filter(window => window.day === row.date
    && (window.scopeKind === 'driver' && String(window.driverId) === String(row.delivery.driver_id)
      || window.scopeKind === 'vehicle' && row.delivery.vehicle != null && String(window.vehicleNo) === String(row.delivery.vehicle)))
    .flatMap(window => window.points ?? []).map(point => [point.sourceSha256 && point.sourceRow != null
      ? `${point.sourceSha256}|${point.sourceRow}` : hash(point), point])).values()];
  const sourceInfo = { rawRows: raw.length, usableClockRows: raw.filter(point => point.gpsTime).length,
    scope: 'saved_dated_vehicle_and_driver_sources', asOf };
  const { evidenceFile: _file, evidenceSummary: _summary, evidenceResult: _inline, ...entry } = selected;
  entry.result = result;
  const projected = gpsEvidenceResult({ row, entry, streams: linked, asOf, sourceInfo, availableStreams: available });
  const files = { streams: {}, projections: {} };
  const alternative = new Set(selected.context?.vehicleAlternatives ?? []);
  for (const stream of new Set([...linked, ...available, ...streams.filter(item => alternative.has(item.vehicle))])) {
    const previous = previousStreams.find(saved => saved.key === stream.key);
    files.streams[stream.key] = equal(previous, stream) ? priorFiles.streams[stream.key]
      : (await stageRuntimeFile(archive, 'gps', stream)).ref;
  }
  const file = await stageRuntimeFile(archive, 'gps-evidence', [[row.key, projected]]);
  files.projections[file.name] = file.ref;
  entry.evidenceFile = file.name;
  entry.evidenceSummary = { ...gpsEvidenceSummary(projected), deliveryDigest: projected.deliveryDigest };
  return { entry, files, asOf, availability: rules.releaseAvailability(row, windows, entry.context) };
}

function buildSummary(row, timing) {
  const delivery = row.delivery;
  const driver = delivery.driver_id;
  return { key: row.key, driverId: typeof driver === 'string' ? driver : Number.isSafeInteger(driver) ? String(driver) : null,
    driverName: nullableText(delivery.driver), customer: nullableText(delivery.customer),
    status: nullableText(delivery.app_status), outcome: nullableText(delivery.timing_label),
    scheduledAt: nullableText(delivery.window_start), uploadedAt: nullableText(delivery.raw_upload ?? delivery.upload),
    ...(timing ? { timing } : {}) };
}

function matchesSavedHouseholdStop(stop, match, rows) {
  if (stop?.authority !== 'owner_accepted'
    || !['stopId', 'arrangementId', 'arrangementHash', 'sourceRef', 'sourceSha256'].every(key => stop[key] === match[key])
    || stop.members?.length !== 2) return false;
  const members = [match.recordKey, match.partnerRecordKey].sort();
  return stop.members.every((member, index) => {
    const row = rows.find(item => item.key === members[index]), delivery = row?.delivery;
    return delivery && member.recordKey === row.key && member.assessmentHash === row.assessmentHash
      && member.deliverySourceSha256 === delivery.source_sha256 && member.customer === delivery.customer
      && member.date === row.date && member.upload === delivery.upload && member.windowStart === delivery.window_start
      && member.deadline === delivery.deadline && member.addressRelation === 'same_apartment';
  });
}

async function projectPolicy({ row, gps, view, original, source, policyScope, review, rules }) {
  requireEvidence(Array.isArray(policyScope?.householdArrangements), 'The original household and review policy state is unavailable');
  const peers = policyScope.peers ?? [];
  const changedPeers = policyScope.changedPeers ?? [];
  const relatedPhotos = policyScope.relatedPhotos ?? [];
  requireEvidence(Array.isArray(peers) && peers.every(peer => peer?.row?.date === row.date && peer.row.key !== row.key)
    && new Set(peers.map(peer => peer.row.key)).size === peers.length, 'The dated household evidence is ambiguous');
  requireEvidence(Array.isArray(changedPeers) && changedPeers.every(peer => peer?.row?.date === row.date
    && peer.row.key !== row.key && hex(peer.row.assessmentHash))
    && new Set(changedPeers.map(peer => peer.row.key)).size === changedPeers.length, 'The changed household evidence is ambiguous');
  requireEvidence(Array.isArray(relatedPhotos) && relatedPhotos.every(binding => Array.isArray(binding) && binding.length === 2
    && typeof binding[0] === 'string' && binding[0] !== row.key && hex(binding[1]))
    && new Set(relatedPhotos.map(([key]) => key)).size === relatedPhotos.length, 'The related delivery photo evidence differs');
  if (policyScope.householdArrangements.length || original?.entry.policy?.sharedHouseholdStop) {
    requireEvidence(policyScope.complete === true, 'Complete dated household evidence is required');
  }
  const rows = [...peers.map(peer => peer.row), row];
  const records = Object.fromEntries(peers.map(peer => [peer.row.key, peer.gps]));
  if (gps.entry) records[row.key] = gps.entry;
  const captures = (source.browser?.matter?.pinnedCurrentObservations ?? []).filter(capture => capture.day === row.date);
  const recovered = rules.recoverRetainedAddresses(rows, { records }, captures);
  if (gps.entry) gps.entry = recovered?.index?.records?.[row.key] ?? gps.entry;
  const households = householdResolutions(rows, recovered.index, policyScope.householdArrangements);
  const savedHouseholdStop = original?.entry.policy?.sharedHouseholdStop ?? null;
  const sameHousehold = (resolutions, peers) => {
    const related = [...resolutions.values()].filter(match => match.recordKey === row.key || match.partnerRecordKey === row.key);
    return savedHouseholdStop ? related.length > 0 && related.every(match => matchesSavedHouseholdStop(savedHouseholdStop, match, peers))
      : related.length === 0;
  };
  // Keep an established stop only while both original member bindings and
  // clocks remain exact. A different pair or arrangement requires joint review.
  requireEvidence(sameHousehold(households, rows),
    'Accepted household changes require joint evidence qualification');
  if (policyScope.householdArrangements.length && changedPeers.length) {
    const alternateRows = new Map(rows.map(item => [item.key, item]));
    const alternateRecords = { ...records };
    for (const peer of changedPeers) {
      alternateRows.set(peer.row.key, peer.row);
      alternateRecords[peer.row.key] = peer.gps ?? {};
    }
    const candidates = [...alternateRows.values()];
    const alternate = rules.recoverRetainedAddresses(candidates, { records: alternateRecords }, captures);
    requireEvidence(sameHousehold(householdResolutions(candidates, alternate.index, policyScope.householdArrangements), candidates),
      'Changed neighboring deliveries require joint household evidence qualification');
  }
  const overlay = (policyScope.overlay ?? []).filter(entry => entry.recordKey === row.key);
  const overlayGeneration = policyScope.overlayGeneration ?? overlay[0]?.generation ?? view.generation;
  const boundOverlay = rules.rebindPrivateReleaseOverlay({ version: 'matter-evidence-overlay-v1', generation: overlayGeneration,
    status: 'ready', bindingsVerified: true, entries: overlay, auditedAt: policyScope.overlayAsOf ?? null }, [row], view.generation);
  const photos = new Map([[row.key, row.delivery.photo_sha256 ?? null],
    ...peers.map(peer => [peer.row.key, peer.row.delivery.photo_sha256 ?? null])]);
  for (const [key, rawSha] of relatedPhotos) {
    requireEvidence(!photos.get(key) || photos.get(key) === rawSha, 'Two saved related delivery photo bindings disagree');
    photos.set(key, rawSha);
  }
  const scopedView = { ...view, version: 1, gpsRows: [row], overlay: boundOverlay, photos: [...photos] };
  let service = { async evidenceOverlay() { return boundOverlay; }, async snapshotFor() { return { ...review, rows: [row] }; } };
  const corrections = policyScope.corrections;
  if (corrections || gps.availability) {
    const { gpsAvailability: retainedAvailability, ...retainedCorrections } = corrections ?? {};
    const bundle = corrections ? { ...retainedCorrections, records: corrections.records.filter(record => record.recordKey === row.key) }
      : { version: 1, generation: view.generation, reportHash: view.reportHash, records: [] };
    const availability = gps.availability ?? retainedAvailability?.records?.[row.key];
    requireEvidence(!bundle.records.length || boundOverlay.entries.length,
      'Retained finding corrections have changed their evidence binding');
    service = connectPreviewCorrections(service, scopedView, {
      ...bundle, ...(availability ? { gpsAvailability: { version: 1, records: { [row.key]: availability } } } : {}),
    });
  }
  const decisions = policyScope.decisions;
  requireEvidence(!decisions || decisions.version === 1 && hex(decisions.reportHash)
    && Array.isArray(decisions.records) && new Set(decisions.records.map(value => value.recordKey)).size === decisions.records.length,
  'The original case decision identity differs');
  const timingReassessment = row.date >= '2026-10-19' ? reassessOrderTiming(row, {
    earliestDelivery: row.delivery.earliest_delivery_evidence, gps: gps.entry?.result, addressStop: gps.entry?.addressStop,
    household: households.get(row.key),
    acceptedDecision: decisions?.records.find(decision => decision.recordKey === row.key),
  }) : null;
  const [evidence, adjusted] = await Promise.all([service.evidenceOverlay({}), service.snapshotFor(review.snapshotHash)]);
  const corrected = applyOrderTiming(adjusted.rows[0], timingReassessment);
  const raw = evidence.entries.find(item => item.recordKey === row.key);
  const { gpsEvidence: _gps, ...evidenceFields } = raw ?? {};
  const entry = timingReassessment ? { ...(raw ? evidenceFields : { version: 'matter-evidence-overlay-entry-v1',
    generation: view.generation, recordKey: row.key, assessmentHash: row.assessmentHash, deliverySourceSha256: row.delivery.source_sha256 }),
  timingReassessment } : raw ? evidenceFields : null;
  return { overlay: entry, sharedHouseholdStop: savedHouseholdStop, reviewFindingIds: [...new Set([...(corrected.findings ?? []),
    ...(corrected.photoFindings ?? [])].map(finding => finding.issue_id))],
  ...(!equal(corrected.findings, row.findings) ? { findings: corrected.findings } : {}),
  ...(!equal(corrected.tier, row.tier) ? { tier: corrected.tier } : {}) };
}

async function loadRules(codeRoot, builderSha256) {
  requireEvidence(typeof codeRoot === 'string' && path.isAbsolute(codeRoot) && hex(builderSha256), 'A qualified case grader is required');
  await verifyAuditBuilder(codeRoot, builderSha256);
  const load = name => import(pathToFileURL(path.join(codeRoot, name)).href);
  const [release, gpsRelease, gps, addresses, build] = await Promise.all([
    load('integration/cloud/preview-release-data.mjs'), load('integration/private-gps/release-gps.mjs'),
    load('integration/private-gps/gps.mjs'), load('integration/private-gps/retained-addresses.mjs'),
    load('integration/cloud/automatic-release-build.mjs'),
  ]);
  const rules = { ...release, ...gpsRelease, ...gps, ...addresses, sourceStreamsForDelivery: build.sourceStreamsForDelivery };
  requireEvidence(['refreshPrivateEvidenceArrivals', 'indexPrivateReleaseSnapshot', 'projectPrivateChangedRows',
    'rebindPrivateReleaseOverlay', 'refreshReleaseGps', 'releaseAvailability', 'ingest', 'grade',
    'mergeRetainedGpsStreams', 'recoverRetainedAddresses', 'sourceStreamsForDelivery'].every(name => typeof rules[name] === 'function'),
  'The pinned delivery grading rules are incomplete');
  return rules;
}

export async function createDriverAuditDeliveryCaseProjector({ codeRoot, builderSha256, ...defaults } = {}) {
  const rules = await loadRules(codeRoot, builderSha256);
  return input => projectDriverAuditDeliveryCase({ ...defaults, ...input, rules });
}

// Project one selected case. All source and retained reads are exact case
// references; the full report builder and compatibility publisher are never run.
export async function projectDriverAuditDeliveryCase({ source, candidate, prior = null, archive,
  policyScope, gpsScope, codeRoot, builderSha256, rules } = {}) {
  const { key, day, detail, history, summary, inputs } = candidate ?? {};
  const publication = source?.publication, repository = source?.repository;
  const generation = publication?.head?.manifest?.sha256, sourceReportHash = publication?.head?.reportHash;
  requireEvidence(validDay(day) && typeof key === 'string' && key.startsWith(day + '/') && key.length <= 300
    && hex(candidate.sourceHash) && (candidate.gpsHash == null || hex(candidate.gpsHash))
    && hex(generation) && hex(sourceReportHash) && hex(publication?.catalog?.sha256)
    && typeof repository?.readFile === 'function' && typeof repository?.resolveFile === 'function'
    && Array.isArray(inputs?.gps) && typeof archive?.readObject === 'function' && typeof archive?.putVerifiedObject === 'function',
  'A verified selected delivery and archive are required');
  const selected = source.cases?.get(key);
  requireEvidence(selected && selected.sourceHash === candidate.sourceHash && selected.gpsHash === candidate.gpsHash && equal(selected.inputs, inputs)
    && equal(selected.detail, detail) && equal(selected.history, history), 'The selected delivery is outside its pinned source');
  rules ??= await loadRules(codeRoot, builderSha256);
  const [incoming, original] = await Promise.all([
    typeof source.readCase === 'function' ? source.readCase(key) : readDetail(repository, detail, key, day),
    originalCase(prior, archive, key, day),
  ]);
  checkRow(incoming, key, day);
  requireEvidence(summary?.key === key && summary.assessmentHash === incoming.assessmentHash
    && summary.delivery?.source_sha256 === incoming.delivery.source_sha256,
    'The scoped source summary differs from the exact assessment');
  const refreshDay = publication.head.source?.day;
  requireEvidence(validDay(refreshDay), 'The source service day is unavailable');
  const refresh = original ? rules.refreshPrivateEvidenceArrivals([original.row], [incoming], refreshDay) : null;
  requireEvidence(!refresh?.held?.length, 'The changed delivery would overwrite previously verified evidence');
  const row = refresh?.rows[0] ?? incoming;
  requireEvidence(original || day >= '2026-10-19', 'The delivery predates this report selection');
  const changed = Boolean(refresh?.versions.length);
  const kept = original && !changed;
  const review = kept ? original.entry.review : { deliveryReview: true, raw: false,
    snapshotHash: hash({ kind: 'dated-delivery-review-v1', key, assessmentHash: row.assessmentHash, delivery: row.delivery }) };
  requireEvidence(review.deliveryReview === true, 'The original delivery review identity is unavailable');
  const view = { generation: kept ? original.index.generation : generation, reportHash: review.snapshotHash };
  const photo = photoFor(row, original, view, inputs);
  const gps = await projectGps({ row, candidate, original, gpsScope, archive, rules });
  const savedPolicy = kept && gps.entry === original.entry.gps && !policyScope?.changedPeers?.length
    ? original.entry.policy : null;
  const policy = savedPolicy ?? await projectPolicy({ row, gps, view, original, source, policyScope, review, rules });

  const retained = new Map();
  const owningCatalogs = new Set();
  const add = (ref, owner = null) => {
    const id = ref.domain + '/' + ref.path;
    requireEvidence(!retained.has(id) || retained.get(id).sha256 === ref.sha256, 'Two saved case files disagree');
    retained.set(id, ref);
    owningCatalogs.add(owner);
  };
  let detailRef = kept ? original.entry.detail : detail;
  let staffRef = kept ? original.entry.history?.staff ?? null : history;
  const retainedSource = original?.entry.history?.source ?? null;
  const sourceRef = history ?? retainedSource;
  const sourceRepository = history && (!kept || history.sha256 !== retainedSource?.sha256)
    ? repository : original?.repository;
  const owningRepository = kept ? original.repository : repository;
  if (sourceRef) {
    await readRows(sourceRef, key, (file, limit) => readRetainedDriverAuditFile(sourceRepository, file, limit));
    add(await resolveRetained(sourceRepository, sourceAssetPath(sourceRef)), sourceRepository);
  }
  if (changed) {
    const read = (repo, ref) => readRows(ref, key, (file, limit) => readRetainedDriverAuditFile(repo, file, limit));
    const oldRows = await read(original.repository, original.entry.history?.staff);
    const oldSource = await read(original.repository, original.entry.history?.source);
    const newRows = await read(repository, history);
    const previousRows = new Map();
    for (const saved of [...oldRows, ...oldSource, ...newRows, original.row]) {
      requireEvidence(saved?.key === key && hex(saved.assessmentHash), 'An original assessment version differs');
      if (!previousRows.has(saved.assessmentHash)) previousRows.set(saved.assessmentHash, saved);
    }
    const currentBrowser = { matter: { validatedReporting: { fullQueryId: 'delivery', queryId: 'summary' },
      lazyDeliveryDetails: { cases: {} }, lazyQueries: { reporting_validated_history: { cases: {} } } }, queries: { summary: { rows: [] } } };
    const { browser, assets } = rules.projectPrivateChangedRows(currentBrowser, [row], { [key]: [...previousRows.values()] });
    detailRef = browser.matter.lazyDeliveryDetails.cases[key];
    staffRef = browser.matter.lazyQueries.reporting_validated_history.cases[key];
    for (const [kind, ref] of [['detail', detailRef], ['history', staffRef]]) {
      checkResource(ref, kind);
      const asset = assets.find(item => item.fileName === ref.url);
      requireEvidence(asset && sha(asset.source) === ref.sha256, 'A scoped assessment asset failed verification');
      const saved = kind === 'detail' ? detail : history;
      if (ref.sha256 === saved?.sha256) {
        if (kind === 'detail') add(await resolveRetained(repository, sourceAssetPath(ref)), repository);
      } else {
        add(await archiveBytes(archive, gzipSync(asset.source), { domain: 'state', path: sourceAssetPath(ref) }));
      }
    }
  } else {
    add(await resolveRetained(owningRepository, sourceAssetPath(detailRef)), owningRepository);
    if (staffRef && staffRef.sha256 !== sourceRef?.sha256) {
      await readRows(staffRef, key, (file, limit) => readRetainedDriverAuditFile(owningRepository, file, limit));
      add(await resolveRetained(owningRepository, sourceAssetPath(staffRef)), owningRepository);
    }
  }
  if (photo.sha256) {
    const photoOwnedByOriginal = photo.sha256 === original?.entry.photo?.sha256;
    const photoRepo = photoOwnedByOriginal ? original.repository : repository;
    const index = photoOwnedByOriginal ? original.index : { catalog: publication.catalog, generation, reportHash: sourceReportHash };
    add(await verifiedPhoto(photoRepo, archive, index, { photo }), photoRepo);
  }
  const canonical = rules.indexPrivateReleaseSnapshot({ ...review, rows: [row] });
  const issues = canonical.issues;
  requireEvidence(issues?.length === 1 && issues[0].deliveryId === key
    && (!original || original.entry.issues?.some(issue => issue.id === issues[0].id)),
  'The original staff review issue identity would change');
  const owner = owningCatalogs.size === 1 ? [...owningCatalogs][0] : null;
  const catalog = owner === repository ? publication.catalog : original && owner === original.repository
    ? original.index.catalog : await archiveCatalog(archive, [...retained.values()]);
  return structuredClone({ row: { key }, gpsRow: { key, date: day, assessmentHash: row.assessmentHash, delivery: row.delivery },
    reviewRow: { key, findings: policy.reviewFindingIds.map(issue_id => ({ issue_id })) },
    detail: detailRef, summary: buildSummary(row, policy.overlay?.timingReassessment?.state), gps: gps.entry, photo,
    history: { staff: staffRef, source: sourceRef, extra: sourceRef && sourceRef.sha256 !== staffRef?.sha256
      ? { source: sourceRef, staff: staffRef } : null },
    issues, policy, gpsFiles: gps.files, gpsAsOf: gps.asOf ?? null, gpsInputHash: candidate.gpsHash ?? original?.entry.gpsInputHash ?? null, catalog,
    generation: view.generation, reportHash: review.snapshotHash, review });
}
