import XLSX from 'xlsx-js-style';
import { buildCookingLog, cookingLogWorkbook } from './kitchenCookingLog';
import { buildKitchenCountRows, componentWeightText } from './kitchenCountingComponents';
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
  const blocks = [{ name: 'Example', category: 'meal', label: 'Main', count: 21, components: [
    { kind: 'Portion', name: 'Chicken', unit: 'KG', base: 27.765 / 1.05 },
    { kind: 'Carb', name: 'Rice', unit: 'KG', base: 27.7 / 1.05 },
    { kind: 'Sauce', name: 'Sauce', unit: 'PCS', base: 21 },
  ] }];
  const wb = cookingLogWorkbook(XLSX, blocks, date), ws = wb.Sheets['Cooking & EOD'];
  expect(ws.B8.v).toBe(27.8); expect(ws.B9.v).toBe(27.7);
  expect(ws.B10.v).toBe(21); expect(ws.B10.s.numFmt).toBe('0');
  expect(wb.Sheets.Calculation.E2.v).toBe(27.765 / 1.05);
});

test('breakfast and snack portions measured in KG do not get the main weight buffer', () => {
  const entries = [{ selectedMeals: ['breakfast', 'snack'].map(category => meal({
    category, mealType: category, mealName: category, menuItemId: category, quantity: 1, proteinWeight: 50,
  })) }];
  const catalog = ['breakfast', 'snack'].map(category => ({
    _id: category, mealType: category, mealName: category, cycleMeal: { qtyUnit: 'KG' },
  }));
  const sheet = cookingLogWorkbook(XLSX, buildCookingLog(entries, date, catalog), date).Sheets['Cooking & EOD'];
  expect(sheet.B8).toMatchObject({ v: 0.05, f: 'Calculation!E2', s: { numFmt: '0.0##' } });
  expect(sheet.H8).toMatchObject({ v: 0.05, f: 'Calculation!E3' });
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

const burgerRecipe = { ...recipe, mealName: 'MEXICAN BURGER WITH GREEN RICE', cycleMeal: { components: [
  { type: 'Protein', name: 'MEXICAN BURGER' }, { type: 'Carb', name: 'GREEN RICE' },
  { type: 'Vegetable', name: 'Carrot' }, { type: 'Sauce', name: 'LEMON GINGER SAUCE' },
] } };
const burger = extra => meal({ mealName: burgerRecipe.mealName, date: '2026-11-24', ...extra });

test('the November 24 burger rule accepts a missing protein label and honors a different recorded protein', () => {
  const day = '2026-11-24';
  const entries = [{ selectedMeals: [burger({ proteinWeight: 260 })] }];
  const minimalDated = [{ _id: 'item', mealName: burgerRecipe.mealName, mealType: 'main' }];
  expect(buildKitchenCountRows(entries, day, minimalDated)[0].components.protein[0]).toMatchObject({ name: 'MEXICAN BURGER', pcs: 6 });
  expect(cookingLogWorkbook(XLSX, buildCookingLog(entries, day, minimalDated), day).Sheets['Cooking & EOD'].B8.v).toBe(6);
  expect(buildCookingLog(entries, day)[0].components[0].unit).toBe('KG');
  const different = [{ selectedMeals: [burger({ proteinChoice: 'Chicken Patty', proteinWeight: 260 })] }];
  expect(buildCookingLog(different, day)[0].components[0].unit).toBe('KG');
  const manualType = [{ selectedMeals: [burger({ manualProteinType: 'fish', proteinWeight: 260 })] }];
  expect(buildCookingLog(manualType, day, [burgerRecipe])[0].components[0].unit).toBe('KG');
  expect(buildKitchenCountRows(manualType, day, [burgerRecipe])[0].components.protein[0].pcs).toBeUndefined();
  const datedChicken = [{ ...burgerRecipe, portionType: 'chicken' }];
  expect(buildCookingLog(entries, day, datedChicken)[0].components[0].unit).toBe('KG');
  expect(buildKitchenCountRows(entries, day, datedChicken)[0].components.protein[0].pcs).toBeUndefined();
  const beefLabel = [{ selectedMeals: [burger({ proteinChoice: 'Beef Mexican Burger', proteinWeight: 260 })] }];
  const datedBeef = [{ ...burgerRecipe, portionType: 'beef' }];
  expect(buildKitchenCountRows(beefLabel, day, datedBeef)[0].components.protein[0].pcs).toBe(6);
  expect(cookingLogWorkbook(XLSX, buildCookingLog(beefLabel, day, datedBeef), day).Sheets['Cooking & EOD'].B8.v).toBe(6);
  const conflicting = [{ selectedMeals: [burger({ manualProteinType: 'beef', proteinWeight: 260 })] }];
  expect(buildCookingLog(conflicting, day, datedChicken)[0].components[0].unit).toBe('KG');
  const contradictory = [{ ...burgerRecipe, cycleMeal: { components: [{ type: 'Protein', name: 'Grilled Chicken' }] } }];
  const savedChoice = [{ selectedMeals: [burger({ proteinChoice: 'Mexican Burger', proteinWeight: 260 })] }];
  expect(buildCookingLog(savedChoice, day, contradictory)[0].components[0].unit).toBe('KG');
  const legacyChicken = [{ ...burgerRecipe, cycleMeal: { ...burgerRecipe.cycleMeal, category: 'MAIN CHX' } }];
  expect(buildCookingLog(savedChoice, day, legacyChicken)[0].components[0].unit).toBe('KG');
  expect(buildCookingLog(savedChoice, day, [{ ...legacyChicken[0], portionType: 'beef' }])[0].components[0].unit).toBe('KG');
  const ambiguous = [1, 2].map((space, index) => ({ ...burgerRecipe, _id: String(index),
    mealName: `Mexican${' '.repeat(space)}Burger With Green Rice`, cycleMeal: { ...burgerRecipe.cycleMeal, qtyUnit: 'KG' },
  }));
  const unresolved = [{ selectedMeals: [burger({ mealName: 'Mexican   Burger With Green Rice', proteinChoice: 'Mexican Burger' })] }];
  expect(buildCookingLog(unresolved, day, ambiguous)[0].components[0].unit).toBe('KG');
  expect(buildKitchenCountRows(unresolved, day, ambiguous)[0].components.protein[0].pcs).toBeUndefined();
  for (const selection of [{ menuItemId: 'missing' }, { proteinType: 'chicken' }, { proteinSourceType: 'fish' }]) {
    const recorded = [{ selectedMeals: [burger({ ...selection, proteinChoice: 'Mexican Burger', proteinWeight: 260 })] }];
    expect(buildCookingLog(recorded, day, datedBeef)[0].components[0].unit).toBe('KG');
    expect(buildKitchenCountRows(recorded, day, datedBeef)[0].components.protein[0].pcs).toBeUndefined();
  }
  const mislinked = [{ selectedMeals: [burger({ menuItemId: 'item', proteinChoice: 'Mexican Burger', proteinWeight: 260 })] }];
  expect(buildCookingLog(mislinked, day, [{ ...datedBeef[0], mealType: 'breakfast' }])[0].components[0].unit).toBe('KG');
});

test.each([undefined, 'PCS'])('the November 24 burger aliases share one rounded portion quantity with unit %s', qtyUnit => {
  const day = '2026-11-24';
  const catalog = [{ ...burgerRecipe, portionType: 'beef', cycleMeal: {
    ...burgerRecipe.cycleMeal, ...(qtyUnit ? { qtyUnit, gramsPerPiece: 50 } : {}),
  } }];
  const entries = [{ selectedMeals: [
    burger({ proteinWeight: 100, proteinChoice: 'Beef Mexican Burger' }),
    burger({ proteinWeight: 100 }),
  ] }];
  expect(buildKitchenCountRows(entries, day, catalog)[0].components.protein).toEqual([{ name: 'MEXICAN BURGER', weight: 200, gramsPerPiece: 50, pcs: 5 }]);
  expect(cookingLogWorkbook(XLSX, buildCookingLog(entries, day, catalog), day).Sheets['Cooking & EOD'].B8.v).toBe(5);
});

test.each(['Oats', 'Oats (LARGE)'])('separate menu item IDs for a large %s and a regular breakfast share the Cooking & EOD block', largeName => {
  const regular = meal({ category: 'breakfast', mealType: 'breakfast', mealName: 'Oats', menuItemId: 'regular' });
  const large = { ...regular, mealName: largeName, menuItemId: 'large', flags: { isLargeBreakfast: true } };
  const blocks = buildCookingLog([{ selectedMeals: [regular, large] }], date);
  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toMatchObject({ name: 'Oats (1-LARGE)', count: 2, components: [{ name: 'Oats (1-LARGE)', base: 2 }] });
});

test('a saved Large title remains visible when both selections link to a regular dated title', () => {
  const catalog = [{ _id: 'item', mealName: 'Oats', mealType: 'breakfast' }];
  const regular = meal({ mealName: 'Oats', menuItemId: 'item', category: 'breakfast', mealType: 'breakfast' });
  const entries = [{ selectedMeals: [regular, { ...regular, mealName: 'Oats (LARGE)', flags: { isLargeBreakfast: false } }] }];
  expect(buildKitchenCountRows(entries, date, catalog).map(row => row.mealName)).toEqual(['Oats', 'Oats (LARGE)']);
  expect(buildCookingLog(entries, date, catalog)).toEqual([expect.objectContaining({ name: 'Oats (1-LARGE)', count: 2 })]);
});

test('distinct regular breakfasts keep their own units and blocks', () => {
  const names = ['Oat Bowl', 'Oat  Bowl'];
  const catalog = names.map((mealName, index) => ({ _id: String(index), mealName, mealType: 'breakfast',
    cycleMeal: { qtyUnit: index ? 'PCS' : 'KG' },
  }));
  const selectedMeals = names.map((mealName, index) => meal({ mealName, menuItemId: String(index), category: 'breakfast', mealType: 'breakfast' }));
  const blocks = buildCookingLog([{ selectedMeals }], date, catalog);
  expect(blocks).toHaveLength(2);
  expect(blocks.find(block => block.name === names[0]).components[0].unit).toBe('KG');
  expect(blocks.find(block => block.name === names[1]).components[0].unit).toBe('PCS');
});

test('a Large title alone does not merge breakfasts with different dated recipes', () => {
  const catalog = [
    { _id: 'regular', mealName: 'Berry Oats', mealType: 'breakfast', cycleMeal: { id: 'recipe-one', components: [{ type: 'Breakfast', name: 'Berry oats' }] } },
    { _id: 'large', mealName: 'BERRY OATS (LARGE)', mealType: 'breakfast', cycleMeal: { id: 'recipe-two', components: [{ type: 'Breakfast', name: 'Cherry oats' }] } },
  ];
  const selectedMeals = catalog.map(item => meal({ mealName: item.mealName, menuItemId: item._id, category: 'breakfast', mealType: 'breakfast' }));
  const blocks = buildCookingLog([{ selectedMeals }], date, catalog);
  expect(blocks.map(block => block.count)).toEqual([1, 1]);
});

test('a matching dated recipe allows regular and Large pairing despite title spacing', () => {
  const snapshot = { id: 'oat-recipe', components: [{ type: 'Breakfast', name: 'Berry Oats' }] };
  const catalog = [
    { _id: 'regular', mealName: 'Berry  Oats', mealType: 'breakfast', cycleMeal: snapshot },
    { _id: 'large', mealName: 'Berry Oats (LARGE)', mealType: 'breakfast', cycleMeal: snapshot },
  ];
  const selectedMeals = catalog.map(item => meal({ mealName: item.mealName, menuItemId: item._id, category: 'breakfast', mealType: 'breakfast' }));
  expect(buildCookingLog([{ selectedMeals }], date, catalog)).toEqual([
    expect.objectContaining({ count: 2, largeCount: 1 }),
  ]);
});

test('equivalent regular and Large workbook rows pair even with separate recipe IDs', () => {
  const catalog = [
    { _id: 'regular', mealName: 'Berry Oats', mealType: 'breakfast', cycleMeal: { id: 'regular-recipe',
      components: [{ type: 'Breakfast', name: 'Berry Oats' }], qtyUnit: 'PCS' } },
    { _id: 'large', mealName: 'Berry Oats (LARGE)', mealType: 'breakfast', cycleMeal: { id: 'large-recipe',
      components: [{ type: 'Protein', name: 'Berry Oats (LARGE)' }], qtyUnit: 'PCS' } },
  ];
  const selectedMeals = catalog.map(item => meal({ mealName: item.mealName, menuItemId: item._id, category: 'breakfast', mealType: 'breakfast' }));
  expect(buildCookingLog([{ selectedMeals }], date, catalog)).toEqual([
    expect.objectContaining({ name: 'Berry Oats (1-LARGE)', count: 2,
      components: [expect.objectContaining({ base: 2, unit: 'PCS' })] }),
  ]);
});

test('equivalent breakfast components pair and aggregate regardless of source ordering', () => {
  const catalog = [
    { _id: 'regular', mealName: 'Berry Oats', mealType: 'breakfast', cycleMeal: {
      components: [{ type: 'Breakfast', name: 'Granola' }, { type: 'Breakfast', name: 'Oats' }], qtyUnit: 'PCS' } },
    { _id: 'large', mealName: 'Berry Oats (LARGE)', mealType: 'breakfast', cycleMeal: {
      components: [{ type: 'Breakfast', name: 'Oats' }, { type: 'Breakfast', name: 'Granola' }], qtyUnit: 'PCS' } },
  ];
  const selectedMeals = catalog.map(item => meal({ mealName: item.mealName, menuItemId: item._id, category: 'breakfast', mealType: 'breakfast' }));
  expect(buildCookingLog([{ selectedMeals }], date, catalog)).toEqual([
    expect.objectContaining({ name: 'Berry Oats (1-LARGE)', count: 2, components: [expect.objectContaining({ base: 2 })] }),
  ]);
});

test('regular and Large breakfast preparations with different notes stay separate', () => {
  const catalog = ['Cook the oats', 'Cold-soak the oats'].map((notes, index) => ({
    _id: String(index), mealName: index ? 'Berry Oats (LARGE)' : 'Berry Oats', mealType: 'breakfast',
    cycleMeal: { components: [{ type: 'Breakfast', name: 'Berry Oats', notes }] },
  }));
  const selectedMeals = catalog.map(item => meal({ mealName: item.mealName, menuItemId: item._id, category: 'breakfast', mealType: 'breakfast' }));
  expect(buildCookingLog([{ selectedMeals }], date, catalog).map(block => block.count)).toEqual([1, 1]);
});

test('breakfasts with different component exclusions do not merge across dated items', () => {
  const catalog = [[], ['Dairy']].map((exclusions, index) => ({
    _id: String(index), mealName: index ? 'Berry Oats (LARGE)' : 'Berry  Oats', mealType: 'breakfast',
    cycleMeal: { id: `recipe-${index}`, qtyUnit: 'PCS', components: [{ type: 'Breakfast', name: 'Berry Oats', exclusions }] },
  }));
  const selectedMeals = catalog.map(item => meal({ mealName: item.mealName, menuItemId: item._id, category: 'breakfast', mealType: 'breakfast' }));
  expect(buildCookingLog([{ selectedMeals }], date, catalog).map(block => block.count)).toEqual([1, 1]);
});

test('breakfasts with different component ingredients stay separate', () => {
  const catalog = ['Dairy milk', 'Oat milk'].map((ingredient, index) => ({
    _id: String(index), mealName: index ? 'Berry Oats (LARGE)' : 'Berry Oats', mealType: 'breakfast',
    cycleMeal: { components: [{ type: 'Breakfast', name: 'Berry Oats', ingredients: [{ name: ingredient }] }] },
  }));
  const selectedMeals = catalog.map(item => meal({ mealName: item.mealName, menuItemId: item._id, category: 'breakfast', mealType: 'breakfast' }));
  expect(buildCookingLog([{ selectedMeals }], date, catalog).map(block => block.count)).toEqual([1, 1]);
});

test('legacy breakfast variants with different garnish do not merge', () => {
  const catalog = ['', 'Walnuts'].map((garnish, index) => ({
    _id: String(index), mealName: index ? 'Berry Oats (LARGE)' : 'Berry Oats', mealType: 'breakfast', garnish,
  }));
  const selectedMeals = catalog.map(item => meal({ mealName: item.mealName, menuItemId: item._id, category: 'breakfast', mealType: 'breakfast' }));
  expect(buildCookingLog([{ selectedMeals }], date, catalog).map(block => block.count)).toEqual([1, 1]);
});

test('an ambiguously linked Large breakfast is not merged into a verified regular recipe', () => {
  const catalog = [
    { _id: 'regular', mealName: 'Berry Oats', mealType: 'breakfast' },
    { _id: 'large-one', mealName: 'Berry Oats (LARGE)', mealType: 'breakfast', proteinSource: 'Berry Oats' },
    { _id: 'large-two', mealName: 'Berry Oats (LARGE)', mealType: 'breakfast', proteinSource: 'Cherry Oats' },
  ];
  const selectedMeals = catalog.slice(0, 2).map((item, i) => meal({
    mealName: item.mealName, menuItemId: i ? undefined : item._id, category: 'breakfast', mealType: 'breakfast',
  }));
  expect(buildCookingLog([{ selectedMeals }], date, catalog).map(block => block.count)).toEqual([1, 1]);
});

test('regular and Large breakfasts configured in different units stay separate', () => {
  const catalog = [
    { _id: 'regular', mealName: 'Oats', mealType: 'breakfast', cycleMeal: { qtyUnit: 'KG' } },
    { _id: 'large', mealName: 'Oats (LARGE)', mealType: 'breakfast', cycleMeal: { qtyUnit: 'PCS' } },
  ];
  const selectedMeals = catalog.map(item => meal({ mealName: item.mealName, menuItemId: item._id, category: 'breakfast', mealType: 'breakfast' }));
  const blocks = buildCookingLog([{ selectedMeals }], date, catalog);
  expect(blocks.map(block => [block.count, block.components[0].unit])).toEqual([[1, 'KG'], [1, 'PCS']]);
});

test.each(['large', 'regular'])('a different selected breakfast protein prevents Large pairing for item %s', largeItem => {
  const catalog = [
    { _id: 'regular', mealName: 'Berry Oats', mealType: 'breakfast', proteinSource: 'Berry Oats' },
    { _id: 'large', mealName: 'Berry Oats (LARGE)', mealType: 'breakfast', proteinSource: 'Berry Oats' },
  ];
  const selectedMeals = catalog.map((item, index) => meal({
    mealName: item.mealName, menuItemId: item._id, category: 'breakfast', mealType: 'breakfast',
    ...(index ? { menuItemId: largeItem, proteinChoice: 'Cherry Oats', flags: { isLargeBreakfast: true } } : {}),
  }));
  const blocks = buildCookingLog([{ selectedMeals }], date, catalog);
  expect(blocks.map(block => block.count)).toEqual([1, 1]);
});

test.each(['Yogurt', undefined])('a Large breakfast’s sauce override is compared against the regular breakfast’s dated %s sauce', sauce => {
  const catalog = [
    { _id: 'regular', mealName: 'Berry Oats', mealType: 'breakfast', sauce },
    { _id: 'large', mealName: 'Berry Oats (LARGE)', mealType: 'breakfast', sauce },
  ];
  const selectedMeals = catalog.map((item, index) => meal({
    mealName: item.mealName, menuItemId: item._id, category: 'breakfast', mealType: 'breakfast',
    ...(index ? { sauceChoice: 'Maple' } : {}),
  }));
  const blocks = buildCookingLog([{ selectedMeals }], date, catalog);
  expect(blocks.map(block => block.components.find(component => component.kind === 'Sauce')?.name)).toEqual([sauce, 'Maple']);
  expect(blocks.map(block => block.count)).toEqual([1, 1]);
});

test('a compatible regular serving pairs with Large even when another regular serving has a sauce override', () => {
  const catalog = [
    { _id: 'regular', mealName: 'Berry Oats', mealType: 'breakfast', sauce: 'Yogurt' },
    { _id: 'large', mealName: 'Berry Oats (LARGE)', mealType: 'breakfast', sauce: 'Yogurt' },
  ];
  const regular = meal({ mealName: 'Berry Oats', menuItemId: 'regular', category: 'breakfast', mealType: 'breakfast' });
  const large = { ...regular, mealName: 'Berry Oats (LARGE)', menuItemId: 'large' };
  const blocks = buildCookingLog([{ selectedMeals: [regular, { ...regular, sauceChoice: 'Maple' }, large] }], date, catalog);
  expect(blocks.map(block => [block.count, block.components.find(component => component.kind === 'Sauce').name])).toEqual([[1, 'Maple'], [2, 'Yogurt']]);
});

test('different saved names for one dated item are totaled before rounding to pieces', () => {
  const day = '2026-11-24';
  const catalog = [{ ...burgerRecipe, cycleMeal: { ...burgerRecipe.cycleMeal, qtyUnit: 'PCS', gramsPerPiece: 50 } }];
  const entries = [{ selectedMeals: [
    burger({ mealName: 'Burger legacy title', menuItemId: 'item', proteinWeight: 100 }),
    burger({ mealName: 'Mexican Burger With Green Rice', menuItemId: 'item', proteinWeight: 100 }),
  ] }];
  const counts = buildKitchenCountRows(entries, day, catalog);
  expect(counts).toHaveLength(1);
  expect(counts[0].components.protein).toEqual([{ name: 'MEXICAN BURGER', weight: 200, gramsPerPiece: 50, pcs: 5 }]);
  const blocks = buildCookingLog(entries, day, catalog);
  expect(blocks).toHaveLength(1);
  expect(cookingLogWorkbook(XLSX, blocks, day).Sheets['Cooking & EOD'].B8.v).toBe(5);
});

test('a name-only selection with an extra space uses the unique dated conversion and group', () => {
  const day = '2026-11-24';
  const catalog = [{ ...burgerRecipe, cycleMeal: { ...burgerRecipe.cycleMeal, qtyUnit: 'PCS', gramsPerPiece: 100 } }];
  const entries = [{ selectedMeals: [
    burger({ menuItemId: 'item', proteinWeight: 100 }),
    burger({ mealName: 'Mexican  Burger With Green Rice', proteinWeight: 100 }),
  ] }];
  const counts = buildKitchenCountRows(entries, day, catalog);
  expect(counts).toHaveLength(1);
  expect(counts[0].components.protein[0].pcs).toBe(3);
  expect(cookingLogWorkbook(XLSX, buildCookingLog(entries, day, catalog), day).Sheets['Cooking & EOD'].B8.v).toBe(3);
});

test('fractional assigned quantities are multiplied exactly before rounding buffered pieces', () => {
  const catalog = [{ ...recipe, cycleMeal: { ...recipe.cycleMeal, qtyUnit: 'PCS', gramsPerPiece: 38.5 } }];
  const entries = [{ selectedMeals: [meal({ menuItemId: 'item', proteinWeight: 100, quantity: 1.1 })] }];
  const counts = buildKitchenCountRows(entries, date, catalog);
  expect(counts[0].components.protein[0]).toMatchObject({ pcs: 3, weight: 110 });
  const workbook = cookingLogWorkbook(XLSX, buildCookingLog(entries, date, catalog), date);
  expect(workbook.Sheets.Calculation.F2.v).toBe(110);
  expect(workbook.Sheets['Cooking & EOD'].B8.v).toBe(3);
});

test('spacing in a PCS component name does not split the rounded count', () => {
  const catalog = [{ ...recipe, cycleMeal: { ...recipe.cycleMeal, qtyUnit: 'PCS', gramsPerPiece: 50 } }];
  const entries = [{ selectedMeals: ['Chicken Patty', 'Chicken  Patty'].map(proteinChoice => meal({
    menuItemId: 'item', proteinChoice, proteinWeight: 100,
  })) }];
  expect(buildKitchenCountRows(entries, date, catalog)[0].components.protein).toEqual([{ name: 'Chicken Patty', weight: 200, gramsPerPiece: 50, pcs: 5 }]);
  expect(cookingLogWorkbook(XLSX, buildCookingLog(entries, date, catalog), date).Sheets['Cooking & EOD'].B8.v).toBe(5);
});

test.each([{ mealFormat: 'Breakfast' }, { mealKind: 'Snack' }, { category: 'OATS' }])('the unconfigured burger exception rejects incompatible recipe metadata %o', metadata => {
  const day = '2026-11-24';
  const entries = [{ selectedMeals: [burger({ menuItemId: 'item', proteinWeight: 260 })] }];
  const catalog = [{ ...burgerRecipe, cycleMeal: { ...burgerRecipe.cycleMeal, ...metadata } }];
  expect(buildCookingLog(entries, day, catalog)[0].components[0].unit).toBe('KG');
  expect(buildKitchenCountRows(entries, day, catalog)[0].components.protein[0].pcs).toBeUndefined();
});

test('the unconfigured burger exception only applies to its named dish on November 24', () => {
  for (const selected of [burger({ date: '2026-11-25' }), burger({ mealName: 'Another Mexican Burger dish' })]) {
    const catalog = [{ ...burgerRecipe, mealName: selected.mealName }];
    const entries = [{ selectedMeals: [selected] }];
    expect(buildCookingLog(entries, selected.date, catalog)[0].components[0].unit).toBe('KG');
    expect(buildKitchenCountRows(entries, selected.date, catalog)[0].components.protein[0].pcs).toBeUndefined();
  }
});

test('the assigned side weight remains visible when its component label is absent', () => {
  const selected = meal({ carbChoice: 'None', carbWeight: 80, vegChoice: 'N/A', vegWeight: 120 });
  const [row] = buildKitchenCountRows([{ selectedMeals: [selected] }], date, [recipe]);
  expect(row.components.carb).toEqual([{ name: 'Component not recorded', weight: 80 }]);
  expect(row.components.veg).toEqual([{ name: 'Component not recorded', weight: 120 }]);
});

test('a placeholder protein is excluded from both production-component breakdowns', () => {
  const selected = meal({ proteinChoice: 'None' });
  const catalog = [{ ...recipe, cycleMeal: { ...recipe.cycleMeal, qtyUnit: 'PCS', gramsPerPiece: 50 } }];
  const entries = [{ selectedMeals: [selected] }];
  expect(buildKitchenCountRows(entries, date, catalog)[0].components.protein).toEqual([]);
  expect(buildCookingLog(entries, date, catalog)[0].components.some(component => component.kind === 'Portion')).toBe(false);
});

test('meal QTY configuration supports 50g and 100g pieces and overrides the legacy burger rule', () => {
  const entries = [{ selectedMeals: [burger({ proteinWeight: 260 })] }];
  for (const [gramsPerPiece, expected] of [[50, 6], [100, 3]]) {
    const configured = { ...burgerRecipe, cycleMeal: { ...burgerRecipe.cycleMeal, qtyUnit: 'PCS', gramsPerPiece } };
    const blocks = buildCookingLog(entries, '2026-11-24', [configured]);
    expect(cookingLogWorkbook(XLSX, blocks, '2026-11-24').Sheets['Cooking & EOD'].B8.v).toBe(expected);
  }
  const kg = { ...burgerRecipe, cycleMeal: { ...burgerRecipe.cycleMeal, qtyUnit: 'KG', gramsPerPiece: null } };
  expect(buildCookingLog(entries, '2026-11-24', [kg])[0].components[0].unit).toBe('KG');
  const invalid = { ...burgerRecipe, cycleMeal: { ...burgerRecipe.cycleMeal, qtyUnit: 'PCS', gramsPerPiece: 0 } };
  expect(buildCookingLog(entries, '2026-11-24', [invalid])[0].components[0].unit).toBe('KG');
  const invalidUnit = { ...burgerRecipe, cycleMeal: { ...burgerRecipe.cycleMeal, qtyUnit: 'BOX' } };
  expect(buildCookingLog(entries, '2026-11-24', [invalidUnit])[0].components[0].unit).toBe('KG');
});

test('a dated main with retained count-only breakfast settings exports in KG', () => {
  const catalog = [{ ...recipe, cycleMeal: { ...recipe.cycleMeal, mealKind: 'Breakfast', qtyUnit: 'PCS' } }];
  const entries = [{ selectedMeals: [meal({ menuItemId: 'item' })] }];
  expect(buildKitchenCountRows(entries, date, catalog)[0].components.protein[0].pcs).toBeUndefined();
  const blocks = buildCookingLog(entries, date, catalog);
  expect(blocks[0].components[0].unit).toBe('KG');
  expect(cookingLogWorkbook(XLSX, blocks, date).Sheets['Cooking & EOD'].E8.v).toBe('KG');
});

test('distinct dated dish IDs stay separate even when their names differ only by spacing', () => {
  const catalog = [recipe, { ...recipe, _id: 'second', mealName: 'Chicken  bowl' }];
  const entries = [{ selectedMeals: [meal({ menuItemId: 'item' }), meal({ menuItemId: 'second', mealName: 'Chicken  bowl' })] }];
  const counts = buildKitchenCountRows(entries, date, catalog);
  expect(counts.map(row => row.count)).toEqual([1, 1]);
  expect(new Set(counts.map(row => row.key)).size).toBe(2);
  expect(buildCookingLog(entries, date, catalog).map(block => block.count)).toEqual([1, 1]);
});

test('Bodybuilder ingredients and sauces stay separate even with a shared placeholder item ID', () => {
  const catalog = [{ ...recipe, cycleMeal: { ...recipe.cycleMeal, qtyUnit: 'PCS', gramsPerPiece: 50 } }];
  const selectedMeals = [['Chicken', 'BBQ'], ['Chicken', 'Lemon'], ['Beef', 'BBQ']].map(([proteinChoice, sauceChoice]) => meal({
    mealName: `Meal 1 - Protein: ${proteinChoice}, Veg: Carrot, Carb: Rice`, proteinChoice, sauceChoice,
    vegChoice: 'Carrot', carbChoice: 'Rice', menuItemId: 'item',
  }));
  const entries = [{ selectedMeals }];
  const counts = buildKitchenCountRows(entries, date, catalog);
  expect(counts).toHaveLength(3);
  expect(counts.every(row => row.count === 1 && row.components.protein[0].pcs === undefined)).toBe(true);
  const blocks = buildCookingLog(entries, date, catalog);
  expect(blocks.map(block => block.name)).toEqual(counts.map(row => row.mealName));
  expect(blocks.every(block => block.count === 1 && block.components[0].unit === 'KG')).toBe(true);
});

test('Mexican burger sums source grams before dividing by 50g and rounding up to pieces', () => {
  const entries = [{ selectedMeals: [burger({ proteinWeight: 110 }), burger({ proteinWeight: 110 })] }];
  const before = JSON.stringify(entries), [block] = buildCookingLog(entries, '2026-11-24', [burgerRecipe]);
  expect(block.count).toBe(2);
  expect(block.components.find(row => row.kind === 'Portion')).toMatchObject({ unit: 'PCS', baseGrams: 220, gramsPerPiece: 50, base: 5 });
  expect(block.components.find(row => row.kind === 'Carb')).toMatchObject({ name: 'GREEN RICE', unit: 'KG', base: 0.4 });
  expect(block.components.find(row => row.kind === 'Sauce')).toMatchObject({ unit: 'PCS', base: 2 });
  expect(JSON.stringify(entries)).toBe(before);
  const bulk = buildCookingLog([{ selectedMeals: [burger({ proteinWeight: 110, quantity: 2 })] }], '2026-11-24', [burgerRecipe]);
  expect(bulk[0].components[0].base).toBe(5);
});

test('burger workbook buffers source grams before rounding up once to whole PCS', () => {
  const blocks = buildCookingLog([{ selectedMeals: [burger({ proteinWeight: 260 })] }], '2026-11-24', [burgerRecipe]);
  const wb = cookingLogWorkbook(XLSX, blocks, '2026-11-24'), ws = wb.Sheets['Cooking & EOD'], source = wb.Sheets.Calculation;
  expect(ws.B8.v).toBe(6); expect(ws.B8.s.numFmt).toBe('0'); expect(ws.E8.v).toBe('PCS');
  expect(ws.B8.f).toBe('IF(AND(Calculation!F2=260,Calculation!G2=50,$B$2=5%),6,ROUNDUP(Calculation!F2*(1+$B$2)/Calculation!G2,0))');
  expect(source.E2.f).toBe('IF(AND(F2=260,G2=50),6,ROUNDUP(F2/G2,0))'); expect(source.E2.v).toBe(6);
  expect(source.F2.v).toBe(260); expect(source.G2.v).toBe(50);
  expect(ws.B9.f).toBe('ROUND(Calculation!E3*(1+$B$2),1)');
  expect(ws.C8.v).toBe(''); expect(ws.D8.v).toBe('');
  const restored = XLSX.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer', cellFormula: true });
  expect(restored.Sheets.Calculation.E2.v).toBe(6);
  expect(restored.Sheets.Calculation.E2.f).toBe(source.E2.f);
  expect(restored.Sheets['Cooking & EOD'].B8.v).toBe(6);
  for (const [grams, expected] of [[0, 0], [250, 6], [260, 6], [300, 7], [1000, 21]]) {
    const plan = buildCookingLog([{ selectedMeals: [burger({ proteinWeight: grams })] }], '2026-11-24', [burgerRecipe]);
    expect(cookingLogWorkbook(XLSX, plan, '2026-11-24').Sheets['Cooking & EOD'].B8.v).toBe(expected);
  }
});

test('recalculating exported near-boundary inputs preserves the exact six-piece count', () => {
  const day = '2026-11-24';
  const catalog = [{ ...burgerRecipe, cycleMeal: { ...burgerRecipe.cycleMeal, qtyUnit: 'PCS', gramsPerPiece: 65.099999999999 } }];
  const workbook = cookingLogWorkbook(XLSX, buildCookingLog([{ selectedMeals: [burger({ proteinWeight: 310 })] }], day, catalog), day);
  expect(workbook.Sheets['Cooking & EOD'].B8).toMatchObject({
    v: 6, f: 'IF(AND(Calculation!F2=310,Calculation!G2=65.099999999999,$B$2=5%),6,ROUNDUP(Calculation!F2*(1+$B$2)/Calculation!G2,0))',
  });
});

test.each([[309, 5], [310, 5], [311, 6]])('65.1g pieces at %sg match the screen and both exports', (grams, expected) => {
  const entries = [{ selectedMeals: [burger({ proteinWeight: grams })] }];
  const day = '2026-11-24';
  const catalog = [{ ...burgerRecipe, cycleMeal: { ...burgerRecipe.cycleMeal, qtyUnit: 'PCS', gramsPerPiece: 65.1 } }];
  const [count] = buildKitchenCountRows(entries, day, catalog);
  expect(count.components.protein[0].pcs).toBe(expected);
  expect(componentWeightText(count.components.protein)).toBe(`MEXICAN BURGER: ${expected} PCS`);
  const workbook = cookingLogWorkbook(XLSX, buildCookingLog(entries, day, catalog), day);
  expect(workbook.Sheets['Cooking & EOD'].B8.v).toBe(expected);
});

test('burger exact multiples stay exact and unrelated protein components stay in kg', () => {
  for (const [grams, expected] of [[0, 0], [250, 5], [260, 6], [300, 6]]) {
    const [block] = buildCookingLog([{ selectedMeals: [burger({ proteinWeight: grams })] }], '2026-11-24', [burgerRecipe]);
    expect(block.components[0].base).toBe(expected);
  }
  const different = { ...burgerRecipe, cycleMeal: { components: [{ type: 'Protein', name: 'Grilled chicken' }] } };
  const [block] = buildCookingLog([{ selectedMeals: [burger({ proteinWeight: 260 })] }], '2026-11-24', [different]);
  expect(block.components[0]).toMatchObject({ unit: 'KG', base: 0.26 });
});
