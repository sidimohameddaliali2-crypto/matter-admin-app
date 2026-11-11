import { createHash } from 'node:crypto';
import { SERVICE_CATEGORY_IDS } from '../config/customerServiceCategories.js';

export const SERVICE_POLICY = Object.freeze({ pendingCap: 2, activeCap: 1, leaseMs: 15 * 60 * 1000, version: '2026-11-06.1' });
export const SERVICE_STAFF_ROLES = Object.freeze(['super_admin', 'admin', 'manager', 'dispatcher', 'store_keeper', 'viewer', 'kitchen']);
export const serviceId = value => String(value?._id ?? value ?? '');
export const serviceError = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });
const fail = (message, statusCode = 400) => { throw serviceError(message, statusCode); };
const string = (value, max = 4000) => typeof value === 'string' && value.trim() && value.length <= max;
const date = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value) : null;

// Membership is a separate explicit grant. Generic page and administrator
// permissions never manufacture service membership or supervision.
export function getServiceCapabilities(user, profile) {
  const active = user?.isActive === true && SERVICE_STAFF_ROLES.includes(user.role);
  const member = active && profile?.enabled === true && serviceId(profile.userId) === serviceId(user._id) && ['reviewer', 'supervisor'].includes(profile.mode);
  return { assignRequests: Boolean(member && (profile.mode === 'supervisor' || profile.grants?.includes('assignRequests'))), approveExceptions: Boolean(member && profile.grants?.includes('approveExceptions')), closeSensitive: Boolean(member && profile.grants?.includes('closeSensitive')), managePolicies: Boolean(member && profile.grants?.includes('managePolicies')), view: Boolean(member), review: Boolean(member), supervise: Boolean(member && profile.mode === 'supervisor'), workActions: Boolean(member), setup: Boolean(active && user.role === 'super_admin') };
}
export function assertServiceRecordAccess({ actor, profile, record, operation = 'read' }) {
  const caps = getServiceCapabilities(actor, profile);
  if (!caps.view) fail('Active customer-service membership required.', 403);
  if (['reassign', 'allocate', 'team'].includes(operation)) {
    if (!caps.supervise) fail('A customer-service supervisor must perform this operation.', 403);
    return true;
  }
  if (caps.supervise && operation !== 'review') return true;
  const field = operation === 'action' ? 'ownerId' : 'reviewerId';
  if (serviceId(record?.[field]) !== serviceId(actor._id)) fail('Only your assigned records are available.', 403);
  return true;
}

export function allocateReviewBatch({ cases = [], staff = [], assignments = [], assignedCounts = {}, cursor = 0, policy = {} }) {
  const limits = { ...SERVICE_POLICY, ...policy };
  const eligible = staff.filter(p => p.enabled === true && ['reviewer', 'supervisor'].includes(p.mode) && p.user?.isActive === true && SERVICE_STAFF_ROLES.includes(p.user.role) && Number.isFinite(p.availableMinutes) && p.availableMinutes > 0).sort((a, b) => serviceId(a.userId).localeCompare(serviceId(b.userId)));
  const pending = new Map(), credit = new Map();
  for (const p of eligible) { const id = serviceId(p.userId); pending.set(id, 0); credit.set(id, Number(assignedCounts[id]) || 0); }
  for (const a of assignments) if (['assigned', 'pending'].includes(a.status) && pending.has(serviceId(a.reviewerId))) pending.set(serviceId(a.reviewerId), pending.get(serviceId(a.reviewerId)) + 1);
  const output = [], unassigned = [];
  let nextCursor = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
  for (const item of [...cases].sort((a, b) => Number(b.priority==='urgent')-Number(a.priority==='urgent')||(date(a.createdAt)?.getTime() || 0) - (date(b.createdAt)?.getTime() || 0) || serviceId(a._id).localeCompare(serviceId(b._id)))) {
    const excluded = new Set([...(item.contributorIds || []), ...(item.skippedBy || []), ...(item.excludedReviewerIds || [])].map(serviceId));
    const candidates = eligible.filter(p => !excluded.has(serviceId(p.userId)) && pending.get(serviceId(p.userId)) < limits.pendingCap);
    if (!candidates.length) { unassigned.push({ reviewId: serviceId(item._id), reason: 'no_eligible_capacity' }); continue; }
    candidates.sort((a, b) => {
      const share = credit.get(serviceId(a.userId)) / a.availableMinutes - credit.get(serviceId(b.userId)) / b.availableMinutes;
      if (Math.abs(share) > 1e-12) return share;
      return (eligible.indexOf(a) - nextCursor % eligible.length + eligible.length) % eligible.length - (eligible.indexOf(b) - nextCursor % eligible.length + eligible.length) % eligible.length;
    });
    const owner = candidates[0], id = serviceId(owner.userId);
    output.push({ reviewId: serviceId(item._id), issueId: serviceId(item.issueId), reviewerId: id, reason: 'planned_capacity', policyVersion: limits.version });
    pending.set(id, pending.get(id) + 1); credit.set(id, credit.get(id) + 1);
    nextCursor = eligible.indexOf(owner) + 1;
  }
  return { assignments: output, unassigned, nextCursor };
}

export function selectReviewCohort({ issues = [], seed, policy = {} }) {
  if (!string(seed, 200)) fail('Provide a reproducible sampling seed.');
  const size = Number.isInteger(policy.sampleSize) && policy.sampleSize >= 0 ? policy.sampleSize : issues.length;
  const hash = item => createHash('sha256').update(`${seed}:${serviceId(item._id)}`).digest('hex');
  // Round-robin original-agent strata first; hashed order supplies a stable
  // baseline sample independent from the separate targeted queue.
  const strata = new Map();
  for (const issue of issues) {
    const key = [...(issue.contributorIds || [])].map(serviceId).sort().join(',') || 'unknown';
    if (!strata.has(key)) strata.set(key, []);
    strata.get(key).push(issue);
  }
  const limit=Math.min(size,issues.length);
  const queues=[...strata].map(([key,group])=>({key,group:group.sort((a,b)=>hash(a).localeCompare(hash(b))),quota:Math.floor(limit*group.length/issues.length),fraction:(limit*group.length/issues.length)%1}));
  let left=limit-queues.reduce((n,q)=>n+q.quota,0);
  for(const queue of [...queues].sort((a,b)=>b.fraction-a.fraction||a.key.localeCompare(b.key))) if(left-->0) queue.quota++;
  const baseline=queues.flatMap(q=>q.group.slice(0,q.quota));
  const metadata = { seed, policyVersion: SERVICE_POLICY.version, eligibleDenominator: issues.length };
  const selected = new Set(baseline.map(i => serviceId(i._id)));
  return [...baseline.map(i => ({ ...i, ...metadata, sampleType: 'baseline' })), ...issues.filter(i => !selected.has(serviceId(i._id)) && (i.priority === 'urgent' || i.repeatIssue === true || i.unanswered === true)).map(i => ({ ...i, ...metadata, sampleType: 'targeted' }))];
}

export function classifyServiceTiming(messages = [], { assignmentEvents, businessCalendar } = {}) {
  const sorted = messages.filter(m => date(m.sentAt)).sort((a, b) => new Date(a.sentAt) - new Date(b.sentAt));
  const firstCustomer = sorted.find(m => m.authorType === 'customer');
  const firstReply = firstCustomer && sorted.find(m => m.authorType === 'staff' && new Date(m.sentAt) >= new Date(firstCustomer.sentAt));
  let outstanding = 0;
  for (const m of sorted) { if (m.authorType === 'customer') outstanding++; else if (m.authorType === 'staff') outstanding = 0; }
  const unknowns = [];
  if (messages.some(m => m.authorType === 'unknown' || !m.authorType)) unknowns.push('unknown_authors');
  if (messages.some(m => !date(m.sentAt))) unknowns.push('invalid_timestamps');
  if (!assignmentEvents?.length) unknowns.push('assignment_history_unavailable');
  if (!businessCalendar) unknowns.push('business_calendar_unavailable');
  const assignment = assignmentEvents?.filter(a => date(a.assignedAt) && firstReply && new Date(a.assignedAt) <= new Date(firstReply.sentAt)).sort((a, b) => new Date(b.assignedAt) - new Date(a.assignedAt))[0];
  return { firstHumanReplySeconds: firstReply ? (new Date(firstReply.sentAt) - new Date(firstCustomer.sentAt)) / 1000 : null, unansweredCustomerMessages: outstanding, stillUnanswered: outstanding > 0, oldestUnansweredAt: outstanding ? sorted.filter(m => m.authorType === 'customer').at(-outstanding)?.sentAt || null : null, assignmentToReplySeconds: assignment ? (new Date(firstReply.sentAt) - new Date(assignment.assignedAt)) / 1000 : null, businessHoursWaitSeconds: null, unknowns };
}

export function validateReviewSubmission(input) {
  if (!['good', 'needs_work', 'insufficient'].includes(input.verdict)) fail('Choose Good, Needs work or Not enough information.');
  if (!string(input.summary, 8000)) fail('Provide an editable issue summary.');
  if (!Array.isArray(input.categoryIds) || input.categoryIds.some(id => !SERVICE_CATEGORY_IDS.includes(id))) fail('Unknown category. Choose from the shared category list.');
  if (!['open', 'resolved', 'unknown'].includes(input.outcome)) fail('Choose an explicit issue outcome.');
  if (!Array.isArray(input.evidenceMessageIds) || input.evidenceMessageIds.length > 100) fail('Provide evidence message references.');
  if (input.verdict === 'needs_work' && (!string(input.note, 4000) || input.evidenceMessageIds.length === 0)) fail('Needs work requires a reason and supporting evidence.');
  if (input.verdict === 'insufficient' && input.outcome === 'resolved') fail('Insufficient evidence cannot confirm resolution.');
  return { verdict: input.verdict, summary: input.summary.trim(), note: typeof input.note === 'string' ? input.note.trim().slice(0, 4000) : '', categoryIds: [...new Set(input.categoryIds)], outcome: input.outcome, evidenceMessageIds: [...new Set(input.evidenceMessageIds.map(serviceId))] };
}
export function validateActionUpdate(action, command) {
  if (!['unassigned', 'assigned', 'in_progress', 'waiting', 'completed'].includes(command.status)) fail('Choose a valid action status.');
  const reason = typeof command.reason === 'string' ? command.reason.trim() : '';
  const nextCheckAt = command.nextCheckAt === undefined ? action.nextCheckAt : date(command.nextCheckAt);
  const dueAt = command.dueAt === undefined ? action.dueAt : date(command.dueAt);
  if (command.dueAt !== undefined && !dueAt) fail('Choose a valid due date.');
  if (command.status === 'waiting' && (!string(reason, 2000) || !nextCheckAt)) fail('Waiting requires a reason and next check date.');
  const evidence = typeof command.evidence === 'string' ? { note: command.evidence, confirmedEffect: false } : command.evidence;
  if (command.status === 'completed' && (!evidence || evidence.confirmedEffect !== true || (!string(evidence.note, 4000) && !evidence.messageIds?.length))) fail('Confirm the actual requested effect and provide completion evidence.');
  if (action.status === 'completed' && command.status !== 'completed' && !string(reason, 2000)) fail('Reopening requires a reason.');
  if (command.note !== undefined && (typeof command.note !== 'string' || command.note.length > 4000)) fail('Action note is too long.');
  return { status: command.status, dueAt, promisedDueAt: action.promisedDueAt || null, reason, nextCheckAt: nextCheckAt || null, note: command.note?.trim() || '', evidence: evidence || null };
}
