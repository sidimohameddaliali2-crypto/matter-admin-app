import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import Renewal from './Renewal';
import DeliveryChanges from './DeliveryChanges';
import Complaints from './Complaints';
import BagRefundTracker from '../components/bags/BagRefundTracker';
import api from '../utils/api';
import { recordActivityChange } from '../utils/activityCapture';

jest.mock('../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
jest.mock('../utils/activityCapture', () => ({ recordActivityChange: jest.fn() }));
const mockDispatch = jest.fn();
jest.mock('react-redux', () => ({ useDispatch: () => mockDispatch, useSelector: fn => fn({ deliveryChange: { changes: [], isLoading: false } }) }));
jest.mock('react-router-dom', () => ({ useNavigate: () => jest.fn(), Link: ({ children }) => <span>{children}</span> }), { virtual: true });

let host, root;
const render = node => act(async () => root.render(node));
const button = label => [...host.querySelectorAll('button')].find(node => node.textContent.trim() === label || node.title === label);
const click = label => act(async () => button(label).click());
const changes = () => recordActivityChange.mock.calls.map(([change]) => change);
const fill = (node, value) => act(() => { Object.getOwnPropertyDescriptor(node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); });
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true; jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  api.get.mockImplementation(async url => ({ data: { data: url === '/customers' ? [] : url === '/deliveries' ? { deliveries: [] } : { complaints: [], pagination: { pages: 1 } } } }));
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); jest.restoreAllMocks(); });

test('renewal urgency chips and clear retain before and after without business writes', async () => {
  api.get.mockImplementation(async url => ({ data: { data: url === '/customers' ? [{ customerId: 'fixture', firstName: 'Fixture', cycleDuration: 1 }] : { deliveries: [] } } }));
  await render(<Renewal/>); expect(changes()).toEqual([]);
  const chip = [...host.querySelectorAll('button')].find(node => node.textContent.startsWith('1–3 days'));
  act(() => chip.click()); await click('Clear filters');
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Renewal urgency', before: 'All', after: '1–3 days' }));
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Renewal urgency', before: '1–3 days', after: 'All' }));
  const search = host.querySelector('input[placeholder="Search by name, ID or phone…"]');
  fill(search, 'PRIVATE-SEARCH'); act(() => search.parentElement.querySelector('button').click());
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Renewal search', before: 'PRIVATE-SEARCH', after: '', private: true }));
  act(() => [...host.querySelectorAll('th')].find(node => node.textContent === 'Customer').click());
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Renewal sort', before: 'remaining asc', after: 'customerName asc' }));
  expect(api.post).not.toHaveBeenCalled();
});

test('refund completion date and reference reset only when staff explicitly switch actions', async () => {
  const record = { _id: 'case', status: 'approved', active: true, amountMinor: 15500, history: [], eligibility: { eligible: true, damaged: false, blockers: [], items: [] } };
  api.get.mockResolvedValue({ data: { data: { canApprove: true, candidates: [], cases: [record] } } });
  await render(<BagRefundTracker/>); await click('Open refund case'); await click('Record refund completed');
  fill(host.querySelector('input[type="datetime-local"]'), '2026-11-17T12:30');
  const reference = host.querySelector('.bo-inset input:not([type="checkbox"]):not([type="datetime-local"])');
  fill(reference, 'PRIVATE-REFERENCE'); await click('Reopen review');
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Refund completion date', before: '2026-11-17T12:30', after: '' }));
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Refund reference', before: 'PRIVATE-REFERENCE', after: '', private: true }));
  expect(api.post).not.toHaveBeenCalled();
});

test('delivery change date chips and filter reset capture custom changes only', async () => {
  await render(<DeliveryChanges/>); expect(changes()).toEqual([]);
  await click('Active');
  fill(host.querySelector('input[placeholder="Search ID or customer..."]'), 'PRIVATE-CUSTOMER');
  await click('Clear filters');
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Delivery change date state', before: 'All', after: 'Active' }));
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Customer filter', before: 'PRIVATE-CUSTOMER', after: '', private: true }));
  expect(api.post).not.toHaveBeenCalled();
});

test('complaint export bulk controls record the actual selected categories before export', async () => {
  api.get.mockResolvedValue({ data: { data: { complaints: [{ _id: 'fixture', customerName: 'Fixture customer', complaint: { complaintType: 'late' } }], pagination: { pages: 1 } } } });
  await render(<Complaints/>); await click('Excel Report'); await click('Clear'); await click('Select All');
  const observations = changes().filter(change => change.field === 'Complaint export types');
  expect(observations).toHaveLength(2);
  expect(observations[0].before).toContain('Late Delivery'); expect(observations[0].after).toEqual([]);
  expect(observations[1].before).toEqual([]); expect(observations[1].after).toContain('Late Delivery');
  expect(api.post).not.toHaveBeenCalled();
});

test('switching refund actions observes discarded draft evidence and confirmations without recording opening defaults', async () => {
  const record = { _id: 'case', status: 'review', active: true, amountMinor: 15500, history: [], eligibility: { eligible: true, damaged: false, blockers: [], items: [{ bagId: 'BAG-0001', returnKey: 'return', receiptEventId: 'receipt' }] } };
  api.get.mockResolvedValue({ data: { data: { canApprove: true, candidates: [], cases: [record] } } });
  await render(<BagRefundTracker/>); await click('Open refund case');
  expect(changes().filter(change => change.field === 'Refund review note')).toEqual([]);
  await click('Record inspection · BAG-0001'); fill(host.querySelector('textarea'), 'Private inspection evidence');
  act(() => host.querySelector('input[type="checkbox"]').click());
  await click('Approve AED 155 refund');
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Refund review note', before: 'Private inspection evidence', after: '', private: true }));
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Refund confirmation', before: true, after: false }));
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Refund return selection', before: 'BAG-0001', after: 'Not selected' }));
  expect(api.post).not.toHaveBeenCalled();
});
