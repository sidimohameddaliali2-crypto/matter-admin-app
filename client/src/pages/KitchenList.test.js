import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import api from '../utils/api';
import KitchenList from './KitchenList';

jest.mock('../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
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

beforeEach(async () => {
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
  expect(container.textContent).toContain(expiredEmail);
  expect(container.textContent).toContain('Not scheduled for');
  expect(container.textContent).not.toContain('customer(s) have incomplete kitchen inputs');
  expect(container.textContent).toContain('Unavailable');
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
