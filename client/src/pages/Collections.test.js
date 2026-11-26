import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import Collections from './Collections';
import api from '../utils/api';

jest.mock('../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
// CRA's Jest 27 resolver predates React Router's package exports.
jest.mock('react-router-dom', () => ({ Link: ({ to, children, ...props }) => <a href={to} {...props}>{children}</a> }), { virtual: true });
jest.mock('date-fns/locale', () => jest.requireActual('date-fns/locale.cjs'));
jest.mock('react-day-picker/dist/style.css', () => ({}), { virtual: true });
let container, root;
beforeEach(async () => {
  jest.useFakeTimers('modern');
  jest.setSystemTime(new Date('2026-11-24T08:00:00Z'));
  global.IS_REACT_ACT_ENVIRONMENT = true;
  api.get.mockResolvedValue({ data: { data: [], total: 0, pages: 0 } });
  api.post.mockResolvedValue({ data: { success: true } });
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<Collections />); });
  await click(button('Add collection'));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); jest.clearAllMocks(); jest.useRealTimers(); });
const button = text => [...document.querySelectorAll('button')].find(element => element.textContent.trim() === text);
async function click(element) { await act(async () => { element.click(); }); }
async function change(selector, value) {
  await act(async () => {
    const element = document.querySelector(selector);
    const prototype = element.tagName === 'SELECT' ? HTMLSelectElement.prototype : element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
}
async function chooseFriday() {
  await click(button('Choose a collection date'));
  await click(document.querySelector('[data-day="2026-11-27"] button'));
  expect(document.querySelector('#collection-time')).toBeNull();
}
test('manual customer and clipboard address create an existing dispatch-compatible request', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: jest.fn().mockResolvedValue('Home\n29 22nd St, Al Quoz, Dubai\nLatitude: 25.126898\nLongitude: 55.225061') } });
  expect(button('Enter manually')).toBeUndefined();
  await change('#collection-name', 'Jane Smith');
  await click(button('Paste address'));
  expect(document.querySelector('#collection-address').value).toBe('29 22nd St, Al Quoz, Dubai');
  expect(document.querySelector('#collection-lat').value).toBe('25.126898');
  await chooseFriday();
  await click(document.querySelector('[type=checkbox]'));
  await act(async () => { document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(api.post).toHaveBeenCalledWith('/collections', expect.objectContaining({ customerSource: 'manual', customerName: 'Jane Smith', address: '29 22nd St, Al Quoz, Dubai', latitude: '25.126898', longitude: '55.225061', collectionDate: '2026-11-27', refundRequestedAfterCollection: true }));
  expect(api.post.mock.calls[0][1].scheduledTime).toBeUndefined();
  expect(container.textContent).toContain('Collection request created.');
  await act(async () => { jest.advanceTimersByTime(300); });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
test('clipboard denial focuses the address field; direct paste fills details without a second step', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: jest.fn().mockRejectedValue(new Error('denied')) } });
  await change('#collection-name', 'Jane Smith');
  await click(button('Paste address'));
  expect(document.activeElement.id).toBe('collection-address');
  expect(document.querySelector('#collection-pasted')).toBeNull();
  await act(async () => {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => 'Home\nAl Quoz, Dubai\nLatitude: 25\nLongitude: 55' } });
    document.querySelector('#collection-address').dispatchEvent(event);
  });
  expect(document.querySelector('#collection-label').value).toBe('Home');
  expect(document.querySelector('#collection-lat').value).toBe('25');
  expect(document.querySelector('#collection-lng').value).toBe('55');
  await chooseFriday();
  api.post.mockRejectedValue({ response: { data: { message: 'Please retry.' } } });
  await act(async () => { document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(document.querySelector('#collection-name').value).toBe('Jane Smith');
  expect(document.querySelector('#collection-address').value).toBe('Al Quoz, Dubai');
  expect(document.querySelector('[role=alert]').textContent).toBe('Please retry.');
});
test('selecting a search match fills customer details; changing the search clears the old identity', async () => {
  const customer = { customerId: 'C001', firstName: 'Sara', lastName: 'Ahmed', phone: '+971500000001', address: 'Al Quoz, Dubai', gpsLocation: { address: 'Al Quoz, Dubai', lat: 25, lng: 55 } };
  api.get.mockImplementation(url => Promise.resolve({ data: { data: url === '/customers' ? [customer] : [], total: 0, pages: 0 } }));
  await change('#collection-customer', 'Sara');
  await act(async () => { jest.advanceTimersByTime(300); });
  await click([...document.querySelectorAll('.collection-results button')][0]);
  expect(document.querySelector('#collection-name').value).toBe('Sara Ahmed');
  expect(document.querySelector('#collection-phone').value).toBe('+971500000001');
  expect(document.querySelector('#collection-address').value).toBe('Al Quoz, Dubai');
  expect(document.querySelector('#collection-lat').value).toBe('25');
  await chooseFriday();
  await act(async () => { document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(api.post).toHaveBeenCalledWith('/collections', expect.objectContaining({ customerSource: 'internal', customerId: 'C001', customerName: 'Sara Ahmed', refundRequestedAfterCollection: false }));
  await click(button('Add collection'));
  await change('#collection-customer', 'Sara');
  await act(async () => { jest.advanceTimersByTime(300); });
  await click([...document.querySelectorAll('.collection-results button')][0]);
  await change('#collection-customer', 'Someone else');
  expect(document.querySelector('#collection-name').value).toBe('');
  expect(document.querySelector('#collection-name').readOnly).toBe(false);
  expect(document.querySelector('#collection-lat').value).toBe('');
});
test('calendar enables only Tuesday, Friday and Saturday each week', async () => {
  await click(button('Choose a collection date'));
  for (const date of ['2026-11-23', '2026-11-25', '2026-11-26', '2026-11-29']) {
    expect(document.querySelector(`[data-day="${date}"] button`).disabled).toBe(true);
  }
  for (const date of ['2026-11-24', '2026-11-27', '2026-11-28']) {
    expect(document.querySelector(`[data-day="${date}"] button`).disabled).toBe(false);
  }
});
test('request list is left of refunds; closing and reopening the modal preserves a draft', async () => {
  await change('#collection-name', 'Draft customer');
  await act(async () => { document.querySelector('[aria-label="Close add collection"]').click(); jest.advanceTimersByTime(300); });
  const panels = [...container.querySelector('.collection-grid').children];
  expect(panels[0].textContent).toContain('Collection requests');
  expect(panels[1].textContent).toContain('Refund tracking');
  await click(button('Add collection'));
  expect(document.querySelector('[role="dialog"]').getAttribute('aria-labelledby')).toBe('collection-modal-title');
  expect(document.querySelector('#collection-name').value).toBe('Draft customer');
});

test('open work is the default and shared customer/date filters reach the API', async () => {
  expect(api.get).toHaveBeenCalledWith('/collections', {params:expect.objectContaining({view:'open',page:1})});
  await act(async () => { document.querySelector('[aria-label="Close add collection"]').click(); jest.advanceTimersByTime(300); });
  await change('#collection-list-search', 'Sara');
  await act(async () => jest.advanceTimersByTime(300));
  await change('#collection-date-from', '2026-11-01');
  await click(button('History'));
  expect(api.get).toHaveBeenCalledWith('/collections', {params:expect.objectContaining({view:'history',search:'Sara',dateFrom:'2026-11-01',page:1})});
});
test('past collection dates are disabled and duplicates require an explicit review', async () => {
  await click(button('Choose a collection date'));
  expect(document.querySelector('[data-day="2026-11-20"] button').disabled).toBe(true);
  await click(document.querySelector('[data-day="2026-11-27"] button'));
  await change('#collection-name','Sara');
  await change('#collection-address','Al Quoz');
  api.post.mockRejectedValueOnce({response:{data:{code:'POSSIBLE_DUPLICATE',message:'Review existing request',duplicates:[{_id:'existing',customerName:'Sara',scheduledTime:'2026-11-26T20:00:00Z',status:'pending'}]}}});
  await act(async () => document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  expect(document.querySelector('[aria-label="Possible duplicate requests"]').textContent).toContain('Review possible duplicates');
  expect(document.querySelector('a[href="/deliveries/existing"]')).not.toBeNull();
  expect(api.post).toHaveBeenCalledTimes(1);
});
test('older matching requests show a review warning without changing any records', async () => {
  await act(async () => { document.querySelector('[aria-label="Close add collection"]').click(); jest.advanceTimersByTime(300); });
  api.get.mockImplementation(url => Promise.resolve({ data: url === '/collections' ? { data: [{ _id: 'one', customerName: 'Sara', address: 'Al Quoz', status: 'pending', scheduledTime: '2026-11-26T20:00:00Z', possibleDuplicateId: 'other' }], total: 1, pages: 1 } : { openCount: 1, pendingRefunds: 0, unassigned: 1, pastDate: 0 } }));
  await click(button('Refresh'));
  expect(container.textContent).toContain('Possible duplicate request.');
  expect(container.querySelector('a[href="/deliveries/other"]').textContent).toBe('Review the other request');
  expect(api.post).not.toHaveBeenCalled();
});
