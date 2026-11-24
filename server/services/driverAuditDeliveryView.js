import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createDriverAuditLightArchive, driverAuditPageSize, isDriverAuditLightReference } from './driverAuditLightArchive.js';
import { createImmutableEvidenceCache } from '../vendor/driver-audits/integration/cloud/immutable-evidence-cache.mjs';

const MiB = 1024 ** 2;
const maxPlain = 12 * MiB;
const stagedResults = new WeakMap();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const dateKey = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const textOrNull = value => value == null || typeof value === 'string';
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const fail = (status, message) => Object.assign(Error(message), { status });
const ensure = (condition, message) => { if (!condition) throw Error(message); };
const sameRef = (left, right) => left?.sha256 === right?.sha256 && left?.size === right?.size;

function caseDate(key) {
  if (typeof key !== 'string' || key.length > 300 || key.length < 12 || key[10] !== '/' || !dateKey(key.slice(0, 10))) {
    throw fail(400, 'Choose a delivery');
  }
  return key.slice(0, 10);
}

export function isDriverAuditDeliveryView(value) {
  return object(value) && Object.keys(value).length === 5 && value.version === 1
    && isDriverAuditLightReference(value.ref) && integer(value.collectorRevision) && value.collectorRevision > 0
    && hex(value.sourceBodySha256) && timestamp(value.visibleCutoffAt);
}

function hasHeadBinding(head) {
  return integer(head?.sourceRevision) && hex(head?.sourceBodySha256) && isDriverAuditLightReference(head?.lightView);
}

function basisFor(head) {
  return JSON.stringify([head.sourceRevision, head.sourceBodySha256, head.generation, head.reportHash,
    head.lightView.sha256, head.lightView.size, head.deliveryView ?? null]);
}

export function verifyDriverAuditDeliveryStage(result, head) {
  return Boolean(result && hasHeadBinding(head) && stagedResults.get(result) === basisFor(head));
}

function summaryMatches(summary, key) {
  return object(summary) && summary.key === key && textOrNull(summary.driverId) && (summary.driverId?.length ?? 0) <= 300
    && textOrNull(summary.driverName) && textOrNull(summary.status);
}

function historyRef(ref) {
  return ref == null || hex(ref.sha256) && integer(ref.count) && ref.url === `report-data/history-${ref.sha256}.json`;
}

function historyBinding(history) {
  return history == null || object(history) && historyRef(history.staff) && historyRef(history.source);
}

function caseContext(value) {
  return hex(value?.catalog?.sha256) && hex(value?.generation) && hex(value?.reportHash);
}

function issueList(issues, key) {
  return Array.isArray(issues) && issues.every(issue => typeof issue?.id === 'string' && issue.id.length > 0
    && issue.id.length <= 2048 && issue.deliveryId === key);
}

function verifyCase(entry, key) {
  ensure(entry?.row?.key === key && entry.gpsRow?.key === key && summaryMatches(entry.summary, key)
    && caseContext(entry) && entry.review?.snapshotHash === entry.reportHash && object(entry.gpsFiles?.streams)
    && object(entry.gpsFiles?.projections) && (entry.gpsAsOf === null || timestamp(entry.gpsAsOf))
    && historyBinding(entry.history) && (entry.detail == null || hex(entry.detail.sha256)
      && entry.detail.url === `report-data/detail-${entry.detail.sha256}.json`)
    && (entry.photo?.sha256 == null || hex(entry.photo.sha256))
    && (entry.reviewRow == null || entry.reviewRow.key === key)
    && (entry.issues == null || issueList(entry.issues, key))
    && (entry.retainedHistory === undefined || Array.isArray(entry.retainedHistory)
      && entry.retainedHistory.every(value => caseContext(value) && object(value.history) && historyBinding(value.history)))
    && (entry.retainedReviews === undefined || Array.isArray(entry.retainedReviews)
      && entry.retainedReviews.every(value => hex(value?.review?.snapshotHash) && issueList(value.issues, key))),
  'The changed delivery differs from its retained evidence');
}

function oldContext(index) {
  const { generation, reportHash, catalog } = index;
  return { generation, reportHash, catalog };
}

function keepHistory(entry, previous) {
  if (!previous) return entry;
  const staff = new Set([entry.history?.staff?.sha256]);
  const source = new Set([entry.history?.source?.sha256]);
  const retainedHistory = [];
  for (const version of [previous, ...(previous.retainedHistory ?? [])]) {
    const { history, catalog, generation, reportHash } = version;
    const staffRef = history?.staff, sourceRef = history?.source;
    const keepStaff = staffRef && !staff.has(staffRef.sha256), keepSource = sourceRef && !source.has(sourceRef.sha256);
    if (!(keepStaff || keepSource)) continue;
    if (keepStaff) staff.add(staffRef.sha256);
    if (keepSource) source.add(sourceRef.sha256);
    retainedHistory.push({ catalog, generation, reportHash, history: {
      staff: keepStaff ? staffRef : null, source: keepSource ? sourceRef : null,
    } });
  }
  return retainedHistory.length ? { ...entry, retainedHistory } : entry;
}

function keepReviews(entry, previous) {
  if (!previous?.review) return entry;
  const seen = new Set(), retainedReviews = [];
  for (const version of [entry, previous, ...(previous.retainedReviews ?? [])]) {
    const { snapshotHash, raw, deliveryReview } = version.review;
    const review = { snapshotHash, raw, deliveryReview }, issues = [];
    for (const issue of version.issues ?? []) {
      const identity = sha(JSON.stringify([review, issue.id, issue]));
      if (seen.has(identity)) continue;
      seen.add(identity);
      issues.push(issue);
    }
    if (version !== entry && issues.length) retainedReviews.push({ review, issues });
  }
  return retainedReviews.length ? { ...entry, retainedReviews } : entry;
}

export function createDriverAuditDeliveryView({ archive } = {}) {
  const base = createDriverAuditLightArchive({ archive });
  const cache = createImmutableEvidenceCache({ maxBytes: 24 * MiB, maxEntries: 80 });

  async function verifiedBytes(ref) {
    ensure(isDriverAuditLightReference(ref), 'Invalid incremental report reference');
    const parts = [];
    let total = 0;
    for await (const part of await archive.readObject(`${ref.sha256}.gz`, { maxBytes: ref.size })) {
      ensure(part instanceof Uint8Array && (total += part.length) <= ref.size, 'Invalid incremental report size');
      parts.push(Buffer.from(part));
    }
    const bytes = Buffer.concat(parts, total);
    ensure(total === ref.size && sha(bytes) === ref.sha256, 'The incremental report object failed verification');
    return bytes;
  }

  async function read(ref) {
    return cache.getOrLoad(`${ref.sha256}:${ref.size}`, async () => {
      const plain = gunzipSync(await verifiedBytes(ref), { maxOutputLength: maxPlain });
      return { value: JSON.parse(plain), bytes: plain.length };
    });
  }

  async function write(value) {
    const plain = Buffer.from(JSON.stringify(value));
    ensure(plain.length <= maxPlain, 'The incremental report exceeds its decoded limit');
    const bytes = gzipSync(plain, { level: 6 }), ref = { sha256: sha(bytes), size: bytes.length };
    ensure(isDriverAuditLightReference(ref), 'The incremental report exceeds its stored limit');
    const key = `${ref.sha256}.gz`, receipt = await archive.putVerifiedObject(key, bytes);
    ensure(receipt?.verified === true && receipt.key === key && receipt.sha256 === ref.sha256,
      'The incremental report write could not be verified');
    await verifiedBytes(ref);
    return ref;
  }

  async function root(head) {
    const view = head?.deliveryView;
    if (view === undefined) return null;
    ensure(isDriverAuditDeliveryView(view), 'The incremental report pointer is invalid');
    const value = await read(view.ref);
    ensure(value?.version === 1 && value.kind === 'delivery-root' && sameRef(value.base, head.lightView)
      && value.collectorRevision === view.collectorRevision && value.sourceBodySha256 === view.sourceBodySha256
      && value.visibleCutoffAt === view.visibleCutoffAt && Array.isArray(value.days) && value.days.length <= 20000,
    'The incremental report index differs from its publication');
    let last;
    for (const day of value.days) {
      ensure(dateKey(day?.day) && (last === undefined || last > day.day) && integer(day.records)
        && integer(day.extraCases) && isDriverAuditLightReference(day.ref), 'Invalid incremental date reference');
      last = day.day;
    }
    return value;
  }

  async function index(head) {
    const original = await base.index(head), overlay = await root(head);
    if (!overlay) return original;
    const dates = new Map(original.days.map(day => [day.day, day]));
    let records = original.records;
    for (const day of overlay.days) {
      const oldCount = dates.get(day.day)?.records ?? 0;
      ensure(day.records >= oldCount, 'The incremental report removed original deliveries');
      records += day.records - oldCount;
      dates.set(day.day, { ...day, fingerprint: day.ref.sha256 });
    }
    return { ...original, generation: head.deliveryView.ref.sha256, visibleCutoffAt: overlay.visibleCutoffAt, records,
      days: [...dates.values()].sort((left, right) => compare(right.day, left.day)) };
  }

  async function loadDate(head, date, original, overlay) {
    const previous = original.days.find(value => value.day === date);
    const selected = overlay?.days.find(value => value.day === date);
    const directory = previous ? await base.directory(head, date) : null;
    const cases = new Map();
    if (!selected) return { directory, cases, records: directory?.records ?? 0, totals: directory?.totals ?? [], selected };
    const patch = await read(selected.ref);
    ensure(patch?.version === 1 && patch.kind === 'delivery-date' && patch.day === date
      && sameRef(patch.base, previous?.ref) && Array.isArray(patch.cases) && patch.cases.length > 0
      && patch.records === selected.records && patch.extraCases === selected.extraCases && Array.isArray(patch.totals),
    'The incremental report date differs from its publication');
    let records = directory?.records ?? 0, extraCases = directory?.extraCases.length ?? 0;
    for (const change of patch.cases) {
      ensure(caseDate(change?.key) === date && !cases.has(change.key) && hex(change.sourceHash)
        && (change.gpsHash == null || hex(change.gpsHash))
        && isDriverAuditLightReference(change.ref) && summaryMatches(change.summary, change.key),
      'Invalid incremental delivery reference');
      cases.set(change.key, change);
      if (!directory?.positions.has(change.key)) records++;
      if (directory?.extraHistory.has(change.key)) extraCases--;
    }
    const totals = new Map(patch.totals);
    ensure(records === selected.records && extraCases === selected.extraCases && totals.size === patch.totals.length
      && [...totals].every(([status, count]) => textOrNull(status) && integer(count) && count > 0)
      && [...totals.values()].reduce((sum, count) => sum + count, 0) === records, 'The incremental report date totals differ');
    return { directory, cases, records, totals: patch.totals, selected };
  }

  async function dateFor(head, date) {
    if (!dateKey(date)) throw fail(400, 'Choose a report date');
    const [original, overlay] = await Promise.all([base.index(head), root(head)]);
    return { ...await loadDate(head, date, original, overlay), context: oldContext(original) };
  }

  function presentDate(value) {
    if (!value.directory && !value.selected) throw fail(404, 'No saved report for that date');
    const { directory, cases, records, totals } = value;
    const entries = [];
    for (const driver of directory?.drivers ?? []) {
      for (let position = driver.start; position < driver.start + driver.records; position++) {
        const key = directory.keys[position];
        if (!cases.has(key)) entries.push({ key, id: driver.id, name: driver.name, position });
      }
    }
    for (const { key, summary } of cases.values()) entries.push({ key, id: summary.driverId ?? '', name: summary.driverName ?? null });
    entries.sort((left, right) => compare(left.id, right.id) || compare(left.key, right.key));
    const drivers = [], positions = new Map();
    for (const [position, { key, id, name }] of entries.entries()) {
      positions.set(key, position);
      if (drivers.at(-1)?.id !== id) drivers.push({ id, name, start: position, records: 0 });
      drivers.at(-1).records++;
    }
    return { cases, entries, positions, keys: entries.map(({ key }) => key), records, drivers, totals,
      extraCases: (directory?.extraCases ?? []).filter(([key]) => !cases.has(key)),
      sourceHashes: new Map([...cases].map(([key, { sourceHash }]) => [key, sourceHash])),
      gpsHashes: new Map([...cases].map(([key, { gpsHash }]) => [key, gpsHash ?? null])) };
  }

  async function changedRecord(change) {
    const value = await read(change.ref);
    ensure(value?.version === 1 && value.kind === 'delivery-case' && value.sourceHash === change.sourceHash
      && (value.gpsHash ?? null) === (change.gpsHash ?? null),
      'The changed delivery source identity differs');
    verifyCase(value.entry, change.key);
    ensure(JSON.stringify(change.summary) === JSON.stringify(value.entry.summary), 'The changed delivery summary differs');
    return value.entry;
  }

  function stageResult(admitted, details) {
    const deliveryView = details.deliveryView ? Object.freeze({ ...details.deliveryView,
      ref: Object.freeze({ ...details.deliveryView.ref }) }) : null;
    const result = Object.freeze({ ...details, deliveryView });
    stagedResults.set(result, admitted);
    return result;
  }

  async function stage({ head: supplied, changes, collectorRevision, sourceBodySha256, visibleCutoffAt } = {}) {
    ensure(hasHeadBinding(supplied) && integer(collectorRevision) && collectorRevision > 0 && hex(sourceBodySha256)
      && timestamp(visibleCutoffAt) && Array.isArray(changes) && typeof archive.putVerifiedObject === 'function',
    'An admitted base and verified delivery source are required');
    const head = { ...supplied, lightView: { ...supplied.lightView } };
    if (supplied.deliveryView) head.deliveryView = { ...supplied.deliveryView, ref: { ...supplied.deliveryView.ref } };
    const admitted = basisFor(head), baseRevision = head.servingPackage?.collectorRevision ?? 0;
    const days = new Map(), seen = new Set();
    for (const change of changes) {
      const date = caseDate(change?.key);
      ensure(!seen.has(change.key) && hex(change.sourceHash) && (change.gpsHash == null || hex(change.gpsHash))
        && change.entry?.retainedHistory === undefined && change.entry?.retainedReviews === undefined,
        'Invalid or repeated changed delivery');
      verifyCase(change.entry, change.key);
      seen.add(change.key);
      if (!days.has(date)) days.set(date, []);
      days.get(date).push(change);
    }
    let changedRecords = 0, changedDays = 0, writtenObjects = 0;
    const result = deliveryView => stageResult(admitted, { deliveryView, changedRecords, changedDays, writtenObjects });
    if (!days.size) return result(head.deliveryView ?? null);
    const [original, current] = await Promise.all([base.index(head), root(head)]);
    const overlay = new Map(current?.days.map(value => [value.day, value]));
    const oldCutoff = current?.visibleCutoffAt ?? original.visibleCutoffAt;
    const oldRevision = current?.collectorRevision ?? baseRevision;
    const sourceAdvanced = collectorRevision > oldRevision
      || current?.collectorRevision === collectorRevision && current.sourceBodySha256 === sourceBodySha256;
    for (const [date, changesForDate] of days) {
      const prior = await loadDate(head, date, original, current), merged = new Map(prior.cases);
      const totals = new Map(prior.totals);
      let records = prior.records, extraCases = prior.selected?.extraCases ?? prior.directory?.extraCases.length ?? 0;
      let touched = false;
      for (const change of changesForDate) {
        const { key, sourceHash } = change, previous = prior.cases.get(key);
        const gpsHash = change.gpsHash ?? previous?.gpsHash ?? null;
        const inBase = prior.directory?.positions.has(key), historical = prior.directory?.extraHistory.get(key);
        const former = previous ? await changedRecord(previous) : inBase ? {
          ...await base.record(head, key), ...oldContext(original),
        } : historical ? { history: historical, ...oldContext(original) } : null;
        if (previous?.sourceHash === sourceHash && (previous.gpsHash ?? null) === gpsHash
          && former.photo?.sha256 === change.entry.photo?.sha256) continue;
        ensure(sourceAdvanced && Date.parse(visibleCutoffAt) >= Date.parse(oldCutoff),
          'The incremental report would move backwards');
        if (previous || inBase) {
          const status = former.summary.status ?? null, count = totals.get(status);
          ensure(integer(count) && count > 0, 'The prior delivery is missing from its status totals');
          if (count === 1) totals.delete(status);
          else totals.set(status, count - 1);
        } else {
          records++;
          if (historical) extraCases--;
        }
        const entry = keepReviews(keepHistory(change.entry, former), former), status = entry.summary.status ?? null;
        totals.set(status, (totals.get(status) ?? 0) + 1);
        const ref = await write({ version: 1, kind: 'delivery-case', sourceHash, gpsHash, entry });
        merged.set(key, { key, sourceHash, gpsHash, ref, summary: entry.summary });
        writtenObjects++;
        changedRecords++;
        touched = true;
      }
      if (!touched) continue;
      const baseRef = original.days.find(value => value.day === date)?.ref ?? null;
      const ref = await write({ version: 1, kind: 'delivery-date', day: date, base: baseRef, records, extraCases,
        cases: [...merged.values()].sort((left, right) => compare(left.key, right.key)), totals: [...totals] });
      overlay.set(date, { day: date, ref, records, extraCases });
      writtenObjects++;
      changedDays++;
    }
    if (!changedRecords) return result(head.deliveryView ?? null);
    const identity = { version: 1, collectorRevision, sourceBodySha256, visibleCutoffAt };
    const ref = await write({ ...identity, kind: 'delivery-root', base: head.lightView,
      days: [...overlay.values()].sort((left, right) => compare(right.day, left.day)) });
    writtenObjects++;
    return result({ ...identity, ref });
  }

  return Object.freeze({
    index, stage, photoSuggestions: base.photoSuggestions,
    async directory(head, date) { return presentDate(await dateFor(head, date)); },
    async hasCase(head, key) {
      const { directory, cases } = await dateFor(head, caseDate(key));
      return cases.has(key) || Boolean(directory?.positions.has(key));
    },
    async materialHash(head, key) {
      const { cases } = await dateFor(head, caseDate(key));
      return cases.get(key)?.sourceHash ?? null;
    },
    async additionalCases(head, date) {
      const value = await dateFor(head, date);
      if (!value.selected) return base.additionalCases(head, date);
      return (value.directory?.extraCases ?? []).filter(([key]) => !value.cases.has(key))
        .map(([record, { staff, source }]) => ({ record, versions: (source ?? staff).count }));
    },
    async additionalHistory(head, key) {
      const original = await base.index(head);
      return { ...await base.additionalHistory(head, key), ...oldContext(original) };
    },
    async record(head, key) {
      const { cases, context } = await dateFor(head, caseDate(key));
      const change = cases.get(key);
      if (change) return changedRecord(change);
      return { ...await base.record(head, key), ...context };
    },
    async list(head, { day, driver, offset = 0 } = {}) {
      if (!integer(offset)) throw fail(400, 'Invalid report page');
      const value = await dateFor(head, day);
      if (!value.selected) return base.list(head, { day, driver, offset });
      const { entries, drivers, totals, records, cases } = presentDate(value);
      const filter = driver == null ? null : drivers.find(item => item.id === driver);
      if (driver != null && !filter) throw fail(404, 'No saved report for that driver');
      const start = filter?.start ?? 0, total = filter?.records ?? records;
      if (offset > total) throw fail(400, 'Invalid report page');
      const end = Math.min(offset + driverAuditPageSize, total), loaded = new Map();
      const rows = await Promise.all(entries.slice(start + offset, start + end).map(async ({ key, position }) => {
        if (position === undefined) return cases.get(key).summary;
        const first = position - position % driverAuditPageSize;
        if (!loaded.has(first)) loaded.set(first, base.list(head, { day, offset: first }));
        return (await loaded.get(first)).rows[position - first];
      }));
      return { day, records, total, drivers: drivers.map(({ id, name, records }) => ({ id, name, records })),
        totals, rows, next: end < total ? end : null };
    },
  });
}
