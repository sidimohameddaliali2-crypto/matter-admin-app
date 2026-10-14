import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import DeliveryOrderModal from './DeliveryOrderModal';
import api from '../utils/api';
jest.mock('../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), put: jest.fn() } }));
global.IS_REACT_ACT_ENVIRONMENT = true;
let container, root;
const deliveries = [{ _id: 'a', customerName: 'First', status: 'assigned' }, { _id: 'b', customerName: 'Second', status: 'assigned' }];
beforeEach(async () => {
  jest.clearAllMocks();
  api.get.mockResolvedValue({ data: { data: { deliveries, revision: 'rev1' } } });
  api.put.mockResolvedValue({ data: { success: true } });
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<DeliveryOrderModal date="2026-10-14" drivers={[{ _id: 'driver1', name: 'Driver' }]} onClose={() => {}} />));
  await act(async () => { const select = container.querySelector('select'); select.value = 'driver1'; select.dispatchEvent(new Event('change', { bubbles: true })); });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const button = text => [...container.querySelectorAll('button')].find(b => b.textContent === text);
test('moves a stop and saves the complete driver/date sequence', async () => {
  expect(api.get).toHaveBeenCalledWith('/deliveries/delivery-order', { params: { driverId: 'driver1', date: '2026-10-14' } });
  expect(container.querySelector('[aria-label="Move stop 1 up"]').disabled).toBe(true);
  await act(async () => container.querySelector('[aria-label="Move stop 2 up"]').click());
  expect(container.querySelector('li').textContent).toContain('Second');
  await act(async () => button('Save order').click());
  expect(api.put).toHaveBeenCalledWith('/deliveries/delivery-order', { driverId: 'driver1', date: '2026-10-14', revision: 'rev1', deliveryIds: ['b', 'a'] });
  expect(container.textContent).toContain('Saved.');
  expect(button('Save order').disabled).toBe(true);
});
test('shows a conflict and requires reloading before retry', async () => {
  api.put.mockRejectedValue({ response: { data: { message: 'The route changed.' } } });
  await act(async () => button('Save order').click());
  expect(container.textContent).toContain('The route changed.');
  expect(button('Save order').disabled).toBe(true);
  await act(async () => button('Reload').click());
  expect(button('Save order').disabled).toBe(false);
});
