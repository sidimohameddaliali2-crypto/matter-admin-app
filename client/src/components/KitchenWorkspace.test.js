import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import KitchenCustomerBrowser from './KitchenCustomerBrowser';
import KitchenCountingGroups from './KitchenCountingGroups';

global.IS_REACT_ACT_ENVIRONMENT = true;
let root, container;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

test('switching customer details and filtering never mutates saved meals or transfers the detail state', async () => {
  const entries = [
    { email: 'first@example.invalid', customerName: 'First customer', selectedMeals: [{ mealName: 'Chosen twice', quantity: 2 }] },
    { email: 'second@example.invalid', customerName: 'Second customer', selectedMeals: [{ mealName: 'Own choice' }] },
  ];
  const before = JSON.stringify(entries);
  const render = rows => <KitchenCustomerBrowser entries={rows} visibleCount={50} onShowMore={() => {}} scope="menu:date"
    controls={<input aria-label="Customer search" />} renderCustomer={entry => <h2>{entry.selectedMeals[0].mealName}</h2>} />;
  await act(async () => root.render(render(entries)));
  expect(container.querySelector('h2').textContent).toBe('Chosen twice');
  await act(async () => container.querySelectorAll('.kitchen-customer-row')[1].click());
  expect(container.querySelector('h2').textContent).toBe('Own choice');
  expect(container.querySelector('.kitchen-browser').classList.contains('kitchen-browser-detail-open')).toBe(true);
  await act(async () => container.querySelector('.kitchen-mobile-back').click());
  expect(container.querySelector('.kitchen-browser').classList.contains('kitchen-browser-detail-open')).toBe(false);
  await act(async () => root.render(render([entries[0]])));
  expect(container.querySelector('h2').textContent).toBe('Chosen twice');
  expect(JSON.stringify(entries)).toBe(before);
});

test('counting groups preserve normal and large dishes, exact gram inputs and correct download targets', async () => {
  const rows = [
    { category: 'breakfast', mealName: 'Oats', count: 2, totalProteinWeight: 200, totalCarbWeight: 200, totalVegWeight: 160 },
    { category: 'breakfast', mealName: 'Oats (LARGE)', count: 1, totalProteinWeight: 150, totalCarbWeight: 200, totalVegWeight: 80 },
    { category: 'snack', mealName: 'Bites', count: 1, totalProteinWeight: 50, totalCarbWeight: 50, totalVegWeight: 0 },
  ];
  const before = JSON.stringify(rows), onDownload = jest.fn();
  await act(async () => root.render(<KitchenCountingGroups rows={rows} onDownload={onDownload} />));
  const groups = container.querySelectorAll('section');
  expect(groups).toHaveLength(2);
  expect(groups[0].querySelector('.kitchen-group-heading > div > strong').textContent).toBe('3');
  expect(groups[0].textContent).toContain('0.35 kg');
  expect(container.querySelectorAll('.kitchen-count-row')).toHaveLength(3);
  expect(container.querySelector('.kitchen-large-label').textContent).toBe('Large');
  expect(container.querySelectorAll('.kitchen-bar-track i')[0].style.width).toBe(`${200 / 350 * 100}%`);
  expect(groups[1].querySelector('.kitchen-weight-totalVegWeight .kitchen-bar-track i').style.width).toBe('0%');
  await act(async () => container.querySelector('[aria-label="Download customers for Oats (LARGE)"]').click());
  expect(onDownload).toHaveBeenCalledWith('breakfast', 'Oats (LARGE)');
  expect(JSON.stringify(rows)).toBe(before);
});
