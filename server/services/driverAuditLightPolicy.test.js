import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

const implementation = await import('./driverAuditLightPolicy.js').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const sha = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const generation = sha('retained generation'), reportHash = sha('retained report');
const start = '2026-11-18T06:00:00.000Z', end = '2026-11-18T08:00:00.000Z';
const timingPolicy = 'individual-order-window-v3-20261109';
function row(id, changes = {}) {
  return { key: '2026-11-18/' + id, date: '2026-11-18', assessmentHash: sha(id), tier: 2,
    findings: [{ issue_id: id + ':early', category: 'Timing', issue_type: 'Early upload', tier: 2, reason: 'Retained warning' }],
    photoFindings: [{ issue_id: id + ':photo', category: 'Proof', issue_type: 'Original image finding', tier: 3 }],
    delivery: { source_sha256: sha(id + ':source'), driver_id: 'driver-original', customer: id,
      window_start: start, deadline: end, upload: '2026-11-18T05:50:00.000Z' }, ...changes };
}
function fixture(rows = [row('one')]) {
  const entries = rows.map(value => ({ version: 'matter-evidence-overlay-entry-v1', generation,
    recordKey: value.key, assessmentHash: value.assessmentHash, deliverySourceSha256: value.delivery.source_sha256,
    directPhoto: { reviewSha256: sha(value.key + ':review'), review: { description: 'Original observation',
      visibleText: ['Original label'], addressComparisonReason: 'Original reason' } },
    source: { comparedSourceSha256: sha(value.key + ':compared') }, gpsEvidence: { stale: 'must not be duplicated' } }));
  return { view: { version: 1, generation, reportHash, photos: rows.map(value => [value.key, sha(value.key + ':image')]),
    gpsRows: structuredClone(rows), overlay: { status: 'ready', generation, entries } },
  gps: { version: 1, records: Object.fromEntries(rows.map(value => [value.key, {}])) },
  reviewSnapshot: { kind: 'delivery-review', snapshotHash: reportHash, deliveryReview: true,
    issues: rows.map(value => ({ id: value.key + ':case', deliveryId: value.key })), rows: structuredClone(rows) },
  householdArrangements: [] };
}
const build = async input => {
  assert.equal(typeof implementation.buildDriverAuditLightPolicy, 'function');
  return implementation.buildDriverAuditLightPolicy(input);
};
function correction(input, id, changes = {}) {
  const original = input.view.gpsRows[0];
  return { eventId: sha(id), kind: 'reported_incident', recordKey: original.key,
    assessmentHash: original.assessmentHash, sourceSha256: original.delivery.source_sha256,
    match: { state: 'provisional_unique_name_date', keys: [original.key] }, category: 'reported_early_delivery',
    issue: 'Customer reported an early visit', source: { sha256: sha('retained sheet'), spreadsheetId: 'fictional', sheet: 'Reports', range: 'A1' }, ...changes };
}
function corrections(input, events = [], photoDecisions) {
  return { version: 1, reportHash: sha('original correction origin'), generation: sha('original correction generation'),
    records: [{ recordKey: input.view.gpsRows[0].key, reportedIncidents: events, photoSupplements: [] }], photoDecisions };
}
function acceptedTiming(input, changes = {}) {
  const original = input.view.gpsRows[0];
  return { version: 1, reportHash: sha('earlier decision origin'), records: [{ kind: 'accepted_delivery_timing',
    recordKey: original.key, date: original.date, assessmentHash: original.assessmentHash,
    deliverySourceSha256: original.delivery.source_sha256, outcome: 'clean', issueType: 'Early upload',
    sourceSha256: sha('accepted timing source'), sourceRef: 'Original instruction', decisionId: 'retained-owner-decision',
    acceptedBy: 'Original owner', acceptedAt: '2026-11-17T07:00:00.000Z', reason: 'Owner confirmed the original instruction', ...changes }] };
}

test('policy preserves each original overlay and input while leaving duplicated GPS evidence out of the compact result', async () => {
  const input = fixture(), before = structuredClone(input), result = await build(input);
  assert(result instanceof Map); assert.equal(result.size, 1);
  const value = result.get('2026-11-18/one');
  assert.equal(value.overlay.directPhoto.review.description, 'Original observation');
  assert.equal(value.overlay.timingReassessment.state, 'early_upload_review');
  assert.equal(Object.hasOwn(value.overlay, 'gpsEvidence'), false);
  assert.equal(value.sharedHouseholdStop, null);
  assert.deepEqual(value.reviewFindingIds, ['one:early:' + timingPolicy, 'one:photo']);
  assert.equal(value.findings[0].issue_type, 'Early upload');
  assert.deepEqual(input, before);
  value.overlay.directPhoto.review.description = 'Caller mutation';
  assert.deepEqual(input, before, 'Compact output must not retain mutable references into frozen inputs');
});

test('provisional reports and stale findings retain their original event evidence rather than becoming accepted outcomes', async () => {
  const input = fixture(), provisional = correction(input, 'provisional'), stale = correction(input, 'stale', { assessmentHash: sha('prior assessment') });
  input.corrections = corrections(input, [provisional, stale]);
  const value = (await build(input)).get('2026-11-18/one');
  assert.equal(value.overlay.corrections[0].issue_type, 'Reported early delivery');
  assert.equal(value.overlay.corrections[0].supplemental, true);
  assert.match(value.overlay.corrections[0].reason, /has not been independently confirmed/);
  assert.equal(value.overlay.corrections[1].evidenceConflict, true);
  assert.deepEqual(value.overlay.corrections[1].priorEvidence, stale);
  assert.deepEqual(value.findings.slice(0, 2), value.overlay.corrections);
  assert.equal(value.overlay.timingReassessment.withdrawn, false);
});

test('accepted timing and changed-source conflicts follow the original decision bindings without replacing retained findings', async () => {
  const input = fixture(); input.decisions = acceptedTiming(input);
  const value = (await build(input)).get('2026-11-18/one');
  assert.equal(value.overlay.timingReassessment.state, 'owner_explained');
  assert.equal(value.findings[0].issue_type, 'Explained — owner-accepted delivery');
  assert.equal(value.findings[0].tier, 0); assert.equal(value.tier, 0);
  assert.equal(input.reviewSnapshot.rows[0].findings[0].issue_type, 'Early upload');
  input.decisions = acceptedTiming(input, { deliverySourceSha256: sha('prior source') });
  const changed = (await build(input)).get('2026-11-18/one');
  assert.equal(changed.overlay.timingReassessment.state, 'timing_unresolved');
  assert.equal(changed.overlay.timingReassessment.acceptedDecisionStatus, 'evidence_conflict');
  assert.equal(changed.findings[0].tier, 2);
});

test('saved photo decisions keep applied and revalidation states and original image observations intact', async () => {
  const input = fixture(), original = input.view.gpsRows[0], entry = input.view.overlay.entries[0];
  const decision = { kind: 'accepted_photo_reading', recordKey: original.key, date: original.date,
    assessmentHash: original.assessmentHash, deliverySourceSha256: original.delivery.source_sha256,
    imageSha256: input.view.photos[0][1], reviewSha256: entry.directPhoto.reviewSha256,
    sourceSha256: sha('photo source'), comparedSourceSha256: entry.source.comparedSourceSha256,
    decisionId: 'retained-photo-decision', acceptedBy: 'Original reviewer', acceptedAt: '2026-11-17T08:00:00.000Z',
    reason: 'Owner verified the visible label', sourceRef: 'Retained source', observationBasis: 'saved_source_field_comparison',
    correction: { visibleText: ['Accepted label'], description: 'Accepted observation',
      addressComparison: 'visible_text_corresponds_to_source', addressComparisonReason: 'Confirmed from source' } };
  input.corrections = corrections(input, [], { version: 1, reportHash: sha('earlier photo origin'), records: [decision] });
  const accepted = (await build(input)).get(original.key);
  assert.equal(accepted.overlay.photoDecision.state, 'applied');
  assert.equal(accepted.overlay.directPhoto.review.description, 'Original observation');
  assert(accepted.reviewFindingIds.includes('photo-decision:retained-photo-decision'));
  decision.imageSha256 = sha('different image');
  const conflict = (await build(input)).get(original.key);
  assert.equal(conflict.overlay.photoDecision.state, 'conflict');
  assert.deepEqual(conflict.overlay.photoDecision.changed, ['image']);
  assert.equal(conflict.overlay.corrections[0].supplemental, true);
});

test('shared-image supplements use every frozen peer photo rather than a single case projection', async () => {
  const input = fixture([row('one'), row('two')]), first = input.view.gpsRows[0];
  input.view.photos[1][1] = input.view.photos[0][1];
  input.corrections = corrections(input);
  input.corrections.records[0].photoSupplements = [{ kind: 'photo_detail_supplement', recordKey: first.key,
    eventId: sha('shared photo event'), sourceBinding: { assessmentHash: first.assessmentHash,
      sourceSha256: first.delivery.source_sha256 }, imageSha256: input.view.photos[0][1],
    relatedRecordKeys: input.view.gpsRows.map(value => value.key), observationRef: { sha256: sha('saved photo observation') },
    findings: [{ category: 'photo_image_reused', observed: 'One original image', recorded: 'Two orders', basis: 'Exact image hash' }] }];
  const value = (await build(input)).get(first.key);
  assert.equal(value.overlay.corrections[0].issue_type, 'Same photo linked to multiple orders');
  assert.deepEqual(value.overlay.corrections[0].relatedRecordKeys, input.view.gpsRows.map(value => value.key));
  input.view.photos[1][1] = sha('a different peer image');
  await assert.rejects(build(input), /Unverified shared image group/);
});

test('an unchanged pre-policy case keeps the exact original fields without adding findings or tier overrides', async () => {
  const value = row('older', { key: '2026-10-18/older', date: '2026-10-18' }), input = fixture([value]);
  const result = (await build(input)).get(value.key);
  const { gpsEvidence, ...expected } = input.view.overlay.entries[0];
  assert.deepEqual(result.overlay, expected);
  assert.equal(Object.hasOwn(result, 'findings'), false);
  assert.equal(Object.hasOwn(result, 'tier'), false);
  assert.deepEqual(result.reviewFindingIds, ['older:early', 'older:photo']);
  assert.equal(result.sharedHouseholdStop, null);
});

test('the complete day peers resolve an accepted household while another day never supplies a partner receipt', async () => {
  const one = row('one'), two = row('two'), next = row('next', { key: '2026-11-19/next', date: '2026-11-19' });
  two.delivery.window_start = '2026-11-18T05:00:00.000Z'; two.delivery.upload = '2026-11-18T05:51:00.000Z';
  two.findings = []; two.delivery.timing_label = 'Within window';
  next.delivery.upload = '2026-11-19T05:50:00.000Z'; next.delivery.window_start = '2026-11-19T06:00:00.000Z'; next.delivery.deadline = '2026-11-19T08:00:00.000Z';
  const input = fixture([one, two, next]);
  for (const [value, customerId] of [[one, 'account-a'], [two, 'account-b'], [next, 'account-a']]) {
    input.gps.records[value.key].addressStop = { recordKey: value.key, assessmentHash: value.assessmentHash,
      deliverySourceSha256: value.delivery.source_sha256, state: 'apartment_identified', customerId,
      identity: { unitKey: 'accepted-unit' } };
  }
  input.householdArrangements = [{ id: 'retained-household', customerIds: ['account-a', 'account-b'], unitKey: 'accepted-unit',
    effectiveFrom: '2026-11-01', effectiveTo: null, acceptPartnerReceipt: true, maxUploadGapSeconds: 600,
    sourceRef: 'Original owner instruction', sourceSha256: sha('household source'), acceptedBy: 'Original owner',
    acceptedAt: '2026-11-01T00:00:00.000Z' }];
  const result = await build(input), value = result.get(one.key);
  assert.equal(value.overlay.timingReassessment.state, 'household_explained');
  assert.equal(value.findings[0].issue_type, 'Explained — shared household delivery');
  assert.equal(value.sharedHouseholdStop.authority, 'owner_accepted');
  assert.deepEqual(value.sharedHouseholdStop.members.map(member => member.recordKey), [one.key, two.key]);
  assert.equal(result.get(two.key).sharedHouseholdStop.stopId, value.sharedHouseholdStop.stopId);
  assert.equal(result.get(next.key).sharedHouseholdStop, null);
});

test('GPS timing and acquired-source availability remain bound to the full original delivery source', async () => {
  const input = fixture(), original = input.view.gpsRows[0];
  input.gps.records[original.key].result = { recordKey: original.key, binding: { assessmentHash: original.assessmentHash },
    deliverySourceSha256: original.delivery.source_sha256, policyVersion: timingPolicy, windowStart: start, windowEnd: end,
    deliveryTiming: { state: 'gps_supported_in_window_visit' } };
  input.availability = { version: 1, records: { [original.key]: { binding: { assessmentHash: original.assessmentHash,
    deliveryDigest: sha(original.delivery) }, originalSourceAvailability: { status: 'missing' },
  sourceAvailability: { status: 'acquired_unlinked', sources: [{ sourceHash: sha('retained GPS source') }] } } } };
  const value = (await build(input)).get(original.key);
  assert.equal(value.overlay.timingReassessment.state, 'in_window');
  assert.equal(value.overlay.gpsAvailability.bindingVerified, true);
  assert.deepEqual(value.overlay.gpsAvailability.deliveryBinding, original.delivery);
  assert.equal(value.tier, 0);
  input.gps.records[original.key].result.deliverySourceSha256 = sha('stale source');
  assert.equal((await build(input)).get(original.key).overlay.timingReassessment.state, 'early_upload_review');
  input.availability.records[original.key].binding.deliveryDigest = sha('stale full row');
  await assert.rejects(build(input), /Stale release GPS availability binding/);
});

test('unknown household state and ambiguous or mismatched original records never become silently empty policy', async () => {
  for (const change of ['households', 'household-invalid', 'row-duplicate', 'overlay-binding', 'review-binding', 'review-missing']) {
    const input = fixture();
    if (change === 'households') delete input.householdArrangements;
    if (change === 'household-invalid') input.householdArrangements.push({ id: 'unverified arrangement' });
    if (change === 'row-duplicate') input.view.gpsRows.push(structuredClone(input.view.gpsRows[0]));
    if (change === 'overlay-binding') input.view.overlay.entries[0].assessmentHash = sha('other assessment');
    if (change === 'review-binding') input.reviewSnapshot.rows[0].assessmentHash = sha('other review assessment');
    if (change === 'review-missing') input.reviewSnapshot.rows = [];
    await assert.rejects(build(input));
  }
});
