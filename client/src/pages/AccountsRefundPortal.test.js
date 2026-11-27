import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import AccountsRefundPortal from './AccountsRefundPortal';
let root, host, records;
const token = 'p'.repeat(43);
const first = { id: 'record-1', customerName: 'Sara', customerId: 'C001', amount: 155, version: 2, collectedAt: '2026-11-26T10:00:00Z' };
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); records = [first, { ...first, id: 'record-2', customerName: 'Omar', customerId: 'C002' }];
  window.history.replaceState({}, '', `/refund/portal#${token}`);
  global.fetch = jest.fn(async url => ({ ok: true, json: async () => ({ success: true, data: records, total: records.length, pages: 1 }) }));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); window.history.replaceState({}, '', '/'); jest.clearAllMocks(); });
async function render() { await act(async () => root.render(<AccountsRefundPortal />)); }
async function click(text) { await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === text).click()); }
async function change(id, value) { await act(async () => { const node = host.querySelector(id); Object.getOwnPropertyDescriptor(node.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }); }
async function submit() { await act(async () => host.querySelector('section[aria-label="Complete selected refund"] form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }
test('portal lists multiple refunds without cookies, staff auth or a token in the URL request', async () => {
  await render(); expect(host.textContent).toContain('2 pending refunds'); expect(host.textContent).toContain('Sara'); expect(host.textContent).toContain('Omar');
  const [url, options] = fetch.mock.calls[0]; expect(url).toContain('/collection-refund-portal/list'); expect(url).not.toContain(token); expect(options.credentials).toBe('omit'); expect(options.headers.Authorization).toBeUndefined(); expect(JSON.parse(options.body).token).toBe(token);
});
test('completion targets only the selected refund and requires method, reference and Jenniza confirmation', async () => {
  await render(); await click('Update refund'); await submit(); expect(fetch).toHaveBeenCalledTimes(1);
  await change('#portal-method', 'card'); await change('#portal-reference', 'CARD-001'); await submit(); expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => host.querySelector('[type="checkbox"]').click());
  fetch.mockImplementation(async url => ({ ok: true, json: async () => url.endsWith('/complete') ? { success: true, receipt: { ...first, method: 'card', reference: 'CARD-001', completedAt: new Date().toISOString() } } : { success: true, data: records.slice(1), total: 1, pages: 1 } }));
  await submit();
  const write = fetch.mock.calls.find(([url]) => url.endsWith('/complete'));
  expect(JSON.parse(write[1].body)).toEqual(expect.objectContaining({ deliveryId: 'record-1', method: 'card', reference: 'CARD-001', confirmed: true, version: 2, token }));
  expect(host.textContent).toContain('Refund recorded as Done'); expect(host.textContent).toContain('Jenniza'); expect(host.textContent).toContain('1 pending refund'); expect(host.querySelectorAll('.refund-portal-list li')).toHaveLength(1);
});
test('expired portal links expose no queue or update form', async () => {
  fetch.mockResolvedValue({ ok: false, json: async () => ({ message: 'This Accounts portal link has expired.' }) }); await render();
  expect(host.querySelector('[role="alert"]').textContent).toContain('expired'); expect(host.querySelector('.refund-portal-list')).toBeNull();
});
test('demo supports multiple completions and reset with zero network calls', async () => {
  window.history.replaceState({}, '', '/refund/portal?demo=1'); await render();
  expect(host.querySelectorAll('.refund-portal-list li')).toHaveLength(2); expect(fetch).not.toHaveBeenCalled();
  await click('Update refund'); await change('#portal-method', 'bank_account'); await change('#portal-reference', 'DEMO-001'); await act(async () => host.querySelector('[type="checkbox"]').click()); await submit();
  expect(host.textContent).toContain('1 pending refund'); expect(host.textContent).toContain('DEMO-001'); expect(host.textContent).toContain('Jenniza');
  await click('Update refund'); await change('#portal-method', 'card'); await change('#portal-reference', 'DEMO-002'); await act(async () => host.querySelector('[type="checkbox"]').click()); await submit();
  expect(host.textContent).toContain('0 pending refunds'); await click('Reset demo'); expect(host.querySelectorAll('.refund-portal-list li')).toHaveLength(2); expect(fetch).not.toHaveBeenCalled();
});
