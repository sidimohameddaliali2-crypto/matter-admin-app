import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import CustomerService from './CustomerService';
import api from '../../utils/api';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn() } }));
let mockPathname = '/customer-service/chats';
jest.mock('react-router-dom', () => {
  const React = require('react');
  return { Link: ({ to, children, ...props }) => <a href={to} {...props}>{children}</a>, useLocation: () => ({ pathname: mockPathname, search: '' }) };
}, { virtual: true });
global.IS_REACT_ACT_ENVIRONMENT = true;
let root, container;
const button = text => [...container.querySelectorAll('button')].find(node => node.textContent.trim() === text);
async function render(user = { _id: 'reviewer', role: 'admin' }, route = '/customer-service/chats') {
  mockPathname = route;
  const store = configureStore({ reducer: { auth: () => ({ user }) } });
  await act(async () => root.render(<Provider store={store}><CustomerService /></Provider>));
}
beforeEach(() => {
  jest.clearAllMocks();
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  api.get.mockImplementation(async url => ({ data: { success: true, data: url.endsWith('/me') ? { capabilities: { review: true, workActions: true }, profile: { displayName: 'Reviewer', userId: 'reviewer' } } : url.endsWith('/categories') ? [] : url.endsWith('/reviews') ? { reviews: [] } : url.endsWith('/team') ? { members: [], candidates: [{ _id: 'candidate', displayName: 'Existing staff' }] } : { issues: [], actions: [] } } }));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
test('four connected pages render without invented workload and claiming requires a click', async () => {
  await render();
  expect([...container.querySelectorAll('nav[aria-label="Customer service pages"] a')].map(a => a.textContent)).toEqual(['Summary', 'Problems', 'Customers', 'Customer chats']);
  expect(container.textContent).toContain('No reviews assigned');
  expect(api.post).not.toHaveBeenCalled();
  expect(button('Start next review')).toBeDefined();
});
test('ordinary admin without an explicit service grant sees access state and no issue data is fetched', async () => {
  api.get.mockResolvedValue({ data: { success: true, data: { capabilities: { review: false, supervise: false, workActions: false, setup: false }, profile: null } } });
  await render();
  expect(container.textContent).toContain('Customer service access is not configured');
  expect(api.get.mock.calls.some(([url]) => url.endsWith('/issues') || url.endsWith('/reviews'))).toBe(false);
});
test('setup-only super admin receives an existing-staff setup form', async () => {
  const original = api.get.getMockImplementation();
  api.get.mockImplementation(async url => url.endsWith('/me') ? { data: { success: true, data: { capabilities: { setup: true }, profile: null } } } : original(url));
  await render({ _id: 'super', role: 'super_admin' });
  expect(container.textContent).toContain('Set up a supervisor');
  expect(container.querySelector('select[aria-label="Supervisor account"]')).toBeTruthy();
  expect(container.textContent).toContain('Existing staff');
});
test('review capacity retains the selected service date when editing a reviewer', async () => {
  const original = api.get.getMockImplementation();
  api.get.mockImplementation(async url => url.endsWith('/me') ? { data: { data: { capabilities: { review: true, supervise: true, workActions: true }, profile: { displayName: 'Supervisor', userId: 'supervisor' } } } } : url.endsWith('/team') ? { data: { data: { candidates: [{ _id: 'candidate', displayName: 'Existing staff' }], members: [{ userId: 'candidate', mode: 'reviewer', availableMinutes: 90, availabilityDate: '2026-11-07', enabled: true }] } } } : original(url));
  api.put.mockResolvedValue({ data: { data: { profile: {} } } });
  await render({ _id: 'supervisor', role: 'admin' }, '/customer-service/summary');
  const select = container.querySelector('select[aria-label="Reviewer account"]');
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'candidate'); select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(container.querySelector('[aria-label="Review availability service date"]').value).toBe('2026-11-07');
  await act(async () => button('Save reviewer availability').click());
  expect(api.put).toHaveBeenCalledWith('/customer-service/team', expect.objectContaining({ userId: 'candidate', availableMinutes: 90, availabilityDate: '2026-11-07' }));
});
