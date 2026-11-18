import { createCloudState } from '../vendor/driver-audits/integration/cloud/cloud-state.mjs';
import { createHostedReviews } from '../vendor/driver-audits/integration/cloud/hosted-reviews.mjs';
import { reviewEvents, reviewMatches } from '../vendor/driver-audits/app/src/content/dashboard/reporting-review.mjs';

export const driverAuditLightReviewLimits = Object.freeze({ journalBytes: 128 * 1024,
  responseBytes: 512 * 1024, eventBytes: 64 * 1024, requestBytes: 512 * 1024 });
const defaultKey = 'preview-gps-map-20261106:review-journal';
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = (value, maximum) => typeof value === 'string' && value.length > 0 && value.length <= maximum;
const denied = () => Object.assign(Error('Reports permission required'), { status: 403 });
const invalid = () => Object.assign(Error('An exact saved review case is required'), { status: 400 });
const capacity = () => Object.assign(Error('The saved review journal exceeds its bounded reader capacity'),
  { code: 'AUDIT_REVIEW_CAPACITY', status: 429 });
function bounded(value, maximum) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maximum) throw capacity();
}

// Filtering is only a response projection. The original complete journal is
// read and committed by the unchanged hosted review implementation.
export function createDriverAuditLightReviews({ rpcForResponseLimit, resolveIssue,
  key = defaultKey, clock } = {}) {
  if (typeof rpcForResponseLimit !== 'function' || typeof resolveIssue !== 'function'
    || !text(key, 160) || !(key === 'review-journal' || key === defaultKey
      || /^preview-acceptance-[a-z0-9-]+:review-journal$/.test(key))
    || clock !== undefined && typeof clock !== 'function') throw Error('A bounded original review transport is required');
  const rpc = rpcForResponseLimit(driverAuditLightReviewLimits.responseBytes);
  if (typeof rpc !== 'function') throw Error('A bounded original review transport is required');
  const original = createCloudState({ async rpc(name, args) {
    if (!['matter_hosted_state_read', 'matter_hosted_state_cas'].includes(name) || args.p_key !== key)
      throw Error('Review transport is outside its original journal');
    if (name === 'matter_hosted_state_cas') {
      bounded(args.p_body_text, driverAuditLightReviewLimits.journalBytes);
      bounded(args.p_event_text, driverAuditLightReviewLimits.eventBytes);
      bounded(JSON.stringify(args), driverAuditLightReviewLimits.requestBytes);
    }
    const result = await rpc(name, args);
    bounded(JSON.stringify(result), driverAuditLightReviewLimits.responseBytes);
    return result;
  } });
  const stateStore = {
    async read(selectedKey) {
      const value = await original.read(selectedKey);
      if (value.body !== null) bounded(value.body, driverAuditLightReviewLimits.journalBytes);
      return value;
    },
    compareAndSwap: input => original.compareAndSwap(input),
  };

  async function context(snapshotHash, issueId, recordKey) {
    if (!digest(snapshotHash) || !text(issueId, 2048) || !text(recordKey, 300)) throw invalid();
    // The caller supplies a hash-verified resolver, including retained older
    // snapshots. A date filter never substitutes for this original identity.
    const snapshot = await resolveIssue(snapshotHash, issueId, recordKey);
    if (snapshot?.snapshotHash !== snapshotHash || !Array.isArray(snapshot.issues) || !Array.isArray(snapshot.rows)) throw invalid();
    const issues = snapshot.issues.filter(issue => issue?.id === issueId);
    if (issues.length !== 1 || issues[0].deliveryId !== recordKey
      || snapshot.rows.filter(row => row?.key === recordKey).length !== 1) throw invalid();
    return { snapshot, issue: issues[0] };
  }
  const reviews = snapshotFor => createHostedReviews({ stateStore, snapshotFor, key, ...(clock ? { clock } : {}) });
  return Object.freeze({
    async readCase({ snapshotHash, issueId, recordKey } = {}, actor) {
      if (!text(actor?.id, 2048) || !['owner', 'reviewer', 'viewer'].includes(actor.role)) throw denied();
      const { snapshot, issue } = await context(snapshotHash, issueId, recordKey);
      const state = await reviews(async () => snapshot).read(actor);
      const history = reviewEvents(state).filter(event => reviewMatches(event, issue, snapshot));
      return { snapshotHash, issueId, recordKey, revision: history.length, history };
    },
    async save(input, actor, { recordKey } = {}) {
      // recordKey selects the immutable context only; the unchanged canonical
      // request/event/CAS must never acquire an additional input field.
      return reviews(async snapshotHash => (await context(snapshotHash, input.issueId, recordKey)).snapshot).save(input, actor);
    },
  });
}
