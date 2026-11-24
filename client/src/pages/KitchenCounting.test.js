import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import api from '../utils/api';
import KitchenCounting from './KitchenCounting';
import { installActivityCapture } from '../utils/activityCapture';

jest.mock('../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
const mockSocketHandlers = new Map();
const mockSocket = {
  on: (event, handler) => mockSocketHandlers.set(event, handler),
  off: (event, handler) => { if (mockSocketHandlers.get(event) === handler) mockSocketHandlers.delete(event); },
};
jest.mock('../contexts/SocketContext', () => ({useSocket: () => ({socket: mockSocket})}));
const mockCountingSave = jest.fn();
const mockCountingRows = jest.fn(rows => rows);
const mockCookingSave = jest.fn();
jest.mock('xlsx-js-style', () => ({ __esModule: true, default: { ...jest.requireActual('xlsx-js-style'), writeFile: (...args) => mockCookingSave(...args) } }));
jest.mock('xlsx', () => ({utils: {book_new: () => ({}), json_to_sheet: rows => mockCountingRows(rows), book_append_sheet: () => {}}, writeFile: (...args) => mockCountingSave(...args)}));
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
    if (path === '/menus/kitchen-partner-orders') return {data: {success: true, data: {date: config.params.date, orders: [], counts: [], orderCount: 0, totalQuantity: 0}}};
    if (path.startsWith('/menus?')) return { data: { success: true, data: [{ _id: 'menu', title: 'Fixture', startDate: A, endDate: B }] } };
    if (path.endsWith('/kitchen-components')) return { data: { success: true, data: [] } };
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

test('a kitchen date chip records its unsaved selection with no automatic-load edit', async () => {
  localStorage.setItem('token', 'fixture-session'); window.history.replaceState({}, '', '/kitchen-counting');
  const previousFetch = window.fetch, warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const capture = jest.fn().mockResolvedValue({ ok: true, status: 202, headers: { get: () => null }, json: async () => ({ success: true }) }); window.fetch = capture;
  const cleanup = installActivityCapture();
  try {
    const chip = container.querySelector('[aria-label="Delivery dates"] button'); expect(chip).toBeTruthy();
    await act(async () => chip.click()); await act(async () => window.dispatchEvent(new Event('pagehide')));
    const events = capture.mock.calls.flatMap(([, options]) => JSON.parse(options.body).events);
    expect(events).toHaveLength(1);
    expect(events[0].changes[0]).toEqual({ field: 'Delivery date', before: '', after: A, redacted: false });
    expect(events[0].stage).toBe('form_edited');
  } finally { cleanup(); window.fetch = previousFetch; localStorage.clear(); warn.mockRestore(); }
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


test('Partner order is inline below cook groups and included in the main Excel export', async () => {
  const originalGet = api.get.getMockImplementation();
  const item = {itemId: 'partner-meal', name: 'Partner Bowl', mealType: 'bowl', quantity: 7};
  api.get.mockImplementation(async (path, config) => path === '/menus/kitchen-partner-orders'
    ? {data: {success: true, data: {date: config.params.date, orders: [{id: 'po', lines: [item]}], counts: [item], orderCount: 1, totalQuantity: 7}}}
    : originalGet(path, config));
  await select(1, A);
  await act(async () => pending[A]({data: {success: true, data: [{email: entry.email}]}}));
  const section = container.querySelector('[aria-label="Partner order"]');
  expect(section.textContent).toContain('Partner Bowl');
  expect(section.closest('details')).toBeNull();
  expect(container.querySelector('.kitchen-count-groups').compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent.includes('Export Excel')).click());
  expect(mockCountingSave).toHaveBeenCalledWith(expect.anything(), `kitchen-counting-${A}.xlsx`);
  expect(mockCountingRows.mock.calls.at(-1)[0].at(-1)).toMatchObject({Category: 'Partner order', 'Meal Name': 'Partner Bowl', Count: 7, 'Total Protein Weight (g)': ''});
  api.get.mockImplementation(async (path, config) => {if (path === '/menus/kitchen-partner-orders') throw new Error('Partner feed failed'); return originalGet(path, config);});
  const saved = mockCountingSave.mock.calls.length;
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent.includes('Export Excel')).click());
  expect(mockCountingSave).toHaveBeenCalledTimes(saved);
  expect(container.textContent).toContain('Partner feed failed');
});


test('component names appear beside their summed weights and in the Excel breakdown', async () => {
  const originalGet = api.get.getMockImplementation();
  api.get.mockImplementation(async (path, config) => path.endsWith('/kitchen-components')
    ? { data: { success: true, data: [{ _id: 'recipe', mealType: 'main', mealName: 'Fixture meal', cycleMeal: { components: [
      { type: 'Protein', name: 'Chicken portion' }, { type: 'Carb', name: 'Saffron rice' }, { type: 'Vegetable', name: 'Green beans' },
    ] } }] } } : originalGet(path, config));
  await select(1, A);
  await act(async () => pending[A]({ data: { success: true, data: [{ email: entry.email }] } }));
  const parts = [...container.querySelectorAll('.kitchen-count-component')];
  expect(parts.map(part => part.querySelector('span').textContent)).toEqual(['Chicken portion', 'Saffron rice', 'Green beans']);
  expect(parts.every(part => /^\d[\d,]* g$/.test(part.querySelector('b').textContent))).toBe(true);
  await act(async () => exportButton().click());
  const exported = mockCountingRows.mock.calls.at(-1)[0][0];
  expect(exported['Protein Components']).toBe(`Chicken portion: ${exported['Total Protein Weight (g)']} g`);
  expect(exported['Carb Components']).toBe(`Saffron rice: ${exported['Total Carb Weight (g)']} g`);
});

test('saved PCS changes refresh without preparation and match both Excel downloads', async () => {
  const originalGet = api.get.getMockImplementation();
  let settings = { qtyUnit: 'KG' };
  let refresh;
  api.get.mockImplementation(async (path, config) => path.endsWith('/kitchen-components')
    ? refresh ? await refresh : { data: { success: true, data: [{ _id: 'recipe', mealType: 'main', mealName: 'Fixture meal',
      proteinSource: 'Patty', cycleMeal: settings }] } } : originalGet(path, config));
  await select(1, A);
  await act(async () => pending[A]({ data: { success: true, data: [{ email: entry.email }] } }));
  const preparationCalls = api.post.mock.calls.length;
  const cookingButton = () => [...container.querySelectorAll('button')].find(item => item.textContent.includes('Cooking & EOD Excel'));
  let rejectRefresh;
  refresh = new Promise((resolve, reject) => { rejectRefresh = reject; });
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(exportButton().disabled).toBe(true);
  expect(cookingButton().disabled).toBe(true);
  expect(container.querySelector('[aria-label="Download customers for Fixture meal"]').disabled).toBe(true);
  expect(container.querySelector('.kitchen-count-component')).toBeNull();
  await act(async () => { rejectRefresh(new Error('Unavailable')); });
  expect(exportButton().disabled).toBe(true);
  expect(cookingButton().disabled).toBe(true);
  refresh = undefined;
  settings = { qtyUnit: 'PCS', gramsPerPiece: 50 };
  await act(async () => mockSocketHandlers.get('kitchen:mealLibraryChanged')());
  expect(exportButton().disabled).toBe(false);
  expect(cookingButton().disabled).toBe(false);
  expect(container.querySelector('[aria-label="Download customers for Fixture meal"]').disabled).toBe(false);
  const pieceLabel = container.querySelector('.kitchen-count-component b').textContent;
  expect(pieceLabel).toMatch(/^\d+ PCS$/);
  await act(async () => exportButton().click());
  const standard = mockCountingRows.mock.calls.at(-1)[0][0];
  const expected = Math.ceil(standard['Total Protein Weight (g)'] * 1.05 / 50);
  expect(pieceLabel).toBe(`${expected} PCS`);
  expect(standard['Protein Components']).toBe(`Patty: ${expected} PCS`);
  const button = [...container.querySelectorAll('button')].find(item => item.textContent.includes('Cooking & EOD Excel'));
  await act(async () => button.click());
  const sheet = mockCookingSave.mock.calls.at(-1)[0].Sheets['Cooking & EOD'];
  expect(sheet.B8.v).toBe(expected);
  expect(sheet.E8.v).toBe('PCS');
  expect(api.post.mock.calls).toHaveLength(preparationCalls);
});

test('both exports read current quantities even if no focus or socket event arrived', async () => {
  const originalGet = api.get.getMockImplementation();
  let gramsPerPiece = 50;
  api.get.mockImplementation(async (path, config) => path.endsWith('/kitchen-components')
    ? { data: { success: true, data: [{ _id: 'recipe', mealType: 'main', mealName: 'Fixture meal',
      proteinSource: 'Patty', cycleMeal: { qtyUnit: 'PCS', gramsPerPiece } }] } } : originalGet(path, config));
  await select(1, A);
  await act(async () => pending[A]({ data: { success: true, data: [{ email: entry.email }] } }));
  gramsPerPiece = 100;
  await act(async () => exportButton().click());
  const standard = mockCountingRows.mock.calls.at(-1)[0][0];
  const grams = standard['Total Protein Weight (g)'];
  expect(standard['Protein Components']).toBe(`Patty: ${Math.ceil(grams * 1.05 / 100)} PCS`);

  gramsPerPiece = 150;
  const cookingButton = [...container.querySelectorAll('button')].find(button => button.textContent.includes('Cooking & EOD Excel'));
  await act(async () => cookingButton.click());
  const sheet = mockCookingSave.mock.calls.at(-1)[0].Sheets['Cooking & EOD'];
  const pieces = Math.ceil(grams * 1.05 / 150);
  expect(sheet.B8.v).toBe(pieces);
  expect(container.querySelector('.kitchen-count-component b').textContent).toBe(`${pieces} PCS`);
});

test('a settings change during a download reports a retry and does not write stale counts', async () => {
  await select(1, A);
  await act(async () => pending[A]({ data: { success: true, data: [{ email: entry.email }] } }));
  const originalGet = api.get.getMockImplementation();
  let finishOrders;
  api.get.mockImplementation((path, config) => path === '/menus/kitchen-partner-orders'
    ? new Promise(resolve => { finishOrders = () => resolve(originalGet(path, config)); })
    : originalGet(path, config));
  await act(async () => exportButton().click());
  await act(async () => mockSocketHandlers.get('kitchen:mealLibraryChanged')());
  await act(async () => finishOrders());
  expect(mockCountingSave).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Component settings could not be verified for this download. Please try again.');
});

test('a component-label request failure does not remove verified counts', async () => {
  const originalGet = api.get.getMockImplementation();
  api.get.mockImplementation(async (path, config) => {
    if (path.endsWith('/kitchen-components')) throw new Error('Recipe labels unavailable');
    if (path.endsWith('/selections')) return { data: { success: true, data: [{
      ...entry, selectedMeals: [
        { ...entry.selectedMeals[0], menuItemId: 'recipe', slotNumber: 1 },
        { ...entry.selectedMeals[0], slotNumber: 2 },
      ],
    }] } };
    return originalGet(path, config);
  });
  await select(1, A);
  await act(async () => pending[A]({ data: { success: true, data: [{ email: entry.email }] } }));
  expect(container.textContent).toContain('2 main meal(s) total');
  expect(container.textContent).toContain('Component settings could not be loaded');
  expect(exportButton().disabled).toBe(true);
  const checklists = container.querySelectorAll('[aria-label="Download customers for Fixture meal"]');
  expect(checklists).toHaveLength(1);
  const [checklist] = checklists;
  expect(checklist.disabled).toBe(false);
  await act(async () => checklist.click());
  expect(mockCountingRows.mock.calls.at(-1)[0]).toEqual(Array.from({ length: 2 }, () => expect.objectContaining({ Email: entry.email })));
});

test('focus during preparation refreshes quantity before either export becomes available', async () => {
  const originalGet = api.get.getMockImplementation();
  let refresh, finish;
  const catalog = settings => ({ data: { success: true, data: [{
    _id: 'recipe', mealType: 'main', mealName: 'Fixture meal', proteinSource: 'Patty', cycleMeal: settings,
  }] } });
  api.get.mockImplementation(async (path, config) => path.endsWith('/kitchen-components')
    ? refresh || catalog({ qtyUnit: 'KG' }) : originalGet(path, config));
  await select(1, A);
  expect(pending[A]).toBeDefined();
  refresh = new Promise(resolve => { finish = resolve; });
  await act(async () => window.dispatchEvent(new Event('focus')));
  await act(async () => pending[A]({ data: { success: true, data: [{ email: entry.email }] } }));
  const cookingButton = () => [...container.querySelectorAll('button')].find(button => button.textContent.includes('Cooking & EOD Excel'));
  expect(exportButton().disabled).toBe(true);
  expect(cookingButton().disabled).toBe(true);
  await act(async () => finish(catalog({ qtyUnit: 'PCS', gramsPerPiece: 50 })));
  expect(container.querySelector('.kitchen-count-component b').textContent).toMatch(/PCS$/);
  expect(exportButton().disabled).toBe(false);
  expect(cookingButton().disabled).toBe(false);
});

test('Cooking & EOD is a separate download with buffered kg and blank staff fields', async () => {
  const originalGet = api.get.getMockImplementation();
  api.get.mockImplementation(async (path, config) => path.endsWith('/kitchen-components') ? { data: { success: true, data: [{
    _id: 'recipe', mealName: 'Fixture meal', mealType: 'main', proteinSource: 'Chicken', carbs: 'Rice', veg: 'Carrot', sauce: 'BBQ sauce', garnish: 'Parsley',
  }] } } : originalGet(path, config));
  await select(1, A);
  await act(async () => pending[A]({ data: { success: true, data: [{ email: entry.email }] } }));
  const button = [...container.querySelectorAll('button')].find(item => item.textContent.includes('Cooking & EOD Excel'));
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(mockCookingSave).toHaveBeenCalledWith(expect.anything(), `cooking-and-eod-${A}.xlsx`);
  const wb = mockCookingSave.mock.calls.at(-1)[0], ws = wb.Sheets['Cooking & EOD'];
  expect(ws.B2.v).toBe(0.05); expect(ws.E8.v).toBe('KG'); expect(ws.B8.f).toContain('*(1+$B$2)');
  expect(ws.C8.v).toBe(''); expect(ws.D8.v).toBe('');
  expect(ws.E11.v).toBe('PCS'); expect(ws.B11.v).toBe(1);
  expect(mockCountingSave).not.toHaveBeenCalled();
  expect(api.post.mock.calls.every(([url]) => !/selections|meal-edits/.test(url))).toBe(true);
});

test.each([false, true])('a day with only partner rows can use the main Excel download (settings unavailable=%s)', async settingsUnavailable => {
  const originalGet = api.get.getMockImplementation();
  const item = {itemId: 'po', name: 'Partner-only bowl', mealType: 'bowl', quantity: 3};
  api.get.mockImplementation(async (path, config) => {
    if (settingsUnavailable && path.endsWith('/kitchen-components')) throw new Error('Unavailable');
    if (path.endsWith('/selections')) return {data: {success: true, data: []}};
    if (path === '/menus/kitchen-partner-orders') return {data: {success: true, data: {date: config.params.date, orders: [{id: 'po', lines: [item]}], counts: [item], orderCount: 1, totalQuantity: 3}}};
    return originalGet(path, config);
  });
  await select(1, A);
  await act(async () => pending[A]({data: {success: true, data: []}}));
  const button = [...container.querySelectorAll('button')].find(button => button.textContent.includes('Export Excel'));
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(mockCountingRows.mock.calls.at(-1)[0]).toEqual([expect.objectContaining({Category: 'Partner order', Count: 3})]);
});

test('a date change while partner export verification is pending cannot download the old date', async () => {
  await select(1, A);
  await act(async () => pending[A]({data: {success: true, data: [{email: entry.email}]}}));
  const originalGet = api.get.getMockImplementation();
  let resolvePartner;
  api.get.mockImplementation((path, config) => path === '/menus/kitchen-partner-orders' && config.params.date === A
    ? new Promise(resolve => {resolvePartner = resolve;}) : originalGet(path, config));
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent.includes('Export Excel')).click());
  await select(1, B);
  await act(async () => resolvePartner({data: {success: true, data: {date: A, orders: [], counts: [], orderCount: 0, totalQuantity: 0}}}));
  expect(mockCountingSave).not.toHaveBeenCalled();
});


test.each([false, true])('independent partner dates outside customer menus stay visible and exportable (no menus=%s)', async noMenus => {
  const outside = '2026-11-17';
  const item = {itemId: 'po', name: 'Outside-menu bowl', mealType: 'bowl', quantity: 4};
  const originalGet = api.get.getMockImplementation();
  api.get.mockImplementation(async (path, config) => {
    if (path.startsWith('/menus?') && noMenus) return {data: {success: true, data: []}};
    if (path === '/menus/kitchen-partner-orders') return {data: {success: true, data: {date: config.params.date, orders: [{id: 'po', lines: [item]}], counts: [item], orderCount: 1, totalQuantity: 4}}};
    return originalGet(path, config);
  });
  if (noMenus) {await act(async () => root.unmount()); root = createRoot(container); await act(async () => root.render(<KitchenCounting />));}
  const writes = api.post.mock.calls.length;
  await act(async () => {
    const field = container.querySelector('[aria-label="Partner-only delivery date"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, outside);
    field.dispatchEvent(new Event('change', {bubbles: true}));
  });
  expect(container.querySelector('[aria-label="Partner order"]').textContent).toContain('Outside-menu bowl');
  expect(container.querySelector('.kitchen-count-groups')).toBeNull();
  const button = [...container.querySelectorAll('button')].find(button => button.textContent.includes('Export Excel'));
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(mockCountingSave).toHaveBeenCalledWith(expect.anything(), `kitchen-counting-${outside}.xlsx`);
  expect(mockCountingRows.mock.calls.at(-1)[0]).toEqual([expect.objectContaining({Category: 'Partner order', Count: 4})]);
  expect(api.post).toHaveBeenCalledTimes(writes);
});
