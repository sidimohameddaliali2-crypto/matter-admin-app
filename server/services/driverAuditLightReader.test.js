import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { createDriverAuditIntegration } from './driverAuditIntegration.js';
import { createDriverAuditDeliveryView } from './driverAuditDeliveryView.js';
import { createDriverAuditLightArchive, stageDriverAuditLightView } from './driverAuditLightArchive.js';
import { createDriverAuditLightReader } from './driverAuditLightReader.js';
import { archiveBytes, archiveCatalog } from '../vendor/driver-audits/integration/cloud/repository.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const day = '2026-11-18', olderDay = '2025-11-05';
const refOf = (kind, value) => {
  const bytes = Buffer.from(JSON.stringify(value)), sha256 = sha(bytes);
  return { bytes: gzipSync(bytes), sha256, url: 'report-data/' + kind + '-' + sha256 + '.json' };
};
const reviewer = { id: 'matter:fixture-staff', role: 'reviewer', email: 'reviewer@example.invalid' };
const viewer = { ...reviewer, role: 'viewer' };
const csrf = 'a'.repeat(64);

async function fixture({ deliveryReview = true, extraIssue = false } = {}) {
  const blobs = new Map(), reads = [], writes = [];
  const archive = {
    async readObject(key, { maxBytes }) {
      reads.push(key);
      if (!blobs.has(key)) throw Object.assign(Error('Missing fixture archive object'), { code: 'ENOENT' });
      const bytes = blobs.get(key);
      assert.ok(bytes.length <= maxBytes);
      return [bytes];
    },
    async putVerifiedObject(key, bytes) {
      assert.equal(key, sha(bytes) + '.gz');
      writes.push(key);
      blobs.set(key, Buffer.from(bytes));
      return { key, sha256: sha(bytes), verified: true };
    },
  };
  const head = { generation: sha('generation'), reportHash: sha('report'),
    visibleCutoffAt: '2026-11-18T07:00:00.000Z' };
  const makeCase = (date, number, driverId = 'driver-a') => {
    const key = date + '/delivery-' + String(number).padStart(2, '0');
    return {
      row: { key }, summary: { key, driverId, driverName: driverId, customer: 'Fictional delivery ' + number,
        status: 'delivered', outcome: 'within_window' },
      gpsRow: { key, date, assessmentHash: sha(key), delivery: { id: number, customer: 'Fictional customer' } },
      gps: null, photo: { sha256: null }, history: { staff: null, source: null },
      reviewRow: { key, findings: [] }, issues: [{ id: 'issue:' + key, deliveryId: key,
        evidence: { source_sha256: sha('delivery'), rule_version: 'fixture' } }],
    };
  };
  const old = makeCase(olderDay, 0);
  if (extraIssue) old.issues.push({ id: 'removed:' + old.row.key, deliveryId: old.row.key, title: 'Prior finding' });
  const rawPhoto = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwcB/UtqpEwAAAAASUVORK5CYII=', 'base64');
  old.photo.sha256 = sha(rawPhoto);
  const saved = { key: old.row.key, result: 'retained', source: { recorded: true } };
  const originalHistory = refOf('history', { rows: [saved] });
  const extraRecord = olderDay + '/original-source-only';
  const extra = refOf('history', { rows: [{ key: extraRecord, result: 'original' }] });
  const asset = async value => archiveBytes(archive, value.bytes, { domain: 'state', path: 'assets/' + value.url.slice(12) + '.gz' });
  const refs = await Promise.all([asset(originalHistory), asset(extra),
    archiveBytes(archive, rawPhoto, { domain: 'objects', path: old.photo.sha256 })]);
  const catalog = await archiveCatalog(archive, refs);
  const history = ({ bytes, ...value }) => ({ ...value, count: 1 });
  old.history.staff = history(originalHistory);
  old.history.source = old.history.staff;
  const newest = Array.from({ length: 45 }, (_, index) => makeCase(day, index, index < 37 ? 'driver-a' : 'driver-b'));
  const projection = { days: new Map([[olderDay, [old]], [day, newest]]),
    context: { generation: head.generation, reportHash: head.reportHash, cutoff: head.visibleCutoffAt,
      records: 46, history: { staffRows: 1 }, refs: { catalog },
      review: { snapshotHash: head.reportHash, deliveryReview }, reviewResolved: true,
      gpsStreamRefs: {}, gpsEvidenceRefs: {}, gpsMetadata: {}, extraSourceHistoryCases: { [extraRecord]: history(extra) } } };
  head.lightView = await stageDriverAuditLightView({ projection, head, archive });
  return { archive, blobs, reads, writes, head, projection, old, saved, extraRecord, rawPhoto };
}

test('the initial date and first delivery page load only the specific immutable objects', async () => {
  const { archive, head, reads, old } = await fixture();
  const reader = createDriverAuditLightArchive({ archive });
  assert.deepEqual((await reader.index(head)).days.map(value => value.day), [day, olderDay]);
  assert.equal(reads.length, 1);
  const first = await reader.list(head, { day });
  assert.equal(first.rows.length, 40);
  assert.equal(first.next, 40);
  assert.equal(reads.length, 3);
  assert.equal((await reader.list(head, { day })).rows.length, 40);
  assert.equal(reads.length, 3, 'unchanged date and page remain cached');
  assert.equal((await reader.list(head, { day, driver: 'driver-b' })).rows.length, 8);
  assert.equal(reads.length, 4, 'a driver spanning two pages reads only the additional page');
  assert.equal((await reader.list(head, { day: olderDay })).rows[0].key, old.row.key);
  await assert.rejects(reader.record(head, day + '/missing'), { status: 404 });
});

test('publication writes only the new catalogue and changed page objects', async () => {
  const { archive, head, projection, writes } = await fixture();
  const next = { ...head, generation: sha('next'), reportHash: sha('new report') };
  const nextProjection = structuredClone(projection);
  nextProjection.context.generation = next.generation;
  nextProjection.context.reportHash = next.reportHash;
  nextProjection.context.review.snapshotHash = next.reportHash;
  nextProjection.days.get(day).at(-1).summary.outcome = 'late';
  writes.length = 0;
  next.lightView = await stageDriverAuditLightView({ projection: nextProjection, head: next, previous: head, archive });
  assert.equal(writes.length, 4, 'only one delivery page, its evidence, the date and the root change');
  const reader = createDriverAuditLightArchive({ archive });
  const initial = await reader.index(head), updated = await reader.index(next);
  assert.deepEqual(initial.days[1], updated.days[1]);
  assert.equal((await reader.list(next, { day, offset: 40 })).rows.at(-1).outcome, 'late');
  assert.equal((await reader.list(head, { day, offset: 40 })).rows.at(-1).outcome, 'within_window');
  writes.length = 0;
  assert.deepEqual(await stageDriverAuditLightView({ projection: nextProjection, head: next, previous: next, archive }), next.lightView);
  assert.deepEqual(writes, []);
});

test('a saved date projection cannot be attached to a different report generation or cutoff', async () => {
  const { archive, head, projection, writes } = await fixture();
  writes.length = 0;
  for (const update of [{ generation: sha('another') }, { reportHash: sha('another') },
    { visibleCutoffAt: '2026-11-18T07:01:00.000Z' }]) {
    await assert.rejects(stageDriverAuditLightView({ projection, head: { ...head, ...update }, archive }),
      /original report identity/);
  }
  assert.equal(writes.length, 0);
});

test('the existing report route opens with exact old date evidence and staff review save and reload', async t => {
  const f = await fixture();
  let state = { body: null, revision: 0 }, legacyPolls = 0, openedDb = 0;
  let integration;
  const server = createServer((req, res) => integration(req, res, () => res.writeHead(404).end()));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const rpc = async (name, args) => {
    assert.equal(args.p_key, 'preview-gps-map-20261106:review-journal');
    if (name === 'matter_hosted_state_read') return { revision: state.revision, body_text: state.body };
    assert.equal(name, 'matter_hosted_state_cas');
    assert.equal(args.p_expected, state.revision);
    state = { body: args.p_body_text, revision: state.revision + 1 };
    return { revision: state.revision, body_text: state.body, body_sha256: sha(state.body),
      event_text: args.p_event_text, replayed: false };
  };
  integration = createDriverAuditIntegration({ db: () => { openedDb++; assert.fail('unexpected Mongo'); },
    env: { DRIVER_AUDIT_ORIGIN: origin, DRIVER_AUDIT_SERVING_STORE: 'supabase',
      DRIVER_AUDIT_ENABLED: '1', DRIVER_AUDIT_IMPORT_ENABLED: '0', DRIVER_AUDIT_LIGHT_READER: '1' },
    dependencies: {
      backend: { kind: 'supabase', executionHost: 'sidi', archive: f.archive, rpc, rpcForResponseLimit: () => rpc },
      store: { head: async () => f.head },
      budget: { reserve: async () => ({ allowed: true }), settle: async () => ({ settled: true }) },
      createCoordinator: () => ({ status: () => ({}), poll: () => { legacyPolls++; assert.fail('legacy package loaded'); } }),
      auth: {
        issue: async () => ({ cookie: 'Staff=reviewer' }),
        authenticate: async cookie => {
          if (!cookie) throw Object.assign(Error('Sign in'), { status: 401 });
          return { actor: cookie === 'Staff=reviewer' ? reviewer : viewer, csrf };
        },
        csrfMatches: (left, right) => left === right,
      },
    },
  });
  const visit = (url, { headers = {}, ...options } = {}) => fetch(origin + url, {
    ...options, headers: { host: new URL(origin).host, cookie: 'Staff=reviewer', ...headers },
  });
  assert.equal((await visit('/api/driver-audits/session', { method: 'POST', headers: { origin,
    authorization: 'Bearer fixture', 'content-type': 'application/json', 'x-driver-audit-client': 'reporting-v1' }, body: '{}' })).status, 200);
  assert.equal(await integration.prewarm(), true);
  assert.equal(await integration.isPreparedFor(f.head), true);
  assert.match(await (await visit('/api/reporting/view?staffFrame=1')).text(), /meta name="matter-driver-reports"/);
  const request = (route, values = {}, options) => visit('/api/reporting/light/' + route + '?' + new URLSearchParams({
    generation: f.head.generation, ...values,
  }), options);
  assert.equal((await request('dates', {}, { headers: { cookie: '' } })).status, 401);
  assert.equal((await (await request('dates')).json()).records, 46);
  const record = f.old.row.key;
  const photo = await request('photo', { record });
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get('x-report-image-sha256'), sha(f.rawPhoto));
  assert.deepEqual(Buffer.from(await photo.arrayBuffer()), f.rawPhoto);
  assert.equal((await (await request('gps', { record })).json()).status, 'unavailable');
  assert.deepEqual((await (await request('history', { record })).json()).staff, [f.saved]);
  assert.deepEqual(await (await request('source-cases', { day: olderDay })).json(), [{ record: f.extraRecord, versions: 1 }]);
  assert.equal((await (await request('source-history', { record: f.extraRecord })).json()).additionalSource.length, 1);
  const issueId = f.old.issues[0].id;
  const input = { issueId, snapshotHash: f.head.reportHash, eventId: '11111111-2222-4333-8444-555555555555',
    expectedRevision: 0, status: 'investigating', response: 'Fictional test review', responsiblePerson: '', followUpDate: '' };
  const save = headers => request('reviews', { record, issueId }, { method: 'POST',
    headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(input) });
  assert.equal((await save({})).status, 403);
  assert.equal((await save({ 'x-reporting-token': csrf, cookie: 'Staff=viewer' })).status, 403);
  assert.deepEqual(await (await save({ 'x-reporting-token': csrf })).json(), { revision: 1, replayed: false });
  const reload = await (await request('reviews', { record, issueId }, { headers: { cookie: 'Staff=viewer' } })).json();
  assert.equal(reload.history[0].data.response, input.response);
  assert.equal(reload.history[0].data.actorId, reviewer.id);
  assert.equal(openedDb, 0);
  assert.equal(legacyPolls, 0);
  assert.equal((await request('case', { record, generation: sha('retired') })).status, 409);
});

test('a changed delivery exposes original snapshot replies and keeps a removed finding read-only', async t => {
  const f = await fixture({ deliveryReview: false, extraIssue: true });
  const prior = { ...f.head, sourceRevision: 1, sourceBodySha256: sha('base publication') };
  let active = prior, state = { body: null, revision: 0 };
  const reader = createDriverAuditLightReader({ store: { head: async () => active }, archive: f.archive,
    rpcForResponseLimit: () => async (name, args) => {
      assert.equal(args.p_key, 'preview-gps-map-20261106:review-journal');
      if (name === 'matter_hosted_state_read') return { revision: state.revision, body_text: state.body };
      assert.equal(name, 'matter_hosted_state_cas');
      assert.equal(args.p_expected, state.revision);
      state = { body: args.p_body_text, revision: state.revision + 1 };
      return { revision: state.revision, body_text: state.body, body_sha256: sha(state.body),
        event_text: args.p_event_text, replayed: false };
    },
  });
  const server = createServer((req, res) => reader.handle(req, res, new URL(req.url, 'http://fixture.invalid'),
    { actor: reviewer, csrf }, { csrfMatches: (left, right) => left === right }).catch(error => {
    res.writeHead(error.status ?? 500).end();
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const record = f.old.row.key, [sameIssue, removedIssue] = f.old.issues;
  const request = (route, fields = {}, options = {}, generation = active.deliveryView?.ref.sha256 ?? active.generation) =>
    fetch(`http://127.0.0.1:${server.address().port}/api/reporting/light/${route}?${new URLSearchParams({
      generation, record, ...fields,
    })}`, options);
  const save = (issueId, snapshotHash, eventId, generation) => request('reviews', { issueId }, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-reporting-token': csrf },
    body: JSON.stringify({ issueId, snapshotHash, eventId, expectedRevision: 0,
      status: 'investigating', response: 'Fictional retained response', responsiblePerson: '', followUpDate: '' }),
  }, generation);
  const eventIds = ['11111111-2222-4333-8444-555555555555', '22222222-2222-4333-8444-555555555555',
    '33333333-2222-4333-8444-555555555555'];
  assert.equal((await save(sameIssue.id, prior.reportHash, eventIds[0])).status, 200);
  assert.equal((await save(removedIssue.id, prior.reportHash, eventIds[1])).status, 200);
  const savedBefore = state.body, originalEvents = JSON.parse(savedBefore).records.reportingReviews;
  assert.equal(originalEvents[0].data.reviewScope, 'snapshot');

  const pages = createDriverAuditDeliveryView({ archive: f.archive });
  const earlier = await pages.record(prior, record), nextSnapshot = sha('new review snapshot');
  const result = await pages.stage({ head: prior, collectorRevision: 2, sourceBodySha256: sha('collector'),
    visibleCutoffAt: '2026-11-18T08:00:00.000Z', changes: [{ key: record, sourceHash: sha('changed case'), entry: {
      ...earlier, history: { staff: null, source: null }, summary: { ...earlier.summary, status: 'failed' },
      reportHash: nextSnapshot, review: { snapshotHash: nextSnapshot, deliveryReview: false }, issues: [sameIssue],
    } }],
  });
  active = { ...prior, sourceRevision: 2, sourceBodySha256: sha('updated publication'), deliveryView: result.deliveryView };
  assert.equal(await reader.prewarm(), true);
  const options = await (await request('case')).json();
  assert.deepEqual(options.issues, [{ id: sameIssue.id, label: null },
    { id: removedIssue.id, label: removedIssue.title, archived: true }]);
  const continuing = await (await request('reviews', { issueId: sameIssue.id })).json();
  assert.equal(continuing.snapshotHash, nextSnapshot);
  assert.equal(continuing.revision, 0);
  assert.deepEqual(continuing.history, []);
  assert.deepEqual(continuing.archivedHistory, [originalEvents[0]]);
  const removed = await (await request('reviews', { issueId: removedIssue.id })).json();
  assert.equal(removed.historicalOnly, true);
  assert.deepEqual(removed.archivedHistory, [originalEvents[1]]);
  assert.equal((await save(removedIssue.id, nextSnapshot, eventIds[2])).status, 409);
  assert.equal((await save(removedIssue.id, prior.reportHash, eventIds[2], prior.generation)).status, 409);
  assert.equal(state.body, savedBefore);
  assert.deepEqual(await (await request('history')).json(), { staff: [f.saved], additionalSource: [] });
  const before = await request('photo', {}, {}, prior.generation), after = await request('photo');
  assert.equal(after.headers.get('x-report-image-sha256'), before.headers.get('x-report-image-sha256'));
  assert.deepEqual(Buffer.from(await before.arrayBuffer()), Buffer.from(await after.arrayBuffer()));
  assert.equal((await save(sameIssue.id, nextSnapshot, eventIds[2])).status, 200);
  const events = JSON.parse(state.body).records.reportingReviews;
  assert.deepEqual(events.slice(0, 2), originalEvents);
  assert.equal(events[2].data.snapshotHash, nextSnapshot);
});
