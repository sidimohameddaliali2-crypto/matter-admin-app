import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import api from '../utils/api';
import KitchenCounting from './KitchenCounting';

jest.mock('../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
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
    if (path.includes('nutrition-by-email')) return { data: { data: { plan_name: 'Custom', macros: { carbohydrates: 60, protein: 60, fat: 20 }, active_delivery_dates: [A, B] } } };
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

test('obsolete date A cannot overwrite date B, and a failed refresh cannot export B as current', async () => {
  await select(1, A);
  expect(pending[A]).toBeDefined();
  await select(1, B);
  expect(pending[B]).toBeDefined();
  await act(async () => pending[B]({ data: { data: [{ email: entry.email }] } }));
  const exportButton = () => [...container.querySelectorAll('button')].find((button) => button.textContent.includes('Export Excel'));
  expect(exportButton().disabled).toBe(false);
  expect(container.textContent).toContain('1 main meal(s) total');
  await act(async () => pending[A]({ data: { data: [] } }));
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
  await act(async () => pending[A]({ data: { data: [{ email: entry.email }] } }));
  expect(container.textContent).not.toContain('Cook counts');
  expect(container.textContent).not.toContain('Export Excel');
});
