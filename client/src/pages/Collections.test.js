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
  jest.useFakeTimers({ now: new Date('2026-11-24T08:00:00Z') });
  global.IS_REACT_ACT_ENVIRONMENT = true;
  api.get.mockResolvedValue({ data: { data: [], total: 0, pages: 0 } });
  api.post.mockResolvedValue({ data: { success: true } });
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<Collections />); });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); jest.clearAllMocks(); jest.useRealTimers(); });
const button = text => [...container.querySelectorAll('button')].find(element => element.textContent.trim() === text);
async function click(element) { await act(async () => { element.click(); }); }
async function change(selector, value) {
  await act(async () => {
    const element = container.querySelector(selector);
    const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function chooseFriday() {
  await click(button('Choose a collection date'));
  await click(container.querySelector('[data-day="2026-11-27"] button'));
  expect(container.querySelector('#collection-time')).toBeNull();
}
test('manual customer and clipboard address create an existing dispatch-compatible request', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: jest.fn().mockResolvedValue('Home\n29 22nd St, Al Quoz, Dubai\nLatitude: 25.126898\nLongitude: 55.225061') } });
  expect(button('Enter manually')).toBeUndefined();
  await change('#collection-name', 'Jane Smith');
  await click(button('Paste address'));
  expect(container.querySelector('#collection-address').value).toBe('29 22nd St, Al Quoz, Dubai');
  expect(container.querySelector('#collection-lat').value).toBe('25.126898');
  await chooseFriday();
  await click(container.querySelector('[type=checkbox]'));
  await act(async () => { container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(api.post).toHaveBeenCalledWith('/collections', expect.objectContaining({ customerSource: 'manual', customerName: 'Jane Smith', address: '29 22nd St, Al Quoz, Dubai', latitude: '25.126898', longitude: '55.225061', collectionDate: '2026-11-27', refundRequestedAfterCollection: true }));
  expect(api.post.mock.calls[0][1].scheduledTime).toBeUndefined();
  expect(container.textContent).toContain('Collection request created.');
});
test('clipboard denial focuses the address field; direct paste fills details without a second step', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: jest.fn().mockRejectedValue(new Error('denied')) } });
  await change('#collection-name', 'Jane Smith');
  await click(button('Paste address'));
  expect(document.activeElement.id).toBe('collection-address');
  expect(container.querySelector('#collection-pasted')).toBeNull();
  await act(async () => {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => 'Home\nAl Quoz, Dubai\nLatitude: 25\nLongitude: 55' } });
    container.querySelector('#collection-address').dispatchEvent(event);
  });
  expect(container.querySelector('#collection-label').value).toBe('Home');
  expect(container.querySelector('#collection-lat').value).toBe('25');
  expect(container.querySelector('#collection-lng').value).toBe('55');
  await chooseFriday();
  api.post.mockRejectedValue({ response: { data: { message: 'Please retry.' } } });
  await act(async () => { container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(container.querySelector('#collection-name').value).toBe('Jane Smith');
  expect(container.querySelector('#collection-address').value).toBe('Al Quoz, Dubai');
  expect(container.querySelector('[role=alert]').textContent).toBe('Please retry.');
});
test('selecting a search match fills customer details; changing the search clears the old identity', async () => {
  const customer = { customerId: 'C001', firstName: 'Sara', lastName: 'Ahmed', phone: '+971500000001', address: 'Al Quoz, Dubai', gpsLocation: { address: 'Al Quoz, Dubai', lat: 25, lng: 55 } };
  api.get.mockImplementation(url => Promise.resolve({ data: { data: url === '/customers' ? [customer] : [], total: 0, pages: 0 } }));
  await change('#collection-customer', 'Sara');
  await act(async () => { jest.advanceTimersByTime(300); });
  await click([...container.querySelectorAll('.collection-results button')][0]);
  expect(container.querySelector('#collection-name').value).toBe('Sara Ahmed');
  expect(container.querySelector('#collection-phone').value).toBe('+971500000001');
  expect(container.querySelector('#collection-address').value).toBe('Al Quoz, Dubai');
  expect(container.querySelector('#collection-lat').value).toBe('25');
  await chooseFriday();
  await act(async () => { container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(api.post).toHaveBeenCalledWith('/collections', expect.objectContaining({ customerSource: 'internal', customerId: 'C001', customerName: 'Sara Ahmed', refundRequestedAfterCollection: false }));
  await change('#collection-customer', 'Sara');
  await act(async () => { jest.advanceTimersByTime(300); });
  await click([...container.querySelectorAll('.collection-results button')][0]);
  await change('#collection-customer', 'Someone else');
  expect(container.querySelector('#collection-name').value).toBe('');
  expect(container.querySelector('#collection-name').readOnly).toBe(false);
  expect(container.querySelector('#collection-lat').value).toBe('');
});
test('calendar enables only Tuesday, Friday and Saturday each week', async () => {
  await click(button('Choose a collection date'));
  for (const date of ['2026-11-23', '2026-11-25', '2026-11-26', '2026-11-29']) {
    expect(container.querySelector(`[data-day="${date}"] button`).disabled).toBe(true);
  }
  for (const date of ['2026-11-24', '2026-11-27', '2026-11-28']) {
    expect(container.querySelector(`[data-day="${date}"] button`).disabled).toBe(false);
  }
});
