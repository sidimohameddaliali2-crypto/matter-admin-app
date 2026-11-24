import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import WebsiteSubscription from './WebsiteSubscription';
import api from '../utils/api';

jest.mock('../utils/api', () => ({ get: jest.fn(), post: jest.fn() }));
let mockSubscriptionId = '101';
jest.mock('react-router-dom', () => ({ useParams: () => ({ id: mockSubscriptionId }), useNavigate: () => jest.fn() }), { virtual: true });
jest.mock('../components/DeliveryCalendar', () => () => null);
jest.mock('../utils/activityCapture', () => ({ recordActivityChange: jest.fn() }));

const alpha = { subscription_id: 101, customer_id: 20, name: 'Synthetic Alpha', customer_type: 'returning', customer_tags: [{ id: 1, name: 'Ambassador', color: '#46A758' }],
  updated_at: '2026-11-22T10:00:00Z', plan: { name: 'Current plan' }, subscription_status: 'active', cycle_end_date: '2026-12-31',
  allergens: [{ id: 3, name: 'Dairy' }, { id: 4, name: 'Gluten' }], exclusions: [{ id: 19, title: 'Shrimps' }],
  upcoming_plan: { subscription_id: 102, customer_id: 20, starting_date: '2026-11-24', plan: { name: 'Future plan' } } };
const beta = { subscription_id: 201, customer_id: 30, name: 'Synthetic Beta', customer_type: 'new', customer_tags: [], upcoming_plan: null };

beforeEach(() => {
  mockSubscriptionId = '101';
  global.IS_REACT_ACT_ENVIRONMENT = true;
  jest.useFakeTimers().setSystemTime(new Date('2026-11-23T08:00:00Z'));
  api.get.mockImplementation(async path => ({ data: { data: path === '/matter/subscriptions/all' ? [alpha, beta]
    : path === '/matter/subscriptions/101' ? { data: alpha } : null } }));
  api.post.mockResolvedValue({ data: { data: { unmatchedIds: ['101', '201'] } } });
});

test('each customer uses only their own Matter API allergens, with no internal fallback for absent or empty data', async () => {
  const subscriptions = [alpha, { ...beta, allergens: [{ id: 8, name: 'Peanuts' }] },
    { subscription_id: 301, customer_id: 40, name: 'Synthetic Gamma', allergens: [] },
    { subscription_id: 401, customer_id: 50, name: 'Synthetic Delta' }];
  api.get.mockImplementation(async path => {
    if (path === '/matter/subscriptions/all') return { data: { data: subscriptions } };
    if (path === '/customers/match') return { data: { data: { customer: {
      customerId: 'internal-fixture', allergies: ['Soy'], allergens: [{ name: 'Sesame' }], mealExclusion: 'Eggs',
    } } } };
    if (path.startsWith('/menus/customers/')) return { data: { data: { allergies: ['Soy'], selectedMeals: [] } } };
    const subscription = subscriptions.find(row => path === `/matter/subscriptions/${row.subscription_id}`);
    return { data: { data: { data: subscription || null } } };
  });
  const node = document.createElement('div');
  const root = createRoot(node);
  try {
    for (const subscription of subscriptions) {
      mockSubscriptionId = String(subscription.subscription_id);
      await act(async () => root.render(<WebsiteSubscription />));
      const badges = node.querySelector('[aria-label="Allergens"]');
      const expected = subscription.allergens || [];
      if (!expected.length) expect(badges).toBeNull();
      else {
        expect([...badges.querySelectorAll('span')].map(span => span.textContent)).toEqual(expected.map(allergen => allergen.name));
        for (const internal of ['Soy', 'Sesame', 'Eggs']) expect(badges.textContent).not.toContain(internal);
      }
      expect(api.get).toHaveBeenCalledWith(`/matter/subscriptions/${subscription.subscription_id}`);
    }
  } finally { await act(async () => root.unmount()); }
});
afterEach(() => { jest.useRealTimers(); jest.clearAllMocks(); });

test('the actual Customer Management page has a type dropdown below search and combines it with upcoming plans', async () => {
  const node = document.createElement('div');
  const root = createRoot(node);
  try {
    await act(async () => root.render(<WebsiteSubscription />));
    const list = node.querySelector('[aria-label="Customer list"]');
    expect(node.querySelector('h1').textContent).toBe('Customer Management');
    const type = list.querySelector('select[aria-label="Customer type"]');
    expect([...type.options].map(option => option.textContent)).toEqual(['All customer types', 'New', 'Returning', 'Not provided']);
    expect(list.textContent).toContain('Synthetic Beta');
    const upcoming = [...list.querySelectorAll('button')].find(button => button.textContent.startsWith('Upcoming plan'));
    await act(async () => upcoming.click());
    expect(list.textContent).toContain('Synthetic Alpha');
    expect(list.textContent).not.toContain('Synthetic Beta');
    await act(async () => { type.value = 'new'; type.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(list.textContent).toContain('No subscriptions found');
    await act(async () => { type.value = 'returning'; type.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(list.textContent).toContain('Synthetic Alpha');
    const header = node.querySelector('h2').parentElement;
    expect(header.firstElementChild.getAttribute('aria-label')).toBe('Customer tags');
    expect(header.firstElementChild.textContent).toBe('Ambassador');
    expect(header.firstElementChild.firstElementChild.className).toContain('rounded-full');
    expect(header.querySelector('[aria-label="Customer type"]').textContent).toBe('Returning');
    expect(header.querySelector('[aria-label="Customer type"]').className).toContain('bg-blue-100');
    const details = [...node.querySelectorAll('section[aria-label="Matter customer details"]')].find(section => section.querySelector('h2'));
    expect(details.querySelector('[aria-label="Customer type"]')).toBeNull();
    expect(details.querySelector('[aria-label="Customer tags"]')).toBeNull();
    expect(node.textContent).toContain('Future plan');
    expect(node.textContent).toContain('Starts 24 Nov 2026');
    const allergens = node.querySelector('[aria-label="Allergens"]');
    expect(allergens.textContent).toContain('Dairy');
    expect(allergens.textContent).toContain('Gluten');
    expect(allergens.textContent).not.toContain('Shrimps');
    expect(node.textContent).toContain('Shrimps');
  } finally { await act(async () => root.unmount()); }
});

test('search matches types and tags, including subscribers without internal matches; refresh reloads profile', async () => {
  const node = document.createElement('div');
  const root = createRoot(node);
  try {
    await act(async () => root.render(<WebsiteSubscription />));
    const list = node.querySelector('[aria-label="Customer list"]');
    const search = list.querySelector('input');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    for (const term of ['returning', 'ambassador']) {
      await act(async () => { setValue.call(search, term); search.dispatchEvent(new Event('input', { bubbles: true })); });
      expect(list.textContent).toContain('Synthetic Alpha');
      expect(list.textContent).not.toContain('Synthetic Beta');
    }
    await act(async () => list.querySelector('[aria-label="Refresh Matter customers"]').click());
    expect(api.get.mock.calls.filter(([path]) => path === '/matter/subscriptions/101')).toHaveLength(2);
  } finally { await act(async () => root.unmount()); }
});
