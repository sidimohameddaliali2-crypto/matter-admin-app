import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import UpcomingPlanSection from './UpcomingPlanSection';

const upcoming = {
  subscription_id: 102, customer_id: 20, replaces_subscription_id: 101, subscription_status: 'scheduled',
  starting_date: '2026-11-27', cycle_start_date: '2026-11-27', cycle_end_date: '2026-12-16',
  plan: { name: 'Future Custom', meal_frequency: 3 }, total_calories: 1350, macros: { protein: 115, carbohydrates: 110, fat: 50 },
  snacks_per_day: 0, breakfast_included: false, total_meals: 60, total_food_days: 20, total_deliveries: 20, remaining_deliveries: 20,
  has_double_delivery: false, delivery_window: { label: 'By 5 AM', timezone: 'Asia/Dubai' },
  allergens: [{ name: 'Peanuts' }], exclusions: [{ title: 'Raw onion' }],
  customer_addresses: [{ id: 2, label: 'Future address', building: 'Future building', unit: '202', category: 'apartment', coordinates: { lat: 25.1, lng: 55.2 } }],
  delivery_schedule: [{ date: '2026-11-27', status: 'active', food_days: 1, is_double: false }],
  base_price: 1000, bag_price: 0, discount: { amount: 0 }, vat: 50, vat_percentage: 5, gross_paid: 1050, currency: 'AED',
  payments: [{ id: 1, transaction_id: 'future-payment', date: '2026-11-24', amount: 1050, currency: 'AED', status: 'active', method: 'Card' }],
  pauses: { paused_days: [], resumed_days: [] }, updated_at: '2026-11-24T06:22:36Z',
};
const subscription = { subscription_id: 101, customer_id: 20, plan: { name: 'Current plan', meal_frequency: 5 },
  total_calories: 2200, macros: { protein: 200 }, allergens: [{ name: 'Dairy' }],
  customer_addresses: [{ label: 'Current address' }], gross_paid: 2200, upcoming_plan: upcoming };
const field = (node, label) => [...node.querySelectorAll('dt')].find(term => term.textContent === label)?.nextElementSibling.textContent;

beforeEach(() => { global.IS_REACT_ACT_ENVIRONMENT = true; });

test('Upcoming toggles and renders only the nested plan, including the visible start date and full details', async () => {
  const node = document.createElement('div');
  const root = createRoot(node);
  try {
    await act(async () => root.render(<UpcomingPlanSection subscription={subscription} />));
    const disclosure = node.querySelector('details');
    expect(disclosure.open).toBe(false);
    expect(node.querySelector('summary').textContent).toContain('Starts 27 Nov 2026');
    await act(async () => node.querySelector('summary').click());
    expect(disclosure.open).toBe(true);
    const nutrition = node.querySelector('[aria-label="Upcoming nutrition"]');
    expect(field(nutrition, 'Calories (kcal)')).toBe('1350');
    expect(field(nutrition, 'Protein (g)')).toBe('115');
    expect(field(node, 'Meals per day')).toBe('3');
    expect(field(node, 'Snacks per day')).toBe('0');
    expect(field(node, 'Breakfast included')).toBe('No');
    expect(node.querySelector('[aria-label="Upcoming allergens"]').textContent).toContain('Peanuts');
    expect(node.querySelector('[aria-label="Upcoming exclusions"]').textContent).toContain('Raw onion');
    expect(node.querySelector('[aria-label="Upcoming delivery addresses"]').textContent).toContain('Future building');
    expect(node.querySelector('[aria-label="Upcoming delivery schedule"]').textContent).toContain('27 Nov 2026');
    expect(node.querySelector('[aria-label="Upcoming payments"]').textContent).toContain('future-payment');
    expect(field(node, 'Gross paid')).toBe('AED 1050.00');
    expect(node.textContent).not.toContain('Current address');
    expect(node.textContent).not.toContain('Current plan');
    expect(node.textContent).not.toContain('Dairy');
    expect(node.querySelector('button')).toBeNull();
    await act(async () => node.querySelector('summary').click());
    expect(disclosure.open).toBe(false);
  } finally { await act(async () => root.unmount()); }
});

test('missing upcoming fields stay unavailable and never inherit current fields or derive the start from updated_at', async () => {
  const node = document.createElement('div');
  const root = createRoot(node);
  try {
    await act(async () => root.render(<UpcomingPlanSection subscription={{ ...subscription, upcoming_plan: { subscription_id: 103, updated_at: '2026-11-24T06:22:36Z' } }} />));
    expect(node.querySelector('summary').textContent).toContain('Starts Not provided');
    expect(field(node, 'Meals per day')).toBe('Not provided');
    expect(field(node, 'Calories (kcal)')).toBe('Not provided');
    expect(node.querySelector('[aria-label="Upcoming allergens"]').textContent).toContain('Not provided by Matter');
    expect(node.querySelector('[aria-label="Upcoming delivery addresses"]').textContent).not.toContain('Current address');
    expect(node.querySelector('[aria-label="Upcoming payments"]').textContent).toContain('Payments not provided by Matter');
  } finally { await act(async () => root.unmount()); }
});

test('customer switches reset the disclosure, and no-upcoming and unavailable responses remain distinct', async () => {
  const node = document.createElement('div');
  const root = createRoot(node);
  try {
    await act(async () => root.render(<UpcomingPlanSection subscription={subscription} />));
    await act(async () => node.querySelector('summary').click());
    expect(node.querySelector('details').open).toBe(true);
    await act(async () => root.render(<UpcomingPlanSection subscription={{ subscription_id: 201, upcoming_plan: null }} />));
    expect(node.querySelector('details').open).toBe(false);
    expect(node.querySelector('summary').textContent).toContain('No upcoming plan scheduled');
    expect(node.textContent).not.toContain('Future Custom');
    await act(async () => root.render(<UpcomingPlanSection subscription={{ subscription_id: 301 }} />));
    expect(node.querySelector('summary').textContent).toContain('Upcoming plan not provided by Matter');
  } finally { await act(async () => root.unmount()); }
});

test('Matter Core values retain their food-weight meaning', async () => {
  const node = document.createElement('div');
  const root = createRoot(node);
  try {
    await act(async () => root.render(<UpcomingPlanSection subscription={{ ...subscription, upcoming_plan: { ...upcoming, plan: { name: 'Matter Core' } } }} />));
    expect(field(node, 'Protein portion (g)')).toBe('115');
    expect(node.textContent).toContain('Matter Core portions are food weights');
  } finally { await act(async () => root.unmount()); }
});
