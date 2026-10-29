import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import api from '../utils/api';
import KitchenList from './KitchenList';

jest.mock('../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn(), patch: jest.fn() } }));
jest.mock('../components/PartnerKitchenOrders', () => () => null);
global.IS_REACT_ACT_ENVIRONMENT = true;

const mockPdfSave = jest.fn();
const mockExcelSave = jest.fn();
const mockExcelRows = jest.fn((rows) => rows);
jest.mock('jspdf', () => ({ __esModule: true, default: function FixturePDF() {
  const doc = { internal: { pageSize: { getWidth: () => 210, getHeight: () => 297 } },
    splitTextToSize: (text) => [String(text)], getTextWidth: () => 20, getNumberOfPages: () => 1,
    save: (...args) => mockPdfSave(...args),
  };
  ['addPage', 'rect', 'roundedRect', 'setFillColor', 'setFont', 'setFontSize', 'setPage', 'setTextColor', 'text'].forEach((key) => { doc[key] = () => {}; });
  return doc;
} }));
jest.mock('jspdf-autotable', () => ({ __esModule: true, default: (doc) => { doc.lastAutoTable = { finalY: 140 }; } }));
jest.mock('xlsx', () => ({ utils: { book_new: () => ({}), json_to_sheet: (rows) => mockExcelRows(rows), book_append_sheet: () => {} }, writeFile: (...args) => mockExcelSave(...args) }));


const thursday = '2026-10-22', friday = '2026-10-23';
const email = 'fixture@example.invalid';
let container, root;
const input = () => ({
  customer_id: 'permanent', customer_email: email, customer_name: 'Matter Fixture', subscription_id: 'matter-current',
  source_fetched_at: new Date().toISOString(), plan_name: 'Custom',
  macros: { carbohydrates: 38, protein: 32, fat: 10 }, meal_frequency: 1,
  breakfast_included: false, snacks_per_day: 0, exclusions: [],
  active_delivery_dates: [thursday, friday],
  delivery_address_resolution: { status: 'resolved', reason: 'current', address: { id: 'address' } },
});
const select = async (element, value) => {
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
};
const dateSelect = () => [...container.querySelectorAll('h3')].find((node) => node.textContent === 'Missing Meal Selections').parentElement.querySelector('select');
const paperSelect = () => [...container.querySelectorAll('label')].find((node) => node.textContent === 'Day kitchen paper').parentElement.querySelector('select');

test('open date shows customer choices and deadline, disables auto assign and makes no assignment POST', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-01T00:00:00Z'));
  const originalGet = api.get.getMockImplementation();
  const writes = api.post.mock.calls.length;
  api.get.mockImplementation(async (path, options) => path.endsWith('/kitchen-state') ? { data: {
    state: 'selection-open', data: { success: true, preparation: 'selection-open', data: {
      kitchenSelections: [{ email, matterCustomerId: 'permanent', selectedMeals: [{ date: friday, mealType: 'main', mealName: 'Customer chosen beef' }] }],
      kitchenInputs: [input()], rosterComplete: true, kitchenRoster: [{ customer_id: 'permanent', email, subscription_id: 'matter-current', meal_frequency: 1 }],
    } },
  } } : originalGet(path, options));
  try {
    await select(dateSelect(), friday);
    expect(container.textContent).toContain('Customer chosen beef');
    expect(container.textContent).toContain('Customer selection is still open until');
    expect([...container.querySelectorAll('button')].find(button => button.textContent === 'Auto-Assign').disabled).toBe(true);
    expect(api.post).toHaveBeenCalledTimes(writes);
  } finally { now.mockRestore(); }
});

beforeEach(async () => {
  localStorage.clear();
  mockExcelRows.mockImplementation((rows) => rows);
  api.get.mockImplementation(async (path) => {
    if (path.startsWith('/menus?')) return { data: { success: true, data: [{ _id: 'menu', title: 'Fixture', startDate: thursday, endDate: friday }] } };
    if (path.endsWith('/selections')) return { data: { success: true, data: [{ email, firstName: 'Internal stale name', matterCustomerId: 'permanent', mealPerDay: 9, skippedDays: [{ date: thursday, pauseStatus: 'success' }], selectedMeals: [thursday, friday].map((date) => ({ date, mealType: 'main', mealName: 'Fixture dish' })) }] } };
    if (path.includes('/matter/')) throw new Error('Duplicate Matter lookup');
    return { data: { success: true, data: {} } };
  });
  api.post.mockImplementation(async () => ({ data: { success: true, preparation: 'completed', data: { kitchenInputs: [input()], rosterComplete: true, kitchenRoster: [{ customer_id: 'permanent', email, subscription_id: 'matter-current', meal_frequency: 1 }] } } }));
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<KitchenList />));
  const menuSelect = [...container.querySelectorAll('select')].find((element) => [...element.options].some((option) => option.value === 'menu'));
  await select(menuSelect, 'menu');
  await select(dateSelect(), thursday);
});

afterEach(async () => { await act(async () => root.unmount()); container.remove(); jest.clearAllMocks(); });

test('selecting the prepared Thursday in the paper control preserves selections without reloading', async () => {
  expect(container.textContent).toContain('Matter Fixture');
  expect(container.textContent).not.toContain('Internal stale name');
  const calls = api.post.mock.calls.length;
  await select(paperSelect(), thursday);
  expect(container.textContent).toContain('Matter Fixture');
  expect(container.textContent).not.toContain('No customer selections found for this menu.');
  expect(api.post).toHaveBeenCalledTimes(calls);
  expect(api.get.mock.calls.some(([path]) => path.includes('/matter/'))).toBe(false);
});

test('customer status tabs filter the prepared view without rerunning assignments', async () => {
  const preparations = api.post.mock.calls.length;
  const filter = container.querySelector('[aria-label="Customer status filter"]');
  const tabs = [...filter.querySelectorAll('button')];
  await act(async () => tabs.find(button => button.textContent === 'Missing').click());
  expect(tabs.find(button => button.textContent === 'Missing').getAttribute('aria-pressed')).toBe('true');
  expect(container.textContent).toContain('No customers match the current filters.');
  await act(async () => tabs.find(button => button.textContent === 'All').click());
  expect(container.querySelector('.kitchen-customer h2').textContent).toBe('Matter Fixture');
  expect(api.post).toHaveBeenCalledTimes(preparations);
});

test('changing either date control keeps both synchronized and prepares the new date', async () => {
  await select(paperSelect(), friday);
  expect(dateSelect().value).toBe(friday);
  expect(paperSelect().value).toBe(friday);
  expect(api.post.mock.calls.at(-1)[1]).toEqual({ date: friday, freshInputs: true });
  expect(container.textContent).toContain('Matter Fixture');
  await select(dateSelect(), thursday);
  expect(paperSelect().value).toBe(thursday);
});


const downloadButton = (text) => [...container.querySelectorAll('button')].find((button) => button.textContent.includes(text));

test('a failed preparation is an error, not an empty selection, and refresh recovers', async () => {
  const successful = api.post.getMockImplementation();
  api.post.mockRejectedValueOnce(new Error('Preparation unavailable'));
  await select(paperSelect(), friday);
  expect(container.textContent).toContain('Preparation unavailable');
  expect(container.textContent).not.toContain('No customer selections found for this menu.');
  expect(downloadButton('Download Day Excel').disabled).toBe(true);
  api.post.mockImplementation(successful);
  await act(async () => container.querySelector('button[title="Reload selections and re-fetch nutrition data from the website"]').click());
  expect(container.textContent).toContain('Matter Fixture');
  expect(container.textContent).not.toContain('Preparation unavailable');
});

test('late menu options cannot overwrite the currently selected date', async () => {
  const originalGet = api.get.getMockImplementation();
  let finishOld;
  let optionCalls = 0;
  api.get.mockImplementation(async (path, options) => {
    if (path.endsWith('/main-meal-options')) {
      optionCalls += 1;
      if (optionCalls === 1) return new Promise((resolve) => { finishOld = resolve; });
      return { data: { success: true, data: { [thursday]: { mainMeals: [{ name: 'Current rotation', type: 'chicken' }], subMeals: [] } } } };
    }
    return originalGet(path, options);
  });
  await select(paperSelect(), friday);
  await select(paperSelect(), thursday);
  await act(async () => finishOld({ data: { success: true, data: { [thursday]: { mainMeals: [{ name: 'Stale rotation', type: 'chicken' }], subMeals: [] } } } }));
  expect(container.textContent).toContain('Current rotation');
  expect(container.textContent).not.toContain('Stale rotation');
});

test('a failed download shows its error near the controls and can be retried to generate Word', async () => {
  const originalBlob = global.Blob, originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
  let html, filename;
  global.Blob = class FixtureBlob { constructor(parts) { html = parts.join(''); } };
  URL.createObjectURL = jest.fn().mockImplementationOnce(() => { throw new Error('Temporary download failure'); }).mockReturnValue('blob:fixture'); URL.revokeObjectURL = jest.fn();
  const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { filename = this.download; });
  jest.useFakeTimers();
  try {
    const preparations = api.post.mock.calls.length;
    await act(async () => downloadButton('Download Day Word').click());
    expect(container.textContent).toContain('Temporary download failure');
    expect(downloadButton('Download Day Word').disabled).toBe(false);
    expect(click).not.toHaveBeenCalled();
    await act(async () => downloadButton('Download Day Word').click());
    expect(filename).toBe(`kitchen-paper-${thursday}.doc`);
    expect(api.post).toHaveBeenCalledTimes(preparations);
    expect(html).toContain('Matter Fixture');
    expect(html).not.toMatch(/Formula:|Nutrition checked:|<th>Remark<\/th>|Portion capped/);
    expect(container.textContent).not.toContain('Temporary download failure');
    jest.runOnlyPendingTimers();
  } finally { click.mockRestore(); global.Blob = originalBlob; URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; jest.useRealTimers(); }
});

test('PDF and Excel buttons generate files after Matter verification', async () => {
  let finish;
  const saved = new Promise((resolve) => { finish = resolve; });
  mockPdfSave.mockImplementationOnce((filename) => finish(filename));
  await act(async () => { downloadButton('Download Day PDF').click(); await saved; });
  expect(mockPdfSave).toHaveBeenCalledWith(`kitchen-paper-${thursday}.pdf`);
  await act(async () => downloadButton('Download Day Excel').click());
  expect(mockExcelSave.mock.calls[0][1]).toBe(`kitchen-paper-${thursday}.xlsx`);
});

test('individual PDF includes saved choices when Matter has reactivated a previously skipped day', async () => {
  const customerSelect = [...container.querySelectorAll('select')].find((element) => [...element.options].some((option) => option.textContent === 'Select a customer...'));
  await select(customerSelect, email);
  const endSelect = [...container.querySelectorAll('label')].find((element) => element.textContent === 'To').parentElement.querySelector('select');
  await select(endSelect, thursday);
  await act(async () => downloadButton('Customer PDF').click());
  expect(mockPdfSave).toHaveBeenCalledWith(`kitchen-paper-matter-fixture-${thursday}.pdf`);
  expect(container.textContent).toContain('Downloaded 1 day(s) for Matter Fixture');
  expect(container.textContent).not.toContain('No confirmed meals for this customer');
});

test('an unavailable subscription stays on its customer while the page and verified day exports keep working', async () => {
  const expiredEmail = 'expired@example.invalid';
  const originalGet = api.get.getMockImplementation();
  api.get.mockImplementation(async (path, options) => {
    if (path.endsWith('/selections')) {
      const response = await originalGet(path, options);
      return { data: { success: true, data: [...response.data.data, {
        email: expiredEmail, matterEmail: expiredEmail, matterCustomerId: 'expired-permanent-id',
        selectedMeals: [{ date: friday, mealType: 'main', mealName: 'Expired account dish' }],
      }] } };
    }
    if (path.includes('kitchen-inputs')) {
      expect(options.params.customerId).toBe('expired-permanent-id');
      throw { response: { status: 404, data: { message: 'No current Matter subscription.' } } };
    }
    return originalGet(path, options);
  });
  await select(paperSelect(), friday);
  expect(container.textContent).toContain('Matter Fixture');
  expect(container.querySelector('.kitchen-customer-index').textContent).not.toContain(expiredEmail);
  expect(container.textContent).not.toContain('customer(s) have incomplete kitchen inputs');
  expect(container.querySelector('.kitchen-customer-index').textContent).not.toContain('Not scheduled');
  expect(container.textContent).not.toContain('Saved selection has no verified Matter customer ID.');
  expect(container.textContent).not.toContain('No customer selections found for this menu.');
  expect(downloadButton('Download Day Excel').disabled).toBe(false);
  await act(async () => downloadButton('Download Day Excel').click());
  expect(mockExcelSave).toHaveBeenCalledWith(expect.anything(), `kitchen-paper-${friday}.xlsx`);
  const exportedRows = mockExcelRows.mock.calls.at(-1)[0];
  expect(exportedRows).toHaveLength(1);
  expect(exportedRows[0]).toMatchObject({ Customer: 'Matter Fixture', Meal: 'Fixture dish' });
  expect(container.textContent).toContain('Matter Fixture');
});

test('removed setup controls stay absent and partner/paper tools are grouped under Kitchen Paper', () => {
  expect(container.querySelector('#kitchen-downloads summary').textContent).toContain('Kitchen Paper');
  for (const text of ['Preparation help', 'Upload format & assignment rules', 'Upload Weekly Menu', 'Show only missing']) expect(container.textContent).not.toContain(text);
  expect([...container.querySelectorAll('button')].some(button => button.textContent.trim() === 'Template')).toBe(false);
});

test('a failed snack edit keeps its editor open and does not report a completed save', async () => {
  const originalGet = api.get.getMockImplementation();
  api.get.mockImplementation(async (path, options) => path.endsWith('/kitchen-snack-presets')
    ? { data: { success: true, data: { presetsByName: { truffle: { snackName: 'Truffle', C: 15, P: 10, F: 6 } } } } }
    : originalGet(path, options));
  await act(async () => container.querySelector('button[title="Reload selections and re-fetch nutrition data from the website"]').click());
  await act(async () => downloadButton('Snack Macros (PCF)').click());
  const name = [...container.querySelectorAll('span')].find(node => node.textContent.trim() === 'Truffle');
  await act(async () => name.parentElement.querySelector('[title="Edit macros"]').click());
  api.patch.mockRejectedValueOnce(new Error('Storage unavailable'));
  const save = [...container.querySelectorAll('button')].find(button => button.textContent.trim() === 'Save');
  await act(async () => save.click());
  expect([...container.querySelectorAll('button')].some(button => button.textContent.trim() === 'Save')).toBe(true);
  expect([...container.querySelectorAll('input[type="number"]')].some(input => input.value === '15')).toBe(true);
});
