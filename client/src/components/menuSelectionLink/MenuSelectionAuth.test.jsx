import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import MenuSelectionLink from './MenuSelectionLink';
import api from '../../utils/api';
import customerApi from '../../utils/menuCustomerApi';

jest.mock('../../utils/api', () => ({ get: jest.fn() }));
jest.mock('../../utils/menuCustomerApi', () => ({ get: jest.fn(), post: jest.fn() }));
global.IS_REACT_ACT_ENVIRONMENT = true;
let root; let container;
const menuId = '507f1f77bcf86cd799439012';
const itemId = '507f1f77bcf86cd799439013';
beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('token', 'unrelated-staff-token');
  window.scrollTo = jest.fn();
  HTMLElement.prototype.scrollIntoView = jest.fn();
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  api.get.mockResolvedValue({ data: { data: { _id: menuId, title: 'Fixture menu', meals: [{ date: '2099-01-01', mealType: 'main', items: [{ _id: itemId, mealName: 'Offered meal' }] }] } } });
  customerApi.post.mockImplementation(async (path, body) => {
    if (path.endsWith('/session')) return { data: { data: { token: 'customer-session' } } };
    return { data: { success: true, pauseResults: [] } };
  });
  customerApi.get.mockResolvedValue({ data: { data: { email: 'customer@example.invalid', firstName: 'Fixture', mealPerDay: 1, allergies: [], deliveryDates: ['2099-01-01'] } } });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function type(id, value) {
  const input = container.querySelector('#' + id);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function click(text) {
  const button = [...container.querySelectorAll('button')].find(button => button.textContent.trim() === text);
  expect(button).toBeTruthy();
  await act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

test('shared-link customer enters email and continues straight to selection without any code', async () => {
  await act(async () => root.render(<MenuSelectionLink token="fixture-share-link" />));
  await type('msl-email', 'customer@example.invalid');
  await click('Continue');
  expect(customerApi.post).toHaveBeenCalledWith('/menus/customer-auth/session', { email: 'customer@example.invalid', menuId, shareToken: 'fixture-share-link' });
  expect(container.querySelector('#msl-verification-code')).toBeNull();
  expect(customerApi.post.mock.calls.some(([path]) => /\/(request|verify)$/.test(path))).toBe(false);
  expect(customerApi.get).toHaveBeenCalledWith('/menus/customers/customer%40example.invalid/subscription-profile', { params: { menuId }, headers: { 'X-Menu-Session': 'customer-session' } });
  expect(localStorage.getItem('token')).toBe('unrelated-staff-token');
  expect(Object.values(localStorage)).not.toContain('customer-session');
  await click('+');
  await click('Submit my week');
  const saved = customerApi.post.mock.calls.find(([path]) => path.endsWith('/select-meals'));
  expect(saved).toBeTruthy();
  expect(saved[1].weeklyMenuId).toBe(menuId);
  expect(saved[2].headers['X-Menu-Session']).toBe('customer-session');
});

test('a customer can correct an unknown email and retry without a code', async () => {
  customerApi.post.mockRejectedValueOnce({ response: { status: 404, data: { message: 'Account not found.' } } });
  await act(async () => root.render(<MenuSelectionLink token="fixture-share-link" />));
  await type('msl-email', 'customer@example.invalid'); await click('Continue');
  expect(container.textContent).toContain('Account not found.');
  expect(customerApi.get).not.toHaveBeenCalled();
  await type('msl-email', 'other@example.invalid');
  expect(container.querySelector('#msl-verification-code')).toBeNull();
  await click('Continue');
  expect(customerApi.post.mock.calls.at(-1)[1].email).toBe('other@example.invalid');
  expect(customerApi.get.mock.calls.at(-1)[0]).toContain('other%40example.invalid/subscription-profile');
});

test('a late sign-in response cannot open the customer account on a different menu link', async () => {
  let finishRequest;
  customerApi.post.mockImplementationOnce(() => new Promise(resolve => { finishRequest = resolve; }));
  await act(async () => root.render(<MenuSelectionLink token="first-menu-link" />));
  await type('msl-email', 'customer@example.invalid');
  await click('Continue');
  await act(async () => root.render(<MenuSelectionLink token="different-menu-link" />));
  await act(async () => finishRequest({ data: { data: { token: 'stale-session' } } }));
  expect(container.querySelector('#msl-verification-code')).toBeNull();
  expect(customerApi.get).not.toHaveBeenCalled();
});
