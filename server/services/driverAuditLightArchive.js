import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createImmutableEvidenceCache } from '../vendor/driver-audits/integration/cloud/immutable-evidence-cache.mjs';
import { gpsEvidenceSummary } from '../vendor/driver-audits/integration/private-gps/evidence-result.mjs';

export const driverAuditPageSize = 40;
const maxPacked = 2 * 1024 ** 2;
const maxPlain = 12 * 1024 ** 2;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const dateKey = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
const ensure = (condition, message) => { if (!condition) throw Error(message); };
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const fail = (status, message) => Object.assign(Error(message), { status });

export function isDriverAuditLightReference(value) {
  return Boolean(value && Object.keys(value).length === 2 && hex(value.sha256)
    && integer(value.size) && value.size > 0 && value.size <= maxPacked);
}

function pack(value) {
  const body = Buffer.from(JSON.stringify(value));
  ensure(body.length <= maxPlain, 'The report page exceeds its decoded limit');
  const bytes = gzipSync(body, { level: 6 });
  const ref = { sha256: digest(bytes), size: bytes.length };
  ensure(isDriverAuditLightReference(ref), 'The report page exceeds its stored limit');
  return { ref, bytes };
}

function deferredInlineGps(entries) {
  const assets = new Map(), entriesByKey = new Map();
  const maximum = 4 * 1024 ** 2;
  let group = [], size = 2;
  function flush() {
    if (!group.length) return;
    const packed = pack(group.map(({ entry, result }) => [entry.row.key, result]));
    const { sha256, size } = packed.ref;
    const name = 'gps-evidence-' + sha256 + '.private.json.gz';
    assets.set(name, { ...packed, manifest: { version: 1, size, sha256, chunks: [{ offset: 0, size, sha256 }] } });
    for (const { entry, result } of group) {
      const { evidenceResult, ...gps } = entry.gps;
      entriesByKey.set(entry.row.key, { ...entry, gps: { ...gps, evidenceFile: name,
        evidenceSummary: { ...gpsEvidenceSummary(result), deliveryDigest: result.deliveryDigest } } });
    }
    group = [];
  }
  for (const entry of entries) {
    const result = entry.gps?.evidenceResult;
    if (!result) continue;
    ensure(result.recordKey === entry.row.key && hex(result.deliveryDigest), 'An inline GPS evidence binding differs');
    const bytes = Buffer.byteLength(JSON.stringify([entry.row.key, result])) + 1;
    ensure(bytes + 2 <= maximum, 'An inline GPS record exceeds its bound');
    if (size + bytes > maximum) { flush(); size = 2; }
    group.push({ entry, result });
    size += bytes;
  }
  flush();
  return { assets, entries: entries.map(entry => entriesByKey.get(entry.row.key) ?? entry) };
}

function indexFor(value, head) {
  ensure(value?.version === 1 && value.generation === head?.generation && value.reportHash === head?.reportHash
    && value.visibleCutoffAt === head?.visibleCutoffAt && Array.isArray(value.days) && value.days.length <= 20000
    && integer(value.records) && integer(value.history?.staffRows) && hex(value.catalog?.sha256)
    && value.review?.snapshotHash === head.reportHash, 'The saved report index differs from its publication');
  let count = 0, last;
  for (const day of value.days) {
    ensure(dateKey(day?.day) && (last === undefined || last > day.day) && integer(day.records)
      && integer(day.extraCases) && hex(day.fingerprint) && isDriverAuditLightReference(day.ref), 'Invalid report date index');
    count += day.records;
    last = day.day;
  }
  ensure(count === value.records, 'The saved report record count differs');
  return value;
}

function verifyDay(value, selected) {
  ensure(value?.version === 1 && value.day === selected.day && value.records === selected.records
    && Array.isArray(value.keys) && value.keys.length === selected.records && Array.isArray(value.pages)
    && value.pages.length === Math.ceil(selected.records / driverAuditPageSize)
    && Array.isArray(value.drivers) && Array.isArray(value.extraCases)
    && value.extraCases.length === selected.extraCases, 'The saved delivery date is invalid');
  const positions = new Map();
  for (const [position, key] of value.keys.entries()) {
    ensure(typeof key === 'string' && key.length <= 300 && key.startsWith(value.day + '/') && !positions.has(key),
      'The saved delivery date has an invalid record key');
    positions.set(key, position);
  }
  for (const page of value.pages) {
    ensure(isDriverAuditLightReference(page?.list) && isDriverAuditLightReference(page?.evidence),
      'The saved report page references are invalid');
  }
  const extraHistory = new Map();
  for (const [key, history] of value.extraCases) {
    const references = [history?.staff, history?.source].filter(Boolean);
    ensure(typeof key === 'string' && key.startsWith(value.day + '/') && !positions.has(key) && !extraHistory.has(key)
      && references.length > 0 && references.every(ref => hex(ref.sha256) && integer(ref.count)
        && ref.url === 'report-data/history-' + ref.sha256 + '.json'),
    'The saved source assessment case is invalid');
    extraHistory.set(key, history);
  }
  let covered = 0, last;
  for (const driver of value.drivers) {
    ensure(typeof driver?.id === 'string' && driver.id.length <= 300
      && (last === undefined || last < driver.id) && (driver.name === null || typeof driver.name === 'string')
      && integer(driver.records) && driver.records > 0 && driver.start === covered,
    'The saved driver ranges are invalid');
    last = driver.id;
    covered += driver.records;
  }
  ensure(covered === selected.records, 'The saved driver ranges omit deliveries');
  return { ...value, positions, extraHistory };
}

export function createDriverAuditLightArchive({ archive } = {}) {
  ensure(typeof archive?.readObject === 'function', 'A verified report archive reader is required');
  const cache = createImmutableEvidenceCache({ maxBytes: 24 * 1024 ** 2, maxEntries: 80 });
  async function read(ref, decode = value => value, kind = 'json') {
    ensure(isDriverAuditLightReference(ref), 'Invalid report object reference');
    return cache.getOrLoad(kind + ':' + ref.sha256, async () => {
      const chunks = [];
      let total = 0;
      for await (const chunk of await archive.readObject(ref.sha256 + '.gz', { maxBytes: ref.size })) {
        ensure(chunk instanceof Uint8Array && (total += chunk.length) <= ref.size, 'The saved report object is too large');
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks, total);
      ensure(bytes.length === ref.size && digest(bytes) === ref.sha256, 'The saved report object failed verification');
      const plain = gunzipSync(bytes, { maxOutputLength: maxPlain });
      return { value: decode(JSON.parse(plain)), bytes: plain.length };
    });
  }

  async function index(head) {
    if (!head?.lightView) throw fail(503, 'The indexed report has not been prepared');
    return indexFor(await read(head.lightView), head);
  }

  async function day(head, key) {
    if (!dateKey(key)) throw fail(400, 'Choose a report date');
    const selected = (await index(head)).days.find(entry => entry.day === key);
    if (!selected) throw fail(404, 'No saved report for that date');
    const loaded = await read(selected.ref, value => verifyDay(value, selected), 'day');
    ensure(loaded.day === selected.day && loaded.records === selected.records, 'The saved report date binding differs');
    return loaded;
  }

  async function page(directory, offset, kind) {
    const pageNumber = Math.floor(offset / driverAuditPageSize);
    const expected = directory.keys.slice(pageNumber * driverAuditPageSize, (pageNumber + 1) * driverAuditPageSize);
    const value = await read(directory.pages[pageNumber][kind]);
    const entries = value?.rows;
    ensure(value?.version === 1 && value.day === directory.day && Array.isArray(entries)
      && entries.length === expected.length
      && entries.every((entry, position) => (kind === 'evidence' ? entry?.row?.key : entry?.key) === expected[position]),
    'The saved report page does not match its date');
    return entries;
  }

  return Object.freeze({
    index,
    directory: day,
    async additionalCases(head, key) {
      const directory = await day(head, key);
      return directory.extraCases.map(([record, { staff, source }]) => ({ record, versions: (source ?? staff).count }));
    },
    async additionalHistory(head, key) {
      if (typeof key !== 'string' || key.length > 300 || key.charAt(10) !== '/') throw fail(400, 'Choose a delivery');
      const directory = await day(head, key.slice(0, 10)), history = directory.extraHistory.get(key);
      if (!history) throw fail(404, 'No saved source assessments for that case');
      return { row: { key }, history };
    },
    async list(head, { day: date, driver, offset = 0 } = {}) {
      if (!integer(offset)) throw fail(400, 'Invalid report page');
      const directory = await day(head, date);
      const filter = driver === undefined || driver === null ? null : directory.drivers.find(item => item.id === driver);
      if (driver !== undefined && driver !== null && !filter) throw fail(404, 'No saved report for that driver');
      const start = filter?.start ?? 0, total = filter?.records ?? directory.records;
      if (offset > total) throw fail(400, 'Invalid report page');
      const end = Math.min(offset + driverAuditPageSize, total), rows = [];
      for (let at = start + offset; at < start + end;) {
        const items = await page(directory, at, 'list');
        const relative = at % driverAuditPageSize;
        const selected = items.slice(relative, relative + start + end - at);
        rows.push(...selected);
        at += selected.length;
      }
      return { day: date, records: directory.records, total, drivers: directory.drivers
        .map(({ id, name, records }) => ({ id, name, records })), totals: directory.totals,
        rows, next: end < total ? end : null };
    },
    async record(head, key) {
      if (typeof key !== 'string' || key.length > 300 || key.charAt(10) !== '/') throw fail(400, 'Choose a delivery');
      const directory = await day(head, key.slice(0, 10));
      const position = directory.positions.get(key);
      if (position === undefined) throw fail(404, 'No saved evidence for that delivery');
      const entries = await page(directory, position, 'evidence');
      const entry = entries[position % driverAuditPageSize];
      const publication = await index(head);
      return { ...entry, gpsFiles: directory.gpsFiles, gpsAsOf: publication.gpsAsOf, review: publication.review };
    },
    async verify(head, savedKeys) {
      const publication = await index(head);
      const expected = new Set(savedKeys);
      ensure(expected.size === savedKeys.length && publication.records === expected.size,
        'The indexed report differs from the saved delivery census');
      for (const descriptor of publication.days) {
        const directory = await day(head, descriptor.day);
        for (const key of directory.keys) ensure(expected.delete(key), 'The indexed report added or repeated a delivery');
        for (let at = 0; at < directory.records; at += driverAuditPageSize) {
          await page(directory, at, 'list');
          await page(directory, at, 'evidence');
        }
      }
      ensure(expected.size === 0, 'The indexed report omitted a saved delivery');
      return publication;
    },
  });
}

// A changed report publishes a tiny generation index. Identical date pages
// use the exact references already admitted by the previous publication.
export async function stageDriverAuditLightView({ projection, head, previous, archive } = {}) {
  ensure(projection?.days instanceof Map && projection.context && hex(head?.generation) && hex(head?.reportHash)
    && typeof archive?.putVerifiedObject === 'function', 'Verified report data is required');
  const { context } = projection;
  const cutoffMatches = context.cutoff === head.visibleCutoffAt || typeof context.cutoff === 'string'
    && typeof head.visibleCutoffAt === 'string' && Date.parse(context.cutoff) === Date.parse(head.visibleCutoffAt);
  ensure(context.generation === head.generation && context.reportHash === head.reportHash && cutoffMatches
    && (!head.servingPackage || context.sourceManifestSha256 === head.servingPackage.manifestSha256),
  'The date projection does not match its original report identity');
  ensure(projection.context.reviewResolved
    && (!projection.context.sourceHistoryExpected || projection.context.sourceHistoryResolved),
  'The original review and source assessment references must be resolved');
  const reader = createDriverAuditLightArchive({ archive });
  const prior = previous?.lightView ? await reader.index(previous) : null;
  const priorDays = new Map(prior?.days.map(day => [day.day, day]));
  const previouslyWritten = new Set(previous?.lightView ? [previous.lightView.sha256] : []);
  async function write({ ref, bytes }) {
    if (!previouslyWritten.has(ref.sha256)) {
      const key = ref.sha256 + '.gz';
      const receipt = await archive.putVerifiedObject(key, bytes);
      ensure(receipt?.verified === true && receipt.sha256 === ref.sha256 && receipt.key === key,
        'The saved report page write could not be verified');
      previouslyWritten.add(ref.sha256);
    }
    return ref;
  }
  const days = [], samples = {};
  const extrasByDay = new Map();
  const extraSource = context.extraSourceHistoryCases, extraStaff = context.extraStaffHistoryCases ?? {};
  const extraKeys = new Set([...Object.keys(extraSource), ...Object.keys(extraStaff)]);
  for (const key of [...extraKeys].sort(compare)) {
    const date = key.slice(0, 10);
    const cases = extrasByDay.get(date) ?? [];
    cases.push([key, { staff: extraStaff[key] ?? null, source: extraSource[key] ?? null }]);
    extrasByDay.set(date, cases);
  }
  const dates = new Set([...projection.days.keys(), ...extrasByDay.keys()]);
  let records = 0;
  for (const day of [...dates].sort((left, right) => compare(right, left))) {
    const entries = projection.days.get(day) ?? [];
    ensure(dateKey(day) && Array.isArray(entries), 'Invalid report projection date');
    const sorted = entries.slice().sort((left, right) => compare(left.summary.driverId ?? '', right.summary.driverId ?? '')
      || compare(left.row.key, right.row.key));
    const { assets, entries: ordered } = deferredInlineGps(sorted);
    const keys = [], drivers = [], totals = new Map(), gpsFiles = { streams: {}, projections: {} };
    for (const [key, stream] of Object.entries(context.gpsStreamRefs)) {
      if (key.startsWith(day + '|')) gpsFiles.streams[key] = stream.ref;
    }
    const unique = new Set();
    for (const [position, entry] of ordered.entries()) {
      const { row, summary, gps, gpsRow } = entry;
      ensure(typeof row?.key === 'string' && row.key.startsWith(day + '/') && !unique.has(row.key)
        && row.key === summary?.key && gpsRow?.key === row.key, 'A projected delivery binding differs');
      unique.add(row.key);
      if (!samples.gps && (gps?.evidenceFile || gps?.evidenceResult)) samples.gps = row.key;
      if (!samples.photo && hex(entry.photo?.sha256)) samples.photo = row.key;
      if (!samples.review && entry.issues?.length) samples.review = row.key;
      keys.push(row.key);
      const id = summary.driverId ?? '', name = summary.driverName ?? null;
      if (drivers.at(-1)?.id !== id) drivers.push({ id, name, start: position, records: 0 });
      drivers.at(-1).records++;
      const status = summary.status ?? null;
      totals.set(status, (totals.get(status) ?? 0) + 1);
      for (const stream of gps?.result?.gps?.streams ?? []) {
        gpsFiles.streams[stream] = context.gpsStreamRefs[stream]?.ref;
      }
      if (gps?.evidenceFile) {
        gpsFiles.projections[gps.evidenceFile] = assets.get(gps.evidenceFile)?.manifest ?? context.gpsEvidenceRefs[gps.evidenceFile];
      }
    }
    ensure(Object.values(gpsFiles.streams).every(Boolean) && Object.values(gpsFiles.projections).every(Boolean),
      'A saved GPS reference is missing');
    const pages = [];
    for (let at = 0; at < ordered.length; at += driverAuditPageSize) {
      const items = ordered.slice(at, at + driverAuditPageSize);
      const evidence = items.map(({ row, reviewRow, ...item }) => ({
        ...item, row: { key: row.key },
        reviewRow: reviewRow ? {
          key: reviewRow.key,
          findings: item.policy?.reviewFindingIds?.map(issue_id => ({ issue_id })) ??
            [...(reviewRow.findings ?? []), ...(reviewRow.photoFindings ?? [])].map(({ issue_id }) => ({ issue_id })),
        } : null,
      }));
      pages.push({
        list: pack({ version: 1, day, rows: items.map(item => item.summary) }),
        evidence: pack({ version: 1, day, rows: evidence }),
      });
    }
    const value = { version: 1, day, records: ordered.length, keys, drivers, totals: [...totals],
      gpsFiles, extraCases: extrasByDay.get(day) ?? [],
      pages: pages.map(({ list, evidence }) => ({ list: list.ref, evidence: evidence.ref })) };
    const packed = pack(value), fingerprint = packed.ref.sha256;
    const old = priorDays.get(day);
    let ref;
    if (old?.fingerprint === fingerprint) {
      ensure(old.records === ordered.length && old.ref.sha256 === fingerprint, 'The previous report date differs');
      ref = old.ref;
    } else {
      if (old) {
        const priorDay = await reader.directory(previous, day);
        ensure(priorDay.records === old.records, 'The previous report date differs');
        for (const { list, evidence } of priorDay.pages) {
          previouslyWritten.add(list.sha256);
          previouslyWritten.add(evidence.sha256);
        }
        for (const ref of Object.values(priorDay.gpsFiles.projections)) previouslyWritten.add(ref.sha256);
      }
      for (const object of assets.values()) await write(object);
      for (const page of pages) {
        await write(page.list);
        await write(page.evidence);
      }
      ref = await write(packed);
    }
    days.push({ day, records: ordered.length, extraCases: value.extraCases.length, ref, fingerprint });
    records += ordered.length;
  }
  ensure(records === context.records, 'The indexed report omitted saved deliveries');
  const index = { version: 1, generation: head.generation, reportHash: head.reportHash,
    visibleCutoffAt: head.visibleCutoffAt, records, history: context.history,
    gpsAsOf: context.gpsMetadata.asOf ?? null, review: { snapshotHash: context.review.snapshotHash,
      deliveryReview: context.review.deliveryReview, raw: context.review.raw },
    catalog: context.refs.catalog, sourceManifest: context.refs.sourceManifest ?? null, days, samples };
  indexFor(index, head);
  return write(pack(index));
}
