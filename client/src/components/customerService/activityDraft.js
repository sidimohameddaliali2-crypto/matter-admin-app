import { recordActivityChange } from '../../utils/activityCapture';
import { formatDubai, idOf } from './serviceUtils';
import { workflowTopic } from './requestTopics';

const title = value => String(value || '').replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ').replace(/^./, letter => letter.toUpperCase());
const date = value => value ? formatDubai(/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value) ? value + '+04:00' : value) : '';
const kind = value => ({ complaint: 'Complaint', inquiry: 'Inquiry', spam: 'Spam / Vendor', vendor: 'Spam / Vendor', non_customer: 'Spam / Vendor' }[value] || '');
const intent = value => ({ update: 'Update', followup: 'Follow up', resolve: 'Resolve' }[value] || '');
const actionFor = (fields, definitions) => definitions.actions?.[workflowTopic({ kind: fields.kind, topic: fields.topic, subtopic: fields.subtopic }, definitions)]?.find(action => action.code === fields.actionCode);
const same = (before, after) => JSON.stringify(before ?? '') === JSON.stringify(after ?? '');

// Only user handlers call this helper. Loading a record, recovering a draft and
// polling establish a baseline; they must not create another staff edit.
export function recordIssueDraftChanges(before, after, { definitions = {}, owners = [], form = 'Problem action', element, exclude = [], legacy = false } = {}) {
  const topic = fields => definitions.topics?.find(item => item.id === fields.topic);
  const name = value => value ? owners.find(owner => idOf(owner.userId || owner) === String(value))?.displayName || 'Recorded staff' : '';
  const descriptors = {
    kind: ['Type', fields => kind(fields.kind)],
    topic: ['Topic', fields => fields.topic ? topic(fields)?.label || 'Previous topic' : ''],
    subtopic: ['Issue detail', fields => fields.subtopic ? topic(fields)?.includes?.find(detail => detail.id === fields.subtopic)?.label || 'Previous issue detail' : ''],
    ownerId: ['Owner', fields => name(fields.ownerId)],
    uiMode: ['Action intent', fields => intent(fields.uiMode)],
    actionCode: ['Action', fields => fields.actionCode ? actionFor(fields, definitions)?.label || 'Previous action' : ''],
    outcomeCode: ['Outcome', fields => fields.outcomeCode ? actionFor(fields, definitions)?.outcomes?.find(outcome => outcome.code === fields.outcomeCode)?.label || 'Previous outcome' : ''],
    dueAt: [legacy ? 'Due time · Dubai' : 'Check again · Dubai', fields => date(fields.dueAt)],
    waitingOn: ['Waiting for', fields => fields.waitingOn || ''],
    customerUpdateDueAt: ['Customer update promised · Dubai', fields => date(fields.customerUpdateDueAt)],
    nextAction: ['Next step', fields => fields.nextAction || '', true],
    evidenceMessageId: ['Outcome evidence message', fields => fields.evidenceMessageId || '', true],
    evidenceReference: ['Completion record / reference', fields => fields.evidenceReference || '', true],
    title: ['Issue summary', fields => fields.title || '', true],
    reopenReason: ['Why reopen this issue?', fields => fields.reopenReason || '', true],
    reopenMessageId: ['Related customer message', fields => fields.reopenMessageId || '', true],
    splitReason: ['Why this is another problem', fields => fields.splitReason || '', true],
    decision: ['Classification decision', fields => title(fields.decision)],
    action: ['Next action', fields => fields.action || '', true],
    responsibleId: ['Responsible person', fields => name(fields.responsibleId)],
    requestMode: ['Request action', fields => ({ overview: 'Simple actions', create: 'Create issue', split: 'Create separate issue', progress: 'Record progress', resolve: 'Resolve issue', feedback: 'Record customer feedback', classify: 'Classify request', classify_suggestion: 'Review classification suggestion', followup: 'Add follow-up', followup_update: 'Update follow-up', request_transfer: 'Request reassignment', assign: 'Assign / reassign', exception: 'Request policy exception', approve_exception: 'Decide exception', acknowledge: 'Acknowledge alert', link_message: 'Link selected message', reopen: 'Reopen issue' }[fields.requestMode] || '')]
  };
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === 'details' || exclude.includes(key) || same(before[key], after[key])) continue;
    const descriptor = descriptors[key];
    // Legacy forms also hold private explanatory input and evidence. Retain
    // their field changes without copying their text or technical identifiers.
    const [field, value, privateValue] = descriptor || [title(key), fields => fields[key] ?? '', true];
    if (['suggestionId', 'suggestionVersion'].includes(key)) continue;
    recordActivityChange({ field, before: value(before), after: value(after), form, element, private: privateValue === true });
  }
  const fieldsFor = fields => {const action = actionFor(fields, definitions);return [...(action?.fields || []), ...(action?.outcomes?.find(outcome => outcome.code === fields.outcomeCode)?.fields || [])];};
  const allFields = [...fieldsFor(before), ...fieldsFor(after), ...Object.values(definitions.actions || {}).flatMap(actionList => actionList.flatMap(action => [...(action.fields || []), ...(action.outcomes || []).flatMap(outcome => outcome.fields || [])]))];
  for (const key of new Set([...Object.keys(before.details || {}), ...Object.keys(after.details || {})])) {
    const oldValue = before.details?.[key], newValue = after.details?.[key];
    if (exclude.includes('details.' + key) || same(oldValue, newValue)) continue;
    const definition = allFields.find(field => field.id === key);
    const display = value => definition?.type === 'checkbox' ? value === true ? 'Selected' : 'Not selected' : value ?? '';
    recordActivityChange({ field: definition?.label || 'Saved detail', before: display(oldValue), after: display(newValue), form, element, private: !['checkbox', 'date', 'number'].includes(definition?.type) });
  }
}
