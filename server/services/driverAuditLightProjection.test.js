import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

const implementation = await import('./driverAuditLightProjection.js').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const sha = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const file = name => ({ version: 1, domain: 'previewRuntime', path: name, kind: 'immutable-evidence',
  size: 1, sha256: sha(name), chunks: [{ offset: 0, size: 1, sha256: sha(name) }] });
const asset = (kind, name, count) => ({ url: `report-data/${kind}-${sha(name)}.json`, sha256: sha(name),
  ...(count === undefined ? {} : { count }) });

function fixture() {
  const generation = sha('browser'), reportHash = sha('report'), sourceHash = sha('original source');
  const keys = ['2026-11-14/saturday', '2026-11-15/sunday', '2026-11-18/current'];
  const rows = keys.map((key, n) => ({ key, date: key.slice(0, 10), assessmentHash: sha('assessment' + n),
    delivery: { driver: ' Saved driver ', driver_id: n === 2 ? 23 : 'driver-a', customer: ' Saved customer ',
      app_status: 'delivered', timing_label: 'Recorded outcome', window_start: '2026-11-18T07:00:00+04:00',
      upload: null, raw_upload: '2026-11-18T07:05:00.000001+04:00', source_sha256: sha('delivery' + n) },
    findings: [{ issue_id: 'finding-' + n }], unknownOriginalField: { retained: n } }));
  const gpsRows = rows.map(row => ({ key: row.key, date: row.date, assessmentHash: row.assessmentHash,
    delivery: { ...row.delivery, originalOnlyField: 'retained' } }));
  const details = Object.fromEntries(rows.map(row => [row.key, asset('detail', row.key)]));
  const staff = Object.fromEntries(rows.slice(0, 2).map(row => [row.key, asset('history', 'staff' + row.key, 2)]));
  const source = { ...staff, [keys[0]]: asset('history', 'original saturday', 3),
    [keys[2]]: asset('history', 'original current', 1) };
  const evidenceFile = 'gps-evidence-' + sha('projection') + '.private.json.gz';
  const streamFile = 'gps-' + sha('stream') + '.private.json.gz';
  const gps = { version: 1, asOf: '2026-11-18T07:11:16.652Z',
    records: Object.fromEntries(rows.map(row => [row.key, { evidenceFile, evidenceSummary: { recordKey: row.key },
      result: { binding: { assessmentHash: row.assessmentHash }, gps: { streams: ['2026-11-18|vehicle'] } } }])),
    streamFiles: { '2026-11-18|vehicle': streamFile, '2026-11-17|vehicle': streamFile } };
  const descriptor = { version: 1, generation, reportHash, sourceManifestSha256: sha('source manifest'),
    files: Object.fromEntries([evidenceFile, streamFile].map(name => [name, file(name)])) };
  const publication = { version: 1, head: { manifest: { url: 'report-data/snapshot-' + generation + '.json', sha256: generation },
    reportHash, records: 3, source: { observedAt: '2026-11-18T07:11:16.652Z' } },
    catalog: { version: 1, sha256: sha('catalog'), size: 0, chunks: [] },
    privateRelease: { currentHead: { history: 6, manifest: { url: 'report-data/snapshot-' + sourceHash + '.json', sha256: sourceHash } } } };
  const view = { version: 1, generation, reportHash, catalogHash: publication.catalog.sha256,
    browser: publication.head.manifest, gpsRows, photos: rows.map((row, n) => [row.key, n === 2 ? null : sha('image')]),
    overlay: { entries: [], status: 'ready' }, status: { records: 3, history: 4 } };
  const browser = { matter: { validatedReporting: { snapshotHash: reportHash, queryId: 'reporting_validated_deliveries_summary' },
    lazyDeliveryDetails: { cases: details }, lazyQueries: { reporting_validated_history: { count: 4, cases: staff } } },
    queries: { reporting_validated_deliveries_summary: { rows } } };
  const reviewSnapshot = { kind: 'matter-validated-report-v1', deliveryReview: true, version: 'original', snapshotHash: reportHash,
    rows: rows.map(row => ({ ...row, photoFindings: [{ issue_id: 'photo-' + row.key }] })),
    issues: rows.map((row, n) => ({ id: 'original-case-' + n, deliveryId: row.key,
      evidence: { source_sha256: row.delivery.source_sha256, rule_version: 'original-rule' } })),
    history: [{ original: true }], changes: [] };
  return { publication, view, gps, browser, descriptor, reviewSnapshot, sourceHistoryCases: source,
    corrections: { version: 1, records: [{ relatedRecordKeys: [keys[0], keys[1]] }] },
    decisions: { version: 1, records: [{ recordKey: keys[0], sourceRef: 'original decision' }] } };
}
function build(input) {
  assert.equal(typeof implementation.buildDriverAuditLightProjection, 'function', 'The exact offline projection is implemented');
  return implementation.buildDriverAuditLightProjection(input);
}

test('all published dates retain exact rows, GPS bindings, detail refs and canonical review identities', () => {
  const f = fixture(), before = clone(f), { days, context } = build(f);
  assert.deepEqual([...days.keys()], ['2026-11-14', '2026-11-15', '2026-11-18']);
  const entry = days.get('2026-11-18')[0], row = f.browser.queries.reporting_validated_deliveries_summary.rows[2];
  assert.deepEqual(entry.row, row); assert.deepEqual(entry.gpsRow, f.view.gpsRows[2]);
  assert.deepEqual(entry.reviewRow, f.reviewSnapshot.rows[2]); assert.deepEqual(entry.issues, [f.reviewSnapshot.issues[2]]);
  assert.deepEqual(entry.detail, f.browser.matter.lazyDeliveryDetails.cases[row.key]);
  assert.deepEqual(entry.summary, { key: row.key, driverId: '23', driverName: ' Saved driver ', customer: ' Saved customer ',
    status: 'delivered', outcome: 'Recorded outcome', scheduledAt: '2026-11-18T07:00:00+04:00',
    uploadedAt: '2026-11-18T07:05:00.000001+04:00' });
  assert.equal(context.records, 3); assert.equal(context.reviewResolved, true);
  assert.equal(context.sourceHistoryResolved, true); assert.equal(context.history.sourceRows, 6);
  assert.deepEqual(context.refs.catalog, f.publication.catalog);
  assert.equal(context.refs.reviewSnapshot.path, 'review-snapshots/' + f.view.reportHash + '.json.gz');
  assert.deepEqual(f, before, 'Projection does not modify supplied originals');
});

test('absent names, clocks and outcomes stay null rather than becoming invented defaults', () => {
  const f = fixture(); delete f.view.gpsRows[2].delivery;
  const entry = build(f).days.get('2026-11-18')[0];
  assert.deepEqual(entry.summary, { key: entry.row.key, driverId: null, driverName: null, customer: null,
    status: null, outcome: null, scheduledAt: null, uploadedAt: null });
});

test('history retains both exact ref sets and makes extra versions a comparison, never a fabricated body', () => {
  const f = fixture(), { days, context } = build(f), saturday = days.get('2026-11-14')[0];
  assert.deepEqual(saturday.history.staff, f.browser.matter.lazyQueries.reporting_validated_history.cases[saturday.row.key]);
  assert.deepEqual(saturday.history.source, f.sourceHistoryCases[saturday.row.key]);
  assert.deepEqual(saturday.history.extra, { source: saturday.history.source, staff: saturday.history.staff });
  assert.equal(days.get('2026-11-15')[0].history.extra, null);
  assert.equal(context.history.staffRows, 4); assert.equal(context.history.staffCases, 2);
});

test('unresolved original history and review inputs remain explicit rather than producing false empty data', () => {
  const f = fixture(); delete f.sourceHistoryCases; delete f.reviewSnapshot;
  const { days, context } = build(f);
  assert.equal(context.sourceHistoryExpected, true); assert.equal(context.sourceHistoryResolved, false);
  assert.equal(context.reviewResolved, false); assert.equal(context.history.sourceRows, null);
  assert.equal(days.get('2026-11-18')[0].issues, null);
  assert.ok(context.unresolved.includes('source-history-cases')); assert.ok(context.unresolved.includes('review-snapshot'));
});

test('GPS files retain exact descriptor refs and evidence-only dates are separate from result days', () => {
  const f = fixture(), { context, days } = build(f);
  const [name, ref] = Object.entries(f.descriptor.files).find(([name]) => name.startsWith('gps-evidence-'));
  assert.deepEqual(context.gpsEvidenceRefs[name], ref);
  assert.equal(context.gpsStreamRefs['2026-11-18|vehicle'].ref.sha256, f.descriptor.files[f.gps.streamFiles['2026-11-18|vehicle']].sha256);
  assert.deepEqual(context.evidenceOnlyDates, [{ day: '2026-11-17', kinds: ['gps-stream'] }]);
  assert.equal(days.has('2026-11-17'), false);
});

test('cross-date corrections and saved decisions are retained independently of page membership', () => {
  const f = fixture(), { context } = build(f);
  assert.deepEqual(context.corrections, f.corrections); assert.deepEqual(context.decisions, f.decisions);
  assert.equal(context.publishedDates.length, 3);
});

test('duplicate or missing row identities and changed assessment bindings fail closed', () => {
  for (const mutate of [
    f => f.browser.queries.reporting_validated_deliveries_summary.rows.push(clone(f.browser.queries.reporting_validated_deliveries_summary.rows[0])),
    f => f.view.gpsRows.pop(), f => { f.view.gpsRows[0].assessmentHash = sha('foreign'); },
    f => { f.browser.queries.reporting_validated_deliveries_summary.rows[0].date = '2026-02-30'; },
  ]) { const f = fixture(); mutate(f); assert.throws(() => build(f)); }
});

test('generation, report, catalog and original descriptor substitutions are rejected', () => {
  for (const mutate of [
    f => { f.view.generation = sha('foreign'); }, f => { f.browser.matter.validatedReporting.snapshotHash = sha('foreign'); },
    f => { f.view.catalogHash = sha('foreign'); }, f => { f.descriptor.reportHash = sha('foreign'); },
  ]) { const f = fixture(); mutate(f); assert.throws(() => build(f)); }
});

test('missing deferred GPS files, malformed ranges and foreign immutable detail refs are rejected', () => {
  for (const mutate of [
    f => { delete f.descriptor.files[Object.keys(f.descriptor.files)[0]]; },
    f => { Object.values(f.descriptor.files)[0].chunks[0].offset = 1; },
    f => { Object.values(f.browser.matter.lazyDeliveryDetails.cases)[0].url = 'https://foreign.invalid/detail.json'; },
  ]) { const f = fixture(); mutate(f); assert.throws(() => build(f)); }
});

test('review snapshots cannot substitute another generation, omit cases or attach a foreign issue', () => {
  for (const mutate of [
    f => { f.reviewSnapshot.snapshotHash = sha('foreign'); }, f => { f.reviewSnapshot.issues.pop(); },
    f => { f.reviewSnapshot.rows[0].assessmentHash = sha('foreign'); },
    f => { f.reviewSnapshot.issues[0].deliveryId = '2026-11-18/foreign'; },
  ]) { const f = fixture(); mutate(f); assert.throws(() => build(f)); }
});

test('source history count mismatches and duplicate photo binding keys are not silently dropped', () => {
  for (const mutate of [
    f => { Object.values(f.sourceHistoryCases)[0].count = -1; },
    f => { f.view.photos.push(clone(f.view.photos[0])); },
    f => { delete f.browser.matter.lazyDeliveryDetails.cases[f.view.gpsRows[0].key]; },
  ]) { const f = fixture(); mutate(f); assert.throws(() => build(f)); }
});

test('returned refs and rows do not change when the caller later mutates its inputs', () => {
  const f = fixture(), p = build(f), expected = clone(p);
  f.view.gpsRows[0].delivery.driver = 'independent change'; f.reviewSnapshot.issues[0].id = 'foreign';
  Object.values(f.descriptor.files)[0].sha256 = sha('changed');
  assert.deepEqual(p, expected);
});

test('original source history outside the published case list is retained as evidence, never as fabricated results', () => {
  const f = fixture(); f.sourceHistoryCases['2026-11-13/source-only'] = asset('history', 'retained original only', 2);
  f.publication.privateRelease.currentHead.history = 8;
  const { days, context } = build(f);
  assert.equal(days.has('2026-11-13'), false);
  assert.deepEqual(context.extraSourceHistoryCases, { '2026-11-13/source-only': f.sourceHistoryCases['2026-11-13/source-only'] });
  assert.ok(context.evidenceOnlyDates.some(x => x.day === '2026-11-13' && x.kinds.includes('source-history')));
  assert.equal(context.history.sourceRows, 8);
});

test('the verified streaming history Map is not mistaken for a resolved empty object', () => {
  const f = fixture(); f.sourceHistoryCases = new Map(Object.entries(f.sourceHistoryCases));
  const { context } = build(f);
  assert.equal(context.history.sourceRows, 6); assert.equal(context.history.sourceCases, 3);
});

test('an omitted original history case cannot pass the original source head count', () => {
  const f = fixture(); delete f.sourceHistoryCases['2026-11-18/current'];
  assert.throws(() => build(f), /history count/);
});

test('staff history-only references retain their role separately from original source versions', () => {
  const f = fixture(), key = '2026-11-13/source-only';
  f.browser.matter.lazyQueries.reporting_validated_history.cases[key] = asset('history', 'staff outside current results', 2);
  f.browser.matter.lazyQueries.reporting_validated_history.count = 6;
  const { context } = build(f);
  assert.deepEqual(context.extraStaffHistoryCases, { [key]: f.browser.matter.lazyQueries.reporting_validated_history.cases[key] });
  assert.equal(context.history.staffRows, 6);
});
