import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { createDriverAuditDeliveryView, verifyDriverAuditDeliveryStage } from './driverAuditDeliveryView.js';
import { createDriverAuditLightArchive, stageDriverAuditLightView } from './driverAuditLightArchive.js';

const today = '2026-11-18', previousDay = '2026-11-17', historicDay = '2026-10-19';
const sha = value => createHash('sha256').update(value).digest('hex');
const keyFor = (date, number) => `${date}/delivery-${String(number).padStart(3, '0')}`;
const keyOf = ref => `${ref.sha256}.gz`;
const reference = value => ({ sha256: sha(value), size: value.length });
const historyRef = text => ({ sha256: sha(text), url: `report-data/history-${sha(text)}.json`, count: 1 });

function savedCase(key, { driver = 'b', status = 'delivered', version = 'base' } = {}) {
  const reportHash = sha(`${version}:snapshot`);
  return {
    row: { key }, summary: { key, driverId: driver, driverName: `${driver} driver`, status, outcome: 'within_window' },
    gpsRow: { key, date: key.slice(0, 10), assessmentHash: sha(`${key}:${version}:gps`), delivery: { id: key } },
    gpsFiles: { streams: {}, projections: {} }, gpsAsOf: `${key.slice(0, 10)}T06:00:00.000Z`,
    gps: null, photo: { sha256: sha(`${key}:photo`) }, history: { staff: historyRef(`${key}:${version}`), source: null },
    catalog: { sha256: sha(`${version}:catalog`) }, generation: sha(`${version}:manifest`), reportHash,
    review: { snapshotHash: reportHash, deliveryReview: true }, reviewRow: { key, findings: [] },
    issues: [{ id: `issue:${key}`, deliveryId: key }],
  };
}

function update(key, options) {
  const entry = savedCase(key, options);
  return { key, sourceHash: sha(JSON.stringify({ key, options })), entry };
}

async function fixture() {
  const objects = new Map(), reads = [], writes = [], poison = new Set();
  let corruptWrite = false;
  const archive = {
    async readObject(key, { maxBytes }) {
      assert.ok(!poison.has(key), 'read an unrelated archived object');
      reads.push(key);
      const value = objects.get(key);
      assert.ok(value && value.length <= maxBytes);
      return [value];
    },
    async putVerifiedObject(key, value) {
      assert.equal(key, keyOf(reference(value)));
      writes.push(key);
      const copy = Buffer.from(value);
      if (corruptWrite) copy[0] ^= 1;
      objects.set(key, copy);
      return { verified: true, key, sha256: sha(value) };
    },
  };
  const head = { generation: sha('base:manifest'), reportHash: sha('base:snapshot'),
    visibleCutoffAt: `${previousDay}T08:00:00.000Z`, sourceRevision: 1, sourceBodySha256: sha('original:head'),
    servingPackage: { collectorRevision: 50 } };
  const extraKey = keyFor(previousDay, 999), extraHistory = historyRef('untouched source-only history');
  const prior = Array.from({ length: 45 }, (_, i) => savedCase(keyFor(previousDay, i + 1)));
  const historic = savedCase(keyFor(historicDay, 1));
  head.lightView = await stageDriverAuditLightView({ head, archive, projection: {
    days: new Map([[previousDay, prior], [historicDay, [historic]]]), context: {
      generation: head.generation, reportHash: head.reportHash, cutoff: head.visibleCutoffAt,
      records: 46, history: { staffRows: 46 }, refs: { catalog: historic.catalog }, review: historic.review,
      reviewResolved: true, gpsStreamRefs: {}, gpsEvidenceRefs: {}, gpsMetadata: { asOf: historic.gpsAsOf },
      extraSourceHistoryCases: { [extraKey]: extraHistory },
    },
  } });
  const base = createDriverAuditLightArchive({ archive });
  const historicRef = (await base.index(head)).days.find(value => value.day === historicDay).ref;
  const savedDay = await base.directory(head, previousDay);
  const savedHistoric = await base.record(head, historic.row.key);
  const pages = createDriverAuditDeliveryView({ archive });
  reads.length = 0;
  writes.length = 0;
  return { head, archive, pages, objects, reads, writes, poison, historicRef, savedDay, savedHistoric,
    extraKey, extraHistory, historic, corrupt: () => { corruptWrite = true; } };
}

function stagedOptions(head, changes, collectorRevision = 51) {
  return { head, changes, collectorRevision, sourceBodySha256: sha(`collector:${collectorRevision}`),
    visibleCutoffAt: `${today}T${collectorRevision === 51 ? '06:30' : '08:00'}:00.000Z` };
}

function selected(head, result) {
  return { ...head, deliveryView: result.deliveryView, sourceRevision: head.sourceRevision + 1,
    sourceBodySha256: sha(`publisher:${head.sourceRevision + 1}`) };
}

test('morning additions preserve the base and only write one case, one date and one root', async () => {
  const f = await fixture();
  f.poison.add(keyOf(f.historicRef));
  for (const page of f.savedDay.pages) {
    f.poison.add(keyOf(page.list));
    f.poison.add(keyOf(page.evidence));
  }
  const added = update(keyFor(previousDay, 0), { driver: 'a', version: 'morning' });
  const result = await f.pages.stage(stagedOptions(f.head, [added]));
  assert.deepEqual([result.changedRecords, result.changedDays, result.writtenObjects], [1, 1, 3]);
  assert.equal(f.writes.length, 3);
  for (const key of f.writes) assert.ok(f.reads.includes(key), 'new archive parts were read back');
  assert.equal(verifyDriverAuditDeliveryStage(result, f.head), true);
  assert.equal(verifyDriverAuditDeliveryStage({ ...result }, f.head), false);
  assert.equal(verifyDriverAuditDeliveryStage(result, { ...f.head, sourceRevision: 2 }), false);
  assert.equal(verifyDriverAuditDeliveryStage(result, { ...f.head, sourceBodySha256: sha('racer') }), false);
  const next = selected(f.head, result), index = await f.pages.index(next);
  assert.equal(index.records, 47);
  assert.equal(index.generation, result.deliveryView.ref.sha256);
  assert.equal(index.reportHash, f.head.reportHash);
  assert.deepEqual(index.days.find(value => value.day === historicDay).ref, f.historicRef);
  assert.equal(await f.pages.hasCase(f.head, added.key), false);
  assert.equal(await f.pages.hasCase(next, added.key), true);
  assert.equal(await f.pages.materialHash(next, keyFor(previousDay, 1)), null);
  assert.equal(await f.pages.materialHash(next, added.key), added.sourceHash);
  assert.deepEqual(await f.pages.list(next, { day: previousDay, driver: 'a' }), {
    day: previousDay, records: 46, total: 1, drivers: [
      { id: 'a', name: 'a driver', records: 1 }, { id: 'b', name: 'b driver', records: 45 },
    ], totals: [['delivered', 46]], rows: [added.entry.summary], next: null,
  });
  f.poison.clear();
  const date = await f.pages.list(next, { day: previousDay });
  const following = await f.pages.list(next, { day: previousDay, offset: date.next });
  assert.deepEqual([...date.rows, ...following.rows].map(({ key }) => key),
    Array.from({ length: 46 }, (_, i) => keyFor(previousDay, i)));
  assert.deepEqual(await f.pages.record(next, f.historic.row.key), { ...f.savedHistoric,
    generation: f.head.generation, reportHash: f.head.reportHash, catalog: f.historic.catalog });
});

test('noon updates only a changed delivery and retains the previous version and original history', async () => {
  const f = await fixture();
  const key = keyFor(today, 1), morningChange = update(key, { version: 'morning' });
  const morning = selected(f.head, await f.pages.stage(stagedOptions(f.head, [morningChange])));
  f.poison.add(keyOf(f.historicRef));
  f.writes.length = 0;
  f.reads.length = 0;
  const replacement = update(key, { version: 'noon', driver: 'c', status: 'rejected' });
  const noonResult = await f.pages.stage(stagedOptions(morning, [replacement], 52));
  const noon = selected(morning, noonResult);
  assert.deepEqual([noonResult.changedRecords, noonResult.changedDays, noonResult.writtenObjects], [1, 1, 3]);
  assert.equal(f.reads.includes(keyOf(f.savedDay.pages[0].evidence)), false);
  assert.deepEqual((await f.pages.list(noon, { day: today })).totals, [['rejected', 1]]);
  assert.deepEqual((await f.pages.list(morning, { day: today })).totals, [['delivered', 1]]);
  assert.equal((await f.pages.record(noon, key)).gpsRow.assessmentHash, replacement.entry.gpsRow.assessmentHash);
  assert.equal((await f.pages.record(morning, key)).gpsRow.assessmentHash, morningChange.entry.gpsRow.assessmentHash);
  assert.deepEqual((await f.pages.record(noon, key)).retainedHistory, [{ history: morningChange.entry.history,
    generation: morningChange.entry.generation, reportHash: morningChange.entry.reportHash, catalog: morningChange.entry.catalog }]);
  assert.deepEqual((await f.pages.record(noon, key)).retainedReviews,
    [{ review: morningChange.entry.review, issues: morningChange.entry.issues }]);
  assert.deepEqual(await f.pages.stage(stagedOptions(noon, [replacement], 52)), {
    deliveryView: noon.deliveryView, changedRecords: 0, changedDays: 0, writtenObjects: 0,
  });
  assert.equal(f.writes.length, 3);
});

test('a delivery returning to the list keeps its original history-only evidence reachable', async () => {
  const f = await fixture();
  assert.equal(await f.pages.hasCase(f.head, f.extraKey), false);
  assert.deepEqual(await f.pages.additionalCases(f.head, previousDay), [{ record: f.extraKey, versions: 1 }]);
  const change = update(f.extraKey, { version: 'morning' });
  const next = selected(f.head, await f.pages.stage(stagedOptions(f.head, [change])));
  assert.equal(await f.pages.hasCase(next, f.extraKey), true);
  assert.equal((await f.pages.index(next)).days.find(value => value.day === previousDay).extraCases, 0);
  assert.deepEqual(await f.pages.additionalCases(next, previousDay), []);
  assert.deepEqual((await f.pages.additionalHistory(next, f.extraKey)).history,
    { staff: null, source: f.extraHistory });
  assert.deepEqual((await f.pages.record(next, f.extraKey)).retainedHistory,
    [{ history: { staff: null, source: f.extraHistory }, generation: f.head.generation,
      reportHash: f.head.reportHash, catalog: f.historic.catalog }]);
});

test('noon can apply deferred changes from the exact same captured source revision', async () => {
  const f = await fixture();
  const newCase = update(keyFor(today, 1), { version: 'morning' });
  const originalKey = keyFor(previousDay, 42);
  const deferredCase = update(originalKey, { version: 'noon', driver: 'c', status: 'failed' });
  const morning = selected(f.head, await f.pages.stage(stagedOptions(f.head, [newCase])));
  f.poison.add(keyOf(f.historicRef));
  f.poison.add(keyOf(f.savedDay.pages[0].evidence));
  f.poison.add(keyOf(f.savedDay.pages[0].list));
  f.writes.length = 0;
  const options = stagedOptions(morning, [deferredCase]);
  await assert.rejects(f.pages.stage({ ...options, sourceBodySha256: sha('same revision different bytes') }), /move backwards/);
  assert.deepEqual(f.writes, []);
  const noon = selected(morning, await f.pages.stage(options));
  assert.equal(noon.deliveryView.collectorRevision, morning.deliveryView.collectorRevision);
  assert.equal(noon.deliveryView.sourceBodySha256, morning.deliveryView.sourceBodySha256);
  assert.equal(f.writes.length, 3);
  assert.deepEqual((await f.pages.list(noon, { day: previousDay, driver: 'c' })).rows, [deferredCase.entry.summary]);
  assert.equal((await f.pages.record(morning, originalKey)).summary.status, 'delivered');
  assert.equal((await f.pages.record(noon, originalKey)).summary.status, 'failed');
  assert.deepEqual((await f.pages.record(noon, originalKey)).retainedHistory[0].history.staff,
    savedCase(originalKey).history.staff);
  const morningDate = (await f.pages.index(morning)).days.find(({ day }) => day === today);
  assert.deepEqual((await f.pages.index(noon)).days.find(({ day }) => day === today), morningDate);
});

test('GPS-only changes apply once and leave prior review identities and missing GPS polls intact', async () => {
  const f = await fixture();
  const key = keyFor(previousDay, 9), source = update(key, { version: 'same-delivery-material' });
  const first = { ...source, gpsHash: sha('morning raw GPS') };
  const morning = selected(f.head, await f.pages.stage(stagedOptions(f.head, [first])));
  const gpsOnly = { ...first, gpsHash: sha('later GPS evidence'), entry: { ...first.entry,
    gpsRow: { ...first.entry.gpsRow, assessmentHash: sha('updated assessment') } } };
  const noon = selected(morning, await f.pages.stage(stagedOptions(morning, [gpsOnly], 52)));
  const directory = await f.pages.directory(noon, previousDay);
  assert.equal(directory.sourceHashes.get(key), first.sourceHash);
  assert.equal(directory.gpsHashes.get(key), gpsOnly.gpsHash);
  const currentCase = await f.pages.record(noon, key);
  assert.equal(currentCase.gpsRow.assessmentHash, gpsOnly.entry.gpsRow.assessmentHash);
  assert.deepEqual(currentCase.retainedReviews, [{ review: savedCase(key).review, issues: savedCase(key).issues }]);
  assert.deepEqual((await f.pages.record(morning, key)).gpsRow, first.entry.gpsRow);
  f.writes.length = 0;
  const outOfScope = { ...gpsOnly, gpsHash: null };
  const result = await f.pages.stage(stagedOptions(noon, [outOfScope], 53));
  assert.deepEqual(result.deliveryView, noon.deliveryView);
  assert.equal(result.changedRecords, 0);
  assert.deepEqual(f.writes, []);
});

test('a failed archive readback cannot produce a new selected view', async () => {
  const f = await fixture();
  f.corrupt();
  const change = update(keyFor(today, 1), { version: 'morning' });
  await assert.rejects(f.pages.stage(stagedOptions(f.head, [change])), /failed verification/);
  assert.equal(f.writes.length, 1);
  assert.equal(await f.pages.hasCase(f.head, change.key), false);
  assert.equal((await f.pages.index(f.head)).generation, f.head.generation);
});
