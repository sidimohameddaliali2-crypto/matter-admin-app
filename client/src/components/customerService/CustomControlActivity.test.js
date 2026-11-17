import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import RequestActionForm from './RequestActionForm';
import RequestWork, { RequestQueues } from './RequestWork';
import ReviewPanel from './ReviewPanel';
import ActionEditor from './ActionEditor';
import CustomerLinkReview from './CustomerLinkReview';
import MetricsCalendarSettings from './MetricsCalendarSettings';
import Summary from '../../pages/customerService/Summary';
import RequestReport from './RequestReport';
import Customers from '../../pages/customerService/Customers';
import Problems from '../../pages/customerService/Problems';
import CustomerChats from '../../pages/customerService/CustomerChats';
import CustomerService from '../../pages/customerService/CustomerService';
import SidebarSandbox from './SidebarSandbox';
import CustomerContextDrawer from './CustomerContext';
import { installActivityCapture } from '../../utils/activityCapture';
import api from '../../utils/api';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), put: jest.fn() } }));
jest.mock('react-router-dom', () => ({ Link: ({ children, to, onClick, ...props }) => <a href={to} {...props} onClick={event => {event.preventDefault();onClick?.(event);}}>{children}</a>, useLocation: () => ({ pathname: globalThis.window.location.pathname, search: globalThis.window.location.search }), useNavigate: () => () => {} }), { virtual: true });
jest.mock('react-redux', () => ({ useSelector: selector => selector({ auth: { user: { _id: 'staff', name: 'Fixture staff' } } }) }));
global.IS_REACT_ACT_ENVIRONMENT = true;
const wrap = data => ({ data: { data } });
const definitions = {
  issuePicker: { available: true }, nonCustomerTypes: { available: true },
  topics: [{ id: 'delivery', label: 'Delivery', includes: [{ id: 'missed', label: 'Missed delivery', workflowTopic: 'delivery' }] }],
  actions: { delivery: [
    { code: 'check', label: 'Check delivery', terminal: false, fields: [{ id: 'reference', label: 'Order reference', type: 'text' }] },
    { code: 'followup_other', label: 'Set next step', terminal: false, fields: [] },
    { code: 'complete', label: 'Record delivery outcome', terminal: true, outcomes: [{ code: 'delivered', label: 'Delivery completed', group: 'fulfilled', fields: [] }] }
  ] },
  actionVersion: 'activity-fixture'
};
const owners = [{ userId: 'staff', displayName: 'Fixture staff' }];
const formProps = { definitions, owners, actorId: 'staff', conversationId: 'chat', conversationScope: true, request: null, onSaved: jest.fn() };
let root, el, cleanup, fetchMock;
const events = () => fetchMock.mock.calls.flatMap(([, options]) => JSON.parse(options.body).events);
const changes = () => events().filter(event => event.stage === 'form_edited').flatMap(event => event.changes);
const button = text => [...el.querySelectorAll('button')].find(node => node.textContent.trim() === text);
const render = node => act(async () => root.render(node));
const click = text => act(async () => button(text).click());
const fill = async (label, value) => act(async () => {
  const node = el.querySelector(`[aria-label="${label}"]`);
  node.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  const prototype = node.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value);
  node.dispatchEvent(new Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
});
async function deliver() { await act(async () => { jest.advanceTimersByTime(2200); for (let n = 0; n < 12; n++) await Promise.resolve(); }); }
async function chooseIssue() { await act(async () => el.querySelector('[role="combobox"]').focus()); await act(async () => el.querySelector('[role="option"]').click()); }
beforeEach(() => {
  jest.useFakeTimers(); jest.setSystemTime(new Date('2026-11-17T08:00:00Z')); jest.clearAllMocks(); sessionStorage.clear(); localStorage.clear();
  localStorage.setItem('token', 'fixture-staff-session'); localStorage.setItem('user', JSON.stringify({ _id: 'staff' }));
  window.history.replaceState({}, '', '/customer-service/chats');
  Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  fetchMock = jest.fn().mockResolvedValue({ ok: true, headers: { get: () => null }, json: async () => ({ success: true }) });
  window.fetch = fetchMock; el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el); cleanup = installActivityCapture();
  api.get.mockResolvedValue(wrap({}));
});
afterEach(async () => { await act(async () => root.unmount()); cleanup(); el.remove(); jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks(); sessionStorage.clear(); localStorage.clear(); });

test('custom issue type and committed issue choices record readable unsaved changes without saving', async () => {
  await render(<RequestActionForm {...formProps}/>); await deliver(); expect(changes()).toEqual([]);
  await click('Inquiry'); await chooseIssue(); await deliver();
  expect(changes()).toEqual(expect.arrayContaining([
    expect.objectContaining({ field: 'Type', before: '', after: 'Inquiry' }),
    expect.objectContaining({ field: 'Topic', before: '', after: 'Delivery' }),
    expect.objectContaining({ field: 'Issue detail', before: '', after: 'Missed delivery' }),
    expect.objectContaining({ field: 'Action', before: '', after: 'Check delivery' })
  ]));
  expect(events().every(event => !event.actor)).toBe(true); expect(api.post).not.toHaveBeenCalled();
  fetchMock.mockClear(); await click('Inquiry'); await deliver(); expect(changes()).toEqual([]);
});

test('action shortcuts record restored and cleared draft fields and due shortcuts without repeating native edits', async () => {
  await render(<RequestActionForm {...formProps}/>); await click('Inquiry'); await chooseIssue(); await fill('Order reference', 'PRIVATE-ORDER-REFERENCE'); await fill('Check again · Dubai', '2026-11-19T11:45'); await deliver(); fetchMock.mockClear();
  await click('Tomorrow'); await deliver();
  expect(changes()).toEqual([expect.objectContaining({ field: 'Check again · Dubai', before: '19 Nov 2026, 11:45', after: '18 Nov 2026, 11:45' })]);
  expect(el.querySelector('[aria-label="Check again · Dubai"]').value.endsWith('T11:45')).toBe(true);
  fetchMock.mockClear(); await click('Follow up'); await deliver();
  expect(changes()).toEqual(expect.arrayContaining([
    expect.objectContaining({ field: 'Action intent', before: 'Update', after: 'Follow up' }),
    expect.objectContaining({ field: 'Action', before: 'Check delivery', after: 'Set next step' }),
    expect.objectContaining({ field: 'Order reference', before: '[Not recorded]', after: '[Not recorded]', redacted: true })
  ]));
  expect(JSON.stringify(events())).not.toContain('PRIVATE-ORDER-REFERENCE');
  fetchMock.mockClear(); await click('Update'); await deliver(); expect(changes()).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'Order reference', redacted: true })]));
  fetchMock.mockClear(); await click('Cancel'); await deliver(); expect(changes()).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'Action', before: 'Check delivery', after: '' })]));
  expect(api.post).not.toHaveBeenCalled();
});

test('native outcome selection captures its dependent action once and does not duplicate the selected outcome', async () => {
  const request = { _id: 'request', version: 1, classification: { kind: 'inquiry', topic: 'delivery', subtopic: 'missed' } };
  await render(<RequestActionForm {...formProps} request={request}/>); await click('Resolve'); await deliver(); fetchMock.mockClear();
  await fill('What happened?', 'complete:delivered'); await deliver();
  expect(changes().filter(change => change.field === 'Outcome')).toHaveLength(1);
  expect(changes()).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'Action', before: '', after: 'Record delivery outcome' })]));
  expect(api.post).not.toHaveBeenCalled();
});

test('native owner changes record the dependent action status without duplicating owner capture', async () => {
  await render(<ActionEditor action={{ _id: 'action', version: 1, status: 'unassigned', history: [] }} owners={owners} capabilities={{ supervise: true, assignRequests: true }} currentUserId="staff" onClose={() => {}} onSaved={() => {}}/>);
  await fill('Action owner', 'staff'); await deliver();
  expect(changes()).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'Action status', before: 'Unassigned', after: 'Assigned' })]));
  expect(changes().filter(change => /owner/i.test(change.field))).toHaveLength(1); expect(api.patch).not.toHaveBeenCalled();
});

test('removing internal evidence records a masked review-draft change without retaining message contents', async () => {
  await render(<ReviewPanel review={{ _id: 'review', version: 1, status: 'in_review', draft: { summary: 'Fixture', evidenceMessageIds: ['internal'] } }} detail={{ issue: {}, messages: [{ _id: 'internal', internalNote: true, text: 'PRIVATE-SOURCE-TEXT' }] }} categories={[]} capabilities={{}}/>);
  await click('Remove internal notes'); await deliver();
  expect(changes()).toEqual([expect.objectContaining({ field: 'Supporting messages', before: '[Not recorded]', after: '[Not recorded]', redacted: true })]);
  expect(JSON.stringify(events())).not.toContain('PRIVATE-SOURCE-TEXT'); expect(api.put).not.toHaveBeenCalled();
});

test('legacy quick due and classification suggestion buttons record only their unsaved business changes', async () => {
  const record = { _id: 'r', version: 1, canWork: true, status: 'open', history: [], followups: [], exceptions: [] };
  api.get.mockImplementation(async url => wrap(url.endsWith('/definitions') ? { topics: [{ id: 'delivery', label: 'Delivery' }] } : url.endsWith('/insights') ? { canDecide: true, requests: [{ suggestions: { version: 1, coverage: 'Fixture', candidates: [{ id: 'suggestion', label: 'Delivery', kind: 'complaint', topic: 'delivery', evidenceMessageIds: [] }] }, metrics: { coverage: 'Fixture', calendar: {}, counts: {}, episodes: [], assignment: {}, resolution: {}, waitingIntervals: [], reopens: [], ownershipIntervals: [], followups: [] } }] } : { requests: [record], rules: [] }));
  await render(<RequestWork requestId="r" conversationId="chat" actorId="staff" capabilities={{}} owners={owners} onSaved={() => {}}/>);
  await fill('Request action', 'followup'); await deliver(); fetchMock.mockClear(); await click('Tomorrow at 10:00 · Dubai'); await deliver();
  expect(changes()).toEqual([expect.objectContaining({ field: 'Due time · Dubai', before: '', after: expect.any(String) })]);
  fetchMock.mockClear(); await click('Accept suggestion'); await deliver();
  expect(changes()).toEqual(expect.arrayContaining([
    expect.objectContaining({ field: 'Classification decision', before: '', after: 'Accept' }),
    expect.objectContaining({ field: 'Type', before: '', after: 'Complaint' }),
    expect.objectContaining({ field: 'Topic', before: '', after: 'Delivery' })
  ])); expect(api.post).not.toHaveBeenCalled();
});

test('customer search clearing a selected link captures the cleared candidate privately', async () => {
  api.get.mockImplementation(async url => wrap(url.endsWith('/customer-link') ? { version: 1, contactId: 'contact' } : { records: [{ customerId: 'customer', name: 'Fixture customer' }], total: 1 }));
  await render(<CustomerLinkReview conversationId="chat" messages={[]} onSaved={() => {}}/>);
  await act(async () => { const details = el.querySelector('details'); details.open = true; details.dispatchEvent(new Event('toggle')); });
  const search = [...el.querySelectorAll('input')].find(node => node.type === 'text');
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(search, 'Fixture'); search.dispatchEvent(new Event('input', { bubbles: true })); });
  await click('Search customers');
  const select = [...el.querySelectorAll('select')].find(node => [...node.options].some(option => option.value === 'customer'));
  await act(async () => { select.value = 'customer'; select.dispatchEvent(new Event('change', { bubbles: true })); }); await deliver(); fetchMock.mockClear();
  await click('Search customers'); await deliver();
  expect(changes()).toEqual([expect.objectContaining({ field: 'Verified customer', redacted: true })]); expect(api.post).not.toHaveBeenCalled();
});

test('holiday confirmation captures its dependent calendar confirmations without duplicating the checkbox', async () => {
  api.get.mockResolvedValue(wrap({ workingDays: [1], holidays: [], hoursByDay: {}, holidayCalendarConfirmed: false, weeklyHoursConfirmed: false, confirmed: false, version: 1 }));
  await render(<MetricsCalendarSettings capabilities={{ managePolicies: true }}/>);
  await act(async () => [...el.querySelectorAll('label')].find(label => label.textContent.includes('Holiday list confirmed')).querySelector('input').click()); await deliver();
  expect(changes()).toEqual(expect.arrayContaining([
    expect.objectContaining({ field: 'Weekly hours confirmed', before: 'Not confirmed', after: 'Confirmed' }),
    expect.objectContaining({ field: 'Metric calendar confirmed', before: 'Not confirmed', after: 'Confirmed' })
  ])); expect(api.put).not.toHaveBeenCalled();
});

test('picker search and keyboard commits remain distinct and Escape does not classify the issue', async () => {
  await render(<RequestActionForm {...formProps}/>); await click('Inquiry'); await deliver(); fetchMock.mockClear();
  await fill('Choose issue', 'Missed');
  await act(async () => el.querySelector('[role="combobox"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  await deliver(); expect(changes()).toEqual([expect.objectContaining({ field: 'Issue search', after: 'Missed' })]);
  fetchMock.mockClear(); await fill('Choose issue', 'Missed');
  await act(async () => el.querySelector('[role="combobox"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  await deliver(); expect(changes()).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'Issue detail', after: 'Missed delivery' })])); expect(api.post).not.toHaveBeenCalled();
});

test('native topic changes capture cleared dependent detail and action fields without duplicating the topic', async () => {
  const nativeDefinitions = { ...definitions, issuePicker: { available: false }, topics: [...definitions.topics, { id: 'other', label: 'Other', includes: [{ id: 'other_detail', label: 'Other issue', workflowTopic: 'delivery' }] }] };
  await render(<RequestActionForm {...formProps} definitions={nativeDefinitions}/>); await click('Inquiry'); await fill('Topic', 'delivery'); await fill('Issue detail', 'missed'); await click('Update'); await fill('Order reference', 'PRIVATE-OLD-ORDER'); await deliver(); fetchMock.mockClear();
  await fill('Topic', 'other'); await deliver();
  expect(changes().filter(change => change.field === 'Topic')).toHaveLength(1);
  expect(changes()).toEqual(expect.arrayContaining([
    expect.objectContaining({ field: 'Issue detail', before: 'Missed delivery', after: '' }),
    expect.objectContaining({ field: 'Action', before: 'Check delivery', after: '' }),
    expect.objectContaining({ field: 'Order reference', redacted: true })
  ])); expect(JSON.stringify(events())).not.toContain('PRIVATE-OLD-ORDER');
});

test('failed saves and recovered drafts preserve values without inventing additional edit observations', async () => {
  await render(<RequestActionForm {...formProps}/>); await click('Inquiry'); await chooseIssue(); await fill('Check again · Dubai', '2026-11-19T11:45'); await deliver();
  api.post.mockRejectedValueOnce(new Error('Fixture failure'));
  await act(async () => el.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); await deliver(); fetchMock.mockClear();
  await act(async () => root.unmount()); root = createRoot(el); await render(<RequestActionForm {...formProps}/>); await deliver();
  expect(changes()).toEqual([]); expect(el.querySelector('[aria-label="Check again · Dubai"]').value).toBe('2026-11-19T11:45');
});

test('linked QA buttons capture private references and linked messages without sending a business command', async () => {
  const qaDefinitions = { ...definitions, actions: { delivery: [{ code: 'complete', label: 'Record day credit', terminal: true, outcomes: [{ code: 'day_credit_applied', label: 'Day credit applied', group: 'fulfilled', fields: [{ id: 'creditReference', label: 'Credit reference', type: 'text' }] }] }] } };
  const request = { _id: 'qa-issue', version: 1, classification: { kind: 'complaint', topic: 'delivery', subtopic: 'missed' } };
  const qaState = { practice: { detail: 'missed_delivery' }, events: [{ kind: 'credit_posted', body: { reference: 'PRIVATE-QA-REF' } }, { kind: 'customer_updated', body: { messageId: 'qa-reply' } }] };
  await render(<RequestActionForm {...formProps} request={request} definitions={qaDefinitions} qaState={qaState} capabilities={{ sidebarSandbox: true }}/>); await click('Resolve'); await fill('What happened?', 'complete:day_credit_applied'); await fill('Credit reference', ''); await deliver(); fetchMock.mockClear();
  await click('Use linked credit reference'); await click('Link captured staff reply'); await deliver();
  expect(changes()).toEqual(expect.arrayContaining([
    expect.objectContaining({ field: 'Credit reference', redacted: true }),
    expect.objectContaining({ field: 'Outcome evidence message', redacted: true })
  ])); expect(JSON.stringify(events())).not.toContain('PRIVATE-QA-REF'); expect(JSON.stringify(events())).not.toContain('qa-reply'); expect(api.post).not.toHaveBeenCalled();
});

test('review follow-up toggles capture the dependent owner and cleared private action description', async () => {
  await render(<ReviewPanel review={{ _id: 'review', version: 1, status: 'in_review', draft: { summary: 'Fixture', evidenceMessageIds: [], action: null } }} detail={{ issue: {}, messages: [] }} categories={[]} owners={owners} capabilities={{ assignRequests: true }} currentUserId="staff"/>);
  const followup = () => [...el.querySelectorAll('label')].find(label => label.textContent.includes('Follow-up needed')).querySelector('input');
  await act(async () => followup().click()); await deliver();
  expect(changes()).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'Action owner', before: '', after: 'Fixture staff' })]));
  const description = el.querySelector('[aria-label="Follow-up action"]');
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(description, 'PRIVATE-FOLLOWUP-CONTEXT'); description.dispatchEvent(new Event('input', { bubbles: true })); }); await deliver(); fetchMock.mockClear();
  await act(async () => followup().click()); await deliver();
  expect(changes()).toEqual(expect.arrayContaining([expect.objectContaining({ field: expect.stringMatching(/^Follow[- ]up action$/), redacted: true }), expect.objectContaining({ field: 'Action owner', before: 'Fixture staff', after: '' })])); expect(JSON.stringify(events())).not.toContain('PRIVATE-FOLLOWUP-CONTEXT');
});

test('discarding a stored issue draft records its removal without copying its private contents', async () => {
  sessionStorage.setItem('matter:request-draft:staff:chat', JSON.stringify({ drafts: { 'request:r': { fields: { reason: 'PRIVATE-DISCARDED-CONTEXT' }, mode: 'request_transfer', selected: 'r', editVersion: 1, savedAt: Date.now() } } }));
  api.get.mockImplementation(async url => wrap(url.endsWith('/definitions') ? { topics: [] } : { requests: [] }));
  await render(<RequestWork conversationId="chat" actorId="staff" capabilities={{}} owners={owners} onSaved={() => {}}/>); await deliver(); expect(changes()).toEqual([]);
  await click('Discard draft'); await deliver();
  expect(changes()).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'Saved issue draft', before: 'Retained', after: 'Discarded' })])); expect(JSON.stringify(events())).not.toContain('PRIVATE-DISCARDED-CONTEXT'); expect(el.textContent).not.toContain('Discard draft');
});

test('selecting an import file captures its suggested coverage dates without retaining source messages or file names', async () => {
  api.get.mockImplementation(async url => wrap(url.endsWith('/metrics') ? { sync: { mode: 'local' } } : url.endsWith('/request-calendar') ? { workingDays: [], holidays: [], hoursByDay: {} } : {}));
  await render(<Summary capabilities={{ supervise: true }} filters={{}} epoch={0} onRefresh={() => {}}/>);
  const file = new File(['fixture'], 'PRIVATE-CAPTURE-NAME.json', { type: 'application/json' });
  file.text = async () => JSON.stringify({ from: '2026-11-01', to: '2026-11-17', messages: [{ externalMessageId: 'source-message', externalConversationId: 'source-chat', sentAt: '2026-11-01T06:00:00Z', text: 'PRIVATE-IMPORTED-MESSAGE' }] });
  await act(async () => { const input = el.querySelector('input[type="file"]'); Object.defineProperty(input, 'files', { value: [file], configurable: true }); input.dispatchEvent(new Event('change', { bubbles: true })); }); await deliver();
  expect(changes()).toEqual(expect.arrayContaining([
    expect.objectContaining({ field: 'Coverage from (Dubai)', before: '', after: '2026-11-01' }),
    expect.objectContaining({ field: 'Coverage to (Dubai)', before: '', after: '2026-11-17' })
  ])); expect(JSON.stringify(events())).not.toContain('PRIVATE-CAPTURE-NAME'); expect(JSON.stringify(events())).not.toContain('PRIVATE-IMPORTED-MESSAGE'); expect(api.post).not.toHaveBeenCalled();
});

test('daily work queue and task-filter buttons record changed views without a business save', async () => {
  api.get.mockResolvedValue(wrap({ requests: [], taskCounts: {} }));
  await render(<RequestQueues capabilities={{ assignRequests: true }} onOpen={() => {}}/>); await deliver(); expect(changes()).toEqual([]);
  await click('My work'); await click('Waiting 0'); await deliver();
  expect(changes()).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'Work queue', before: 'Needs assignment', after: 'My work' }), expect.objectContaining({ field: 'Work filter', before: 'All work', after: 'Waiting' })])); expect(api.post).not.toHaveBeenCalled();
});

test('report drilldowns and follow-up queues capture readable filters independently of business drafts', async () => {
  api.get.mockResolvedValue(wrap({ summary: {}, calendar: {}, requests: [], outcomeCounts: {}, nextOffset: null }));
  await render(<RequestReport filters={{}}/>); await click('Still open 0'); await deliver();
  expect(changes()).toEqual([expect.objectContaining({ field: 'Outcome filter', before: 'All outcomes', after: 'Still open' })]);
  fetchMock.mockClear(); await render(<Problems me={{ profile: { userId: 'staff' } }} capabilities={{ supervise: true }} categories={[]} filters={{}} onRefresh={() => {}}/>); await click('Overdue'); await deliver();
  expect(changes()).toEqual([expect.objectContaining({ field: 'Follow up queue', before: 'Team actions', after: 'Overdue' })]); expect(api.post).not.toHaveBeenCalled();
});

test('directory and inbox shortcut buttons record the resulting views and date filters', async () => {
  api.get.mockResolvedValue(wrap({ records: [], conversations: [], total: 0 }));
  await render(<Customers filters={{}} capabilities={{}} me={{}}/>); await click('Unmatched conversations'); await deliver();
  expect(changes()).toEqual([expect.objectContaining({ field: 'Customer directory view', before: 'Matter customers', after: 'Unmatched conversations' })]); fetchMock.mockClear();
  function Inbox() {const [filters,setFilters]=React.useState({from:'2026-11-01',to:'2026-11-16'});return <CustomerChats filters={filters} onFiltersChange={setFilters} me={{}} capabilities={{}} categories={[]} onRefresh={() => {}}/>;}
  await render(<Inbox/>); await click('All time'); await click('Unassigned'); await click('My work & follow-ups'); await deliver();
  expect(changes()).toEqual(expect.arrayContaining([
    expect.objectContaining({ field: 'From date in Dubai', before: '2026-11-01', after: '' }),
    expect.objectContaining({ field: 'To date in Dubai', before: '2026-11-16', after: '' }),
    expect.objectContaining({ field: 'Conversation assignment', before: 'All assignments', after: 'Unassigned' }),
    expect.objectContaining({ field: 'Inbox view', before: 'Conversations', after: 'Staff work' })
  ])); expect(api.post).not.toHaveBeenCalled();
});

test('customer service page tabs capture the selected page before navigation', async () => {
  api.get.mockImplementation(async url => wrap(url.endsWith('/me') ? { profile: { userId: 'staff' }, capabilities: { review: true } } : {}));
  await render(<CustomerService/>); await deliver(); fetchMock.mockClear();
  await act(async () => [...el.querySelectorAll('a')].find(link => link.textContent === 'Follow-ups').click()); await deliver();
  expect(changes()).toEqual([expect.objectContaining({ field: 'Customer service page', before: 'Inbox', after: 'Follow-ups' })]); expect(api.post).not.toHaveBeenCalled();
});

test('directory pagination and selected customer references are observed without copying the private identity', async () => {
  api.get.mockResolvedValue(wrap({ records: [{ customerId: 'PRIVATE-CUSTOMER-REF', name: 'Fixture customer', issues: [] }], total: 100, pageSize: 50 }));
  await render(<Customers filters={{}} capabilities={{}} me={{}}/>); await click('Next page'); await click('View customer'); await deliver();
  expect(changes()).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'Directory page', before: '1', after: '2' }), expect.objectContaining({ field: 'Selected customer', redacted: true })]));
  expect(JSON.stringify(events())).not.toContain('PRIVATE-CUSTOMER-REF'); expect(api.post).not.toHaveBeenCalled();
});

test('native reply evidence choices keep source message wording out of activity values', async () => {
  const answerDefinitions = { ...definitions, actions: { delivery: [{ code: 'answer', label: 'Record answer', terminal: true, outcomes: [{ code: 'information_provided', label: 'Information provided', group: 'information', fields: [] }] }] } };
  const request = { _id: 'issue', version: 1, classification: { kind: 'inquiry', topic: 'delivery', subtopic: 'missed' } };
  await render(<RequestActionForm {...formProps} request={request} definitions={answerDefinitions} messages={[{ _id: 'reply', authorType: 'staff', text: 'PRIVATE-REPLY-WORDING', sentAt: '2026-11-17T06:00:00Z' }]}/>); await click('Resolve'); await fill('What happened?', 'answer:information_provided'); await deliver(); fetchMock.mockClear();
  await fill('Outcome evidence message', 'reply'); await deliver();
  expect(changes()).toEqual([expect.objectContaining({ field: 'Outcome evidence message', redacted: true })]); expect(JSON.stringify(events())).not.toContain('PRIVATE-REPLY-WORDING');
});

test('native supporting-message checks use safe activity labels instead of source excerpts', async () => {
  await render(<ReviewPanel review={{ _id: 'review', version: 1, status: 'in_review', draft: { summary: 'Fixture', evidenceMessageIds: [] } }} detail={{ issue: {}, messages: [{ _id: 'reply', authorType: 'staff', authorName: 'Fixture staff', text: 'PRIVATE-SUPPORTING-WORDING' }] }} categories={[]} capabilities={{}}/>);
  await act(async () => el.querySelector('.cs-evidence input').click()); await deliver();
  expect(changes()).toEqual([expect.objectContaining({ field: 'Supporting message', redacted: true })]); expect(JSON.stringify(events())).not.toContain('PRIVATE-SUPPORTING-WORDING');
});

test('practice topic selection records its dependent detail default without repeating the native topic edit', async () => {
  api.get.mockResolvedValue(wrap({ topics: [{ id: 'tag_delivery', label: 'Delivery', includes: [{ id: 'missed_delivery', label: 'Missed delivery' }] }, { id: 'tag_account', label: 'Account', includes: [{ id: 'website', label: 'Website issue' }] }] }));
  await render(<SidebarSandbox conversationId="chat" onOpen={() => {}} onRefresh={() => {}}/>); await deliver(); expect(changes()).toEqual([]);
  await fill('Practice topic', 'tag_account'); await deliver();
  expect(changes().filter(change => change.field === 'Practice topic')).toHaveLength(1);
  expect(changes()).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'Practice detail', before: 'Missed delivery', after: 'Website issue' })])); expect(api.post).not.toHaveBeenCalled();
});

test('customer history selections record masked conversation and saved-review choices', async () => {
  const history = [{ _id: 'PRIVATE-HISTORY-ONE', conversationId: 'private-conversation', summary: 'First recorded issue' }, { _id: 'PRIVATE-HISTORY-TWO', conversationId: 'private-conversation', summary: 'Second recorded issue' }];
  api.get.mockImplementation(async url => wrap(url.endsWith('/context') ? { issues: history } : { issue: {}, messages: [], reviews: [] }));
  await render(<CustomerContextDrawer customerId="customer" issues={history} categories={[]} capabilities={{}} currentUserId="staff" onClose={() => {}}/>); await deliver(); expect(changes()).toEqual([]);
  await click('View conversation'); await deliver();
  expect(changes()).toEqual([expect.objectContaining({ field: 'Selected historical issue', redacted: true })]); fetchMock.mockClear();
  await click('‹ Back to conversation history'); await click('Second recorded issue'); await deliver();
  expect(changes().filter(change => change.field === 'Selected historical issue')).toHaveLength(2); expect(JSON.stringify(events())).not.toMatch(/PRIVATE-HISTORY|private-conversation/); expect(api.post).not.toHaveBeenCalled();
});

test.each([
  { recordId: 'PRIVATE-NEW-ISSUE', candidate: false, expectedField: 'Selected issue' },
  { recordId: undefined, candidate: true, expectedField: 'Selected source message' }
])('opening a work-queue choice in the same conversation records $expectedField', async ({recordId,candidate,expectedField}) => {
  window.history.replaceState({}, '', '/customer-service/chats?conversation=chat&request=PRIVATE-OLD-ISSUE');
  const queued = { _id: recordId, candidate, originMessageId: 'PRIVATE-CANDIDATE-MESSAGE', excerpt: 'Fixture source excerpt', conversationId: 'chat', canWork: true, status: 'open', title: 'Fixture queued request', history: [], followups: [], exceptions: [] };
  api.get.mockImplementation(async (url,options) => wrap(url.endsWith('/definitions') ? { topics: [] } : url.endsWith('/conversations/chat') ? { conversation: { _id: 'chat', source: 'gallabox' }, messages: [], sessions: [] } : url.endsWith('/requests') ? { requests: options?.params?.queue!=='conversation'||!candidate?[queued]:[] } : {}));
  await render(<CustomerChats filters={{}} me={{ profile: { userId: 'staff' } }} capabilities={{}} categories={[]} onRefresh={() => {}}/>);
  await act(async () => el.querySelector('.cs-my-work').click()); await deliver(); fetchMock.mockClear();
  await act(async () => el.querySelector('.cs-request-strip button').click()); await deliver();
  expect(changes()).toEqual(expect.arrayContaining([expect.objectContaining({ field: expectedField, redacted: true })])); expect(JSON.stringify(events())).not.toMatch(/PRIVATE-OLD-ISSUE|PRIVATE-NEW-ISSUE|PRIVATE-CANDIDATE-MESSAGE/); expect(api.post).not.toHaveBeenCalled();
});
