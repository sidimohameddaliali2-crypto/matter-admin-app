import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import Customers from './Customers';
import api from '../utils/api';
import { customerMatterMetadata, hasUpcomingPlan, dubaiToday } from '../utils/customerMatterMetadata';

jest.mock('../utils/api', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('react-router-dom', () => ({ useLocation: () => ({}) }), { virtual: true });
jest.mock('react-redux', () => ({ useSelector: selector => selector({ auth: { user: { role: 'dispatcher' } } }) }));
jest.mock('../components/MealPreferences', () => () => null);

const alpha = { customerId: 'synthetic-a', firstName: 'Alpha', matterCustomerId: '20', matterSubscriptionId: '101',
  matterMetadata: { customer_id: '20', subscription_id: '101', customer_type: 'returning', customer_tags: [{ id: '1', name: 'Ambassador', color: '#46A758' }],
    updated_at: '2026-11-22T10:00:00Z', fetchedAt: '2026-11-23T08:00:00Z',
    upcoming_plan: { subscription_id: '102', starting_date: '2026-11-24', plan: { name: 'Future Thrive' } } } };
const beta = { customerId: 'synthetic-b', firstName: 'Beta', matterCustomerId: '30', matterMetadata: { customer_id: '30', customer_type: 'new', customer_tags: [], upcoming_plan: null } };

beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  jest.useFakeTimers().setSystemTime(new Date('2026-11-23T08:00:00Z'));
  api.get.mockImplementation(async path => ({ data: { success: true, data: path === '/customers' ? [alpha, beta] : path === '/deliveries' ? { deliveries: [] } : {} } }));
  api.post.mockResolvedValue({ data: { success: true } });
});
afterEach(() => { jest.useRealTimers(); jest.clearAllMocks(); });

test('Dubai day and upcoming start date are independent of the source update date', () => {
  expect(dubaiToday(new Date('2026-11-23T20:01:00Z'))).toBe('2026-11-24');
  expect(hasUpcomingPlan(alpha, '2026-11-23')).toBe(true);
  expect(hasUpcomingPlan(alpha, '2026-11-24')).toBe(true);
  expect(hasUpcomingPlan(alpha, '2026-11-25')).toBe(false);
  expect(hasUpcomingPlan(beta, '2026-11-23')).toBe(false);
  expect(customerMatterMetadata({ ...alpha, matterCustomerId: '99' })).toBe(null);
});

test('upcoming and type filters combine; profile shows captured tags and dates', async () => {
  const node = document.createElement('div');
  const root = createRoot(node);
  try {
    await act(async () => root.render(<Customers />));
    expect(api.post).toHaveBeenCalledWith('/customers/matter-metadata/refresh');
    expect(node.textContent).toContain('Alpha');
    expect(node.textContent).toContain('Beta');
    const upcoming = [...node.querySelectorAll('button')].find(button => button.textContent.startsWith('Upcoming plan'));
    await act(async () => upcoming.click());
    expect(node.textContent).toContain('Alpha');
    expect(node.textContent).not.toContain('Beta');
    const select = node.querySelector('select[aria-label="Customer type"]');
    await act(async () => { select.value = 'new'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(node.textContent).toContain('No customers found');
    await act(async () => { select.value = 'returning'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => node.querySelector('h3').click());
    expect(node.querySelector('[aria-label="Customer type"]').textContent).toBe('Returning');
    expect(node.querySelector('h1').previousElementSibling.textContent).toBe('Ambassador');
    expect(node.textContent).toContain('Future Thrive');
    expect(node.textContent).toContain('Starts 24 Nov 2026');
    expect(node.textContent).toContain('Matter updated:');
  } finally { await act(async () => root.unmount()); }
});

test('failed Matter refresh preserves the sheet, tags and filters', async () => {
  api.post.mockRejectedValue(new Error('offline'));
  const node = document.createElement('div');
  const root = createRoot(node);
  try {
    await act(async () => root.render(<Customers />));
    expect(node.textContent).toContain('Showing saved customer types, tags and upcoming plans');
    expect(node.textContent).toContain('Alpha');
    expect(node.textContent).toContain('Ambassador');
    expect(node.querySelector('select[aria-label="Customer type"]')).not.toBe(null);
  } finally { await act(async () => root.unmount()); }
});
