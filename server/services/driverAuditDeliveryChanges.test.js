import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { archiveBytes, archiveCatalog } from '../vendor/driver-audits/integration/cloud/repository.mjs';
import { planDriverAuditDeliveryChanges, readDriverAuditDeliverySource } from './driverAuditDeliveryChanges.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => sha(JSON.stringify(value));
const morning = '2026-11-18T06:30:00.000Z';
const noon = '2026-11-18T08:00:00.000Z';
const date = '2026-11-18', priorDate = '2026-11-17';
const originalCapture = '2026-11-18T05:00:00.000Z';
const laterCapture = '2026-11-18T06:00:00.000Z';

function delivery(id, { day = date, driver = 'driver-one', vehicle = null, photo = null, tier = 0 } = {}) {
  const key = `${day}/${id}`;
  return { key, date: day, tier, assessmentHash: digest([key, tier, photo]),
    delivery: { delivery_id: id, driver_id: driver, vehicle, upload: '2026-11-17T20:10:00.000Z',
      source_sha256: digest([key, driver, vehicle, photo]), photo_sha256: photo } };
}

async function archiveFixture(rows, { revision = 7, gps = [], history = [], captureClock = originalCapture, gpsScope } = {}) {
  const objects = new Map(), reads = new Set(), byName = new Map();
  const archive = {
    async putVerifiedObject(key, bytes) {
      objects.set(key, Buffer.from(bytes));
      return { verified: true, sha256: sha(bytes) };
    },
    async readObject(key) {
      reads.add(key);
      if (!objects.has(key)) throw Object.assign(Error('Fixture object is unavailable'), { code: 'ENOENT' });
      return [objects.get(key)];
    },
  };
  const files = [];
  async function save(domain, path, bytes) {
    const file = await archiveBytes(archive, bytes, { domain, path });
    files.push(file);
    byName.set(path, file);
    return file;
  }
  async function asset(kind, value, count) {
    const bytes = Buffer.from(JSON.stringify(value)), sha256 = sha(bytes);
    const name = `${kind}-${sha256}.json`;
    await save('state', `assets/${name}.gz`, gzipSync(bytes));
    return { url: `report-data/${name}`, sha256, ...(count === undefined ? {} : { count }) };
  }
  const details = {}, histories = {};
  for (const row of rows) details[row.key] = await asset('detail', { rows: [row] }, 1);
  for (const row of history) histories[row.key] = await asset('history', { rows: [row] }, 1);
  const reportHash = digest(rows.map(row => [row.key, row.assessmentHash]));
  const historyId = 'reporting_validated_history', queryId = 'reporting_validated_deliveries_summary';
  const summaries = rows.map(row => ({ ...row, delivery: { ...row.delivery, photo_sha256: undefined } }));
  const manifest = await asset('snapshot', { matter: { validatedReporting: { snapshotHash: reportHash, queryId, historyId },
    lazyDeliveryDetails: { cases: details }, lazyQueries: { [historyId]: { count: history.length, cases: histories } } },
  queries: { [queryId]: { rows: summaries } } });
  const gpsState = {}, states = [], windows = [];
  for (const { namespace, driverId, scopeKind = 'driver', day = date, vehicleNo, material } of gps) {
    const snapshotSha256 = digest(material), observationSha256 = digest([material, captureClock]);
    const window = { namespace, driverId, day, snapshotSha256, observationSha256, fetchedAt: captureClock };
    const body = Buffer.from(JSON.stringify({ version: 1, scope: { kind: scopeKind },
      windows: { [`${driverId}/${day}`]: { ...window, scopeKind, ...(vehicleNo ? { vehicleNo } : {}) } } }));
    const stateSha = sha(body);
    gpsState[namespace] = { stateManifest: await save('gps', `${namespace}/states/${stateSha}.json`, body) };
    states.push({ namespace, scopeKind, sha256: stateSha });
    windows.push(window);
  }
  let gpsPointer;
  if (states.length > 0) {
    const receipt = { version: 1, scope: gpsScope ?? { from: priorDate, to: date }, states, windows, observedAt: captureClock };
    const body = Buffer.from(JSON.stringify({ ...receipt, sha256: digest(receipt) }));
    const sha256 = sha(body), path = `gps-publications/${sha256}.json`;
    await save('state', path, body);
    gpsPointer = { path, sha256, observedAt: captureClock };
  }
  const catalog = await archiveCatalog(archive, files);
  const publication = { version: 1, revision, catalog, gpsState, head: {
    reportHash, manifest, records: rows.length, history: history.length, gps: gpsPointer } };
  return { archive, publication, objects, byName, reads, details, histories,
    async read() {return readDriverAuditDeliverySource({ publication, archive });} };
}

function published(initial, applied = []) {
  const directories = new Map(), lookups = [];
  const add = row => {
    if (!directories.has(row.date)) directories.set(row.date, { positions: new Map(), sourceHashes: new Map(), gpsHashes: new Map() });
    return directories.get(row.date);
  };
  for (const row of initial) {
    const { positions } = add(row);
    positions.set(row.key, positions.size);
  }
  for (const candidate of applied) {
    const { positions, sourceHashes, gpsHashes } = add({ date: candidate.day });
    if (!positions.has(candidate.key)) positions.set(candidate.key, positions.size);
    sourceHashes.set(candidate.key, candidate.sourceHash);
    if (candidate.gpsHash) gpsHashes.set(candidate.key, candidate.gpsHash);
  }
  return { lookups, async index() {
    return { days: [...directories.keys()].map(day => ({ day })) };
  }, async directory(_head, day) {
    lookups.push(day);
    return directories.get(day);
  }, async materialHash() { throw Error('Repeated per-record lookups are unnecessary'); } };
}

test('morning selects only missing keys and the same source revision corrects existing cases at noon', async () => {
  const saved = delivery('saved'), updated = delivery('saved', { tier: 2 }), second = delivery('new');
  const omitted = delivery('retained', { day: priorDate });
  const baselineFixture = await archiveFixture([saved, omitted], { revision: 6 });
  const latestFixture = await archiveFixture([updated, second]);
  const [baseline, latest] = await Promise.all([baselineFixture.read(), latestFixture.read()]);
  const before = new Set(latestFixture.reads), pages = published([saved, omitted]);
  const head = {};
  const first = await planDriverAuditDeliveryChanges({ scheduledAt: morning, head, pages, baseline, latest });
  assert.deepEqual(first.selected.map(row => row.key), [second.key]);
  assert.deepEqual([first.newCount, first.changedCount, first.deferredCount], [1, 0, 1]);
  assert.deepEqual(pages.lookups, [date]);
  const membershipOnly = await planDriverAuditDeliveryChanges({ scheduledAt: morning, head, pages, latest });
  assert.deepEqual(membershipOnly.selected.map(row => row.key), [second.key]);
  assert.equal(membershipOnly.deferredCount, 0);

  const next = await planDriverAuditDeliveryChanges({ scheduledAt: noon, head, pages: published([saved, omitted], first.selected), baseline, latest });
  assert.deepEqual(next.selected.map(row => row.key), [updated.key]);
  assert.deepEqual([next.newCount, next.changedCount], [0, 1]);
  const repeat = await planDriverAuditDeliveryChanges({ scheduledAt: noon, head,
    pages: published([saved, omitted], [...first.selected, ...next.selected]), baseline, latest });
  assert.deepEqual(repeat.selected, []);
  assert.deepEqual(latestFixture.reads, before);
  assert.equal(latest.cases.has(omitted.key), false);

  const missed = await planDriverAuditDeliveryChanges({ scheduledAt: noon, head, pages, baseline, latest });
  assert.deepEqual(missed.selected.map(row => row.key), [updated.key, second.key]);
});

test('late GPS and corrected photo select only their material cases and keep original clocks', async () => {
  const sameDriver = delivery('gps'), otherDriver = delivery('different', { driver: 'driver-two' });
  const proof = delivery('photo', { driver: 'driver-other', photo: digest('image-original') });
  const corrected = delivery('photo', { driver: 'driver-other', photo: digest('image-corrected') });
  const raw = { namespace: 'saved-one', driverId: 'driver-one', day: priorDate, material: 'points before' };
  const unrelated = { namespace: 'other', driverId: 'driver-missing', day: date, material: 'other before' };
  const baseFixture = await archiveFixture([sameDriver, proof, otherDriver], { revision: 6, gps: [raw, unrelated] });
  const fixture = await archiveFixture([sameDriver, corrected, otherDriver], { gps: [
    { ...raw, material: 'points after' }, { ...unrelated, material: 'other after' },
  ], captureClock: laterCapture });
  const [baseline, latest] = await Promise.all([baseFixture.read(), fixture.read()]);
  const gps = latest.cases.get(sameDriver.key);
  assert.equal(gps.inputs.gpsCoverage.uploadDay, date);
  assert.equal(gps.inputs.gps.length, 1);
  assert.equal(gps.inputs.gps[0].day, priorDate);
  assert.equal(gps.inputs.gps[0].fetchedAt, laterCapture);
  assert.equal(latest.gpsAsOf, laterCapture);
  assert.equal(gps.sourceHash, baseline.cases.get(sameDriver.key).sourceHash);
  assert.notEqual(gps.gpsHash, baseline.cases.get(sameDriver.key).gpsHash);
  const result = await planDriverAuditDeliveryChanges({ scheduledAt: noon, head: {},
    pages: published([sameDriver, proof, otherDriver]), baseline, latest });
  assert.deepEqual(result.selected.map(row => row.key), [sameDriver.key, corrected.key]);
  assert.notEqual(latest.cases.get(corrected.key).sourceHash, baseline.cases.get(proof.key).sourceHash);
});

test('an unchanged GPS poll or an expired GPS scope does not rebuild a published delivery', async () => {
  const row = delivery('gps');
  const gps = { namespace: 'saved-one', driverId: 'driver-one', material: 'the same points' };
  const baseFixture = await archiveFixture([row], { revision: 6, gps: [gps] });
  const newPoll = await archiveFixture([row], { gps: [gps], captureClock: laterCapture });
  const outOfScope = await archiveFixture([row], { revision: 8, gps: [{ ...gps, day: '2026-11-19' }],
    gpsScope: { from: '2026-11-19', to: '2026-11-19' } });
  const baseline = await baseFixture.read();
  const pages = published([row]);
  for (const fixture of [newPoll, outOfScope]) {
    const latest = await fixture.read();
    const plan = await planDriverAuditDeliveryChanges({ scheduledAt: noon, head: {}, pages, baseline, latest });
    assert.deepEqual(plan.selected, []);
  }
});

test('the first verified GPS window applies once to a delivery published without a window at 10:30', async () => {
  const row = delivery('new'), head = {};
  const other = { namespace: 'other', driverId: 'driver-other', material: 'verified unrelated points' };
  const initial = await archiveFixture([row], { gps: [other] });
  const morningSource = await initial.read();
  const first = await planDriverAuditDeliveryChanges({ scheduledAt: morning, head, pages: published([]), latest: morningSource });
  assert.deepEqual(first.selected.map(candidate => candidate.key), [row.key]);
  assert.equal(first.selected[0].gpsHash, null);

  const gps = { namespace: 'saved-one', driverId: 'driver-one', material: 'first verified points' };
  const arrived = await archiveFixture([row], { gps: [other, gps], captureClock: laterCapture });
  const noonSource = await arrived.read();
  assert.equal(noonSource.cases.get(row.key).sourceHash, first.selected[0].sourceHash);
  const noonPlan = await planDriverAuditDeliveryChanges({ scheduledAt: noon, head,
    pages: published([], first.selected), latest: noonSource });
  assert.deepEqual(noonPlan.selected.map(candidate => candidate.key), [row.key]);
  assert.deepEqual([noonPlan.newCount, noonPlan.changedCount, noonPlan.heldGpsCount], [0, 1, 0]);

  const saved = published([], noonPlan.selected);
  const repeated = await archiveFixture([row], { revision: 8, gps: [gps] });
  const expired = await archiveFixture([row], { revision: 9, gps: [{ ...gps, day: '2026-11-19' }],
    gpsScope: { from: '2026-11-19', to: '2026-11-19' } });
  for (const next of [arrived, repeated, expired]) {
    const result = await planDriverAuditDeliveryChanges({ scheduledAt: noon, head, pages: saved, latest: await next.read() });
    assert.deepEqual(result.selected, []);
  }
});

test('an unavailable historic GPS receipt leaves stored cases alone and flags the unresolved comparison', async () => {
  const row = delivery('established'), added = delivery('new');
  const gps = { namespace: 'saved-one', driverId: 'driver-one', material: 'saved points' };
  const historical = await archiveFixture([row], { revision: 6, gps: [gps] });
  const latest = await archiveFixture([row, added], { gps: [{ ...gps, material: 'more points' }] });
  const missing = historical.byName.get(historical.publication.head.gps.path);
  historical.objects.delete(`${missing.sha256}.gz`);
  await assert.rejects(historical.read(), { code: 'ENOENT' });
  const baseline = await readDriverAuditDeliverySource({ ...historical, comparisonOnly: true });
  assert.equal(baseline.gpsStatus, 'historical-reference-unavailable');
  const selection = await planDriverAuditDeliveryChanges({ scheduledAt: noon, head: {},
    pages: published([row]), baseline, latest: await latest.read() });
  assert.deepEqual(selection.selected.map(candidate => candidate.key), [added.key]);
  assert.equal(selection.heldGpsCount, 1);
});

test('source integrity is verified before selection and case/history reads stay lazy', async () => {
  const row = delivery('one'), old = delivery('one', { tier: 1 }), historyOnly = delivery('archived', { day: priorDate });
  const fixture = await archiveFixture([row], { history: [old, historyOnly] });
  const source = await fixture.read();
  const detailFile = fixture.byName.get(`assets/${fixture.details[row.key].url.slice(12)}.gz`);
  const historyFile = fixture.byName.get(`assets/${fixture.histories[row.key].url.slice(12)}.gz`);
  const detailKey = `${detailFile.sha256}.gz`, historyKey = `${historyFile.sha256}.gz`;
  assert(!fixture.reads.has(detailKey));
  assert(!fixture.reads.has(historyKey));
  assert.deepEqual([...source.historyOnly.keys()], [historyOnly.key]);
  assert.deepEqual(await source.readCase(row.key), row);
  assert.deepEqual(await source.readHistory(row.key), [old]);
  assert(fixture.reads.has(detailKey));
  assert(fixture.reads.has(historyKey));
  const manifest = fixture.byName.get(`assets/${fixture.publication.head.manifest.url.slice(12)}.gz`);
  fixture.objects.set(`${manifest.sha256}.gz`, Buffer.alloc(manifest.size));
  await assert.rejects(fixture.read(), /integrity failure/);

  await assert.rejects(planDriverAuditDeliveryChanges({ scheduledAt: noon, head: {},
    pages: published([row]), latest: source }), /last published delivery source/);
});
