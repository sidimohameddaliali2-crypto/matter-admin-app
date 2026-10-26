import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import api from '../utils/api';
import PartnerKitchenOrders, { partnerKitchenCsv } from './PartnerKitchenOrders';

const mockSocket = { on: jest.fn(), off: jest.fn() };
jest.mock('../contexts/SocketContext', () => ({ useSocket: () => ({ socket: mockSocket }) }));
jest.mock('../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
global.IS_REACT_ACT_ENVIRONMENT = true;
let root, container;
const DAY = '2026-10-31';
const item = { itemId: 'meal', name: 'Chicken Bowl', mealType: 'bowl', quantity: 5 };
const data = {
  date: DAY, orderCount: 1, totalQuantity: 5, counts: [item],
  orders: [{ id: 'order', reference: 'PO-0001', partnerName: 'Cafe Fixture', deliveryTime: 'Morning', notes: 'Reception', lines: [item] }],
};
const response = value => ({ data: { success: true, data: value } });
const render = async props => act(async () => { root.render(<PartnerKitchenOrders date={DAY} {...props} />); });
beforeEach(() => {
  mockSocket.on.mockClear(); mockSocket.off.mockClear();
  api.get.mockImplementation(async () => response(data));
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

test('kitchen list shows submitted partner order quantities and delivery instructions', async () => {
  await render({});
  expect(api.get).toHaveBeenCalledWith('/menus/kitchen-partner-orders', { params: { date: DAY } });
  for (const text of ['Cafe Fixture', 'Chicken Bowl', '5 ×', 'Reception', 'PO-0001']) expect(container.textContent).toContain(text);
});

test('kitchen counting shows the same ordered portions by dish', async () => {
  await render({ counting: true });
  expect(container.textContent).toContain('Partner cook counts');
  expect(container.textContent).toContain('5 portion(s)');
  expect(container.querySelector('tbody tr').textContent).toContain('Chicken Bowl5');
});

test('an order-change event refreshes quantities and removes cancelled orders', async () => {
  await render({ counting: true });
  const changed = mockSocket.on.mock.calls.find(([name]) => name === 'partner:ordersChanged')[1];
  api.get.mockImplementation(async () => response({ ...data, orderCount: 0, totalQuantity: 0, counts: [], orders: [] }));
  await act(async () => changed({ date: DAY }));
  expect(container.textContent).toContain('No submitted partner orders');
  expect(container.textContent).not.toContain('Chicken Bowl');
});

test('a failed refresh hides stale cooking counts and blocks export', async () => {
  await render({ counting: true });
  api.get.mockRejectedValue(new Error('Fixture refresh failure'));
  await act(async () => [...container.querySelectorAll('button')].find(b => b.textContent === 'Refresh partner orders').click());
  expect(container.querySelector('[role="alert"]').textContent).toContain('Fixture refresh failure');
  expect(container.textContent).not.toContain('Chicken Bowl');
  expect([...container.querySelectorAll('button')].find(b => b.textContent.includes('Export partner')).disabled).toBe(true);
});

test('switching dates ignores an older request that finishes late', async () => {
  let finishOld;
  api.get.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  await render({});
  api.get.mockImplementation(async () => response({ ...data, date: '2026-11-01', orders: [], counts: [], totalQuantity: 0, orderCount: 0 }));
  await render({ date: '2026-11-01' });
  await act(async () => finishOld(response(data)));
  expect(container.textContent).toContain('Delivery: 2026-11-01');
  expect(container.textContent).not.toContain('Chicken Bowl');
});

test('partner production CSVs preserve quantities and do not invent macro weights', () => {
  expect(partnerKitchenCsv(data, true)).toContain('"Bowl","Chicken Bowl","5"');
  expect(partnerKitchenCsv(data, false)).toContain('"Cafe Fixture","PO-0001","Morning"');
  expect(partnerKitchenCsv(data, true)).not.toContain('Protein');
});
