import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import Subscription from './Subscription';
import api from '../utils/api';
import * as XLSX from 'xlsx';
import { formatBusinessDateInput } from '../utils/businessTime';

jest.mock('../utils/api', () => ({ post: jest.fn(), get: jest.fn() }));
jest.mock('recharts', () => {
  const Component = ({ children }) => <div>{children}</div>;
  return { ResponsiveContainer: Component, AreaChart: Component, Area: () => null, BarChart: Component, Bar: () => null, XAxis: () => null, YAxis: () => null, CartesianGrid: () => null, Tooltip: () => null };
});
jest.mock('xlsx', () => ({ utils: { book_new: jest.fn(() => ({})), aoa_to_sheet: jest.fn(() => ({})), book_append_sheet: jest.fn() }, writeFile: jest.fn() }));

global.IS_REACT_ACT_ENVIRONMENT = true;
let container, root;
const screen = { getByText: (value) => [...container.querySelectorAll('*')].find((node) => node.textContent === value), getByRole: (value) => container.querySelector(`[role="${value}"]`), queryByText: (value) => [...container.querySelectorAll('*')].find((node) => node.textContent === value) || null };
const today = formatBusinessDateInput(new Date());
const report = {
  from: today.slice(0, 8) + '01', to: today, today, observedAt: new Date(Date.now() - 20 * 60000).toISOString(), captureStartedOn: today,
  activeSubscriptions: 301, subscriptionStartsLast7Days: 40, plans: [], unidentifiedPayments: 0,
  paymentCoverage: 'Observed Matter payments',
  days: [{ day: today, paymentsReceived: 1000, knownDeliveryRevenue: 0, orders: 2, completed: 1, unpriced: 1, unknownPayments: 0 }],
  details: [{ date: today, customerId: 'CUST-1', name: 'Matter Name', status: 'delivered', revenue: null, unitAmount: null, amountPaid: null, pricingStatus: 'historical-pricing-unavailable' }],
  totals: { paymentsReceived: 1000, knownDeliveryRevenue: 0, orders: 2, completed: 1, unpriced: 1, unknownPayments: 0 },
};
beforeEach(() => {
  jest.clearAllMocks();
  XLSX.utils.aoa_to_sheet.mockImplementation(() => ({}));
  XLSX.utils.book_new.mockImplementation(() => ({}));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  api.post.mockResolvedValue({ data: { success: true } });
  api.get.mockResolvedValue({ data: { success: true, data: report } });
});

afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

test('loads the shared report, labels missing history and never shows a fabricated renewal percentage', async () => {
  await act(async () => root.render(<Subscription />));
  expect(screen.getByText('301')).toBeTruthy();
  expect(api.post).toHaveBeenCalledWith('/matter/sales-dashboard/refresh');
  expect(api.get.mock.calls.every(([url]) => url === '/matter/sales-dashboard')).toBe(true);
  expect(screen.getByText('40 subscription starts in last 7 days; includes renewals')).toBeTruthy();
  expect(screen.getByText('Complete renewal history is required')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toContain('unavailable pricing');
  expect(screen.queryByText('100%')).toBeNull();
});

test('failed source refresh visibly retains captured data instead of silently showing zero', async () => {
  api.post.mockRejectedValue({ response: { data: { message: 'Matter refresh incomplete' } } });
  await act(async () => root.render(<Subscription />));
  expect(screen.getByText('301')).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toContain('Matter refresh incomplete');
});

test('a recent saved capture loads immediately without repeating hundreds of Matter detail requests', async () => {
  api.get.mockResolvedValue({ data: { success: true, data: { ...report, observedAt: new Date().toISOString() } } });
  await act(async () => root.render(<Subscription />));
  expect(screen.getByText('301')).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
  await act(async () => screen.getByText('Refresh').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(api.post).toHaveBeenCalledWith('/matter/sales-dashboard/refresh');
});

test('Excel exports use the same report and leave unknown historical revenue blank', async () => {
  await act(async () => root.render(<Subscription />));
  expect(screen.getByText('301')).toBeTruthy();
  await act(async () => screen.getByText('Download Excel').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(XLSX.writeFile).toHaveBeenCalled();
  const exported = XLSX.utils.aoa_to_sheet.mock.calls[0][0];
  expect(exported[1][8]).toBe('');
  expect(exported[1][9]).toBe('historical-pricing-unavailable');
  expect(api.get.mock.calls.at(-1)[0]).toBe('/matter/sales-dashboard');
});
