import { previewPhotoBindings } from '../vendor/driver-audits/integration/cloud/preview-photo-bindings.mjs';

const check = (value, message) => { if (!value) throw Error(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00Z'))
  && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const recordDay = key => typeof key === 'string' && key.length <= 300 && !/[\x00-\x1f\x7f]/.test(key)
  && key[10] === '/' && key.length > 11 && day(key.slice(0, 10)) ? key.slice(0, 10) : null;
const stringOrNull = value => typeof value === 'string' ? value : null;
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));

function runtimeRef(ref, name) {
  check(exactKeys(ref, ['version', 'domain', 'path', 'kind', 'size', 'sha256', 'chunks'])
    && ref.version === 1 && ref.domain === 'previewRuntime' && ref.path === name
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/.test(name) && !['.', '..'].includes(name)
    && ref.kind === 'immutable-evidence' && digest(ref.sha256)
    && Number.isSafeInteger(ref.size) && ref.size >= 0 && ref.size <= 128 * 1024 ** 2
    && Array.isArray(ref.chunks), 'Invalid light report runtime reference');
  let offset = 0;
  for (const part of ref.chunks) {
    check(exactKeys(part, ['offset', 'size', 'sha256']) && part.offset === offset
      && Number.isSafeInteger(part.size) && part.size > 0 && part.size <= 8 * 1024 ** 2
      && digest(part.sha256), 'Invalid light report runtime chunk');
    offset += part.size;
    check(offset <= ref.size, 'Light report runtime chunk exceeds its file');
  }
  check(offset === ref.size, 'Incomplete light report runtime reference');
  return ref;
}

function resourceRef(ref, kind) {
  check(object(ref) && digest(ref.sha256) && ref.url === 'report-data/' + kind + '-' + ref.sha256 + '.json'
    && (ref.count === undefined || Number.isSafeInteger(ref.count) && ref.count >= 0),
  'Invalid original light report resource reference');
  return ref;
}

function caseRefs(value, kind) {
  check(object(value), 'Original light report case references are unavailable');
  for (const [key, ref] of Object.entries(value)) {
    check(recordDay(key), 'Invalid original light report case identity');
    resourceRef(ref, kind);
  }
  return value;
}

function historyCount(cases) {
  let total = 0;
  for (const ref of Object.values(cases)) {
    check(Number.isSafeInteger(ref.count) && ref.count >= 0, 'Original history count is unavailable');
    total += ref.count;
    check(Number.isSafeInteger(total), 'Original history count exceeds its bound');
  }
  return total;
}

function rowsByKey(rows, label) {
  check(Array.isArray(rows) && rows.length <= 100000, label + ' rows are unavailable');
  const result = new Map();
  for (const row of rows) {
    check(object(row) && recordDay(row.key) === row.date && digest(row.assessmentHash)
      && !result.has(row.key), label + ' row identity is invalid or ambiguous');
    result.set(row.key, row);
  }
  return result;
}

// Only transforms already verified immutable inputs. It performs no IO, chooses
// no authority and never treats an unresolved history or review input as empty.
export function buildDriverAuditLightProjection({ publication, view, gps, browser, descriptor,
  corrections = null, decisions = null, sourceHistoryCases, reviewSnapshot, photoBindingRegistry } = {}) {
  check(publication?.version === 1 && object(publication.head) && digest(publication.catalog?.sha256)
    && view?.version === 1 && digest(view.generation) && digest(view.reportHash)
    && view.catalogHash === publication.catalog.sha256
    && publication.head.manifest?.sha256 === view.generation
    && publication.head.reportHash === view.reportHash, 'Light report publication binding differs');
  resourceRef(publication.head.manifest, 'snapshot');
  resourceRef(view.browser, 'snapshot');
  check(view.browser.sha256 === view.generation && descriptor?.version === 1
    && descriptor.generation === view.generation && descriptor.reportHash === view.reportHash
    && digest(descriptor.sourceManifestSha256) && object(descriptor.files), 'Light report descriptor binding differs');
  for (const [name, ref] of Object.entries(descriptor.files)) runtimeRef(ref, name);
  check(gps?.version === 1 && object(gps.records) && object(gps.streamFiles)
    && browser?.matter?.validatedReporting?.snapshotHash === view.reportHash,
  'Light report original assessment binding differs');

  const meta = browser.matter.validatedReporting;
  check(typeof meta.queryId === 'string' && Object.hasOwn(browser.queries ?? {}, meta.queryId),
    'Light report published results query is unavailable');
  const rows = rowsByKey(browser.queries[meta.queryId]?.rows, 'Published report');
  const gpsRows = rowsByKey(view.gpsRows, 'Served GPS');
  check(rows.size > 0 && gpsRows.size === rows.size, 'Light report row coverage differs');
  for (const [key, row] of rows) {
    check(gpsRows.get(key)?.assessmentHash === row.assessmentHash, 'Light report assessment or GPS row differs');
  }
  for (const count of [publication.head.records, view.status?.records]) {
    check(count === undefined || count === rows.size, 'Light report declared result count differs');
  }

  const detailCases = caseRefs(browser.matter.lazyDeliveryDetails?.cases, 'detail');
  const staffHistory = browser.matter.lazyQueries?.reporting_validated_history;
  const staffCases = caseRefs(staffHistory?.cases, 'history');
  const staffRows = historyCount(staffCases);
  check(staffHistory.count === staffRows, 'Light report declared history count differs');
  const sourceManifest = publication.privateRelease?.currentHead?.manifest ?? null;
  if (sourceManifest) resourceRef(sourceManifest, 'snapshot');
  const sourceExpected = Boolean(sourceManifest && sourceManifest.sha256 !== view.browser.sha256);
  const sourceCases = sourceHistoryCases === undefined ? null
    : caseRefs(sourceHistoryCases instanceof Map ? Object.fromEntries(sourceHistoryCases) : sourceHistoryCases, 'history');
  check(sourceCases === null || sourceManifest, 'Original history references lack their source manifest');
  const sourceRows = sourceCases === null ? null : historyCount(sourceCases);
  const expectedSourceRows = publication.privateRelease?.currentHead?.history;
  check(sourceRows === null || expectedSourceRows === undefined || Number.isSafeInteger(expectedSourceRows)
    && expectedSourceRows >= 0 && sourceRows === expectedSourceRows, 'Original source history count differs');
  const sourceResolved = !sourceExpected || sourceCases !== null;
  const unresolved = [];
  if (!sourceResolved) unresolved.push('source-history-cases');

  const rawPhotos = new Map(view.photos);
  check(Array.isArray(view.photos) && rawPhotos.size === view.photos.length && rawPhotos.size === rows.size,
    'Light report photo bindings are incomplete or ambiguous');
  const photos = previewPhotoBindings(view, photoBindingRegistry ?? null);
  for (const [key, value] of photos) {
    check(rows.has(key) && (value === null || digest(value)), 'Light report photo binding differs');
  }
  if (descriptor.files['preview-photo-bindings.private.json'] && photoBindingRegistry === undefined) {
    unresolved.push('photo-binding-registry');
  }

  const reviewRows = reviewSnapshot === undefined ? null : rowsByKey(reviewSnapshot.rows, 'Original review');
  const issueGroups = new Map();
  let review = null;
  if (reviewRows) {
    check(reviewSnapshot.snapshotHash === view.reportHash && typeof reviewSnapshot.kind === 'string'
      && Array.isArray(reviewSnapshot.issues) && reviewRows.size === rows.size,
    'Original light report review snapshot differs');
    for (const [key, row] of rows) {
      check(reviewRows.get(key)?.assessmentHash === row.assessmentHash, 'Original light report review assessment differs');
    }
    const ids = new Set();
    for (const issue of reviewSnapshot.issues) {
      check(object(issue) && typeof issue.id === 'string' && issue.id.length > 0 && issue.id.length <= 512
        && !ids.has(issue.id) && rows.has(issue.deliveryId), 'Original light report review issue differs');
      ids.add(issue.id);
      if (!issueGroups.has(issue.deliveryId)) issueGroups.set(issue.deliveryId, []);
      issueGroups.get(issue.deliveryId).push(issue);
    }
    if (reviewSnapshot.deliveryReview === true) {
      check([...rows.keys()].every(key => issueGroups.has(key)), 'Original light report review case is missing');
    }
    review = Object.fromEntries(Object.entries(reviewSnapshot).filter(([key]) => !['rows', 'issues', 'history', 'changes'].includes(key)));
  } else unresolved.push('review-snapshot');

  const evidenceDates = new Map(), gpsStreamRefs = {}, gpsEvidenceRefs = {}, extraGpsRecords = {};
  const addEvidenceDate = (date, kind) => {
    if (!evidenceDates.has(date)) evidenceDates.set(date, new Set());
    evidenceDates.get(date).add(kind);
  };
  for (const [key, name] of Object.entries(gps.streamFiles)) {
    const date = key.slice(0, 10);
    check(day(date) && key[10] === '|' && key.length > 11 && typeof name === 'string'
      && /^gps-[a-f0-9]{64}\.private\.json\.gz$/.test(name) && descriptor.files[name],
    'Original light report GPS stream reference is unavailable');
    gpsStreamRefs[key] = { file: name, ref: descriptor.files[name] };
    addEvidenceDate(date, 'gps-stream');
  }
  for (const [key, entry] of Object.entries(gps.records)) {
    check(recordDay(key) && object(entry), 'Invalid original light report GPS identity');
    if (entry.evidenceFile !== undefined) {
      check(typeof entry.evidenceFile === 'string' && /^gps-evidence-[a-f0-9]{64}\.private\.json\.gz$/.test(entry.evidenceFile)
        && descriptor.files[entry.evidenceFile], 'Original light report GPS evidence reference is unavailable');
      gpsEvidenceRefs[entry.evidenceFile] = descriptor.files[entry.evidenceFile];
    }
    for (const stream of entry.result?.gps?.streams ?? []) {
      check(Object.hasOwn(gpsStreamRefs, stream), 'Original light report GPS stream binding is unavailable');
    }
    if (!rows.has(key)) extraGpsRecords[key] = entry;
    addEvidenceDate(recordDay(key), 'gps-record');
  }
  if (sourceCases) {
    for (const key of Object.keys(sourceCases)) if (!rows.has(key)) addEvidenceDate(recordDay(key), 'source-history');
  }

  const days = new Map();
  for (const [key, row] of rows) {
    check(Object.hasOwn(detailCases, key) && rawPhotos.has(key), 'Original light report case detail is missing');
    const gpsRow = gpsRows.get(key), delivery = gpsRow.delivery;
    const source = sourceCases?.[key] ?? (sourceExpected ? null : staffCases[key] ?? null);
    const staff = staffCases[key] ?? null;
    const originalId = delivery?.driver_id;
    const entry = {
      row, gpsRow, reviewRow: reviewRows?.get(key) ?? null, detail: detailCases[key],
      summary: { key, driverId: typeof originalId === 'string' ? originalId
        : typeof originalId === 'number' && Number.isSafeInteger(originalId) ? String(originalId) : null,
      driverName: stringOrNull(delivery?.driver), customer: stringOrNull(delivery?.customer),
      status: stringOrNull(delivery?.app_status), outcome: stringOrNull(delivery?.timing_label),
      scheduledAt: stringOrNull(delivery?.window_start), uploadedAt: stringOrNull(delivery?.raw_upload ?? delivery?.upload) },
      gps: gps.records[key] ?? null,
      photo: { sha256: photos.get(key), originalSha256: rawPhotos.get(key),
        sourceUrl: stringOrNull(delivery?.photo_url), proofTimestamp: stringOrNull(delivery?.raw_upload ?? delivery?.upload) },
      history: { staff, source, extra: source && source.sha256 !== staff?.sha256 ? { source, staff } : null },
      issues: reviewRows ? issueGroups.get(key) ?? [] : null,
    };
    if (!days.has(row.date)) days.set(row.date, []);
    days.get(row.date).push(entry);
  }
  const publishedDates = [...days.keys()].sort();
  const sortedDays = new Map(publishedDates.map(date => [date, days.get(date)]));
  const context = {
    version: 1, kind: 'driver-audit-light-projection-v1', generation: view.generation, reportHash: view.reportHash,
    sourceManifestSha256: descriptor.sourceManifestSha256, descriptor, records: rows.size,
    cutoff: stringOrNull(publication.head.source?.observedAt), publishedDates,
    history: { staffRows, staffCases: Object.keys(staffCases).length, sourceRows: sourceCases ? sourceRows : sourceExpected ? null : staffRows,
      sourceCases: sourceCases ? Object.keys(sourceCases).length : sourceExpected ? null : Object.keys(staffCases).length,
      sourceExpected, sourceResolved },
    sourceHistoryExpected: sourceExpected, sourceHistoryResolved: sourceResolved,
    reviewResolved: reviewRows !== null, review, unresolved,
    refs: { catalog: publication.catalog, browserManifest: view.browser, sourceManifest,
      reviewSnapshot: { domain: 'state', path: 'review-snapshots/' + view.reportHash + '.json.gz', fallbackDomain: 'archive' } },
    gpsMetadata: Object.fromEntries(Object.entries(gps).filter(([key]) => !['records', 'streamFiles'].includes(key))),
    gpsStreamRefs, gpsEvidenceRefs, extraGpsRecords,
    extraSourceHistoryCases: Object.fromEntries(Object.entries(sourceCases ?? {}).filter(([key]) => !rows.has(key))),
    extraStaffHistoryCases: Object.fromEntries(Object.entries(staffCases).filter(([key]) => !rows.has(key))),
    evidenceOnlyDates: [...evidenceDates].filter(([date]) => !days.has(date)).sort(([a], [b]) => a.localeCompare(b))
      .map(([date, kinds]) => ({ day: date, kinds: [...kinds].sort() })),
    corrections, decisions, photoBindingRegistry: photoBindingRegistry ?? null,
    summarySource: { driverId: 'gpsRow.delivery.driver_id', driverName: 'gpsRow.delivery.driver', customer: 'gpsRow.delivery.customer',
      status: 'gpsRow.delivery.app_status', outcome: 'gpsRow.delivery.timing_label', scheduledAt: 'recorded window_start',
      uploadedAt: 'original raw_upload, otherwise upload' },
  };
  return structuredClone({ days: sortedDays, context });
}
