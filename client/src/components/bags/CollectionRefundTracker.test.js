import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import CollectionRefundTracker from './CollectionRefundTracker';
import api from '../../utils/api';
jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
let container, root, row, canUpdate;
beforeEach(async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  row = { _id: 'collection-1', customerId: 'C001', customerName: 'Sara Ahmed', refundStatus: 'pending', collectionDetails: { collectedAt: '2026-11-27T08:00:00Z' } };
  canUpdate = true;
  api.get.mockImplementation(() => Promise.resolve({ data: { data: [row], total: 1, pages: 1, canUpdate } }));
  api.post.mockResolvedValue({ data: { success: true } });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root.render(<CollectionRefundTracker />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); jest.clearAllMocks(); });
const button = text => [...container.querySelectorAll('button')].find(el => el.textContent.trim() === text);
async function click(text) { await act(async () => button(text).click()); }
async function change(id, value) {
  await act(async () => {
    const el = container.querySelector(id);
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
}
async function save() { await act(async () => container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }
test('completed collection shows pending; management records payment reference and notes', async () => {
  expect(container.textContent).toContain('Pending refund');
  expect(api.get).toHaveBeenCalledWith('/collections/refunds', { params: { status: 'pending', page: 1 } });
  await click('Update refund'); await change('#collection-refund-status', 'refunded');
  expect(container.querySelector('#collection-refund-reference').required).toBe(true);
  await change('#collection-refund-reference', 'BANK-123'); await change('#collection-refund-note', 'Payment confirmed');
  await save();
  expect(api.post).toHaveBeenCalledWith('/collections/collection-1/refund', expect.objectContaining({ status: 'refunded', reference: 'BANK-123', note: 'Payment confirmed', version: 0, eventId: expect.any(String) }));
  expect(container.textContent).toContain('Refund recorded as completed.');
});
test('not refunded records why it remains outstanding; failed saves retain the update', async () => {
  await click('Update refund'); await change('#collection-refund-note', 'Awaiting accounts');
  api.post.mockRejectedValueOnce({ response: { data: { message: 'This refund changed. Refresh before updating it.' } } });
  await save();
  expect(container.querySelector('#collection-refund-note').value).toBe('Awaiting accounts');
  expect(container.textContent).toContain('This refund changed.');
  await save();
  expect(api.post).toHaveBeenLastCalledWith('/collections/collection-1/refund', expect.objectContaining({ status: 'not_refunded', note: 'Awaiting accounts' }));
  expect(container.textContent).toContain('It remains outstanding.');
});
test('read-only staff and previously refunded customers cannot see update controls', async () => {
  canUpdate = false; await click('Refresh refunds');
  expect(button('Update refund')).toBeUndefined();
  canUpdate = true; row = { ...row, refundStatus: 'refunded', recordedForCustomer: true };
  await click('Refunded');
  expect(button('Update refund')).toBeUndefined();
  expect(container.textContent).toContain('Refund already recorded for this customer');
});
