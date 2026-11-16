import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import api from '../utils/api';
import MenuNonSelectors from './MenuNonSelectors';

jest.mock('../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
global.IS_REACT_ACT_ENVIRONMENT = true;
const menu = { _id: 'menu', title: '16–22 November' };
const result = customers => ({ data: { success: true, data: { customers, startDate: '2026-11-16', endDate: '2026-11-22', checkedAt: '2026-11-16T08:00:00Z' } } });
let node, root;
beforeEach(() => { jest.clearAllMocks(); node = document.createElement('div'); document.body.appendChild(node); root = createRoot(node); });
afterEach(async () => { await act(async () => root.unmount()); node.remove(); });

test('loads the whole menu once and displays contact details and active dates', async () => {
  api.get.mockResolvedValue(result([{ customerId: 'one', name: 'No selections', email: 'one@example.com', phone: '0501234567', deliveryDates: ['2026-11-16', '2026-11-19'] }]));
  await act(async () => root.render(<MenuNonSelectors menu={menu} onClose={() => {}} />));
  expect(api.get).toHaveBeenCalledWith('/menus/menu/did-not-select', expect.objectContaining({ timeout: 180000 }));
  expect(node.textContent).toContain('No selections');
  expect(node.textContent).toContain('one@example.com');
  expect(node.textContent).toContain('0501234567');
  expect(node.textContent).toContain('16 Nov, 19 Nov');
  expect(api.get).toHaveBeenCalledTimes(1);
});

test('failed refresh clears old customer results and offers retry rather than an empty success', async () => {
  api.get.mockResolvedValueOnce(result([{ customerId: 'one', name: 'Old customer', deliveryDates: ['2026-11-16'] }]))
    .mockRejectedValueOnce({ response: { data: { message: 'Matter unavailable' } } });
  await act(async () => root.render(<MenuNonSelectors menu={menu} onClose={() => {}} />));
  expect(node.textContent).toContain('Old customer');
  await act(async () => [...node.querySelectorAll('button')].find(button => button.textContent === 'Refresh').click());
  expect(node.querySelector('[role="alert"]').textContent).toBe('Matter unavailable');
  expect(node.textContent).not.toContain('Old customer');
  expect(node.textContent).not.toContain('No customers with active deliveries');
  expect(node.textContent).toContain('Retry');
});

test('late results from the previous menu cannot overwrite the currently selected menu', async () => {
  let resolveOld;
  api.get.mockImplementation(url => url.includes('/old/') ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve(result([])));
  const close = () => {};
  await act(async () => root.render(<MenuNonSelectors menu={{ ...menu, _id: 'old' }} onClose={close} />));
  await act(async () => root.render(<MenuNonSelectors menu={menu} onClose={close} />));
  await act(async () => resolveOld(result([{ customerId: 'old', name: 'Wrong menu customer', deliveryDates: [] }])));
  expect(node.textContent).not.toContain('Wrong menu customer');
  expect(node.textContent).toContain('No customers with active deliveries');
});

test('close remains available during the live Matter check', async () => {
  api.get.mockReturnValue(new Promise(() => {}));
  const close = jest.fn();
  await act(async () => root.render(<MenuNonSelectors menu={menu} onClose={close} />));
  expect(node.querySelector('[role="status"]').textContent).toContain('Checking active deliveries');
  await act(async () => node.querySelector('[aria-label="Close customers who did not select"]').click());
  expect(close).toHaveBeenCalledTimes(1);
});
