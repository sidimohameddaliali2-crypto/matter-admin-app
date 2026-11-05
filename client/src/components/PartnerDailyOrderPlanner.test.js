import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import api from '../utils/partnerApi';
import Planner from './PartnerDailyOrderPlanner';
jest.mock('../utils/partnerApi', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn()
  }
}));
global.IS_REACT_ACT_ENVIRONMENT = true;
const A = '2099-01-05',
  B = '2099-01-06',
  C = '2099-01-07',
  partner = {
    _id: 'fixture',
    minimumOrder: 0
  };
let root, container;
const menu = date => [{
  _id: date === B ? 'b' : 'a',
  name: date === B ? 'Meal B' : 'Meal A',
  price: date === B ? 30 : 20
}];
const render = props => act(async () => root.render(<Planner partner={partner} earliestDate={A} orders={[]} {...props} />));
const button = label => [...container.querySelectorAll('button')].find(b => b.textContent === label || b.getAttribute('aria-label') === label);
const click = label => act(async () => {
  expect(button(label)).toBeTruthy();
  button(label).click();
});
const begin = async end => {
  for (let time = Date.parse(A + 'T00:00:00Z'); time <= Date.parse(end + 'T00:00:00Z'); time += 86400000) {
    const date = new Date(time).toISOString().slice(0, 10);
    const cell = button('Delivery ' + date);
    if (cell && !cell.disabled && cell.getAttribute('aria-pressed') !== 'true') await click('Delivery ' + date);
  }
  await click('Start daily orders');
};
beforeEach(() => {
  localStorage.clear();
  api.get.mockReset();
  api.post.mockReset();
  api.get.mockImplementation(async path => ({
    data: {
      success: true,
      data: path === '/partner/orders' ? [] : path.startsWith('/partner/orders/') ? {
        status: 'draft', lines: []
      } : menu(path.split('=')[1])
    }
  }));
  api.post.mockImplementation(async (path, body) => ({
    data: {
      success: true,
      data: {
        _id: body ? 'order-' + body.deliveryDate : 'submitted'
      }
    }
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
test('daily carts are separate, every day must be confirmed, and one checkout places the whole plan', async () => {
  await render();
  await begin(C);
  expect(button('Place all daily orders')).toBeUndefined();
  await click('Add Meal A');
  await click('Confirm day & continue');
  expect(container.textContent).toContain('Day 2 of 3');
  expect(container.querySelector('[aria-label="Quantity for Meal B"]').textContent).toBe('0');
  await click('Add Meal B');
  await click('Add Meal B');
  await click('Confirm day & continue');
  expect(button('Place all daily orders')).toBeUndefined();
  expect(api.post).not.toHaveBeenCalled();
  await click('Add Meal A');
  await click('Confirm day & continue');
  expect(container.textContent).toContain('Combined total AED 100.00');
  await click('Place all daily orders');
  const bodies = api.post.mock.calls.filter(([path]) => path === '/partner/orders').map(([, body]) => body);
  expect(bodies.map(b => b.deliveryDate)).toEqual([A, B, C]);
  expect(bodies.map(b => b.lines)).toEqual([[{
    menuItemId: 'a',
    quantity: 1
  }], [{
    menuItemId: 'b',
    quantity: 2
  }], [{
    menuItemId: 'a',
    quantity: 1
  }]]);
  expect(container.textContent).toContain('Your daily orders are placed');
});
test('empty dates cannot be skipped and can be removed using Change dates', async () => {
  await render();
  await begin(B);
  await click('Confirm day & continue');
  expect(container.textContent).toContain('Add items for this day');
  expect(button('Skip this day & continue')).toBeUndefined();
  await click('Change dates');
  await click('Delivery ' + A);
  await click('Start daily orders');
  await click('Add Meal B');
  await click('Confirm day & continue');
  await click('Place all daily orders');
  expect(api.post.mock.calls.filter(([p]) => p === '/partner/orders').map(([, b]) => b.deliveryDate)).toEqual([B]);
});
test('minimum is validated per delivery before moving on', async () => {
  await render({
    partner: {
      ...partner,
      minimumOrder: 40
    }
  });
  await begin(B);
  await click('Add Meal A');
  await click('Confirm day & continue');
  expect(container.textContent).toContain('Minimum per delivery is AED 40.00');
  expect(container.textContent).toContain('Day 1 of 2');
  expect(api.post).not.toHaveBeenCalled();
});
test('going back preserves the previous day cart', async () => {
  await render();
  await begin(B);
  await click('Add Meal A');
  await click('Confirm day & continue');
  await click('Previous day');
  expect(container.querySelector('[aria-label="Quantity for Meal A"]').textContent).toBe('1');
});
test('failed menu loading blocks confirmation and offers no skip button', async () => {
  api.get.mockRejectedValue(new Error('Fixture unavailable'));
  await render();
  await begin(B);
  expect(container.textContent).toContain('Fixture unavailable');
  expect(button('Confirm day & continue').disabled).toBe(true);
  expect(button('Skip this day & continue')).toBeUndefined();
});
test('partial checkout retries only the remaining date', async () => {
  let failed = false;
  api.post.mockImplementation(async (path, body) => {
    if (path === '/partner/orders/order-' + B + '/submit' && !failed) {
      failed = true;
      throw new Error('Fixture failed');
    }
    return {
      data: {
        success: true,
        data: {
          _id: body ? 'order-' + body.deliveryDate : 'submitted'
        }
      }
    };
  });
  await render();
  await begin(B);
  await click('Add Meal A');
  await click('Confirm day & continue');
  await click('Add Meal B');
  await click('Confirm day & continue');
  await click('Place all daily orders');
  expect(container.textContent).toContain('Accepted orders are saved');
  await click('Retry remaining orders');
  expect(api.post.mock.calls.filter(([p, b]) => p === '/partner/orders' && b.deliveryDate === A)).toHaveLength(1);
  expect(container.textContent).toContain('Your daily orders are placed');
});
test('price changes require another review before any write', async () => {
  await render();
  await begin(A);
  await click('Add Meal A');
  await click('Confirm day & continue');
  api.get.mockImplementation(async path => ({
    data: {
      success: true,
      data: path === '/partner/orders' ? [] : [{
        _id: 'a',
        name: 'Meal A',
        price: 25
      }]
    }
  }));
  await click('Place all daily orders');
  expect(container.textContent).toContain('Prices have changed');
  expect(container.textContent).toContain('Combined total AED 25.00');
  expect(api.post).not.toHaveBeenCalled();
  await click('Place all daily orders');
  expect(container.textContent).toContain('Your daily orders are placed');
});
test('local progress resumes after leaving the page', async () => {
  await render();
  await begin(B);
  await click('Add Meal A');
  await click('Confirm day & continue');
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  expect(container.textContent).toContain('Day 2 of 2');
  expect(api.post).not.toHaveBeenCalled();
});
test('existing orders must be kept explicitly rather than merged', async () => {
  await render({
    orders: [{
      _id: 'old',
      deliveryDate: A + 'T00:00:00Z',
      status: 'submitted'
    }]
  });
  await begin(B);
  expect(container.textContent).toContain('An order already exists');
  expect(button('Add Meal A')).toBeUndefined();
  await click('Keep existing order & continue');
  expect(container.textContent).toContain('Day 2 of 2');
});

test('a 15-day date range requires visiting every delivery day before final checkout', async () => {
  await render();
  await begin('2099-01-19');
  for (let index = 0; index < 13; index++) {
    expect(container.textContent).toContain('Day ' + (index + 1) + ' of 13');
    expect(button('Place all daily orders')).toBeUndefined();
    const add = [...container.querySelectorAll('button')].find(b => b.getAttribute('aria-label')?.startsWith('Add '));
    await act(async () => add.click());
    await click('Confirm day & continue');
  }
  expect(button('Place all daily orders')).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
});
test('changing the range preserves carts for delivery dates still in the plan', async () => {
  await render(); await begin(B);
  await click('Add Meal A'); await click('Confirm day & continue'); await click('Add Meal B');
  await click('Change dates'); await begin(C);
  expect(container.textContent).toContain('Day 2 of 3');
  expect(container.querySelector('[aria-label="Quantity for Meal B"]').textContent).toBe('1');
});
test('a selected dish removed from the menu can be explicitly removed when revisiting the date', async () => {
  await render(); await begin(B); await click('Add Meal A'); await click('Confirm day & continue');
  api.get.mockResolvedValue({data:{success:true,data:[{_id:'replacement',name:'Replacement',price:20}]}});
  await click('Previous day');
  expect(container.textContent).toContain('Meal A is no longer available');
  await click('Remove unavailable Meal A'); await click('Add Replacement'); await click('Confirm day & continue');
  expect(container.textContent).toContain('Day 2 of 2');
});

test('calendar preserves individual date selection and requires review only for selected days', async () => {
  await render();
  expect(button('Delivery ' + A).getAttribute('aria-pressed')).toBe('true');
  expect(button('Delivery 2099-01-04').disabled).toBe(true);
  expect(button('Delivery 2099-01-11').disabled).toBe(true);
  await click('Delivery ' + C);
  await click('Start daily orders');
  expect(container.textContent).toContain('Day 1 of 2');
  await click('Add Meal A'); await click('Confirm day & continue');
  expect(container.textContent).toContain('Day 2 of 2');
  expect(api.get.mock.calls.some(([path]) => path.endsWith('date=' + B))).toBe(false);
  await click('Add Meal A'); await click('Confirm day & continue');
  await click('Place all daily orders');
  expect(api.post.mock.calls.filter(([p]) => p === '/partner/orders').map(([, b]) => b.deliveryDate)).toEqual([A, C]);
});

test('calendar supports month navigation, toggling and existing order dots', async () => {
  await render({orders: [{_id: 'old', deliveryDate: A, status: 'submitted'}]});
  expect(button('Delivery ' + A).querySelector('[aria-label="Existing order"]')).toBeTruthy();
  await click('Delivery ' + A);
  await click('Start daily orders');
  expect(container.textContent).toContain('Choose at least one delivery day');
  await click('Next month');
  expect(container.textContent).toContain('February 2099');
  await click('Delivery 2099-02-02');
  await click('Previous month');
  expect(container.textContent).toContain('January 2099');
  await click('Next month');
  expect(button('Delivery 2099-02-02').getAttribute('aria-pressed')).toBe('true');
});


test.each([A, B])('saved expired dates can be removed with earliest date %s', async earliestDate => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2099-01-03T12:00:00Z'));
  try {
    localStorage.setItem('partner-daily-plan:fixture', JSON.stringify({
      version: 1, phase: 'days', from: A, to: A, selectedDates: [A], index: 0,
      days: [{date: A, items: {}, window: 'Morning · 5–6am', reviewed: false}]
    }));
    await render({earliestDate});
    await click('Change dates');
    expect(button('Delivery ' + A).getAttribute('aria-pressed')).toBe('true');
    expect(button('Delivery ' + A).disabled).toBe(false);
    await click('Delivery ' + A);
    expect(button('Delivery ' + A).disabled).toBe(true);
    expect(button('Delivery ' + A).getAttribute('aria-pressed')).toBe('false');
    await click('Delivery ' + B);
    await click('Start daily orders');
    expect(container.textContent).toContain('Day 1 of 1');
    expect(container.textContent).not.toContain('cutoff has passed');
    const saved = JSON.parse(localStorage.getItem('partner-daily-plan:fixture'));
    expect(saved.days.map(day => day.date)).toEqual([B]);
    await act(async () => root.unmount());
    root = createRoot(container);
    await render({earliestDate});
    expect(container.textContent).toContain('Day 1 of 1');
    expect(JSON.parse(localStorage.getItem('partner-daily-plan:fixture')).selectedDates).toEqual([B]);
    expect(api.post).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});


test.each([
  ['dates', '', B],
  ['dates', A, ''],
  ['dates', A, '2099-05-05'],
  ['days', '', B],
  ['days', A, ''],
  ['days', A, '2099-05-05'],
  ['dates', B, A],
  ['dates', '2099-02-30', '2099-03-01']
])('legacy %s draft recovers invalid range %s through %s without losing meals', async (phase, from, to) => {
  localStorage.setItem('partner-daily-plan:fixture', JSON.stringify({
    version: 1, phase, from, to, index: 0,
    days: [{date: A, items: {a: {id: 'a', name: 'Meal A', price: 20, quantity: 2}},
      window: 'Morning · 5–6am', reviewed: false}]
  }));
  await render();
  if (phase === 'days') await click('Change dates');
  expect(button('Delivery ' + A).getAttribute('aria-pressed')).toBe('true');
  await click('Delivery ' + B);
  await click('Start daily orders');
  expect(container.textContent).toContain('Day 1 of 2');
  expect(container.querySelector('[aria-label="Quantity for Meal A"]').textContent).toBe('2');
  expect(JSON.parse(localStorage.getItem('partner-daily-plan:fixture')).selectedDates).toEqual([A, B]);
  expect(api.post).not.toHaveBeenCalled();
});

test('a valid legacy range retains all selected delivery dates', async () => {
  localStorage.setItem('partner-daily-plan:fixture', JSON.stringify({
    version: 1, phase: 'dates', from: A, to: C, index: 0,
    days: [{date: A, items: {}, window: 'Morning · 5–6am', reviewed: false}]
  }));
  await render();
  for (const date of [A, B, C]) expect(button('Delivery ' + date).getAttribute('aria-pressed')).toBe('true');
});


test('daily menu restores category tags, protein groups and filters without losing cart quantities', async () => {
  const dishes = [
    {_id: 'chicken', name: 'CHICKEN RICE', mealType: 'main', category: 'Chicken', price: 28},
    {_id: 'beef', name: 'BEEF BOWL', mealType: 'main', category: 'Beef', price: 32},
    {_id: 'fish', name: 'FISH RICE', mealType: 'main', category: 'Fish', price: 32},
    {_id: 'oats', name: 'BERRY OATS', mealType: 'oats', description: 'Fresh berries', price: 15},
    {_id: 'unknown', name: 'EXTRA DISH', price: null}
  ];
  api.get.mockImplementation(async path => ({data: {success: true, data: path === '/partner/orders' ? [] : dishes}}));
  await render(); await begin(B);
  expect(container.querySelector('h2').style.fontFamily).toContain('Archivo Black');
  await click('Morning · 7–10am');
  expect(button('Morning · 7–10am').getAttribute('aria-pressed')).toBe('true');
  expect(JSON.parse(localStorage.getItem('partner-daily-plan:fixture')).days[0].window).toBe('Morning · 7–10am');
  for (const group of ['Main', 'Oats', 'Other']) expect(container.querySelector('[aria-label="' + group + ' meals"]')).toBeTruthy();
  for (const protein of ['Chicken', 'Beef', 'Fish']) expect([...container.querySelectorAll('h5')].some(h => h.textContent === protein)).toBe(true);
  expect(container.textContent).toContain('Chicken Rice');
  expect(container.textContent).toContain('Fresh berries');
  expect(container.textContent).toContain('Price TBD');
  expect(button('Add EXTRA DISH').disabled).toBe(true);
  await click('Add CHICKEN RICE');
  await click('Filter Oats');
  expect(button('Add CHICKEN RICE')).toBeUndefined();
  expect(button('Add BERRY OATS')).toBeTruthy();
  await click('Add BERRY OATS');
  await click('Filter Main');
  expect(container.querySelector('[aria-label="Quantity for CHICKEN RICE"]').textContent).toBe('1');
  expect(container.textContent).toContain('Day total: AED 43.00');
  await click('Confirm day & continue');
  expect(button('Filter All').getAttribute('aria-pressed')).toBe('true');
  expect(container.querySelector('[aria-label="Quantity for CHICKEN RICE"]').textContent).toBe('0');
  expect(button('Add BERRY OATS')).toBeTruthy();
});


test.each(['review', 'days'])('partial checkout recovers an expired unplaced day from %s after reload', async phase => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2099-01-01T12:00:00Z'));
  const failed = new Set();
  api.post.mockImplementation(async (path, body) => {
    if ([B, C].some(date => path === '/partner/orders/order-' + date + '/submit') && !failed.has(path)) {
      failed.add(path);
      throw new Error('Fixture failed');
    }
    return {data: {success: true, data: {_id: body ? 'order-' + body.deliveryDate : 'submitted'}}};
  });
  try {
    await render(); await begin(C);
    await click('Add Meal A'); await click('Confirm day & continue');
    await click('Add Meal B'); await click('Confirm day & continue');
    await click('Add Meal A'); await click('Confirm day & continue');
    await click('Place all daily orders');
    expect(button('Change dates')).toBeUndefined();
    expect(button('Remove Mon 5 Jan')).toBeUndefined();
    jest.setSystemTime(new Date('2099-01-04T12:00:00Z'));
    await act(async () => root.unmount()); root = createRoot(container); await render();
    if (phase === 'days') {
      await click('Edit Tue 6 Jan');
      await click('Confirm day & continue');
      expect(container.textContent).toContain('cutoff has passed');
      await click('Remove this unplaced day');
    } else {
      await click('Retry remaining orders');
      expect(container.textContent).toContain('cutoff has passed');
      await click('Remove Tue 6 Jan');
    }
    const saved = JSON.parse(localStorage.getItem('partner-daily-plan:fixture'));
    expect(saved.days.map(day => day.date)).toEqual([A, C]);
    expect(saved.selectedDates).toEqual([A, C]);
    expect(saved.days[0]).toMatchObject({placed: true, orderId: 'order-' + A});
    await act(async () => root.unmount()); root = createRoot(container); await render();
    await click('Retry remaining orders');
    expect(container.textContent).toContain('Your daily orders are placed');
    expect(api.post.mock.calls.filter(([path]) => path === '/partner/orders/order-' + A + '/submit')).toHaveLength(1);
    expect(api.post.mock.calls.filter(([path]) => path === '/partner/orders/order-' + B + '/submit')).toHaveLength(1);
    expect(api.post.mock.calls.filter(([path]) => path === '/partner/orders/order-' + C + '/submit')).toHaveLength(2);
  } finally { jest.useRealTimers(); }
});

test('removing the final unplaced day finishes the plan while preserving the accepted order', async () => {
  localStorage.setItem('partner-daily-plan:fixture', JSON.stringify({
    version: 1, phase: 'review', from: A, to: B, selectedDates: [A, B], index: 1,
    days: [
      {date: A, items: {a: {id: 'a', name: 'Meal A', price: 20, quantity: 1}}, window: 'Morning · 5–6am', reviewed: true, placed: true, orderId: 'accepted'},
      {date: B, items: {}, window: 'Morning · 5–6am', reviewed: true, error: 'Failed'}
    ]
  }));
  await render();
  await click('Remove Tue 6 Jan');
  expect(container.textContent).toContain('Your daily orders are placed');
  expect(container.textContent).toContain('1 order(s) · AED 20.00 total');
  expect(button('Start another plan')).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
  expect(localStorage.getItem('partner-daily-plan:fixture')).toBeNull();
});
