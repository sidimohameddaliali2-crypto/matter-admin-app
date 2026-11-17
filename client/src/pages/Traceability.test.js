import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import Traceability from './Traceability';
import api from '../utils/api';
import { readCaptureStatus } from '../utils/activityCapture';

jest.mock('../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../utils/activityCapture', () => ({ readCaptureStatus: jest.fn() }));

const events = [
  {
    eventId: 'saved-driver',
    occurredAt: '2026-11-17T08:30:00.000Z',
    actor: { name: 'Osman', role: 'dispatcher' },
    area: 'Drivers',
    action: 'added',
    summary: 'Osman added a driver',
    issue: '',
    outcome: 'saved',
    stage: 'record_saved',
    changes: [{ field: 'Name', before: null, after: 'Example driver' }],
    form: { page: 'Drivers', title: 'Add driver', field: null },
    requestId: 'private-request-reference',
  },
  {
    eventId: 'edited-form',
    occurredAt: '2026-11-17T08:25:00.000Z',
    actor: { name: 'Sara', role: 'manager' },
    area: 'Drivers',
    action: 'edited form',
    summary: 'Sara edited the driver form',
    issue: '',
    outcome: 'draft',
    stage: 'form_edited',
    changes: [{ field: 'Phone number', before: 'sensitive-before', after: 'sensitive-after', redacted: true }],
    form: { page: 'Drivers', title: 'Edit driver', field: 'Phone number' },
    requestId: null,
  },
  {
    eventId: 'failed-change',
    occurredAt: '2026-11-17T08:20:00.000Z',
    actor: { name: 'Ali', role: 'dispatcher' },
    area: 'Deliveries',
    action: 'assigned',
    summary: 'Ali tried to assign a delivery',
    issue: 'The delivery could not be assigned because no driver was selected.',
    outcome: 'failed',
    stage: 'action_response',
    changes: [],
    form: { page: 'Deliveries', title: 'Assign driver', field: null },
    requestId: 'another-private-reference',
  },
];
const activity = {
  events,
  nextCursor: null,
  storage: { kind: 'mongo', durable: true },
  coverage: {
    formCapture: true,
    serverChanges: true,
    captureFailures: 0,
    limitations: ['Activity from before tracking was enabled is not available.'],
  },
  preview: false,
};
const response = (data = activity) => ({ data: { success: true, data } });
let root;
let container;
const button = (text) => [...container.querySelectorAll('button')].find((item) => item.textContent.trim() === text);
const render = async () => act(async () => root.render(<Traceability />));
const click = async (element) => act(async () => element.click());
const typeSearch = async (value) => act(async () => {
  const input = container.querySelector('input');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
const waitForSearch = async () => act(async () => jest.advanceTimersByTime(250));
const search = async (value) => { await typeSearch(value); await waitForSearch(); };
const defer = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

beforeEach(() => {
  jest.useFakeTimers();
  global.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  readCaptureStatus.mockReturnValue({ pendingEvents: 0, failedBatches: 0, droppedEvents: 0, durableQueueSupported: true, queueIssue: null });
  api.get.mockImplementation(async (path, { params }) => {
    if (path !== '/traceability/activity') throw new Error(`Unexpected page request: ${path}`);
    if (params.q === 'osman' || params.q === 'Osman') return response({ ...activity, events: [events[0]] });
    if (params.q === 'no driver') return response({ ...activity, events: [events[2]] });
    if (params.q === 'no matching person') return response({ ...activity, events: [] });
    if (params.issues === '1') return response({ ...activity, events: [events[2]] });
    return response();
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  jest.useRealTimers();
  jest.resetAllMocks();
});

test('opens with one clear issue sentence, its person and time, and a visible Details label', async () => {
  await render();
  expect(container.querySelector('h1').textContent).toBe('Issues');
  expect(container.querySelectorAll('.trace-event')).toHaveLength(1);
  const row = container.querySelector('.trace-event-button');
  expect(row.textContent).toContain('Ali: The delivery could not be assigned because no driver was selected.');
  expect(row.textContent).toContain('12:20');
  expect(row.textContent).toContain('Details');
  expect(row.textContent.match(/no driver was selected/g)).toHaveLength(1);
  expect(row.textContent).not.toMatch(/Dispatcher|Deliveries|Outcome|Did not complete/);
  expect(button('Issues').getAttribute('aria-pressed')).toBe('true');
  expect(container.textContent).not.toMatch(/private-request|saved-driver|Access declarations|HTTP|API routes/);
  expect(api.get.mock.calls[0][1].params).toEqual({ limit: 100, issues: '1' });
});
test('draft rows stay plain while Details retains the exact record identity', async () => {
  const id = '111111111111111111111111';
  api.get.mockResolvedValue(response({ ...activity, events: [{ ...events[1], summary: `Sara edited Rice bowl (${id}) quantity.`, changes: [{ field: `Rice bowl (${id}) quantity`, before: '1', after: '2' }] }] }));
  await render();
  const row = container.querySelector('.trace-event-button');
  expect(row.textContent).toContain('Sara edited Rice bowl quantity.'); expect(row.textContent).not.toContain(id);
  await click(row); expect(container.querySelector('[aria-label="Activity details"]').textContent).toContain(id);
});
test('unsaved changes show the observed before and after and preserve a literal record reference', async () => {
  const field = 'Delivery dates (11111111-1111-4111-8111-111111111111)';
  api.get.mockResolvedValue(response({ ...activity, events: [{ ...events[1], changes: [{ field, before: '2026-11-18, 2026-11-20', after: '2026-11-20' }] }] }));
  await render(); await click(container.querySelector('.trace-event-button'));
  const details = container.querySelector('[aria-label="Activity details"]');
  expect(details.querySelector('h4').textContent).toBe(field);
  expect(details.textContent).toContain('Before edit'); expect(details.textContent).toContain('After edit');
  expect(details.textContent).toContain('2026-11-18, 2026-11-20'); expect(details.textContent).toContain('Form edit · not saved');
});

test('labels failed attempted values as entered values rather than a saved before-and-after change', async () => {
  api.get.mockResolvedValueOnce(response({ ...activity, events: [{ ...events[2], changes: [{ field: 'Driver', before: 'Previous driver', after: 'Attempted driver' }] }] }));
  await render();
  await click(container.querySelector('.trace-event-button'));
  const details = container.querySelector('[aria-label="Activity details"]');
  expect(details.textContent).toContain('Entered values');
  expect(details.querySelector('.trace-changes').textContent).toContain('Attempted driver');
  expect(details.querySelector('.trace-changes').textContent).not.toMatch(/Before|After|Previous driver/);
});

test('uses an explanatory summary once and keeps the action when an issue reason is short', async () => {
  api.get.mockResolvedValueOnce(response({ ...activity, events: [
    { ...events[2], eventId: 'duplicate-driver', actor: { name: 'Osman' }, summary: 'Osman could not add a driver because a matching record already exists.', issue: 'A matching record already exists.' },
    { ...events[2], issue: 'No driver was selected.' },
  ] }));
  await render();
  const rows = container.querySelectorAll('.trace-event-button');
  expect(rows[0].querySelector('strong').textContent).toBe('Osman could not add a driver because a matching record already exists.');
  expect(rows[0].textContent.match(/matching record already exists/gi)).toHaveLength(1);
  expect(rows[1].querySelector('strong').textContent).toBe('Ali could not assign a delivery: No driver was selected.');
});

test('filters issues using the recorded issue and searches people, actions and issues', async () => {
  await render();
  await click(button('Issues'));
  expect(container.querySelectorAll('.trace-event')).toHaveLength(1);
  expect(container.textContent).toContain('no driver was selected');
  expect(container.querySelector('.trace-event').textContent).not.toContain('Osman');
  await click(button('All activity'));
  await search('osman');
  expect(container.querySelectorAll('.trace-event')).toHaveLength(1);
  expect(container.querySelector('.trace-event').textContent).toContain('Osman added a driver');
  await search('no driver');
  expect(container.querySelector('.trace-event').textContent).toContain('Ali: The delivery could not be assigned');
  await search('no matching person');
  expect(container.querySelectorAll('.trace-event')).toHaveLength(0);
  expect(container.textContent).toContain('No matching activity');
  await click(button('Clear search'));
  await waitForSearch();
  expect(container.querySelectorAll('.trace-event')).toHaveLength(3);
});

test('debounces server search and finds an activity outside the initially loaded page', async () => {
  await render();
  const older = { ...events[2], eventId: 'older', summary: 'Hana tried to add a customer', issue: 'The customer could not be added.', actor: { name: 'Hana', role: 'manager' } };
  api.get.mockResolvedValueOnce(response({ ...activity, events: [older] }));
  await typeSearch('Han');
  await act(async () => jest.advanceTimersByTime(249));
  expect(api.get).toHaveBeenCalledTimes(1);
  await typeSearch('Hana');
  await waitForSearch();
  expect(api.get.mock.calls[1][1].params).toEqual({ limit: 100, q: 'Hana', issues: '1' });
  expect(container.querySelectorAll('.trace-event')).toHaveLength(1);
  expect(container.textContent).toContain('Hana: The customer could not be added.');
  expect(container.textContent).not.toContain('Search and filters apply to these results');
  await click(button('All activity'));
  expect(api.get.mock.calls[2][1].params).toEqual({ limit: 100, q: 'Hana' });
});

test('appends older pages without duplicates, retries a failed page, and refreshes back to the first page', async () => {
  api.get.mockResolvedValueOnce(response({ ...activity, events: [events[0]], nextCursor: 'page-two' }));
  await render();
  await click(container.querySelector('.trace-event-button'));
  api.get.mockResolvedValueOnce(response({ ...activity, events: [events[0], events[1]], nextCursor: 'page-three' }));
  await click(button('Load older activity'));
  expect(api.get.mock.calls[1][1].params).toEqual({ limit: 100, issues: '1', before: 'page-two' });
  expect(container.querySelectorAll('.trace-event')).toHaveLength(2);
  expect(container.querySelector('[aria-label="Activity details"]')).not.toBeNull();
  api.get.mockRejectedValueOnce(new Error('offline'));
  await click(button('Load older activity'));
  expect(container.querySelector('[role="alert"]').textContent).toContain('Older activity could not be loaded');
  expect(container.querySelectorAll('.trace-event')).toHaveLength(2);
  api.get.mockResolvedValueOnce(response({ ...activity, events: [events[2]] }));
  await click(button('Try again'));
  expect(api.get.mock.calls[3][1].params.before).toBe('page-three');
  expect(container.querySelectorAll('.trace-event')).toHaveLength(3);
  expect(button('Load older activity')).toBeUndefined();
  api.get.mockResolvedValueOnce(response({ ...activity, events: [events[0]], nextCursor: 'page-two' }));
  await click(button('Refresh'));
  expect(api.get.mock.calls[4][1].params).toEqual({ limit: 100, issues: '1' });
  expect(container.querySelectorAll('.trace-event')).toHaveLength(1);
  expect(container.querySelector('[aria-label="Activity details"]')).not.toBeNull();
});

test('cancels an older search and ignores its late response', async () => {
  await render();
  const oldRequest = defer();
  api.get.mockReturnValueOnce(oldRequest.promise);
  await search('Hana');
  const oldSignal = api.get.mock.calls[1][1].signal;
  await search('Osman');
  expect(oldSignal.aborted).toBe(true);
  await act(async () => oldRequest.resolve(response({ ...activity, events: [events[1]] })));
  expect(container.querySelectorAll('.trace-event')).toHaveLength(1);
  expect(container.querySelector('.trace-event').textContent).toContain('Osman');
});

test('surfaces server storage issues and missing capture history outside the collapsed coverage', async () => {
  api.get.mockResolvedValueOnce(response({ ...activity,
    events: [],
    storage: { kind: 'mongo', durable: true, issue: 'Some stored activity could not be read.' },
    coverage: { ...activity.coverage, captureFailures: 3 },
  }));
  await render();
  const warnings = [...container.querySelectorAll('[role="alert"]')].map((element) => element.textContent).join(' ');
  expect(warnings).toContain('Some stored activity could not be read.');
  expect(warnings).toContain('3 activities could not be recorded');
  expect(container.textContent).not.toContain('No activity has been recorded yet');
  expect(container.querySelector('details[open]')).toBeNull();
});

test('shows current browser pending and lost activity without exposing queued field content', async () => {
  readCaptureStatus.mockReturnValue({ pendingEvents: 2, failedBatches: 1, droppedEvents: 0, durableQueueSupported: true, queueIssue: null });
  await render();
  expect(container.textContent).toContain('2 form activities are waiting to be recorded');
  readCaptureStatus.mockReturnValue({ pendingEvents: 1, failedBatches: 2, droppedEvents: 4, durableQueueSupported: false, queueIssue: 'storage-unavailable', privateField: 'do-not-render' });
  await act(async () => window.dispatchEvent(new CustomEvent('matter:activity-capture-status')));
  expect(container.querySelector('[role="alert"]').textContent).toContain('4 form activities could not be recorded');
  expect(container.textContent).not.toMatch(/storage-unavailable|do-not-render/);
  readCaptureStatus.mockReturnValue({ pendingEvents: 0, failedBatches: 1, droppedEvents: 0, durableQueueSupported: true, queueIssue: null });
  await act(async () => window.dispatchEvent(new CustomEvent('matter:activity-capture-status')));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).not.toContain('waiting to be recorded');
});

test('keeps account, references and confirmation notes inside closed More information', async () => {
  await render();
  await click(button('All activity'));
  api.get.mockResolvedValueOnce(response({ ...activity, events: [{ ...events[0], actor: { ...events[0].actor, id: 'private-account-reference' }, confirmation: 'The saved change was confirmed by the app.', previousValuesObserved: true }] }));
  await click(button('Refresh'));
  await click(container.querySelector('.trace-event-button'));
  const details = container.querySelector('[aria-label="Activity details"]');
  expect(details.querySelector('.trace-facts').textContent).not.toMatch(/private-account|private-request|Dispatcher/);
  const more = details.querySelector('details');
  expect(more.open).toBe(false);
  expect(more.textContent).toContain('private-account-reference');
  expect(more.textContent).toContain('private-request-reference');
  expect(more.textContent).toContain('The saved change was confirmed by the app.');
  expect(more.textContent).toContain('Earlier values were observed before saving; simultaneous edits can affect them.');
  await click(more.querySelector('summary'));
  expect(more.open).toBe(true);
});

test('opens before and after details with the person and form, and can close them', async () => {
  await render();
  await click(button('All activity'));
  const row = container.querySelector('.trace-event-button');
  await click(row);
  const details = container.querySelector('[aria-label="Activity details"]');
  expect(row.getAttribute('aria-expanded')).toBe('true');
  expect(details.textContent).toContain('Osman');
  expect(details.textContent).toContain('Add driver');
  expect(details.textContent).toContain('Before');
  expect(details.textContent).toContain('After');
  expect(details.textContent).toContain('Empty');
  expect(details.textContent).toContain('Example driver');
  expect(details.querySelector('.trace-facts').textContent).not.toContain('private-request-reference');
  await click(row);
  expect(container.querySelector('[aria-label="Activity details"]')).toBeNull();
});

test('labels a form edit as not saved and hides protected before and after values', async () => {
  await render();
  await click(button('All activity'));
  const draft = container.querySelectorAll('.trace-event')[1];
  expect(draft.textContent).toContain('Not saved');
  await click(draft.querySelector('button'));
  const details = container.querySelector('[aria-label="Activity details"]');
  expect(details.textContent).toContain('This records an edit to a form. It does not confirm that the change was saved.');
  expect(details.textContent).toContain('Hidden for privacy');
  expect(container.textContent).not.toMatch(/sensitive-before|sensitive-after/);
});

test('keeps submitted and accepted actions separate from confirmed saved changes', async () => {
  await render();
  await click(button('All activity'));
  api.get.mockResolvedValueOnce(response({ ...activity, events: [
    { ...events[0], eventId: 'submitted', stage: 'form_submitted', outcome: 'submitted' },
    { ...events[0], eventId: 'accepted', stage: 'action_response', outcome: 'accepted' },
    { ...events[0], eventId: 'pending', stage: 'record_change_started', outcome: 'pending' },
    { ...events[0], eventId: 'unconfirmed', stage: 'action_response', outcome: 'saved' },
  ] }));
  await click(button('Refresh'));
  const outcomes = [];
  for (const row of container.querySelectorAll('.trace-event-button')) {
    await click(row);
    outcomes.push(container.querySelector('.trace-result').textContent);
  }
  expect(outcomes).toEqual(['Submitted · awaiting result', 'Action accepted', 'In progress', 'Result not confirmed']);
});

test('shows loading, retry after a failure, and preserves filters and old results on refresh failure', async () => {
  const pending = defer();
  api.get.mockReturnValueOnce(pending.promise);
  await render();
  expect(container.textContent).toContain('Loading activity');
  expect(button('Loading…').disabled).toBe(true);
  await act(async () => pending.reject(new Error('offline')));
  expect(container.querySelector('[role="alert"]').textContent).toContain('could not be loaded');
  await click(button('Try again'));
  expect(container.querySelectorAll('.trace-event')).toHaveLength(1);
  await search('Osman');
  await click(container.querySelector('.trace-event-button'));
  api.get.mockRejectedValueOnce(new Error('offline'));
  await click(button('Refresh'));
  expect(container.querySelector('[role="alert"]').textContent).toContain('previous results are still shown');
  expect(container.querySelector('input').value).toBe('Osman');
  expect(container.querySelector('[aria-label="Activity details"]')).not.toBeNull();
  await click(button('Try again'));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelectorAll('.trace-event')).toHaveLength(1);
});

test('distinguishes a healthy empty history from unavailable storage and marks preview examples', async () => {
  api.get.mockResolvedValueOnce(response({ ...activity, events: [] }));
  await render();
  expect(container.textContent).toContain('No recorded issues found');
  api.get.mockResolvedValueOnce(response({ ...activity, events: [] }));
  await click(button('All activity'));
  expect(container.textContent).toContain('No activity has been recorded yet');
  api.get.mockResolvedValueOnce(response({
    ...activity,
    events: [],
    storage: { kind: 'unavailable', durable: false },
  }));
  await click(button('Refresh'));
  expect(container.textContent).toContain('History storage is unavailable');
  expect(container.textContent).not.toContain('No activity has been recorded yet');
  api.get.mockResolvedValueOnce(response({ ...activity, preview: true, storage: { kind: 'preview', durable: false } }));
  await click(button('Refresh'));
  expect(container.textContent).toContain('Preview');
  expect(container.textContent).toContain('Fictional');
  expect(container.querySelector('details[open]')).toBeNull();
  expect(container.querySelector('details')).toBeNull();
});

test('aborts a pending request when the page is closed', async () => {
  const pending = defer();
  api.get.mockReturnValueOnce(pending.promise);
  await render();
  const signal = api.get.mock.calls[0][1].signal;
  await act(async () => root.unmount());
  expect(signal.aborted).toBe(true);
  await act(async () => pending.resolve(response()));
  expect(container.textContent).toBe('');
  root = createRoot(container);
});

test('treats a malformed response as a load failure instead of an empty history', async () => {
  api.get.mockResolvedValueOnce({ data: { success: true, data: {} } });
  await render();
  expect(container.querySelector('[role="alert"]').textContent).toContain('could not be loaded');
  expect(container.textContent).not.toContain('No activity has been recorded yet');
});
