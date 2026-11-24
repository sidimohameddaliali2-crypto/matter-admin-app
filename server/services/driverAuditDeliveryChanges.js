import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { addDaysToDateKey, getBusinessDayBounds, isDateKey, toBusinessDateKey } from '../utils/businessDate.js';
import { loadPhotoBindingRepair } from '../vendor/driver-audits/integration/cloud/photo-binding-repair.mjs';
import { readRows } from '../vendor/driver-audits/integration/cloud/preview-source-history.mjs';
import { createCloudRepository } from '../vendor/driver-audits/integration/cloud/repository.mjs';
import { readRetainedDriverAuditFile } from './driverAuditLightEvidence.js';

const MiB = 1024 ** 2;
const maxCases = 100_000;
const maxGpsWindows = 100_000;
const sha = value => createHash('sha256').update(value).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const check = (condition, message) => { if (!condition) throw Error(message); };
const clock = value => typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 300;
const vehicleId = value => identity(value) ? value : Number.isSafeInteger(value) ? String(value) : null;

function keyDay(key) {
  check(identity(key) && key.charAt(10) === '/' && key.length > 11 && isDateKey(key.slice(0, 10)),
    'Invalid saved delivery key');
  return key.slice(0, 10);
}

function resource(ref, kind) {
  check(hex(ref?.sha256) && ref.url === `report-data/${kind}-${ref.sha256}.json`,
    'The saved delivery resource reference differs');
  return `assets/${kind}-${ref.sha256}.json.gz`;
}

async function savedJson(repository, ref, kind, packedLimit, decodedLimit) {
  const compressed = await readRetainedDriverAuditFile(repository, resource(ref, kind), packedLimit);
  const bytes = gunzipSync(compressed, { maxOutputLength: decodedLimit });
  check(sha(bytes) === ref.sha256, 'The saved delivery resource failed verification');
  return JSON.parse(bytes);
}

async function readPublishedGpsWindows(repository) {
  const { publication } = repository;
  const pointer = publication.head.gps;
  const windows = new Map();
  if (!pointer) return { windows, scope: null, asOf: null, pending: false, status: 'no-published-receipt' };
  check(hex(pointer.sha256) && pointer.path === `gps-publications/${pointer.sha256}.json`
    && clock(pointer.observedAt), 'Invalid saved GPS publication reference');
  const bytes = await readRetainedDriverAuditFile(repository, pointer.path, 8 * MiB);
  check(sha(bytes) === pointer.sha256, 'The saved GPS publication failed verification');
  const { sha256, ...receipt } = JSON.parse(bytes);
  const { scope, states, observedAt } = receipt;
  check(receipt.version === 1 && sha(JSON.stringify(receipt)) === sha256
    && observedAt === pointer.observedAt && isDateKey(scope?.from) && isDateKey(scope?.to)
    && scope.from <= scope.to && addDaysToDateKey(scope.from, 13) >= scope.to
    && Array.isArray(states) && states.length > 0 && states.length <= 2_000
    && Array.isArray(receipt.windows) && receipt.windows.length > 0 && receipt.windows.length <= maxGpsWindows,
  'Invalid saved GPS publication proof');
  const namedWindows = new Map();
  let latestObservation = -Infinity;
  for (const window of receipt.windows) {
    check(object(window) && isDateKey(window.day) && identity(window.driverId) && hex(window.snapshotSha256)
      && hex(window.observationSha256) && clock(window.fetchedAt)
      && window.day >= addDaysToDateKey(scope.from, -1) && window.day <= addDaysToDateKey(scope.to, 1),
    'Invalid saved GPS publication window');
    const key = `${window.driverId}/${window.day}`;
    latestObservation = Math.max(latestObservation, Date.parse(window.fetchedAt));
    if (!namedWindows.has(window.namespace)) namedWindows.set(window.namespace, new Map());
    const named = namedWindows.get(window.namespace);
    check(!named.has(key), 'Duplicate saved GPS publication window');
    named.set(key, window);
  }
  check(latestObservation === Date.parse(observedAt), 'The saved GPS publication cutoff differs');
  const loaded = new Set();
  let pending = false, count = 0, size = 0;
  for (const { namespace, scopeKind, sha256: stateSha } of states) {
    check(/^[a-zA-Z0-9_-]{1,60}$/.test(namespace) && hex(stateSha) && ['vehicle', 'driver'].includes(scopeKind)
      && !loaded.has(namespace), 'Invalid saved GPS namespace');
    loaded.add(namespace);
    const manifest = publication.gpsState?.[namespace]?.stateManifest;
    const path = `${namespace}/states/${stateSha}.json`;
    const catalog = await repository.resolveFile('gps', path);
    check(catalog.sha256 === stateSha && (size += catalog.size) <= 32 * MiB
      && (manifest?.sha256 !== stateSha || isDeepStrictEqual(catalog, manifest)),
    'The saved GPS namespace catalog binding differs');
    pending ||= manifest?.sha256 !== stateSha;
    const selected = namedWindows.get(namespace);
    if (!selected?.size) continue;
    const bytes = await repository.readFile('gps', path, { maxBytes: 32 * MiB });
    check(sha(bytes) === stateSha, 'The saved GPS namespace failed verification');
    const state = JSON.parse(bytes);
    check(state?.version === 1 && object(state.windows), 'Invalid saved GPS windows');
    for (const [key, verified] of selected) {
      const value = state.windows[key];
      check(object(value) && ['day', 'driverId', 'snapshotSha256', 'observationSha256', 'fetchedAt']
        .every(field => verified[field] === value[field]), 'The saved GPS publication window binding differs');
      const { day, driverId, snapshotSha256, observationSha256, fetchedAt } = value;
      const vehicleNo = scopeKind === 'vehicle' ? vehicleId(value.vehicleNo) : null;
      check((value.scopeKind ?? 'driver') === scopeKind && (scopeKind === 'driver' || vehicleNo !== null)
        && (!state.scope?.kind || state.scope.kind === scopeKind), 'Invalid saved GPS window binding');
      count++;
      const window = { namespace, key, scopeKind, day, driverId, vehicleNo, snapshotSha256, observationSha256, fetchedAt };
      for (const [kind, id] of [['driver', driverId], ['vehicle', vehicleNo]].filter(([, id]) => id !== null)) {
        const binding = JSON.stringify([kind, id, day]);
        if (!windows.has(binding)) windows.set(binding, []);
        windows.get(binding).push(window);
      }
    }
  }
  check(count === receipt.windows.length, 'The saved GPS publication omits its window namespace');
  return { windows, scope, asOf: observedAt, pending, status: 'verified' };
}

function gpsForDelivery(summary, published) {
  const { delivery, savedGpsAssessment, savedGpsContext } = summary;
  const day = summary.date;
  const uploadAt = [savedGpsAssessment?.uploadAt, savedGpsContext?.uploadAt, delivery.upload].find(clock);
  const uploadDay = uploadAt ? toBusinessDateKey(uploadAt) : null;
  const driver = identity(delivery.driver_id) && delivery.driver_id !== 'unassigned' ? delivery.driver_id : null;
  const vehicles = new Set([delivery.vehicle, savedGpsAssessment?.vehicleNo, savedGpsContext?.vehicleNo]
    .map(vehicleId).filter(value => value !== null));
  // A receipt from the adjacent date can contain fixes for the delivery day.
  const days = new Set([day, uploadDay].filter(Boolean)
    .flatMap(date => [-1, 0, 1].map(offset => addDaysToDateKey(date, offset))));
  const refs = new Map();
  for (const date of days) {
    const bindings = [['driver', driver], ...Array.from(vehicles, vehicle => ['vehicle', vehicle])];
    for (const binding of bindings) {
      if (binding[1] === null) continue;
      for (const window of published.windows.get(JSON.stringify([...binding, date])) ?? []) {
        refs.set(`${window.namespace}/${window.key}`, window);
      }
    }
  }
  const covered = published.scope && [day, uploadDay].some(date => date && date >= published.scope.from && date <= published.scope.to);
  const gps = [...refs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, ref]) => ref);
  const gpsHash = covered && gps.length > 0 ? sha(JSON.stringify(gps.map(window =>
    [window.namespace, window.key, window.snapshotSha256]))) : null;
  return {
    gps,
    gpsHash,
    gpsCoverage: {
      driver: driver === null ? 'unassigned' : 'recorded',
      vehicle: vehicles.size > 0 ? 'recorded' : 'unresolved',
      uploadDay,
      sources: !covered ? 'not-in-published-scope' : refs.size > 0 ? 'bound' : 'no-verified-windows',
      pendingPublication: Boolean(covered && published.pending),
    },
  };
}

async function latestPhotoCapture(repository) {
  const capture = repository.publication.lastCapture;
  const ref = capture?.photoReceipt;
  if (!ref) return null;
  check(identity(capture.runId) && /^[a-zA-Z0-9_-]{1,120}$/.test(capture.runId) && hex(capture.sha256) && clock(capture.observedAt)
    && hex(ref.sha256) && ref.path === `photo-capture-receipts/${capture.runId}-${ref.sha256}.json`,
  'Invalid saved photo receipt reference');
  const bytes = await readRetainedDriverAuditFile(repository, ref.path, 16 * MiB);
  check(sha(bytes) === ref.sha256, 'The saved photo receipt failed verification');
  const receipt = JSON.parse(bytes);
  check(receipt.version === 1 && receipt.day === capture.day && isDateKey(receipt.day)
    && receipt.runId === capture.runId && receipt.captureSha256 === capture.sha256
    && object(receipt.entries) && Object.keys(receipt.entries).length <= maxCases, 'The saved photo receipt differs');
  return { captureSha256: capture.sha256, receiptSha256: ref.sha256, day: receipt.day,
    observedAt: capture.observedAt, entries: receipt.entries };
}

export async function readDriverAuditDeliverySource({ publication, archive, comparisonOnly = false } = {}) {
  const head = publication?.head;
  check(publication?.version === 1 && Number.isSafeInteger(publication.revision) && publication.revision > 0
    && hex(publication.catalog?.sha256) && hex(head?.reportHash) && typeof archive?.readObject === 'function'
    && typeof comparisonOnly === 'boolean',
  'An exact saved delivery publication is required');
  const stateStore = { read: async () => ({ body: JSON.stringify(publication), revision: publication.revision }) };
  const repository = await createCloudRepository({ stateStore, transport: archive, cacheBytes: 12 * MiB }).pin();
  const browser = await savedJson(repository, head.manifest, 'snapshot', 128 * MiB, 256 * MiB);
  const reporting = browser?.matter?.validatedReporting;
  const details = browser?.matter?.lazyDeliveryDetails?.cases;
  const history = browser?.matter?.lazyQueries?.[reporting?.historyId];
  const summaries = browser?.queries?.[reporting?.queryId]?.rows;
  check(reporting?.snapshotHash === head.reportHash && object(details) && object(history?.cases)
    && Array.isArray(summaries) && summaries.length <= maxCases && Object.keys(details).length === summaries.length
    && (head.records === undefined || head.records === summaries.length), 'The exact saved delivery summary is unavailable');
  const historyCases = new Map();
  let historyCount = 0;
  for (const [key, ref] of Object.entries(history.cases)) {
    keyDay(key);
    resource(ref, 'history');
    check(Number.isSafeInteger(ref.count) && ref.count > 0 && ref.count <= maxCases && historyCases.size < maxCases,
      'Invalid saved delivery history count');
    historyCount += ref.count;
    historyCases.set(key, { sha256: ref.sha256, url: ref.url, count: ref.count });
  }
  check(history.count === historyCount && (head.history === undefined || head.history === historyCount),
    'The saved delivery history index differs');
  const gpsRead = readPublishedGpsWindows(repository).catch(error => {
    if (!comparisonOnly || error.code !== 'ENOENT') throw error;
    return { windows: new Map(), scope: null, asOf: null, pending: false, status: 'historical-reference-unavailable' };
  });
  const [gpsWindows, repair, photos] = await Promise.all([
    gpsRead, loadPhotoBindingRepair(repository), comparisonOnly ? null : latestPhotoCapture(repository),
  ]);
  const repairs = new Map((repair?.entries ?? []).map(entry => [entry.recordKey, entry]));
  const cases = new Map();
  for (const summary of summaries) {
    const key = summary?.key, day = keyDay(key), delivery = summary.delivery;
    const detail = Object.hasOwn(details, key) ? details[key] : null;
    check(summary.date === day && object(delivery) && delivery.delivery_id === key.slice(11) && hex(summary.assessmentHash)
      && detail?.count === 1 && !cases.has(key), 'The saved delivery summary binding differs');
    resource(detail, 'detail');
    const historyRef = historyCases.get(key) ?? null;
    const repairEntry = repairs.get(key);
    const photoRepair = repairEntry?.assessmentHash === summary.assessmentHash
      && repairEntry.sourceRowSha256 === delivery.source_sha256 ? repairEntry : null;
    const capture = photos?.day === day && Object.hasOwn(photos.entries, delivery.delivery_id)
      ? photos.entries[delivery.delivery_id] : null;
    let photoCapture = null;
    if (capture?.status === 'captured') {
      check(hex(capture.sha256) && hex(capture.urlSha256) && (capture.proofTimestamp === null || clock(capture.proofTimestamp))
        && (capture.observedAt == null || clock(capture.observedAt)),
        'The saved photo receipt binding differs');
      // A reused image has no fresh download clock. Bind it to the original
      // collector receipt time without changing the recorded proof timestamp.
      photoCapture = { ...capture, observedAt: capture.observedAt ?? photos.observedAt,
        captureSha256: photos.captureSha256, receiptSha256: photos.receiptSha256 };
    }
    const { gpsHash, ...gps } = gpsForDelivery(summary, gpsWindows);
    const inputs = { ...gps, photoRepair, photoCapture };
    // The rolling raw GPS receipt and the last delivery capture are separate
    // from the durable case identity. Expiring a receipt cannot erase evidence.
    const sourceHash = sha(JSON.stringify([1, key, detail.sha256, historyRef?.sha256 ?? null,
      photoRepair ? [photoRepair.urlSha256, photoRepair.proofTimestamp, photoRepair.imageSha256] : null]));
    cases.set(key, { key, day, sourceHash, gpsHash, detail: { sha256: detail.sha256, url: detail.url, count: 1 },
      history: historyRef, summary, inputs });
  }
  return Object.freeze({
    cases, publication, repository, browser, gpsAsOf: gpsWindows.asOf, gpsStatus: gpsWindows.status,
    gpsPending: gpsWindows.pending,
    historyOnly: new Map([...historyCases].filter(([key]) => !cases.has(key))),
    async readCase(key) {
      const candidate = cases.get(key);
      check(candidate, 'The saved delivery case is unavailable');
      const detail = await savedJson(repository, candidate.detail, 'detail', 16 * MiB, 16 * MiB);
      const row = detail?.rows?.[0];
      check(Array.isArray(detail?.rows) && detail.rows.length === 1 && row?.key === key && row.date === candidate.day
        && row.assessmentHash === candidate.summary.assessmentHash && row.delivery?.delivery_id === key.slice(11)
        && row.delivery?.source_sha256 === candidate.summary.delivery.source_sha256, 'The saved delivery detail binding differs');
      return row;
    },
    async readHistory(key) {
      keyDay(key);
      return readRows(historyCases.get(key), key, (file, maxBytes) => readRetainedDriverAuditFile(repository, file, maxBytes));
    },
  });
}

export async function planDriverAuditDeliveryChanges({ scheduledAt, head, pages, baseline, latest } = {}) {
  const time = scheduledAt instanceof Date ? scheduledAt.getTime() : typeof scheduledAt === 'number'
    ? scheduledAt : clock(scheduledAt) ? Date.parse(scheduledAt) : NaN;
  check(Number.isFinite(time) && head && typeof pages?.index === 'function' && typeof pages.directory === 'function'
    && latest?.cases instanceof Map, 'An exact saved delivery schedule and index are required');
  const { startOfDay } = getBusinessDayBounds(time);
  const minutes = (time - startOfDay.getTime()) / 60_000;
  check(minutes === 630 || minutes === 720, 'The delivery check must use the 10:30 or noon Dubai slot');
  const slot = minutes === 630 ? 'morning' : 'noon';
  const index = await pages.index(head);
  const knownDays = new Set(index.days.map(item => item.day));
  // These are date directories and sparse source hashes. Opening a report
  // case to decide if it changed would re-read the evidence for every case.
  const directories = new Map(), selected = [];
  let newCount = 0, changedCount = 0, deferredCount = 0, heldGpsCount = 0;
  for (const [key, candidate] of latest.cases) {
    const day = keyDay(key);
    check(candidate?.key === key && candidate.day === day && hex(candidate.sourceHash)
      && (candidate.gpsHash == null || hex(candidate.gpsHash)), 'Invalid delivery change candidate');
    if (knownDays.has(day) && !directories.has(day)) {
      const directory = await pages.directory(head, day);
      check(directory?.positions instanceof Map, 'The saved delivery date directory is invalid');
      directories.set(day, directory);
    }
    const directory = directories.get(day), published = directory?.positions.has(key);
    if (!published) {
      newCount++;
      selected.push(candidate);
      continue;
    }
    const applied = directory.sourceHashes instanceof Map ? directory.sourceHashes.get(key)
      : typeof pages.materialHash === 'function' ? await pages.materialHash(head, key) : null;
    const seeded = baseline?.cases?.get(key);
    const prior = applied ?? seeded?.sourceHash;
    const previousGps = hex(applied) ? directory.gpsHashes?.get(key) ?? null : seeded?.gpsHash ?? null;
    // A saved incremental case has already passed admission, even when its
    // first publication had no bound raw GPS windows. Its first verified
    // window can be staged through the normal case and evidence checks.
    const gpsBasisKnown = hex(applied) || previousGps !== null || (seeded?.inputs?.gpsCoverage?.sources === 'no-verified-windows'
      && !seeded.inputs.gpsCoverage.pendingPublication);
    const gpsChanged = gpsBasisKnown && candidate.gpsHash != null && candidate.gpsHash !== previousGps;
    if (slot === 'morning') {
      if (hex(prior) && (prior !== candidate.sourceHash || gpsChanged)) deferredCount++;
      continue;
    }
    check(hex(prior), 'The last published delivery source is unavailable');
    let newPhoto = false;
    // A verified capture can arrive independently of the assessed row. Compare
    // with the visible case's actual binding so a rolling receipt or retry
    // cannot overwrite or rebuild a photo the report already has.
    const capture = candidate.inputs?.photoCapture;
    if (prior === candidate.sourceHash && !gpsChanged && capture) {
      const saved = (await pages.record(head, key)).photo;
      newPhoto = typeof saved?.sourceUrl === 'string' && sha(saved.sourceUrl) === capture.urlSha256
        && saved.proofTimestamp === capture.proofTimestamp && !hex(saved.sha256);
    }
    if (prior === candidate.sourceHash && !gpsChanged && !newPhoto) {
      if (!gpsBasisKnown && candidate.gpsHash != null) heldGpsCount++;
      continue;
    }
    changedCount++;
    selected.push(candidate);
  }
  return { slot, selected, newCount, changedCount, deferredCount, heldGpsCount };
}
