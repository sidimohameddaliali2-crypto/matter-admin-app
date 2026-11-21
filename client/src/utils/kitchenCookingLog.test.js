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

test('breakfast/snack quantities use pieces, large breakfast is separate and no sauce means no sauce row', () => {
  const breakfast = meal({ category: 'breakfast', mealType: 'breakfast', mealName: 'Oats', quantity: 2 });
  const snack = meal({ category: 'snack', mealType: 'snack', mealName: 'Truffle' });
  const blocks = buildCookingLog([{ selectedMeals: [breakfast, { ...breakfast, flags: { isLargeBreakfast: true } }, snack] }], date, []);
  expect(blocks.map(row => row.name)).toEqual(['Oats', 'Oats (LARGE)', 'Truffle']);
  expect(blocks.every(block => block.components.every(row => row.unit === 'PCS'))).toBe(true);
  expect(blocks[0].components).toEqual([{ kind: 'Portion', name: 'Oats', unit: 'PCS', base: 2 }]);
  const noSauce = { ...recipe, cycleMeal: {}, sauce: 'NO SAUCE', garnish: 'None' };
  expect(buildCookingLog([{ selectedMeals: [meal()] }], date, [noSauce])[0].components.some(row => /Sauce|Garnish/.test(row.kind))).toBe(false);
});

test('workbook matches paired template layout, caches buffered formula values, and leaves staff inputs empty', () => {
  const blocks = buildCookingLog([{ selectedMeals: [meal({ quantity: 2 }), meal({ proteinWeight: 100 })] }], date, [recipe]);
  const wb = cookingLogWorkbook(XLSX, blocks, date), ws = wb.Sheets['Cooking & EOD'];
  expect(ws.B2.v).toBe(0.05);
  expect(ws.B8.f).toBe('ROUND(Calculation!E2*(1+$B$2),3)');
  expect(ws.B8.v).toBe(0.42);
  expect(ws.E8.v).toBe('KG');
  expect(ws.C8.v).toBe(''); expect(ws.D8.v).toBe('');
  expect(ws.B11.v).toBe(3); expect(ws.E11.v).toBe('PCS');
  expect(wb.Sheets.Calculation.E2.v).toBe(0.4);
  const restored = XLSX.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer', cellFormula: true, cellStyles: true });
  expect(restored.Sheets['Cooking & EOD'].B8.v).toBe(0.42);
  expect(restored.Sheets['Cooking & EOD'].B8.f).toBe(ws.B8.f);
  for (const sheet of Object.values(restored.Sheets)) expect(Object.values(sheet).filter(cell => cell?.t === 'e')).toEqual([]);
  const paired = cookingLogWorkbook(XLSX, [blocks[0], { ...blocks[0], name: 'Second meal' }, { ...blocks[0], name: 'Third meal' }], date);
  const pairedSheet = paired.Sheets['Cooking & EOD'];
  expect(pairedSheet.G5.v).toBe('Second meal');
  expect(pairedSheet.H8.f).toBe(`ROUND(Calculation!E${blocks[0].components.length + 2}*(1+$B$2),3)`);
  expect(pairedSheet.I8.v).toBe(''); expect(pairedSheet.J8.v).toBe('');
  expect(Object.values(pairedSheet).some(cell => cell?.v === 'Third meal')).toBe(true);
});
