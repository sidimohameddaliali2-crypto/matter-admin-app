import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createHostedReviews } from '../vendor/driver-audits/integration/cloud/hosted-reviews.mjs';
import { createCloudState } from '../vendor/driver-audits/integration/cloud/cloud-state.mjs';

const implementation = await import('./driverAuditLightReviews.js').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const sha = value => createHash('sha256').update(value).digest('hex');
const key = 'preview-gps-map-20261106:review-journal';
const reviewer = { id: 'matter:fictional-reviewer', email: 'reviewer@example.invalid', role: 'reviewer' };
const older = { snapshotHash: sha('older immutable snapshot'), deliveryReview: true,
  issues: [{ id: 'original-older-issue', deliveryId: 'older-record' }],
  rows: [{ key: 'older-record', findings: [{ issue_id: 'saved-finding' }] }] };
const current = { snapshotHash: sha('current immutable snapshot'), deliveryReview: true,
  issues: [{ id: 'original-current-issue', deliveryId: 'current-record' }], rows: [{ key: 'current-record' }] };
const request = (snapshot, id) => ({ eventId: id, issueId: snapshot.issues[0].id, snapshotHash: snapshot.snapshotHash,
  expectedRevision: 0, status: 'investigating', response: 'Original staff response', responsiblePerson: 'Operations', followUpDate: '' });

async function fixture() {
  let row = { revision: 0, body: null }, loseAck = false;
  const calls = [], bounds = [], resolutions = [], snapshots = [older, current];
  async function rpc(name, args) {
    calls.push({ name, args: structuredClone(args) }); assert.equal(args.p_key, key);
    if (name === 'matter_hosted_state_read') return { revision: row.revision, body_text: row.body };
    assert.equal(name, 'matter_hosted_state_cas');
    if (args.p_expected !== row.revision) throw Object.assign(Error('Concurrent original journal'), { status: 409 });
    row = { revision: row.revision + 1, body: args.p_body_text };
    const receipt = { revision: row.revision, body_text: row.body, event_text: args.p_event_text,
      body_sha256: sha(row.body), replayed: false };
    if (loseAck) { loseAck = false; throw Error('Lost committed acknowledgement'); }
    return receipt;
  }
  const originals = createHostedReviews({ stateStore: createCloudState({ rpc }),
    snapshotFor: async hash => [older, current].find(snapshot => snapshot.snapshotHash === hash),
    clock: () => '2026-11-18T06:30:00.000Z', key });
  await originals.save(request(older, '00000000-0000-4000-8000-000000000001'), reviewer);
  await originals.save(request(current, '00000000-0000-4000-8000-000000000002'), reviewer);
  const saved = JSON.parse(row.body); saved.preferences.preserved = 'Other dates and preferences stay intact'; row.body = JSON.stringify(saved);
  assert.equal(typeof implementation.createDriverAuditLightReviews, 'function');
  const service = implementation.createDriverAuditLightReviews({
    rpcForResponseLimit(bytes) { bounds.push(bytes); return rpc; },
    async resolveIssue(hash, issueId, recordKey) {
      resolutions.push([hash, issueId, recordKey]);
      return snapshots.find(snapshot => snapshot.snapshotHash === hash);
    }, clock: () => '2026-11-18T08:00:00.000Z',
  });
  calls.length = 0;
  return { service, calls, bounds, resolutions, snapshots, get row() { return row; },
    setBody(body) { row = { ...row, body }; }, loseNextAck() { loseAck = true; } };
}

test('case reads use a small transport and keep hidden historical reviews available across reload', async () => {
  const f = await fixture();
  for (const snapshot of [current, older]) {
    const recordKey = snapshot.rows[0].key, issueId = snapshot.issues[0].id;
    const value = await f.service.readCase({ snapshotHash: snapshot.snapshotHash, issueId, recordKey }, { id: 'staff', role: 'viewer' });
    assert.equal(value.revision, 1); assert.equal(value.history.length, 1);
    assert.equal(value.history[0].data.snapshotHash, snapshot.snapshotHash);
    assert.equal(value.history[0].data.authorVerification, 'verified-hosted');
    assert.deepEqual(f.resolutions.at(-1), [snapshot.snapshotHash, issueId, recordKey]);
  }
  assert.ok(f.bounds.every(bytes => bytes === 512 * 1024));
  assert.equal(f.calls.some(call => call.name === 'matter_hosted_state_cas'), false);
});

test('an older exact case save preserves every other date and the original canonical CAS shape', async () => {
  const f = await fixture(), before = JSON.parse(f.row.body);
  const input = { ...request(older, '00000000-0000-4000-8000-000000000003'), expectedRevision: 1,
    findingId: 'saved-finding', response: 'Retained old-date finding checked' };
  const result = await f.service.save(input, reviewer, { recordKey: 'older-record' });
  assert.deepEqual(result, { revision: 2, replayed: false });
  const after = JSON.parse(f.row.body);
  assert.deepEqual(after.records.reportingReviews.slice(0, 2), before.records.reportingReviews);
  assert.deepEqual(after.preferences, before.preferences);
  const commit = f.calls.find(call => call.name === 'matter_hosted_state_cas');
  assert.equal(commit.args.p_expected, 2);
  assert.equal(Object.hasOwn(JSON.parse(commit.args.p_request_text).input, 'recordKey'), false);
  const reloaded = await f.service.readCase({ snapshotHash: older.snapshotHash, issueId: older.issues[0].id,
    recordKey: 'older-record' }, reviewer);
  assert.equal(reloaded.revision, 2); assert.equal(reloaded.history.at(-1).data.response, input.response);
});

test('lost committed acknowledgement replays the original event and clock without duplicate history', async () => {
  const f = await fixture(), input = { ...request(older, '00000000-0000-4000-8000-000000000004'), expectedRevision: 1 };
  f.loseNextAck(); await assert.rejects(f.service.save(input, reviewer, { recordKey: 'older-record' }));
  const body = f.row.body;
  assert.deepEqual(await f.service.save(input, reviewer, { recordKey: 'older-record' }), { revision: 2, replayed: true });
  assert.equal(f.row.body, body);
  assert.equal(f.calls.filter(call => call.name === 'matter_hosted_state_cas').length, 1);
  await assert.rejects(f.service.save({ ...input, response: 'Different retry content' }, reviewer, { recordKey: 'older-record' }),
    error => error.status === 409);
});

test('wrong record, snapshot, issue, stale revision and unverified role cannot write a review', async () => {
  for (const change of ['record', 'snapshot', 'issue', 'revision', 'role', 'finding']) {
    const f = await fixture(), before = f.row.body;
    const input = { ...request(older, '00000000-0000-4000-8000-000000000005'), expectedRevision: 1 };
    if (change === 'snapshot') input.snapshotHash = sha('unknown snapshot');
    if (change === 'issue') input.issueId = current.issues[0].id;
    if (change === 'revision') input.expectedRevision = 0;
    if (change === 'finding') input.findingId = 'not-in-original-case';
    await assert.rejects(f.service.save(input, change === 'role' ? { ...reviewer, role: 'viewer' } : reviewer,
      { recordKey: change === 'record' ? 'current-record' : 'older-record' }));
    assert.equal(f.row.body, before); assert.equal(f.calls.some(call => call.name === 'matter_hosted_state_cas'), false);
  }
});

test('oversized retained journals fail closed without truncating or rewriting history', async () => {
  const f = await fixture(), large = JSON.parse(f.row.body); large.preferences.large = 'x'.repeat(128 * 1024);
  f.setBody(JSON.stringify(large)); const before = f.row.body;
  await assert.rejects(f.service.readCase({ snapshotHash: older.snapshotHash, issueId: older.issues[0].id,
    recordKey: 'older-record' }, reviewer), error => error.code === 'AUDIT_REVIEW_CAPACITY');
  await assert.rejects(f.service.save({ ...request(older, '00000000-0000-4000-8000-000000000006'), expectedRevision: 1 },
    reviewer, { recordKey: 'older-record' }));
  assert.equal(f.row.body, before); assert.equal(f.calls.some(call => call.name === 'matter_hosted_state_cas'), false);
});

test('a journal that would grow outside its bound is rejected before the canonical CAS', async () => {
  const f = await fixture(), large = JSON.parse(f.row.body); large.preferences.large = 'x'.repeat(128 * 1024 - 3000);
  f.setBody(JSON.stringify(large)); assert(Buffer.byteLength(f.row.body) < 128 * 1024);
  const before = f.row.body;
  await assert.rejects(f.service.save({ ...request(older, '00000000-0000-4000-8000-000000000007'), expectedRevision: 1,
    response: 'x'.repeat(4000) }, reviewer, { recordKey: 'older-record' }), error => error.code === 'AUDIT_REVIEW_CAPACITY');
  assert.equal(f.row.body, before); assert.equal(f.calls.some(call => call.name === 'matter_hosted_state_cas'), false);
});

test('the original delivery-review scope carries its prior event across a newly retained snapshot', async () => {
  const f = await fixture(), refreshed = { ...older, snapshotHash: sha('refreshed same dated delivery') };
  f.snapshots.push(refreshed);
  const result = await f.service.readCase({ snapshotHash: refreshed.snapshotHash, issueId: refreshed.issues[0].id,
    recordKey: 'older-record' }, reviewer);
  assert.equal(result.revision, 1);
  assert.equal(result.history[0].data.snapshotHash, older.snapshotHash, 'The old review is not relabeled as a new observation');
});

test('a different reviewer cannot reuse another reviewer original event identity', async () => {
  const f = await fixture(), before = f.row.body;
  await assert.rejects(f.service.save(request(older, '00000000-0000-4000-8000-000000000001'),
    { ...reviewer, id: 'matter:another-reviewer' }, { recordKey: 'older-record' }), error => error.status === 409);
  assert.equal(f.row.body, before); assert.equal(f.calls.some(call => call.name === 'matter_hosted_state_cas'), false);
});

test('denied case access and injected canonical input fields stop without journal I/O', async () => {
  const f = await fixture();
  await assert.rejects(f.service.readCase({ snapshotHash: older.snapshotHash, issueId: older.issues[0].id,
    recordKey: 'older-record' }, { id: 'staff', role: 'driver' }), error => error.status === 403);
  assert.equal(f.resolutions.length, 0); assert.equal(f.calls.length, 0);
  await assert.rejects(f.service.save({ ...request(older, '00000000-0000-4000-8000-000000000008'),
    expectedRevision: 1, recordKey: 'older-record' }, reviewer, { recordKey: 'older-record' }), error => error.status === 400);
  assert.equal(f.calls.length, 0);
});

test('maximum valid response text remains bounded through JSON escaping and exact reload', async () => {
  const f = await fixture(), input = { ...request(older, '00000000-0000-4000-8000-000000000009'),
    expectedRevision: 1, response: '\u0000'.repeat(4000) };
  await f.service.save(input, reviewer, { recordKey: 'older-record' });
  const result = await f.service.readCase({ snapshotHash: older.snapshotHash, issueId: older.issues[0].id,
    recordKey: 'older-record' }, reviewer);
  assert.equal(result.history.at(-1).data.response, input.response);
  assert.ok(f.calls.filter(call => call.name === 'matter_hosted_state_cas')
    .every(call => Buffer.byteLength(JSON.stringify(call.args)) <= 512 * 1024));
});

test('legacy empty review records retain the original reviewEvents compatibility', async () => {
  for (const value of [null, false, 0, '']) {
    const f = await fixture(), state = JSON.parse(f.row.body); state.records.reportingReviews = value;
    f.setBody(JSON.stringify(state));
    const result = await f.service.readCase({ snapshotHash: older.snapshotHash, issueId: older.issues[0].id,
      recordKey: 'older-record' }, reviewer);
    assert.deepEqual(result.history, []); assert.equal(result.revision, 0);
  }
});
