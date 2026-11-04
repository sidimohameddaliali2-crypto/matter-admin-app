import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import api from '../utils/api';
import KitchenCounting from './KitchenCounting';

jest.mock('../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
jest.mock('../components/PartnerKitchenOrders', () => () => null);
global.IS_REACT_ACT_ENVIRONMENT = true;

const A = '2026-10-20', B = '2026-10-21';
const entry = {
  email: 'fixture@example.invalid', customerId: 'fixture', firstName: 'Fixture',
  selectedMeals: [A, B].map((date) => ({ date, mealType: 'main', mealName: 'Fixture meal', quantity: 1 })),
};
let container, root, pending, fail;
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const select = async (index, value) => {
  await act(async () => {
    const element = container.querySelectorAll('select')[index];
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
};

beforeEach(async () => {
  pending = {}; fail = false;
  api.post.mockImplementation(async () => ({ data: { success: true, preparation: 'completed' } }));
  api.get.mockImplementation(async (path, config) => {
    if (path.startsWith('/menus?')) return { data: { success: true, data: [{ _id: 'menu', title: 'Fixture', startDate: A, endDate: B }] } };
    if (path.endsWith('/selections')) return { data: { success: true, data: [entry] } };
    if (path.includes('kitchen-inputs')) return { data: { data: { plan_name: 'Custom', macros: { carbohydrates: 60, protein: 60, fat: 20 }, active_delivery_dates: [A, B] } } };
    if (path.includes('delivery-on-date')) {
      if (fail) throw new Error('Fixture roster failure');
      return new Promise((resolve) => { pending[config.params.date] = resolve; });
    }
    return { data: { success: true, data: {} } };
  });
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<KitchenCounting />));
  await flush();
  await select(0, 'menu');
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove(); jest.clearAllMocks();
});

test('before choosing a date, date discovery needs one small request and no complete selections download', () => {
  expect(api.get.mock.calls.filter(([url])=>url.endsWith('/kitchen-dates'))).toHaveLength(1);
  expect(api.get.mock.calls.filter(([url])=>url.endsWith('/selections'))).toHaveLength(0);
  expect(api.get.mock.calls.filter(([url])=>/\/(main-meal-options|breakfast-options|snack-options)$/.test(url))).toHaveLength(0);
});

test('obsolete date A cannot overwrite date B, and a failed refresh cannot export B as current', async () => {
  await select(1, A);
  expect(pending[A]).toBeDefined();
  await select(1, B);
  expect(pending[B]).toBeDefined();
  await act(async () => pending[B]({ data: { success: true, data: [{ email: entry.email }] } }));
  const exportButton = () => [...container.querySelectorAll('button')].find((button) => button.textContent.includes('Export Excel'));
  expect(exportButton().disabled).toBe(false);
  expect(container.textContent).toContain('1 main meal(s) total');
  await act(async () => pending[A]({ data: { success: true, data: [] } }));
  expect(container.textContent).toContain('1 main meal(s) total');
  expect(exportButton().disabled).toBe(false);
  fail = true;
  await act(async () => container.querySelector('button[title="Reload counts"]').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await flush();
  expect(container.textContent).toContain('Fixture roster failure');
  expect(exportButton().disabled).toBe(true);
  expect(container.textContent).toContain('0 main meal(s) total');
});

test('clearing the date invalidates a request still loading', async () => {
  await select(1, A);
  await select(1, '');
  await act(async () => pending[A]({ data: { success: true, data: [{ email: entry.email }] } }));
  expect(container.textContent).not.toContain('Cook counts');
  expect(container.textContent).not.toContain('Export Excel');
});

const selectedDateChip = () => container.querySelector('[aria-label="Delivery dates"] button[aria-pressed="true"]');
const exportButton = () => [...container.querySelectorAll('button')].find(button => button.textContent.includes('Export Excel'));

const useMixedCoreDates = () => {
  const originalGet = api.get.getMockImplementation();
  api.get.mockImplementation(async (path, config) => {
    if (path.endsWith('/selections')) return { data: { success: true, data: [{ ...entry, selectedMeals: [
      { date: A, mealType: 'main', mealName: 'Valid day meal' },
      { date: B, mealType: 'main', mealName: 'Other day first meal' },
      { date: B, mealType: 'main', mealName: 'Other day second meal' },
    ] }] } };
    if (path.includes('kitchen-inputs')) return { data: { success: true, data: {
      customer_name: 'Core Fixture', plan_name: 'Matter Core', macros: { carbohydrates: 100, protein: 100, fat: 11 },
      meal_frequency: 1, snacks_per_day: 0, breakfast_included: false, exclusions: [], active_delivery_dates: [A, B], double_delivery_dates: [],
    } } };
    return originalGet(path, config);
  });
};

test('an unsupported Core portion on another date must not block valid selected-day counts or export', async () => {
  useMixedCoreDates();
  await select(1, A);
  await act(async () => pending[A]({ data: { success: true, data: [{ email: entry.email }] } }));
  expect(container.textContent).not.toContain('Kitchen export blocked');
  expect(container.textContent).toContain('1 main meal(s) total');
  expect(exportButton().disabled).toBe(false);
});

test('an unsupported Core portion on the selected date still blocks export', async () => {
  useMixedCoreDates();
  await select(1, B);
  await act(async () => pending[B]({ data: { success: true, data: [{ email: entry.email }] } }));
  expect(container.textContent).toContain('Kitchen export blocked');
  expect(container.textContent).toContain('Core Fixture');
  expect(container.textContent).toContain('P 50g / C 50g');
  expect(exportButton().disabled).toBe(true);
});

test('clicking the current date preserves loaded counts and Excel export without reloading', async () => {
  await select(1, A);
  await act(async () => pending[A]({ data: { success: true, data: [{ email: entry.email }] } }));
  expect(exportButton().disabled).toBe(false);
  const reads = api.get.mock.calls.length, preparations = api.post.mock.calls.length;
  await act(async () => selectedDateChip().click());
  expect(container.textContent).toContain('1 main meal(s) total');
  expect(exportButton().disabled).toBe(false);
  expect(api.get).toHaveBeenCalledTimes(reads);
  expect(api.post).toHaveBeenCalledTimes(preparations);
});

test('clicking the current date during loading keeps the request alive and clears the spinner when it completes', async () => {
  await select(1, A);
  expect(container.textContent).toContain('Loading kitchen counts...');
  const reads = api.get.mock.calls.length, preparations = api.post.mock.calls.length;
  await act(async () => selectedDateChip().click());
  await act(async () => pending[A]({ data: { success: true, data: [{ email: entry.email }] } }));
  expect(container.textContent).not.toContain('Loading kitchen counts...');
  expect(container.textContent).toContain('1 main meal(s) total');
  expect(exportButton().disabled).toBe(false);
  expect(api.get).toHaveBeenCalledTimes(reads);
  expect(api.post).toHaveBeenCalledTimes(preparations);
});
