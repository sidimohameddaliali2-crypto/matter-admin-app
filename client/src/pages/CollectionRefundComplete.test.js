import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import CollectionRefundComplete from './CollectionRefundComplete';
let container, root, record;
const token = 'a'.repeat(43);
beforeEach(async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState({}, '', `/refund/complete#${token}`);
  record = { customerName: 'Sara', customerId: 'C001', amount: 155, status: 'pending', version: 2 };
  global.fetch = jest.fn(async url => ({ ok: true, json: async () => url.endsWith('/view') ? { success: true, data: record } : { success: true } }));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root.render(<CollectionRefundComplete />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); jest.clearAllMocks(); window.history.replaceState({}, '', '/'); });
async function change(selector, value) {
  await act(async () => { const input = container.querySelector(selector); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function submit() { await act(async () => container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }
test('the private link loads only its refund without login cookies or an authorization header', () => {
  expect(container.textContent).toContain('Sara'); expect(container.textContent).toContain('AED 155');
  const [url, options] = fetch.mock.calls[0];
  expect(url).not.toContain(token); expect(options.credentials).toBe('omit'); expect(options.referrerPolicy).toBe('no-referrer');
  expect(options.headers.Authorization).toBeUndefined(); expect(JSON.parse(options.body).token).toBe(token);
  expect(fetch.mock.calls.some(([path]) => path.includes('/complete'))).toBe(false);
});
test('Done requires a transaction reference and explicit confirmation, then renders the recorded reference', async () => {
  await submit(); expect(fetch).toHaveBeenCalledTimes(1);
  await change('#accounts-refund-reference', 'TXN-123');
  await submit(); expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => container.querySelector('[type="checkbox"]').click());
  record = { ...record, status: 'done', reference: 'TXN-123' };
  await submit();
  const write = fetch.mock.calls.find(([url]) => url.endsWith('/complete'));
  expect(JSON.parse(write[1].body)).toEqual(expect.objectContaining({ token, reference: 'TXN-123', confirmed: true, version: 2 }));
  expect(container.querySelector('form')).toBeNull(); expect(container.textContent).toContain('Refund recorded as Done'); expect(container.textContent).toContain('TXN-123');
});
test('expired links show the server message without presenting an editable refund', async () => {
  fetch.mockResolvedValue({ ok: false, json: async () => ({ message: 'This refund link has expired.' }) });
  await act(async () => [...container.querySelectorAll('button')].find(el => el.textContent === 'Reload refund details').click());
  expect(container.querySelector('[role="alert"]').textContent).toContain('expired'); expect(container.querySelector('form')).toBeNull();
});
test('a failed save keeps the reference and confirmation for a safe retry', async () => {
  await change('#accounts-refund-reference', 'TXN-RETRY'); await act(async () => container.querySelector('[type="checkbox"]').click());
  fetch.mockResolvedValueOnce({ ok: false, json: async () => ({ message: 'This refund changed. Reload before updating.' }) });
  await submit(); expect(container.querySelector('#accounts-refund-reference').value).toBe('TXN-RETRY'); expect(container.querySelector('[type="checkbox"]').checked).toBe(true); expect(container.textContent).toContain('This refund changed');
});
