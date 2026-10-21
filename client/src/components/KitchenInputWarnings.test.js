import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import KitchenInputWarnings from './KitchenInputWarnings';
global.IS_REACT_ACT_ENVIRONMENT = true;
let container, root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
test('lists incomplete customers and their reasons and opens the selected customer', async () => {
  const broken = { email: 'fixture@example.invalid', customerName: 'Fixture Customer', calculationStatus: 'incomplete', inputErrors: ['Matter daily meal count is unresolved.'], noDeliveryDate: '2026-10-22' };
  const show = jest.fn();
  await act(async () => root.render(<KitchenInputWarnings entries={[broken, { email: 'ready@example.invalid', calculationStatus: 'complete' }]} onShowCustomer={show} />));
  expect(container.textContent).toContain('1 customer(s)');
  expect(container.textContent).toContain(broken.email);
  expect(container.textContent).toContain(broken.inputErrors[0]);
  expect(container.textContent).toContain('excluded from production');
  expect(container.textContent).not.toContain('ready@example.invalid');
  await act(async () => container.querySelector('button').click());
  expect(show).toHaveBeenCalledWith(broken);
});
test('does not show a warning when all inputs are complete', async () => {
  await act(async () => root.render(<KitchenInputWarnings entries={[{ calculationStatus: 'complete' }]} onShowCustomer={() => {}} />));
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

test('a linked account excluded by a complete date roster is not an incomplete production warning', async () => {
  await act(async () => root.render(<KitchenInputWarnings entries={[
    { email: 'not-due@example.invalid', calculationStatus: 'incomplete', kitchenProductionExcluded: true },
    { email: 'due@example.invalid', calculationStatus: 'incomplete', inputErrors: ['Required nutrition unavailable.'] },
  ]} onShowCustomer={() => {}} />));
  expect(container.textContent).toContain('1 customer(s)');
  expect(container.textContent).toContain('due@example.invalid');
  expect(container.textContent).not.toContain('not-due@example.invalid');
});
