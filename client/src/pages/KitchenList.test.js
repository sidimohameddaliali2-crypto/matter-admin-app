import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { TextDecoder, TextEncoder } from 'util';
import api from '../utils/api';
import KitchenList from './KitchenList';
import { installActivityCapture } from '../utils/activityCapture';

jest.mock('../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), put: jest.fn() } }));
jest.mock('../lib/kitchenDayScope', () => ({ ...jest.requireActual('../lib/kitchenDayScope'), kitchenToday: () => '2026-10-22' }));
global.IS_REACT_ACT_ENVIRONMENT = true;
global.TextEncoder ??= TextEncoder;
global.TextDecoder ??= TextDecoder;

const mockPdfSave = jest.fn();
const mockPdfText = jest.fn();
const mockPdfTable = jest.fn();
const mockPdfBytes = jest.fn();
const mockExcelSave = jest.fn();
const mockExcelRows = jest.fn((rows) => rows);
let mockUseRealPdf = false;
jest.mock('jspdf', () => ({ __esModule: true, default: function FixturePDF() {
  if (mockUseRealPdf) {
    const { jsPDF } = jest.requireActual('jspdf');
    const doc = new jsPDF();
    doc.save = filename => { mockPdfSave(filename); mockPdfBytes(doc.output()); };
    return doc;
  }
  const doc = { internal: { pageSize: { getWidth: () => 210, getHeight: () => 297 } },
    splitTextToSize: (text) => [String(text)], getTextWidth: () => 20, getNumberOfPages: () => 1,
    save: (...args) => mockPdfSave(...args),
  };
  ['addPage', 'rect', 'roundedRect', 'setFillColor', 'setFont', 'setFontSize', 'setPage', 'setTextColor', 'text'].forEach((key) => { doc[key] = () => {}; });
  doc.text = (...args) => mockPdfText(...args);
  return doc;
} }));
jest.mock('jspdf-autotable', () => ({ __esModule: true, default: (doc, options) => {
  mockPdfTable(options);
  if (mockUseRealPdf) jest.requireActual('jspdf-autotable').autoTable(doc, options);
  else doc.lastAutoTable = { finalY: 140 };
} }));
jest.mock('xlsx', () => ({ utils: { ...jest.requireActual('xlsx').utils, json_to_sheet: rows => mockExcelRows(rows) },
  writeFile: (...args) => mockExcelSave(...args) }));


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

test('Kitchen List shows the three fallback snacks and the condition for using them', async () => {
  await select(dateSelect(), friday);
  const fallback = container.querySelector('[aria-label="Fallback snacks"]');
  expect([...fallback.querySelectorAll('li > span')].map(label => label.textContent))
    .toEqual(['CRACKER BLISS BALL', 'CHOCO PEANUT BUTTER TRUFFLE', 'CHEESECAKE BITES']);
  expect(fallback.textContent).toContain('both daily snack pools conflict');
  expect(fallback.textContent).toContain('CRACKER BLISS BALL (W/ SOY)');
  expect(fallback.textContent).toContain('Needs a verified Meal Library recipe');
});

test.each(['selection-open', 'allergy-review'])('%s shows the conflicting saved choice without starting assignment', async state => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(Date.parse(state === 'selection-open' ? '2026-10-01T00:00:00Z' : '2026-10-24T00:00:00Z'));
  const originalGet = api.get.getMockImplementation();
  const writes = api.post.mock.calls.length;
  api.get.mockImplementation(async (path, options) => path.endsWith('/kitchen-state') ? { data: {
    state, data: { success: true, preparation: state, data: {
      kitchenSelections: [{ email, matterCustomerId: 'permanent', selectedMeals: [{ date: friday, mealType: 'main', mealName: 'Customer chosen beef' }] }],
      kitchenAllergyReview: 'Customer chosen beef conflicts with recorded allergies.',
      kitchenInputs: [input()], rosterComplete: true, kitchenRoster: [{ customer_id: 'permanent', email, subscription_id: 'matter-current', meal_frequency: 1 }],
    } },
  } } : originalGet(path, options));
  try {
    await select(dateSelect(), friday);
    expect(container.textContent).toContain('Customer chosen beef');
    if (state === 'selection-open') expect(container.textContent).toContain('Customer selection is still open until');
    expect([...container.querySelectorAll('[role="alert"]')].some(alert => alert.textContent === 'Customer chosen beef conflicts with recorded allergies.')).toBe(true);
    expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Auto-Assign')).toBe(false);
    expect(api.post).toHaveBeenCalledTimes(writes);
  } finally { now.mockRestore(); }
});

test('meal confirmations require a note and unlock day exports only after all cases are logged', async () => {
  const originalGet = api.get.getMockImplementation();
  const cases = ['Peanut chicken', 'Peanut beef'].map((mealName, index) => ({
    mealName, mealId: `meal-${index}`, fingerprint: `review-${index}`, recordId: 'selection',
    date: friday, customerId: 'permanent', subscriptionId: 'matter-current',
    canConfirm: true, message: `${mealName} conflicts with Peanuts`, conflicts: ['Peanuts'], confirmation: null,
  }));
  api.get.mockImplementation(async (path, options) => path.endsWith('/kitchen-state') ? { data: {
    state: 'allergy-review', data: { success: true, preparation: 'allergy-review', data: {
      kitchenSelections: [{ _id: 'selection', email, matterCustomerId: 'permanent',
        selectedMeals: cases.map(item => ({ _id: item.mealId, date: friday, mealType: 'main', mealName: item.mealName, kitchenAllergyCases: [item] })) }],
      kitchenAllergyReview: 'Two meal reviews needed.', kitchenAllergyCases: cases,
      kitchenInputs: [input()], rosterComplete: true, kitchenRoster: [{ customer_id: 'permanent', email, subscription_id: 'matter-current', meal_frequency: 1 }],
    } },
  } } : originalGet(path, options));
  await select(dateSelect(), friday);
  await select(paperSelect(), friday);
  const dayPdf = () => [...container.querySelectorAll('button')].find(button => button.textContent.includes('Download Day PDF'));
  expect(dayPdf().disabled).toBe(true);
  expect(container.textContent).toContain('2 remaining');

  for (const item of cases) {
    const meal = [...container.querySelectorAll('.kitchen-meal')].find(element => element.textContent.includes(item.mealName));
    await act(async () => [...meal.querySelectorAll('button')].find(button => button.textContent === 'Confirm allergy review').click());
    const submit = [...meal.querySelectorAll('button')].find(button => button.textContent === 'Confirm and log');
    expect(submit.disabled).toBe(true);
    const note = 'Use the verified peanut-free preparation.';
    await act(async () => {
      const field = meal.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, note);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    api.post.mockResolvedValueOnce({ data: { success: true, data: { actorName: 'Kitchen Lead', at: '2026-10-23T08:00:00Z', note } } });
    await act(async () => submit.click());
    expect(api.post).toHaveBeenLastCalledWith('/menus/menu/kitchen-customers/permanent/allergy-confirmations', {
      recordId: 'selection', mealId: item.mealId, date: friday, subscriptionId: 'matter-current', fingerprint: item.fingerprint, note,
    });
    expect(meal.textContent).toContain('confirmed by Kitchen Lead');
    if (item === cases[0]) {
      expect(container.textContent).toContain('1 remaining');
      expect(dayPdf().disabled).toBe(true);
    }
  }
  expect(dayPdf().disabled).toBe(false);
});

test.each(['main', 'snack'])('open-date %s-only partial selection stays in Missing without assigning or hiding saved choices', async mealType => {
  const originalGet = api.get.getMockImplementation();
  const writes = api.post.mock.calls.length;
  api.get.mockImplementation(async (path, options) => path.endsWith('/kitchen-state') ? { data: {
    state: 'selection-open', data: { success: true, preparation: 'selection-open', data: {
      kitchenSelections: [{ email, matterCustomerId: 'permanent', selectedMeals: [{ date: friday, mealType, mealName: 'Saved partial choice' }] }],
      kitchenInputs: [{ ...input(), meal_frequency: 2 }], rosterComplete: true,
      kitchenRoster: [{ customer_id: 'permanent', email, subscription_id: 'matter-current', meal_frequency: 2 }],
    } },
  } } : originalGet(path, options));
  await select(dateSelect(), friday);
  const filter = container.querySelector('[aria-label="Customer status filter"]');
  await act(async () => [...filter.querySelectorAll('button')].find(button => button.textContent === 'Missing').click());
  expect(container.querySelector('.kitchen-customer h2').textContent).toBe('Matter Fixture');
  expect(container.textContent).toContain('Incomplete Meal Selection');
  expect(container.textContent).toContain(`${mealType === 'main' ? 1 : 0} of 2 meal portion(s) selected.`);
  expect(container.textContent).toContain('Saved partial choice');
  expect(api.post).toHaveBeenCalledTimes(writes);
});

beforeEach(async () => {
  if (!URL.createObjectURL) URL.createObjectURL = jest.fn(() => 'blob:fixture');
  if (!URL.revokeObjectURL) URL.revokeObjectURL = jest.fn();
  localStorage.clear();
  mockExcelRows.mockImplementation((rows) => rows);
  api.get.mockImplementation(async (path, config) => {
    if (path === '/menus/kitchen-fallback-snacks') return { data: { success: true, data: [
      { name: 'CRACKER BLISS BALL', mealName: 'CRACKER BLISS BALL (W/ SOY)' },
    ] } };
    if (path === '/menus/kitchen-partner-orders') return {data: {success: true, data: {date: config.params.date, orders: [], counts: [], orderCount: 0, totalQuantity: 0}}};
    if (path.startsWith('/menus?')) return { data: { success: true, data: [{ _id: 'menu', title: 'Fixture', isActive: true, isPublished: true, startDate: thursday, endDate: friday }, { _id: 'old-menu', title: 'Old menu', isActive: false, isPublished: true, startDate: thursday, endDate: friday }] } };
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

test.each(['rejected request','unsuccessful response'])('failed protein correction restores the saved display (%s)', async outcome => {
  await select(dateSelect(), friday);
  const protein=()=>container.querySelector('.kitchen-meal-protein select');
  const prior=protein().value;
  if(outcome==='rejected request')api.put.mockRejectedValueOnce({response:{data:{message:'Correction rejected'}}});
  else api.put.mockResolvedValueOnce({data:{success:false,message:'Correction rejected'}});
  await select(protein(),'fish');
  expect(api.put).toHaveBeenCalledTimes(1);
  expect(protein().value).toBe(prior);
  expect(protein().disabled).toBe(false);
  expect(container.textContent).toContain('Correction rejected');
});

test('protein correction commits only after acceptance, serializes whole-record saves and can be cleared', async () => {
  await select(dateSelect(), friday);
  let release;
  api.put.mockImplementationOnce((url,body)=>new Promise(resolve=>{release=()=>resolve({data:{success:true,record:{selectedMeals:body.selections}}});}));
  const protein=()=>container.querySelector('.kitchen-meal-protein select');
  await select(protein(),'fish');
  expect(protein().value).toBe('');expect(protein().disabled).toBe(true);
  expect(container.textContent).toContain('Saving...');
  expect(api.put.mock.calls[0][1].selections).toHaveLength(2);
  await act(async()=>release());
  expect(protein().value).toBe('fish');expect(protein().disabled).toBe(false);
  api.put.mockImplementationOnce(async(url,body)=>({data:{success:true,record:{selectedMeals:body.selections}}}));
  await select(protein(),'');
  expect(protein().value).toBe('');
  expect(api.put.mock.calls[1][1].selections.find(row=>row.date===friday).manualProteinType).toBe('');
});

test('saving one correction preserves another generic dish classification, weights and prepared export with ID-only responses', async () => {
  const source=[
    {date:friday,mealType:'main',mealName:'House Special',menuItemId:{_id:'dish-one',portionType:'chicken'}},
    {date:friday,mealType:'main',mealName:'Grandma Roast',menuItemId:{_id:'dish-two',portionType:'beef'}},
  ];
  const originalGet=api.get.getMockImplementation();
  api.get.mockImplementation(async(path,options)=>path.endsWith('/selections')
    ?{data:{success:true,data:[{email,matterCustomerId:'permanent',selectedMeals:source}]}}
    :originalGet(path,options));
  await select(dateSelect(),friday);
  const mealCard=name=>[...container.querySelectorAll('.kitchen-meal')].find(card=>card.textContent.includes(name));
  expect(mealCard('Grandma Roast').textContent).toContain('Detected type: Beef');
  const weights=mealCard('Grandma Roast').querySelector('.kitchen-meal-weights').textContent;
  const macros=mealCard('Grandma Roast').querySelector('.kitchen-meal-macros').textContent;
  await act(async()=>downloadButton('Download Day Excel').click());
  const exportBefore=mockExcelRows.mock.calls.at(-1)[0].find(row=>row.Meal==='Grandma Roast');
  expect(exportBefore).toBeDefined();
  const exportsBefore=mockExcelRows.mock.calls.length;
  // The real PUT returns IDs; use a different order to prevent index-based merging.
  api.put.mockImplementationOnce(async(url,body)=>({data:{success:true,record:{selectedMeals:[...body.selections].reverse()}}}));
  await select(mealCard('House Special').querySelector('.kitchen-meal-protein select'),'chicken');
  expect(mealCard('House Special').querySelector('.kitchen-meal-protein select').value).toBe('chicken');
  expect(mealCard('Grandma Roast').textContent).toContain('Detected type: Beef');
  expect(mealCard('Grandma Roast').querySelector('.kitchen-meal-weights').textContent).toBe(weights);
  expect(mealCard('Grandma Roast').querySelector('.kitchen-meal-macros').textContent).toBe(macros);
  await act(async()=>downloadButton('Download Day Excel').click());
  expect(mockExcelRows).toHaveBeenCalledTimes(exportsBefore+1);
  expect(mockExcelRows.mock.calls.at(-1)[0].find(row=>row.Meal==='Grandma Roast')).toEqual(exportBefore);
});

test('Kitchen List automatically uses only the active menu and locks the selector', () => {
  const menu = container.querySelector('#kitchen-list-menu');
  expect(menu.value).toBe('menu');
  expect(menu.disabled).toBe(true);
  expect([...menu.options].map(option => option.value)).toEqual(['', 'menu']);
  expect(container.textContent).toContain('active menu is selected automatically and locked');
  expect(container.textContent).not.toContain('Use active menu & today automatically');
  expect(container.querySelector('#kitchen-header-date').disabled).toBe(false);
});

test('manual check and assignment buttons are removed while loading still prepares automatically', () => {
  const buttons = [...container.querySelectorAll('button')].map(button => button.textContent.trim());
  expect(buttons).not.toContain('Check Missing Selections');
  expect(buttons).not.toContain('Auto-Assign');
  expect(api.post.mock.calls.some(([path]) => path.endsWith('/auto-populate-missing'))).toBe(true);
  expect(api.post.mock.calls.some(([path]) => /\/assign-(main-meals|snacks|matter-core-meals)$/.test(path))).toBe(false);
  expect(container.textContent).toContain('Matter Fixture');
});

test('Refresh requests fresh preparation when a ready snapshot exists, keeping saved choices visible', async () => {
  const originalGet = api.get.getMockImplementation();
  api.get.mockImplementation(async (path, config) => path.endsWith('/kitchen-state')
    ? { data: { state: 'ready', data: { success: true, preparation: 'completed', data: {} } } } : originalGet(path, config));
  const originalPost = api.post.getMockImplementation();
  api.post.mockImplementation(async (path, body, config) => path.endsWith('/kitchen-state')
    ? { data: { state: 'ready', data: await originalPost(path, body, config).then(result => result.data) } } : originalPost(path, body, config));
  await act(async () => container.querySelector('button[title="Reload selections and re-fetch nutrition data from the website"]').click());
  expect(api.post).toHaveBeenCalledWith('/menus/menu/kitchen-state', { date: thursday, refresh: true }, { timeout: 30000 });
  expect(container.textContent).toContain('Matter Fixture');
});

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

test('kitchen papers mark auto-assigned portions without marking saved choices of the same dish', async () => {
  const originalGet = api.get.getMockImplementation();
  const allergyProfile = { allergiesAvailable: true, allergies: ['Peanuts'] };
  const selectedMeals = [
    { date: friday, mealType: 'main', mealName: 'Bowl & rice', isAutoAssigned: false },
    { date: friday, mealType: 'main', mealName: 'Bowl & rice', isAutoAssigned: true, quantity: 2, remark: 'veg & garnish' },
    { date: friday, mealType: 'breakfast', mealName: 'Oats & berries', isAutoAssigned: true },
    { date: friday, mealType: 'snack', mealName: 'Manual snack' },
  ];
  api.get.mockImplementation(async (path, options) => {
    if (path.endsWith('/selections')) return { data: { success: true, data: [{ email, matterCustomerId: 'permanent', selectedMeals }] } };
    if (path === '/menus/kitchen-breakfast-presets') return { data: { success: true,
      data: { presetsByName: { 'oats & berries': { C: 26, P: 24, F: 18, isLargeBreakfast: true } } } } };
    return originalGet(path, options);
  });
  api.post.mockResolvedValue({ data: { success: true, preparation: 'completed', data: {
    kitchenInputs: [{ ...input(), exclusions: ['Cabbage'], allergyProfile }], rosterComplete: true,
    kitchenRoster: [{ customer_id: 'permanent', email, subscription_id: 'matter-current', meal_frequency: 1 }],
  } } });
  await select(paperSelect(), friday);

  const xlsx = jest.requireActual('xlsx');
  mockExcelRows.mockImplementationOnce(xlsx.utils.json_to_sheet);
  await act(async () => downloadButton('Download Day Excel').click());
  expect(mockExcelSave).toHaveBeenCalledWith(expect.anything(), `kitchen-paper-${friday}.xlsx`);
  const workbook = mockExcelSave.mock.calls.at(-1)[0];
  const reopened = xlsx.read(xlsx.write(workbook, { type: 'array', bookType: 'xlsx' }), { type: 'array' }).Sheets['Kitchen Paper'];
  expect(reopened['!autofilter'].ref).toBe(reopened['!ref']);
  const rows = xlsx.utils.sheet_to_json(reopened);
  expect(rows.filter(row => row.Meal === 'Bowl & rice').map(row => row['Auto Assigned']).sort()).toEqual(['', 'Auto', 'Auto']);
  expect(rows.find(row => row.Meal === 'Oats & berries')['Auto Assigned']).toBe('Auto');
  expect(rows.find(row => row.Meal === 'Manual snack')['Auto Assigned']).toBe('');
  expect(rows[0]).toMatchObject({ Exclusions: 'Cabbage', Allergies: 'Peanuts' });

  const assertPdfDownload = async (button, filename) => {
    const tableIndex = mockPdfTable.mock.calls.length;
    const saveIndex = mockPdfSave.mock.calls.length;
    const bytesIndex = mockPdfBytes.mock.calls.length;
    await act(async () => downloadButton(button).click());
    expect(mockPdfSave.mock.calls.slice(saveIndex)).toEqual([[filename]]);
    expect(mockPdfTable.mock.calls.slice(tableIndex)).toHaveLength(1);
    const names = mockPdfTable.mock.calls[tableIndex][0].body.map(row => row[1]);
    expect(names.filter(name => name.startsWith('Bowl & rice')).sort())
      .toEqual(['Bowl & rice', 'Bowl & rice   [AUTO]\nChange veg & garnish', 'Bowl & rice   [AUTO]\nChange veg & garnish']);
    expect(names).toContain('Oats & berries   [LARGE]   [AUTO]');
    expect(names).toContain('Manual snack');
    expect(mockPdfBytes.mock.calls.slice(bytesIndex)).toHaveLength(1);
    const [pdf] = mockPdfBytes.mock.calls[bytesIndex];
    expect(pdf.startsWith('%PDF')).toBe(true);
    expect(pdf.match(/\[AUTO\]/g)).toHaveLength(3);
    expect(pdf.indexOf('Allergies: Peanuts')).toBeGreaterThan(pdf.indexOf('Exclusions: Cabbage'));
 };
  const originalCreateUrl = URL.createObjectURL;
  const createUrl = jest.fn(() => 'blob:fixture');
  URL.createObjectURL = createUrl;
  const downloads = [];
  const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { downloads.push(this.download); });
  const assertWordDownload = async (button, filename) => {
    const blobIndex = createUrl.mock.calls.length;
    const downloadIndex = downloads.length;
    await act(async () => downloadButton(button).click());
    expect(downloads.slice(downloadIndex)).toEqual([filename]);
    expect(createUrl.mock.calls.slice(blobIndex)).toHaveLength(1);
    const blob = createUrl.mock.calls[blobIndex][0];
    const html = await new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsText(blob);
    });
    const paper = new DOMParser().parseFromString(html, 'text/html');
    expect(paper.body.textContent).toMatch(/Exclusions: Cabbage\s+Allergies: Peanuts/);
    const mealCells = [...paper.querySelectorAll('tr > td:nth-child(2)')];
    const tags = (cell) => [...cell.querySelectorAll('span')].map(tag => tag.textContent.trim());
    expect(mealCells.filter(cell => cell.textContent.startsWith('Bowl & rice')).map(cell => tags(cell).join()).sort()).toEqual(['', 'AUTO', 'AUTO']);
    expect(tags(mealCells.find(cell => cell.textContent.startsWith('Oats & berries')))).toEqual(['LARGE', 'AUTO']);
    expect(tags(mealCells.find(cell => cell.textContent === 'Manual snack'))).toEqual([]);
    expect(mealCells.some(cell => cell.querySelector('b')?.textContent === 'Change veg & garnish')).toBe(true);
  };
  try {
    mockUseRealPdf = true;
    await assertPdfDownload('Download Day PDF', `kitchen-paper-${friday}.pdf`);
    await assertWordDownload('Download Day Word', `kitchen-paper-${friday}.doc`);
    const customerSelect = [...container.querySelectorAll('select')].find((element) => [...element.options].some((option) => option.textContent === 'Select a customer...'));
    await select(customerSelect, email);
    for (const label of ['From', 'To']) {
      const dateField = [...container.querySelectorAll('label')].find(element => element.textContent === label).parentElement.querySelector('select');
      await select(dateField, friday);
    }
    await assertPdfDownload('Customer PDF', `kitchen-paper-matter-fixture-${friday}.pdf`);
    await assertWordDownload('Customer Word', `kitchen-paper-matter-fixture-${friday}.doc`);
  } finally { mockUseRealPdf = false; click.mockRestore(); URL.createObjectURL = originalCreateUrl; }
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

test('custom kitchen filter choices are traced without a save', async () => {
  localStorage.setItem('token', 'fixture-session'); window.history.replaceState({}, '', '/kitchen-list');
  const previousFetch = window.fetch, warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const capture = jest.fn().mockResolvedValue({ ok: true, status: 202, headers: { get: () => null }, json: async () => ({ success: true }) }); window.fetch = capture;
  const cleanup = installActivityCapture();
  try {
    const filters = container.querySelector('[aria-label="Customer status filter"]');
    await act(async () => [...filters.querySelectorAll('button')].find(button => button.textContent === 'Missing').click());
    await act(async () => [...filters.querySelectorAll('button')].find(button => button.textContent === 'Needs attention').click());
    await act(async () => window.dispatchEvent(new Event('pagehide')));
    const events = capture.mock.calls.flatMap(([, options]) => JSON.parse(options.body).events);
    expect(events.map(event => event.changes[0])).toEqual([
      { field: 'Customer status filter', before: 'All', after: 'Missing', redacted: false },
      { field: 'Customer status filter', before: 'Missing', after: 'Needs attention', redacted: false },
    ]);
    expect(events.every(event => event.stage === 'form_edited' && !event.actor)).toBe(true);
  } finally { cleanup(); window.fetch = previousFetch; warn.mockRestore(); }
});


test('day paper appends Partner orders in Excel, PDF and Word without showing the old panel', async () => {
  const originalGet = api.get.getMockImplementation();
  const item = {itemId: 'partner-meal', name: 'Partner Bowl', mealType: 'bowl', quantity: 7};
  api.get.mockImplementation(async (path, config) => path === '/menus/kitchen-partner-orders'
    ? {data: {success: true, data: {date: config.params.date, orders: [{id: 'po', partnerName: 'Cafe Fixture', reference: 'PO-123', deliveryTime: 'Morning', notes: 'Reception', lines: [item]}], counts: [item], orderCount: 1, totalQuantity: 7}}}
    : originalGet(path, config));
  await select(paperSelect(), friday);
  expect(container.textContent).not.toContain('Partner orders for the kitchen');
  await act(async () => downloadButton('Download Day Excel').click());
  const rows = mockExcelRows.mock.calls.at(-1)[0];
  expect(rows[0]).toMatchObject({Customer: 'Matter Fixture'});
  expect(rows.at(-1)).toMatchObject({Section: 'Partner', Customer: 'Cafe Fixture', Meal: 'Partner Bowl', Quantity: 7, Order: 'PO-123'});
  await act(async () => downloadButton('Download Day PDF').click());
  expect(mockPdfText).toHaveBeenCalledWith('Partner', 14, 20);
  expect(mockPdfTable.mock.calls.at(-1)[0].body).toEqual([['Cafe Fixture', 'PO-123 / Morning', 'Bowl', 'Partner Bowl', 7, 'Reception']]);
  const priorCreate = URL.createObjectURL, priorRevoke = URL.revokeObjectURL;
  URL.createObjectURL = jest.fn(() => 'blob:fixture'); URL.revokeObjectURL = jest.fn();
  const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  try {
    await act(async () => downloadButton('Download Day Word').click());
    const blob = URL.createObjectURL.mock.calls.at(-1)[0];
    const html = await new Promise(resolve => {const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(blob);});
    expect(html).toContain('<h2>Partner</h2>');
    expect(html.indexOf('<h2>Partner</h2>')).toBeGreaterThan(html.indexOf('Matter Fixture'));
    expect(html).toContain('Partner Bowl');
  } finally {click.mockRestore(); URL.createObjectURL = priorCreate; URL.revokeObjectURL = priorRevoke;}
});

test('day paper blocks incomplete downloads when partner orders cannot be verified', async () => {
  const originalGet = api.get.getMockImplementation();
  api.get.mockImplementation(async (path, config) => {if (path === '/menus/kitchen-partner-orders') throw new Error('Partner verification failed'); return originalGet(path, config);});
  await select(paperSelect(), friday);
  await act(async () => downloadButton('Download Day Excel').click());
  expect(mockExcelSave).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Partner verification failed');
});


const choosePartnerPaperDate = async date => act(async () => {
  const field = container.querySelector('[aria-label="Partner-only paper date"]');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, date);
  field.dispatchEvent(new Event('change', {bubbles: true}));
});

test.each([false, true])('independent partner papers outside all menus support every format (no menus=%s)', async noMenus => {
  const outside = '2026-11-17';
  const item = {itemId: 'po', name: 'Outside-menu bowl', mealType: 'bowl', quantity: 4};
  const originalGet = api.get.getMockImplementation();
  api.get.mockImplementation(async (path, config) => {
    if (path.startsWith('/menus?') && noMenus) return {data: {success: true, data: []}};
    if (path === '/menus/kitchen-partner-orders') return {data: {success: true, data: {date: config.params.date, orders: [{id: 'po', partnerName: 'Cafe', reference: 'PO-5', lines: [item]}], counts: [item], orderCount: 1, totalQuantity: 4}}};
    return originalGet(path, config);
  });
  if (noMenus) {await act(async () => root.unmount()); root = createRoot(container); await act(async () => root.render(<KitchenList />));}
  const writes = api.post.mock.calls.length;
  await choosePartnerPaperDate(outside);
  expect(container.textContent).not.toContain('Outside-menu bowl');
  expect(downloadButton('Download Day Excel').disabled).toBe(false);
  await act(async () => downloadButton('Download Day Excel').click());
  expect(mockExcelSave).toHaveBeenCalledWith(expect.anything(), `kitchen-paper-${outside}.xlsx`);
  expect(mockExcelRows.mock.calls.at(-1)[0]).toHaveLength(1);
  expect(mockExcelRows.mock.calls.at(-1)[0][0]).toMatchObject({Section: 'Partner', Meal: 'Outside-menu bowl', 'Auto Assigned': '', Quantity: 4});
  await act(async () => downloadButton('Download Day PDF').click());
  expect(mockPdfSave).toHaveBeenCalledWith(`kitchen-paper-${outside}.pdf`);
  expect(mockPdfTable.mock.calls.at(-1)[0].body[0]).toContain('Outside-menu bowl');
  const priorCreate = URL.createObjectURL, priorRevoke = URL.revokeObjectURL;
  URL.createObjectURL = jest.fn(() => 'blob:fixture'); URL.revokeObjectURL = jest.fn();
  const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  try {
    await act(async () => downloadButton('Download Day Word').click());
    const blob = URL.createObjectURL.mock.calls.at(-1)[0];
    const html = await new Promise(resolve => {const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(blob);});
    expect(html).toContain('<h2>Partner</h2>'); expect(html).toContain('Outside-menu bowl');
  } finally {click.mockRestore(); URL.createObjectURL = priorCreate; URL.revokeObjectURL = priorRevoke;}
  expect(api.post).toHaveBeenCalledTimes(writes);
});

test('changing the independent partner paper date rejects an obsolete download', async () => {
  const first = '2026-11-17', second = '2026-11-18';
  let finish;
  const originalGet = api.get.getMockImplementation();
  api.get.mockImplementation((path, config) => path === '/menus/kitchen-partner-orders'
    ? new Promise(resolve => {finish = resolve;}) : originalGet(path, config));
  await choosePartnerPaperDate(first);
  await act(async () => downloadButton('Download Day Excel').click());
  await choosePartnerPaperDate(second);
  await act(async () => finish({data: {success: true, data: {date: first, orders: [], counts: [], orderCount: 0, totalQuantity: 0}}}));
  expect(mockExcelSave).not.toHaveBeenCalled();
});
