import XLSX from 'xlsx-js-style';
import { buildCookingLog, cookingLogWorkbook } from './kitchenCookingLog';
const date = '2026-11-23';
const meal = extra => ({ date, category: 'meal', mealType: 'main', mealName: 'Chicken bowl',
  proteinWeight: 150, carbWeight: 200, vegWeight: 80, quantity: 1, ...extra });
const recipe = { _id: 'item', mealType: 'main', mealName: 'Chicken bowl', cycleMeal: { category: 'MAIN CHX', components: [
  { type: 'Protein', name: 'Roast chicken' }, { type: 'Carb', name: 'Rice' }, { type: 'Vegetable', name: 'Carrot' },
  { type: 'Sauce', name: 'BBQ sauce' }, { type: 'Sauce 2', name: 'Dressing' }, { type: 'Garnish', name: 'Parsley' },
] } };

test('cooking plan sums personalized weights and duplicates; pieces are per meal portion with no data mutation', () => {
  const entries = [{ selectedMeals: [meal({ quantity: 2 }), meal({ proteinWeight: 100 }), meal({ date: '2026-11-24' })] }];
  const before = JSON.stringify(entries), [block] = buildCookingLog(entries, date, [recipe]);
  expect(block.count).toBe(3);
  expect(block.components.find(row => row.kind === 'Portion')).toMatchObject({ name: 'Roast chicken', base: 0.4, unit: 'KG' });
  expect(block.components.filter(row => row.unit === 'PCS').map(row => [row.name, row.base])).toEqual([['BBQ sauce', 3], ['Dressing', 3], ['Parsley', 3]]);
  expect(JSON.stringify(entries)).toBe(before);
});

test('salad bases and dressing use pcs; main protein and carbs retain kg', () => {
  const catalog = [{ ...recipe, cycleMeal: { ...recipe.cycleMeal, isSaladBase: true, components: recipe.cycleMeal.components.map(component => component.type === 'Vegetable' ? { ...component, type: 'Salad', name: 'Mixed leaf salad' } : component) } }];
  const [block] = buildCookingLog([{ selectedMeals: [meal({ quantity: 2 })] }], date, catalog);
  expect(block.components.find(row => row.kind === 'Salad base')).toMatchObject({ name: 'Mixed leaf salad', unit: 'PCS', base: 2 });
  expect(block.components.find(row => row.kind === 'Carb').unit).toBe('KG');
});

for (const marker of ['flag', 'plan']) {
  test(`Matter Core ${marker} excludes only its main salad base in mixed cook counts`, () => {
    const salad = { ...recipe, cycleMeal: { ...recipe.cycleMeal, isSaladBase: true } };
    const core = { ...(marker === 'plan' ? { planName: ' Matter Core ' } : {}), selectedMeals: [meal({
      quantity: 2, vegWeight: 0, ...(marker === 'flag' ? { flags: { matterCorePlan: true } } : {}),
    })] };
    const standard = { planName: 'Custom', selectedMeals: [meal({ quantity: 3 })] };
    const entries = [core, standard], before = JSON.stringify(entries);
    const [block] = buildCookingLog(entries, date, [salad]);
    expect(block.count).toBe(5);
    expect(block.components.find(row => row.kind === 'Salad base')).toMatchObject({ base: 3, unit: 'PCS' });
    expect(block.components.find(row => row.kind === 'Portion').base).toBe(0.75);
    expect(block.components.find(row => row.kind === 'Sauce').base).toBe(5);
    expect(block.components.find(row => row.kind === 'Garnish').base).toBe(5);
    expect(buildCookingLog([core], date, [salad])[0].components.some(row => row.kind === 'Salad base')).toBe(false);
    expect(JSON.stringify(entries)).toBe(before);
  });
}

test('Matter Core main salad exclusion does not remove its additional breakfast vegetables', () => {
  const breakfast = { ...recipe, mealName: 'Breakfast salad', mealType: 'breakfast', cycleMeal: { components: [{ type: 'Salad', name: 'Breakfast veg' }] } };
  const [block] = buildCookingLog([{ planName: 'Matter Core', selectedMeals: [meal({ category: 'breakfast', mealType: 'breakfast', mealName: breakfast.mealName })] }], date, [breakfast]);
  expect(block.components.find(row => row.kind === 'Salad base')).toMatchObject({ base: 1, unit: 'PCS' });
});

test('breakfast quantities combine normal and Large pieces with a Large count in their name', () => {
  const breakfast = meal({ category: 'breakfast', mealType: 'breakfast', mealName: 'Oats', quantity: 2 });
  const snack = meal({ category: 'snack', mealType: 'snack', mealName: 'Truffle' });
  const blocks = buildCookingLog([{ selectedMeals: [breakfast, { ...breakfast, flags: { isLargeBreakfast: true } }, snack] }], date, []);
  expect(blocks.map(row => row.name)).toEqual(['Oats (2-LARGE)', 'Truffle']);
  expect(blocks.every(block => block.components.every(row => row.unit === 'PCS'))).toBe(true);
  expect(blocks[0].count).toBe(4);
  expect(blocks[0].components).toEqual([{ kind: 'Portion', name: 'Oats (2-LARGE)', unit: 'PCS', base: 4, largeCount: 2 }]);
  const noSauce = { ...recipe, cycleMeal: {}, sauce: 'NO SAUCE', garnish: 'None' };
  expect(buildCookingLog([{ selectedMeals: [meal()] }], date, [noSauce])[0].components.some(row => /Sauce|Garnish/.test(row.kind))).toBe(false);
});

test('workbook matches paired template layout, caches buffered formula values, and leaves staff inputs empty', () => {
  const blocks = buildCookingLog([{ selectedMeals: [meal({ quantity: 2 }), meal({ proteinWeight: 100 })] }], date, [recipe]);
  const wb = cookingLogWorkbook(XLSX, blocks, date), ws = wb.Sheets['Cooking & EOD'];
  expect(ws.B2.v).toBe(0.05);
  expect(ws.B8.f).toBe('ROUND(Calculation!E2*(1+$B$2),1)');
  expect(ws.B8.v).toBe(0.4);
  expect(ws.B8.s.numFmt).toBe('0.0');
  expect(ws.E8.v).toBe('KG');
  expect(ws.C8.v).toBe(''); expect(ws.D8.v).toBe('');
  expect(ws.B11.v).toBe(3); expect(ws.E11.v).toBe('PCS');
  expect(wb.Sheets.Calculation.E2.v).toBe(0.4);
  const restored = XLSX.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer', cellFormula: true, cellStyles: true });
  expect(restored.Sheets['Cooking & EOD'].B8.v).toBe(0.4);
  expect(restored.Sheets['Cooking & EOD'].B8.f).toBe(ws.B8.f);
  for (const sheet of Object.values(restored.Sheets)) expect(Object.values(sheet).filter(cell => cell?.t === 'e')).toEqual([]);
  const paired = cookingLogWorkbook(XLSX, [blocks[0], { ...blocks[0], name: 'Second meal' }, { ...blocks[0], name: 'Third meal' }], date);
  const pairedSheet = paired.Sheets['Cooking & EOD'];
  expect(pairedSheet.G5.v).toBe('Second meal');
  expect(pairedSheet.H8.f).toBe(`ROUND(Calculation!E${blocks[0].components.length + 2}*(1+$B$2),1)`);
  expect(pairedSheet.I8.v).toBe(''); expect(pairedSheet.J8.v).toBe('');
  expect(Object.values(pairedSheet).some(cell => cell?.v === 'Third meal')).toBe(true);
});

test('INITIAL rounds buffered kg to one decimal, while unbuffered quantities and pcs stay exact', () => {
  const blocks = [{ name: 'Example', label: 'Main', count: 21, components: [
    { kind: 'Portion', name: 'Chicken', unit: 'KG', base: 27.765 / 1.05 },
    { kind: 'Carb', name: 'Rice', unit: 'KG', base: 27.7 / 1.05 },
    { kind: 'Sauce', name: 'Sauce', unit: 'PCS', base: 21 },
  ] }];
  const wb = cookingLogWorkbook(XLSX, blocks, date), ws = wb.Sheets['Cooking & EOD'];
  expect(ws.B8.v).toBe(27.8); expect(ws.B9.v).toBe(27.7);
  expect(ws.B10.v).toBe(21); expect(ws.B10.s.numFmt).toBe('0');
  expect(wb.Sheets.Calculation.E2.v).toBe(27.765 / 1.05);
});

test('twenty 150g portions aggregate in grams and round the buffered 3.15kg total up to 3.2kg', () => {
  const entries = Array.from({ length: 20 }, () => ({ selectedMeals: [meal({ proteinWeight: 150, carbWeight: 150, vegWeight: 150 })] }));
  const before = JSON.stringify(entries), blocks = buildCookingLog(entries, date, [recipe]);
  for (const component of blocks[0].components.filter(row => row.unit === 'KG')) expect(component.base).toBe(3);
  const wb = cookingLogWorkbook(XLSX, blocks, date), ws = wb.Sheets['Cooking & EOD'];
  for (const address of ['B8', 'B9', 'B10']) expect(ws[address].v).toBe(3.2);
  expect(wb.Sheets.Calculation.E2.v).toBe(3);
  expect(ws.B11.v).toBe(20);
  const restored = XLSX.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer', cellFormula: true });
  expect(restored.Sheets['Cooking & EOD'].B8.v).toBe(3.2);
  expect(restored.Sheets['Cooking & EOD'].B8.f).toBe('ROUND(Calculation!E2*(1+$B$2),1)');
  expect(JSON.stringify(entries)).toBe(before);
  const bulk = buildCookingLog([{ selectedMeals: [meal({ quantity: 20, proteinWeight: 150 })] }], date, [recipe]);
  expect(cookingLogWorkbook(XLSX, bulk, date).Sheets['Cooking & EOD'].B8.v).toBe(3.2);
});

test('buffered rounding remains distinct just below, at and above the half-step', () => {
  for (const [grams, expected] of [[2999, 3.1], [3000, 3.2], [3001, 3.2], [1000, 1.1], [5000, 5.3]]) {
    const blocks = buildCookingLog([{ selectedMeals: [meal({ proteinWeight: grams })] }], date, [recipe]);
    expect(cookingLogWorkbook(XLSX, blocks, date).Sheets['Cooking & EOD'].B8.v).toBe(expected);
  }
});

test('combined breakfast names count Large quantities only and do not alter saved meals', () => {
  const breakfast = meal({ category: 'breakfast', mealType: 'breakfast', mealName: 'Scramble egg (150G)', quantity: 32 });
  const entries = [{ selectedMeals: [breakfast, { ...breakfast, quantity: 21, flags: { isLargeBreakfast: true } }] }];
  const before = JSON.stringify(entries), [block] = buildCookingLog(entries, date, []);
  expect(block.name).toBe('Scramble egg (150G) (21-LARGE)'); expect(block.count).toBe(53);
  expect(block.components[0].base).toBe(53);
  expect(block.components[0].name).toBe('Scramble egg (150G) (21-LARGE)');
  const wb = cookingLogWorkbook(XLSX, [block], date);
  expect(wb.Sheets['Cooking & EOD'].A5.v).toBe(block.name);
  expect(wb.Sheets['Cooking & EOD'].B8.v).toBe(53);
  expect(JSON.stringify(entries)).toBe(before);
  expect(buildCookingLog([{ selectedMeals: [breakfast] }], date, [])[0].name).toBe('Scramble egg (150G)');
});
