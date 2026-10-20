import { calculateKitchenListEntry } from './kitchenListCalculations';
import { assertKitchenExportReady, createKitchenRequestGuard, kitchenMealWarnings, prepareKitchenSelections } from './kitchenIntegrity';
import { enrichSelectionsWithNutrition } from '../lib/kitchenData';
import { loadKitchenSnapshot, assertKitchenRosterCovered } from '../lib/kitchenSnapshot';
import { downloadCustomerPaperPdf, downloadCustomerPaperWord } from './kitchenPaperCustomer';

const date = '2026-10-20';
const meal = { date, mealType: 'main', mealName: 'Fixture', quantity: 1 };
const customer = { email: 'fixture@example.invalid', planName: 'Custom', targetMacros: { C: 38, P: 32, F: 10 } };
const calculate = (overrides = {}, meals = [meal]) => calculateKitchenListEntry({ customer: { ...customer, ...overrides }, selectedMeals: meals });

test.each([{}, { targetMacros: { C: null, P: 32, F: 10 } }, { targetMacros: { C: 0, P: 0, F: 0 } }, { targetMacros: { C: 10, P: Infinity, F: 1 } }, { planName: '' }, { nutritionStatus: 'failed' }, { nutritionUnits: 'food-weight-grams' }])('unresolved inputs never synthesize a valid production portion: %p', (input) => {
  const result = calculateKitchenListEntry({ customer: input, selectedMeals: [meal] });
  expect(result.calculationStatus).toBe('incomplete');
  expect(result.selectedMeals[0].weight).toBeNull();
  expect(() => assertKitchenExportReady([result])).toThrow('blocked');
});

test('legitimate zero carbs/fat and partner presets remain supported', () => {
  expect(calculate({ targetMacros: { C: 0, P: 50, F: 0 } }).calculationStatus).toBe('complete');
  const partner = calculate({ partner: { businessName: 'Fixture' }, planName: '', targetMacros: {} });
  expect(partner.calculationStatus).toBe('complete');
  expect(partner.selectedMeals[0].macros).toMatchObject({ C: 35, P: 30, F: 15 });
});

test.each([[25, 100], [29, 100], [30, 120], [35, 120], [36, 140], [40, 140], [45, 160], [50, 180], [55, 200], [56, 220], [58, 220], [60, 220], [61, 240], [65, 240]])('existing main-kitchen protein rule is preserved at %ig', (P, weight) => {
  expect(calculate({ targetMacros: { C: 38, P, F: 1 } }).selectedMeals[0].proteinWeight).toBe(weight);
});

test('repeated quantities produce separate portions without doubling their macro budget', () => {
  const result = calculate({}, [{ ...meal, quantity: 2 }]);
  expect(result.selectedMeals).toHaveLength(2);
  expect(result.selectedMeals.every((item) => item.quantity === 1)).toBe(true);
  expect(result.totalWeight).toBe(result.selectedMeals.reduce((sum, item) => sum + item.weight, 0));
});

test('Core units survive a successful lookup; failed/missing lookups do not fall back to ordinary food weights', async () => {
  const raw = { ...customer, selectedMeals: [meal] };
  const api = { get: jest.fn().mockResolvedValue({ data: { data: { plan_name: 'Matter Core', macros: { carbohydrates: 100, protein: 150, fat: 0 } } } }) };
  const [resolved] = await enrichSelectionsWithNutrition(api, [raw], { current: new Map() });
  expect(resolved.nutritionUnits).toBe('food-weight-grams');
  expect(calculateKitchenListEntry({ customer: resolved, selectedMeals: [meal] }).selectedMeals[0].proteinWeight).toBe(150);
  for (const get of [async () => { throw new Error('timeout'); }, async () => ({ data: { data: null } })]) {
    const [unresolved] = await enrichSelectionsWithNutrition({ get }, [raw], { current: new Map() });
    expect(calculateKitchenListEntry({ customer: unresolved, selectedMeals: [meal] }).calculationStatus).toBe('incomplete');
  }
});

test('all production output warnings remain readable after aggregation/export', () => {
  const warnings = kitchenMealWarnings({ remark: 'Review sauce', exclusionConflict: ['milk'], flags: { macroCapped: true, macroShortfall: true, matterCoreLookupMissing: true, autoUpgradedToLarge: true } });
  expect(warnings.join(' ')).toMatch(/capped/);
  expect(warnings.join(' ')).toMatch(/Daily macro target/);
  expect(warnings.join(' ')).toMatch(/Matter Core/);
  expect(warnings.join(' ')).toMatch(/milk/);
  expect(warnings.join(' ')).toMatch(/Large/);
});

test('a later request invalidates old completion and cancellation invalidates pending work', () => {
  const requests = createKitchenRequestGuard();
  const a = requests.begin(), b = requests.begin();
  expect(requests.isCurrent(a)).toBe(false);
  expect(requests.isCurrent(b)).toBe(true);
  requests.cancel();
  expect(requests.isCurrent(b)).toBe(false);
});

test('preparation failure cannot be treated as completed', async () => {
  await expect(prepareKitchenSelections({ post: async () => ({ data: { success: true } }) }, 'menu', date)).rejects.toThrow('did not complete');
});

test('a changed roster cannot hide missing customers, partial quantities or intentional skips', () => {
  const roster = [{ email: customer.email, meal_frequency: 3 }];
  expect(() => assertKitchenRosterCovered([], roster, date)).toThrow('incomplete');
  expect(() => assertKitchenRosterCovered([{ ...customer, selectedMeals: [{ ...meal, quantity: 2 }] }], roster, date)).toThrow('incomplete');
  expect(() => assertKitchenRosterCovered([{ ...customer, selectedMeals: [{ ...meal, quantity: 3 }] }], roster, date)).not.toThrow();
  expect(() => assertKitchenRosterCovered([{ ...customer, skippedDays: [{ date }], selectedMeals: [] }], roster, date)).not.toThrow();
});

test('paper snapshot waits for preparation and uses the same calculator as kitchen screens', async () => {
  const calls = [];
  const nutrition = { delivery_address_resolution: { status: 'resolved', reason: 'current', address: { id: 'fixture', emirate: 'Dubai' } }, plan_name: 'Custom', macros: { carbohydrates: 38, protein: 32, fat: 10 }, active_delivery_dates: [date] };
  const api = {
    post: async () => { calls.push('prepared'); return { data: { success: true, preparation: 'completed' } }; },
    get: async (path) => {
      calls.push(path);
      if (path.endsWith('/selections')) return { data: { success: true, data: [{ ...customer, selectedMeals: [meal] }] } };
      if (path.includes('kitchen-inputs')) return { data: { data: nutrition } };
      if (path.includes('delivery-on-date')) return { data: { success: true, data: [{ email: customer.email }] } };
      return { data: { success: true, data: {} } };
    },
  };
  const snapshot = await loadKitchenSnapshot(api, 'menu', [date]);
  expect(calls[0]).toBe('prepared');
  expect(snapshot.entries[0].selectedMeals[0]).toMatchObject({ proteinWeight: 120, carbWeight: 135, vegWeight: 80 });
  expect(snapshot.entries[0].selectedMeals[0].weight).toBe(calculate().selectedMeals[0].weight);
  expect(snapshot.entries[0].formulaVersion).toBeTruthy();
  expect(snapshot.entries[0].nutritionResolvedAt).toBeTruthy();
});

test('PDF and Word retain calculated portion quantities, warnings, date and formula provenance', async () => {
  const entry = { ...calculate({}, [{ ...meal, quantity: 2 }]), deliveryDates: [date], nutritionResolvedAt: '2026-10-20T08:00:00Z' };
  entry.selectedMeals[0].flags.macroCapped = true;
  const tables = [], texts = [];
  const doc = {
    internal: { pageSize: { getWidth: () => 210, getHeight: () => 297 } },
    splitTextToSize: (text) => [text], getTextWidth: (text) => text.length * 2,
    getNumberOfPages: () => 1, text: (text) => texts.push(String(text)), save: jest.fn(),
  };
  ['addPage', 'roundedRect', 'setFillColor', 'setFont', 'setFontSize', 'setPage', 'setTextColor'].forEach((method) => { doc[method] = () => {}; });
  const helpers = {
    getDateKey: (value) => String(value).slice(0, 10), formatDateLabel: (value) => value,
    getMealLabel: (value) => ({ mealType: value.mealType, mealName: value.mealName }),
    mealRemarkText: (value) => kitchenMealWarnings(value).join(' | '),
    exclusionsText: () => 'None', formatAddress: () => 'Fixture address',
    parseDeliveryHour: () => 999, formatDeliveryHourLabel: () => '',
    loadJsPDF: async () => ({ default: function FixturePDF() { return doc; } }),
    loadAutoTable: async () => ({ default: (_doc, options) => { tables.push(options.body); doc.lastAutoTable = { finalY: 160 }; } }),
  };
  expect((await downloadCustomerPaperPdf({ entry, fromKey: date, toKey: date, helpers })).ok).toBe(true);
  expect(tables[0]).toHaveLength(2);
  expect(tables[0][0][2]).toContain('capped');
  expect(tables[0][0].slice(3)).toEqual([`${entry.selectedMeals[0].proteinWeight}g`, `${entry.selectedMeals[0].carbWeight}g`, '80g']);
  expect(texts.join(' ')).toContain(entry.formulaVersion);
  expect(texts.join(' ')).toContain(date);
  const originalBlob = global.Blob;
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
  let html;
  global.Blob = class FixtureBlob { constructor(parts) { html = parts.join(''); } };
  URL.createObjectURL = () => 'blob:fixture'; URL.revokeObjectURL = () => {};
  const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  jest.useFakeTimers();
  try {
    expect(downloadCustomerPaperWord({ entry, fromKey: date, toKey: date, helpers }).ok).toBe(true);
    expect(html).toContain('capped');
    expect(html).toContain(entry.formulaVersion);
    expect(html).toContain(entry.nutritionResolvedAt);
    expect(html).toContain(`<td>${entry.selectedMeals[0].proteinWeight}g</td>`);
    expect((html.match(/Fixture<\/td>/g) || [])).toHaveLength(2);
    jest.runOnlyPendingTimers();
  } finally {
    global.Blob = originalBlob; URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
    click.mockRestore(); jest.useRealTimers();
  }
});
