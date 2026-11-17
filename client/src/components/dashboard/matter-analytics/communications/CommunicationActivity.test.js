import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import ReportIssueForm from './ReportIssueForm';
import QuickNewCommunicationModal from './QuickNewCommunicationModal';
import DeliveryIssuesTab from './DeliveryIssuesTab';
import { installActivityCapture } from '../../../../utils/activityCapture';
import api from '../../../../utils/api';
jest.mock('../../../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
jest.mock('react-redux', () => ({ useSelector: selector => selector({ auth: { user: { role: 'manager' } } }) }));
global.IS_REACT_ACT_ENVIRONMENT = true;
let root, el, cleanup, fetchMock;
const events = () => fetchMock.mock.calls.flatMap(([, options]) => JSON.parse(options.body).events);
const changes = () => events().filter(event => event.stage === 'form_edited').flatMap(event => event.changes);
const click = text => act(async () => [...el.querySelectorAll('button')].find(button => button.textContent.trim() === text).click());
const render = node => act(async () => root.render(node));
async function fill(node, value) { await act(async () => { node.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); const prototype = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); }); }
async function deliver() { await act(async () => { jest.advanceTimersByTime(2200); for (let n = 0; n < 12; n++) await Promise.resolve(); }); }
async function attach() { const file = new File(['fixture'], 'PRIVATE-PHOTO-NAME.jpg', { type: 'image/jpeg' }); await act(async () => { const input = el.querySelector('input[type="file"]'); Object.defineProperty(input, 'files', { configurable: true, value: [file] }); input.dispatchEvent(new Event('change', { bubbles: true })); }); }
beforeEach(() => {
  jest.useFakeTimers(); jest.clearAllMocks(); localStorage.clear(); localStorage.setItem('token', 'fixture-session'); localStorage.setItem('user', JSON.stringify({ _id: 'staff' }));
  Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined }); window.history.replaceState({}, '', '/dashboard');
  jest.spyOn(console, 'warn').mockImplementation(() => {}); URL.createObjectURL = jest.fn(() => 'blob:PRIVATE-PHOTO-PREVIEW');
  fetchMock = jest.fn().mockResolvedValue({ ok: true, headers: { get: () => null }, json: async () => ({ success: true }) }); window.fetch = fetchMock;
  api.get.mockResolvedValue({ data: { data: [{ customerId: 'private-customer-id', firstName: 'PRIVATE-CUSTOMER' }] } });
  api.post.mockResolvedValue({ data: { url: 'https://private.invalid/PRIVATE-PHOTO-URL.jpg' } });
  el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el); cleanup = installActivityCapture();
});
afterEach(async () => { await act(async () => root.unmount()); cleanup(); el.remove(); jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks(); localStorage.clear(); });

test('report issue customer choices and priority buttons are captured before submitting, with private customer values', async () => {
  await render(<ReportIssueForm/>); await click('High'); await fill(el.querySelector('input[type="text"]'), 'Fixture'); await deliver();
  await act(async () => [...el.querySelectorAll('button')].find(button => button.textContent.includes('PRIVATE-CUSTOMER')).click()); await deliver();
  expect(changes()).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'Priority', before: 'Medium', after: 'High' }), expect.objectContaining({ field: 'Selected customer', redacted: true })]));
  fetchMock.mockClear(); await act(async () => el.querySelector('[aria-label="Clear selected customer"]').click()); await deliver();
  expect(changes()).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'Selected customer', redacted: true })])); expect(JSON.stringify(events())).not.toContain('PRIVATE-CUSTOMER'); expect(JSON.stringify(events())).not.toContain('private-customer-id'); expect(api.post).not.toHaveBeenCalled();
});

test('report issue photo removal records counts without photo names or URLs and does not submit the issue', async () => {
  await render(<ReportIssueForm/>); await attach(); await deliver(); fetchMock.mockClear(); await click('Remove'); await deliver();
  expect(changes()).toEqual([expect.objectContaining({ field: 'Selected files', before: '1', after: '0', redacted: false })]); expect(el.querySelector('img')).toBeNull();
  expect(JSON.stringify(events())).not.toMatch(/PRIVATE-PHOTO|private\.invalid/); expect(api.post.mock.calls.map(([path]) => path)).toEqual(['/upload/delivery-photo']);
});

test('quick communication priority, attachment removal and cancellation are observed with masked free text before Send', async () => {
  const onClose = jest.fn(); await render(<QuickNewCommunicationModal onClose={onClose}/>); await fill(el.querySelector('input[type="text"]'), 'PRIVATE-CUSTOMER-NAME'); await fill(el.querySelector('textarea'), 'PRIVATE-CHAT-TEXT'); await click('High'); await attach(); await deliver();
  expect(changes()).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'Priority', before: 'Low', after: 'High' })])); expect(JSON.stringify(events())).not.toMatch(/PRIVATE-CUSTOMER-NAME|PRIVATE-CHAT-TEXT/);
  fetchMock.mockClear(); await click('Remove'); await click('Cancel'); await deliver();
  expect(changes()).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'Selected files', before: '1', after: '0' }), expect.objectContaining({ field: 'Communication view', before: 'Open', after: 'Closed' })]));
  expect(onClose).toHaveBeenCalledTimes(1); expect(api.post.mock.calls.map(([path]) => path)).toEqual(['/upload/delivery-photo']); expect(JSON.stringify(events())).not.toMatch(/PRIVATE-PHOTO|private\.invalid/);
});

test('delivery issue filters and selected resolution records are observed before any resolution save', async () => {
  api.get.mockImplementation(async path => ({ data: path.startsWith('/delivery-issues') ? { issues: [{ _id: 'PRIVATE-ISSUE-ID', customerName: 'Fixture customer', issueType: 'wrong_item', priority: 'medium', status: 'open', description: 'PRIVATE-ISSUE-CONTEXT' }] } : { data: [] } }));
  await render(<DeliveryIssuesTab/>); await deliver(); expect(changes()).toEqual([]);
  await click('Open (1)'); await act(async () => el.querySelector('div.cursor-pointer').click()); await deliver();
  expect(changes()).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'Delivery issue filter', before: 'All', after: 'Open' }), expect.objectContaining({ field: 'Selected delivery issue', redacted: true })]));
  await fill(el.querySelector('textarea[placeholder^="Describe how"]'), 'PRIVATE-RESOLUTION-NOTE'); await deliver();
  expect(JSON.stringify(events())).not.toMatch(/PRIVATE-ISSUE|PRIVATE-RESOLUTION-NOTE/); expect(api.post).not.toHaveBeenCalled();
});
