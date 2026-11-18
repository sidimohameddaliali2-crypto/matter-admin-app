import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { archiveBytes, archiveCatalog, createCloudRepository } from '../vendor/driver-audits/integration/cloud/repository.mjs';
import { reviewMatches } from '../vendor/driver-audits/app/src/content/dashboard/reporting-review.mjs';
import { createDriverAuditLightEvidence } from './driverAuditLightEvidence.js';
import { createDriverAuditDeliveryCaseProjector, projectDriverAuditDeliveryCase,
  readDriverAuditDeliveryGpsScope } from './driverAuditDeliveryCaseProjection.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const day = '2026-11-18', key = day + '/selected-delivery', cutoff = day + 'T08:00:00.000Z';
const url = 'https://photos.example.invalid/private-delivery.webp';
const makeAsset = (kind, value) => {
  const source = JSON.stringify({ rows: value }), sha256 = sha(source);
  return { source, fileName: `report-data/${kind}-${sha256}.json`, ref: { sha256, count: value.length,
    url: `report-data/${kind}-${sha256}.json` } };
};

function fixtureArchive() {
  const objects = new Map(), reads = [], writes = [];
  const archive = {
    async putVerifiedObject(key, bytes) {
      const sha256 = sha(bytes);
      assert.equal(key, sha256 + '.gz');
      objects.set(key, Buffer.from(bytes));
      writes.push(key);
      return { key, sha256, verified: true };
    },
    async readObject(key, { maxBytes }) {
      assert.ok(objects.get(key)?.length <= maxBytes, 'Only known bounded immutable objects may be requested');
      reads.push(key);
      return [objects.get(key)];
    },
  };
  return { archive, objects, reads, writes };
}

function delivery(version, withPhoto = false) {
  return { date: day, key, assessmentHash: sha('assessment' + version), version,
    delivery: { delivery_id: key.slice(11), driver: 'Saved driver', driver_id: 'driver-a', vehicle: null,
      customer: 'Saved recipient', app_status: 'delivered', timing_label: 'In window', window_start: day + 'T02:00:00Z',
      deadline: day + 'T07:00:00Z', upload: withPhoto ? day + 'T06:00:00Z' : null,
      raw_upload: withPhoto ? day + 'T06:00:00Z' : null,
      photo_url: withPhoto ? url : null, source_sha256: sha('source row ' + version) },
    tier: 0, findings: [{ issue_id: 'finding-' + version }], originalFindings: [], legacyReferences: [], photoFindings: [],
    photo: { reviewStatus: 'unreviewed', grade: null }, gps: { limitations: [], measurements: {} } };
}

async function saved(archive, row, { previous = [], object = null, windows = [] } = {}) {
  const detail = makeAsset('detail', [row]);
  const history = previous.length ? makeAsset('history', previous) : null;
  const manifests = [];
  for (const asset of [detail, history].filter(Boolean)) {
    manifests.push(await archiveBytes(archive, gzipSync(asset.source), { domain: 'state', path: 'assets/' + asset.fileName.slice(12) + '.gz' }));
  }
  if (object) manifests.push(await archiveBytes(archive, object, { domain: 'objects', path: sha(object) }));
  for (const file of windows) manifests.push(await archiveBytes(archive, file.body, { domain: 'gps', path: file.path }));
  const catalog = await archiveCatalog(archive, manifests);
  const reportHash = sha('source report ' + row.version), generation = sha('source browser ' + row.version);
  const publication = { version: 1, catalog, head: { reportHash, source: { day },
    manifest: { sha256: generation, url: 'report-data/snapshot-' + generation + '.json' } } };
  const body = JSON.stringify(publication);
  const repository = await createCloudRepository({ transport: archive, stateStore: { read: async () => ({ body, revision: 1 }) } }).pin();
  const candidate = { day, key, sourceHash: sha('inputs ' + row.version), summary: row, detail: detail.ref,
    history: history?.ref ?? null, inputs: { gps: [], photoRepair: null, photoCapture: null } };
  return { source: { publication, repository, cases: new Map([[key, candidate]]) }, candidate };
}

function qualification() {
  const calls = [];
  function gpsResult(row) {
    return { result: { gps: { streams: [] }, binding: { assessmentHash: row.assessmentHash,
      deliveryDigest: sha(JSON.stringify(row.delivery)) }, vehicle: null, sampledStops: [] },
    context: { vehicle: null, vehicleAlternatives: [], pin: null }, related: [], addressStop: null };
  }
  const rules = {
    refreshPrivateEvidenceArrivals(prior, next) {
      calls.push([prior.map(row => row.key), next.map(row => row.key)]);
      const changed = prior[0].assessmentHash !== next[0].assessmentHash;
      return { rows: changed ? next : prior, versions: changed ? [{ prior: prior[0] }] : [], held: [] };
    },
    indexPrivateReleaseSnapshot(value) { return { ...value, issues: value.rows.map(row => ({ id: 'delivery-review:' + row.key,
      deliveryId: row.key, evidence: { source_sha256: row.assessmentHash, rule_version: row.version } })) }; },
    projectPrivateChangedRows(_browser, rows, history) {
      assert.deepEqual(rows.map(row => row.key), [key]);
      const detail = makeAsset('detail', rows), versions = makeAsset('history', history[key]);
      return { browser: { matter: { lazyDeliveryDetails: { cases: { [key]: detail.ref } },
        lazyQueries: { reporting_validated_history: { cases: { [key]: versions.ref } } } } }, assets: [detail, versions] };
    },
    ingest({ windows }) { return { streams: [], qualityObservations: windows.map(item => item.snapshotSha256) }; },
    mergeRetainedGpsStreams(prior, incoming) { return [...prior, ...incoming]; },
    refreshReleaseGps({ rows, baselineIndex, windows }) {
      assert.deepEqual(rows.map(row => row.key), [key]);
      calls.push(['gps', windows.length]);
      const entry = gpsResult(rows[0]);
      return { index: { records: { ...baselineIndex.records, [key]: entry } } };
    },
    sourceStreamsForDelivery() { return []; },
    releaseAvailability() { return null; },
    recoverRetainedAddresses(_rows, index) { return { index }; },
    rebindPrivateReleaseOverlay(overlay) { return overlay; },
  };
  return { rules, calls };
}
const scope = { gpsScope: { complete: true, asOf: cutoff, windows: [], peers: [] },
  policyScope: { householdArrangements: [], peers: [] } };

const codeRoot = process.env.DRIVER_AUDIT_FIXTURE_BUILDER_ROOT;
const builderSha256 = process.env.DRIVER_AUDIT_FIXTURE_BUILDER_SHA256;
test('the pinned private grader verifies a new delivery and the same delivery with late evidence',
  { skip: codeRoot === undefined && builderSha256 === undefined }, async () => {
    const { archive } = fixtureArchive();
    const project = await createDriverAuditDeliveryCaseProjector({ codeRoot, builderSha256 });
    const first = delivery('pinned-first');
    first.findings = [];
    const previous = await project({ ...await saved(archive, first), ...scope, archive });
    const photo = Buffer.from([255, 216, 255, 4, 5, 255, 217]);
    const late = delivery('pinned-noon', true);
    late.findings = [];
    late.delivery.photo_sha256 = sha(photo);
    const current = await project({ ...await saved(archive, late, { previous: [first], object: photo }),
      ...scope, archive, prior: { entry: previous } });
    const evidence = createDriverAuditLightEvidence({ archive });
    assert.equal(previous.photo.sha256, null);
    assert.deepEqual((await evidence.photo(current, current)).body, photo);
    assert.equal((await evidence.gps(current, current, { role: 'owner' })).assessmentHash, current.gpsRow.assessmentHash);
    assert.equal(current.issues[0].id, previous.issues[0].id);
    assert.deepEqual((await evidence.history(current, current)).staff.map(row => row.key), [first.key]);
  });

test('one new case reads its own saved assessment and remains available through the original evidence reader', async () => {
  const { archive, writes } = fixtureArchive(), { rules, calls } = qualification();
  const row = delivery('new');
  const selected = await saved(archive, row);
  const begin = writes.length;
  const entry = await projectDriverAuditDeliveryCase({ ...selected, ...scope, archive, rules });
  assert.deepEqual(calls, [['gps', 0]], 'Only one dated delivery was graded for GPS');
  assert.ok(writes.length - begin < 5, 'Only the one GPS projection and compact case catalogue are staged');
  assert.deepEqual(await createDriverAuditLightEvidence({ archive }).detail(entry, entry), { rows: [row] });
  assert.equal(entry.review.snapshotHash, entry.reportHash);
  assert.deepEqual(entry.issues.map(item => item.id), ['delivery-review:' + key]);
  const gps = await createDriverAuditLightEvidence({ archive }).gps(entry, entry, { role: 'owner' });
  assert.equal(gps.assessmentHash, row.assessmentHash);
  assert.equal(gps.gpsEvidence.recordKey, key);
  assert.equal(gps.gpsEvidence.asOf, cutoff);
});

test('neighboring delivery context does not cause neighboring timing assessments to rebuild', async () => {
  const { archive } = fixtureArchive(), { rules } = qualification();
  const peer = { key: `${day}/neighbor`, date: day, delivery: {
    get earliest_delivery_evidence() { throw Error('neighbor timing was recalculated'); },
  } };
  const selected = await saved(archive, delivery('new with neighbor'));
  const entry = await projectDriverAuditDeliveryCase({ ...selected, ...scope, archive, rules,
    policyScope: { ...scope.policyScope, peers: [{ row: peer, gps: null }] } });
  assert.equal(entry.summary.key, key);
  assert.equal(entry.policy.overlay.recordKey, key);
});

test('a changed neighboring delivery that affects a verified household holds both saved cases', async () => {
  const { archive } = fixtureArchive(), { rules } = qualification();
  const target = delivery('target participant');
  target.delivery.upload = `${day}T06:00:00Z`;
  const peer = { ...target, key: `${day}/neighbor`, assessmentHash: sha('neighbor version'),
    delivery: { ...target.delivery, delivery_id: 'neighbor', source_sha256: sha('neighbor version source') } };
  const earlierPeer = { ...peer, delivery: { ...peer.delivery, driver_id: 'different driver' } };
  rules.recoverRetainedAddresses = (rows, index) => ({ index: { records: Object.fromEntries(rows.map(row => [row.key,
    { ...index.records[row.key], addressStop: { recordKey: row.key, assessmentHash: row.assessmentHash,
      deliverySourceSha256: row.delivery.source_sha256, state: 'apartment_identified',
      customerId: row.key === key ? 'account-a' : 'account-b', identity: { unitKey: 'building-unit' } } }])) } });
  const policyScope = { complete: true, peers: [{ row: earlierPeer, gps: {} }], changedPeers: [{ row: peer, gps: {} }],
    householdArrangements: [{ id: 'approved-house', customerIds: ['account-a', 'account-b'], unitKey: 'building-unit',
      effectiveFrom: day, effectiveTo: null, acceptPartnerReceipt: true, maxUploadGapSeconds: 600, sourceRef: 'operator-reference',
      sourceSha256: sha('signed decision'), acceptedBy: 'Owner', acceptedAt: cutoff }] };
  const selected = await saved(archive, target);
  await assert.rejects(projectDriverAuditDeliveryCase({ ...selected, ...scope, archive, rules, policyScope }),
    { code: 'DRIVER_AUDIT_CASE_HELD', message: 'Changed neighboring deliveries require joint household evidence qualification' });
});

test('shared-image corrections stay tied to their explicit related delivery photo digests', async () => {
  const { archive } = fixtureArchive(), { rules } = qualification();
  const row = delivery('shared image', true), photo = Buffer.from([255, 216, 255, 4, 255, 217]);
  row.delivery.photo_sha256 = sha(photo);
  const selected = await saved(archive, row, { object: photo });
  const peer = '2026-11-17/related-image', generation = selected.source.publication.head.manifest.sha256;
  const event = { recordKey: key, eventId: sha('saved correction'), kind: 'photo_detail_supplement', imageSha256: sha(photo),
    observationRef: { sha256: sha('photo observation') }, relatedRecordKeys: [key, peer],
    sourceBinding: { assessmentHash: row.assessmentHash, sourceSha256: row.delivery.source_sha256 },
    findings: [{ category: 'photo_image_reused', observed: 'same image', recorded: 'different records', basis: 'verified original photo' }] };
  const overlay = [{ version: 'matter-evidence-overlay-entry-v1', generation, recordKey: key,
    assessmentHash: row.assessmentHash, deliverySourceSha256: row.delivery.source_sha256 }];
  const corrections = { version: 1, generation, reportHash: selected.source.publication.head.reportHash,
    records: [{ recordKey: key, reportedIncidents: [], photoSupplements: [event] }] };
  const policyScope = { ...scope.policyScope, overlay, corrections, relatedPhotos: [[peer, sha(photo)]] };
  const entry = await projectDriverAuditDeliveryCase({ ...selected, ...scope, archive, rules, policyScope });
  assert.deepEqual(entry.policy.overlay.corrections[0].relatedRecordKeys, [key, peer]);
  await assert.rejects(projectDriverAuditDeliveryCase({ ...selected, ...scope, archive, rules,
    policyScope: { ...policyScope, relatedPhotos: [[peer, sha('different image')]] } }), /Unverified shared image group/);
});

test('a late scoped photo keeps the previous assessment and immutable review issue visible', async () => {
  const { archive } = fixtureArchive(), { rules, calls } = qualification();
  const first = delivery('first');
  const original = await projectDriverAuditDeliveryCase({ ...await saved(archive, first), ...scope, archive, rules });
  const photo = Buffer.from([255, 216, 255, 4, 5, 255, 217]), second = delivery('late', true);
  const selected = await saved(archive, second, { previous: [first], object: photo });
  const binding = { recordKey: key, imageSha256: sha(photo), urlSha256: sha(url), proofTimestamp: second.delivery.raw_upload };
  selected.candidate.inputs.photoRepair = { ...binding, date: day, sourceRowSha256: second.delivery.source_sha256,
    assessmentHash: second.assessmentHash, sources: [{ ...binding, receiptSha256: sha('receipt'), captureSha256: sha('capture'), observedAt: cutoff }] };
  const entry = await projectDriverAuditDeliveryCase({ ...selected, ...scope, archive, rules, prior: { entry: original } });
  assert.deepEqual(calls, [['gps', 0], [[key], [key]], ['gps', 0]]);
  assert.equal(entry.issues[0].id, original.issues[0].id);
  assert.notEqual(entry.review.snapshotHash, original.review.snapshotHash);
  assert.equal(reviewMatches({ data: { issueId: original.issues[0].id,
    snapshotHash: original.reportHash, reviewScope: 'delivery-review-v1' } }, entry.issues[0], entry.review), true);
  const evidence = createDriverAuditLightEvidence({ archive });
  assert.deepEqual((await evidence.history(entry, entry)).staff, [first]);
  assert.deepEqual((await evidence.history(original, original)).staff, []);
  assert.deepEqual((await evidence.photo(entry, entry)).body, photo);
  assert.equal(entry.photo.sourceUrl, url);
  assert.equal(entry.photo.originalSha256, null);
  assert.equal((await evidence.detail(entry, entry)).rows[0].photo.grade, null);
});

test('a scoped check keeps its prior review snapshot and refuses to guess missing original photo or GPS evidence', async () => {
  const { archive, writes } = fixtureArchive(), { rules } = qualification();
  const unchanged = await saved(archive, delivery('untouched'), { previous: [delivery('unchanged old history')] });
  const prior = await projectDriverAuditDeliveryCase({ ...unchanged, ...scope, archive, rules });
  const before = writes.length;
  const entry = await projectDriverAuditDeliveryCase({ ...unchanged, policyScope: scope.policyScope,
    archive, rules, prior: { entry: prior } });
  assert.deepEqual(entry.review, prior.review);
  assert.deepEqual(entry.issues, prior.issues);
  assert.deepEqual(entry.gpsFiles, prior.gpsFiles);
  assert.deepEqual(entry.catalog, prior.catalog);
  assert.equal(writes.length, before);
  await assert.rejects(projectDriverAuditDeliveryCase({ ...unchanged, archive, rules, policyScope: scope.policyScope }),
    { code: 'DRIVER_AUDIT_CASE_HELD', message: 'Verified dated GPS coverage and neighboring cases are required for this delivery' });
  const unverified = await saved(archive, delivery('no retained image', true));
  await assert.rejects(projectDriverAuditDeliveryCase({ ...unverified, ...scope, archive, rules }),
    { code: 'DRIVER_AUDIT_CASE_HELD', message: 'The referenced photo has no verified original bytes' });
});

test('a new source assessment history stays visible even when the current case has not changed', async () => {
  const { archive } = fixtureArchive(), { rules } = qualification();
  const row = delivery('current'), first = delivery('previous'), added = delivery('additional source version');
  const initial = await saved(archive, row, { previous: [first] });
  const before = await projectDriverAuditDeliveryCase({ ...initial, ...scope, archive, rules });
  const savedHistory = await saved(archive, row, { previous: [first, added] });
  savedHistory.candidate.sourceHash = sha('changed history');
  const entry = await projectDriverAuditDeliveryCase({ ...savedHistory, policyScope: scope.policyScope,
    archive, rules, prior: { entry: before } });
  assert.deepEqual(entry.gpsRow, before.gpsRow);
  assert.deepEqual(entry.review, before.review);
  assert.deepEqual(entry.history.staff, before.history.staff);
  assert.equal(entry.history.source.sha256, savedHistory.candidate.history.sha256);
  const evidence = createDriverAuditLightEvidence({ archive });
  assert.deepEqual(await evidence.history(entry, entry), { staff: [first], additionalSource: [added] });
  assert.deepEqual(await evidence.history(before, before), { staff: [first], additionalSource: [] });
});

test('a late GPS window opens only its pinned source files and rejects a different receipt or cutoff', async () => {
  const { archive, reads } = fixtureArchive();
  const driverId = 'driver-a', namespace = 'driver-windows', scopeKind = 'driver';
  const point = { gpsTime: day + 'T04:30:00Z', recordedAt: day + 'T05:30:00Z' };
  const snapshot = { driverId, day, scopeKind, pages: [{ data: [point] }] };
  const bytes = Buffer.from(JSON.stringify(snapshot)), snapshotSha256 = sha(bytes);
  const receipt = { day, scopeKind, driverId, fetchedAt: cutoff, snapshotSha256 };
  const observation = Buffer.from(JSON.stringify(receipt)), observationSha256 = sha(observation);
  const selected = await saved(archive, delivery('with-GPS'), { windows: [
    { body: gzipSync(bytes), path: `${namespace}/snapshots/${snapshotSha256}.json.gz` },
    { body: observation, path: `${namespace}/observations/${observationSha256}.json` },
  ] });
  selected.candidate.inputs.gps = [{ namespace, scopeKind, day, driverId, snapshotSha256, observationSha256, fetchedAt: cutoff }];
  const priorReads = reads.length;
  const gpsScope = await readDriverAuditDeliveryGpsScope({ ...selected, complete: true, asOf: cutoff });
  assert.deepEqual(gpsScope.windows[0].points, [point]);
  assert.ok(reads.length - priorReads <= 6);
  const afterFirstRead = reads.length;
  await readDriverAuditDeliveryGpsScope({ ...selected, complete: true, asOf: cutoff });
  assert.equal(reads.length, afterFirstRead, 'The next delivery sharing the exact window reuses its verified bytes');
  const { rules, calls } = qualification();
  const entry = await projectDriverAuditDeliveryCase({ ...selected, ...scope, gpsScope, archive, rules });
  assert.deepEqual(calls, [['gps', 1]]);
  assert.equal(entry.gpsAsOf, cutoff);
  await assert.rejects(readDriverAuditDeliveryGpsScope({ ...selected, complete: true, asOf: day + 'T07:00:00Z' }),
    { code: 'DRIVER_AUDIT_CASE_HELD' });
});

test('new GPS receipt evidence is published even if the undetermined result stays the same', async () => {
  const { archive, writes } = fixtureArchive(), { rules } = qualification();
  const refresh = rules.refreshReleaseGps;
  rules.refreshReleaseGps = input => input.baselineIndex.records[key] ? { index: input.baselineIndex } : refresh(input);
  const selected = await saved(archive, delivery('undetermined'));
  const first = await projectDriverAuditDeliveryCase({ ...selected, ...scope, archive, rules });
  const snapshotSha256 = sha('late archive window');
  const lateWindow = { day, scopeKind: 'driver', driverId: 'driver-a', snapshotSha256, points: [] };
  selected.candidate.inputs.gps = [lateWindow];
  selected.candidate.gpsHash = sha('late GPS scope');
  const asOf = `${day}T09:00:00.000Z`;
  const gpsScope = { ...scope.gpsScope, asOf, windows: [lateWindow] };
  const late = await projectDriverAuditDeliveryCase({ ...selected, ...scope, gpsScope, archive, rules, prior: { entry: first } });
  assert.deepEqual(late.gps.result, first.gps.result);
  assert.deepEqual(late.review, first.review);
  assert.notEqual(late.gps.evidenceFile, first.gps.evidenceFile);
  assert.equal(late.gpsAsOf, asOf);
  const before = writes.length;
  const repeat = await projectDriverAuditDeliveryCase({ ...selected, ...scope,
    gpsScope: { ...gpsScope, asOf: `${day}T10:00:00.000Z` }, archive, rules, prior: { entry: late } });
  assert.deepEqual(repeat, late);
  assert.equal(writes.length, before);
});
