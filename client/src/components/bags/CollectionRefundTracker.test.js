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
  expect(container.querySelector('.collection-status').textContent).toBe('Pending');
  expect([...container.querySelectorAll('[aria-label="Refund status filters"] button')].map(el => el.textContent)).toEqual(['Pending', 'Done']);
  expect(api.get).toHaveBeenCalledWith('/collections/refunds', { params: { status: 'pending', page: 1, search: '', dateFrom: '', dateTo: '', owner: '' } });
  await click('Mark as done');
  expect(container.querySelector('#collection-refund-status')).toBeNull();
  expect(container.querySelector('#collection-refund-reference').required).toBe(true);
  await change('#collection-refund-method', 'card'); await change('#collection-refund-reference', 'BANK-123'); await change('#collection-refund-note', 'Payment confirmed');
  await save();
  expect(api.post).toHaveBeenCalledWith('/collections/collection-1/refund', expect.objectContaining({ status: 'refunded', reference: 'BANK-123', note: 'Payment confirmed', version: 0, eventId: expect.any(String) }));
  expect(container.textContent).toContain('Refund marked as Done.');
});
test('earlier unpaid requests remain Pending; failed saves retain the confirmation', async () => {
  row = { ...row, refundStatus: 'not_refunded', collectionRefund: { version: 2, note: 'Awaiting accounts' } };
  await click('Refresh refunds');
  expect(container.querySelector('.collection-status').textContent).toBe('Pending');
  await click('Mark as done'); await change('#collection-refund-note', 'Payment confirmed');
  await change('#collection-refund-method', 'card'); await change('#collection-refund-reference', 'BANK-456');
  api.post.mockRejectedValueOnce({ response: { data: { message: 'This refund changed. Refresh before updating it.' } } });
  await save();
  expect(container.querySelector('#collection-refund-note').value).toBe('Payment confirmed');
  expect(container.querySelector('#collection-refund-reference').value).toBe('BANK-456');
  expect(container.textContent).toContain('This refund changed.');
  await save();
  expect(api.post).toHaveBeenLastCalledWith('/collections/collection-1/refund', expect.objectContaining({ status: 'refunded', note: 'Payment confirmed', reference: 'BANK-456', version: 2 }));
  expect(container.textContent).toContain('Refund marked as Done.');
});
test('read-only staff and previously refunded customers cannot see update controls', async () => {
  canUpdate = false; await click('Refresh refunds');
  expect(button('Mark as done')).toBeUndefined();
  canUpdate = true; row = { ...row, refundStatus: 'refunded', recordedForCustomer: true };
  await click('Done');
  expect(api.get).toHaveBeenLastCalledWith('/collections/refunds', { params: { status: 'refunded', page: 1, search: '', dateFrom: '', dateTo: '', owner: '' } });
  expect(container.querySelector('.collection-status').textContent).toBe('Done');
  expect(button('Mark as done')).toBeUndefined();
  expect(container.textContent).toContain('Refund already recorded for this customer');
});

test('Done requires a nonblank transaction reference and keeps the request pending until confirmation', async () => {
  expect(button('View demo requests')).toBeUndefined();
  expect(container.textContent).not.toContain('DEMO-');
  await click('Mark as done');
  expect(container.textContent).toContain('Transaction reference (required)');
  await change('#collection-refund-note', 'Payment confirmed');
  await save();
  expect(api.post).not.toHaveBeenCalled();
  await change('#collection-refund-method', 'card'); await change('#collection-refund-reference', '   ');
  await save();
  expect(api.post).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Enter the transaction reference');
  await change('#collection-refund-method', 'card'); await change('#collection-refund-reference', 'TXN-789');
  await save();
  expect(api.post).toHaveBeenCalledWith('/collections/collection-1/refund', expect.objectContaining({status: 'refunded', reference: 'TXN-789'}));
});

test('management assigns follow-up without recording payment and the new version is used for completion', async () => {
  await act(async () => root.render(<CollectionRefundTracker owners={[{_id:'owner-1',name:'Accounts Manager'}]} />));
  await click('Assign follow-up');
  await change('#collection-refund-owner', 'owner-1');
  await change('#collection-refund-due', '2026-12-01');
  await save();
  expect(api.post).toHaveBeenLastCalledWith('/collections/collection-1/refund-assignment', expect.objectContaining({ownerId:'owner-1',dueDate:'2026-12-01',version:0}));
  expect(api.post.mock.calls[0][1].status).toBeUndefined();
  expect(container.textContent).toContain('Refund owner and follow-up date saved.');
});
test('refund list applies shared customer and collection-date filters', async () => {
  await act(async () => root.render(<CollectionRefundTracker search="Sara" dateFrom="2026-11-01" dateTo="2026-11-30" />));
  expect(api.get).toHaveBeenLastCalledWith('/collections/refunds', {params:{status:'pending',page:1,search:'Sara',dateFrom:'2026-11-01',dateTo:'2026-11-30',owner:''}});
  expect(container.textContent).toContain('does not verify bank payments');
});

test('clearing filters restores the pending queue and removes the owner restriction', async () => {
  await change('#collection-refund-owner-filter','unassigned');
  await click('Done');
  await act(async () => root.render(<CollectionRefundTracker resetKey={1} />));
  expect(container.querySelector('#collection-refund-owner-filter').value).toBe('');
  expect(api.get).toHaveBeenLastCalledWith('/collections/refunds',{params:expect.objectContaining({status:'pending',owner:'',page:1})});
});
test('one portal email action handles the entire queue and does not record payment', async () => {
  Object.defineProperty(window, 'crypto', { configurable: true, value: { randomUUID: () => '720c802c-2f40-4b18-a92b-b4099bd6438a' } });
  api.get.mockResolvedValue({ data: { data: [row], total: 1, pages: 1, canUpdate: true, emailEnabled: true } });
  api.post.mockResolvedValue({ data: { success: true, message: 'Accounts has already received today’s refund email. No second email will be sent.' } });
  await click('Refresh refunds'); await click('Email today’s portal to Accounts');
  expect(api.post).toHaveBeenLastCalledWith('/collections/refund-portal-email', { messageKey: expect.any(String) });
  expect(container.textContent).toContain('No second email will be sent.');
  expect(button('Portal email accepted by Brevo').disabled).toBe(true);
  expect([...container.querySelectorAll('button')].some(el => el.textContent === 'Email Accounts portal')).toBe(false);
});
